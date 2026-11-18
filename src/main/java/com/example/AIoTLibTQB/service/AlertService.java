package com.example.AIoTLibTQB.service;

import com.example.AIoTLibTQB.dto.mqtt.TelemetryPayload;
import com.example.AIoTLibTQB.dto.response.AlertResponse;
import com.example.AIoTLibTQB.dto.response.PageResponse;
import com.example.AIoTLibTQB.enums.AlertStatus;
import com.example.AIoTLibTQB.enums.AlertType;
import org.springframework.data.domain.Pageable;

public interface AlertService {

    PageResponse<AlertResponse> getAlerts(String roomId, AlertType type, AlertStatus status, Pageable pageable);

    long getUnreadCount();

    AlertResponse acknowledgeAlert(String id, String username);

    AlertResponse resolveAlert(String id, String username);

    default AlertResponse resolveAlert(String id, String username, Integer snoozeMinutes) {
        return resolveAlert(id, username);
    }

    void evaluateTelemetry(String deviceId, String hardwareId, String roomId, TelemetryPayload.TelemetryData data);

    default void evaluateTelemetry(String deviceId, String hardwareId, String roomId, String zoneId, TelemetryPayload.TelemetryData data) {
        evaluateTelemetry(deviceId, hardwareId, roomId, data);
    }

    void triggerDeviceOfflineAlert(String deviceId, String hardwareId, String roomId);

    default void triggerDeviceOfflineAlert(String deviceId, String hardwareId, String roomId, String zoneId) {
        triggerDeviceOfflineAlert(deviceId, hardwareId, roomId);
    }

    void resolveDeviceOfflineAlert(String hardwareId);

    default void resolveActiveAlertsForDevice(String deviceId, String hardwareId) {
    }

    default void evaluateSensorHealth(
            String deviceId,
            String hardwareId,
            String roomId,
            String zoneId,
            boolean hasInvalidSensorReading,
            boolean allValidReadings
    ) {
    }

    default void evaluateSensorHealth(
            String deviceId,
            String hardwareId,
            String roomId,
            String zoneId,
            boolean hasInvalidSensorReading,
            boolean allValidReadings,
            java.util.List<String> malfunctioningSensors
    ) {
        evaluateSensorHealth(deviceId, hardwareId, roomId, zoneId, hasInvalidSensorReading, allValidReadings);
    }
}
