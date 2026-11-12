package com.example.AIoTLibTQB.dto.response;

import com.example.AIoTLibTQB.enums.AlertSeverity;
import com.example.AIoTLibTQB.enums.AlertStatus;
import com.example.AIoTLibTQB.enums.AlertType;
import lombok.*;
import lombok.experimental.FieldDefaults;

import java.time.Instant;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@FieldDefaults(level = AccessLevel.PRIVATE)
public class AlertResponse {

    String id;
    String deviceId;
    String hardwareId;
    String roomId;
    AlertType type;
    AlertSeverity severity;
    Integer severityRank;
    AlertStatus status;
    Double currentValue;
    Double threshold;
    String message;
    String recommendedAction;
    Instant startedAt;
    Instant acknowledgedAt;
    Instant resolvedAt;
    String acknowledgedBy;
    String resolvedBy;
}
