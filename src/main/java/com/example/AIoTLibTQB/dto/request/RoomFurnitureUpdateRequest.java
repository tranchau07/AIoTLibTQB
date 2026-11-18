package com.example.AIoTLibTQB.dto.request;

import com.example.AIoTLibTQB.document.FurnitureItemDoc;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import lombok.*;
import lombok.experimental.FieldDefaults;

import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@FieldDefaults(level = AccessLevel.PRIVATE)
public class RoomFurnitureUpdateRequest {

    Long expectedVersion;

    @NotNull(message = "INVALID_REQUEST_PAYLOAD")
    @Valid
    List<FurnitureItemDoc> items;

    @Size(max = 300)
    String changeNote;
}
