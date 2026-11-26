package com.example.AIoTLibTQB.service;

import com.example.AIoTLibTQB.document.FurnitureAuditEntry;
import com.example.AIoTLibTQB.document.FurnitureItemDoc;
import com.example.AIoTLibTQB.document.Room;
import com.example.AIoTLibTQB.document.RoomFurnitureLayout;
import com.example.AIoTLibTQB.document.RoomThresholdConfig;
import com.example.AIoTLibTQB.dto.request.RoomCreationRequest;
import com.example.AIoTLibTQB.dto.request.RoomFurnitureUpdateRequest;
import com.example.AIoTLibTQB.dto.request.RoomThresholdUpdateRequest;
import com.example.AIoTLibTQB.dto.request.RoomUpdateRequest;
import com.example.AIoTLibTQB.dto.response.PageResponse;
import com.example.AIoTLibTQB.dto.response.RoomFurnitureResponse;
import com.example.AIoTLibTQB.dto.response.RoomResponse;
import com.example.AIoTLibTQB.enums.ErrorCode;
import com.example.AIoTLibTQB.enums.RoomType;
import com.example.AIoTLibTQB.exception.AppException;
import com.example.AIoTLibTQB.repository.DeviceRepository;
import com.example.AIoTLibTQB.repository.RoomFurnitureLayoutRepository;
import com.example.AIoTLibTQB.repository.RoomRepository;
import lombok.AccessLevel;
import lombok.experimental.FieldDefaults;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.dao.OptimisticLockingFailureException;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageImpl;
import org.springframework.data.domain.Pageable;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.stream.Collectors;

@Slf4j
@Service
@FieldDefaults(level = AccessLevel.PRIVATE, makeFinal = true)
public class RoomService {

    RoomRepository roomRepository;
    DeviceRepository deviceRepository;
    ComfortScoreService comfortScoreService;
    LatestTelemetryCache latestTelemetryCache;
    AlertRuleEngine alertRuleEngine;
    RoomFurnitureLayoutRepository roomFurnitureLayoutRepository;

    @Autowired
    public RoomService(RoomRepository roomRepository,
                       DeviceRepository deviceRepository,
                       @Autowired(required = false) ComfortScoreService comfortScoreService,
                       @Autowired(required = false) LatestTelemetryCache latestTelemetryCache,
                       @Autowired(required = false) AlertRuleEngine alertRuleEngine,
                       @Autowired(required = false) RoomFurnitureLayoutRepository roomFurnitureLayoutRepository) {
        this.roomRepository = roomRepository;
        this.deviceRepository = deviceRepository;
        this.comfortScoreService = comfortScoreService;
        this.latestTelemetryCache = latestTelemetryCache;
        this.alertRuleEngine = alertRuleEngine;
        this.roomFurnitureLayoutRepository = roomFurnitureLayoutRepository;
    }

    public RoomService(RoomRepository roomRepository,
                       DeviceRepository deviceRepository,
                       ComfortScoreService comfortScoreService,
                       LatestTelemetryCache latestTelemetryCache,
                       AlertRuleEngine alertRuleEngine) {
        this(roomRepository, deviceRepository, comfortScoreService, latestTelemetryCache, alertRuleEngine, null);
    }

    public RoomService(RoomRepository roomRepository,
                       DeviceRepository deviceRepository,
                       ComfortScoreService comfortScoreService,
                       LatestTelemetryCache latestTelemetryCache) {
        this(roomRepository, deviceRepository, comfortScoreService, latestTelemetryCache, null, null);
    }

    public RoomService(RoomRepository roomRepository, DeviceRepository deviceRepository) {
        this(roomRepository, deviceRepository, null, null, null, null);
    }

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

    public PageResponse<RoomResponse> getAll(Pageable pageable, Integer floor) {
        if (floor != null) {
            List<Room> roomsOnFloor = roomRepository.findByFloor(floor);
            int start = (int) pageable.getOffset();
            int end = Math.min(start + pageable.getPageSize(), roomsOnFloor.size());
            List<Room> sub = (start <= roomsOnFloor.size())
                    ? roomsOnFloor.subList(start, end)
                    : List.of();
            Page<Room> page = new PageImpl<>(sub, pageable, roomsOnFloor.size());
            return PageResponse.<RoomResponse>builder()
                    .content(page.getContent().stream().map(this::toRoomResponse).collect(Collectors.toList()))
                    .page(page.getNumber())
                    .size(page.getSize())
                    .totalElements(page.getTotalElements())
                    .totalPages(page.getTotalPages())
                    .last(page.isLast())
                    .build();
        }

        Page<Room> page = roomRepository.findAll(pageable);
        return PageResponse.<RoomResponse>builder()
                .content(page.getContent().stream().map(this::toRoomResponse).collect(Collectors.toList()))
                .page(page.getNumber())
                .size(page.getSize())
                .totalElements(page.getTotalElements())
                .totalPages(page.getTotalPages())
                .last(page.isLast())
                .build();
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
        if (comfortScoreService != null) {
            comfortScoreService.invalidateRoomTypeCache(id);
        }
        if (latestTelemetryCache != null) {
            latestTelemetryCache.removeRoomTelemetry(id);
        }
        if (alertRuleEngine != null) {
            alertRuleEngine.invalidateRoomCache(id);
            if (updated.getType() != RoomType.BOOK_STORAGE) {
                alertRuleEngine.onRoomTypeChanged(id, updated.getType());
            }
        }
        log.info("Room updated: '{}' (code={})", updated.getName(), updated.getCode());
        return toRoomResponse(updated);
    }

    @PreAuthorize("hasAnyAuthority('ADMIN', 'LIBRARIAN')")
    public RoomResponse updateThresholds(String id, RoomThresholdUpdateRequest request) {
        if (request == null) {
            throw new AppException(ErrorCode.INVALID_REQUEST_PAYLOAD);
        }
        Room room = findRoomById(id);
        RoomType rType = room.getType() != null ? room.getType() : RoomType.STUDY_ROOM;
        RoomThresholdConfig base = room.getThresholds() != null
                ? room.getThresholds().mergeWithDefaults(rType)
                : RoomThresholdConfig.defaultFor(rType);

        RoomThresholdConfig merged = RoomThresholdConfig.builder()
                .noiseAvgMax(request.getNoiseAvgMax() != null ? request.getNoiseAvgMax() : base.getNoiseAvgMax())
                .noisePeakMax(request.getNoisePeakMax() != null ? request.getNoisePeakMax() : base.getNoisePeakMax())
                .noisePeakImmediate(request.getNoisePeakImmediate() != null ? request.getNoisePeakImmediate() : base.getNoisePeakImmediate())
                .tempMin(request.getTempMin() != null ? request.getTempMin() : base.getTempMin())
                .tempMax(request.getTempMax() != null ? request.getTempMax() : base.getTempMax())
                .humidityMin(request.getHumidityMin() != null ? request.getHumidityMin() : base.getHumidityMin())
                .humidityMax(request.getHumidityMax() != null ? request.getHumidityMax() : base.getHumidityMax())
                .pm25Max(request.getPm25Max() != null ? request.getPm25Max() : base.getPm25Max())
                .build();

        if (merged.getTempMin() != null && merged.getTempMax() != null && merged.getTempMin() >= merged.getTempMax()) {
            throw new AppException(ErrorCode.INVALID_PARAMETER);
        }
        if (merged.getHumidityMin() != null && merged.getHumidityMax() != null && merged.getHumidityMin() >= merged.getHumidityMax()) {
            throw new AppException(ErrorCode.INVALID_PARAMETER);
        }
        if (merged.getNoiseAvgMax() != null && merged.getNoisePeakMax() != null && merged.getNoiseAvgMax() >= merged.getNoisePeakMax()) {
            throw new AppException(ErrorCode.INVALID_PARAMETER);
        }
        if (merged.getNoisePeakMax() != null && merged.getNoisePeakImmediate() != null && merged.getNoisePeakMax() > merged.getNoisePeakImmediate()) {
            throw new AppException(ErrorCode.INVALID_PARAMETER);
        }

        room.setThresholds(merged);
        Room updated = roomRepository.save(room);
        if (alertRuleEngine != null) {
            alertRuleEngine.invalidateRoomCache(id);
        }
        log.info("Room thresholds updated: '{}' (code={})", updated.getName(), updated.getCode());
        return toRoomResponse(updated);
    }

    @PreAuthorize("hasAuthority('ADMIN')")
    public void delete(String id) {
        if (!roomRepository.existsById(id)) {
            throw new AppException(ErrorCode.ROOM_NOT_EXISTED);
        }
        if (!deviceRepository.findByRoomId(id).isEmpty()) {
            throw new AppException(ErrorCode.ROOM_HAS_DEVICES);
        }
        roomRepository.deleteById(id);
        if (roomFurnitureLayoutRepository != null) {
            roomFurnitureLayoutRepository.findByRoomId(id).ifPresent(roomFurnitureLayoutRepository::delete);
        }
        if (comfortScoreService != null) {
            comfortScoreService.invalidateRoomTypeCache(id);
        }
        if (latestTelemetryCache != null) {
            latestTelemetryCache.removeRoomTelemetry(id);
        }
        log.warn("Room deleted: (id={})", id);
    }

    @PreAuthorize("hasAuthority('ADMIN')")
    public void deleteRoom(String id) {
        delete(id);
    }

    public RoomFurnitureResponse getFurnitureLayout(String roomId, boolean includeSensitive) {
        findRoomById(roomId);
        if (roomFurnitureLayoutRepository == null) {
            return RoomFurnitureResponse.builder()
                    .roomId(roomId)
                    .version(null)
                    .items(List.of())
                    .auditHistory(List.of())
                    .build();
        }
        return roomFurnitureLayoutRepository.findByRoomId(roomId)
                .map(layout -> toFurnitureResponse(layout, layout.getVersion(), includeSensitive))
                .orElseGet(() -> RoomFurnitureResponse.builder()
                        .roomId(roomId)
                        .version(null)
                        .items(List.of())
                        .auditHistory(List.of())
                        .build());
    }

    @PreAuthorize("hasAnyAuthority('ADMIN', 'LIBRARIAN', 'MAINTENANCE', 'MANAGE_ZONES')")
    public RoomFurnitureResponse updateFurnitureLayout(
            String roomId,
            RoomFurnitureUpdateRequest request,
            String operatorUsername) {
        if (request == null || request.getItems() == null) {
            throw new AppException(ErrorCode.INVALID_REQUEST_PAYLOAD);
        }
        Room room = findRoomById(roomId);
        List<FurnitureItemDoc> sanitizedItems = sanitizeAndValidateFurnitureItems(room, request.getItems());

        RoomFurnitureLayout existing = roomFurnitureLayoutRepository != null
                ? roomFurnitureLayoutRepository.findByRoomId(roomId).orElse(null)
                : null;

        Long requestedExpectedVersion = request.getExpectedVersion();
        Long previousVersionObj = existing != null ? existing.getVersion() : null;
        boolean isUpdate = existing != null;

        if (isUpdate) {
            if (!Objects.equals(requestedExpectedVersion, previousVersionObj)) {
                throw new AppException(ErrorCode.FURNITURE_VERSION_CONFLICT);
            }
        } else if (requestedExpectedVersion != null && requestedExpectedVersion != 0L) {
            throw new AppException(ErrorCode.FURNITURE_VERSION_CONFLICT);
        }

        Instant now = Instant.now();
        String actor = (operatorUsername != null && !operatorUsername.isBlank())
                ? operatorUsername.trim()
                : "system";
        Long nextAuditVersion = isUpdate
                ? ((previousVersionObj != null ? previousVersionObj : 0L) + 1L)
                : 0L;

        String summary = (request.getChangeNote() != null && !request.getChangeNote().isBlank())
                ? request.getChangeNote().trim()
                : String.format("Cập nhật bố cục nội thất (%d đối tượng)", sanitizedItems.size());

        RoomFurnitureLayout target = isUpdate
                ? existing
                : RoomFurnitureLayout.builder()
                        .roomId(roomId)
                        .items(new ArrayList<>())
                        .auditHistory(new ArrayList<>())
                        .build();

        target.setItems(new ArrayList<>(sanitizedItems));
        target.setUpdatedBy(actor);
        target.setUpdatedAt(now);

        List<FurnitureAuditEntry> history = target.getAuditHistory() != null
                ? new ArrayList<>(target.getAuditHistory())
                : new ArrayList<>();
        history.add(FurnitureAuditEntry.builder()
                .timestamp(now)
                .username(actor)
                .actionSummary(summary)
                .version(nextAuditVersion)
                .build());
        if (history.size() > 50) {
            history = new ArrayList<>(history.subList(history.size() - 50, history.size()));
        }
        target.setAuditHistory(history);

        if (roomFurnitureLayoutRepository == null) {
            return toFurnitureResponse(target, nextAuditVersion, true);
        }

        try {
            RoomFurnitureLayout saved = roomFurnitureLayoutRepository.save(target);
            RoomFurnitureLayout effective = saved != null ? saved : target;
            Long resolvedVersion;
            if (isUpdate) {
                resolvedVersion = (effective.getVersion() != null && !Objects.equals(effective.getVersion(), previousVersionObj))
                        ? effective.getVersion()
                        : nextAuditVersion;
            } else {
                resolvedVersion = effective.getVersion() != null ? effective.getVersion() : 0L;
            }
            if (!effective.getAuditHistory().isEmpty()) {
                FurnitureAuditEntry lastEntry = effective.getAuditHistory().get(effective.getAuditHistory().size() - 1);
                lastEntry.setVersion(resolvedVersion);
            }
            log.info("Furniture layout updated for room '{}' ({}): version={}, items={}, by={}",
                    room.getCode(), roomId, resolvedVersion, sanitizedItems.size(), actor);
            return toFurnitureResponse(effective, resolvedVersion, true);
        } catch (OptimisticLockingFailureException | DuplicateKeyException ex) {
            throw new AppException(ErrorCode.FURNITURE_VERSION_CONFLICT);
        }
    }

    private List<FurnitureItemDoc> sanitizeAndValidateFurnitureItems(Room room, List<FurnitureItemDoc> rawItems) {
        List<Point2D> structuralColumns = TqbPresetColumnsRegistry.getColumnsForRoomCode(room.getCode());
        List<FurnitureItemDoc> normalized = new ArrayList<>(rawItems.size());
        for (FurnitureItemDoc raw : rawItems) {
            if (raw == null || raw.getId() == null || raw.getId().isBlank()
                    || raw.getTypeId() == null || raw.getTypeId().isBlank()
                    || raw.getX() == null || raw.getY() == null
                    || raw.getWidthM() == null || raw.getDepthM() == null
                    || !Double.isFinite(raw.getX()) || !Double.isFinite(raw.getY())
                    || !Double.isFinite(raw.getWidthM()) || !Double.isFinite(raw.getDepthM())
                    || raw.getWidthM() < 0.1 || raw.getDepthM() < 0.1) {
                throw new AppException(ErrorCode.INVALID_REQUEST_PAYLOAD);
            }
            double rot = (raw.getRotationDeg() != null && Double.isFinite(raw.getRotationDeg()))
                    ? raw.getRotationDeg()
                    : 0.0;
            FurnitureItemDoc item = FurnitureItemDoc.builder()
                    .id(raw.getId().trim())
                    .typeId(raw.getTypeId().trim().toUpperCase())
                    .label(raw.getLabel() != null ? raw.getLabel().trim() : "")
                    .x(raw.getX())
                    .y(raw.getY())
                    .widthM(raw.getWidthM())
                    .depthM(raw.getDepthM())
                    .rotationDeg(rot)
                    .locked(Boolean.TRUE.equals(raw.getLocked()))
                    .build();

            if (!FurnitureGeometryValidator.isFurnitureInsideRoom(item, room.getBoundaryPolygon())) {
                throw new AppException(ErrorCode.FURNITURE_OUT_OF_BOUNDS);
            }
            if (FurnitureGeometryValidator.doesFurnitureOverlapColumn(
                    item, structuralColumns, FurnitureGeometryValidator.STRUCTURAL_COLUMN_SIZE_M)) {
                throw new AppException(ErrorCode.FURNITURE_OUT_OF_BOUNDS);
            }
            normalized.add(item);
        }

        for (int i = 0; i < normalized.size(); i++) {
            for (int j = i + 1; j < normalized.size(); j++) {
                if (FurnitureGeometryValidator.doFurnitureItemsOverlap(normalized.get(i), normalized.get(j))) {
                    throw new AppException(ErrorCode.FURNITURE_OUT_OF_BOUNDS);
                }
            }
        }
        return normalized;
    }

    private RoomFurnitureResponse toFurnitureResponse(
            RoomFurnitureLayout layout,
            Long resolvedVersion,
            boolean includeSensitive) {
        List<FurnitureItemDoc> rawItems = layout.getItems() != null ? layout.getItems() : List.of();
        List<FurnitureItemDoc> visibleItems = includeSensitive
                ? new ArrayList<>(rawItems)
                : rawItems.stream()
                        .filter(it -> !"IOT_NODE".equalsIgnoreCase(it.getTypeId()))
                        .collect(Collectors.toList());

        List<FurnitureAuditEntry> history = includeSensitive && layout.getAuditHistory() != null
                ? new ArrayList<>(layout.getAuditHistory())
                : List.of();

        return RoomFurnitureResponse.builder()
                .roomId(layout.getRoomId())
                .version(resolvedVersion)
                .items(visibleItems)
                .updatedBy(includeSensitive ? layout.getUpdatedBy() : null)
                .updatedAt(layout.getUpdatedAt())
                .auditHistory(history)
                .build();
    }

    private Room findRoomById(String id) {
        return roomRepository.findById(id)
                .orElseThrow(() -> new AppException(ErrorCode.ROOM_NOT_EXISTED));
    }

    private RoomResponse toRoomResponse(Room room) {
        RoomType rType = room.getType() != null ? room.getType() : RoomType.STUDY_ROOM;
        RoomThresholdConfig cfg = room.getThresholds() != null
                ? room.getThresholds().mergeWithDefaults(rType)
                : RoomThresholdConfig.defaultFor(rType);
        return RoomResponse.builder()
                .id(room.getId())
                .code(room.getCode())
                .name(room.getName())
                .floor(room.getFloor())
                .capacity(room.getCapacity())
                .description(room.getDescription())
                .targetComfortScore(room.getTargetComfortScore())
                .boundaryPolygon(room.getBoundaryPolygon())
                .type(rType)
                .thresholds(cfg)
                .createdAt(room.getCreatedAt())
                .updatedAt(room.getUpdatedAt())
                .build();
    }
}
