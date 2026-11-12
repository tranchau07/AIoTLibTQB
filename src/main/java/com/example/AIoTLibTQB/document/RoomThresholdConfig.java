package com.example.AIoTLibTQB.document;

import com.example.AIoTLibTQB.enums.RoomType;
import lombok.*;
import lombok.experimental.FieldDefaults;

/**
 * Cấu hình ngưỡng cảnh báo động theo từng phòng (hoặc preset theo RoomType).
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@FieldDefaults(level = AccessLevel.PRIVATE)
public class RoomThresholdConfig {

    Double noiseAvgMax;
    Double noisePeakMax;
    Double noisePeakImmediate;
    Double tempMin;
    Double tempMax;
    Double humidityMin;
    Double humidityMax;
    Double pm25Max;

    public static RoomThresholdConfig defaultFor(RoomType roomType) {
        RoomType actual = roomType != null ? roomType : RoomType.STUDY_ROOM;
        return switch (actual) {
            case BOOK_STORAGE -> RoomThresholdConfig.builder()
                    .noiseAvgMax(70.0)
                    .noisePeakMax(80.0)
                    .noisePeakImmediate(85.0)
                    .tempMin(18.0)
                    .tempMax(24.0)
                    .humidityMin(45.0)
                    .humidityMax(60.0)
                    .pm25Max(35.0)
                    .build();
            case CIRCULATION_HALL -> RoomThresholdConfig.builder()
                    .noiseAvgMax(70.0)
                    .noisePeakMax(80.0)
                    .noisePeakImmediate(85.0)
                    .tempMin(20.0)
                    .tempMax(32.0)
                    .humidityMin(35.0)
                    .humidityMax(70.0)
                    .pm25Max(50.0)
                    .build();
            case STUDY_ROOM -> RoomThresholdConfig.builder()
                    .noiseAvgMax(65.0)
                    .noisePeakMax(75.0)
                    .noisePeakImmediate(85.0)
                    .tempMin(18.0)
                    .tempMax(32.0)
                    .humidityMin(35.0)
                    .humidityMax(70.0)
                    .pm25Max(50.0)
                    .build();
        };
    }

    public RoomThresholdConfig mergeWithDefaults(RoomType roomType) {
        RoomThresholdConfig def = defaultFor(roomType);
        return RoomThresholdConfig.builder()
                .noiseAvgMax(this.noiseAvgMax != null ? this.noiseAvgMax : def.getNoiseAvgMax())
                .noisePeakMax(this.noisePeakMax != null ? this.noisePeakMax : def.getNoisePeakMax())
                .noisePeakImmediate(this.noisePeakImmediate != null ? this.noisePeakImmediate : def.getNoisePeakImmediate())
                .tempMin(this.tempMin != null ? this.tempMin : def.getTempMin())
                .tempMax(this.tempMax != null ? this.tempMax : def.getTempMax())
                .humidityMin(this.humidityMin != null ? this.humidityMin : def.getHumidityMin())
                .humidityMax(this.humidityMax != null ? this.humidityMax : def.getHumidityMax())
                .pm25Max(this.pm25Max != null ? this.pm25Max : def.getPm25Max())
                .build();
    }
}
