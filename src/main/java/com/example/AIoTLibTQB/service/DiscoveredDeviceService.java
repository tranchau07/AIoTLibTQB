package com.example.AIoTLibTQB.service;

import com.example.AIoTLibTQB.dto.response.DiscoveredDeviceResponse;
import lombok.AccessLevel;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.experimental.FieldDefaults;
import lombok.extern.slf4j.Slf4j;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;

@Slf4j
@Service
@FieldDefaults(level = AccessLevel.PRIVATE, makeFinal = true)
public class DiscoveredDeviceService {

    Map<String, DiscoveredEntry> cache = new ConcurrentHashMap<>();
    private static final Duration EXPIRATION = Duration.ofMinutes(10);

    public void recordDiscovered(String hardwareId, Integer wifiRssi) {
        if (hardwareId == null || hardwareId.isBlank()) {
            return;
        }

        Instant now = Instant.now();
        cache.compute(hardwareId, (key, existing) -> {
            if (existing == null) {
                log.info("Discovered new unregistered IoT device broadcasting: hardwareId={}, rssi={}",
                        hardwareId, wifiRssi);
                return new DiscoveredEntry(hardwareId, now, now, 1L, wifiRssi);
            } else {
                existing.setLastSeenAt(now);
                existing.setMessageCount(existing.getMessageCount() + 1);
                if (wifiRssi != null) {
                    existing.setLastWifiRssi(wifiRssi);
                }
                return existing;
            }
        });
    }

    @PreAuthorize("hasAnyAuthority('ADMIN', 'LIBRARIAN')")
    public List<DiscoveredDeviceResponse> getDiscoveredDevices() {
        cleanExpired();
        return cache.values().stream()
                .sorted(Comparator.comparing(DiscoveredEntry::getLastSeenAt).reversed())
                .map(this::toResponse)
                .collect(Collectors.toList());
    }

    public void removeDiscovered(String hardwareId) {
        if (hardwareId != null) {
            cache.remove(hardwareId);
        }
    }

    private void cleanExpired() {
        Instant threshold = Instant.now().minus(EXPIRATION);
        cache.entrySet().removeIf(entry -> entry.getValue().getLastSeenAt().isBefore(threshold));
    }

    private DiscoveredDeviceResponse toResponse(DiscoveredEntry entry) {
        return DiscoveredDeviceResponse.builder()
                .hardwareId(entry.getHardwareId())
                .firstSeenAt(entry.getFirstSeenAt())
                .lastSeenAt(entry.getLastSeenAt())
                .messageCount(entry.getMessageCount())
                .lastWifiRssi(entry.getLastWifiRssi())
                .build();
    }

    @Data
    @AllArgsConstructor
    @FieldDefaults(level = AccessLevel.PRIVATE)
    private static class DiscoveredEntry {
        String hardwareId;
        Instant firstSeenAt;
        Instant lastSeenAt;
        long messageCount;
        Integer lastWifiRssi;
    }
}
