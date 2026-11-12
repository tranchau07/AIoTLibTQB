package com.example.AIoTLibTQB.dto.response;

import com.example.AIoTLibTQB.document.AcousticMetrics;
import com.example.AIoTLibTQB.document.AirQualityMetrics;
import com.example.AIoTLibTQB.document.ComfortScoreRecord;
import com.example.AIoTLibTQB.document.EnvironmentMetrics;
import com.example.AIoTLibTQB.document.Point2D;
import com.example.AIoTLibTQB.enums.RoomType;
import lombok.*;
import lombok.experimental.FieldDefaults;

import java.time.Instant;
import java.util.List;

/**
 * DTO công khai tối giản cho Kiosk và cổng tra cứu sinh viên (GĐ4).
 * Tuyệt đối KHÔNG chứa deviceId, hardwareId hay thông tin hạ tầng nội bộ.
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@FieldDefaults(level = AccessLevel.PRIVATE)
public class PublicRoomStatusResponse {

    String id;
    String code;
    String name;
    Integer floor;
    Integer capacity;
    RoomType type;
    List<Point2D> boundaryPolygon;

    Instant timestamp;
    AcousticMetrics acoustics;
    AirQualityMetrics airQuality;
    EnvironmentMetrics environment;
    ComfortScoreRecord comfortScore;
}
