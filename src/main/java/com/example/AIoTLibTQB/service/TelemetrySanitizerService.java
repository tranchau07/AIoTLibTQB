package com.example.AIoTLibTQB.service;

import com.example.AIoTLibTQB.document.AcousticMetrics;
import com.example.AIoTLibTQB.document.AirQualityMetrics;
import com.example.AIoTLibTQB.document.EnvironmentMetrics;
import com.example.AIoTLibTQB.dto.mqtt.TelemetryPayload;
import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;
import lombok.AccessLevel;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.experimental.FieldDefaults;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.concurrent.locks.ReentrantLock;

@Slf4j
@Service
@FieldDefaults(level = AccessLevel.PRIVATE, makeFinal = true)
public class TelemetrySanitizerService {

    public static final double NOISE_MIN = 30.0;
    public static final double NOISE_AVG_MAX = 110.0;
    public static final double NOISE_PEAK_MAX = 130.0;
    public static final double PM_MIN = 0.0;
    public static final double PM_MAX = 1000.0;
    public static final double TEMP_MIN = 0.0;
    public static final double TEMP_MAX = 60.0;
    public static final double HUMIDITY_MIN = 0.0;
    public static final double HUMIDITY_MAX = 100.0;
    public static final double LUX_MIN = 0.0;
    public static final double LUX_MAX = 65535.0;

    private static final Duration FORWARD_FILL_WINDOW = Duration.ofSeconds(30);
    private static final Duration NOISE_WINDOW = Duration.ofSeconds(30);
    private static final long CACHE_MAX_SIZE = 50_000L;
    private static final long NOISE_CACHE_MAX_SIZE = 10_000L;
    private static final int MAX_NOISE_WINDOW_SAMPLES = 1_000;
    private static final Duration CACHE_EXPIRE_AFTER_ACCESS = Duration.ofMinutes(10);

    Clock clock;

    @lombok.experimental.PackagePrivate
    Cache<String, TimestampedValue> fieldCache = Caffeine.newBuilder()
            .expireAfterAccess(CACHE_EXPIRE_AFTER_ACCESS)
            .maximumSize(CACHE_MAX_SIZE)
            .build();

    @lombok.experimental.PackagePrivate
    Cache<String, NoiseSlidingWindow> noiseWindowCache = Caffeine.newBuilder()
            .expireAfterAccess(CACHE_EXPIRE_AFTER_ACCESS)
            .maximumSize(NOISE_CACHE_MAX_SIZE)
            .build();

    @Autowired
    public TelemetrySanitizerService(@Autowired(required = false) Clock clock) {
        this.clock = clock != null ? clock : Clock.systemUTC();
    }

    public TelemetrySanitizerService() {
        this(Clock.systemUTC());
    }

    @lombok.experimental.PackagePrivate
    void putCacheEntry(String deviceId, String fieldKey, TimestampedValue value) {
        fieldCache.put(buildCacheKey(deviceId, fieldKey), value);
    }

    @lombok.experimental.PackagePrivate
    TimestampedValue getCacheEntry(String deviceId, String fieldKey) {
        return fieldCache.getIfPresent(buildCacheKey(deviceId, fieldKey));
    }

    @lombok.experimental.PackagePrivate
    String buildCacheKey(String deviceId, String fieldKey) {
        return deviceId + ":" + fieldKey;
    }

    public SanitizedMetrics sanitize(String deviceId, TelemetryPayload.TelemetryData data) {
        if (data == null) {
            return new SanitizedMetrics(null, null, null);
        }

        Instant now = clock.instant();

        // 1. Âm học (Acoustics)
        AcousticMetrics acoustics = sanitizeAcoustics(deviceId, data.getAcoustics(), now);

        // 2. Bụi mịn (Air Quality)
        AirQualityMetrics airQuality = sanitizeAirQuality(deviceId, data.getAirQuality(), now);

        // 3. Môi trường nhiệt ẩm ánh sáng (Environment)
        EnvironmentMetrics environment = sanitizeEnvironment(deviceId, data.getEnvironment(), now);

        return new SanitizedMetrics(acoustics, airQuality, environment);
    }

    private AcousticMetrics sanitizeAcoustics(String deviceId, TelemetryPayload.AcousticsData in, Instant now) {
        String safeDeviceKey = deviceId != null ? deviceId : "unknown";

        // Luồng mới: Thiết bị chỉ gửi độ ồn tức thời (noise), Server tự tính noiseAvg (cửa sổ trượt 30s) & noisePeak
        if (in != null && in.getNoise() != null) {
            double rawNoise = in.getNoise();
            if (Double.isFinite(rawNoise) && rawNoise >= NOISE_MIN && rawNoise <= NOISE_PEAK_MAX) {
                NoiseSlidingWindow window = noiseWindowCache.get(safeDeviceKey, k -> new NoiseSlidingWindow());
                double computedAvg = window.recordAndAverage(rawNoise, now, NOISE_WINDOW);
                double noiseAvg = roundToOneDecimal(Math.min(computedAvg, NOISE_AVG_MAX));
                double noisePeak = roundToOneDecimal(Math.min(Math.max(rawNoise, noiseAvg), NOISE_PEAK_MAX));
                return AcousticMetrics.builder()
                        .noiseAvg(noiseAvg)
                        .noisePeak(noisePeak)
                        .build();
            }

            log.warn("Sensor out-of-bounds rejected for device '{}', metric 'acoustics.noise': value={} (expected [{}, {}])",
                    deviceId, rawNoise, NOISE_MIN, NOISE_PEAK_MAX);
            Double fallbackAvg = getNoiseWindowAverage(safeDeviceKey, now);
            if (fallbackAvg == null) {
                return null;
            }
            return AcousticMetrics.builder()
                    .noiseAvg(fallbackAvg)
                    .noisePeak(null)
                    .build();
        }

        // Tương thích ngược: Payload cũ gửi sẵn noise_avg / noise_peak
        if (in != null && (in.getNoiseAvg() != null || in.getNoisePeak() != null)) {
            Double avg = sanitizeField(deviceId, "acoustics.noiseAvg", in.getNoiseAvg(), NOISE_MIN, NOISE_AVG_MAX, now);
            Double peak = sanitizePeakWithoutForwardFill(deviceId, "acoustics.noisePeak", in.getNoisePeak(), NOISE_MIN, NOISE_PEAK_MAX);
            if (avg == null && peak == null) {
                return null;
            }
            return AcousticMetrics.builder()
                    .noiseAvg(avg)
                    .noisePeak(peak)
                    .build();
        }

        // Trường hợp acoustics bị null hoặc noise = null: forward-fill noiseAvg trong 30s, tuyệt đối không forward-fill noisePeak
        Double avg = getNoiseWindowAverage(safeDeviceKey, now);
        if (avg == null) {
            avg = sanitizeField(deviceId, "acoustics.noiseAvg", null, NOISE_MIN, NOISE_AVG_MAX, now);
        }
        if (avg == null) {
            return null;
        }
        return AcousticMetrics.builder()
                .noiseAvg(avg)
                .noisePeak(null)
                .build();
    }

    private Double getNoiseWindowAverage(String safeDeviceKey, Instant now) {
        NoiseSlidingWindow window = noiseWindowCache.getIfPresent(safeDeviceKey);
        if (window == null) {
            return null;
        }
        Double avg = window.averageIfActive(now, NOISE_WINDOW);
        if (avg == null) {
            return null;
        }
        return roundToOneDecimal(Math.min(avg, NOISE_AVG_MAX));
    }

    private static double roundToOneDecimal(double value) {
        return Math.round(value * 10.0) / 10.0;
    }

    private Double sanitizePeakWithoutForwardFill(String deviceId, String fieldKey, Double incomingValue, double min, double max) {
        if (incomingValue == null) {
            return null;
        }

        if (incomingValue >= min && incomingValue <= max) {
            return incomingValue;
        }

        log.warn("Sensor out-of-bounds rejected for device '{}', metric '{}': value={} (expected [{}, {}])",
                deviceId, fieldKey, incomingValue, min, max);
        return null;
    }

    private AirQualityMetrics sanitizeAirQuality(String deviceId, TelemetryPayload.AirQualityData in, Instant now) {
        Double pm1_0 = sanitizeField(deviceId, "airQuality.pm1_0", (in != null ? in.getPm1_0() : null), PM_MIN, PM_MAX, now);
        Double pm2_5 = sanitizeField(deviceId, "airQuality.pm2_5", (in != null ? in.getPm2_5() : null), PM_MIN, PM_MAX, now);
        Double pm4_0 = sanitizeField(deviceId, "airQuality.pm4_0", (in != null ? in.getPm4_0() : null), PM_MIN, PM_MAX, now);
        Double pm10 = sanitizeField(deviceId, "airQuality.pm10", (in != null ? in.getPm10() : null), PM_MIN, PM_MAX, now);

        if (pm1_0 == null && pm2_5 == null && pm4_0 == null && pm10 == null) {
            return null;
        }

        return AirQualityMetrics.builder()
                .pm1_0(pm1_0)
                .pm2_5(pm2_5)
                .pm4_0(pm4_0)
                .pm10(pm10)
                .build();
    }

    private EnvironmentMetrics sanitizeEnvironment(String deviceId, TelemetryPayload.EnvironmentData in, Instant now) {
        Double temp = sanitizeField(deviceId, "env.temperature", (in != null ? in.getTemperature() : null), TEMP_MIN, TEMP_MAX, now);
        Double hum = sanitizeField(deviceId, "env.humidity", (in != null ? in.getHumidity() : null), HUMIDITY_MIN, HUMIDITY_MAX, now);
        Double lux = sanitizeField(deviceId, "env.lux", (in != null ? in.getLux() : null), LUX_MIN, LUX_MAX, now);

        if (temp == null && hum == null && lux == null) {
            return null;
        }

        return EnvironmentMetrics.builder()
                .temperature(temp)
                .humidity(hum)
                .lux(lux)
                .build();
    }

    private Double sanitizeField(String deviceId, String fieldKey, Double incomingValue, double min, double max, Instant now) {
        String cacheKey = buildCacheKey(deviceId, fieldKey);
        TimestampedValue lastKnown = fieldCache.getIfPresent(cacheKey);

        boolean hasValidIncoming = incomingValue != null && incomingValue >= min && incomingValue <= max;
        if (hasValidIncoming) {
            // New valid reading from physical sensor: update cache with current timestamp
            fieldCache.put(cacheKey, new TimestampedValue(incomingValue, now));
            return incomingValue;
        }

        if (incomingValue != null) {
            log.warn("Sensor out-of-bounds rejected for device '{}', metric '{}': value={} (expected [{}, {}])",
                    deviceId, fieldKey, incomingValue, min, max);
        }

        // Check forward-fill window for this specific field
        if (lastKnown != null && Duration.between(lastKnown.timestamp(), now).compareTo(FORWARD_FILL_WINDOW) <= 0) {
            log.debug("Applying forward-fill for device '{}', metric '{}': fallbackValue={}",
                    deviceId, fieldKey, lastKnown.value());
            return lastKnown.value();
        }

        // Expired or no previous value: do not forward-fill
        return null;
    }

    public record TimestampedValue(Double value, Instant timestamp) {}

    @lombok.experimental.PackagePrivate
    static final class NoiseSlidingWindow {
        private final ReentrantLock lock = new ReentrantLock();
        private final Deque<TimestampedValue> samples = new ArrayDeque<>();

        double recordAndAverage(double value, Instant now, Duration windowSize) {
            lock.lock();
            try {
                pruneExpired(now, windowSize);
                samples.addLast(new TimestampedValue(value, now));
                while (samples.size() > MAX_NOISE_WINDOW_SAMPLES) {
                    samples.pollFirst();
                }
                return computeMean();
            } finally {
                lock.unlock();
            }
        }

        Double averageIfActive(Instant now, Duration windowSize) {
            lock.lock();
            try {
                pruneExpired(now, windowSize);
                if (samples.isEmpty()) {
                    return null;
                }
                return computeMean();
            } finally {
                lock.unlock();
            }
        }

        private void pruneExpired(Instant now, Duration windowSize) {
            samples.removeIf(s -> Duration.between(s.timestamp(), now).compareTo(windowSize) > 0);
        }

        private double computeMean() {
            double sum = 0.0;
            int count = 0;
            for (TimestampedValue s : samples) {
                sum += s.value();
                count++;
            }
            return count > 0 ? sum / count : 0.0;
        }
    }

    @Data
    @AllArgsConstructor
    @FieldDefaults(level = AccessLevel.PRIVATE)
    public static class SanitizedMetrics {
        AcousticMetrics acoustics;
        AirQualityMetrics airQuality;
        EnvironmentMetrics environment;
    }
}
