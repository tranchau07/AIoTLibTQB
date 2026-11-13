package com.example.AIoTLibTQB.controller;

import com.example.AIoTLibTQB.document.ComfortScoreRecord;
import com.example.AIoTLibTQB.document.EnvironmentMetrics;
import com.example.AIoTLibTQB.document.Room;
import com.example.AIoTLibTQB.document.TelemetryMetadata;
import com.example.AIoTLibTQB.dto.response.ApiResponse;
import com.example.AIoTLibTQB.dto.response.PublicRoomStatusResponse;
import com.example.AIoTLibTQB.dto.response.TelemetryResponse;
import com.example.AIoTLibTQB.enums.RoomType;
import com.example.AIoTLibTQB.repository.RoomRepository;
import com.example.AIoTLibTQB.service.TelemetryService;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Instant;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class PublicControllerTest {

    @Mock
    RoomRepository roomRepository;

    @Mock
    TelemetryService telemetryService;

    @InjectMocks
    PublicController publicController;

    @Test
    @DisplayName("GET /api/v1/public/rooms trả về DTO công khai và JSON tuyệt đối KHÔNG chứa deviceId hay hardwareId")
    void getPublicRooms_doesNotExposeHardwareOrDeviceIds() throws Exception {
        Room room = Room.builder()
                .id("room-301")
                .code("TQB_301")
                .name("Phòng Multimedia 301")
                .floor(3)
                .capacity(120)
                .type(RoomType.STUDY_ROOM)
                .build();

        TelemetryResponse tel = TelemetryResponse.builder()
                .id("tel-1")
                .timestamp(Instant.parse("2026-11-12T10:00:00Z"))
                .metadata(TelemetryMetadata.builder()
                        .deviceId("SECRET_DEV_ID_999")
                        .hardwareId("SECRET_HW_ESP32_999")
                        .roomId("room-301")
                        .build())
                .environment(EnvironmentMetrics.builder().temperature(24.0).humidity(55.0).lux(410.0).build())
                .comfortScore(ComfortScoreRecord.builder().overall(88.0).grade("Gold").build())
                .wifiRssi(-55)
                .build();

        when(roomRepository.findByFloor(3)).thenReturn(List.of(room));
        when(telemetryService.getPublicLatestByRoomId("room-301")).thenReturn(tel);

        ApiResponse<List<PublicRoomStatusResponse>> response = publicController.getPublicRooms(3);
        assertThat(response.getResult()).hasSize(1);
        assertThat(response.getResult().get(0).getComfortScore()).isNotNull();
        assertThat(response.getResult().get(0).getComfortScore().getOverall()).isEqualTo(88.0);

        ObjectMapper mapper = new ObjectMapper().registerModule(new JavaTimeModule());
        String json = mapper.writeValueAsString(response);

        assertThat(json).contains("TQB_301");
        assertThat(json).doesNotContain("deviceId");
        assertThat(json).doesNotContain("hardwareId");
        assertThat(json).doesNotContain("SECRET_DEV_ID_999");
        assertThat(json).doesNotContain("SECRET_HW_ESP32_999");
    }

    @Test
    @DisplayName("GET /api/v1/public/rooms/{id}/latest trả về telemetry ẩn danh qua getPublicLatestByRoomId")
    void getPublicRoomLatest_returnsAnonymizedTelemetry() {
        Room room = Room.builder()
                .id("room-301")
                .code("TQB_301")
                .name("Phòng Multimedia 301")
                .floor(3)
                .capacity(120)
                .type(RoomType.STUDY_ROOM)
                .build();

        TelemetryResponse tel = TelemetryResponse.builder()
                .id("tel-1")
                .timestamp(Instant.parse("2026-11-12T10:00:00Z"))
                .environment(EnvironmentMetrics.builder().temperature(23.5).humidity(52.0).lux(430.0).build())
                .comfortScore(ComfortScoreRecord.builder().overall(92.0).grade("Platinum").build())
                .build();

        when(roomRepository.findById("room-301")).thenReturn(java.util.Optional.of(room));
        when(telemetryService.getPublicLatestByRoomId("room-301")).thenReturn(tel);

        ApiResponse<PublicRoomStatusResponse> response = publicController.getPublicRoomLatest("room-301");
        assertThat(response.getResult().getCode()).isEqualTo("TQB_301");
        assertThat(response.getResult().getComfortScore().getGrade()).isEqualTo("Platinum");
        assertThat(response.getResult().getEnvironment().getTemperature()).isEqualTo(23.5);
    }
}
