package com.example.AIoTLibTQB.dto.mqtt;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.*;
import lombok.experimental.FieldDefaults;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@JsonInclude(JsonInclude.Include.NON_NULL)
@FieldDefaults(level = AccessLevel.PRIVATE)
public class DeviceCommandPayload {

    String command;

    @JsonProperty("hardware_id")
    String hardwareId;

    @JsonProperty("led_state")
    String ledState;

    String reason;

    @JsonProperty("measured_value")
    Double measuredValue;

    @JsonProperty("threshold_value")
    Double thresholdValue;

    Long timestamp;
}
