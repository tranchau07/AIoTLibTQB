package com.example.AIoTLibTQB.document;

import lombok.*;
import lombok.experimental.FieldDefaults;

import java.time.Instant;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@FieldDefaults(level = AccessLevel.PRIVATE)
public class AffectedNodeSnapshot {

    String deviceId;
    String hardwareId;
    String metricType;
    Double currentValue;
    Double threshold;
    Instant updatedAt;
}
