package com.example.AIoTLibTQB.dto.response;

import com.example.AIoTLibTQB.document.FurnitureAuditEntry;
import com.example.AIoTLibTQB.document.FurnitureItemDoc;
import lombok.*;
import lombok.experimental.FieldDefaults;

import java.time.Instant;
import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@FieldDefaults(level = AccessLevel.PRIVATE)
public class RoomFurnitureResponse {

    String roomId;

    Long version;

    List<FurnitureItemDoc> items;

    String updatedBy;

    Instant updatedAt;

    List<FurnitureAuditEntry> auditHistory;
}
