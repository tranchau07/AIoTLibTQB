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
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

@Slf4j
@Component
@FieldDefaults(level = AccessLevel.PRIVATE)
public class AlertRuleEngine {

    final AlertRepository alertRepository;
    final RealtimePublisher realtimePublisher;
    final RoomRepository roomRepository;
    final Clock clock;

    static final Duration PENDING_WINDOW = Duration.ofSeconds(30);
    static final Duration HYSTERESIS_WINDOW = Duration.ofSeconds(60);
    static final Duration NOISE_PEAK_PULSE_WINDOW = Duration.ofSeconds(60);
    static final int NOISE_PEAK_PULSE_REQUIRED = 3;

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

    final Map<String, List<Instant>> noisePeakPulsesMap = new ConcurrentHashMap<>();

    public AlertRuleEngine(
            AlertRepository alertRepository,
            RealtimePublisher realtimePublisher,
            Clock clock
    ) {
        this(alertRepository, realtimePublisher, clock, null);
    }

    @Autowired
    public AlertRuleEngine(
            AlertRepository alertRepository,
            RealtimePublisher realtimePublisher,
            @Autowired(required = false) Clock clock,
            @Autowired(required = false) RoomRepository roomRepository
    ) {
        this.alertRepository = alertRepository;
        this.realtimePublisher = realtimePublisher;
        this.clock = clock != null ? clock : Clock.systemUTC();
        this.roomRepository = roomRepository;
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
        String msg = alert.getMessage() != null ? alert.getMessage() : "";
        if (type == AlertType.NOISE_EXCEEDED) {
            if (msg.contains("Peak noise")) {
                return "NOISE_PEAK";
            }
            return "NOISE_AVG";
        }
        if (type == AlertType.AIR_UNHEALTHY) {
            if (msg.contains("PM2.5")) {
                return "PM2_5";
            }
            if (msg.contains("exceeded max threshold")) {
                return "HUMIDITY_HIGH";
            }
            if (msg.contains("dropped below min threshold")) {
                return "HUMIDITY_LOW";
            }
            return "TEMPERATURE";
        }
        return type.name();
    }

    /**
     * Idempotent startup migration (M3): Bổ sung severity=MEDIUM, severityRank, metricType và recommendedAction cho bản ghi cũ.
     */
    public int migrateLegacyAlertsSeverity() {
        try {
            List<Alert> all = alertRepository.findAll();
            if (all == null || all.isEmpty()) {
                return 0;
            }
            int updatedCount = 0;
            for (Alert alert : all) {
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
            log.debug("Skipping alert migration during unit test: {}", e.getMessage());
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
        String alertId;
        Double lastValue;
        Double threshold;
        AlertType alertType;
        AlertSeverity severity;
        String metricType;
        String deviceId;
        String hardwareId;
        String roomId;
    }

    public void evaluateTelemetry(String deviceId, String hardwareId, String roomId, TelemetryPayload.TelemetryData data) {
        if (data == null) {
            return;
        }

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
                    sop, deviceId, hardwareId, roomId, false);
        }

        // 2. noisePeak dual-threshold:
        //    - >= noisePeakImmediate (85 dBA): fire immediately (CRITICAL)
        //    - >= noisePeakMax (75 dBA): record pulse; if >= 3 pulses within 60s -> fire immediately (HIGH)
        if (data.getAcoustics() != null) {
            Double noisePeak = data.getAcoustics().getNoisePeak();
            if (noisePeak != null) {
                Instant now = clock.instant();
                String pulseKey = targetId + ":NOISE_PEAK_PULSES";
                boolean immediateSevere = noisePeak >= noisePeakImmediate;
                boolean moderatePulse = noisePeak > noisePeakMax;
                int pulseCount = 0;

                if (moderatePulse) {
                    List<Instant> pulses = noisePeakPulsesMap.computeIfAbsent(pulseKey, k -> new ArrayList<>());
                    synchronized (pulses) {
                        pulses.removeIf(t -> Duration.between(t, now).compareTo(NOISE_PEAK_PULSE_WINDOW) > 0);
                        pulses.add(now);
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
                        sop, deviceId, hardwareId, roomId, true);
            }
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
                    sop, deviceId, hardwareId, roomId, false);
        }

        // 4. BOOK_STORAGE humidity rules (min / max with deadband)
        if (roomType == RoomType.BOOK_STORAGE && data.getEnvironment() != null && data.getEnvironment().getHumidity() != null) {
            double rh = data.getEnvironment().getHumidity();
            double rhMax = cfg.getHumidityMax() != null ? cfg.getHumidityMax() : 60.0;
            double rhMin = cfg.getHumidityMin() != null ? cfg.getHumidityMin() : 45.0;

            boolean highBreach = rh > rhMax;
            boolean highRecovered = rh <= (rhMax - DEADBAND_HUMIDITY);
            String highSop = AlertSopCatalog.resolveSop("HUMIDITY_HIGH", AlertType.AIR_UNHEALTHY, roomType);
            evaluateMetric(targetId, "HUMIDITY_HIGH", highBreach, highRecovered, rh,
                    rhMax, AlertType.AIR_UNHEALTHY, AlertSeverity.HIGH,
                    String.format("Book storage humidity (%.1f %%RH) exceeded max threshold (%.1f %%RH)", rh, rhMax),
                    highSop, deviceId, hardwareId, roomId, false);

            boolean lowBreach = rh < rhMin;
            boolean lowRecovered = rh >= (rhMin + DEADBAND_HUMIDITY);
            String lowSop = AlertSopCatalog.resolveSop("HUMIDITY_LOW", AlertType.AIR_UNHEALTHY, roomType);
            evaluateMetric(targetId, "HUMIDITY_LOW", lowBreach, lowRecovered, rh,
                    rhMin, AlertType.AIR_UNHEALTHY, AlertSeverity.MEDIUM,
                    String.format("Book storage humidity (%.1f %%RH) dropped below min threshold (%.1f %%RH)", rh, rhMin),
                    lowSop, deviceId, hardwareId, roomId, false);
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
                    sop, deviceId, hardwareId, roomId, false);
        }
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
            boolean immediateFire
    ) {
        String key = targetId + ":" + metricType;
        Instant now = clock.instant();

        final boolean[] shouldFire = { false };
        final Alert[] alertToSave = { null };
        final String[] resolveAlertId = { null };

        fsmMap.compute(key, (k, state) -> {
            if (state == null) {
                // NORMAL state
                if (isBreached) {
                    if (immediateFire) {
                        FsmState newState = new FsmState();
                        newState.setStatus(AlertStatus.FIRING);
                        newState.setFiringSince(now);
                        newState.setRecoverySince(null);
                        newState.setLastValue(currentValue);
                        newState.setThreshold(threshold);
                        newState.setAlertType(alertType);
                        newState.setSeverity(severity);
                        newState.setMetricType(metricType);
                        newState.setDeviceId(deviceId);
                        newState.setHardwareId(hardwareId);
                        newState.setRoomId(roomId);

                        alertToSave[0] = Alert.builder()
                                .deviceId(deviceId)
                                .hardwareId(hardwareId)
                                .roomId(roomId)
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
                        newState.setLastValue(currentValue);
                        newState.setThreshold(threshold);
                        newState.setAlertType(alertType);
                        newState.setSeverity(severity);
                        newState.setMetricType(metricType);
                        newState.setDeviceId(deviceId);
                        newState.setHardwareId(hardwareId);
                        newState.setRoomId(roomId);
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
                    long pendingSeconds = Duration.between(state.getPendingSince(), now).getSeconds();
                    if (pendingSeconds >= PENDING_WINDOW.getSeconds()) {
                        state.setStatus(AlertStatus.FIRING);
                        state.setFiringSince(now);
                        state.setRecoverySince(null);

                        alertToSave[0] = Alert.builder()
                                .deviceId(deviceId)
                                .hardwareId(hardwareId)
                                .roomId(roomId)
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
                    }
                    return state;
                } else {
                    log.debug("Alert FSM cancelled PENDING (false alarm filtered): key={}", key);
                    return null;
                }
            }

            // Existing state is FIRING or ACKNOWLEDGED
            if (state.getStatus() == AlertStatus.FIRING || state.getStatus() == AlertStatus.ACKNOWLEDGED) {
                if (isBreached) {
                    state.setLastValue(currentValue);
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
            FsmState s = fsmMap.get(key);
            if (s != null && s.getStatus() == AlertStatus.FIRING) {
                s.setAlertId(savedAlert.getId());
            }
            realtimePublisher.publishAlert(toAlertResponse(savedAlert));
            log.info("Alert FSM transitioned to FIRING: key={}, alertId={}, value={}", key, savedAlert.getId(), currentValue);
        } else if (resolveAlertId[0] != null) {
            alertRepository.findById(resolveAlertId[0]).ifPresent(alert -> {
                alert.setStatus(AlertStatus.RESOLVED);
                alert.setResolvedAt(now);
                alert.setResolvedBy("SYSTEM");
                Alert saved = alertRepository.save(alert);
                realtimePublisher.publishAlert(toAlertResponse(saved));
                log.info("Alert FSM resolved after 60s hysteresis: key={}, alertId={}", key, alert.getId());
            });
        }
    }

    public void triggerDeviceOfflineAlert(String deviceId, String hardwareId, String roomId) {
        String targetId = deviceId != null && !deviceId.isBlank() ? deviceId : hardwareId;
        String key = targetId + ":DEVICE_OFFLINE";
        Instant now = clock.instant();
        RoomAlertContext ctx = resolveRoomContext(roomId);
        String sop = AlertSopCatalog.resolveSop("DEVICE_OFFLINE", AlertType.DEVICE_OFFLINE, ctx.roomType());

        final Alert[] alertToSave = { null };

        fsmMap.compute(key, (k, state) -> {
            if (state != null && (state.getStatus() == AlertStatus.FIRING || state.getStatus() == AlertStatus.ACKNOWLEDGED)) {
                return state;
            }

            alertToSave[0] = Alert.builder()
                    .deviceId(deviceId)
                    .hardwareId(hardwareId)
                    .roomId(roomId)
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

            FsmState newState = new FsmState();
            newState.setStatus(AlertStatus.FIRING);
            newState.setFiringSince(now);
            newState.setAlertType(AlertType.DEVICE_OFFLINE);
            newState.setSeverity(AlertSeverity.HIGH);
            newState.setMetricType("DEVICE_OFFLINE");
            newState.setDeviceId(deviceId);
            newState.setHardwareId(hardwareId);
            newState.setRoomId(roomId);
            return newState;
        });

        if (alertToSave[0] != null) {
            Alert savedAlert = alertRepository.save(alertToSave[0]);
            FsmState s = fsmMap.get(key);
            if (s != null) {
                s.setAlertId(savedAlert.getId());
            }
            realtimePublisher.publishAlert(toAlertResponse(savedAlert));
            log.info("Triggered DEVICE_OFFLINE alert: hardwareId={}, alertId={}", hardwareId, savedAlert.getId());
        }
    }

    public void resolveDeviceOfflineAlert(String hardwareId) {
        Instant now = clock.instant();
        fsmMap.entrySet().removeIf(entry -> {
            FsmState state = entry.getValue();
            if (state != null && "DEVICE_OFFLINE".equals(state.getMetricType())
                    && hardwareId != null && hardwareId.equals(state.getHardwareId())) {
                if (state.getAlertId() != null) {
                    alertRepository.findById(state.getAlertId()).ifPresent(alert -> {
                        alert.setStatus(AlertStatus.RESOLVED);
                        alert.setResolvedAt(now);
                        alert.setResolvedBy("SYSTEM");
                        Alert saved = alertRepository.save(alert);
                        realtimePublisher.publishAlert(toAlertResponse(saved));
                        log.info("Resolved in-memory DEVICE_OFFLINE alert: hardwareId={}, alertId={}", hardwareId, alert.getId());
                    });
                }
                return true;
            }
            return false;
        });

        List<Alert> firingAlerts;
        try {
            firingAlerts = alertRepository.findByHardwareIdAndTypeAndStatusIn(
                    hardwareId, AlertType.DEVICE_OFFLINE, List.of(AlertStatus.FIRING, AlertStatus.ACKNOWLEDGED));
        } catch (Exception e) {
            firingAlerts = alertRepository.findByStatus(AlertStatus.FIRING).stream()
                    .filter(a -> a.getType() == AlertType.DEVICE_OFFLINE && hardwareId != null && hardwareId.equals(a.getHardwareId()))
                    .toList();
        }
        for (Alert a : firingAlerts) {
            a.setStatus(AlertStatus.RESOLVED);
            a.setResolvedAt(now);
            a.setResolvedBy("SYSTEM");
            alertRepository.save(a);
            realtimePublisher.publishAlert(toAlertResponse(a));
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
        if (alertId == null) return;
        fsmMap.values().removeIf(state -> alertId.equals(state.getAlertId()));
        log.debug("Removed FSM state for resolved alertId={}", alertId);
    }

    public void reset() {
        fsmMap.clear();
        noisePeakPulsesMap.clear();
        roomContextCache.invalidateAll();
    }

    public static AlertResponse toAlertResponse(Alert alert) {
        if (alert == null) return null;
        AlertSeverity sev = alert.getSeverity() != null ? alert.getSeverity() : AlertSeverity.MEDIUM;
        Integer rank = alert.getSeverityRank() != null ? alert.getSeverityRank() : AlertSeverity.rankOf(sev);
        String sop = alert.getRecommendedAction();
        if (sop == null || sop.isBlank()) {
            sop = AlertSopCatalog.resolveSop(
                    alert.getType() != null ? alert.getType().name() : "",
                    alert.getType(),
                    RoomType.STUDY_ROOM);
        }
        return AlertResponse.builder()
                .id(alert.getId())
                .deviceId(alert.getDeviceId())
                .hardwareId(alert.getHardwareId())
                .roomId(alert.getRoomId())
                .type(alert.getType())
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
