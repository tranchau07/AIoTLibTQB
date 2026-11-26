package com.example.AIoTLibTQB.service;

import com.example.AIoTLibTQB.controller.PublicController;
import com.example.AIoTLibTQB.controller.RoomController;
import com.example.AIoTLibTQB.document.FurnitureAuditEntry;
import com.example.AIoTLibTQB.document.FurnitureItemDoc;
import com.example.AIoTLibTQB.document.Point2D;
import com.example.AIoTLibTQB.document.Room;
import com.example.AIoTLibTQB.document.RoomFurnitureLayout;
import com.example.AIoTLibTQB.dto.request.RoomFurnitureUpdateRequest;
import com.example.AIoTLibTQB.dto.response.ApiResponse;
import com.example.AIoTLibTQB.dto.response.RoomFurnitureResponse;
import com.example.AIoTLibTQB.enums.ErrorCode;
import com.example.AIoTLibTQB.enums.RoomType;
import com.example.AIoTLibTQB.exception.AppException;
import com.example.AIoTLibTQB.repository.DeviceRepository;
import com.example.AIoTLibTQB.repository.RoomFurnitureLayoutRepository;
import com.example.AIoTLibTQB.repository.RoomRepository;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.dao.OptimisticLockingFailureException;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.annotation.PutMapping;

import java.lang.reflect.Method;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class RoomFurnitureTest {

    @Mock
    RoomRepository roomRepository;

    @Mock
    DeviceRepository deviceRepository;

    @Mock
    RoomFurnitureLayoutRepository roomFurnitureLayoutRepository;

    @Mock
    TelemetryService telemetryService;

    @InjectMocks
    RoomService roomService;

    @AfterEach
    void tearDown() {
        SecurityContextHolder.clearContext();
    }

    private Room buildNormalizedRoom(String id) {
        return Room.builder()
                .id(id)
                .code("TQB_301")
                .name("Phòng Multimedia 301")
                .floor(3)
                .type(RoomType.STUDY_ROOM)
                .boundaryPolygon(List.of(
                        new Point2D(0.10, 0.10),
                        new Point2D(0.45, 0.10),
                        new Point2D(0.45, 0.45),
                        new Point2D(0.10, 0.45)
                ))
                .build();
    }

    private FurnitureItemDoc desk(String id, double x, double y, double rot) {
        return FurnitureItemDoc.builder()
                .id(id)
                .typeId("DESK")
                .label("Bàn đọc " + id)
                .x(x)
                .y(y)
                .widthM(2.4)
                .depthM(1.2)
                .rotationDeg(rot)
                .locked(false)
                .build();
    }

    @Test
    @DisplayName("TC-G8-10 (BE): Lưu bố cục nội thất vào room_furniture_layouts kèm tăng @Version và ghi auditHistory")
    void updateFurnitureLayout_incrementsVersionAndAppendsAuditEntry() {
        Room room = buildNormalizedRoom("room-301");
        when(roomRepository.findById("room-301")).thenReturn(Optional.of(room));

        RoomFurnitureLayout existing = RoomFurnitureLayout.builder()
                .id("layout-301")
                .roomId("room-301")
                .version(1L)
                .items(List.of())
                .auditHistory(new ArrayList<>(List.of(
                        FurnitureAuditEntry.builder()
                                .timestamp(Instant.parse("2026-11-18T08:00:00Z"))
                                .username("admin")
                                .actionSummary("Khởi tạo mặt bằng")
                                .version(1L)
                                .build()
                )))
                .build();
        when(roomFurnitureLayoutRepository.findByRoomId("room-301")).thenReturn(Optional.of(existing));
        when(roomFurnitureLayoutRepository.save(any(RoomFurnitureLayout.class))).thenAnswer(inv -> {
            RoomFurnitureLayout arg = inv.getArgument(0);
            arg.setVersion(arg.getVersion() == null ? 0L : arg.getVersion() + 1L);
            return arg;
        });

        List<FurnitureItemDoc> fourDesks = List.of(
                desk("d1", 0.16, 0.16, 0.0),
                desk("d2", 0.24, 0.16, 0.0),
                desk("d3", 0.16, 0.25, 0.0),
                desk("d4", 0.24, 0.25, 0.0)
        );
        RoomFurnitureUpdateRequest req = RoomFurnitureUpdateRequest.builder()
                .expectedVersion(1L)
                .items(fourDesks)
                .changeNote("Bố trí 4 bàn đọc Multimedia")
                .build();

        RoomFurnitureResponse resp = roomService.updateFurnitureLayout("room-301", req, "ktv.minh");

        assertThat(resp.getRoomId()).isEqualTo("room-301");
        assertThat(resp.getVersion()).isEqualTo(2L);
        assertThat(resp.getItems()).hasSize(4);
        assertThat(resp.getUpdatedBy()).isEqualTo("ktv.minh");
        assertThat(resp.getAuditHistory()).hasSize(2);
        FurnitureAuditEntry latestAudit = resp.getAuditHistory().get(1);
        assertThat(latestAudit.getUsername()).isEqualTo("ktv.minh");
        assertThat(latestAudit.getVersion()).isEqualTo(2L);
        assertThat(latestAudit.getTimestamp()).isNotNull();
        verify(roomFurnitureLayoutRepository).save(any(RoomFurnitureLayout.class));
    }

    @Test
    @DisplayName("TC-G8-11 (BE): Chặn ghi đè xung đột phiên bản (Optimistic Locking 409 Conflict / code 5007)")
    void updateFurnitureLayout_versionMismatch_throws409Conflict() {
        Room room = buildNormalizedRoom("room-301");
        when(roomRepository.findById("room-301")).thenReturn(Optional.of(room));

        RoomFurnitureLayout existing = RoomFurnitureLayout.builder()
                .id("layout-301")
                .roomId("room-301")
                .version(3L)
                .items(List.of(desk("d1", 0.20, 0.20, 0.0)))
                .auditHistory(new ArrayList<>())
                .build();
        when(roomFurnitureLayoutRepository.findByRoomId("room-301")).thenReturn(Optional.of(existing));

        RoomFurnitureUpdateRequest staleReq = RoomFurnitureUpdateRequest.builder()
                .expectedVersion(2L)
                .items(List.of(desk("d2", 0.30, 0.30, 0.0)))
                .build();

        assertThatThrownBy(() -> roomService.updateFurnitureLayout("room-301", staleReq, "lib.lan"))
                .isInstanceOf(AppException.class)
                .extracting(e -> ((AppException) e).getErrorCode())
                .satisfies(ec -> {
                    assertThat(ec).isEqualTo(ErrorCode.FURNITURE_VERSION_CONFLICT);
                    assertThat(ec.getCode()).isEqualTo(5007);
                    assertThat(ec.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
                });

        verify(roomFurnitureLayoutRepository, never()).save(any());

        // Race-condition during Mongo save throws OptimisticLockingFailureException -> translated to 5007
        RoomFurnitureUpdateRequest concurrentReq = RoomFurnitureUpdateRequest.builder()
                .expectedVersion(3L)
                .items(List.of(desk("d2", 0.30, 0.30, 0.0)))
                .build();
        when(roomFurnitureLayoutRepository.save(any())).thenThrow(new OptimisticLockingFailureException("stale @Version"));

        assertThatThrownBy(() -> roomService.updateFurnitureLayout("room-301", concurrentReq, "lib.lan"))
                .isInstanceOf(AppException.class)
                .extracting(e -> ((AppException) e).getErrorCode())
                .isEqualTo(ErrorCode.FURNITURE_VERSION_CONFLICT);
    }

    @Test
    @DisplayName("Kiểm tra ranh giới phòng lõm và chồng lấn SAT phía Backend (ErrorCode 5008)")
    void updateFurnitureLayout_rejectsOutOfBoundsConcaveAndSatOverlap() {
        // Concave L-shape polygon (notch around elevator core at x: 0.25..0.45, y: 0.10..0.25)
        Room lRoom = Room.builder()
                .id("room-201")
                .code("TQB_201")
                .name("Phòng Đọc 201")
                .floor(2)
                .boundaryPolygon(List.of(
                        new Point2D(0.10, 0.10),
                        new Point2D(0.25, 0.10),
                        new Point2D(0.25, 0.25),
                        new Point2D(0.45, 0.25),
                        new Point2D(0.45, 0.45),
                        new Point2D(0.10, 0.45)
                ))
                .build();
        when(roomRepository.findById("room-201")).thenReturn(Optional.of(lRoom));

        // Desk placed inside cutout core (0.35, 0.16)
        RoomFurnitureUpdateRequest outReq = RoomFurnitureUpdateRequest.builder()
                .items(List.of(desk("d-core", 0.35, 0.16, 0.0)))
                .build();
        assertThatThrownBy(() -> roomService.updateFurnitureLayout("room-201", outReq, "ktv.minh"))
                .isInstanceOf(AppException.class)
                .extracting(e -> ((AppException) e).getErrorCode())
                .satisfies(ec -> {
                    assertThat(ec).isEqualTo(ErrorCode.FURNITURE_OUT_OF_BOUNDS);
                    assertThat(ec.getCode()).isEqualTo(5008);
                });

        // Two overlapping rotated desks inside valid zone
        RoomFurnitureUpdateRequest overlapReq = RoomFurnitureUpdateRequest.builder()
                .items(List.of(
                        desk("a", 0.20, 0.35, 45.0),
                        desk("b", 0.21, 0.355, 0.0)
                ))
                .build();
        assertThatThrownBy(() -> roomService.updateFurnitureLayout("room-201", overlapReq, "ktv.minh"))
                .isInstanceOf(AppException.class)
                .extracting(e -> ((AppException) e).getErrorCode())
                .isEqualTo(ErrorCode.FURNITURE_OUT_OF_BOUNDS);
    }

    @Test
    @DisplayName("RBAC & Ẩn danh FE-VIZ-09: Controller & PublicController ẩn IOT_NODE và auditHistory khỏi USER/VIEWER/Kiosk")
    void rbacAndAnonymization_stripsIotNodeAndAuditHistoryForReaders() throws NoSuchMethodException {
        Room room = buildNormalizedRoom("room-301");
        RoomFurnitureLayout layout = RoomFurnitureLayout.builder()
                .id("l-1")
                .roomId("room-301")
                .version(2L)
                .updatedBy("ktv.minh")
                .items(List.of(
                        desk("desk-1", 0.22, 0.22, 0.0),
                        FurnitureItemDoc.builder()
                                .id("node-1")
                                .typeId("IOT_NODE")
                                .label("ESP32_301_A")
                                .x(0.28)
                                .y(0.22)
                                .widthM(0.5)
                                .depthM(0.5)
                                .rotationDeg(0.0)
                                .locked(true)
                                .build()
                ))
                .auditHistory(List.of(
                        FurnitureAuditEntry.builder()
                                .username("ktv.minh")
                                .version(2L)
                                .actionSummary("Gắn sensor")
                                .timestamp(Instant.now())
                                .build()
                ))
                .build();

        when(roomRepository.findById("room-301")).thenReturn(Optional.of(room));
        when(roomFurnitureLayoutRepository.findByRoomId("room-301")).thenReturn(Optional.of(layout));

        RoomController roomController = new RoomController(roomService);
        PublicController publicController = new PublicController(roomRepository, telemetryService, roomFurnitureLayoutRepository);

        // 1. Reader role USER -> hides IOT_NODE & auditHistory
        SecurityContextHolder.getContext().setAuthentication(
                new UsernamePasswordAuthenticationToken("student01", "n/a", List.of(new SimpleGrantedAuthority("USER")))
        );
        ApiResponse<RoomFurnitureResponse> readerResp = roomController.getFurniture("room-301");
        assertThat(readerResp.getResult().getItems()).extracting(FurnitureItemDoc::getTypeId)
                .containsExactly("DESK");
        assertThat(readerResp.getResult().getAuditHistory()).isEmpty();
        assertThat(readerResp.getResult().getUpdatedBy()).isNull();

        // 2. Maintenance role -> sees full IOT_NODE & auditHistory
        SecurityContextHolder.getContext().setAuthentication(
                new UsernamePasswordAuthenticationToken("ktv.minh", "n/a", List.of(new SimpleGrantedAuthority("MAINTENANCE")))
        );
        ApiResponse<RoomFurnitureResponse> maintResp = roomController.getFurniture("room-301");
        assertThat(maintResp.getResult().getItems()).hasSize(2);
        assertThat(maintResp.getResult().getAuditHistory()).hasSize(1);
        assertThat(maintResp.getResult().getUpdatedBy()).isEqualTo("ktv.minh");

        // 3. Anonymous public kiosk endpoint -> hides IOT_NODE & auditHistory
        SecurityContextHolder.clearContext();
        ApiResponse<RoomFurnitureResponse> kioskResp = publicController.getPublicRoomFurniture("room-301");
        assertThat(kioskResp.getResult().getItems()).extracting(FurnitureItemDoc::getTypeId)
                .containsExactly("DESK");
        assertThat(kioskResp.getResult().getAuditHistory()).isEmpty();

        // 4. PUT /api/v1/rooms/{id}/furniture security annotation excludes VIEWER & ZONE_MANAGER
        Method putMethod = RoomController.class.getMethod("updateFurniture", String.class, RoomFurnitureUpdateRequest.class);
        PutMapping putMapping = putMethod.getAnnotation(PutMapping.class);
        PreAuthorize preAuth = putMethod.getAnnotation(PreAuthorize.class);
        assertThat(putMapping).isNotNull();
        assertThat(putMapping.value()).containsExactly("/{id}/furniture");
        assertThat(preAuth).isNotNull();
        assertThat(preAuth.value()).isEqualTo("hasAnyAuthority('ADMIN', 'LIBRARIAN', 'MAINTENANCE', 'MANAGE_ZONES')");
    }

    @Test
    @DisplayName("Phase 3 (BE): Chặn đặt bàn/giá sách đè lên cột chịu lực BTCT (0.60x0.60m) trong TQB_301 (ErrorCode 5008)")
    void updateFurnitureLayout_rejectsStructuralColumnOverlap() {
        Room room301RealBounds = Room.builder()
                .id("room-301")
                .code("TQB_301")
                .name("Phòng Multimedia 301")
                .floor(3)
                .type(RoomType.STUDY_ROOM)
                .boundaryPolygon(List.of(
                        new Point2D(0.301, 0.008),
                        new Point2D(0.699, 0.008),
                        new Point2D(0.699, 0.32),
                        new Point2D(0.301, 0.32)
                ))
                .build();
        when(roomRepository.findById("room-301")).thenReturn(Optional.of(room301RealBounds));

        // Cột BTCT ở (0.399, 0.032) của TQB_301 -> đặt bàn đè trúng tâm cột phải ném 5008 FURNITURE_OUT_OF_BOUNDS
        RoomFurnitureUpdateRequest overlapColReq = RoomFurnitureUpdateRequest.builder()
                .items(List.of(desk("desk-on-col", 0.399, 0.035, 0.0)))
                .build();

        assertThatThrownBy(() -> roomService.updateFurnitureLayout("room-301", overlapColReq, "admin"))
                .isInstanceOf(AppException.class)
                .extracting(e -> ((AppException) e).getErrorCode())
                .satisfies(ec -> {
                    assertThat(ec).isEqualTo(ErrorCode.FURNITURE_OUT_OF_BOUNDS);
                    assertThat(ec.getCode()).isEqualTo(5008);
                });

        // Kiểm tra hàm validator trực tiếp: IOT_NODE gắn trên cột không bị coi là va chạm lối đi
        FurnitureItemDoc sensorOnCol = FurnitureItemDoc.builder()
                .id("sensor-col")
                .typeId("IOT_NODE")
                .x(0.399)
                .y(0.032)
                .widthM(0.5)
                .depthM(0.5)
                .rotationDeg(0.0)
                .build();
        assertThat(FurnitureGeometryValidator.doesFurnitureOverlapColumn(
                sensorOnCol, TqbPresetColumnsRegistry.getColumnsForRoomCode("TQB_301"))).isFalse();
    }
}
