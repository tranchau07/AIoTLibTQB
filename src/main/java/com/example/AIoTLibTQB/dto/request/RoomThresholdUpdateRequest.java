package com.example.AIoTLibTQB.dto.request;

import lombok.*;
import lombok.experimental.FieldDefaults;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@FieldDefaults(level = AccessLevel.PRIVATE)
public class RoomThresholdUpdateRequest {

    Double noiseAvgMax;
    Double noisePeakMax;
    Double noisePeakImmediate;
    Double tempMin;
    Double tempMax;
    Double humidityMin;
    Double humidityMax;
    Double pm25Max;
}
