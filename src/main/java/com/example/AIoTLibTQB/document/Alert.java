package com.example.AIoTLibTQB.document;

import com.example.AIoTLibTQB.enums.AlertSeverity;
import com.example.AIoTLibTQB.enums.AlertStatus;
import com.example.AIoTLibTQB.enums.AlertType;
import com.example.AIoTLibTQB.enums.AlertWorkflowStatus;
import lombok.*;
import lombok.experimental.FieldDefaults;
import org.springframework.data.annotation.CreatedDate;
import org.springframework.data.annotation.Id;
import org.springframework.data.annotation.Version;
import org.springframework.data.mongodb.core.index.CompoundIndex;
import org.springframework.data.mongodb.core.index.CompoundIndexes;
import org.springframework.data.mongodb.core.index.Indexed;
import org.springframework.data.mongodb.core.mapping.Document;

import java.time.Instant;
import java.util.List;

@Document(collection = "alerts")
@CompoundIndexes({
        @CompoundIndex(name = "idx_alert_device_type_status", def = "{'deviceId': 1, 'type': 1, 'status': 1, 'startedAt': -1}"),
        @CompoundIndex(name = "idx_alert_hardware_type_status", def = "{'hardwareId': 1, 'type': 1, 'status': 1}"),
        @CompoundIndex(name = "idx_alert_status_started", def = "{'status': 1, 'startedAt': -1}"),
        @CompoundIndex(name = "idx_alert_zone_status_started", def = "{'zoneId': 1, 'status': 1, 'startedAt': -1}")
})
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@FieldDefaults(level = AccessLevel.PRIVATE)
public class Alert {

    @Id
    String id;

    @Version
    Long version;

    @Indexed
    String deviceId;

    String hardwareId;

    @Indexed
    String roomId;

    @Indexed
    String zoneId;

    AlertType type;

    String metricType;

    AlertSeverity severity;

    @Indexed
    Integer severityRank;

    AlertStatus status;

    AlertWorkflowStatus workflowStatus;

    String assignedTo;

    String handlingNote;

    String resolutionTag;

    Instant inProgressAt;

    Boolean sensorRecovered;

    Instant sensorRecoveredAt;

    List<AffectedNodeSnapshot> affectedNodes;

    Double currentValue;

    Double threshold;

    String message;

    String recommendedAction;

    @CreatedDate
    Instant startedAt;

    Instant acknowledgedAt;

    Instant resolvedAt;

    String acknowledgedBy;

    String resolvedBy;
}
