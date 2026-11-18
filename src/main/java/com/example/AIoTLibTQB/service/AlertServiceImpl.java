package com.example.AIoTLibTQB.service;

import com.example.AIoTLibTQB.document.Alert;
import com.example.AIoTLibTQB.document.Device;
import com.example.AIoTLibTQB.document.User;
import com.example.AIoTLibTQB.dto.mqtt.TelemetryPayload;
import com.example.AIoTLibTQB.dto.request.AlertWorkflowUpdateRequest;
import com.example.AIoTLibTQB.dto.response.AlertResponse;
import com.example.AIoTLibTQB.dto.response.PageResponse;
import com.example.AIoTLibTQB.enums.AlertStatus;
import com.example.AIoTLibTQB.enums.AlertType;
import com.example.AIoTLibTQB.enums.AlertWorkflowStatus;
import com.example.AIoTLibTQB.enums.ErrorCode;
import com.example.AIoTLibTQB.exception.AppException;
import com.example.AIoTLibTQB.repository.AlertRepository;
import com.example.AIoTLibTQB.repository.DeviceRepository;
import com.example.AIoTLibTQB.repository.UserRepository;
import lombok.AccessLevel;
import lombok.experimental.FieldDefaults;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.OptimisticLockingFailureException;
import org.springframework.data.domain.Pageable;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.context.SecurityContext;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;

@Slf4j
@Service
@FieldDefaults(level = AccessLevel.PRIVATE, makeFinal = true)
public class AlertServiceImpl implements AlertService {

    static final int OPTIMISTIC_LOCK_MAX_RETRIES = 3;

    AlertRepository alertRepository;
    RealtimePublisher realtimePublisher;
    AlertRuleEngine alertRuleEngine;
    MongoTemplate mongoTemplate;
    Clock clock;
    UserRepository userRepository;
    DeviceRepository deviceRepository;
    AlertEmailNotificationService alertEmailNotificationService;

    public AlertServiceImpl(
            AlertRepository alertRepository,
            RealtimePublisher realtimePublisher,
            AlertRuleEngine alertRuleEngine,
            MongoTemplate mongoTemplate,
            Clock clock
    ) {
        this(alertRepository, realtimePublisher, alertRuleEngine, mongoTemplate, clock, null, null, null);
    }

    public AlertServiceImpl(
            AlertRepository alertRepository,
            RealtimePublisher realtimePublisher,
            AlertRuleEngine alertRuleEngine,
            MongoTemplate mongoTemplate,
            Clock clock,
            UserRepository userRepository,
            DeviceRepository deviceRepository
    ) {
        this(alertRepository, realtimePublisher, alertRuleEngine, mongoTemplate, clock, userRepository, deviceRepository, null);
    }

    @Autowired
    public AlertServiceImpl(
            AlertRepository alertRepository,
            RealtimePublisher realtimePublisher,
            AlertRuleEngine alertRuleEngine,
            MongoTemplate mongoTemplate,
            @Autowired(required = false) Clock clock,
            @Autowired(required = false) UserRepository userRepository,
            @Autowired(required = false) DeviceRepository deviceRepository,
            @Autowired(required = false) AlertEmailNotificationService alertEmailNotificationService
    ) {
        this.alertRepository = alertRepository;
        this.realtimePublisher = realtimePublisher;
        this.alertRuleEngine = alertRuleEngine;
        this.mongoTemplate = mongoTemplate;
        this.clock = clock != null ? clock : Clock.systemUTC();
        this.userRepository = userRepository;
        this.deviceRepository = deviceRepository;
        this.alertEmailNotificationService = alertEmailNotificationService;
    }

    private record ZoneAccessScope(
            boolean fullAccess,
            Set<String> assignedZones,
            List<String> allowedDeviceIds,
            List<String> allowedRoomIds
    ) {}

    private ZoneAccessScope resolveZoneAccessScope() {
        SecurityContext context = SecurityContextHolder.getContext();
        Authentication auth = context != null ? context.getAuthentication() : null;
        if (auth == null || userRepository == null || deviceRepository == null) {
            return new ZoneAccessScope(true, Set.of(), List.of(), List.of());
        }

        boolean isFullAccess = auth.getAuthorities() != null && auth.getAuthorities().stream()
                .filter(Objects::nonNull)
                .map(GrantedAuthority::getAuthority)
                .anyMatch(authority -> "ADMIN".equals(authority) || "ROLE_ADMIN".equals(authority));
        if (isFullAccess) {
            return new ZoneAccessScope(true, Set.of(), List.of(), List.of());
        }

        String username = auth.getName();
        if (username == null || username.isBlank()) {
            return new ZoneAccessScope(false, Set.of(), List.of(), List.of());
        }

        Optional<User> userOpt = userRepository.findByUsername(username);
        User user = userOpt != null ? userOpt.orElse(null) : null;
        if (user == null || user.getAssignedZones() == null || user.getAssignedZones().isEmpty()) {
            return new ZoneAccessScope(false, Set.of(), List.of(), List.of());
        }

        Set<String> assignedZones = user.getAssignedZones().stream()
                .filter(z -> z != null && !z.isBlank())
                .collect(Collectors.toUnmodifiableSet());
        if (assignedZones.isEmpty()) {
            return new ZoneAccessScope(false, Set.of(), List.of(), List.of());
        }

        List<Device> devices = deviceRepository.findByZoneIdIn(assignedZones);
        if (devices == null) {
            devices = List.of();
        }
        List<String> allowedDeviceIds = devices.stream()
                .filter(Objects::nonNull)
                .map(Device::getId)
                .filter(id -> id != null && !id.isBlank())
                .distinct()
                .toList();
        List<String> allowedRoomIds = devices.stream()
                .filter(Objects::nonNull)
                .map(Device::getRoomId)
                .filter(roomId -> roomId != null && !roomId.isBlank())
                .distinct()
                .toList();

        return new ZoneAccessScope(false, assignedZones, allowedDeviceIds, allowedRoomIds);
    }

    private void applyZoneCriteria(Query query, ZoneAccessScope scope) {
        if (scope.fullAccess()) {
            return;
        }
        if (scope.assignedZones().isEmpty()) {
            query.addCriteria(Criteria.where("_id").is("__none__"));
            return;
        }
        query.addCriteria(new Criteria().orOperator(
                Criteria.where("zoneId").in(scope.assignedZones()),
                Criteria.where("deviceId").in(scope.allowedDeviceIds()),
                Criteria.where("roomId").in(scope.allowedRoomIds())
        ));
    }

    private void assertAlertZoneAccess(Alert alert) {
        ZoneAccessScope scope = resolveZoneAccessScope();
        if (scope.fullAccess()) {
            return;
        }
        if (scope.assignedZones().isEmpty()) {
            throw new AppException(ErrorCode.ZONE_ACCESS_DENIED);
        }

        String alertZoneId = alert.getZoneId();
        if (alertZoneId != null && !alertZoneId.isBlank()) {
            if (!scope.assignedZones().contains(alertZoneId)) {
                throw new AppException(ErrorCode.ZONE_ACCESS_DENIED);
            }
            return;
        }

        if (alert.getDeviceId() != null && !alert.getDeviceId().isBlank()) {
            Optional<Device> deviceOpt = deviceRepository.findById(alert.getDeviceId());
            Device device = deviceOpt != null ? deviceOpt.orElse(null) : null;
            if (device != null && device.getZoneId() != null && !device.getZoneId().isBlank()) {
                if (scope.assignedZones().contains(device.getZoneId())) {
                    return;
                }
                throw new AppException(ErrorCode.ZONE_ACCESS_DENIED);
            }
        }

        boolean matchesDevice = alert.getDeviceId() != null && scope.allowedDeviceIds().contains(alert.getDeviceId());
        boolean matchesRoom = alert.getRoomId() != null && scope.allowedRoomIds().contains(alert.getRoomId());
        if (!matchesDevice && !matchesRoom) {
            throw new AppException(ErrorCode.ZONE_ACCESS_DENIED);
        }
    }

    @Override
    public PageResponse<AlertResponse> getAlerts(String roomId, AlertType type, AlertStatus status, Pageable pageable) {
        Query query = new Query();
        if (roomId != null && !roomId.isBlank()) {
            query.addCriteria(Criteria.where("roomId").is(roomId));
        }
        if (type != null) {
            query.addCriteria(Criteria.where("type").is(type));
        }
        if (status != null) {
            query.addCriteria(Criteria.where("status").is(status));
        }

        applyZoneCriteria(query, resolveZoneAccessScope());

        long totalElements = mongoTemplate.count(query, Alert.class);
        query.with(pageable);
        List<Alert> alerts = mongoTemplate.find(query, Alert.class);

        List<AlertResponse> content = alerts.stream()
                .map(AlertRuleEngine::toAlertResponse)
                .toList();

        int pageSize = pageable.getPageSize() > 0 ? pageable.getPageSize() : 10;
        int totalPages = (int) Math.ceil((double) totalElements / pageSize);
        if (totalPages == 0) {
            totalPages = 1;
        }
        boolean last = pageable.getPageNumber() >= totalPages - 1;

        return PageResponse.<AlertResponse>builder()
                .content(content)
                .page(pageable.getPageNumber())
                .size(pageSize)
                .totalElements(totalElements)
                .totalPages(totalPages)
                .last(last)
                .build();
    }

    @Override
    public long getUnreadCount() {
        Query query = Query.query(Criteria.where("status").is(AlertStatus.FIRING));
        applyZoneCriteria(query, resolveZoneAccessScope());
        return mongoTemplate.count(query, Alert.class);
    }

    @Override
    public AlertResponse acknowledgeAlert(String id, String username) {
        Alert initial = alertRepository.findById(id)
                .orElseThrow(() -> new AppException(ErrorCode.ALERT_NOT_EXISTED));
        assertAlertZoneAccess(initial);

        for (int attempt = 0; attempt < OPTIMISTIC_LOCK_MAX_RETRIES; attempt++) {
            Alert current = alertRepository.findById(id)
                    .orElseThrow(() -> new AppException(ErrorCode.ALERT_NOT_EXISTED));

            // M4: Nếu cảnh báo đã được RESOLVED (hoặc đã ACKNOWLEDGED) thì tuyệt đối không ghi đè ngược về ACKNOWLEDGED
            if (current.getStatus() != AlertStatus.FIRING) {
                return AlertRuleEngine.toAlertResponse(current);
            }

            current.setStatus(AlertStatus.ACKNOWLEDGED);
            if (current.getWorkflowStatus() == null || current.getWorkflowStatus() == AlertWorkflowStatus.NEW) {
                current.setWorkflowStatus(AlertWorkflowStatus.ACKNOWLEDGED);
            }
            current.setAcknowledgedAt(clock.instant());
            current.setAcknowledgedBy(username);

            try {
                Alert saved = alertRepository.save(current);
                Alert effectiveSaved = saved != null ? saved : current;

                alertRuleEngine.onAcknowledge(id);
                AlertResponse response = AlertRuleEngine.toAlertResponse(effectiveSaved);
                realtimePublisher.publishAlert(response);
                log.info("Alert acknowledged: id={}, username={}", id, username);
                return response;
            } catch (OptimisticLockingFailureException ex) {
                log.debug("Optimistic locking conflict on acknowledgeAlert id={}, attempt={}", id, attempt + 1);
                if (attempt == OPTIMISTIC_LOCK_MAX_RETRIES - 1) {
                    Alert latest = alertRepository.findById(id)
                            .orElseThrow(() -> new AppException(ErrorCode.ALERT_NOT_EXISTED));
                    if (latest.getStatus() != AlertStatus.FIRING) {
                        return AlertRuleEngine.toAlertResponse(latest);
                    }
                    throw ex;
                }
            }
        }

        Alert latest = alertRepository.findById(id)
                .orElseThrow(() -> new AppException(ErrorCode.ALERT_NOT_EXISTED));
        return AlertRuleEngine.toAlertResponse(latest);
    }

    @Override
    public AlertResponse resolveAlert(String id, String username) {
        return resolveAlert(id, username, 15);
    }

    @Override
    public AlertResponse resolveAlert(String id, String username, Integer snoozeMinutes) {
        Alert initial = alertRepository.findById(id)
                .orElseThrow(() -> new AppException(ErrorCode.ALERT_NOT_EXISTED));
        assertAlertZoneAccess(initial);

        int effectiveSnoozeMinutes = snoozeMinutes != null
                ? Math.max(0, Math.min(240, snoozeMinutes))
                : 15;

        for (int attempt = 0; attempt < OPTIMISTIC_LOCK_MAX_RETRIES; attempt++) {
            Alert current = alertRepository.findById(id)
                    .orElseThrow(() -> new AppException(ErrorCode.ALERT_NOT_EXISTED));

            if (current.getStatus() == AlertStatus.RESOLVED) {
                return AlertRuleEngine.toAlertResponse(current);
            }

            current.setStatus(AlertStatus.RESOLVED);
            current.setWorkflowStatus(AlertWorkflowStatus.RESOLVED);
            current.setResolvedAt(clock.instant());
            current.setResolvedBy(username);

            try {
                Alert saved = alertRepository.save(current);
                Alert effectiveSaved = saved != null ? saved : current;

                alertRuleEngine.onResolve(effectiveSaved, Duration.ofMinutes(effectiveSnoozeMinutes));
                AlertResponse response = AlertRuleEngine.toAlertResponse(effectiveSaved);
                realtimePublisher.publishAlert(response);
                if (alertEmailNotificationService != null) {
                    try {
                        alertEmailNotificationService.onAlertResolved(effectiveSaved);
                    } catch (Exception ex) {
                        log.warn("Error sending resolved email notification for alertId={}: {}", effectiveSaved.getId(), ex.getMessage());
                    }
                }
                log.info("Alert resolved manually: id={}, username={}, snoozeMinutes={}", id, username, effectiveSnoozeMinutes);
                return response;
            } catch (OptimisticLockingFailureException ex) {
                log.debug("Optimistic locking conflict on resolveAlert id={}, attempt={}", id, attempt + 1);
                if (attempt == OPTIMISTIC_LOCK_MAX_RETRIES - 1) {
                    Alert latest = alertRepository.findById(id)
                            .orElseThrow(() -> new AppException(ErrorCode.ALERT_NOT_EXISTED));
                    if (latest.getStatus() == AlertStatus.RESOLVED) {
                        return AlertRuleEngine.toAlertResponse(latest);
                    }
                    throw ex;
                }
            }
        }

        Alert latest = alertRepository.findById(id)
                .orElseThrow(() -> new AppException(ErrorCode.ALERT_NOT_EXISTED));
        return AlertRuleEngine.toAlertResponse(latest);
    }

    @Override
    public AlertResponse updateAlertWorkflow(String id, AlertWorkflowUpdateRequest request, String operatorUsername) {
        Alert initial = alertRepository.findById(id)
                .orElseThrow(() -> new AppException(ErrorCode.ALERT_NOT_EXISTED));
        assertAlertZoneAccess(initial);

        AlertWorkflowUpdateRequest safeRequest = request != null
                ? request
                : AlertWorkflowUpdateRequest.builder().build();
        int effectiveSnoozeMinutes = safeRequest.getSnoozeMinutes() != null
                ? Math.max(0, Math.min(240, safeRequest.getSnoozeMinutes()))
                : 15;

        for (int attempt = 0; attempt < OPTIMISTIC_LOCK_MAX_RETRIES; attempt++) {
            Alert current = alertRepository.findById(id)
                    .orElseThrow(() -> new AppException(ErrorCode.ALERT_NOT_EXISTED));

            // M4: Cảnh báo đã RESOLVED tuyệt đối không bị ghi đè ngược
            if (current.getStatus() == AlertStatus.RESOLVED
                    || current.getWorkflowStatus() == AlertWorkflowStatus.RESOLVED) {
                return AlertRuleEngine.toAlertResponse(current);
            }

            AlertWorkflowStatus currentWf = current.getWorkflowStatus() != null
                    ? current.getWorkflowStatus()
                    : (current.getStatus() == AlertStatus.ACKNOWLEDGED
                            ? AlertWorkflowStatus.ACKNOWLEDGED
                            : AlertWorkflowStatus.NEW);
            AlertWorkflowStatus requestedWf = safeRequest.getWorkflowStatus();
            AlertWorkflowStatus targetWf = requestedWf != null
                    ? (workflowOrder(requestedWf) >= workflowOrder(currentWf) ? requestedWf : currentWf)
                    : currentWf;

            if (safeRequest.getAssignedTo() != null) {
                String trimmedAssignee = safeRequest.getAssignedTo().trim();
                current.setAssignedTo(trimmedAssignee.isEmpty() ? null : trimmedAssignee);
            }
            if (safeRequest.getHandlingNote() != null) {
                String trimmedNote = safeRequest.getHandlingNote().trim();
                current.setHandlingNote(trimmedNote.isEmpty() ? null : trimmedNote);
            }

            java.time.Instant now = clock.instant();
            boolean wasFiring = current.getStatus() == AlertStatus.FIRING;
            boolean becameAcknowledged = false;
            boolean transitionedToResolved = false;

            current.setWorkflowStatus(targetWf);
            if (targetWf == AlertWorkflowStatus.ACKNOWLEDGED) {
                if (wasFiring) {
                    current.setStatus(AlertStatus.ACKNOWLEDGED);
                    current.setAcknowledgedAt(now);
                    current.setAcknowledgedBy(operatorUsername);
                    becameAcknowledged = true;
                }
            } else if (targetWf == AlertWorkflowStatus.IN_PROGRESS) {
                if (wasFiring) {
                    current.setStatus(AlertStatus.ACKNOWLEDGED);
                    current.setAcknowledgedAt(now);
                    current.setAcknowledgedBy(operatorUsername);
                    becameAcknowledged = true;
                }
                if (current.getInProgressAt() == null) {
                    current.setInProgressAt(now);
                }
            } else if (targetWf == AlertWorkflowStatus.RESOLVED) {
                current.setStatus(AlertStatus.RESOLVED);
                current.setResolvedAt(now);
                current.setResolvedBy(operatorUsername);
                transitionedToResolved = true;
            }

            try {
                Alert saved = alertRepository.save(current);
                Alert effectiveSaved = saved != null ? saved : current;

                if (transitionedToResolved) {
                    alertRuleEngine.onResolve(effectiveSaved, Duration.ofMinutes(effectiveSnoozeMinutes));
                } else if (becameAcknowledged) {
                    alertRuleEngine.onAcknowledge(id);
                }

                AlertResponse response = AlertRuleEngine.toAlertResponse(effectiveSaved);
                realtimePublisher.publishAlert(response);

                if (transitionedToResolved && alertEmailNotificationService != null) {
                    try {
                        alertEmailNotificationService.onAlertResolved(effectiveSaved);
                    } catch (Exception ex) {
                        log.warn("Error sending resolved email notification for alertId={}: {}", effectiveSaved.getId(), ex.getMessage());
                    }
                }

                log.info("Alert workflow updated: id={}, workflowStatus={}, assignedTo={}, operator={}",
                        id, effectiveSaved.getWorkflowStatus(), effectiveSaved.getAssignedTo(), operatorUsername);
                return response;
            } catch (OptimisticLockingFailureException ex) {
                log.debug("Optimistic locking conflict on updateAlertWorkflow id={}, attempt={}", id, attempt + 1);
                if (attempt == OPTIMISTIC_LOCK_MAX_RETRIES - 1) {
                    Alert latest = alertRepository.findById(id)
                            .orElseThrow(() -> new AppException(ErrorCode.ALERT_NOT_EXISTED));
                    if (latest.getStatus() == AlertStatus.RESOLVED) {
                        return AlertRuleEngine.toAlertResponse(latest);
                    }
                    throw ex;
                }
            }
        }

        Alert latest = alertRepository.findById(id)
                .orElseThrow(() -> new AppException(ErrorCode.ALERT_NOT_EXISTED));
        return AlertRuleEngine.toAlertResponse(latest);
    }

    private static int workflowOrder(AlertWorkflowStatus status) {
        if (status == null) {
            return 0;
        }
        return switch (status) {
            case NEW -> 0;
            case ACKNOWLEDGED -> 1;
            case IN_PROGRESS -> 2;
            case RESOLVED -> 3;
        };
    }

    @Override
    public void evaluateTelemetry(String deviceId, String hardwareId, String roomId, TelemetryPayload.TelemetryData data) {
        alertRuleEngine.evaluateTelemetry(deviceId, hardwareId, roomId, data);
    }

    @Override
    public void evaluateTelemetry(String deviceId, String hardwareId, String roomId, String zoneId, TelemetryPayload.TelemetryData data) {
        alertRuleEngine.evaluateTelemetry(deviceId, hardwareId, roomId, zoneId, data);
    }

    @Override
    public void triggerDeviceOfflineAlert(String deviceId, String hardwareId, String roomId) {
        alertRuleEngine.triggerDeviceOfflineAlert(deviceId, hardwareId, roomId);
    }

    @Override
    public void triggerDeviceOfflineAlert(String deviceId, String hardwareId, String roomId, String zoneId) {
        alertRuleEngine.triggerDeviceOfflineAlert(deviceId, hardwareId, roomId, zoneId);
    }

    @Override
    public void resolveDeviceOfflineAlert(String hardwareId) {
        alertRuleEngine.resolveDeviceOfflineAlert(hardwareId);
    }

    @Override
    public void resolveActiveAlertsForDevice(String deviceId, String hardwareId) {
        alertRuleEngine.resolveActiveAlertsForDevice(deviceId, hardwareId, "Device deactivated or deleted");
    }

    @Override
    public void evaluateSensorHealth(
            String deviceId,
            String hardwareId,
            String roomId,
            String zoneId,
            boolean hasInvalidSensorReading,
            boolean allValidReadings
    ) {
        alertRuleEngine.evaluateSensorHealth(deviceId, hardwareId, roomId, zoneId, hasInvalidSensorReading, allValidReadings);
    }

    @Override
    public void evaluateSensorHealth(
            String deviceId,
            String hardwareId,
            String roomId,
            String zoneId,
            boolean hasInvalidSensorReading,
            boolean allValidReadings,
            List<String> malfunctioningSensors
    ) {
        alertRuleEngine.evaluateSensorHealth(
                deviceId, hardwareId, roomId, zoneId, hasInvalidSensorReading, allValidReadings, malfunctioningSensors);
    }
}
