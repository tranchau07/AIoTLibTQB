package com.example.AIoTLibTQB.service;

public interface DeviceCommandPublisher {

    String LED_NORMAL = "NORMAL";
    String LED_WARN_PULSE = "WARN_PULSE";
    String LED_CRITICAL_BLINK = "CRITICAL_BLINK";
    String LED_STAFF_DISPATCHED = "STAFF_DISPATCHED";

    void publishLedState(
            String hardwareId,
            String ledState,
            String reason,
            Double measuredValue,
            Double thresholdValue
    );

    default void clearDeviceState(String hardwareId) {
    }

    default void reset() {
    }
}
