package com.example.AIoTLibTQB.service;

import com.example.AIoTLibTQB.document.Device;
import com.example.AIoTLibTQB.document.TelemetryRecord;
import com.example.AIoTLibTQB.document.User;
import com.example.AIoTLibTQB.dto.response.TelemetryResponse;
import com.example.AIoTLibTQB.enums.ErrorCode;
import com.example.AIoTLibTQB.exception.AppException;
import com.example.AIoTLibTQB.repository.DeviceRepository;
import com.example.AIoTLibTQB.repository.TelemetryRepository;
import com.example.AIoTLibTQB.repository.UserRepository;
import lombok.AccessLevel;
import lombok.RequiredArgsConstructor;
import lombok.experimental.FieldDefaults;
import lombok.extern.slf4j.Slf4j;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.stream.Collectors;

@Slf4j
@Service
@RequiredArgsConstructor
@FieldDefaults(level = AccessLevel.PRIVATE, makeFinal = true)
@PreAuthorize("hasAnyAuthority('ADMIN', 'LIBRARIAN', 'ZONE_MANAGER', 'USER', 'VIEWER')")
public class TelemetryService {

    TelemetryRepository telemetryRepository;
    DeviceRepository deviceRepository;
    UserRepository userRepository;

    public TelemetryResponse getLatestByDeviceId(String deviceId) {
        checkDeviceAccess(deviceId);
        return telemetryRepository.findTopByMetadataDeviceIdOrderByTimestampDesc(deviceId)
                .map(this::toResponse)
                .orElse(null);
    }

    public TelemetryResponse getLatestByRoomId(String roomId) {
        checkRoomAccess(roomId);
        return telemetryRepository.findTopByMetadataRoomIdOrderByTimestampDesc(roomId)
                .map(this::toResponse)
                .orElse(null);
    }

    public List<TelemetryResponse> getHistoryByDeviceId(String deviceId, Instant start, Instant end) {
        checkDeviceAccess(deviceId);
        Instant actualEnd = (end != null) ? end : Instant.now();
        Instant actualStart = (start != null) ? start : actualEnd.minus(1, ChronoUnit.HOURS);

        return telemetryRepository.findByMetadataDeviceIdAndTimestampBetweenOrderByTimestampDesc(deviceId, actualStart, actualEnd)
                .stream()
                .map(this::toResponse)
                .collect(Collectors.toList());
    }

    public List<TelemetryResponse> getHistoryByRoomId(String roomId, Instant start, Instant end) {
        checkRoomAccess(roomId);
        Instant actualEnd = (end != null) ? end : Instant.now();
        Instant actualStart = (start != null) ? start : actualEnd.minus(1, ChronoUnit.HOURS);

        return telemetryRepository.findByMetadataRoomIdAndTimestampBetweenOrderByTimestampDesc(roomId, actualStart, actualEnd)
                .stream()
                .map(this::toResponse)
                .collect(Collectors.toList());
    }

    private void checkDeviceAccess(String deviceId) {
        var auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth == null) return;

        boolean isFullAccess = auth.getAuthorities().stream()
                .anyMatch(a -> "ADMIN".equals(a.getAuthority()) || "ROLE_ADMIN".equals(a.getAuthority())
                        || "LIBRARIAN".equals(a.getAuthority()) || "ROLE_LIBRARIAN".equals(a.getAuthority()));

        if (!isFullAccess) {
            boolean isZoneManager = auth.getAuthorities().stream()
                    .anyMatch(a -> "ZONE_MANAGER".equals(a.getAuthority()) || "ROLE_ZONE_MANAGER".equals(a.getAuthority()));
            if (isZoneManager) {
                Device device = deviceRepository.findById(deviceId).orElse(null);
                if (device != null && device.getZoneId() != null) {
                    String username = auth.getName();
                    User user = userRepository.findByUsername(username)
                            .orElseThrow(() -> new AppException(ErrorCode.UNAUTHENTICATED));
                    if (user.getAssignedZones() == null || !user.getAssignedZones().contains(device.getZoneId())) {
                        throw new AppException(ErrorCode.ZONE_ACCESS_DENIED);
                    }
                }
            }
        }
    }

    private void checkRoomAccess(String roomId) {
        var auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth == null) return;

        boolean isFullAccess = auth.getAuthorities().stream()
                .anyMatch(a -> "ADMIN".equals(a.getAuthority()) || "ROLE_ADMIN".equals(a.getAuthority())
                        || "LIBRARIAN".equals(a.getAuthority()) || "ROLE_LIBRARIAN".equals(a.getAuthority()));

        if (!isFullAccess) {
            boolean isZoneManager = auth.getAuthorities().stream()
                    .anyMatch(a -> "ZONE_MANAGER".equals(a.getAuthority()) || "ROLE_ZONE_MANAGER".equals(a.getAuthority()));
            if (isZoneManager) {
                String username = auth.getName();
                User user = userRepository.findByUsername(username)
                        .orElseThrow(() -> new AppException(ErrorCode.UNAUTHENTICATED));
                List<Device> devices = deviceRepository.findByRoomId(roomId);
                if (!devices.isEmpty()) {
                    boolean anyMatch = devices.stream()
                            .anyMatch(d -> d.getZoneId() != null && user.getAssignedZones() != null && user.getAssignedZones().contains(d.getZoneId()));
                    if (!anyMatch) {
                        throw new AppException(ErrorCode.ZONE_ACCESS_DENIED);
                    }
                }
            }
        }
    }

    private TelemetryResponse toResponse(TelemetryRecord record) {
        return TelemetryResponse.builder()
                .id(record.getId())
                .timestamp(record.getTimestamp())
                .metadata(record.getMetadata())
                .acoustics(record.getAcoustics())
                .airQuality(record.getAirQuality())
                .environment(record.getEnvironment())
                .comfortScore(record.getComfortScore())
                .wifiRssi(record.getWifiRssi())
                .build();
    }
}
