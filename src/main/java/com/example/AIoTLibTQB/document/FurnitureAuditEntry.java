package com.example.AIoTLibTQB.document;

import lombok.*;
import lombok.experimental.FieldDefaults;

import java.time.Instant;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@FieldDefaults(level = AccessLevel.PRIVATE)
public class FurnitureAuditEntry {

    Instant timestamp;

    String username;

    String actionSummary;

    Long version;
}
