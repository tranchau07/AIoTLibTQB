package com.example.AIoTLibTQB.controller;

import com.example.AIoTLibTQB.document.Room;
import com.example.AIoTLibTQB.dto.response.ApiResponse;
import com.example.AIoTLibTQB.dto.response.PublicRoomStatusResponse;
import com.example.AIoTLibTQB.dto.response.TelemetryResponse;
import com.example.AIoTLibTQB.enums.ErrorCode;
import com.example.AIoTLibTQB.enums.RoomType;
import com.example.AIoTLibTQB.exception.AppException;
import com.example.AIoTLibTQB.repository.RoomRepository;
import com.example.AIoTLibTQB.service.TelemetryService;
import lombok.AccessLevel;
import lombok.RequiredArgsConstructor;
import lombok.experimental.FieldDefaults;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.stream.Collectors;

/**
 * Cổng API công khai chỉ đọc cho Kiosk và sinh viên tra cứu nhanh (GĐ4).
 * Được bảo vệ bởi RateLimitFilter (60 req/phút/IP) và trả về DTO tối giản không lộ hardwareId/deviceId.
 */
@RestController
@RequestMapping("/api/v1/public")
@RequiredArgsConstructor
@FieldDefaults(level = AccessLevel.PRIVATE, makeFinal = true)
public class PublicController {

    RoomRepository roomRepository;
    TelemetryService telemetryService;

    @GetMapping("/rooms")
    public ApiResponse<List<PublicRoomStatusResponse>> getPublicRooms(
            @RequestParam(required = false) Integer floor
    ) {
        List<Room> rooms = (floor != null)
                ? roomRepository.findByFloor(floor)
                : roomRepository.findAll();

        List<PublicRoomStatusResponse> result = rooms.stream()
                .map(this::toPublicStatus)
                .collect(Collectors.toList());

        return ApiResponse.<List<PublicRoomStatusResponse>>builder()
                .result(result)
                .build();
    }

    @GetMapping("/rooms/{id}/latest")
    public ApiResponse<PublicRoomStatusResponse> getPublicRoomLatest(@PathVariable String id) {
        Room room = roomRepository.findById(id)
                .orElseThrow(() -> new AppException(ErrorCode.ROOM_NOT_EXISTED));
        return ApiResponse.<PublicRoomStatusResponse>builder()
                .result(toPublicStatus(room))
                .build();
    }

    private PublicRoomStatusResponse toPublicStatus(Room room) {
        TelemetryResponse tel = null;
        try {
            tel = telemetryService.getPublicLatestByRoomId(room.getId());
        } catch (Exception ignored) {
        }

        return PublicRoomStatusResponse.builder()
                .id(room.getId())
                .code(room.getCode())
                .name(room.getName())
                .floor(room.getFloor())
                .capacity(room.getCapacity())
                .type(room.getType() != null ? room.getType() : RoomType.STUDY_ROOM)
                .boundaryPolygon(room.getBoundaryPolygon())
                .timestamp(tel != null ? tel.getTimestamp() : null)
                .acoustics(tel != null ? tel.getAcoustics() : null)
                .airQuality(tel != null ? tel.getAirQuality() : null)
                .environment(tel != null ? tel.getEnvironment() : null)
                .comfortScore(tel != null ? tel.getComfortScore() : null)
                .build();
    }
}
