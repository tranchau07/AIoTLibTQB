package com.example.AIoTLibTQB.document;

import com.example.AIoTLibTQB.enums.AlertStatus;
import com.example.AIoTLibTQB.enums.AlertType;
import lombok.*;
import lombok.experimental.FieldDefaults;
import org.springframework.data.annotation.CreatedDate;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.index.Indexed;
import org.springframework.data.mongodb.core.mapping.Document;

import java.time.Instant;

@Document(collection = "alerts")
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@FieldDefaults(level = AccessLevel.PRIVATE)
public class Alert {

    @Id
    String id;

    @Indexed
    String deviceId;

    String hardwareId;

    @Indexed
    String roomId;

    AlertType type;

    AlertStatus status;

    Double currentValue;

    Double threshold;

    String message;

    @CreatedDate
    Instant startedAt;

    Instant acknowledgedAt;

    Instant resolvedAt;

    String acknowledgedBy;
}
