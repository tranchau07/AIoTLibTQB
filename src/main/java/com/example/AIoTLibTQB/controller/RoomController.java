package com.example.AIoTLibTQB.controller;

import com.example.AIoTLibTQB.dto.request.RoomCreationRequest;
import com.example.AIoTLibTQB.dto.request.RoomFurnitureUpdateRequest;
import com.example.AIoTLibTQB.dto.request.RoomThresholdUpdateRequest;
import com.example.AIoTLibTQB.dto.request.RoomUpdateRequest;
import com.example.AIoTLibTQB.dto.response.ApiResponse;
import com.example.AIoTLibTQB.dto.response.PageResponse;
import com.example.AIoTLibTQB.dto.response.RoomFurnitureResponse;
import com.example.AIoTLibTQB.dto.response.RoomResponse;
import com.example.AIoTLibTQB.service.RoomService;
import jakarta.validation.Valid;
import lombok.AccessLevel;
import lombok.RequiredArgsConstructor;
import lombok.experimental.FieldDefaults;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Set;

@RestController
@RequestMapping("/api/v1/rooms")
@RequiredArgsConstructor
@FieldDefaults(level = AccessLevel.PRIVATE, makeFinal = true)
public class RoomController {

    private static final Set<String> OPERATOR_AUTHORITIES = Set.of(
            "ADMIN", "LIBRARIAN", "ZONE_MANAGER", "MAINTENANCE", "MANAGE_ZONES"
    );

    RoomService roomService;

    @PreAuthorize("hasAnyAuthority('ADMIN', 'LIBRARIAN')")
    @PostMapping
    public ApiResponse<RoomResponse> create(@RequestBody @Valid RoomCreationRequest request) {
        return ApiResponse.<RoomResponse>builder()
                .result(roomService.create(request))
                .build();
    }

    @PreAuthorize("hasAnyAuthority('ADMIN', 'LIBRARIAN', 'ZONE_MANAGER', 'MAINTENANCE', 'VIEWER', 'USER')")
    @GetMapping
    public ApiResponse<PageResponse<RoomResponse>> getAll(
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "10") int size,
            @RequestParam(required = false) Integer floor) {
        int safePage = Math.max(0, page);
        int safeSize = Math.max(1, Math.min(100, size));
        Pageable pageable = PageRequest.of(safePage, safeSize);
        return ApiResponse.<PageResponse<RoomResponse>>builder()
                .result(roomService.getAll(pageable, floor))
                .build();
    }

    @PreAuthorize("hasAnyAuthority('ADMIN', 'LIBRARIAN', 'ZONE_MANAGER', 'MAINTENANCE', 'VIEWER', 'USER')")
    @GetMapping("/{id}")
    public ApiResponse<RoomResponse> getById(@PathVariable String id) {
        return ApiResponse.<RoomResponse>builder()
                .result(roomService.getById(id))
                .build();
    }

    @PreAuthorize("hasAnyAuthority('ADMIN', 'LIBRARIAN', 'ZONE_MANAGER', 'MAINTENANCE', 'VIEWER', 'USER')")
    @GetMapping("/code/{code}")
    public ApiResponse<RoomResponse> getByCode(@PathVariable String code) {
        return ApiResponse.<RoomResponse>builder()
                .result(roomService.getByCode(code))
                .build();
    }

    @PreAuthorize("hasAnyAuthority('ADMIN', 'LIBRARIAN', 'ZONE_MANAGER', 'MAINTENANCE', 'VIEWER', 'USER')")
    @GetMapping("/{id}/furniture")
    public ApiResponse<RoomFurnitureResponse> getFurniture(@PathVariable String id) {
        boolean includeSensitive = hasOperatorAuthority();
        return ApiResponse.<RoomFurnitureResponse>builder()
                .result(roomService.getFurnitureLayout(id, includeSensitive))
                .build();
    }

    @PreAuthorize("hasAnyAuthority('ADMIN', 'LIBRARIAN', 'MAINTENANCE', 'MANAGE_ZONES')")
    @PutMapping("/{id}/furniture")
    public ApiResponse<RoomFurnitureResponse> updateFurniture(
            @PathVariable String id,
            @RequestBody @Valid RoomFurnitureUpdateRequest request) {
        String username = extractUsername();
        return ApiResponse.<RoomFurnitureResponse>builder()
                .result(roomService.updateFurnitureLayout(id, request, username))
                .build();
    }

    @PreAuthorize("hasAnyAuthority('ADMIN', 'LIBRARIAN')")
    @PutMapping("/{id}")
    public ApiResponse<RoomResponse> update(
            @PathVariable String id,
            @RequestBody @Valid RoomUpdateRequest request) {
        return ApiResponse.<RoomResponse>builder()
                .result(roomService.update(id, request))
                .build();
    }

    @PreAuthorize("hasAnyAuthority('ADMIN', 'LIBRARIAN')")
    @PutMapping("/{id}/thresholds")
    public ApiResponse<RoomResponse> updateThresholds(
            @PathVariable String id,
            @RequestBody @Valid RoomThresholdUpdateRequest request) {
        return ApiResponse.<RoomResponse>builder()
                .result(roomService.updateThresholds(id, request))
                .build();
    }

    @PreAuthorize("hasAuthority('ADMIN')")
    @DeleteMapping("/{id}")
    public ApiResponse<Void> delete(@PathVariable String id) {
        roomService.delete(id);
        return ApiResponse.<Void>builder().build();
    }

    private boolean hasOperatorAuthority() {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication == null || authentication.getAuthorities() == null) {
            return false;
        }
        return authentication.getAuthorities().stream()
                .map(GrantedAuthority::getAuthority)
                .anyMatch(OPERATOR_AUTHORITIES::contains);
    }

    private String extractUsername() {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication != null && authentication.getName() != null && !authentication.getName().isBlank()) {
            return authentication.getName();
        }
        return "system";
    }
}
