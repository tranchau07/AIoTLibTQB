package com.example.AIoTLibTQB.controller;

import com.example.AIoTLibTQB.dto.response.ApiResponse;
import com.example.AIoTLibTQB.dto.response.TelemetryBucketResponse;
import com.example.AIoTLibTQB.dto.response.TelemetryResponse;
import com.example.AIoTLibTQB.service.TelemetryService;
import lombok.AccessLevel;
import lombok.RequiredArgsConstructor;
import lombok.experimental.FieldDefaults;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;

import java.time.Instant;
import java.util.List;

@RestController
@RequestMapping("/api/v1/telemetry")
@RequiredArgsConstructor
@FieldDefaults(level = AccessLevel.PRIVATE, makeFinal = true)
@PreAuthorize("hasAnyAuthority('ADMIN', 'LIBRARIAN', 'ZONE_MANAGER', 'USER', 'VIEWER')")
public class TelemetryController {

    TelemetryService telemetryService;

    @GetMapping("/device/{deviceId}/latest")
    public ApiResponse<TelemetryResponse> getLatestByDeviceId(@PathVariable String deviceId) {
        return ApiResponse.<TelemetryResponse>builder()
                .result(telemetryService.getLatestByDeviceId(deviceId))
                .build();
    }

    @GetMapping("/room/{roomId}/latest")
    public ApiResponse<TelemetryResponse> getLatestByRoomId(@PathVariable String roomId) {
        return ApiResponse.<TelemetryResponse>builder()
                .result(telemetryService.getLatestByRoomId(roomId))
                .build();
    }

    @GetMapping("/device/{deviceId}")
    public ApiResponse<List<TelemetryResponse>> getHistoryByDeviceId(
            @PathVariable String deviceId,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant start,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant end) {
        return ApiResponse.<List<TelemetryResponse>>builder()
                .result(telemetryService.getHistoryByDeviceId(deviceId, start, end))
                .build();
    }

    @GetMapping("/room/{roomId}")
    public ApiResponse<List<TelemetryResponse>> getHistoryByRoomId(
            @PathVariable String roomId,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant start,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant end) {
        return ApiResponse.<List<TelemetryResponse>>builder()
                .result(telemetryService.getHistoryByRoomId(roomId, start, end))
                .build();
    }

    @GetMapping("/room/{roomId}/buckets")
    public ApiResponse<TelemetryBucketResponse> getBucketsByRoomId(
            @PathVariable String roomId,
            @RequestParam(defaultValue = "1h") String interval,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant start,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant end) {
        return ApiResponse.<TelemetryBucketResponse>builder()
                .result(telemetryService.getBucketsByRoomId(roomId, interval, start, end))
                .build();
    }
}
