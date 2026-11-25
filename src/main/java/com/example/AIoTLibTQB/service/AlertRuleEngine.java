package com.example.AIoTLibTQB.service;

import com.example.AIoTLibTQB.configuration.AlertSopCatalog;
import com.example.AIoTLibTQB.document.AffectedNodeSnapshot;
import com.example.AIoTLibTQB.document.Alert;
import com.example.AIoTLibTQB.document.Room;
import com.example.AIoTLibTQB.document.RoomThresholdConfig;
import com.example.AIoTLibTQB.dto.mqtt.TelemetryPayload;
import com.example.AIoTLibTQB.dto.response.AlertResponse;
import com.example.AIoTLibTQB.enums.AlertSeverity;
import com.example.AIoTLibTQB.enums.AlertStatus;
import com.example.AIoTLibTQB.enums.AlertType;
import com.example.AIoTLibTQB.enums.AlertWorkflowStatus;
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
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

@Slf4j
@Component
@FieldDefaults(level = AccessLevel.PRIVATE)
public class AlertRuleEngine {

    public static final String AUTO_STABILIZED_TAG = "AUTO_STABILIZED";

    final AlertRepository alertRepository;
    final RealtimePublisher realtimePublisher;
    final RoomRepository roomRepository;
    final MongoTemplate mongoTemplate;
    final AlertEmailNotificationService alertEmailNotificationService;
    @Getter
    @Setter
    DeviceCommandPublisher deviceCommandPublisher;
    final Clock clock;

    static final Duration PENDING_WINDOW = Duration.ofSeconds(30);
    static final Duration NOISE_TIER1_LED_WINDOW = Duration.ofSeconds(60);
    static final Duration NOISE_PEAK_CALM_CANCEL_WINDOW = Duration.ofSeconds(20);
    static final Duration HYSTERESIS_WINDOW = Duration.ofSeconds(60);
    static final Duration CONFIRM_GRACE_WINDOW = Duration.ofMinutes(15);
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
    final Map<String, String> roomIncidentAlertIds = new ConcurrentHashMap<>();

    @Getter
    final Map<String, List<Instant>> noisePeakPulsesMap = new ConcurrentHashMap<>();

    @Getter
    final Map<String, Instant> snoozeUntilMap = new ConcurrentHashMap<>();

    public AlertRuleEngine(
            AlertRepository alertRepository,
            RealtimePublisher realtimePublisher,
            Clock clock
    ) {
        this(alertRepository, realtimePublisher, clock, null, null, null, null);
    }

    public AlertRuleEngine(
            AlertRepository alertRepository,
            RealtimePublisher realtimePublisher,
            Clock clock,
            RoomRepository roomRepository
    ) {
        this(alertRepository, realtimePublisher, clock, roomRepository, null, null, null);
    }

    public AlertRuleEngine(
            AlertRepository alertRepository,
            RealtimePublisher realtimePublisher,
            Clock clock,
            RoomRepository roomRepository,
            MongoTemplate mongoTemplate
    ) {
        this(alertRepository, realtimePublisher, clock, roomRepository, mongoTemplate, null, null);
    }

    public AlertRuleEngine(
            AlertRepository alertRepository,
            RealtimePublisher realtimePublisher,
            Clock clock,
            RoomRepository roomRepository,
            MongoTemplate mongoTemplate,
            AlertEmailNotificationService alertEmailNotificationService
    ) {
        this(alertRepository, realtimePublisher, clock, roomRepository, mongoTemplate, alertEmailNotificationService, null);
    }

    @Autowired
    public AlertRuleEngine(
            AlertRepository alertRepository,
            RealtimePublisher realtimePublisher,
            @Autowired(required = false) Clock clock,
            @Autowired(required = false) RoomRepository roomRepository,
            @Autowired(required = false) MongoTemplate mongoTemplate,
            @Autowired(required = false) AlertEmailNotificationService alertEmailNotificationService,
            @Autowired(required = false) DeviceCommandPublisher deviceCommandPublisher
    ) {
        this.alertRepository = alertRepository;
        this.realtimePublisher = realtimePublisher;
        this.clock = clock != null ? clock : Clock.systemUTC();
        this.roomRepository = roomRepository;
        this.mongoTemplate = mongoTemplate;
        this.alertEmailNotificationService = alertEmailNotificationService;
        this.deviceCommandPublisher = deviceCommandPublisher != null
                ? deviceCommandPublisher
                : new DeviceCommandPublisherImpl(null, null, null, this.clock);
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

    static String resolveRoomIncidentKey(String roomId, AlertType alertType, String metricType) {
        if (roomId == null || roomId.isBlank() || alertType == null) {
            return null;
        }
        if (alertType == AlertType.DEVICE_OFFLINE || alertType == AlertType.SENSOR_MALFUNCTION
                || "DEVICE_OFFLINE".equals(metricType) || "SENSOR_MALFUNCTION".equals(metricType)) {
            return null;
        }
        String normalizedRoom = roomId.trim();
        if (alertType == AlertType.NOISE_EXCEEDED
                || "NOISE_AVG".equals(metricType)
                || "NOISE_PEAK".equals(metricType)) {
            return "room:" + normalizedRoom + ":NOISE";
        }
        String safeMetric = (metricType != null && !metricType.isBlank()) ? metricType.trim() : alertType.name();
        return "room:" + normalizedRoom + ":" + safeMetric;
    }

    static boolean supportsLocalLedForAlert(RoomType roomType, AlertType alertType) {
        RoomType actual = roomType != null ? roomType : RoomType.STUDY_ROOM;
        return alertType == AlertType.NOISE_EXCEEDED
                && (actual == RoomType.STUDY_ROOM || actual == RoomType.CIRCULATION_HALL);
    }

    @PostConstruct
    public void rehydrateActiveAlerts() {
        try {
            migrateLegacyAlertsSeverity();
            List<Alert> activeAlerts = alertRepository.findByStatusIn(List.of(AlertStatus.FIRING, AlertStatus.ACKNOWLEDGED));
            if (activeAlerts != null) {
                for (Alert alert : activeAlerts) {
                    if (alert == null || Boolean.TRUE.equals(alert.getSensorRecovered())) {
                        continue;
                    }
                    String fallbackMetricType = resolveMetricType(alert);
                    String incidentKey = resolveRoomIncidentKey(alert.getRoomId(), alert.getType(), fallbackMetricType);
                    if (incidentKey != null && alert.getId() != null) {
                        roomIncidentAlertIds.put(incidentKey, alert.getId());
                    }

                    if (alert.getAffectedNodes() != null && !alert.getAffectedNodes().isEmpty()) {
                        for (AffectedNodeSnapshot snap : alert.getAffectedNodes()) {
                            if (snap == null) continue;
                            String nodeTarget = snap.getDeviceId() != null && !snap.getDeviceId().isBlank()
                                    ? snap.getDeviceId()
                                    : snap.getHardwareId();
                            if (nodeTarget == null || nodeTarget.isBlank()) continue;
                            String nodeMetric = (snap.getMetricType() != null && !snap.getMetricType().isBlank())
                                    ? snap.getMetricType()
                                    : fallbackMetricType;
                            FsmState state = new FsmState();
                            state.setStatus(alert.getStatus());
                            state.setFiringSince(alert.getStartedAt() != null ? alert.getStartedAt() : clock.instant());
                            state.setAlertId(alert.getId());
                            state.setIncidentKey(incidentKey);
                            state.setThreshold(snap.getThreshold() != null ? snap.getThreshold() : alert.getThreshold());
                            state.setLastValue(snap.getCurrentValue() != null ? snap.getCurrentValue() : alert.getCurrentValue());
                            state.setAlertType(alert.getType());
                            state.setSeverity(alert.getSeverity() != null ? alert.getSeverity() : AlertSeverity.MEDIUM);
                            state.setMetricType(nodeMetric);
                            state.setDeviceId(snap.getDeviceId());
                            state.setHardwareId(snap.getHardwareId());
                            state.setRoomId(alert.getRoomId());
                            state.setZoneId(alert.getZoneId());
                            state.setLastEvaluatedAt(clock.instant());
                            fsmMap.put(nodeTarget + ":" + nodeMetric, state);
                        }
                        continue;
                    }

                    String targetId = alert.getDeviceId() != null && !alert.getDeviceId().isBlank()
                            ? alert.getDeviceId()
                            : (alert.getRoomId() != null && !alert.getRoomId().isBlank() ? alert.getRoomId() : alert.getHardwareId());
                    if (targetId == null) continue;
                    String key = targetId + ":" + fallbackMetricType;

                    FsmState state = new FsmState();
                    state.setStatus(alert.getStatus());
                    state.setFiringSince(alert.getStartedAt() != null ? alert.getStartedAt() : clock.instant());
                    state.setAlertId(alert.getId());
                    state.setIncidentKey(incidentKey);
                    state.setThreshold(alert.getThreshold());
                    state.setLastValue(alert.getCurrentValue());
                    state.setAlertType(alert.getType());
                    state.setSeverity(alert.getSeverity() != null ? alert.getSeverity() : AlertSeverity.MEDIUM);
                    state.setMetricType(fallbackMetricType);
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
        String lower = msg.toLowerCase(Locale.ROOT);
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
        String incidentKey;
        Double lastValue;
        Double threshold;
        AlertType alertType;
        AlertSeverity severity;
        String metricType;
        String message;
        String recommendedAction;
        String deviceId;
        String hardwareId;
        String roomId;
        String zoneId;
        boolean localLedEnabled;
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

        boolean tier1NoiseRoom = supportsLocalLedForAlert(roomType, AlertType.NOISE_EXCEEDED);
        Duration noisePendingWindow = tier1NoiseRoom ? NOISE_TIER1_LED_WINDOW : PENDING_WINDOW;

        // 1. noiseAvg > noiseAvgMax (with deadband; 60s Tier-1 LED window in STUDY_ROOM / CIRCULATION_HALL)
        if (data.getAcoustics() != null && data.getAcoustics().getNoiseAvg() != null) {
            double noiseAvg = data.getAcoustics().getNoiseAvg();
            boolean isBreached = noiseAvg > noiseAvgMax;
            boolean isRecovered = noiseAvg <= (noiseAvgMax - DEADBAND_NOISE);
            String sop = AlertSopCatalog.resolveSop("NOISE_AVG", AlertType.NOISE_EXCEEDED, roomType);
            evaluateMetric(targetId, "NOISE_AVG", isBreached, isRecovered, noiseAvg,
                    noiseAvgMax, AlertType.NOISE_EXCEEDED, AlertSeverity.MEDIUM,
                    String.format(Locale.US, "Average noise level (%.1f dBA) exceeded threshold (%.1f dBA)", noiseAvg, noiseAvgMax),
                    sop, deviceId, hardwareId, roomId, zoneId, false, noisePendingWindow, tier1NoiseRoom);
        } else {
            resolveStaleMetricIfAbsent(targetId, "NOISE_AVG", now);
        }

        // 2. noisePeak dual-threshold:
        //    - >= noisePeakImmediate (85 dBA): fire immediately (CRITICAL) + CRITICAL_BLINK LED
        //    - >= noisePeakMax (75/80 dBA) with >= 3 pulses in 60s:
        //      * STUDY_ROOM / CIRCULATION_HALL: Tier-1 60s LED warning first; cancel if quiet >= 20s; fire HIGH if sustained >= 60s
        //      * BOOK_STORAGE: fire immediately (HIGH), no LED
        if (data.getAcoustics() != null && data.getAcoustics().getNoisePeak() != null) {
            Double noisePeak = data.getAcoustics().getNoisePeak();
            String pulseKey = targetId + ":NOISE_PEAK_PULSES";
            boolean immediateSevere = noisePeak >= noisePeakImmediate;
            boolean moderatePulse = noisePeak > noisePeakMax;
            int pulseCount = 0;
            Instant latestPulseAt = null;

            if (moderatePulse) {
                List<Instant> pulses = noisePeakPulsesMap.computeIfAbsent(pulseKey, k -> new ArrayList<>());
                synchronized (pulses) {
                    pulses.removeIf(t -> Duration.between(t, now).compareTo(NOISE_PEAK_PULSE_WINDOW) > 0);
                    Instant lastPulse = pulses.isEmpty() ? null : pulses.get(pulses.size() - 1);
                    if (lastPulse == null || Duration.between(lastPulse, now).compareTo(NOISE_PEAK_PULSE_COOLDOWN) >= 0) {
                        pulses.add(now);
                    }
                    pulseCount = pulses.size();
                    latestPulseAt = pulses.isEmpty() ? null : pulses.get(pulses.size() - 1);
                }
            } else if (noisePeak <= (noisePeakMax - DEADBAND_NOISE)) {
                List<Instant> pulses = noisePeakPulsesMap.get(pulseKey);
                if (pulses != null) {
                    synchronized (pulses) {
                        pulses.removeIf(t -> Duration.between(t, now).compareTo(NOISE_PEAK_PULSE_WINDOW) > 0);
                        pulseCount = pulses.size();
                        latestPulseAt = pulses.isEmpty() ? null : pulses.get(pulses.size() - 1);
                    }
                }
            }

            FsmState currentPeakState = fsmMap.get(targetId + ":NOISE_PEAK");
            boolean alreadyInPeakPending = currentPeakState != null && currentPeakState.getStatus() == AlertStatus.PENDING;
            boolean hasActivePulseCluster = pulseCount >= NOISE_PEAK_PULSE_REQUIRED
                    && latestPulseAt != null
                    && Duration.between(latestPulseAt, now).compareTo(NOISE_PEAK_CALM_CANCEL_WINDOW) < 0;

            boolean shouldBreachPeak = immediateSevere
                    || (moderatePulse && pulseCount >= NOISE_PEAK_PULSE_REQUIRED)
                    || (tier1NoiseRoom && alreadyInPeakPending && hasActivePulseCluster);

            boolean isRecoveredPeak;
            if (tier1NoiseRoom && alreadyInPeakPending) {
                boolean quietForCalmWindow = latestPulseAt == null
                        || Duration.between(latestPulseAt, now).compareTo(NOISE_PEAK_CALM_CANCEL_WINDOW) >= 0;
                isRecoveredPeak = noisePeak <= (noisePeakMax - DEADBAND_NOISE) && quietForCalmWindow;
                if (isRecoveredPeak) {
                    noisePeakPulsesMap.remove(pulseKey);
                }
            } else {
                isRecoveredPeak = noisePeak <= (noisePeakMax - DEADBAND_NOISE);
            }

            boolean immediatePeakFire = immediateSevere || !tier1NoiseRoom;
            AlertSeverity peakSeverity = immediateSevere ? AlertSeverity.CRITICAL : AlertSeverity.HIGH;
            double activeThreshold = immediateSevere ? noisePeakImmediate : noisePeakMax;
            String sop = AlertSopCatalog.resolveSop("NOISE_PEAK", AlertType.NOISE_EXCEEDED, roomType);

            evaluateMetric(targetId, "NOISE_PEAK", shouldBreachPeak, isRecoveredPeak, noisePeak,
                    activeThreshold, AlertType.NOISE_EXCEEDED, peakSeverity,
                    String.format(Locale.US, "Peak noise spike (%.1f dBA) exceeded threshold (%.1f dBA)", noisePeak, activeThreshold),
                    sop, deviceId, hardwareId, roomId, zoneId, immediatePeakFire, noisePendingWindow, tier1NoiseRoom);
        } else {
            resolveStaleMetricIfAbsent(targetId, "NOISE_PEAK", now);
        }

        // 3. temp > tempMax (30s pending, no student LED)
        if (data.getEnvironment() != null && data.getEnvironment().getTemperature() != null) {
            double temp = data.getEnvironment().getTemperature();
            boolean isBreached = temp > tempMax;
            boolean isRecovered = temp <= (tempMax - DEADBAND_TEMP);
            String sop = AlertSopCatalog.resolveSop("TEMPERATURE", AlertType.AIR_UNHEALTHY, roomType);
            evaluateMetric(targetId, "TEMPERATURE", isBreached, isRecovered, temp,
                    tempMax, AlertType.AIR_UNHEALTHY, AlertSeverity.MEDIUM,
                    String.format(Locale.US, "Temperature (%.1f °C) exceeded threshold (%.1f °C)", temp, tempMax),
                    sop, deviceId, hardwareId, roomId, zoneId, false, PENDING_WINDOW, false);
        } else {
            resolveStaleMetricIfAbsent(targetId, "TEMPERATURE", now);
        }

        // 4. BOOK_STORAGE humidity rules (min / max with deadband, 30s pending, no LED)
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
                        String.format(Locale.US, "Book storage humidity (%.1f %%RH) exceeded max threshold (%.1f %%RH)", rh, rhMax),
                        highSop, deviceId, hardwareId, roomId, zoneId, false, PENDING_WINDOW, false);

                boolean lowBreach = rh < rhMin;
                boolean lowRecovered = rh >= (rhMin + DEADBAND_HUMIDITY);
                String lowSop = AlertSopCatalog.resolveSop("HUMIDITY_LOW", AlertType.AIR_UNHEALTHY, roomType);
                evaluateMetric(targetId, "HUMIDITY_LOW", lowBreach, lowRecovered, rh,
                        rhMin, AlertType.AIR_UNHEALTHY, AlertSeverity.MEDIUM,
                        String.format(Locale.US, "Book storage humidity (%.1f %%RH) dropped below min threshold (%.1f %%RH)", rh, rhMin),
                        lowSop, deviceId, hardwareId, roomId, zoneId, false, PENDING_WINDOW, false);
            } else {
                resolveStaleMetricIfAbsent(targetId, "HUMIDITY_HIGH", now);
                resolveStaleMetricIfAbsent(targetId, "HUMIDITY_LOW", now);
            }
        } else {
            resolveMetricByKey(targetId, "HUMIDITY_HIGH", now, "Room type is no longer BOOK_STORAGE");
            resolveMetricByKey(targetId, "HUMIDITY_LOW", now, "Room type is no longer BOOK_STORAGE");
        }

        // 5. pm2.5 > pm25Max (30s pending, no LED)
        if (data.getAirQuality() != null && data.getAirQuality().getPm2_5() != null) {
            double pm25 = data.getAirQuality().getPm2_5();
            boolean isBreached = pm25 > pm25Max;
            boolean isRecovered = pm25 <= (pm25Max - DEADBAND_PM25);
            String sop = AlertSopCatalog.resolveSop("PM2_5", AlertType.AIR_UNHEALTHY, roomType);
            evaluateMetric(targetId, "PM2_5", isBreached, isRecovered, pm25,
                    pm25Max, AlertType.AIR_UNHEALTHY, AlertSeverity.HIGH,
                    String.format(Locale.US, "PM2.5 particulate level (%.1f µg/m³) exceeded threshold (%.1f µg/m³)", pm25, pm25Max),
                    sop, deviceId, hardwareId, roomId, zoneId, false, PENDING_WINDOW, false);
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
                false,
                PENDING_WINDOW,
                false
        );
    }

    private boolean checkOrClearSnooze(String key, String incidentKey, Instant now, boolean isBreached, boolean isRecovered, AlertSeverity severity) {
        boolean suppressed = false;
        for (String snoozeKey : new String[]{key, incidentKey}) {
            if (snoozeKey == null) continue;
            Instant snoozedUntil = snoozeUntilMap.get(snoozeKey);
            if (snoozedUntil == null) continue;

            if (!now.isBefore(snoozedUntil)) {
                snoozeUntilMap.remove(snoozeKey);
            } else if (isRecovered && snoozeKey.equals(key)) {
                snoozeUntilMap.remove(key);
                if (incidentKey != null && areAllRoomNodesInactive(incidentKey, key)) {
                    snoozeUntilMap.remove(incidentKey);
                }
            } else if (severity == AlertSeverity.CRITICAL && isBreached) {
                snoozeUntilMap.remove(snoozeKey);
                log.info("Snooze overridden by CRITICAL alert: snoozeKey={}, valueSeverity=CRITICAL", snoozeKey);
            } else {
                suppressed = true;
            }
        }
        return suppressed;
    }

    private boolean areAllRoomNodesInactive(String incidentKey, String excludeKey) {
        for (Map.Entry<String, FsmState> entry : fsmMap.entrySet()) {
            if (entry.getKey().equals(excludeKey)) continue;
            FsmState st = entry.getValue();
            if (st != null && incidentKey.equals(st.getIncidentKey())) {
                return false;
            }
        }
        return true;
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
            boolean immediateFire,
            Duration pendingWindow,
            boolean localLedEnabled
    ) {
        String key = targetId + ":" + metricType;
        String incidentKey = resolveRoomIncidentKey(roomId, alertType, metricType);
        Instant now = clock.instant();

        final boolean[] transitionedToFiring = { false };
        final boolean[] valueOrSeverityChangedInFiring = { false };
        final boolean[] enteredPendingWithLed = { false };
        final boolean[] cancelledPendingWithLed = { false };
        final boolean[] recoveredFromFiring = { false };
        final String[] priorAlertIdHolder = { null };

        fsmMap.compute(key, (k, state) -> {
            if (state == null) {
                if (checkOrClearSnooze(key, incidentKey, now, isBreached, isRecovered, severity)) {
                    log.debug("Alert suppressed by active snooze: key={}, incidentKey={}", key, incidentKey);
                    return null;
                }

                if (isBreached) {
                    FsmState newState = new FsmState();
                    newState.setLastEvaluatedAt(now);
                    newState.setLastValue(currentValue);
                    newState.setThreshold(threshold);
                    newState.setAlertType(alertType);
                    newState.setSeverity(severity);
                    newState.setMetricType(metricType);
                    newState.setMessage(message);
                    newState.setRecommendedAction(recommendedAction);
                    newState.setDeviceId(deviceId);
                    newState.setHardwareId(hardwareId);
                    newState.setRoomId(roomId);
                    newState.setZoneId(zoneId);
                    newState.setIncidentKey(incidentKey);
                    newState.setLocalLedEnabled(localLedEnabled);

                    if (immediateFire) {
                        newState.setStatus(AlertStatus.FIRING);
                        newState.setFiringSince(now);
                        newState.setRecoverySince(null);
                        transitionedToFiring[0] = true;
                        log.info("Alert FSM entered FIRING immediately: key={}, value={}, threshold={}", key, currentValue, threshold);
                    } else {
                        newState.setStatus(AlertStatus.PENDING);
                        newState.setPendingSince(now);
                        if (localLedEnabled) {
                            enteredPendingWithLed[0] = true;
                        }
                        log.debug("Alert FSM entered PENDING ({}s): key={}, value={}, threshold={}",
                                pendingWindow.getSeconds(), key, currentValue, threshold);
                    }
                    return newState;
                }
                return null;
            }

            // Existing state is PENDING
            if (state.getStatus() == AlertStatus.PENDING) {
                if (isBreached) {
                    state.setLastValue(currentValue);
                    state.setLastEvaluatedAt(now);
                    state.setMessage(message);
                    state.setRecommendedAction(recommendedAction);
                    if (zoneId != null) {
                        state.setZoneId(zoneId);
                    }
                    if (AlertSeverity.rankOf(severity) > AlertSeverity.rankOf(state.getSeverity())) {
                        state.setSeverity(severity);
                        state.setThreshold(threshold);
                    }
                    long pendingSeconds = Duration.between(state.getPendingSince(), now).getSeconds();
                    if (immediateFire || pendingSeconds >= pendingWindow.getSeconds()) {
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
                        transitionedToFiring[0] = true;
                    }
                    return state;
                } else if (!isRecovered) {
                    state.setLastValue(currentValue);
                    state.setLastEvaluatedAt(now);
                    return state;
                } else {
                    if (state.isLocalLedEnabled()) {
                        cancelledPendingWithLed[0] = true;
                    }
                    log.debug("Alert FSM cancelled PENDING (resolved locally before escalation): key={}", key);
                    return null;
                }
            }

            // Existing state is FIRING or ACKNOWLEDGED
            if (state.getStatus() == AlertStatus.FIRING || state.getStatus() == AlertStatus.ACKNOWLEDGED) {
                state.setLastEvaluatedAt(now);
                if (isBreached) {
                    state.setLastValue(currentValue);
                    state.setMessage(message);
                    int newRank = AlertSeverity.rankOf(severity);
                    int oldRank = AlertSeverity.rankOf(state.getSeverity());
                    if (newRank > oldRank) {
                        state.setSeverity(severity);
                        state.setThreshold(threshold);
                        valueOrSeverityChangedInFiring[0] = true;
                    }
                    if (state.getRecoverySince() != null) {
                        state.setRecoverySince(null);
                        log.debug("Alert FSM recovery timer reset due to breach spike: key={}", key);
                    }
                    return state;
                } else if (!isRecovered) {
                    state.setLastValue(currentValue);
                    if (state.getRecoverySince() != null) {
                        long recoverySeconds = Duration.between(state.getRecoverySince(), now).getSeconds();
                        if (recoverySeconds >= HYSTERESIS_WINDOW.getSeconds()) {
                            priorAlertIdHolder[0] = state.getAlertId();
                            recoveredFromFiring[0] = true;
                            return null;
                        }
                    }
                    return state;
                } else {
                    if (state.getRecoverySince() == null) {
                        state.setRecoverySince(now);
                        log.debug("Alert FSM started recovery hysteresis window: key={}", key);
                        return state;
                    } else {
                        long recoverySeconds = Duration.between(state.getRecoverySince(), now).getSeconds();
                        if (recoverySeconds >= HYSTERESIS_WINDOW.getSeconds()) {
                            priorAlertIdHolder[0] = state.getAlertId();
                            recoveredFromFiring[0] = true;
                            return null;
                        }
                        return state;
                    }
                }
            }

            return state;
        });

        // Side-effects outside ConcurrentHashMap.compute lock
        if (enteredPendingWithLed[0] && hardwareId != null) {
            deviceCommandPublisher.publishLedState(
                    hardwareId,
                    DeviceCommandPublisher.LED_WARN_PULSE,
                    "TIER1_" + metricType + "_PENDING",
                    currentValue,
                    threshold
            );
        } else if (cancelledPendingWithLed[0] && hardwareId != null) {
            refreshDeviceLedForHardware(deviceId, hardwareId, metricType, currentValue, threshold);
        }

        if (transitionedToFiring[0]) {
            FsmState firedState = fsmMap.get(key);
            if (firedState != null && firedState.isLocalLedEnabled() && hardwareId != null) {
                String ledTarget = firedState.getSeverity() == AlertSeverity.CRITICAL
                        ? DeviceCommandPublisher.LED_CRITICAL_BLINK
                        : (firedState.getStatus() == AlertStatus.ACKNOWLEDGED
                                ? DeviceCommandPublisher.LED_STAFF_DISPATCHED
                                : DeviceCommandPublisher.LED_WARN_PULSE);
                deviceCommandPublisher.publishLedState(
                        hardwareId,
                        ledTarget,
                        "TIER2_" + metricType + "_FIRING",
                        currentValue,
                        firedState.getThreshold()
                );
            }
            persistOrMergeFiringState(key, incidentKey, now);
        } else if (valueOrSeverityChangedInFiring[0]) {
            FsmState activeState = fsmMap.get(key);
            if (activeState != null && activeState.isLocalLedEnabled()
                    && activeState.getSeverity() == AlertSeverity.CRITICAL && hardwareId != null) {
                deviceCommandPublisher.publishLedState(
                        hardwareId,
                        DeviceCommandPublisher.LED_CRITICAL_BLINK,
                        "TIER2_" + metricType + "_CRITICAL",
                        currentValue,
                        activeState.getThreshold()
                );
            }
            syncExistingIncidentInDb(key, incidentKey, now);
        } else if (recoveredFromFiring[0]) {
            if (localLedEnabled && hardwareId != null) {
                refreshDeviceLedForHardware(deviceId, hardwareId, metricType, currentValue, threshold);
            }
            handleNodeChannelRecovered(incidentKey, priorAlertIdHolder[0], now);
        }
    }

    private void refreshDeviceLedForHardware(
            String deviceId,
            String hardwareId,
            String reasonMetric,
            Double measuredValue,
            Double thresholdValue
    ) {
        if (hardwareId == null || hardwareId.isBlank()) {
            return;
        }
        AlertSeverity maxActiveSev = null;
        boolean anyAcknowledged = false;
        boolean anyActiveNoise = false;

        for (FsmState st : fsmMap.values()) {
            if (st == null || !st.isLocalLedEnabled()) continue;
            boolean sameHw = hardwareId.equals(st.getHardwareId())
                    || (deviceId != null && !deviceId.isBlank() && deviceId.equals(st.getDeviceId()));
            if (!sameHw) continue;
            anyActiveNoise = true;
            if (st.getStatus() == AlertStatus.ACKNOWLEDGED) {
                anyAcknowledged = true;
            }
            if (maxActiveSev == null || AlertSeverity.rankOf(st.getSeverity()) > AlertSeverity.rankOf(maxActiveSev)) {
                maxActiveSev = st.getSeverity();
            }
        }

        if (!anyActiveNoise) {
            deviceCommandPublisher.publishLedState(
                    hardwareId,
                    DeviceCommandPublisher.LED_NORMAL,
                    reasonMetric + "_RECOVERED",
                    measuredValue,
                    thresholdValue
            );
        } else if (maxActiveSev == AlertSeverity.CRITICAL) {
            deviceCommandPublisher.publishLedState(
                    hardwareId,
                    DeviceCommandPublisher.LED_CRITICAL_BLINK,
                    reasonMetric + "_STILL_CRITICAL",
                    measuredValue,
                    thresholdValue
            );
        } else if (anyAcknowledged) {
            deviceCommandPublisher.publishLedState(
                    hardwareId,
                    DeviceCommandPublisher.LED_STAFF_DISPATCHED,
                    reasonMetric + "_STAFF_DISPATCHED",
                    measuredValue,
                    thresholdValue
            );
        } else {
            deviceCommandPublisher.publishLedState(
                    hardwareId,
                    DeviceCommandPublisher.LED_WARN_PULSE,
                    reasonMetric + "_STILL_ACTIVE",
                    measuredValue,
                    thresholdValue
            );
        }
    }

    private List<FsmState> findActiveStatesForIncident(String key, String incidentKey) {
        List<FsmState> list = new ArrayList<>();
        if (incidentKey != null) {
            for (FsmState st : fsmMap.values()) {
                if (st != null && incidentKey.equals(st.getIncidentKey())
                        && (st.getStatus() == AlertStatus.FIRING || st.getStatus() == AlertStatus.ACKNOWLEDGED)) {
                    list.add(st);
                }
            }
        } else {
            FsmState single = fsmMap.get(key);
            if (single != null && (single.getStatus() == AlertStatus.FIRING || single.getStatus() == AlertStatus.ACKNOWLEDGED)) {
                list.add(single);
            }
        }
        return list;
    }

    private static Comparator<FsmState> epicenterComparator() {
        return Comparator
                .comparingInt((FsmState s) -> AlertSeverity.rankOf(s.getSeverity()))
                .thenComparingDouble(s -> {
                    double v = s.getLastValue() != null ? s.getLastValue() : 0.0;
                    double t = s.getThreshold() != null ? s.getThreshold() : 0.0;
                    return "HUMIDITY_LOW".equals(s.getMetricType()) ? (t - v) : (v - t);
                })
                .thenComparing((s1, s2) -> {
                    Instant t1 = s1.getLastEvaluatedAt();
                    Instant t2 = s2.getLastEvaluatedAt();
                    if (Objects.equals(t1, t2)) return 0;
                    if (t1 == null) return -1;
                    if (t2 == null) return 1;
                    return t1.compareTo(t2);
                });
    }

    private static List<AffectedNodeSnapshot> buildAffectedNodeSnapshots(List<FsmState> activeStates, Instant now) {
        if (activeStates == null || activeStates.isEmpty()) {
            return List.of();
        }
        Map<String, FsmState> bestPerNode = new LinkedHashMap<>();
        Comparator<FsmState> cmp = epicenterComparator();
        for (FsmState st : activeStates) {
            String nodeKey = (st.getDeviceId() != null && !st.getDeviceId().isBlank())
                    ? st.getDeviceId()
                    : (st.getHardwareId() != null ? st.getHardwareId() : st.getMetricType());
            FsmState prev = bestPerNode.get(nodeKey);
            if (prev == null || cmp.compare(st, prev) > 0) {
                bestPerNode.put(nodeKey, st);
            }
        }
        return bestPerNode.values().stream()
                .sorted(cmp.reversed())
                .map(st -> AffectedNodeSnapshot.builder()
                        .deviceId(st.getDeviceId())
                        .hardwareId(st.getHardwareId())
                        .metricType(st.getMetricType())
                        .currentValue(st.getLastValue())
                        .threshold(st.getThreshold())
                        .updatedAt(st.getLastEvaluatedAt() != null ? st.getLastEvaluatedAt() : now)
                        .build())
                .toList();
    }

    private String findExistingAlertId(String key, String incidentKey) {
        if (incidentKey != null) {
            String mappedId = roomIncidentAlertIds.get(incidentKey);
            if (mappedId != null) {
                return mappedId;
            }
            for (FsmState st : fsmMap.values()) {
                if (st != null && incidentKey.equals(st.getIncidentKey()) && st.getAlertId() != null) {
                    return st.getAlertId();
                }
            }
        }
        FsmState current = fsmMap.get(key);
        return current != null ? current.getAlertId() : null;
    }

    private void persistOrMergeFiringState(String key, String incidentKey, Instant now) {
        List<FsmState> activeStates = findActiveStatesForIncident(key, incidentKey);
        if (activeStates.isEmpty()) {
            return;
        }
        FsmState epicenter = activeStates.stream().max(epicenterComparator()).orElse(activeStates.get(0));
        List<AffectedNodeSnapshot> snapshots = incidentKey != null
                ? buildAffectedNodeSnapshots(activeStates, now)
                : null;

        String existingAlertId = findExistingAlertId(key, incidentKey);
        if (existingAlertId != null) {
            boolean merged = mergeIntoExistingAlertInDb(existingAlertId, key, incidentKey, epicenter, snapshots);
            if (merged) {
                return;
            }
        }

        Alert alertToSave = Alert.builder()
                .deviceId(epicenter.getDeviceId())
                .hardwareId(epicenter.getHardwareId())
                .roomId(epicenter.getRoomId())
                .zoneId(epicenter.getZoneId())
                .type(epicenter.getAlertType())
                .metricType(epicenter.getMetricType())
                .severity(epicenter.getSeverity())
                .severityRank(AlertSeverity.rankOf(epicenter.getSeverity()))
                .status(AlertStatus.FIRING)
                .workflowStatus(AlertWorkflowStatus.NEW)
                .affectedNodes(snapshots)
                .currentValue(epicenter.getLastValue())
                .threshold(epicenter.getThreshold())
                .message(formatMergedMessage(epicenter, snapshots))
                .recommendedAction(epicenter.getRecommendedAction())
                .startedAt(now)
                .build();

        Alert savedAlert = alertRepository.save(alertToSave);
        Alert effectiveSaved = savedAlert != null ? savedAlert : alertToSave;
        String savedId = effectiveSaved.getId();

        if (savedId != null) {
            if (incidentKey != null) {
                roomIncidentAlertIds.put(incidentKey, savedId);
                for (FsmState st : activeStates) {
                    st.setAlertId(savedId);
                }
            } else {
                FsmState s = fsmMap.get(key);
                if (s != null) {
                    s.setAlertId(savedId);
                }
            }
        }

        realtimePublisher.publishAlert(toAlertResponse(effectiveSaved));
        notifyEmailOnFiredOrEscalated(effectiveSaved);
        log.info("Alert FSM transitioned to FIRING: key={}, incidentKey={}, alertId={}, value={}",
                key, incidentKey, savedId, epicenter.getLastValue());
    }

    private boolean mergeIntoExistingAlertInDb(
            String alertId,
            String triggeredKey,
            String incidentKey,
            FsmState epicenter,
            List<AffectedNodeSnapshot> snapshots
    ) {
        for (int attempt = 0; attempt < OPTIMISTIC_LOCK_MAX_RETRIES; attempt++) {
            Optional<Alert> alertOpt = alertRepository.findById(alertId);
            if (alertOpt == null || alertOpt.isEmpty()) {
                if (incidentKey != null) {
                    roomIncidentAlertIds.remove(incidentKey, alertId);
                }
                return false;
            }
            Alert alert = alertOpt.get();
            if (alert.getStatus() == AlertStatus.RESOLVED) {
                if (incidentKey != null) {
                    roomIncidentAlertIds.remove(incidentKey, alertId);
                }
                return false;
            }

            int oldRank = AlertSeverity.rankOf(alert.getSeverity());
            int epicenterRank = AlertSeverity.rankOf(epicenter.getSeverity());
            boolean escalated = epicenterRank > oldRank;
            if (escalated) {
                alert.setSeverity(epicenter.getSeverity());
                alert.setSeverityRank(epicenterRank);
            }

            alert.setDeviceId(epicenter.getDeviceId());
            alert.setHardwareId(epicenter.getHardwareId());
            alert.setMetricType(epicenter.getMetricType());
            alert.setCurrentValue(epicenter.getLastValue());
            alert.setThreshold(epicenter.getThreshold());
            alert.setMessage(formatMergedMessage(epicenter, snapshots));
            if (snapshots != null) {
                alert.setAffectedNodes(snapshots);
            }
            // Nếu sự cố phòng trước đó đã êm tạm thời nhưng nay bùng phát lại trước khi đóng -> gỡ cờ sensorRecovered
            if (Boolean.TRUE.equals(alert.getSensorRecovered())) {
                alert.setSensorRecovered(false);
                alert.setSensorRecoveredAt(null);
            }

            try {
                Alert saved = alertRepository.save(alert);
                Alert effectiveSaved = saved != null ? saved : alert;

                FsmState joiningState = fsmMap.get(triggeredKey);
                if (joiningState != null) {
                    joiningState.setAlertId(alertId);
                    if (alert.getStatus() == AlertStatus.ACKNOWLEDGED) {
                        joiningState.setStatus(AlertStatus.ACKNOWLEDGED);
                        if (joiningState.isLocalLedEnabled()
                                && joiningState.getSeverity() != AlertSeverity.CRITICAL
                                && joiningState.getHardwareId() != null) {
                            deviceCommandPublisher.publishLedState(
                                    joiningState.getHardwareId(),
                                    DeviceCommandPublisher.LED_STAFF_DISPATCHED,
                                    "JOINED_IN_PROGRESS_ROOM_ALERT",
                                    joiningState.getLastValue(),
                                    joiningState.getThreshold()
                            );
                        }
                    }
                }

                realtimePublisher.publishAlert(toAlertResponse(effectiveSaved));
                if (escalated) {
                    notifyEmailOnFiredOrEscalated(effectiveSaved);
                }
                log.info("Merged/updated active room alert: incidentKey={}, alertId={}, affectedNodes={}, severity={}",
                        incidentKey, alertId, snapshots != null ? snapshots.size() : 1, effectiveSaved.getSeverity());
                return true;
            } catch (OptimisticLockingFailureException ex) {
                log.debug("Optimistic locking conflict while merging room alertId={}, attempt={}", alertId, attempt + 1);
            }
        }
        return true;
    }

    private void syncExistingIncidentInDb(String key, String incidentKey, Instant now) {
        List<FsmState> activeStates = findActiveStatesForIncident(key, incidentKey);
        if (activeStates.isEmpty()) {
            return;
        }
        String alertId = findExistingAlertId(key, incidentKey);
        if (alertId == null) {
            return;
        }
        FsmState epicenter = activeStates.stream().max(epicenterComparator()).orElse(activeStates.get(0));
        List<AffectedNodeSnapshot> snapshots = incidentKey != null
                ? buildAffectedNodeSnapshots(activeStates, now)
                : null;
        mergeIntoExistingAlertInDb(alertId, key, incidentKey, epicenter, snapshots);
    }

    private static String formatMergedMessage(FsmState epicenter, List<AffectedNodeSnapshot> snapshots) {
        String base = epicenter.getMessage();
        if (snapshots != null && snapshots.size() > 1) {
            return base + String.format(" [Ghi nhận tại %d trạm trong phòng]", snapshots.size());
        }
        return base;
    }

    private void handleNodeChannelRecovered(String incidentKey, String alertId, Instant now) {
        if (incidentKey != null) {
            List<FsmState> remaining = findActiveStatesForIncident(null, incidentKey);
            if (!remaining.isEmpty()) {
                String activeAlertId = alertId != null ? alertId : roomIncidentAlertIds.get(incidentKey);
                if (activeAlertId != null) {
                    FsmState nextEpicenter = remaining.stream().max(epicenterComparator()).orElse(remaining.get(0));
                    List<AffectedNodeSnapshot> snapshots = buildAffectedNodeSnapshots(remaining, now);
                    mergeIntoExistingAlertInDb(activeAlertId, "", incidentKey, nextEpicenter, snapshots);
                }
                return;
            }
            if (alertId != null) {
                roomIncidentAlertIds.remove(incidentKey, alertId);
            } else {
                roomIncidentAlertIds.remove(incidentKey);
            }
        }

        if (alertId != null) {
            handleIncidentPhysicallyRecovered(alertId, now);
        }
    }

    private void handleIncidentPhysicallyRecovered(String alertId, Instant now) {
        for (int attempt = 0; attempt < OPTIMISTIC_LOCK_MAX_RETRIES; attempt++) {
            Optional<Alert> alertOpt = alertRepository.findById(alertId);
            if (alertOpt == null || alertOpt.isEmpty()) {
                return;
            }
            Alert current = alertOpt.get();
            if (current.getStatus() == AlertStatus.RESOLVED) {
                return;
            }

            boolean awaitingLibrarianConfirm = current.getWorkflowStatus() == AlertWorkflowStatus.IN_PROGRESS
                    || (current.getAssignedTo() != null && !current.getAssignedTo().isBlank());

            if (!awaitingLibrarianConfirm) {
                resolveAlertEntity(current, now, null);
                log.info("Alert FSM auto-resolved after 60s hysteresis (unclaimed): alertId={}", alertId);
                return;
            }

            current.setSensorRecovered(true);
            current.setSensorRecoveredAt(now);
            try {
                Alert saved = alertRepository.save(current);
                Alert effectiveSaved = saved != null ? saved : current;
                realtimePublisher.publishAlert(toAlertResponse(effectiveSaved));
                log.info("Alert sensors physically recovered; holding 15m for shift verification by {}: alertId={}",
                        current.getAssignedTo(), alertId);
                return;
            } catch (OptimisticLockingFailureException ex) {
                log.debug("Optimistic locking conflict marking sensorRecovered on alertId={}, attempt={}", alertId, attempt + 1);
            }
        }
    }

    /**
     * Quét định kỳ mỗi phút: các sự cố đã có thủ thư bấm "Nhận xử lý" và cảm biến đã êm >= 15 phút
     * nhưng thủ thư bận chưa bấm Chạm 2 ("Đã nhắc xong") sẽ được tự động chốt ca kèm tên người nhận.
     */
    @Scheduled(fixedRate = 60000)
    public int sweepRecoveredUnconfirmedAlerts() {
        Instant now = clock.instant();
        List<Alert> active = findActiveAlertsSafe();
        int closedCount = 0;

        for (Alert alert : active) {
            if (alert == null || alert.getStatus() == AlertStatus.RESOLVED) {
                continue;
            }
            if (!Boolean.TRUE.equals(alert.getSensorRecovered()) || alert.getSensorRecoveredAt() == null) {
                continue;
            }
            if (Duration.between(alert.getSensorRecoveredAt(), now).compareTo(CONFIRM_GRACE_WINDOW) < 0) {
                continue;
            }

            String alertId = alert.getId();
            for (int attempt = 0; attempt < OPTIMISTIC_LOCK_MAX_RETRIES; attempt++) {
                Alert current = attempt == 0
                        ? alert
                        : (alertId != null ? alertRepository.findById(alertId).orElse(null) : null);
                if (current == null || current.getStatus() == AlertStatus.RESOLVED
                        || !Boolean.TRUE.equals(current.getSensorRecovered())) {
                    break;
                }
                current.setStatus(AlertStatus.RESOLVED);
                current.setWorkflowStatus(AlertWorkflowStatus.RESOLVED);
                current.setResolvedAt(now);
                current.setResolvedBy("SYSTEM");
                if (current.getResolutionTag() == null || current.getResolutionTag().isBlank()) {
                    current.setResolutionTag(AUTO_STABILIZED_TAG);
                }
                if (current.getHandlingNote() == null || current.getHandlingNote().isBlank()) {
                    String assignee = (current.getAssignedTo() != null && !current.getAssignedTo().isBlank())
                            ? current.getAssignedTo()
                            : (current.getAcknowledgedBy() != null ? current.getAcknowledgedBy() : "thủ thư");
                    current.setHandlingNote("Tự động chốt ca: Môi trường đã ổn định sau khi " + assignee + " tiếp nhận");
                }
                try {
                    Alert saved = alertRepository.save(current);
                    Alert effectiveSaved = saved != null ? saved : current;
                    realtimePublisher.publishAlert(toAlertResponse(effectiveSaved));
                    notifyEmailOnResolved(effectiveSaved);
                    closedCount++;
                    log.info("Auto-confirmed recovered alert after 15m grace window: alertId={}, assignedTo={}",
                            alertId, current.getAssignedTo());
                    break;
                } catch (OptimisticLockingFailureException ex) {
                    log.debug("Optimistic locking conflict sweeping recovered alertId={}, attempt={}", alertId, attempt + 1);
                }
            }
        }
        return closedCount;
    }

    public void triggerDeviceOfflineAlert(String deviceId, String hardwareId, String roomId) {
        triggerDeviceOfflineAlert(deviceId, hardwareId, roomId, null);
    }

    public void triggerDeviceOfflineAlert(String deviceId, String hardwareId, String roomId, String zoneId) {
        resolveEnvironmentalAlertsOnOffline(deviceId, hardwareId);
        if (hardwareId != null) {
            deviceCommandPublisher.clearDeviceState(hardwareId);
        }

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
                            recent.setWorkflowStatus(AlertWorkflowStatus.NEW);
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
                        .workflowStatus(AlertWorkflowStatus.NEW)
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
                    target.setWorkflowStatus(AlertWorkflowStatus.NEW);
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
        List<FsmState> removedStates = new ArrayList<>();

        fsmMap.entrySet().removeIf(entry -> {
            FsmState state = entry.getValue();
            if (state != null && matchesDevice(state.getDeviceId(), state.getHardwareId(), deviceId, hardwareId, entry.getKey())) {
                removedStates.add(state);
                return true;
            }
            return false;
        });

        if (hardwareId != null) {
            deviceCommandPublisher.publishLedState(hardwareId, DeviceCommandPublisher.LED_NORMAL, "DEVICE_DEACTIVATED", null, null);
        }
        clearPulseAndSnoozeStateForDevice(deviceId, hardwareId);

        List<String> alertIdsToResolve = filterAlertIdsWithNoRemainingRoomNodes(removedStates, now);
        Set<String> resolvedIds = resolveFsmAlertIdsInDb(alertIdsToResolve, now);

        for (Alert alert : findActiveAlertsSafe()) {
            if (alert == null || alert.getStatus() == AlertStatus.RESOLVED) {
                continue;
            }
            if (alert.getId() != null && resolvedIds.contains(alert.getId())) {
                continue;
            }
            if (matchesDevice(alert.getDeviceId(), alert.getHardwareId(), deviceId, hardwareId, null)) {
                String incKey = resolveRoomIncidentKey(alert.getRoomId(), alert.getType(), resolveMetricType(alert));
                if (incKey != null && !findActiveStatesForIncident(null, incKey).isEmpty()) {
                    continue;
                }
                if (incKey != null && alert.getId() != null) {
                    roomIncidentAlertIds.remove(incKey, alert.getId());
                }
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
        List<FsmState> removedStates = new ArrayList<>();

        fsmMap.entrySet().removeIf(entry -> {
            FsmState state = entry.getValue();
            if (state == null) {
                return false;
            }
            boolean isOfflineType = state.getAlertType() == AlertType.DEVICE_OFFLINE
                    || "DEVICE_OFFLINE".equals(state.getMetricType());
            if (!isOfflineType && matchesDevice(state.getDeviceId(), state.getHardwareId(), deviceId, hardwareId, entry.getKey())) {
                removedStates.add(state);
                return true;
            }
            return false;
        });

        List<String> alertIdsToResolve = filterAlertIdsWithNoRemainingRoomNodes(removedStates, now);
        Set<String> resolvedIds = resolveFsmAlertIdsInDb(alertIdsToResolve, now);

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
                String incKey = resolveRoomIncidentKey(alert.getRoomId(), alert.getType(), resolveMetricType(alert));
                if (incKey != null && !findActiveStatesForIncident(null, incKey).isEmpty()) {
                    continue;
                }
                if (incKey != null && alert.getId() != null) {
                    roomIncidentAlertIds.remove(incKey, alert.getId());
                }
                resolveAlertEntity(alert, now, resolvedIds);
            }
        }
        if (!resolvedIds.isEmpty()) {
            log.info("Auto-resolved {} environmental alert(s) on device offline (deviceId={}, hardwareId={})",
                    resolvedIds.size(), deviceId, hardwareId);
        }
    }

    private List<String> filterAlertIdsWithNoRemainingRoomNodes(List<FsmState> removedStates, Instant now) {
        List<String> alertIdsToResolve = new ArrayList<>();
        Set<String> checkedIncidentKeys = new HashSet<>();

        for (FsmState st : removedStates) {
            if (st == null || st.getAlertId() == null) continue;
            String incKey = st.getIncidentKey();
            if (incKey == null) {
                alertIdsToResolve.add(st.getAlertId());
                continue;
            }
            if (!checkedIncidentKeys.add(incKey)) {
                continue;
            }
            List<FsmState> remaining = findActiveStatesForIncident(null, incKey);
            if (remaining.isEmpty()) {
                roomIncidentAlertIds.remove(incKey, st.getAlertId());
                alertIdsToResolve.add(st.getAlertId());
            } else {
                FsmState nextEpicenter = remaining.stream().max(epicenterComparator()).orElse(remaining.get(0));
                List<AffectedNodeSnapshot> snapshots = buildAffectedNodeSnapshots(remaining, now);
                mergeIntoExistingAlertInDb(st.getAlertId(), "", incKey, nextEpicenter, snapshots);
            }
        }
        return alertIdsToResolve;
    }

    public void onRoomTypeChanged(String roomId, RoomType newType) {
        if (roomId == null || roomId.isBlank() || newType == RoomType.BOOK_STORAGE) {
            return;
        }
        invalidateRoomCache(roomId);
        Instant now = clock.instant();
        List<String> fsmAlertIds = new ArrayList<>();

        roomIncidentAlertIds.remove("room:" + roomId.trim() + ":HUMIDITY_HIGH");
        roomIncidentAlertIds.remove("room:" + roomId.trim() + ":HUMIDITY_LOW");

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

        final FsmState[] removedHolder = { null };
        fsmMap.computeIfPresent(key, (k, state) -> {
            if (state.getLastEvaluatedAt() != null
                    && Duration.between(state.getLastEvaluatedAt(), now).compareTo(STALE_METRIC_RESOLVE_WINDOW) > 0) {
                removedHolder[0] = state;
                log.info("Auto-resolving stale metric alert after missing sensor reading > {}: key={}",
                        STALE_METRIC_RESOLVE_WINDOW, key);
                return null;
            }
            return state;
        });

        if (removedHolder[0] != null) {
            FsmState st = removedHolder[0];
            if (st.isLocalLedEnabled() && st.getHardwareId() != null) {
                refreshDeviceLedForHardware(st.getDeviceId(), st.getHardwareId(), metricType, null, st.getThreshold());
            }
            if (st.getAlertId() != null) {
                List<String> toResolve = filterAlertIdsWithNoRemainingRoomNodes(List.of(st), now);
                for (String id : toResolve) {
                    resolveAlertByIdInDb(id, now);
                }
            }
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
        final FsmState[] removedHolder = { null };
        fsmMap.computeIfPresent(key, (k, state) -> {
            removedHolder[0] = state;
            log.info("Auto-resolving FSM metric state ({}): key={}", reason, key);
            return null;
        });
        if (removedHolder[0] != null && removedHolder[0].getAlertId() != null) {
            List<String> toResolve = filterAlertIdsWithNoRemainingRoomNodes(List.of(removedHolder[0]), now);
            for (String id : toResolve) {
                resolveAlertByIdInDb(id, now);
            }
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

            current.setStatus(AlertStatus.RESOLVED);
            current.setWorkflowStatus(AlertWorkflowStatus.RESOLVED);
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
            }
        }
    }

    public void onClaimInProgress(Alert alert) {
        if (alert == null || alert.getId() == null) return;
        String alertId = alert.getId();
        Set<String> notifiedHw = new HashSet<>();

        for (FsmState state : fsmMap.values()) {
            if (alertId.equals(state.getAlertId())) {
                state.setStatus(AlertStatus.ACKNOWLEDGED);
                if (state.isLocalLedEnabled()
                        && state.getSeverity() != AlertSeverity.CRITICAL
                        && state.getHardwareId() != null
                        && notifiedHw.add(state.getHardwareId())) {
                    deviceCommandPublisher.publishLedState(
                            state.getHardwareId(),
                            DeviceCommandPublisher.LED_STAFF_DISPATCHED,
                            "STAFF_CLAIMED_ALERT",
                            state.getLastValue(),
                            state.getThreshold()
                    );
                }
            }
        }

        if (alert.getType() == AlertType.NOISE_EXCEEDED) {
            RoomAlertContext ctx = resolveRoomContext(alert.getRoomId());
            if (supportsLocalLedForAlert(ctx.roomType(), AlertType.NOISE_EXCEEDED)) {
                if (alert.getAffectedNodes() != null) {
                    for (AffectedNodeSnapshot snap : alert.getAffectedNodes()) {
                        if (snap != null && snap.getHardwareId() != null && notifiedHw.add(snap.getHardwareId())) {
                            deviceCommandPublisher.publishLedState(
                                    snap.getHardwareId(),
                                    DeviceCommandPublisher.LED_STAFF_DISPATCHED,
                                    "STAFF_CLAIMED_ALERT",
                                    snap.getCurrentValue(),
                                    snap.getThreshold()
                            );
                        }
                    }
                } else if (alert.getHardwareId() != null && notifiedHw.add(alert.getHardwareId())) {
                    deviceCommandPublisher.publishLedState(
                            alert.getHardwareId(),
                            DeviceCommandPublisher.LED_STAFF_DISPATCHED,
                            "STAFF_CLAIMED_ALERT",
                            alert.getCurrentValue(),
                            alert.getThreshold()
                    );
                }
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
        Set<String> resetHardwareIds = new HashSet<>();

        roomIncidentAlertIds.entrySet().removeIf(e -> alertId.equals(e.getValue()));

        fsmMap.entrySet().removeIf(entry -> {
            FsmState state = entry.getValue();
            if (state != null && alertId.equals(state.getAlertId())) {
                applySnoozeKey(entry.getKey(), effectiveSnooze, snoozeUntil);
                if (state.getIncidentKey() != null) {
                    applySnoozeKey(state.getIncidentKey(), effectiveSnooze, snoozeUntil);
                }
                if (state.isLocalLedEnabled() && state.getHardwareId() != null) {
                    resetHardwareIds.add(state.getHardwareId());
                }
                return true;
            }
            return false;
        });

        for (String hw : resetHardwareIds) {
            deviceCommandPublisher.publishLedState(hw, DeviceCommandPublisher.LED_NORMAL, "ALERT_RESOLVED", null, null);
        }
        log.debug("Removed FSM state and applied snooze ({}) for resolved alertId={}", effectiveSnooze, alertId);
    }

    public void onResolve(Alert alert, Duration snoozeDuration) {
        if (alert == null) return;
        Duration effectiveSnooze = (snoozeDuration != null && !snoozeDuration.isNegative())
                ? snoozeDuration
                : DEFAULT_SNOOZE_DURATION;
        Instant snoozeUntil = clock.instant().plus(effectiveSnooze);
        String resolvedMetric = resolveMetricType(alert);
        String incidentKey = resolveRoomIncidentKey(alert.getRoomId(), alert.getType(), resolvedMetric);
        Set<String> resetHardwareIds = new HashSet<>();

        if (incidentKey != null) {
            roomIncidentAlertIds.remove(incidentKey);
            applySnoozeKey(incidentKey, effectiveSnooze, snoozeUntil);
        }

        final boolean[] removedFromFsm = { false };
        fsmMap.entrySet().removeIf(entry -> {
            FsmState state = entry.getValue();
            if (state == null) return false;
            boolean matchesAlert = (alert.getId() != null && alert.getId().equals(state.getAlertId()))
                    || (incidentKey != null && incidentKey.equals(state.getIncidentKey()));
            if (matchesAlert) {
                applySnoozeKey(entry.getKey(), effectiveSnooze, snoozeUntil);
                if (state.isLocalLedEnabled() && state.getHardwareId() != null) {
                    resetHardwareIds.add(state.getHardwareId());
                }
                if (state.getDeviceId() != null) {
                    noisePeakPulsesMap.remove(state.getDeviceId() + ":NOISE_PEAK_PULSES");
                }
                removedFromFsm[0] = true;
                return true;
            }
            return false;
        });

        if (!removedFromFsm[0]) {
            String targetId = alert.getDeviceId() != null && !alert.getDeviceId().isBlank()
                    ? alert.getDeviceId()
                    : (alert.getRoomId() != null && !alert.getRoomId().isBlank() ? alert.getRoomId() : alert.getHardwareId());
            if (targetId != null && !targetId.isBlank()) {
                String key = targetId + ":" + resolvedMetric;
                fsmMap.remove(key);
                applySnoozeKey(key, effectiveSnooze, snoozeUntil);
                noisePeakPulsesMap.remove(targetId + ":NOISE_PEAK_PULSES");
            }
        }

        if (alert.getAffectedNodes() != null) {
            for (AffectedNodeSnapshot snap : alert.getAffectedNodes()) {
                if (snap != null && snap.getHardwareId() != null) {
                    resetHardwareIds.add(snap.getHardwareId());
                }
            }
        }
        if (alert.getHardwareId() != null) {
            resetHardwareIds.add(alert.getHardwareId());
        }
        for (String hw : resetHardwareIds) {
            deviceCommandPublisher.publishLedState(hw, DeviceCommandPublisher.LED_NORMAL, "ALERT_RESOLVED", null, null);
        }

        log.debug("Removed FSM state and applied snooze ({}) for resolved alertId={}", effectiveSnooze, alert.getId());
    }

    private void applySnoozeKey(String key, Duration snoozeDuration, Instant snoozeUntil) {
        if (key == null) return;
        if (!snoozeDuration.isZero()) {
            snoozeUntilMap.put(key, snoozeUntil);
        } else {
            snoozeUntilMap.remove(key);
        }
    }

    public void reset() {
        fsmMap.clear();
        roomIncidentAlertIds.clear();
        noisePeakPulsesMap.clear();
        snoozeUntilMap.clear();
        roomContextCache.invalidateAll();
        if (deviceCommandPublisher != null) {
            deviceCommandPublisher.reset();
        }
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
        AlertWorkflowStatus workflowStatus;
        if (alert.getStatus() == AlertStatus.RESOLVED) {
            workflowStatus = AlertWorkflowStatus.RESOLVED;
        } else if (alert.getWorkflowStatus() != null) {
            workflowStatus = alert.getWorkflowStatus();
        } else if (alert.getStatus() == AlertStatus.ACKNOWLEDGED) {
            workflowStatus = AlertWorkflowStatus.ACKNOWLEDGED;
        } else {
            workflowStatus = AlertWorkflowStatus.NEW;
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
                .workflowStatus(workflowStatus)
                .assignedTo(alert.getAssignedTo())
                .handlingNote(alert.getHandlingNote())
                .resolutionTag(alert.getResolutionTag())
                .inProgressAt(alert.getInProgressAt())
                .sensorRecovered(alert.getSensorRecovered())
                .sensorRecoveredAt(alert.getSensorRecoveredAt())
                .affectedNodes(alert.getAffectedNodes())
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
