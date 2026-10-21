package com.example.AIoTLibTQB.service;

import com.example.AIoTLibTQB.document.Room;
import com.example.AIoTLibTQB.dto.request.RoomCreationRequest;
import com.example.AIoTLibTQB.dto.request.RoomUpdateRequest;
import com.example.AIoTLibTQB.dto.response.RoomResponse;
import com.example.AIoTLibTQB.enums.ErrorCode;
import com.example.AIoTLibTQB.enums.RoomType;
import com.example.AIoTLibTQB.exception.AppException;
import com.example.AIoTLibTQB.repository.RoomRepository;
import lombok.AccessLevel;
import lombok.RequiredArgsConstructor;
import lombok.experimental.FieldDefaults;
import lombok.extern.slf4j.Slf4j;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.stream.Collectors;

@Slf4j
@Service
@RequiredArgsConstructor
@FieldDefaults(level = AccessLevel.PRIVATE, makeFinal = true)
public class RoomService {

    RoomRepository roomRepository;

    @PreAuthorize("hasAnyAuthority('ADMIN', 'LIBRARIAN')")
    public RoomResponse create(RoomCreationRequest request) {
        String normalizedCode = request.getCode().trim().toUpperCase();
        if (roomRepository.existsByCode(normalizedCode)) {
            throw new AppException(ErrorCode.ROOM_EXISTED);
        }

        Room room = Room.builder()
                .code(normalizedCode)
                .name(request.getName().trim())
                .floor(request.getFloor())
                .capacity(request.getCapacity())
                .description(request.getDescription())
                .targetComfortScore(request.getTargetComfortScore())
                .boundaryPolygon(request.getBoundaryPolygon())
                .type(request.getType() != null ? request.getType() : RoomType.STUDY_ROOM)
                .build();

        Room saved = roomRepository.save(room);
        log.info("New room created: '{}' (code={}, floor={})", saved.getName(), saved.getCode(), saved.getFloor());
        return toRoomResponse(saved);
    }

    public List<RoomResponse> getAll() {
        return roomRepository.findAll().stream()
                .map(this::toRoomResponse)
                .collect(Collectors.toList());
    }

    public RoomResponse getById(String id) {
        return toRoomResponse(findRoomById(id));
    }

    public RoomResponse getByCode(String code) {
        return roomRepository.findByCode(code.trim().toUpperCase())
                .map(this::toRoomResponse)
                .orElseThrow(() -> new AppException(ErrorCode.ROOM_NOT_EXISTED));
    }

    public List<RoomResponse> getByFloor(Integer floor) {
        return roomRepository.findByFloor(floor).stream()
                .map(this::toRoomResponse)
                .collect(Collectors.toList());
    }

    @PreAuthorize("hasAnyAuthority('ADMIN', 'LIBRARIAN')")
    public RoomResponse update(String id, RoomUpdateRequest request) {
        Room room = findRoomById(id);

        if (request.getName() != null && !request.getName().isBlank()) {
            room.setName(request.getName().trim());
        }
        if (request.getFloor() != null) {
            room.setFloor(request.getFloor());
        }
        if (request.getCapacity() != null) {
            room.setCapacity(request.getCapacity());
        }
        if (request.getDescription() != null) {
            room.setDescription(request.getDescription());
        }
        if (request.getTargetComfortScore() != null) {
            room.setTargetComfortScore(request.getTargetComfortScore());
        }
        if (request.getBoundaryPolygon() != null) {
            room.setBoundaryPolygon(request.getBoundaryPolygon());
        }
        if (request.getType() != null) {
            room.setType(request.getType());
        }

        Room updated = roomRepository.save(room);
        log.info("Room updated: '{}' (code={})", updated.getName(), updated.getCode());
        return toRoomResponse(updated);
    }

    @PreAuthorize("hasAuthority('ADMIN')")
    public void delete(String id) {
        if (!roomRepository.existsById(id)) {
            throw new AppException(ErrorCode.ROOM_NOT_EXISTED);
        }
        roomRepository.deleteById(id);
        log.warn("Room deleted: (id={})", id);
    }

    private Room findRoomById(String id) {
        return roomRepository.findById(id)
                .orElseThrow(() -> new AppException(ErrorCode.ROOM_NOT_EXISTED));
    }

    private RoomResponse toRoomResponse(Room room) {
        return RoomResponse.builder()
                .id(room.getId())
                .code(room.getCode())
                .name(room.getName())
                .floor(room.getFloor())
                .capacity(room.getCapacity())
                .description(room.getDescription())
                .targetComfortScore(room.getTargetComfortScore())
                .boundaryPolygon(room.getBoundaryPolygon())
                .type(room.getType() != null ? room.getType() : RoomType.STUDY_ROOM)
                .createdAt(room.getCreatedAt())
                .updatedAt(room.getUpdatedAt())
                .build();
    }
}
