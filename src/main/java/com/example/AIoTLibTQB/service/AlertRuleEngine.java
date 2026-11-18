package com.example.AIoTLibTQB.service;

import com.example.AIoTLibTQB.configuration.AlertSopCatalog;
import com.example.AIoTLibTQB.document.Alert;
import com.example.AIoTLibTQB.document.Room;
import com.example.AIoTLibTQB.document.RoomThresholdConfig;
import com.example.AIoTLibTQB.dto.mqtt.TelemetryPayload;
import com.example.AIoTLibTQB.dto.response.AlertResponse;
import com.example.AIoTLibTQB.enums.AlertSeverity;
import com.example.AIoTLibTQB.enums.AlertStatus;
import com.example.AIoTLibTQB.enums.AlertType;
import com.example.AIoTLibTQB.enums.RoomType;
import com.example.AIoTLibTQB.repository.AlertRepository;
import com.example.AIoTLibTQB.repository.RoomRepository;
import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;
import jakarta.annotation.PostConstruct;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.Setter;
import lombok.experimental.FieldDefaults;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.OptimisticLockingFailureException;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.mongodb.core.query.Update;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

@Slf4j
@Component
@FieldDefaults(level = AccessLevel.PRIVATE)
public class AlertRuleEngine {

    final AlertRepository alertRepository;
    final RealtimePublisher realtimePublisher;
    final RoomRepository roomRepository;
    final MongoTemplate mongoTemplate;
    final AlertEmailNotificationService alertEmailNotificationService;
    final Clock clock;

    static final Duration PENDING_WINDOW = Duration.ofSeconds(30);
    static final Duration HYSTERESIS_WINDOW = Duration.ofSeconds(60);
    static final Duration NOISE_PEAK_PULSE_WINDOW = Duration.ofSeconds(60);
    static final Duration NOISE_PEAK_PULSE_COOLDOWN = Duration.ofSeconds(3);
    static final Duration DEFAULT_SNOOZE_DURATION = Duration.ofMinutes(15);
    static final Duration STALE_METRIC_RESOLVE_WINDOW = Duration.ofMinutes(2);
    static final Duration OFFLINE_FLAP_WINDOW = Duration.ofSeconds(30);
    static final int NOISE_PEAK_PULSE_REQUIRED = 3;
    static final int OPTIMISTIC_LOCK_MAX_RETRIES = 3;

    static final double THRESHOLD_NOISE_AVG = 65.0;
    static final double THRESHOLD_NOISE_PEAK = 75.0;
    static final double THRESHOLD_NOISE_PEAK_IMMEDIATE = 85.0;
    static final double THRESHOLD_TEMP = 32.0;
    static final double THRESHOLD_PM25 = 50.0;

    static final double DEADBAND_NOISE = 2.0;
    static final double DEADBAND_TEMP = 0.8;
    static final double DEADBAND_HUMIDITY = 2.0;
    static final double DEADBAND_PM25 = 5.0;

    public record RoomAlertContext(RoomType roomType, RoomThresholdConfig thresholds) {}

    final Cache<String, RoomAlertContext> roomContextCache = Caffeine.newBuilder()
            .maximumSize(1000)
            .expireAfterWrite(Duration.ofMinutes(10))
            .build();

    @Getter
    final Map<String, FsmState> fsmMap = new ConcurrentHashMap<>();

    @Getter
    final Map<String, List<Instant>> noisePeakPulsesMap = new ConcurrentHashMap<>();

    @Getter
    final Map<String, Instant> snoozeUntilMap = new ConcurrentHashMap<>();

    public AlertRuleEngine(
            AlertRepository alertRepository,
            RealtimePublisher realtimePublisher,
            Clock clock
    ) {
        this(alertRepository, realtimePublisher, clock, null, null, null);
    }

    public AlertRuleEngine(
            AlertRepository alertRepository,
            RealtimePublisher realtimePublisher,
            Clock clock,
            RoomRepository roomRepository
    ) {
        this(alertRepository, realtimePublisher, clock, roomRepository, null, null);
    }

    public AlertRuleEngine(
            AlertRepository alertRepository,
            RealtimePublisher realtimePublisher,
            Clock clock,
            RoomRepository roomRepository,
            MongoTemplate mongoTemplate
    ) {
        this(alertRepository, realtimePublisher, clock, roomRepository, mongoTemplate, null);
    }

    @Autowired
    public AlertRuleEngine(
            AlertRepository alertRepository,
            RealtimePublisher realtimePublisher,
            @Autowired(required = false) Clock clock,
            @Autowired(required = false) RoomRepository roomRepository,
            @Autowired(required = false) MongoTemplate mongoTemplate,
            @Autowired(required = false) AlertEmailNotificationService alertEmailNotificationService
    ) {
        this.alertRepository = alertRepository;
        this.realtimePublisher = realtimePublisher;
        this.clock = clock != null ? clock : Clock.systemUTC();
        this.roomRepository = roomRepository;
        this.mongoTemplate = mongoTemplate;
        this.alertEmailNotificationService = alertEmailNotificationService;
    }

    public RoomAlertContext resolveRoomContext(String roomId) {
        if (roomId == null || roomId.isBlank() || roomRepository == null) {
            return new RoomAlertContext(RoomType.STUDY_ROOM, RoomThresholdConfig.defaultFor(RoomType.STUDY_ROOM));
        }
        return roomContextCache.get(roomId, id -> roomRepository.findById(id)
                .map(RoomRuleMapper::fromRoom)
                .orElseGet(() -> new RoomAlertContext(RoomType.STUDY_ROOM, RoomThresholdConfig.defaultFor(RoomType.STUDY_ROOM))));
    }

    private static final class RoomRuleMapper {
        static RoomAlertContext fromRoom(Room room) {
            RoomType rType = room.getType() != null ? room.getType() : RoomType.STUDY_ROOM;
            RoomThresholdConfig cfg = room.getThresholds() != null
                    ? room.getThresholds().mergeWithDefaults(rType)
                    : RoomThresholdConfig.defaultFor(rType);
            return new RoomAlertContext(rType, cfg);
        }
    }

    public void invalidateRoomCache(String roomId) {
        if (roomId != null) {
            roomContextCache.invalidate(roomId);
        }
    }

    @PostConstruct
    public void rehydrateActiveAlerts() {
        try {
            migrateLegacyAlertsSeverity();
            List<Alert> activeAlerts = alertRepository.findByStatusIn(List.of(AlertStatus.FIRING, AlertStatus.ACKNOWLEDGED));
            if (activeAlerts != null) {
                for (Alert alert : activeAlerts) {
                    String targetId = alert.getDeviceId() != null && !alert.getDeviceId().isBlank()
                            ? alert.getDeviceId()
                            : (alert.getRoomId() != null && !alert.getRoomId().isBlank() ? alert.getRoomId() : alert.getHardwareId());
                    if (targetId == null) continue;
                    String metricType = resolveMetricType(alert);
                    String key = targetId + ":" + metricType;

                    FsmState state = new FsmState();
                    state.setStatus(alert.getStatus());
                    state.setFiringSince(alert.getStartedAt() != null ? alert.getStartedAt() : clock.instant());
                    state.setAlertId(alert.getId());
                    state.setThreshold(alert.getThreshold());
                    state.setLastValue(alert.getCurrentValue());
                    state.setAlertType(alert.getType());
                    state.setSeverity(alert.getSeverity() != null ? alert.getSeverity() : AlertSeverity.MEDIUM);
                    state.setMetricType(metricType);
                    state.setDeviceId(alert.getDeviceId());
                    state.setHardwareId(alert.getHardwareId());
                    state.setRoomId(alert.getRoomId());
                    state.setZoneId(alert.getZoneId());
                    state.setLastEvaluatedAt(clock.instant());

                    fsmMap.put(key, state);
                }
                log.info("Rehydrated {} active alert(s) into AlertRuleEngine FSM on startup", activeAlerts.size());
            }
        } catch (Exception e) {
            log.debug("Skipping FSM rehydration during test or mock environment: {}", e.getMessage());
        }
    }

    static String resolveMetricType(Alert alert) {
        if (alert == null) return "UNKNOWN";
        if (alert.getMetricType() != null && !alert.getMetricType().isBlank()) {
            return alert.getMetricType();
        }
        AlertType type = alert.getType();
        if (type == null) return "UNKNOWN";
        if (type == AlertType.DEVICE_OFFLINE) {
            return "DEVICE_OFFLINE";
        }
        if (type == AlertType.SENSOR_MALFUNCTION) {
            return "SENSOR_MALFUNCTION";
        }
        String msg = alert.getMessage() != null ? alert.getMessage() : "";
        String lower = msg.toLowerCase(java.util.Locale.ROOT);
        if (type == AlertType.NOISE_EXCEEDED) {
            if (msg.contains("Peak noise") || lower.contains("peak noise")) {
                return "NOISE_PEAK";
            }
            return "NOISE_AVG";
        }
        if (type == AlertType.AIR_UNHEALTHY) {
            if (msg.contains("PM2.5") || lower.contains("pm2.5") || lower.contains("pm2_5")
                    || lower.contains("µg/m³") || lower.contains("bụi")) {
                return "PM2_5";
            }
            if (msg.contains("dropped below min threshold")
                    || ((lower.contains("humidity") || lower.contains("%rh") || lower.contains("độ ẩm"))
                    && (lower.contains("min") || lower.contains("thấp")))) {
                return "HUMIDITY_LOW";
            }
            if (msg.contains("exceeded max threshold")
                    || lower.contains("humidity") || lower.contains("%rh") || lower.contains("độ ẩm")) {
                return "HUMIDITY_HIGH";
            }
            return "TEMPERATURE";
        }
        return type.name();
    }

    /**
     * Idempotent startup migration (M3 & M7): Chỉ truy vấn các bản ghi cũ còn thiếu trường dữ liệu
     * (severity, severityRank, metricType, recommendedAction) thay vì tải toàn bộ bảng alerts lên RAM;
     * fallback về alertRepository.findAll() khi chạy unit test không có MongoTemplate.
     */
    public int migrateLegacyAlertsSeverity() {
        try {
            List<Alert> candidates;
            if (mongoTemplate != null) {
                mongoTemplate.updateMulti(
                        Query.query(Criteria.where("version").is(null)),
                        new Update().set("version", 0L),
                        Alert.class
                );
                Query legacyQuery = Query.query(new Criteria().orOperator(
                        Criteria.where("severity").is(null),
                        Criteria.where("severityRank").is(null),
                        Criteria.where("metricType").is(null),
                        Criteria.where("metricType").is(""),
                        Criteria.where("recommendedAction").is(null),
                        Criteria.where("recommendedAction").is("")
                ));
                candidates = mongoTemplate.find(legacyQuery, Alert.class);
            } else {
                candidates = alertRepository != null ? alertRepository.findAll() : List.of();
            }

            if (candidates == null || candidates.isEmpty()) {
                return 0;
            }
            int updatedCount = 0;
            for (Alert alert : candidates) {
                if (alert == null) {
                    continue;
                }
                boolean changed = false;
                if (alert.getSeverity() == null) {
                    alert.setSeverity(AlertSeverity.MEDIUM);
                    changed = true;
                }
                int expectedRank = AlertSeverity.rankOf(alert.getSeverity());
                if (alert.getSeverityRank() == null || alert.getSeverityRank() != expectedRank) {
                    alert.setSeverityRank(expectedRank);
                    changed = true;
                }
                if (alert.getMetricType() == null || alert.getMetricType().isBlank()) {
                    alert.setMetricType(resolveMetricType(alert));
                    changed = true;
                }
                if (alert.getRecommendedAction() == null || alert.getRecommendedAction().isBlank()) {
                    alert.setRecommendedAction(AlertSopCatalog.resolveSop(
                            alert.getMetricType() != null ? alert.getMetricType() : "",
                            alert.getType(),
                            RoomType.STUDY_ROOM));
                    changed = true;
                }
                if (changed) {
                    alertRepository.save(alert);
                    updatedCount++;
                }
            }
            if (updatedCount > 0) {
                log.info("Migrated {} legacy alert(s) with default severity/severityRank/metricType/SOP", updatedCount);
            }
            return updatedCount;
        } catch (Exception e) {
            log.warn("Error migrating legacy alerts during startup: {}", e.getMessage(), e);
            return 0;
        }
    }

    @Getter
    @Setter
    public static class FsmState {
        AlertStatus status;
        Instant pendingSince;
        Instant firingSince;
        Instant recoverySince;
        Instant lastEvaluatedAt;
        String alertId;
        Double lastValue;
        Double threshold;
        AlertType alertType;
        AlertSeverity severity;
        String metricType;
        String deviceId;
        String hardwareId;
        String roomId;
        String zoneId;
    }

    public void evaluateTelemetry(String deviceId, String hardwareId, String roomId, TelemetryPayload.TelemetryData data) {
        evaluateTelemetry(deviceId, hardwareId, roomId, null, data);
    }

    public void evaluateTelemetry(String deviceId, String hardwareId, String roomId, String zoneId, TelemetryPayload.TelemetryData data) {
        if (data == null) {
            return;
        }

        Instant now = clock.instant();
        String targetId = deviceId != null && !deviceId.isBlank() ? deviceId : (roomId != null && !roomId.isBlank() ? roomId : hardwareId);
        RoomAlertContext ctx = resolveRoomContext(roomId);
        RoomType roomType = ctx.roomType();
        RoomThresholdConfig cfg = ctx.thresholds();

        double noiseAvgMax = cfg.getNoiseAvgMax() != null ? cfg.getNoiseAvgMax() : THRESHOLD_NOISE_AVG;
        double noisePeakMax = cfg.getNoisePeakMax() != null ? cfg.getNoisePeakMax() : THRESHOLD_NOISE_PEAK;
        double noisePeakImmediate = cfg.getNoisePeakImmediate() != null ? cfg.getNoisePeakImmediate() : THRESHOLD_NOISE_PEAK_IMMEDIATE;
        double tempMax = cfg.getTempMax() != null ? cfg.getTempMax() : THRESHOLD_TEMP;
        double pm25Max = cfg.getPm25Max() != null ? cfg.getPm25Max() : THRESHOLD_PM25;

        // 1. noiseAvg > noiseAvgMax (with deadband)
        if (data.getAcoustics() != null && data.getAcoustics().getNoiseAvg() != null) {
            double noiseAvg = data.getAcoustics().getNoiseAvg();
            boolean isBreached = noiseAvg > noiseAvgMax;
            boolean isRecovered = noiseAvg <= (noiseAvgMax - DEADBAND_NOISE);
            String sop = AlertSopCatalog.resolveSop("NOISE_AVG", AlertType.NOISE_EXCEEDED, roomType);
            evaluateMetric(targetId, "NOISE_AVG", isBreached, isRecovered, noiseAvg,
                    noiseAvgMax, AlertType.NOISE_EXCEEDED, AlertSeverity.MEDIUM,
                    String.format("Average noise level (%.1f dBA) exceeded threshold (%.1f dBA)", noiseAvg, noiseAvgMax),
                    sop, deviceId, hardwareId, roomId, zoneId, false);
        } else {
            resolveStaleMetricIfAbsent(targetId, "NOISE_AVG", now);
        }

        // 2. noisePeak dual-threshold:
        //    - >= noisePeakImmediate (85 dBA): fire immediately (CRITICAL)
        //    - >= noisePeakMax (75 dBA): record pulse; if >= 3 pulses within 60s -> fire immediately (HIGH)
        if (data.getAcoustics() != null && data.getAcoustics().getNoisePeak() != null) {
            Double noisePeak = data.getAcoustics().getNoisePeak();
            String pulseKey = targetId + ":NOISE_PEAK_PULSES";
            boolean immediateSevere = noisePeak >= noisePeakImmediate;
            boolean moderatePulse = noisePeak > noisePeakMax;
            int pulseCount = 0;

            if (moderatePulse) {
                List<Instant> pulses = noisePeakPulsesMap.computeIfAbsent(pulseKey, k -> new ArrayList<>());
                synchronized (pulses) {
                    pulses.removeIf(t -> Duration.between(t, now).compareTo(NOISE_PEAK_PULSE_WINDOW) > 0);
                    Instant lastPulse = pulses.isEmpty() ? null : pulses.get(pulses.size() - 1);
                    if (lastPulse == null || Duration.between(lastPulse, now).compareTo(NOISE_PEAK_PULSE_COOLDOWN) >= 0) {
                        pulses.add(now);
                    }
                    pulseCount = pulses.size();
                }
            } else if (noisePeak <= (noisePeakMax - DEADBAND_NOISE)) {
                List<Instant> pulses = noisePeakPulsesMap.get(pulseKey);
                if (pulses != null) {
                    synchronized (pulses) {
                        pulses.removeIf(t -> Duration.between(t, now).compareTo(NOISE_PEAK_PULSE_WINDOW) > 0);
                        pulseCount = pulses.size();
                    }
                }
            }

            boolean shouldBreachPeak = immediateSevere || (moderatePulse && pulseCount >= NOISE_PEAK_PULSE_REQUIRED);
            boolean isRecoveredPeak = noisePeak <= (noisePeakMax - DEADBAND_NOISE);
            AlertSeverity peakSeverity = immediateSevere ? AlertSeverity.CRITICAL : AlertSeverity.HIGH;
            double activeThreshold = immediateSevere ? noisePeakImmediate : noisePeakMax;
            String sop = AlertSopCatalog.resolveSop("NOISE_PEAK", AlertType.NOISE_EXCEEDED, roomType);

            evaluateMetric(targetId, "NOISE_PEAK", shouldBreachPeak, isRecoveredPeak, noisePeak,
                    activeThreshold, AlertType.NOISE_EXCEEDED, peakSeverity,
                    String.format("Peak noise spike (%.1f dBA) exceeded threshold (%.1f dBA)", noisePeak, activeThreshold),
                    sop, deviceId, hardwareId, roomId, zoneId, true);
        } else {
            resolveStaleMetricIfAbsent(targetId, "NOISE_PEAK", now);
        }

        // 3. temp > tempMax (with deadband)
        if (data.getEnvironment() != null && data.getEnvironment().getTemperature() != null) {
            double temp = data.getEnvironment().getTemperature();
            boolean isBreached = temp > tempMax;
            boolean isRecovered = temp <= (tempMax - DEADBAND_TEMP);
            String sop = AlertSopCatalog.resolveSop("TEMPERATURE", AlertType.AIR_UNHEALTHY, roomType);
            evaluateMetric(targetId, "TEMPERATURE", isBreached, isRecovered, temp,
                    tempMax, AlertType.AIR_UNHEALTHY, AlertSeverity.MEDIUM,
                    String.format("Temperature (%.1f °C) exceeded threshold (%.1f °C)", temp, tempMax),
                    sop, deviceId, hardwareId, roomId, zoneId, false);
        } else {
            resolveStaleMetricIfAbsent(targetId, "TEMPERATURE", now);
        }

        // 4. BOOK_STORAGE humidity rules (min / max with deadband)
        if (roomType == RoomType.BOOK_STORAGE) {
            if (data.getEnvironment() != null && data.getEnvironment().getHumidity() != null) {
                double rh = data.getEnvironment().getHumidity();
                double rhMax = cfg.getHumidityMax() != null ? cfg.getHumidityMax() : 60.0;
                double rhMin = cfg.getHumidityMin() != null ? cfg.getHumidityMin() : 45.0;

                boolean highBreach = rh > rhMax;
                boolean highRecovered = rh <= (rhMax - DEADBAND_HUMIDITY);
                String highSop = AlertSopCatalog.resolveSop("HUMIDITY_HIGH", AlertType.AIR_UNHEALTHY, roomType);
                evaluateMetric(targetId, "HUMIDITY_HIGH", highBreach, highRecovered, rh,
                        rhMax, AlertType.AIR_UNHEALTHY, AlertSeverity.HIGH,
                        String.format("Book storage humidity (%.1f %%RH) exceeded max threshold (%.1f %%RH)", rh, rhMax),
                        highSop, deviceId, hardwareId, roomId, zoneId, false);

                boolean lowBreach = rh < rhMin;
                boolean lowRecovered = rh >= (rhMin + DEADBAND_HUMIDITY);
                String lowSop = AlertSopCatalog.resolveSop("HUMIDITY_LOW", AlertType.AIR_UNHEALTHY, roomType);
                evaluateMetric(targetId, "HUMIDITY_LOW", lowBreach, lowRecovered, rh,
                        rhMin, AlertType.AIR_UNHEALTHY, AlertSeverity.MEDIUM,
                        String.format("Book storage humidity (%.1f %%RH) dropped below min threshold (%.1f %%RH)", rh, rhMin),
                        lowSop, deviceId, hardwareId, roomId, zoneId, false);
            } else {
                resolveStaleMetricIfAbsent(targetId, "HUMIDITY_HIGH", now);
                resolveStaleMetricIfAbsent(targetId, "HUMIDITY_LOW", now);
            }
        } else {
            resolveMetricByKey(targetId, "HUMIDITY_HIGH", now, "Room type is no longer BOOK_STORAGE");
            resolveMetricByKey(targetId, "HUMIDITY_LOW", now, "Room type is no longer BOOK_STORAGE");
        }

        // 5. pm2.5 > pm25Max (with deadband)
        if (data.getAirQuality() != null && data.getAirQuality().getPm2_5() != null) {
            double pm25 = data.getAirQuality().getPm2_5();
            boolean isBreached = pm25 > pm25Max;
            boolean isRecovered = pm25 <= (pm25Max - DEADBAND_PM25);
            String sop = AlertSopCatalog.resolveSop("PM2_5", AlertType.AIR_UNHEALTHY, roomType);
            evaluateMetric(targetId, "PM2_5", isBreached, isRecovered, pm25,
                    pm25Max, AlertType.AIR_UNHEALTHY, AlertSeverity.HIGH,
                    String.format("PM2.5 particulate level (%.1f µg/m³) exceeded threshold (%.1f µg/m³)", pm25, pm25Max),
                    sop, deviceId, hardwareId, roomId, zoneId, false);
        } else {
            resolveStaleMetricIfAbsent(targetId, "PM2_5", now);
        }
    }

    public void evaluateSensorHealth(
            String deviceId,
            String hardwareId,
            String roomId,
            String zoneId,
            boolean hasInvalidSensorReading,
            boolean allValidReadings
    ) {
        evaluateSensorHealth(deviceId, hardwareId, roomId, zoneId, hasInvalidSensorReading, allValidReadings, List.of());
    }

    public void evaluateSensorHealth(
            String deviceId,
            String hardwareId,
            String roomId,
            String zoneId,
            boolean hasInvalidSensorReading,
            boolean allValidReadings,
            List<String> malfunctioningSensors
    ) {
        String targetId = deviceId != null && !deviceId.isBlank()
                ? deviceId
                : (roomId != null && !roomId.isBlank() ? roomId : hardwareId);
        if (targetId == null || targetId.isBlank()) {
            return;
        }
        // Không kích hoạt lỗi mới cũng như không xác nhận hồi phục khi bản tin hoàn toàn không có mẫu đọc vật lý hợp lệ hay vượt dải
        if (!hasInvalidSensorReading && !allValidReadings) {
            return;
        }

        RoomAlertContext ctx = resolveRoomContext(roomId);
        String sop = AlertSopCatalog.resolveSop("SENSOR_MALFUNCTION", AlertType.SENSOR_MALFUNCTION, ctx.roomType());
        boolean isBreached = hasInvalidSensorReading;
        boolean isRecovered = !hasInvalidSensorReading && allValidReadings;
        double currentValue = hasInvalidSensorReading
                ? ((malfunctioningSensors != null && !malfunctioningSensors.isEmpty()) ? malfunctioningSensors.size() : 1.0)
                : 0.0;

        String channels = (malfunctioningSensors != null && !malfunctioningSensors.isEmpty())
                ? String.join(", ", malfunctioningSensors)
                : null;
        String message = channels != null
                ? String.format("Lỗi cảm biến phần cứng (%s): giá trị đo vượt ngoài dải vật lý hợp lệ liên tục", channels)
                : "Lỗi cảm biến phần cứng: giá trị đo vượt ngoài dải vật lý hợp lệ liên tục";

        evaluateMetric(
                targetId,
                "SENSOR_MALFUNCTION",
                isBreached,
                isRecovered,
                currentValue,
                0.0,
                AlertType.SENSOR_MALFUNCTION,
                AlertSeverity.MEDIUM,
                message,
                sop,
                deviceId,
                hardwareId,
                roomId,
                zoneId,
                false
        );
    }

    private void evaluateMetric(
            String targetId,
            String metricType,
            boolean isBreached,
            boolean isRecovered,
            double currentValue,
            double threshold,
            AlertType alertType,
            AlertSeverity severity,
            String message,
            String recommendedAction,
            String deviceId,
            String hardwareId,
            String roomId,
            String zoneId,
            boolean immediateFire
    ) {
        String key = targetId + ":" + metricType;
        Instant now = clock.instant();

        final boolean[] shouldFire = { false };
        final boolean[] shouldEscalate = { false };
        final String[] escalateAlertId = { null };
        final Alert[] alertToSave = { null };
        final String[] resolveAlertId = { null };

        fsmMap.compute(key, (k, state) -> {
            if (state == null) {
                Instant snoozedUntil = snoozeUntilMap.get(key);
                if (snoozedUntil != null) {
                    if (!now.isBefore(snoozedUntil) || isRecovered) {
                        snoozeUntilMap.remove(key);
                    } else if (severity == AlertSeverity.CRITICAL && isBreached) {
                        snoozeUntilMap.remove(key);
                        log.info("Snooze overridden by CRITICAL alert: key={}, value={}", key, currentValue);
                    } else {
                        log.debug("Alert suppressed by active snooze until {}: key={}", snoozedUntil, key);
                        return null;
                    }
                }

                // NORMAL state
                if (isBreached) {
                    if (immediateFire) {
                        FsmState newState = new FsmState();
                        newState.setStatus(AlertStatus.FIRING);
                        newState.setFiringSince(now);
                        newState.setRecoverySince(null);
                        newState.setLastEvaluatedAt(now);
                        newState.setLastValue(currentValue);
                        newState.setThreshold(threshold);
                        newState.setAlertType(alertType);
                        newState.setSeverity(severity);
                        newState.setMetricType(metricType);
                        newState.setDeviceId(deviceId);
                        newState.setHardwareId(hardwareId);
                        newState.setRoomId(roomId);
                        newState.setZoneId(zoneId);

                        alertToSave[0] = Alert.builder()
                                .deviceId(deviceId)
                                .hardwareId(hardwareId)
                                .roomId(roomId)
                                .zoneId(zoneId)
                                .type(alertType)
                                .metricType(metricType)
                                .severity(severity)
                                .severityRank(AlertSeverity.rankOf(severity))
                                .status(AlertStatus.FIRING)
                                .currentValue(currentValue)
                                .threshold(threshold)
                                .message(message)
                                .recommendedAction(recommendedAction)
                                .startedAt(now)
                                .build();
                        shouldFire[0] = true;
                        log.info("Alert FSM entered FIRING immediately (instantaneous metric): key={}, value={}, threshold={}", key, currentValue, threshold);
                        return newState;
                    } else {
                        FsmState newState = new FsmState();
                        newState.setStatus(AlertStatus.PENDING);
                        newState.setPendingSince(now);
                        newState.setLastEvaluatedAt(now);
                        newState.setLastValue(currentValue);
                        newState.setThreshold(threshold);
                        newState.setAlertType(alertType);
                        newState.setSeverity(severity);
                        newState.setMetricType(metricType);
                        newState.setDeviceId(deviceId);
                        newState.setHardwareId(hardwareId);
                        newState.setRoomId(roomId);
                        newState.setZoneId(zoneId);
                        log.debug("Alert FSM entered PENDING: key={}, value={}, threshold={}", key, currentValue, threshold);
                        return newState;
                    }
                }
                return null;
            }

            // Existing state is PENDING
            if (state.getStatus() == AlertStatus.PENDING) {
                if (isBreached) {
                    state.setLastValue(currentValue);
                    state.setLastEvaluatedAt(now);
                    if (AlertSeverity.rankOf(severity) > AlertSeverity.rankOf(state.getSeverity())) {
                        state.setSeverity(severity);
                        state.setThreshold(threshold);
                    }
                    long pendingSeconds = Duration.between(state.getPendingSince(), now).getSeconds();
                    if (pendingSeconds >= PENDING_WINDOW.getSeconds()) {
                        AlertSeverity effectiveSeverity =
                                AlertSeverity.rankOf(severity) >= AlertSeverity.rankOf(state.getSeverity())
                                        ? severity
                                        : state.getSeverity();
                        double effectiveThreshold = effectiveSeverity == severity ? threshold : state.getThreshold();

                        state.setStatus(AlertStatus.FIRING);
                        state.setFiringSince(now);
                        state.setRecoverySince(null);
                        state.setSeverity(effectiveSeverity);
                        state.setThreshold(effectiveThreshold);
                        if (zoneId != null) {
                            state.setZoneId(zoneId);
                        }
                        String effectiveZoneId = zoneId != null ? zoneId : state.getZoneId();

                        alertToSave[0] = Alert.builder()
                                .deviceId(deviceId)
                                .hardwareId(hardwareId)
                                .roomId(roomId)
                                .zoneId(effectiveZoneId)
                                .type(alertType)
                                .metricType(metricType)
                                .severity(effectiveSeverity)
                                .severityRank(AlertSeverity.rankOf(effectiveSeverity))
                                .status(AlertStatus.FIRING)
                                .currentValue(currentValue)
                                .threshold(effectiveThreshold)
                                .message(message)
                                .recommendedAction(recommendedAction)
                                .startedAt(now)
                                .build();
                        shouldFire[0] = true;
                    }
                    return state;
                } else if (!isRecovered) {
                    // Dao động nhẹ trong vùng deadband (threshold - deadband < currentValue <= threshold):
                    // Giữ nguyên trạng thái PENDING và pendingSince, cập nhật lastValue
                    state.setLastValue(currentValue);
                    state.setLastEvaluatedAt(now);
                    return state;
                } else {
                    // Đã tụt hẳn xuống vùng an toàn (<= threshold - deadband): Hủy PENDING
                    log.debug("Alert FSM cancelled PENDING (false alarm filtered): key={}", key);
                    return null;
                }
            }

            // Existing state is FIRING or ACKNOWLEDGED
            if (state.getStatus() == AlertStatus.FIRING || state.getStatus() == AlertStatus.ACKNOWLEDGED) {
                state.setLastEvaluatedAt(now);
                if (isBreached) {
                    state.setLastValue(currentValue);
                    int newRank = AlertSeverity.rankOf(severity);
                    int oldRank = AlertSeverity.rankOf(state.getSeverity());
                    if (newRank > oldRank) {
                        state.setSeverity(severity);
                        state.setThreshold(threshold);
                        shouldEscalate[0] = true;
                        escalateAlertId[0] = state.getAlertId();
                    }
                    if (state.getRecoverySince() != null) {
                        state.setRecoverySince(null);
                        log.debug("Alert FSM recovery timer reset due to breach spike: key={}", key);
                    }
                    return state;
                } else if (!isRecovered) {
                    // Deadband zone: between (threshold - deadband) and threshold -> keep current state without resetting recovery timer if already recovering, or do not start recovery yet if not started
                    state.setLastValue(currentValue);
                    if (state.getRecoverySince() != null) {
                        long recoverySeconds = Duration.between(state.getRecoverySince(), now).getSeconds();
                        if (recoverySeconds >= HYSTERESIS_WINDOW.getSeconds()) {
                            if (state.getAlertId() != null) {
                                resolveAlertId[0] = state.getAlertId();
                            }
                            return null;
                        }
                    }
                    return state;
                } else {
                    // Metric dropped safely below deadband
                    if (state.getRecoverySince() == null) {
                        state.setRecoverySince(now);
                        log.debug("Alert FSM started recovery hysteresis window: key={}", key);
                        return state;
                    } else {
                        long recoverySeconds = Duration.between(state.getRecoverySince(), now).getSeconds();
                        if (recoverySeconds >= HYSTERESIS_WINDOW.getSeconds()) {
                            if (state.getAlertId() != null) {
                                resolveAlertId[0] = state.getAlertId();
                            }
                            return null;
                        }
                        return state;
                    }
                }
            }

            return state;
        });

        if (shouldFire[0] && alertToSave[0] != null) {
            Alert savedAlert = alertRepository.save(alertToSave[0]);
            Alert effectiveSaved = savedAlert != null ? savedAlert : alertToSave[0];
            FsmState s = fsmMap.get(key);
            if (s != null && s.getStatus() == AlertStatus.FIRING) {
                s.setAlertId(effectiveSaved.getId());
            }
            realtimePublisher.publishAlert(toAlertResponse(effectiveSaved));
            notifyEmailOnFiredOrEscalated(effectiveSaved);
            log.info("Alert FSM transitioned to FIRING: key={}, alertId={}, value={}", key, effectiveSaved.getId(), currentValue);
        } else if (shouldEscalate[0] && escalateAlertId[0] != null) {
            escalateAlertSeverityInDb(escalateAlertId[0], severity, currentValue, threshold, message, key);
        } else if (resolveAlertId[0] != null) {
            resolveAlertByIdInDb(resolveAlertId[0], now);
            log.info("Alert FSM resolved after 60s hysteresis: key={}, alertId={}", key, resolveAlertId[0]);
        }
    }

    private void escalateAlertSeverityInDb(
            String alertId,
            AlertSeverity newSeverity,
            double currentValue,
            double threshold,
            String message,
            String key
    ) {
        if (alertId == null) {
            return;
        }
        int targetRank = AlertSeverity.rankOf(newSeverity);
        for (int attempt = 0; attempt < OPTIMISTIC_LOCK_MAX_RETRIES; attempt++) {
            Optional<Alert> alertOpt = alertRepository.findById(alertId);
            if (alertOpt == null || alertOpt.isEmpty()) {
                return;
            }
            Alert alert = alertOpt.get();
            if (alert.getStatus() == AlertStatus.RESOLVED) {
                return;
            }
            int currentRank = AlertSeverity.rankOf(alert.getSeverity());
            if (targetRank <= currentRank) {
                return;
            }

            alert.setSeverity(newSeverity);
            alert.setSeverityRank(targetRank);
            alert.setCurrentValue(currentValue);
            alert.setThreshold(threshold);
            alert.setMessage(message);

            try {
                Alert saved = alertRepository.save(alert);
                Alert effectiveSaved = saved != null ? saved : alert;
                realtimePublisher.publishAlert(toAlertResponse(effectiveSaved));
                notifyEmailOnFiredOrEscalated(effectiveSaved);
                log.info("Alert escalated in severity: key={}, alertId={}, oldRank={}, newSeverity={}, value={}",
                        key, effectiveSaved.getId(), currentRank, newSeverity, currentValue);
                return;
            } catch (OptimisticLockingFailureException ex) {
                log.debug("Optimistic locking conflict while escalating alertId={}, attempt={}", alertId, attempt + 1);
            }
        }
        log.warn("Unable to escalate alertId={} after {} optimistic locking attempts", alertId, OPTIMISTIC_LOCK_MAX_RETRIES);
    }

    public void triggerDeviceOfflineAlert(String deviceId, String hardwareId, String roomId) {
        triggerDeviceOfflineAlert(deviceId, hardwareId, roomId, null);
    }

    public void triggerDeviceOfflineAlert(String deviceId, String hardwareId, String roomId, String zoneId) {
        resolveEnvironmentalAlertsOnOffline(deviceId, hardwareId);

        String targetId = deviceId != null && !deviceId.isBlank() ? deviceId : hardwareId;
        String key = targetId + ":DEVICE_OFFLINE";
        Instant now = clock.instant();
        RoomAlertContext ctx = resolveRoomContext(roomId);
        String sop = AlertSopCatalog.resolveSop("DEVICE_OFFLINE", AlertType.DEVICE_OFFLINE, ctx.roomType());

        final Alert[] alertToSave = { null };
        final boolean[] reopened = { false };

        fsmMap.compute(key, (k, state) -> {
            if (state != null && (state.getStatus() == AlertStatus.FIRING || state.getStatus() == AlertStatus.ACKNOWLEDGED)) {
                return state;
            }

            Alert recentToReopen = null;
            if (deviceId != null && !deviceId.isBlank()) {
                Optional<Alert> recentOpt = alertRepository.findTopByDeviceIdAndTypeAndStatusOrderByStartedAtDesc(
                        deviceId, AlertType.DEVICE_OFFLINE, AlertStatus.RESOLVED);
                if (recentOpt != null && recentOpt.isPresent()) {
                    Alert recent = recentOpt.get();
                    if (recent.getResolvedAt() != null) {
                        Duration sinceResolved = Duration.between(recent.getResolvedAt(), now);
                        if (!sinceResolved.isNegative() && sinceResolved.compareTo(OFFLINE_FLAP_WINDOW) <= 0) {
                            recent.setStatus(AlertStatus.FIRING);
                            recent.setResolvedAt(null);
                            recent.setResolvedBy(null);
                            if (recent.getSeverity() == null) {
                                recent.setSeverity(AlertSeverity.HIGH);
                                recent.setSeverityRank(AlertSeverity.rankOf(AlertSeverity.HIGH));
                            }
                            if (recent.getMetricType() == null || recent.getMetricType().isBlank()) {
                                recent.setMetricType("DEVICE_OFFLINE");
                            }
                            if ((recent.getZoneId() == null || recent.getZoneId().isBlank()) && zoneId != null) {
                                recent.setZoneId(zoneId);
                            }
                            recentToReopen = recent;
                        }
                    }
                }
            }

            AlertSeverity effectiveSeverity = AlertSeverity.HIGH;
            if (recentToReopen != null) {
                alertToSave[0] = recentToReopen;
                reopened[0] = true;
                if (recentToReopen.getSeverity() != null) {
                    effectiveSeverity = recentToReopen.getSeverity();
                }
            } else {
                alertToSave[0] = Alert.builder()
                        .deviceId(deviceId)
                        .hardwareId(hardwareId)
                        .roomId(roomId)
                        .zoneId(zoneId)
                        .type(AlertType.DEVICE_OFFLINE)
                        .metricType("DEVICE_OFFLINE")
                        .severity(AlertSeverity.HIGH)
                        .severityRank(AlertSeverity.rankOf(AlertSeverity.HIGH))
                        .status(AlertStatus.FIRING)
                        .currentValue(0.0)
                        .threshold(0.0)
                        .message("Device is offline: hardwareId=" + hardwareId)
                        .recommendedAction(sop)
                        .startedAt(now)
                        .build();
            }

            FsmState newState = new FsmState();
            newState.setStatus(AlertStatus.FIRING);
            newState.setFiringSince(now);
            newState.setLastEvaluatedAt(now);
            newState.setAlertId(recentToReopen != null ? recentToReopen.getId() : null);
            newState.setAlertType(AlertType.DEVICE_OFFLINE);
            newState.setMetricType("DEVICE_OFFLINE");
            newState.setSeverity(effectiveSeverity);
            newState.setDeviceId(deviceId);
            newState.setHardwareId(hardwareId);
            newState.setRoomId(roomId);
            newState.setZoneId(zoneId);
            return newState;
        });

        if (alertToSave[0] != null) {
            Alert savedAlert = saveOfflineAlertWithRetry(alertToSave[0], reopened[0], zoneId);
            if (savedAlert != null) {
                FsmState s = fsmMap.get(key);
                if (s != null && savedAlert.getId() != null) {
                    s.setAlertId(savedAlert.getId());
                }
                realtimePublisher.publishAlert(toAlertResponse(savedAlert));
                notifyEmailOnFiredOrEscalated(savedAlert);
                if (reopened[0]) {
                    log.info("Reopened DEVICE_OFFLINE alert within {}s anti-flapping window: hardwareId={}, alertId={}",
                            OFFLINE_FLAP_WINDOW.getSeconds(), hardwareId, savedAlert.getId());
                } else {
                    log.info("Triggered DEVICE_OFFLINE alert: hardwareId={}, alertId={}", hardwareId, savedAlert.getId());
                }
            }
        }
    }

    private Alert saveOfflineAlertWithRetry(Alert alert, boolean isReopen, String zoneId) {
        if (!isReopen || alert.getId() == null) {
            Alert saved = alertRepository.save(alert);
            return saved != null ? saved : alert;
        }
        String alertId = alert.getId();
        for (int attempt = 0; attempt < OPTIMISTIC_LOCK_MAX_RETRIES; attempt++) {
            try {
                Alert target = attempt == 0
                        ? alert
                        : alertRepository.findById(alertId).orElse(null);
                if (target == null) {
                    return null;
                }
                if (attempt > 0) {
                    target.setStatus(AlertStatus.FIRING);
                    target.setResolvedAt(null);
                    target.setResolvedBy(null);
                    if ((target.getZoneId() == null || target.getZoneId().isBlank()) && zoneId != null) {
                        target.setZoneId(zoneId);
                    }
                }
                Alert saved = alertRepository.save(target);
                return saved != null ? saved : target;
            } catch (OptimisticLockingFailureException ex) {
                log.debug("Optimistic locking conflict while reopening DEVICE_OFFLINE alertId={}, attempt={}", alertId, attempt + 1);
            }
        }
        log.warn("Unable to reopen DEVICE_OFFLINE alertId={} after {} optimistic locking attempts", alertId, OPTIMISTIC_LOCK_MAX_RETRIES);
        return null;
    }

    public void resolveActiveAlertsForDevice(String deviceId, String hardwareId) {
        resolveActiveAlertsForDevice(deviceId, hardwareId, "Device deactivated or deleted");
    }

    public void resolveActiveAlertsForDevice(String deviceId, String hardwareId, String reason) {
        if ((deviceId == null || deviceId.isBlank()) && (hardwareId == null || hardwareId.isBlank())) {
            return;
        }
        Instant now = clock.instant();
        List<String> fsmAlertIds = new ArrayList<>();

        fsmMap.entrySet().removeIf(entry -> {
            FsmState state = entry.getValue();
            if (state != null && matchesDevice(state.getDeviceId(), state.getHardwareId(), deviceId, hardwareId, entry.getKey())) {
                if (state.getAlertId() != null) {
                    fsmAlertIds.add(state.getAlertId());
                }
                return true;
            }
            return false;
        });

        clearPulseAndSnoozeStateForDevice(deviceId, hardwareId);

        Set<String> resolvedIds = resolveFsmAlertIdsInDb(fsmAlertIds, now);
        for (Alert alert : findActiveAlertsSafe()) {
            if (alert == null || alert.getStatus() == AlertStatus.RESOLVED) {
                continue;
            }
            if (alert.getId() != null && resolvedIds.contains(alert.getId())) {
                continue;
            }
            if (matchesDevice(alert.getDeviceId(), alert.getHardwareId(), deviceId, hardwareId, null)) {
                resolveAlertEntity(alert, now, resolvedIds);
            }
        }
        log.info("Resolved {} active alert(s) for device (deviceId={}, hardwareId={}, reason={})",
                resolvedIds.size(), deviceId, hardwareId, reason);
    }

    public void resolveEnvironmentalAlertsOnOffline(String deviceId, String hardwareId) {
        if ((deviceId == null || deviceId.isBlank()) && (hardwareId == null || hardwareId.isBlank())) {
            return;
        }
        Instant now = clock.instant();
        List<String> fsmAlertIds = new ArrayList<>();

        fsmMap.entrySet().removeIf(entry -> {
            FsmState state = entry.getValue();
            if (state == null) {
                return false;
            }
            boolean isOfflineType = state.getAlertType() == AlertType.DEVICE_OFFLINE
                    || "DEVICE_OFFLINE".equals(state.getMetricType());
            if (!isOfflineType && matchesDevice(state.getDeviceId(), state.getHardwareId(), deviceId, hardwareId, entry.getKey())) {
                if (state.getAlertId() != null) {
                    fsmAlertIds.add(state.getAlertId());
                }
                return true;
            }
            return false;
        });

        Set<String> resolvedIds = resolveFsmAlertIdsInDb(fsmAlertIds, now);
        for (Alert alert : findActiveAlertsSafe()) {
            if (alert == null || alert.getStatus() == AlertStatus.RESOLVED) {
                continue;
            }
            if (alert.getId() != null && resolvedIds.contains(alert.getId())) {
                continue;
            }
            if (alert.getType() != AlertType.DEVICE_OFFLINE
                    && !"DEVICE_OFFLINE".equals(alert.getMetricType())
                    && matchesDevice(alert.getDeviceId(), alert.getHardwareId(), deviceId, hardwareId, null)) {
                resolveAlertEntity(alert, now, resolvedIds);
            }
        }
        if (!resolvedIds.isEmpty()) {
            log.info("Auto-resolved {} environmental alert(s) on device offline (deviceId={}, hardwareId={})",
                    resolvedIds.size(), deviceId, hardwareId);
        }
    }

    public void onRoomTypeChanged(String roomId, RoomType newType) {
        if (roomId == null || roomId.isBlank() || newType == RoomType.BOOK_STORAGE) {
            return;
        }
        invalidateRoomCache(roomId);
        Instant now = clock.instant();
        List<String> fsmAlertIds = new ArrayList<>();

        fsmMap.entrySet().removeIf(entry -> {
            FsmState state = entry.getValue();
            if (state != null && roomId.equals(state.getRoomId())
                    && isHumidityMetric(state.getMetricType(), entry.getKey())) {
                if (state.getAlertId() != null) {
                    fsmAlertIds.add(state.getAlertId());
                }
                return true;
            }
            return false;
        });

        Set<String> resolvedIds = resolveFsmAlertIdsInDb(fsmAlertIds, now);
        for (Alert alert : findActiveAlertsSafe()) {
            if (alert == null || alert.getStatus() == AlertStatus.RESOLVED) {
                continue;
            }
            if (alert.getId() != null && resolvedIds.contains(alert.getId())) {
                continue;
            }
            if (roomId.equals(alert.getRoomId())) {
                String mt = resolveMetricType(alert);
                if ("HUMIDITY_HIGH".equals(mt) || "HUMIDITY_LOW".equals(mt)) {
                    resolveAlertEntity(alert, now, resolvedIds);
                }
            }
        }
        if (!resolvedIds.isEmpty()) {
            log.info("Auto-resolved {} humidity alert(s) because room {} changed type to {}",
                    resolvedIds.size(), roomId, newType);
        }
    }

    private void resolveStaleMetricIfAbsent(String targetId, String metricType, Instant now) {
        if (targetId == null || targetId.isBlank()) {
            return;
        }
        String key = targetId + ":" + metricType;
        FsmState current = fsmMap.get(key);
        if (current == null || current.getLastEvaluatedAt() == null) {
            return;
        }
        if (Duration.between(current.getLastEvaluatedAt(), now).compareTo(STALE_METRIC_RESOLVE_WINDOW) <= 0) {
            return;
        }

        final String[] resolveAlertId = { null };
        fsmMap.computeIfPresent(key, (k, state) -> {
            if (state.getLastEvaluatedAt() != null
                    && Duration.between(state.getLastEvaluatedAt(), now).compareTo(STALE_METRIC_RESOLVE_WINDOW) > 0) {
                if (state.getAlertId() != null) {
                    resolveAlertId[0] = state.getAlertId();
                }
                log.info("Auto-resolving stale metric alert after missing sensor reading > {}: key={}",
                        STALE_METRIC_RESOLVE_WINDOW, key);
                return null;
            }
            return state;
        });

        if (resolveAlertId[0] != null) {
            resolveAlertByIdInDb(resolveAlertId[0], now);
        }
    }

    private void resolveMetricByKey(String targetId, String metricType, Instant now, String reason) {
        if (targetId == null || targetId.isBlank()) {
            return;
        }
        String key = targetId + ":" + metricType;
        if (!fsmMap.containsKey(key)) {
            return;
        }
        final String[] resolveAlertId = { null };
        fsmMap.computeIfPresent(key, (k, state) -> {
            if (state.getAlertId() != null) {
                resolveAlertId[0] = state.getAlertId();
            }
            log.info("Auto-resolving FSM metric state ({}): key={}", reason, key);
            return null;
        });
        if (resolveAlertId[0] != null) {
            resolveAlertByIdInDb(resolveAlertId[0], now);
        }
    }

    private void clearPulseAndSnoozeStateForDevice(String deviceId, String hardwareId) {
        noisePeakPulsesMap.keySet().removeIf(k ->
                (deviceId != null && !deviceId.isBlank() && k.startsWith(deviceId + ":"))
                        || (hardwareId != null && !hardwareId.isBlank() && k.startsWith(hardwareId + ":")));
        snoozeUntilMap.keySet().removeIf(k ->
                (deviceId != null && !deviceId.isBlank() && k.startsWith(deviceId + ":"))
                        || (hardwareId != null && !hardwareId.isBlank() && k.startsWith(hardwareId + ":")));
    }

    private Set<String> resolveFsmAlertIdsInDb(List<String> fsmAlertIds, Instant now) {
        Set<String> resolvedIds = new HashSet<>();
        for (String alertId : fsmAlertIds) {
            if (alertId == null || resolvedIds.contains(alertId)) {
                continue;
            }
            alertRepository.findById(alertId).ifPresent(alert -> resolveAlertEntity(alert, now, resolvedIds));
        }
        return resolvedIds;
    }

    private void resolveAlertByIdInDb(String alertId, Instant now) {
        if (alertId == null) {
            return;
        }
        alertRepository.findById(alertId).ifPresent(alert -> resolveAlertEntity(alert, now, null));
    }

    private void resolveAlertEntity(Alert alert, Instant now, Set<String> resolvedIds) {
        if (alert == null || alert.getStatus() == AlertStatus.RESOLVED) {
            if (alert != null && alert.getId() != null && resolvedIds != null) {
                resolvedIds.add(alert.getId());
            }
            return;
        }

        Alert current = alert;
        String alertId = current.getId();
        for (int attempt = 0; attempt < OPTIMISTIC_LOCK_MAX_RETRIES; attempt++) {
            if (attempt > 0) {
                if (alertId == null) {
                    return;
                }
                Optional<Alert> latestOpt = alertRepository.findById(alertId);
                if (latestOpt == null || latestOpt.isEmpty()) {
                    return;
                }
                current = latestOpt.get();
                if (current.getStatus() == AlertStatus.RESOLVED) {
                    if (resolvedIds != null && current.getId() != null) {
                        resolvedIds.add(current.getId());
                    }
                    return;
                }
            }

            // M4: Chỉ chuyển RESOLVED khi chưa phải RESOLVED; giữ nguyên acknowledgedAt và acknowledgedBy
            current.setStatus(AlertStatus.RESOLVED);
            current.setResolvedAt(now);
            current.setResolvedBy("SYSTEM");

            try {
                Alert persisted = alertRepository.save(current);
                Alert effectiveSaved = persisted != null ? persisted : current;
                if (resolvedIds != null) {
                    if (effectiveSaved.getId() != null) {
                        resolvedIds.add(effectiveSaved.getId());
                    } else if (alertId != null) {
                        resolvedIds.add(alertId);
                    }
                }
                realtimePublisher.publishAlert(toAlertResponse(effectiveSaved));
                notifyEmailOnResolved(effectiveSaved);
                return;
            } catch (OptimisticLockingFailureException ex) {
                log.debug("Optimistic locking conflict while auto-resolving alertId={}, attempt={}", alertId, attempt + 1);
            }
        }
        log.warn("Unable to auto-resolve alertId={} after {} optimistic locking attempts", alertId, OPTIMISTIC_LOCK_MAX_RETRIES);
    }

    private void notifyEmailOnFiredOrEscalated(Alert alert) {
        if (alertEmailNotificationService == null || alert == null) {
            return;
        }
        try {
            alertEmailNotificationService.onAlertFiredOrEscalated(alert);
        } catch (Exception ex) {
            log.warn("Error triggering opening email notification for alertId={}: {}", alert.getId(), ex.getMessage());
        }
    }

    private void notifyEmailOnResolved(Alert alert) {
        if (alertEmailNotificationService == null || alert == null) {
            return;
        }
        try {
            alertEmailNotificationService.onAlertResolved(alert);
        } catch (Exception ex) {
            log.warn("Error triggering resolved email notification for alertId={}: {}", alert.getId(), ex.getMessage());
        }
    }

    private List<Alert> findActiveAlertsSafe() {
        try {
            List<Alert> active = alertRepository.findByStatusIn(List.of(AlertStatus.FIRING, AlertStatus.ACKNOWLEDGED));
            return active != null ? active : List.of();
        } catch (Exception e) {
            log.debug("Skipping active alert fallback scan: {}", e.getMessage());
            return List.of();
        }
    }

    private boolean matchesDevice(String candidateDeviceId, String candidateHardwareId,
                                  String deviceId, String hardwareId, String stateKey) {
        boolean deviceMatch = deviceId != null && !deviceId.isBlank()
                && (deviceId.equals(candidateDeviceId) || (stateKey != null && stateKey.startsWith(deviceId + ":")));
        boolean hwMatch = hardwareId != null && !hardwareId.isBlank()
                && (hardwareId.equals(candidateHardwareId) || (stateKey != null && stateKey.startsWith(hardwareId + ":")));
        return deviceMatch || hwMatch;
    }

    private boolean isHumidityMetric(String metricType, String stateKey) {
        return "HUMIDITY_HIGH".equals(metricType)
                || "HUMIDITY_LOW".equals(metricType)
                || (stateKey != null && (stateKey.endsWith(":HUMIDITY_HIGH") || stateKey.endsWith(":HUMIDITY_LOW")));
    }

    public void resolveDeviceOfflineAlert(String hardwareId) {
        Instant now = clock.instant();
        List<String> offlineFsmAlertIds = new ArrayList<>();
        fsmMap.entrySet().removeIf(entry -> {
            FsmState state = entry.getValue();
            if (state != null && "DEVICE_OFFLINE".equals(state.getMetricType())
                    && hardwareId != null && hardwareId.equals(state.getHardwareId())) {
                if (state.getAlertId() != null) {
                    offlineFsmAlertIds.add(state.getAlertId());
                }
                return true;
            }
            return false;
        });

        Set<String> resolvedIds = resolveFsmAlertIdsInDb(offlineFsmAlertIds, now);
        for (String resolvedId : resolvedIds) {
            log.info("Resolved in-memory DEVICE_OFFLINE alert: hardwareId={}, alertId={}", hardwareId, resolvedId);
        }

        List<Alert> firingAlerts;
        try {
            firingAlerts = alertRepository.findByHardwareIdAndTypeAndStatusIn(
                    hardwareId, AlertType.DEVICE_OFFLINE, List.of(AlertStatus.FIRING, AlertStatus.ACKNOWLEDGED));
        } catch (Exception e) {
            firingAlerts = alertRepository.findByStatus(AlertStatus.FIRING).stream()
                    .filter(a -> a.getType() == AlertType.DEVICE_OFFLINE && hardwareId != null && hardwareId.equals(a.getHardwareId()))
                    .toList();
        }
        if (firingAlerts != null) {
            for (Alert a : firingAlerts) {
                if (a != null && a.getId() != null && resolvedIds.contains(a.getId())) {
                    continue;
                }
                resolveAlertEntity(a, now, resolvedIds);
            }
        }
    }

    public void onAcknowledge(String alertId) {
        if (alertId == null) return;
        for (FsmState state : fsmMap.values()) {
            if (alertId.equals(state.getAlertId())) {
                state.setStatus(AlertStatus.ACKNOWLEDGED);
                log.debug("Updated FSM state to ACKNOWLEDGED for alertId={}", alertId);
                break;
            }
        }
    }

    public void onResolve(String alertId) {
        onResolve(alertId, DEFAULT_SNOOZE_DURATION);
    }

    public void onResolve(String alertId, Duration snoozeDuration) {
        if (alertId == null) return;
        Duration effectiveSnooze = (snoozeDuration != null && !snoozeDuration.isNegative())
                ? snoozeDuration
                : DEFAULT_SNOOZE_DURATION;
        Instant snoozeUntil = clock.instant().plus(effectiveSnooze);
        fsmMap.entrySet().removeIf(entry -> {
            FsmState state = entry.getValue();
            if (state != null && alertId.equals(state.getAlertId())) {
                if (!effectiveSnooze.isZero()) {
                    snoozeUntilMap.put(entry.getKey(), snoozeUntil);
                } else {
                    snoozeUntilMap.remove(entry.getKey());
                }
                return true;
            }
            return false;
        });
        log.debug("Removed FSM state and applied snooze ({}) for resolved alertId={}", effectiveSnooze, alertId);
    }

    public void onResolve(Alert alert, Duration snoozeDuration) {
        if (alert == null) return;
        Duration effectiveSnooze = (snoozeDuration != null && !snoozeDuration.isNegative())
                ? snoozeDuration
                : DEFAULT_SNOOZE_DURATION;
        Instant snoozeUntil = clock.instant().plus(effectiveSnooze);

        final boolean[] removedFromFsm = { false };
        if (alert.getId() != null) {
            fsmMap.entrySet().removeIf(entry -> {
                FsmState state = entry.getValue();
                if (state != null && alert.getId().equals(state.getAlertId())) {
                    if (!effectiveSnooze.isZero()) {
                        snoozeUntilMap.put(entry.getKey(), snoozeUntil);
                    } else {
                        snoozeUntilMap.remove(entry.getKey());
                    }
                    removedFromFsm[0] = true;
                    return true;
                }
                return false;
            });
        }

        if (!removedFromFsm[0]) {
            String targetId = alert.getDeviceId() != null && !alert.getDeviceId().isBlank()
                    ? alert.getDeviceId()
                    : (alert.getRoomId() != null && !alert.getRoomId().isBlank() ? alert.getRoomId() : alert.getHardwareId());
            if (targetId != null && !targetId.isBlank()) {
                String key = targetId + ":" + resolveMetricType(alert);
                fsmMap.remove(key);
                if (!effectiveSnooze.isZero()) {
                    snoozeUntilMap.put(key, snoozeUntil);
                } else {
                    snoozeUntilMap.remove(key);
                }
            }
        }
        log.debug("Removed FSM state and applied snooze ({}) for resolved alertId={}", effectiveSnooze, alert.getId());
    }

    public void reset() {
        fsmMap.clear();
        noisePeakPulsesMap.clear();
        snoozeUntilMap.clear();
        roomContextCache.invalidateAll();
    }

    static String resolveUnit(String metricType, AlertType type) {
        if ("DEVICE_OFFLINE".equals(metricType) || type == AlertType.DEVICE_OFFLINE
                || "SENSOR_MALFUNCTION".equals(metricType) || type == AlertType.SENSOR_MALFUNCTION) {
            return null;
        }
        if ("NOISE_AVG".equals(metricType) || "NOISE_PEAK".equals(metricType) || type == AlertType.NOISE_EXCEEDED) {
            return "dBA";
        }
        if ("TEMPERATURE".equals(metricType)) {
            return "°C";
        }
        if ("HUMIDITY_HIGH".equals(metricType) || "HUMIDITY_LOW".equals(metricType)) {
            return "%RH";
        }
        if ("PM2_5".equals(metricType)) {
            return "µg/m³";
        }
        return null;
    }

    public static AlertResponse toAlertResponse(Alert alert) {
        if (alert == null) return null;
        AlertSeverity sev = alert.getSeverity() != null ? alert.getSeverity() : AlertSeverity.MEDIUM;
        Integer rank = alert.getSeverityRank() != null ? alert.getSeverityRank() : AlertSeverity.rankOf(sev);
        String metricType = resolveMetricType(alert);
        String unit = resolveUnit(metricType, alert.getType());
        String sop = alert.getRecommendedAction();
        if (sop == null || sop.isBlank()) {
            sop = AlertSopCatalog.resolveSop(
                    metricType,
                    alert.getType(),
                    RoomType.STUDY_ROOM);
        }
        return AlertResponse.builder()
                .id(alert.getId())
                .deviceId(alert.getDeviceId())
                .hardwareId(alert.getHardwareId())
                .roomId(alert.getRoomId())
                .zoneId(alert.getZoneId())
                .type(alert.getType())
                .metricType(metricType)
                .unit(unit)
                .severity(sev)
                .severityRank(rank)
                .status(alert.getStatus())
                .currentValue(alert.getCurrentValue())
                .threshold(alert.getThreshold())
                .message(alert.getMessage())
                .recommendedAction(sop)
                .startedAt(alert.getStartedAt())
                .acknowledgedAt(alert.getAcknowledgedAt())
                .resolvedAt(alert.getResolvedAt())
                .acknowledgedBy(alert.getAcknowledgedBy())
                .resolvedBy(alert.getResolvedBy())
                .build();
    }
}
