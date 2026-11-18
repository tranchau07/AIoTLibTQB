package com.example.AIoTLibTQB.dto.request;

import com.example.AIoTLibTQB.enums.AlertWorkflowStatus;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Size;
import lombok.*;
import lombok.experimental.FieldDefaults;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@FieldDefaults(level = AccessLevel.PRIVATE)
public class AlertWorkflowUpdateRequest {

    AlertWorkflowStatus workflowStatus;

    @Size(max = 100, message = "INVALID_REQUEST_PAYLOAD")
    String assignedTo;

    @Size(max = 1000, message = "INVALID_REQUEST_PAYLOAD")
    String handlingNote;

    @Min(value = 0, message = "INVALID_REQUEST_PAYLOAD")
    @Max(value = 240, message = "INVALID_REQUEST_PAYLOAD")
    Integer snoozeMinutes;
}
