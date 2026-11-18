package com.example.AIoTLibTQB.document;

import lombok.*;
import lombok.experimental.FieldDefaults;
import org.springframework.data.annotation.Id;
import org.springframework.data.annotation.LastModifiedDate;
import org.springframework.data.annotation.Version;
import org.springframework.data.mongodb.core.index.Indexed;
import org.springframework.data.mongodb.core.mapping.Document;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

@Document(collection = "room_furniture_layouts")
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@FieldDefaults(level = AccessLevel.PRIVATE)
public class RoomFurnitureLayout {

    @Id
    String id;

    @Indexed(unique = true)
    String roomId;

    @Version
    Long version;

    @Builder.Default
    List<FurnitureItemDoc> items = new ArrayList<>();

    String updatedBy;

    @LastModifiedDate
    Instant updatedAt;

    @Builder.Default
    List<FurnitureAuditEntry> auditHistory = new ArrayList<>();
}
