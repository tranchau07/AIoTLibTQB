package com.example.AIoTLibTQB.controller;

import com.example.AIoTLibTQB.dto.request.RoomCreationRequest;
import com.example.AIoTLibTQB.dto.request.RoomUpdateRequest;
import com.example.AIoTLibTQB.dto.response.ApiResponse;
import com.example.AIoTLibTQB.dto.response.RoomResponse;
import com.example.AIoTLibTQB.service.RoomService;
import jakarta.validation.Valid;
import lombok.AccessLevel;
import lombok.RequiredArgsConstructor;
import lombok.experimental.FieldDefaults;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api/v1/rooms")
@RequiredArgsConstructor
@FieldDefaults(level = AccessLevel.PRIVATE, makeFinal = true)
public class RoomController {

    RoomService roomService;

    @PostMapping
    public ApiResponse<RoomResponse> create(@RequestBody @Valid RoomCreationRequest request) {
        return ApiResponse.<RoomResponse>builder()
                .result(roomService.create(request))
                .build();
    }

    @GetMapping
    public ApiResponse<List<RoomResponse>> getAll(@RequestParam(required = false) Integer floor) {
        List<RoomResponse> list = (floor != null) ? roomService.getByFloor(floor) : roomService.getAll();
        return ApiResponse.<List<RoomResponse>>builder()
                .result(list)
                .build();
    }

    @GetMapping("/{id}")
    public ApiResponse<RoomResponse> getById(@PathVariable String id) {
        return ApiResponse.<RoomResponse>builder()
                .result(roomService.getById(id))
                .build();
    }

    @GetMapping("/code/{code}")
    public ApiResponse<RoomResponse> getByCode(@PathVariable String code) {
        return ApiResponse.<RoomResponse>builder()
                .result(roomService.getByCode(code))
                .build();
    }

    @PutMapping("/{id}")
    public ApiResponse<RoomResponse> update(
            @PathVariable String id,
            @RequestBody @Valid RoomUpdateRequest request) {
        return ApiResponse.<RoomResponse>builder()
                .result(roomService.update(id, request))
                .build();
    }

    @DeleteMapping("/{id}")
    public ApiResponse<Void> delete(@PathVariable String id) {
        roomService.delete(id);
        return ApiResponse.<Void>builder().build();
    }
}
