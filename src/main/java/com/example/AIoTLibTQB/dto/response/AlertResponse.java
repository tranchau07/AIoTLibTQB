package com.example.AIoTLibTQB.dto.response;

import com.example.AIoTLibTQB.enums.AlertSeverity;
import com.example.AIoTLibTQB.enums.AlertStatus;
import com.example.AIoTLibTQB.enums.AlertType;
import com.example.AIoTLibTQB.enums.AlertWorkflowStatus;
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
    String zoneId;
    AlertType type;
    String metricType;
    String unit;
    AlertSeverity severity;
    Integer severityRank;
    AlertStatus status;
    AlertWorkflowStatus workflowStatus;
    String assignedTo;
    String handlingNote;
    Instant inProgressAt;
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
