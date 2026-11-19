package com.example.AIoTLibTQB.service;

import com.example.AIoTLibTQB.document.ComfortScoreRecord;
import com.example.AIoTLibTQB.document.EnvironmentMetrics;
import com.example.AIoTLibTQB.dto.response.TelemetryResponse;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Instant;
import java.util.HashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class TelemetryConflationServiceTest {

    @Mock
    RealtimePublisher realtimePublisher;

    LatestTelemetryCacheImpl latestTelemetryCache;
    TelemetryConflationService conflationService;

    @BeforeEach
    void setUp() {
        latestTelemetryCache = new LatestTelemetryCacheImpl();
        conflationService = new TelemetryConflationService(latestTelemetryCache, realtimePublisher);
    }

    private TelemetryResponse buildTelemetry(String id, Instant ts, double temp, double comfort) {
        return TelemetryResponse.builder()
                .id(id)
                .timestamp(ts)
                .environment(EnvironmentMetrics.builder().temperature(temp).humidity(52.0).lux(400.0).build())
                .comfortScore(ComfortScoreRecord.builder().overall(comfort).grade("A").build())
                .wifiRssi(-56)
                .build();
    }

    @Test
    @DisplayName("Burst scenario: gộp nhiều gói tin liên tiếp thành 1 bản tin STOMP mới nhất và không phát trùng signature")
    void conflateAndPublish_burstDeduplicatesAndPublishesLatestOnly() {
        Instant t1 = Instant.parse("2026-11-18T10:00:00Z");
        Instant t2 = Instant.parse("2026-11-18T10:00:01Z");

        // Simulator bơm 5 gói liên tiếp cho cùng phòng trước chu kỳ phát 1Hz
        for (int i = 0; i < 4; i++) {
            latestTelemetryCache.putRoomTelemetry("room-301", buildTelemetry("tel-" + i, t1, 22.0 + i, 88.0 - i));
        }
        TelemetryResponse newestInBurst = buildTelemetry("tel-final", t2, 24.8, 82.0);
        latestTelemetryCache.putRoomTelemetry("room-301", newestInBurst);

        // Tick 1: Chỉ phát đúng 1 bản tin cuối cùng trong burst
        conflationService.conflateAndPublish();
        verify(realtimePublisher, times(1)).publishRoomTelemetry("room-301", newestInBurst);

        // Tick 2 & 3 khi chưa có dữ liệu mới -> Không phát dư thừa
        conflationService.conflateAndPublish();
        conflationService.conflateAndPublish();
        verifyNoMoreInteractions(realtimePublisher);

        // Gói mới ở giây kế tiếp -> Phát tiếp 1 lần
        Instant t3 = Instant.parse("2026-11-18T10:00:02Z");
        TelemetryResponse nextTickTelemetry = buildTelemetry("tel-next", t3, 25.1, 80.5);
        latestTelemetryCache.putRoomTelemetry("room-301", nextTickTelemetry);

        conflationService.conflateAndPublish();
        verify(realtimePublisher, times(1)).publishRoomTelemetry("room-301", nextTickTelemetry);
    }

    @Test
    @DisplayName("Scale 33 phòng: mỗi tick phát đều 1 bản tin conflated cho toàn bộ 33 phòng đang hoạt động")
    void conflateAndPublish_thirtyThreeRoomsFanout() {
        Instant ts = Instant.parse("2026-11-18T10:05:00Z");
        for (int i = 1; i <= 33; i++) {
            String roomId = "TQB_R_" + i;
            latestTelemetryCache.putRoomTelemetry(roomId, buildTelemetry("t-" + i, ts, 23.0, 86.0));
        }

        conflationService.conflateAndPublish();
        verify(realtimePublisher, times(33)).publishRoomTelemetry(anyString(), any(TelemetryResponse.class));

        // Gọi lại ngay không đổi signature -> 0 bản tin dư
        conflationService.conflateAndPublish();
        verifyNoMoreInteractions(realtimePublisher);
    }

    @Test
    @DisplayName("Lỗi phát một phòng không làm gián đoạn các phòng khác và giữ nguyên trạng thái retry ở tick sau")
    void conflateAndPublish_exceptionIsolationAndRetry() {
        Instant ts = Instant.parse("2026-11-18T10:10:00Z");
        TelemetryResponse r1 = buildTelemetry("t-r1", ts, 23.0, 88.0);
        TelemetryResponse r2 = buildTelemetry("t-r2", ts, 26.5, 72.0);
        latestTelemetryCache.putRoomTelemetry("room-fail", r1);
        latestTelemetryCache.putRoomTelemetry("room-ok", r2);

        doAnswer(invocation -> {
            String rid = invocation.getArgument(0);
            if ("room-fail".equals(rid) && mockingDetails(realtimePublisher).getInvocations().stream()
                    .filter(inv -> "room-fail".equals(inv.getArgument(0))).count() <= 1) {
                throw new RuntimeException("Transient STOMP channel error");
            }
            return null;
        }).when(realtimePublisher).publishRoomTelemetry(anyString(), any(TelemetryResponse.class));

        assertThatCode(() -> conflationService.conflateAndPublish()).doesNotThrowAnyException();

        // Phòng còn lại vẫn nhận bản tin ngay ở tick đầu tiên
        verify(realtimePublisher, times(1)).publishRoomTelemetry("room-ok", r2);

        // Tick kế tiếp -> room-fail chưa lưu signature nên được retry thành công, room-ok không gửi trùng
        conflationService.conflateAndPublish();

        verify(realtimePublisher, times(2)).publishRoomTelemetry("room-fail", r1);
        verify(realtimePublisher, times(1)).publishRoomTelemetry("room-ok", r2);
    }

    @Test
    @DisplayName("An toàn khi cache rỗng hoặc null và clearSignatures cho phép phát lại")
    void conflateAndPublish_emptyCacheAndClearSignatures() {
        conflationService.conflateAndPublish();
        verifyNoInteractions(realtimePublisher);

        // Cache mock trả về bản ghi có value null không NPE
        LatestTelemetryCache customCache = mock(LatestTelemetryCache.class);
        Map<String, TelemetryResponse> edgeMap = new HashMap<>();
        edgeMap.put("room-null", null);
        when(customCache.getAllRoomLatest()).thenReturn(edgeMap);
        TelemetryConflationService edgeService = new TelemetryConflationService(customCache, realtimePublisher);
        assertThatCode(edgeService::conflateAndPublish).doesNotThrowAnyException();
        verifyNoInteractions(realtimePublisher);

        // clearSignatures() đặt lại dấu vết cho phép phát lại ngay
        Instant ts = Instant.parse("2026-11-18T10:15:00Z");
        TelemetryResponse t = buildTelemetry("t-reset", ts, 22.8, 89.0);
        latestTelemetryCache.putRoomTelemetry("room-301", t);

        conflationService.conflateAndPublish();
        conflationService.clearSignatures();
        conflationService.conflateAndPublish();

        verify(realtimePublisher, times(2)).publishRoomTelemetry(eq("room-301"), eq(t));
    }
}
