package com.example.AIoTLibTQB.service;

import com.example.AIoTLibTQB.document.Device;
import com.example.AIoTLibTQB.dto.request.DeviceAuthRequest;
import com.example.AIoTLibTQB.dto.request.DeviceRegistrationRequest;
import com.example.AIoTLibTQB.dto.response.AuthenticationResponse;
import com.example.AIoTLibTQB.dto.response.DeviceRegistrationResponse;
import com.example.AIoTLibTQB.dto.response.DeviceResponse;
import com.example.AIoTLibTQB.enums.ErrorCode;
import com.example.AIoTLibTQB.exception.AppException;
import com.example.AIoTLibTQB.repository.DeviceRepository;
import lombok.AccessLevel;
import lombok.RequiredArgsConstructor;
import lombok.experimental.FieldDefaults;
import lombok.experimental.NonFinal;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.crypto.password.PasswordEncoder;
import com.example.AIoTLibTQB.document.User;
import com.example.AIoTLibTQB.dto.request.DeviceUpdateRequest;
import com.example.AIoTLibTQB.repository.UserRepository;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.UUID;
import java.util.stream.Collectors;

@Slf4j
@Service
@RequiredArgsConstructor
@FieldDefaults(level = AccessLevel.PRIVATE, makeFinal = true)
public class DeviceService {

    DeviceRepository deviceRepository;
    PasswordEncoder  passwordEncoder;
    AuthenticationService authenticationService;
    UserRepository userRepository;
    DiscoveredDeviceService discoveredDeviceService;

    private static final long ONLINE_THRESHOLD_MINUTES = 5L;

    @PreAuthorize("hasAnyAuthority('ADMIN', 'LIBRARIAN')")
    public DeviceRegistrationResponse register(DeviceRegistrationRequest request) {

        return deviceRepository.findByHardwareId(request.getHardwareId())
                .map(existing -> {
                    log.info("Device '{}' already registered (hardwareId={}), returning existing.",
                            existing.getName(), existing.getHardwareId());
                    return toRegistrationResponse(existing, null, true);
                })
                .orElseGet(() -> createNewDevice(request));
    }

    @PreAuthorize("hasAnyAuthority('ADMIN', 'LIBRARIAN')")
    public DeviceRegistrationResponse regenerateApiKey(String deviceId) {
        Device device = findById(deviceId);
        String rawKey = generateAndHashApiKey(device);
        Device saved = deviceRepository.save(device);
        log.warn("API Key regenerated for device '{}' (id={})", saved.getName(), saved.getId());
        return toRegistrationResponse(saved, rawKey, false);
    }

    public AuthenticationResponse authenticateDevice(DeviceAuthRequest request) {
        Device device = deviceRepository.findByHardwareId(request.getHardwareId())
                .orElseThrow(() -> new AppException(ErrorCode.DEVICE_NOT_EXISTED));

        if (!device.isActive()) {
            throw new AppException(ErrorCode.DEVICE_INACTIVE);
        }

        if (!passwordEncoder.matches(request.getApiKey(), device.getApiKeyHash())) {
            throw new AppException(ErrorCode.INVALID_API_KEY);
        }

        device.setLastSeenAt(Instant.now());
        deviceRepository.save(device);

        String token = authenticationService.generateDeviceToken(device);
        log.debug("Device '{}' authenticated successfully.", device.getName());
        return AuthenticationResponse.builder().token(token).build();
    }

    @PreAuthorize("hasAnyAuthority('ADMIN', 'LIBRARIAN')")
    public List<DeviceResponse> getAll() {
        return deviceRepository.findAll().stream()
                .map(this::toDeviceResponse)
                .collect(Collectors.toList());
    }

    @PreAuthorize("hasAnyAuthority('ADMIN', 'LIBRARIAN', 'ZONE_MANAGER', 'MAINTENANCE')")
    public DeviceResponse getById(String id) {
        return toDeviceResponse(findById(id));
    }

    @PreAuthorize("hasAnyAuthority('ADMIN', 'LIBRARIAN', 'ZONE_MANAGER')")
    public List<DeviceResponse> getByZone(String zoneId) {
        var auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth != null) {
            boolean isFullAccess = auth.getAuthorities().stream()
                    .anyMatch(a -> "ADMIN".equals(a.getAuthority()) || "ROLE_ADMIN".equals(a.getAuthority())
                            || "LIBRARIAN".equals(a.getAuthority()) || "ROLE_LIBRARIAN".equals(a.getAuthority()));

            if (!isFullAccess) {
                String username = auth.getName();
                User user = userRepository.findByUsername(username)
                        .orElseThrow(() -> new AppException(ErrorCode.UNAUTHENTICATED));
                if (user.getAssignedZones() == null || !user.getAssignedZones().contains(zoneId)) {
                    throw new AppException(ErrorCode.ZONE_ACCESS_DENIED);
                }
            }
        }

        return deviceRepository.findByZoneId(zoneId).stream()
                .map(this::toDeviceResponse)
                .collect(Collectors.toList());
    }

    @PreAuthorize("hasAnyAuthority('ADMIN', 'LIBRARIAN')")
    public DeviceResponse update(String id, DeviceUpdateRequest request) {
        Device device = findById(id);

        if (request.getName() != null && !request.getName().isBlank()) {
            device.setName(request.getName());
        }
        if (request.getZoneId() != null && !request.getZoneId().isBlank()) {
            device.setZoneId(request.getZoneId());
        }
        if (request.getRoomId() != null && !request.getRoomId().isBlank()) {
            device.setRoomId(request.getRoomId());
        }
        if (request.getPosX() != null) {
            device.setPosX(request.getPosX());
        }
        if (request.getPosY() != null) {
            device.setPosY(request.getPosY());
        }
        if (request.getDeviceType() != null && !request.getDeviceType().isBlank()) {
            device.setDeviceType(request.getDeviceType());
        }
        if (request.getLocation() != null) {
            device.setLocation(request.getLocation());
        }
        if (request.getFirmwareVersion() != null && !request.getFirmwareVersion().isBlank()) {
            device.setFirmwareVersion(request.getFirmwareVersion());
        }

        return toDeviceResponse(deviceRepository.save(device));
    }

    @PreAuthorize("hasAnyAuthority('ADMIN', 'LIBRARIAN')")
    public DeviceResponse toggleStatus(String id, boolean active) {
        Device device = findById(id);
        device.setActive(active);
        return toDeviceResponse(deviceRepository.save(device));
    }

    @PreAuthorize("hasAuthority('ADMIN')")
    public void delete(String id) {
        if (!deviceRepository.existsById(id)) {
            throw new AppException(ErrorCode.DEVICE_NOT_EXISTED);
        }
        deviceRepository.deleteById(id);
    }

    public void updateLastSeen(String deviceId) {
        deviceRepository.findById(deviceId).ifPresent(device -> {
            device.setLastSeenAt(Instant.now());
            deviceRepository.save(device);
        });
    }

    private Device findById(String id) {
        return deviceRepository.findById(id)
                .orElseThrow(() -> new AppException(ErrorCode.DEVICE_NOT_EXISTED));
    }

    private DeviceRegistrationResponse createNewDevice(DeviceRegistrationRequest request) {
        Device device = Device.builder()
                .name(request.getName())
                .hardwareId(request.getHardwareId())
                .zoneId(request.getZoneId())
                .roomId(request.getRoomId())
                .posX(request.getPosX())
                .posY(request.getPosY())
                .deviceType(request.getDeviceType())
                .location(request.getLocation())
                .firmwareVersion(request.getFirmwareVersion())
                .isActive(true)
                .build();

        String rawKey = generateAndHashApiKey(device);
        Device saved = deviceRepository.save(device);
        discoveredDeviceService.removeDiscovered(saved.getHardwareId());

        log.info("New device registered: '{}' (hardwareId={}, zone={}, room={})",
                saved.getName(), saved.getHardwareId(), saved.getZoneId(), saved.getRoomId());
        return toRegistrationResponse(saved, rawKey, false);
    }

    private String generateAndHashApiKey(Device device) {
        String rawKey = UUID.randomUUID().toString().replace("-", "");
        device.setApiKeyHash(passwordEncoder.encode(rawKey));
        return rawKey;
    }

    private DeviceRegistrationResponse toRegistrationResponse(
            Device device, String rawApiKey, boolean alreadyExisted) {
        return DeviceRegistrationResponse.builder()
                .id(device.getId())
                .name(device.getName())
                .hardwareId(device.getHardwareId())
                .zoneId(device.getZoneId())
                .roomId(device.getRoomId())
                .posX(device.getPosX())
                .posY(device.getPosY())
                .deviceType(device.getDeviceType())
                .location(device.getLocation())
                .firmwareVersion(device.getFirmwareVersion())
                .isActive(device.isActive())
                .createdAt(device.getCreatedAt())
                .rawApiKey(rawApiKey)
                .alreadyExisted(alreadyExisted)
                .build();
    }

    private DeviceResponse toDeviceResponse(Device device) {
        boolean online = !"OFFLINE".equalsIgnoreCase(device.getConnectionState()) &&
                device.getLastSeenAt() != null &&
                device.getLastSeenAt().isAfter(
                        Instant.now().minus(ONLINE_THRESHOLD_MINUTES, ChronoUnit.MINUTES));
        return DeviceResponse.builder()
                .id(device.getId())
                .name(device.getName())
                .hardwareId(device.getHardwareId())
                .zoneId(device.getZoneId())
                .roomId(device.getRoomId())
                .posX(device.getPosX())
                .posY(device.getPosY())
                .deviceType(device.getDeviceType())
                .location(device.getLocation())
                .firmwareVersion(device.getFirmwareVersion())
                .isActive(device.isActive())
                .lastSeenAt(device.getLastSeenAt())
                .connectionState(device.getConnectionState())
                .lastOfflineAt(device.getLastOfflineAt())
                .createdAt(device.getCreatedAt())
                .updatedAt(device.getUpdatedAt())
                .online(online)
                .build();
    }
}
