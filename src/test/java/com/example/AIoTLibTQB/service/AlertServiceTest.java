package com.example.AIoTLibTQB.service;

import com.example.AIoTLibTQB.configuration.AlertSopCatalog;
import com.example.AIoTLibTQB.document.Alert;
import com.example.AIoTLibTQB.document.Device;
import com.example.AIoTLibTQB.document.Role;
import com.example.AIoTLibTQB.document.Room;
import com.example.AIoTLibTQB.document.RoomThresholdConfig;
import com.example.AIoTLibTQB.document.User;
import com.example.AIoTLibTQB.dto.mqtt.TelemetryPayload;
import com.example.AIoTLibTQB.dto.request.AlertWorkflowUpdateRequest;
import com.example.AIoTLibTQB.dto.response.AlertResponse;
import com.example.AIoTLibTQB.dto.response.PageResponse;
import com.example.AIoTLibTQB.enums.AlertSeverity;
import com.example.AIoTLibTQB.enums.AlertStatus;
import com.example.AIoTLibTQB.enums.AlertType;
import com.example.AIoTLibTQB.enums.AlertWorkflowStatus;
import com.example.AIoTLibTQB.enums.ErrorCode;
import com.example.AIoTLibTQB.enums.RoomType;
import com.example.AIoTLibTQB.exception.AppException;
import com.example.AIoTLibTQB.repository.AlertRepository;
import com.example.AIoTLibTQB.repository.DeviceRepository;
import com.example.AIoTLibTQB.repository.RoomRepository;
import com.example.AIoTLibTQB.repository.UserRepository;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.MockedStatic;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.dao.OptimisticLockingFailureException;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.mongodb.core.query.Update;
import org.springframework.http.HttpStatus;
import org.springframework.mail.SimpleMailMessage;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContext;
import org.springframework.security.core.context.SecurityContextHolder;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class AlertServiceTest {

    @Mock
    AlertRepository alertRepository;

    @Mock
    RealtimePublisher realtimePublisher;

    @Mock
    MongoTemplate mongoTemplate;

    @Mock
    RoomRepository roomRepository;

    MutableClock mutableClock;
    AlertRuleEngine alertRuleEngine;
    AlertServiceImpl alertService;

    static class MutableClock extends Clock {
        private Instant instant;

        public MutableClock(Instant initial) {
            this.instant = initial;
        }

        public void advance(Duration duration) {
            this.instant = this.instant.plus(duration);
        }

        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return instant;
        }
    }

    @BeforeEach
    void setUp() {
        mutableClock = new MutableClock(Instant.parse("2026-10-22T10:00:00Z"));
        alertRuleEngine = new AlertRuleEngine(alertRepository, realtimePublisher, mutableClock, roomRepository);
        alertService = new AlertServiceImpl(alertRepository, realtimePublisher, alertRuleEngine, mongoTemplate, mutableClock);
    }

    private TelemetryPayload.TelemetryData createAcousticsData(Double noiseAvg, Double noisePeak) {
        return TelemetryPayload.TelemetryData.builder()
                .acoustics(TelemetryPayload.AcousticsData.builder()
                        .noiseAvg(noiseAvg)
                        .noisePeak(noisePeak)
                        .build())
                .build();
    }

    private TelemetryPayload.TelemetryData createEnvironmentData(Double temp) {
        return TelemetryPayload.TelemetryData.builder()
                .environment(TelemetryPayload.EnvironmentData.builder()
                        .temperature(temp)
                        .build())
                .build();
    }

    private TelemetryPayload.TelemetryData createAirQualityData(Double pm25) {
        return TelemetryPayload.TelemetryData.builder()
                .airQuality(TelemetryPayload.AirQualityData.builder()
                        .pm2_5(pm25)
                        .build())
                .build();
    }

    @Test
    @DisplayName("FSM: Vượt ngưỡng lần đầu -> Chuyển PENDING, KHÔNG ghi MongoDB, KHÔNG publish WebSocket")
    void evaluate_firstBreach_entersPendingWithoutDbOrWebSocket() {
        TelemetryPayload.TelemetryData data = createAcousticsData(70.0, null); // 70 > 65

        alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", data);

        assertThat(alertRuleEngine.getFsmMap()).containsKey("dev-1:NOISE_AVG");
        AlertRuleEngine.FsmState state = alertRuleEngine.getFsmMap().get("dev-1:NOISE_AVG");
        assertThat(state.getStatus()).isEqualTo(AlertStatus.PENDING);
        assertThat(state.getPendingSince()).isEqualTo(mutableClock.instant());

        // Tuyệt đối KHÔNG chạm DB hoặc WebSocket ở trạng thái PENDING
        verify(alertRepository, never()).save(any());
        verify(realtimePublisher, never()).publishAlert(any());
    }

    @Test
    @DisplayName("FSM: Vượt ngưỡng nhưng hạ xuống an toàn trước 30s -> Hủy PENDING, lọc báo động giả, KHÔNG ghi DB")
    void evaluate_pendingRecoversBefore30s_cancelsPendingWithoutDb() {
        TelemetryPayload.TelemetryData breachData = createAcousticsData(70.0, null);
        alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", breachData);
        assertThat(alertRuleEngine.getFsmMap()).containsKey("dev-1:NOISE_AVG");

        // Tiến thời gian 15s (chưa đủ 30s)
        mutableClock.advance(Duration.ofSeconds(15));
        TelemetryPayload.TelemetryData safeData = createAcousticsData(50.0, null);
        alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", safeData);

        // State bị xóa khỏi map (trở về bình thường)
        assertThat(alertRuleEngine.getFsmMap()).doesNotContainKey("dev-1:NOISE_AVG");

        verify(alertRepository, never()).save(any());
        verify(realtimePublisher, never()).publishAlert(any());
    }

    @Test
    @DisplayName("FSM: Độ ồn phòng đọc vượt ngưỡng liên tục -> 0..59s bật LED Tầng 1 (PENDING), đủ 60s chuyển FIRING")
    void evaluate_continuousBreach30s_transitionsToFiring() {
        when(alertRepository.save(any(Alert.class))).thenAnswer(invocation -> {
            Alert a = invocation.getArgument(0);
            a.setId("alert-001");
            return a;
        });

        // t = 0s: Vượt ngưỡng -> PENDING + bật LED WARN_PULSE
        alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", createAcousticsData(68.0, null));

        // t = 30s: Đang trong pha LED Tầng 1 (60s) -> Vẫn PENDING, chưa làm phiền thủ thư
        mutableClock.advance(Duration.ofSeconds(30));
        alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", createAcousticsData(69.0, null));
        verify(alertRepository, never()).save(any());

        // t = 60s: Đủ 60s liên tục sinh viên không giảm ồn -> Chuyển FIRING
        mutableClock.advance(Duration.ofSeconds(30));
        alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", createAcousticsData(71.0, null));

        ArgumentCaptor<Alert> alertCaptor = ArgumentCaptor.forClass(Alert.class);
        verify(alertRepository, times(1)).save(alertCaptor.capture());
        Alert saved = alertCaptor.getValue();
        assertThat(saved.getStatus()).isEqualTo(AlertStatus.FIRING);
        assertThat(saved.getType()).isEqualTo(AlertType.NOISE_EXCEEDED);
        assertThat(saved.getSeverity()).isEqualTo(AlertSeverity.MEDIUM);
        assertThat(saved.getDeviceId()).isEqualTo("dev-1");
        assertThat(saved.getRoomId()).isEqualTo("room-1");
        assertThat(saved.getCurrentValue()).isEqualTo(71.0);
        assertThat(saved.getThreshold()).isEqualTo(65.0);

        verify(realtimePublisher, times(1)).publishAlert(any(AlertResponse.class));
    }

    @Test
    @DisplayName("FSM: Vòng đời hoàn chỉnh PENDING (30s) -> FIRING -> ACKNOWLEDGED -> RESOLVED (60s hysteresis)")
    void evaluate_fullLifecycle_pendingToFiringToAckToResolved() {
        when(alertRepository.save(any(Alert.class))).thenAnswer(invocation -> {
            Alert a = invocation.getArgument(0);
            if (a.getId() == null) a.setId("alert-123");
            return a;
        });

        // 1. t = 0s: Nhiệt độ 35°C > 32°C -> PENDING
        alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", createEnvironmentData(35.0));

        // 2. t = 30s: Chuyển FIRING
        mutableClock.advance(Duration.ofSeconds(30));
        alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", createEnvironmentData(35.5));
        verify(alertRepository, times(1)).save(any(Alert.class));
        verify(realtimePublisher, times(1)).publishAlert(any(AlertResponse.class));

        // Mock findById cho acknowledge
        Alert firingAlert = Alert.builder()
                .id("alert-123")
                .deviceId("dev-1")
                .roomId("room-1")
                .type(AlertType.AIR_UNHEALTHY)
                .status(AlertStatus.FIRING)
                .startedAt(mutableClock.instant())
                .build();
        when(alertRepository.findById("alert-123")).thenReturn(Optional.of(firingAlert));

        // 3. Thủ thư xác nhận ACKNOWLEDGE
        mutableClock.advance(Duration.ofSeconds(15));
        AlertResponse ackResponse = alertService.acknowledgeAlert("alert-123", "librarian_john");
        assertThat(ackResponse.getStatus()).isEqualTo(AlertStatus.ACKNOWLEDGED);
        assertThat(ackResponse.getAcknowledgedBy()).isEqualTo("librarian_john");
        verify(alertRepository, times(2)).save(any(Alert.class));

        // 4. Nhiệt độ hạ xuống an toàn 28°C (< 32°C) -> Bắt đầu 60s hysteresis
        mutableClock.advance(Duration.ofSeconds(10));
        alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", createEnvironmentData(28.0));
        // Chưa đủ 60s -> Vẫn ACKNOWLEDGED, không ghi DB thêm
        verify(alertRepository, times(2)).save(any(Alert.class));

        // 5. Sau 30s an toàn (tổng cộng 30s/60s), nhiệt độ lại tăng vọt lên 34°C -> Reset recovery timer
        mutableClock.advance(Duration.ofSeconds(30));
        alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", createEnvironmentData(34.0));
        // Recovery timer bị reset

        // 6. Nhiệt độ lại hạ xuống 29°C -> Bắt đầu tính lại 60s
        mutableClock.advance(Duration.ofSeconds(5));
        alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", createEnvironmentData(29.0));

        // 7. Sau 60s liên tục an toàn -> Chuyển RESOLVED
        mutableClock.advance(Duration.ofSeconds(60));
        alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", createEnvironmentData(29.0));

        // Lần save thứ 3: Chuyển sang RESOLVED
        verify(alertRepository, times(3)).save(any(Alert.class));
        assertThat(firingAlert.getStatus()).isEqualTo(AlertStatus.RESOLVED);
        assertThat(firingAlert.getResolvedAt()).isNotNull();

        // Đã gỡ khỏi in-memory FSM
        assertThat(alertRuleEngine.getFsmMap()).doesNotContainKey("dev-1:TEMPERATURE");
    }

    @Test
    @DisplayName("Xử lý an toàn noisePeak null: Không gây NullPointerException và không kích hoạt cảnh báo sai")
    void evaluate_noisePeakNull_handledSafelyWithoutNpeOrFalseAlarm() {
        TelemetryPayload.TelemetryData data = createAcousticsData(40.0, null); // noiseAvg = 40 (an toàn), noisePeak = null

        alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", data);

        assertThat(alertRuleEngine.getFsmMap()).isEmpty();
        verify(alertRepository, never()).save(any());
        verify(realtimePublisher, never()).publishAlert(any());
    }

    @Test
    @DisplayName("noisePeak >= 85 dBA kích hoạt cảnh báo NOISE_EXCEEDED ngay lập tức (CRITICAL), còn 1 xung lẻ 76 dBA không báo")
    void evaluate_noisePeakExceeded_triggersNoiseExceededAlert() {
        when(alertRepository.save(any(Alert.class))).thenAnswer(invocation -> {
            Alert a = invocation.getArgument(0);
            a.setId("alert-peak");
            return a;
        });

        // 1 xung lẻ 76.0 dBA (< 85.0 dBA) chỉ ghi nhận pulse thứ 1, chưa báo động giả
        alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", createAcousticsData(50.0, 76.0));
        verify(alertRepository, never()).save(any());

        // Xung nghiêm trọng 88.0 dBA (>= 85.0 dBA) -> FIRING ngay lập tức
        alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", createAcousticsData(50.0, 88.0));

        ArgumentCaptor<Alert> captor = ArgumentCaptor.forClass(Alert.class);
        verify(alertRepository).save(captor.capture());
        assertThat(captor.getValue().getType()).isEqualTo(AlertType.NOISE_EXCEEDED);
        assertThat(captor.getValue().getStatus()).isEqualTo(AlertStatus.FIRING);
        assertThat(captor.getValue().getSeverity()).isEqualTo(AlertSeverity.CRITICAL);
        assertThat(captor.getValue().getSeverityRank()).isEqualTo(4);
        assertThat(captor.getValue().getCurrentValue()).isEqualTo(88.0);
        assertThat(captor.getValue().getThreshold()).isEqualTo(85.0);
        assertThat(captor.getValue().getRecommendedAction()).isNotBlank();
    }

    @Test
    @DisplayName("pm2.5 > 50 µg/m³ kích hoạt cảnh báo AIR_UNHEALTHY")
    void evaluate_pm25Exceeded_triggersAirUnhealthyAlert() {
        when(alertRepository.save(any(Alert.class))).thenAnswer(invocation -> {
            Alert a = invocation.getArgument(0);
            a.setId("alert-pm");
            return a;
        });

        alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", createAirQualityData(65.0));
        mutableClock.advance(Duration.ofSeconds(30));
        alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", createAirQualityData(65.0));

        ArgumentCaptor<Alert> captor = ArgumentCaptor.forClass(Alert.class);
        verify(alertRepository).save(captor.capture());
        assertThat(captor.getValue().getType()).isEqualTo(AlertType.AIR_UNHEALTHY);
        assertThat(captor.getValue().getCurrentValue()).isEqualTo(65.0);
        assertThat(captor.getValue().getThreshold()).isEqualTo(50.0);
    }

    @Test
    @DisplayName("getUnreadCount() - Đếm chính xác số lượng cảnh báo FIRING")
    void getUnreadCount_returnsActiveFiringCount() {
        when(mongoTemplate.count(any(Query.class), eq(Alert.class))).thenReturn(5L);

        long count = alertService.getUnreadCount();
        assertThat(count).isEqualTo(5L);
    }

    @Test
    @DisplayName("getAlerts() - Phân trang và lọc theo roomId, type, status")
    void getAlerts_paginatedAndFiltered() {
        Alert alert1 = Alert.builder().id("a1").roomId("room-1").type(AlertType.NOISE_EXCEEDED).status(AlertStatus.FIRING).build();
        Alert alert2 = Alert.builder().id("a2").roomId("room-1").type(AlertType.NOISE_EXCEEDED).status(AlertStatus.ACKNOWLEDGED).build();

        when(mongoTemplate.count(any(Query.class), eq(Alert.class))).thenReturn(2L);
        when(mongoTemplate.find(any(Query.class), eq(Alert.class))).thenReturn(List.of(alert1, alert2));

        PageResponse<AlertResponse> response = alertService.getAlerts("room-1", AlertType.NOISE_EXCEEDED, null, PageRequest.of(0, 10));

        assertThat(response.getContent()).hasSize(2);
        assertThat(response.getTotalElements()).isEqualTo(2);
        assertThat(response.getPage()).isEqualTo(0);
        assertThat(response.getSize()).isEqualTo(10);
    }

    @Test
    @DisplayName("acknowledgeAlert() - Ném ALERT_NOT_EXISTED nếu ID không tồn tại")
    void acknowledgeAlert_notFound_throwsException() {
        when(alertRepository.findById("invalid-id")).thenReturn(Optional.empty());

        assertThatThrownBy(() -> alertService.acknowledgeAlert("invalid-id", "user1"))
                .isInstanceOf(AppException.class)
                .hasFieldOrPropertyWithValue("errorCode", ErrorCode.ALERT_NOT_EXISTED);
    }

    @Test
    @DisplayName("resolveAlert() - Ném ALERT_NOT_EXISTED nếu ID không tồn tại")
    void resolveAlert_notFound_throwsException() {
        when(alertRepository.findById("invalid-id")).thenReturn(Optional.empty());

        assertThatThrownBy(() -> alertService.resolveAlert("invalid-id", "user1"))
                .isInstanceOf(AppException.class)
                .hasFieldOrPropertyWithValue("errorCode", ErrorCode.ALERT_NOT_EXISTED);
    }

    @Test
    @DisplayName("triggerDeviceOfflineAlert() & resolveDeviceOfflineAlert() - Quản lý sự cố offline thiết bị")
    void deviceOfflineAlert_triggerAndResolve() {
        when(alertRepository.save(any(Alert.class))).thenAnswer(invocation -> {
            Alert a = invocation.getArgument(0);
            if (a.getId() == null) a.setId("alert-offline");
            return a;
        });

        alertService.triggerDeviceOfflineAlert("dev-offline", "HW-OFFLINE", "room-1");
        verify(alertRepository, times(1)).save(any(Alert.class));
        verify(realtimePublisher, times(1)).publishAlert(any());

        Alert offlineAlert = Alert.builder()
                .id("alert-offline")
                .deviceId("dev-offline")
                .hardwareId("HW-OFFLINE")
                .type(AlertType.DEVICE_OFFLINE)
                .status(AlertStatus.FIRING)
                .build();
        when(alertRepository.findById("alert-offline")).thenReturn(Optional.of(offlineAlert));

        alertService.resolveDeviceOfflineAlert("HW-OFFLINE");
        verify(alertRepository, times(2)).save(any(Alert.class));
        assertThat(offlineAlert.getStatus()).isEqualTo(AlertStatus.RESOLVED);
        assertThat(offlineAlert.getResolvedBy()).isEqualTo("SYSTEM");
    }

    @Test
    @DisplayName("FSM: 3 xung âm (noisePeak >= 75 dBA) kích hoạt PENDING + LED Tầng 1, tiếp tục ồn đủ 60s chuyển FIRING HIGH và hồi phục qua hysteresis")
    void evaluate_noisePeakSpike_transitionsToFiringWithout30sContinuousBreach() {
        when(alertRepository.save(any(Alert.class))).thenAnswer(invocation -> {
            Alert a = invocation.getArgument(0);
            if (a.getId() == null) a.setId("alert-peak-001");
            return a;
        });

        // Xung 1 & 2 (82.0 dBA): chưa đủ 3 xung -> chưa vào PENDING
        alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", createAcousticsData(50.0, 82.0));
        mutableClock.advance(Duration.ofSeconds(10));
        alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", createAcousticsData(50.0, 81.0));
        verify(alertRepository, never()).save(any());

        // Xung 3 trong vòng 60s -> Vào PENDING Tầng 1 (bật LED WARN_PULSE nhắc sinh viên tại bàn)
        mutableClock.advance(Duration.ofSeconds(10));
        TelemetryPayload.TelemetryData spikeData = createAcousticsData(50.0, 82.0);
        alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", spikeData);
        assertThat(alertRuleEngine.getFsmMap().get("dev-1:NOISE_PEAK").getStatus()).isEqualTo(AlertStatus.PENDING);
        verify(alertRepository, never()).save(any());

        // Nhóm sinh viên phớt lờ đèn LED, tiếp tục phát xung ồn xuyên suốt 60s kế tiếp -> Nâng lên FIRING HIGH
        for (int i = 0; i < 4; i++) {
            mutableClock.advance(Duration.ofSeconds(15));
            alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", spikeData);
        }

        ArgumentCaptor<Alert> alertCaptor = ArgumentCaptor.forClass(Alert.class);
        verify(alertRepository, times(1)).save(alertCaptor.capture());
        Alert saved = alertCaptor.getValue();
        assertThat(saved.getStatus()).isEqualTo(AlertStatus.FIRING);
        assertThat(saved.getType()).isEqualTo(AlertType.NOISE_EXCEEDED);
        assertThat(saved.getSeverity()).isEqualTo(AlertSeverity.HIGH);
        assertThat(saved.getSeverityRank()).isEqualTo(3);
        assertThat(saved.getCurrentValue()).isEqualTo(82.0);
        assertThat(saved.getThreshold()).isEqualTo(75.0);
        assertThat(saved.getMessage()).contains("Peak noise spike");
        assertThat(saved.getRecommendedAction()).isNotBlank();

        verify(realtimePublisher, times(1)).publishAlert(any(AlertResponse.class));

        // t + 5s: Xung âm đã dứt, noisePeak hạ về 52.0 dBA
        mutableClock.advance(Duration.ofSeconds(5));
        TelemetryPayload.TelemetryData calmData = createAcousticsData(50.0, 52.0);
        alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", calmData);

        assertThat(alertRuleEngine.getFsmMap()).containsKey("dev-1:NOISE_PEAK");
        assertThat(alertRuleEngine.getFsmMap().get("dev-1:NOISE_PEAK").getStatus()).isEqualTo(AlertStatus.FIRING);

        // Sau 60s không còn peak nào nữa -> Chuyển sang RESOLVED
        when(alertRepository.findById("alert-peak-001")).thenReturn(Optional.of(saved));
        mutableClock.advance(Duration.ofSeconds(60));
        alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", calmData);

        verify(alertRepository, times(2)).save(any(Alert.class));
        assertThat(saved.getStatus()).isEqualTo(AlertStatus.RESOLVED);
        assertThat(saved.getResolvedBy()).isEqualTo("SYSTEM");
    }

    @Test
    @DisplayName("BOOK_STORAGE: Độ ẩm vượt ngưỡng trên (>60%RH) hoặc dưới (<45%RH) sau 30s -> FIRING kèm SOP Kho sách")
    void evaluate_bookStorageHumidity_triggersHighAndLowAlerts() {
        Room storageRoom = Room.builder()
                .id("room-storage-201")
                .code("TQB_201")
                .name("Kho sách Tầng 2")
                .type(RoomType.BOOK_STORAGE)
                .build();
        when(roomRepository.findById("room-storage-201")).thenReturn(Optional.of(storageRoom));
        when(alertRepository.save(any(Alert.class))).thenAnswer(inv -> {
            Alert a = inv.getArgument(0);
            if (a.getId() == null) a.setId("alert-hum-1");
            return a;
        });

        TelemetryPayload.TelemetryData highHum = TelemetryPayload.TelemetryData.builder()
                .environment(TelemetryPayload.EnvironmentData.builder().temperature(20.0).humidity(64.5).build())
                .build();

        alertService.evaluateTelemetry("dev-s1", "HW-S1", "room-storage-201", highHum);
        mutableClock.advance(Duration.ofSeconds(30));
        alertService.evaluateTelemetry("dev-s1", "HW-S1", "room-storage-201", highHum);

        ArgumentCaptor<Alert> captor = ArgumentCaptor.forClass(Alert.class);
        verify(alertRepository, times(1)).save(captor.capture());
        Alert saved = captor.getValue();
        assertThat(saved.getStatus()).isEqualTo(AlertStatus.FIRING);
        assertThat(saved.getSeverity()).isEqualTo(AlertSeverity.HIGH);
        assertThat(saved.getThreshold()).isEqualTo(60.0);
        assertThat(saved.getRecommendedAction()).contains("SOP Kho sách");
    }

    @Test
    @DisplayName("Kịch bản heat/humid (35.5°C + 85.0%RH): BOOK_STORAGE kích hoạt HIGH HUMIDITY_HIGH + SOP Kho sách & TEMPERATURE; STUDY_ROOM chỉ kích hoạt MEDIUM TEMPERATURE")
    void evaluate_heatHumidScenario_differentiatesBookStorageAndStudyRoom() {
        Room storageRoom = Room.builder()
                .id("room-storage-103")
                .code("TQB_103")
                .name("Kho sách Tầng 1")
                .type(RoomType.BOOK_STORAGE)
                .build();
        Room studyRoom = Room.builder()
                .id("room-study-301")
                .code("TQB_301")
                .name("Phòng đọc Tầng 3")
                .type(RoomType.STUDY_ROOM)
                .build();

        when(roomRepository.findById("room-storage-103")).thenReturn(Optional.of(storageRoom));
        when(roomRepository.findById("room-study-301")).thenReturn(Optional.of(studyRoom));
        AtomicInteger idSeq = new AtomicInteger(1);
        when(alertRepository.save(any(Alert.class))).thenAnswer(inv -> {
            Alert a = inv.getArgument(0);
            if (a.getId() == null) {
                a.setId("alert-hh-" + idSeq.getAndIncrement());
            }
            return a;
        });

        TelemetryPayload.TelemetryData heatHumid = TelemetryPayload.TelemetryData.builder()
                .environment(TelemetryPayload.EnvironmentData.builder()
                        .temperature(35.5)
                        .humidity(85.0)
                        .build())
                .build();

        alertService.evaluateTelemetry("dev-s103", "ESP32_T1_03", "room-storage-103", heatHumid);
        alertService.evaluateTelemetry("dev-d301", "ESP32_T3_01", "room-study-301", heatHumid);

        mutableClock.advance(Duration.ofSeconds(30));

        TelemetryPayload.TelemetryData heatHumidT2 = TelemetryPayload.TelemetryData.builder()
                .environment(TelemetryPayload.EnvironmentData.builder()
                        .temperature(36.0)
                        .humidity(86.0)
                        .build())
                .build();

        alertService.evaluateTelemetry("dev-s103", "ESP32_T1_03", "room-storage-103", heatHumidT2);
        alertService.evaluateTelemetry("dev-d301", "ESP32_T3_01", "room-study-301", heatHumidT2);

        ArgumentCaptor<Alert> captor = ArgumentCaptor.forClass(Alert.class);
        verify(alertRepository, times(3)).save(captor.capture());

        List<Alert> savedAlerts = captor.getAllValues();
        List<Alert> storageAlerts = savedAlerts.stream()
                .filter(a -> "room-storage-103".equals(a.getRoomId()))
                .toList();
        List<Alert> studyAlerts = savedAlerts.stream()
                .filter(a -> "room-study-301".equals(a.getRoomId()))
                .toList();

        assertThat(storageAlerts).hasSize(2);
        Alert storageHumidityAlert = storageAlerts.stream()
                .filter(a -> "HUMIDITY_HIGH".equals(a.getMetricType()))
                .findFirst()
                .orElseThrow();
        assertThat(storageHumidityAlert.getStatus()).isEqualTo(AlertStatus.FIRING);
        assertThat(storageHumidityAlert.getSeverity()).isEqualTo(AlertSeverity.HIGH);
        assertThat(storageHumidityAlert.getThreshold()).isEqualTo(60.0);
        assertThat(storageHumidityAlert.getRecommendedAction()).contains("SOP Kho sách");

        Alert storageTempAlert = storageAlerts.stream()
                .filter(a -> "TEMPERATURE".equals(a.getMetricType()))
                .findFirst()
                .orElseThrow();
        assertThat(storageTempAlert.getStatus()).isEqualTo(AlertStatus.FIRING);
        assertThat(storageTempAlert.getSeverity()).isEqualTo(AlertSeverity.MEDIUM);
        assertThat(storageTempAlert.getThreshold()).isEqualTo(24.0);

        assertThat(studyAlerts).hasSize(1);
        Alert studyTempAlert = studyAlerts.get(0);
        assertThat(studyTempAlert.getMetricType()).isEqualTo("TEMPERATURE");
        assertThat(studyTempAlert.getStatus()).isEqualTo(AlertStatus.FIRING);
        assertThat(studyTempAlert.getSeverity()).isEqualTo(AlertSeverity.MEDIUM);
        assertThat(studyTempAlert.getThreshold()).isEqualTo(32.0);
    }

    @Test
    @DisplayName("Deadband biên độ: Dao động nhỏ trong vùng trễ (63.5–65.0 dBA) không kích hoạt recovery sớm")
    void evaluate_deadband_preventsPrematureRecoveryWhenHoveringNearThreshold() {
        when(alertRepository.save(any(Alert.class))).thenAnswer(inv -> {
            Alert a = inv.getArgument(0);
            if (a.getId() == null) a.setId("alert-db-1");
            return a;
        });

        // Vượt ngưỡng 66.0 dBA trong 60s (pha LED Tầng 1 phòng đọc) -> FIRING
        alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", createAcousticsData(66.0, null));
        mutableClock.advance(Duration.ofSeconds(60));
        alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", createAcousticsData(66.5, null));

        AlertRuleEngine.FsmState state = alertRuleEngine.getFsmMap().get("dev-1:NOISE_AVG");
        assertThat(state.getStatus()).isEqualTo(AlertStatus.FIRING);

        // Hạ nhẹ xuống 64.0 dBA (nằm trong deadband [63.0, 65.0]) -> Chưa được tính là đã hồi phục an toàn
        mutableClock.advance(Duration.ofSeconds(10));
        alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", createAcousticsData(64.0, null));
        assertThat(state.getRecoverySince()).isNull();

        // Chỉ khi hạ hẳn xuống <= 63.0 dBA (62.5 dBA) mới bắt đầu đếm 60s hysteresis
        mutableClock.advance(Duration.ofSeconds(10));
        alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", createAcousticsData(62.5, null));
        assertThat(state.getRecoverySince()).isNotNull();
    }

    @Test
    @DisplayName("Migration idempotent (M3): Bản ghi cũ thiếu severity được điền MEDIUM, severityRank=2 và SOP")
    void migrateLegacyAlertsSeverity_idempotent() {
        Alert legacy = Alert.builder()
                .id("legacy-1")
                .type(AlertType.NOISE_EXCEEDED)
                .status(AlertStatus.FIRING)
                .severity(null)
                .build();
        when(alertRepository.findAll()).thenReturn(List.of(legacy));

        int firstRun = alertRuleEngine.migrateLegacyAlertsSeverity();
        assertThat(firstRun).isEqualTo(1);
        assertThat(legacy.getSeverity()).isEqualTo(AlertSeverity.MEDIUM);
        assertThat(legacy.getSeverityRank()).isEqualTo(2);
        assertThat(legacy.getRecommendedAction()).isNotBlank();

        // Chạy lần 2 không ghi lại DB
        int secondRun = alertRuleEngine.migrateLegacyAlertsSeverity();
        assertThat(secondRun).isEqualTo(0);
    }

    @Test
    @DisplayName("resolveAlert() - Lưu đúng resolvedBy khi thủ thư giải quyết cảnh báo thủ công")
    void resolveAlert_success_setsResolvedBy() {
        Alert alert = Alert.builder()
                .id("alert-manual-01")
                .status(AlertStatus.FIRING)
                .type(AlertType.NOISE_EXCEEDED)
                .severity(AlertSeverity.HIGH)
                .build();

        when(alertRepository.findById("alert-manual-01")).thenReturn(Optional.of(alert));
        when(alertRepository.save(any(Alert.class))).thenAnswer(invocation -> invocation.getArgument(0));

        AlertResponse response = alertService.resolveAlert("alert-manual-01", "librarian_lan");

        assertThat(response.getStatus()).isEqualTo(AlertStatus.RESOLVED);
        assertThat(response.getResolvedBy()).isEqualTo("librarian_lan");
        assertThat(alert.getResolvedBy()).isEqualTo("librarian_lan");
        verify(alertRepository, times(1)).save(alert);
    }

    @Test
    @DisplayName("rehydrateActiveAlerts() - Khôi phục đúng khóa metricType cho PM2_5/NOISE_AVG và tự đóng khi phục hồi")
    void rehydrateActiveAlerts_restoresMetricTypeAndAutoResolvesAfterRestart() {
        Alert pm25Alert = Alert.builder()
                .id("alert-pm25-restart")
                .deviceId("dev-1")
                .hardwareId("HW-1")
                .roomId("room-1")
                .type(AlertType.AIR_UNHEALTHY)
                .severity(AlertSeverity.HIGH)
                .severityRank(3)
                .status(AlertStatus.FIRING)
                .currentValue(62.0)
                .threshold(50.0)
                .message("PM2.5 particulate level (62.0 µg/m³) exceeded threshold (50.0 µg/m³)")
                .recommendedAction("Kiểm tra lọc không khí")
                .startedAt(mutableClock.instant().minusSeconds(120))
                .build();

        when(alertRepository.findAll()).thenReturn(List.of(pm25Alert));
        when(alertRepository.findByStatusIn(List.of(AlertStatus.FIRING, AlertStatus.ACKNOWLEDGED)))
                .thenReturn(List.of(pm25Alert));
        when(alertRepository.findById("alert-pm25-restart")).thenReturn(Optional.of(pm25Alert));
        when(alertRepository.save(any(Alert.class))).thenAnswer(inv -> inv.getArgument(0));

        alertRuleEngine.rehydrateActiveAlerts();

        assertThat(alertRuleEngine.getFsmMap()).containsKey("dev-1:PM2_5");
        assertThat(alertRuleEngine.getFsmMap().get("dev-1:PM2_5").getMetricType()).isEqualTo("PM2_5");

        TelemetryPayload.TelemetryData cleanAir = TelemetryPayload.TelemetryData.builder()
                .airQuality(TelemetryPayload.AirQualityData.builder().pm2_5(12.0).build())
                .build();
        alertRuleEngine.evaluateTelemetry("dev-1", "HW-1", "room-1", cleanAir);
        mutableClock.advance(Duration.ofSeconds(61));
        alertRuleEngine.evaluateTelemetry("dev-1", "HW-1", "room-1", cleanAir);

        assertThat(alertRuleEngine.getFsmMap()).doesNotContainKey("dev-1:PM2_5");
        assertThat(pm25Alert.getStatus()).isEqualTo(AlertStatus.RESOLVED);
        assertThat(pm25Alert.getResolvedBy()).isEqualTo("SYSTEM");
    }

    @Nested
    @DisplayName("Hạng mục 1 (P0-1): Zone Isolation Tests & AlertRuleEngine zoneId Propagation")
    class ZoneIsolationTests {

        @Mock
        UserRepository userRepository;

        @Mock
        DeviceRepository deviceRepository;

        AlertServiceImpl scopedAlertService;

        @BeforeEach
        void setUpScopedService() {
            SecurityContextHolder.clearContext();
            scopedAlertService = new AlertServiceImpl(
                    alertRepository,
                    realtimePublisher,
                    alertRuleEngine,
                    mongoTemplate,
                    mutableClock,
                    userRepository,
                    deviceRepository
            );
        }

        @AfterEach
        void tearDownSecurityContext() {
            SecurityContextHolder.clearContext();
        }

        private SecurityContext buildSecurityContext(String username, String... authorities) {
            Authentication auth = mock(Authentication.class);
            List<SimpleGrantedAuthority> granted = java.util.Arrays.stream(authorities)
                    .map(SimpleGrantedAuthority::new)
                    .toList();
            doReturn(granted).when(auth).getAuthorities();
            if (!"ADMIN".equals(authorities[0]) && !"ROLE_ADMIN".equals(authorities[0])) {
                when(auth.getName()).thenReturn(username);
            }
            SecurityContext ctx = mock(SecurityContext.class);
            when(ctx.getAuthentication()).thenReturn(auth);
            return ctx;
        }

        @Test
        @DisplayName("AlertRuleEngine: 5-arg evaluateTelemetry truyền zoneId vào FsmState, Alert (PENDING->FIRING & immediate) và AlertResponse")
        void evaluateTelemetry_5arg_propagatesZoneIdToFsmAlertAndResponse() {
            when(alertRepository.save(any(Alert.class))).thenAnswer(inv -> {
                Alert a = inv.getArgument(0);
                if (a.getId() == null) {
                    a.setId("alert-" + a.getMetricType());
                }
                return a;
            });

            // 1. Sustained metric: PENDING -> FIRING
            scopedAlertService.evaluateTelemetry("dev-z1", "HW-Z1", "room-z1", "ZONE_A", createEnvironmentData(35.0));
            AlertRuleEngine.FsmState pendingState = alertRuleEngine.getFsmMap().get("dev-z1:TEMPERATURE");
            assertThat(pendingState).isNotNull();
            assertThat(pendingState.getZoneId()).isEqualTo("ZONE_A");

            mutableClock.advance(Duration.ofSeconds(30));
            scopedAlertService.evaluateTelemetry("dev-z1", "HW-Z1", "room-z1", "ZONE_A", createEnvironmentData(35.5));

            // 2. Immediate metric: noisePeak >= 85 dBA
            scopedAlertService.evaluateTelemetry("dev-z1", "HW-Z1", "room-z1", "ZONE_A", createAcousticsData(45.0, 88.0));

            ArgumentCaptor<Alert> savedCaptor = ArgumentCaptor.forClass(Alert.class);
            verify(alertRepository, times(2)).save(savedCaptor.capture());
            assertThat(savedCaptor.getAllValues())
                    .extracting(Alert::getZoneId)
                    .containsExactly("ZONE_A", "ZONE_A");

            ArgumentCaptor<AlertResponse> publishedCaptor = ArgumentCaptor.forClass(AlertResponse.class);
            verify(realtimePublisher, times(2)).publishAlert(publishedCaptor.capture());
            assertThat(publishedCaptor.getAllValues())
                    .extracting(AlertResponse::getZoneId)
                    .containsExactly("ZONE_A", "ZONE_A");
        }

        @Test
        @DisplayName("AlertRuleEngine: 4-arg triggerDeviceOfflineAlert truyền zoneId vào Alert, FsmState và AlertResponse")
        void triggerDeviceOfflineAlert_4arg_propagatesZoneId() {
            when(alertRepository.save(any(Alert.class))).thenAnswer(inv -> {
                Alert a = inv.getArgument(0);
                a.setId("alert-offline-z1");
                return a;
            });

            scopedAlertService.triggerDeviceOfflineAlert("dev-off-1", "HW-OFF-1", "room-z1", "ZONE_B");

            assertThat(alertRuleEngine.getFsmMap().get("dev-off-1:DEVICE_OFFLINE").getZoneId()).isEqualTo("ZONE_B");

            ArgumentCaptor<Alert> alertCaptor = ArgumentCaptor.forClass(Alert.class);
            verify(alertRepository).save(alertCaptor.capture());
            assertThat(alertCaptor.getValue().getZoneId()).isEqualTo("ZONE_B");

            ArgumentCaptor<AlertResponse> pubCaptor = ArgumentCaptor.forClass(AlertResponse.class);
            verify(realtimePublisher).publishAlert(pubCaptor.capture());
            assertThat(pubCaptor.getValue().getZoneId()).isEqualTo("ZONE_B");
        }

        @Test
        @DisplayName("AlertRuleEngine: rehydrateActiveAlerts() khôi phục zoneId và toAlertResponse() ánh xạ zoneId")
        void rehydrateActiveAlerts_restoresZoneIdAndToAlertResponseMapsZoneId() {
            Alert active = Alert.builder()
                    .id("alert-rehydrate-z")
                    .deviceId("dev-r1")
                    .hardwareId("HW-R1")
                    .roomId("room-r1")
                    .zoneId("ZONE_C")
                    .type(AlertType.NOISE_EXCEEDED)
                    .metricType("NOISE_AVG")
                    .severity(AlertSeverity.MEDIUM)
                    .severityRank(2)
                    .status(AlertStatus.FIRING)
                    .recommendedAction("Check noise")
                    .startedAt(mutableClock.instant())
                    .build();

            when(alertRepository.findAll()).thenReturn(List.of(active));
            when(alertRepository.findByStatusIn(List.of(AlertStatus.FIRING, AlertStatus.ACKNOWLEDGED)))
                    .thenReturn(List.of(active));

            alertRuleEngine.rehydrateActiveAlerts();

            assertThat(alertRuleEngine.getFsmMap().get("dev-r1:NOISE_AVG").getZoneId()).isEqualTo("ZONE_C");
            assertThat(AlertRuleEngine.toAlertResponse(active).getZoneId()).isEqualTo("ZONE_C");
        }

        @Test
        @DisplayName("Test 1 (Admin Full Access): ADMIN và ROLE_ADMIN xem toàn bộ zone, đếm toàn bộ unread và ACK/Resolve mọi zone")
        void admin_fullAccess_seesAllZonesAndHandlesAnyZone() {
            Alert alertA = Alert.builder().id("a-A").zoneId("ZONE_A").status(AlertStatus.FIRING).type(AlertType.NOISE_EXCEEDED).build();
            Alert alertB = Alert.builder().id("a-B").zoneId("ZONE_B").status(AlertStatus.FIRING).type(AlertType.AIR_UNHEALTHY).build();
            Alert alertC = Alert.builder().id("a-C").zoneId("ZONE_C").status(AlertStatus.FIRING).type(AlertType.DEVICE_OFFLINE).build();

            when(mongoTemplate.count(any(Query.class), eq(Alert.class))).thenReturn(3L);
            when(mongoTemplate.find(any(Query.class), eq(Alert.class))).thenReturn(List.of(alertA, alertB, alertC));
            when(alertRepository.findById("a-B")).thenReturn(Optional.of(alertB));
            when(alertRepository.findById("a-C")).thenReturn(Optional.of(alertC));
            when(alertRepository.save(any(Alert.class))).thenAnswer(inv -> inv.getArgument(0));

            for (String adminAuthority : List.of("ADMIN", "ROLE_ADMIN")) {
                SecurityContext ctx = buildSecurityContext("admin_user", adminAuthority);
                try (MockedStatic<SecurityContextHolder> holder = mockStatic(SecurityContextHolder.class)) {
                    holder.when(SecurityContextHolder::getContext).thenReturn(ctx);

                    PageResponse<AlertResponse> page = scopedAlertService.getAlerts(null, null, null, PageRequest.of(0, 10));
                    assertThat(page.getTotalElements()).isEqualTo(3L);
                    assertThat(page.getContent()).extracting(AlertResponse::getZoneId)
                            .containsExactly("ZONE_A", "ZONE_B", "ZONE_C");

                    long unread = scopedAlertService.getUnreadCount();
                    assertThat(unread).isEqualTo(3L);

                    AlertResponse ackB = scopedAlertService.acknowledgeAlert("a-B", "admin_user");
                    assertThat(ackB.getStatus()).isEqualTo(AlertStatus.ACKNOWLEDGED);

                    AlertResponse resC = scopedAlertService.resolveAlert("a-C", "admin_user");
                    assertThat(resC.getStatus()).isEqualTo(AlertStatus.RESOLVED);
                }
                // Reset status for next authority iteration
                alertB.setStatus(AlertStatus.FIRING);
                alertC.setStatus(AlertStatus.FIRING);
            }

            ArgumentCaptor<Query> queryCaptor = ArgumentCaptor.forClass(Query.class);
            verify(mongoTemplate, atLeast(2)).count(queryCaptor.capture(), eq(Alert.class));
            for (Query captured : queryCaptor.getAllValues()) {
                assertThat(captured.getQueryObject().containsKey("$or")).isFalse();
                assertThat(captured.getQueryObject().containsKey("_id")).isFalse();
            }
            verifyNoInteractions(userRepository, deviceRepository);
        }

        @Test
        @DisplayName("Test 2a (Role Scoping): LIBRARIAN/MAINTENANCE/ZONE_MANAGER/Custom chỉ thấy ZONE_A qua findByZoneIdIn, không gọi findAll()")
        void nonAdminRoles_getAlertsAndUnreadCount_scopedToAssignedZoneWithoutFindAll() {
            Device devA = Device.builder().id("dev-A1").roomId("room-A1").zoneId("ZONE_A").build();
            Alert alertA = Alert.builder().id("a-A").deviceId("dev-A1").roomId("room-A1").zoneId("ZONE_A")
                    .status(AlertStatus.FIRING).type(AlertType.NOISE_EXCEEDED).build();

            for (String role : List.of("LIBRARIAN", "MAINTENANCE", "ZONE_MANAGER", "CUSTOM_STAFF")) {
                User user = User.builder().username("staff_" + role).assignedZones(Set.of("ZONE_A")).build();
                when(userRepository.findByUsername("staff_" + role)).thenReturn(Optional.of(user));
                when(deviceRepository.findByZoneIdIn(Set.of("ZONE_A"))).thenReturn(List.of(devA));
                when(mongoTemplate.count(any(Query.class), eq(Alert.class))).thenReturn(1L);
                when(mongoTemplate.find(any(Query.class), eq(Alert.class))).thenReturn(List.of(alertA));

                SecurityContext ctx = buildSecurityContext("staff_" + role, role);
                try (MockedStatic<SecurityContextHolder> holder = mockStatic(SecurityContextHolder.class)) {
                    holder.when(SecurityContextHolder::getContext).thenReturn(ctx);

                    PageResponse<AlertResponse> page = scopedAlertService.getAlerts(
                            "room-A1", AlertType.NOISE_EXCEEDED, AlertStatus.FIRING, PageRequest.of(0, 10));
                    assertThat(page.getTotalElements()).isEqualTo(1L);
                    assertThat(page.getContent()).singleElement()
                            .satisfies(resp -> assertThat(resp.getZoneId()).isEqualTo("ZONE_A"));

                    long unread = scopedAlertService.getUnreadCount();
                    assertThat(unread).isEqualTo(1L);
                }
            }

            verify(deviceRepository, times(8)).findByZoneIdIn(Set.of("ZONE_A"));
            verify(deviceRepository, never()).findAll();

            ArgumentCaptor<Query> queryCaptor = ArgumentCaptor.forClass(Query.class);
            verify(mongoTemplate, times(8)).count(queryCaptor.capture(), eq(Alert.class));
            Query lastUnreadQuery = queryCaptor.getAllValues().get(queryCaptor.getAllValues().size() - 1);
            assertThat(lastUnreadQuery.getQueryObject().get("status")).isEqualTo(AlertStatus.FIRING);
            List<org.bson.Document> orClauses = lastUnreadQuery.getQueryObject().getList("$or", org.bson.Document.class);
            assertThat(orClauses).hasSize(3);
            assertThat(orClauses.toString()).contains("zoneId", "ZONE_A", "deviceId", "dev-A1", "room-A1");
        }

        @Test
        @DisplayName("Test 2b (Cross-Zone Denial): User thuộc ZONE_A ACK/Resolve ZONE_A thành công, chạm ZONE_B bị 4031 ZONE_ACCESS_DENIED")
        void nonAdmin_acknowledgeAndResolve_sameZoneAllowed_crossZoneDenied() {
            Device devA = Device.builder().id("dev-A1").roomId("room-A1").zoneId("ZONE_A").build();
            User librarian = User.builder().username("lib_a").assignedZones(Set.of("ZONE_A")).build();

            Alert alertZoneA = Alert.builder().id("a-A").deviceId("dev-A1").roomId("room-A1").zoneId("ZONE_A")
                    .status(AlertStatus.FIRING).type(AlertType.NOISE_EXCEEDED).build();
            Alert alertZoneBFiring = Alert.builder().id("a-B-fire").deviceId("dev-B1").roomId("room-B1").zoneId("ZONE_B")
                    .status(AlertStatus.FIRING).type(AlertType.NOISE_EXCEEDED).build();
            Alert alertZoneBAcked = Alert.builder().id("a-B-ack").deviceId("dev-B1").roomId("room-B1").zoneId("ZONE_B")
                    .status(AlertStatus.ACKNOWLEDGED).type(AlertType.NOISE_EXCEEDED).build();
            Alert alertZoneBResolved = Alert.builder().id("a-B-res").deviceId("dev-B1").roomId("room-B1").zoneId("ZONE_B")
                    .status(AlertStatus.RESOLVED).type(AlertType.NOISE_EXCEEDED).build();

            when(userRepository.findByUsername("lib_a")).thenReturn(Optional.of(librarian));
            when(deviceRepository.findByZoneIdIn(Set.of("ZONE_A"))).thenReturn(List.of(devA));
            when(alertRepository.findById("a-A")).thenReturn(Optional.of(alertZoneA));
            when(alertRepository.findById("a-B-fire")).thenReturn(Optional.of(alertZoneBFiring));
            when(alertRepository.findById("a-B-ack")).thenReturn(Optional.of(alertZoneBAcked));
            when(alertRepository.findById("a-B-res")).thenReturn(Optional.of(alertZoneBResolved));
            when(alertRepository.save(any(Alert.class))).thenAnswer(inv -> inv.getArgument(0));

            SecurityContext ctx = buildSecurityContext("lib_a", "LIBRARIAN");
            try (MockedStatic<SecurityContextHolder> holder = mockStatic(SecurityContextHolder.class)) {
                holder.when(SecurityContextHolder::getContext).thenReturn(ctx);

                // Cross-zone FIRING, ACKNOWLEDGED, RESOLVED probes must all throw ZONE_ACCESS_DENIED before status check
                assertThatThrownBy(() -> scopedAlertService.acknowledgeAlert("a-B-fire", "lib_a"))
                        .isInstanceOf(AppException.class)
                        .satisfies(ex -> {
                            ErrorCode code = ((AppException) ex).getErrorCode();
                            assertThat(code).isEqualTo(ErrorCode.ZONE_ACCESS_DENIED);
                            assertThat(code.getCode()).isEqualTo(4031);
                            assertThat(code.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
                        });
                assertThatThrownBy(() -> scopedAlertService.acknowledgeAlert("a-B-ack", "lib_a"))
                        .isInstanceOf(AppException.class)
                        .hasFieldOrPropertyWithValue("errorCode", ErrorCode.ZONE_ACCESS_DENIED);
                assertThatThrownBy(() -> scopedAlertService.resolveAlert("a-B-res", "lib_a"))
                        .isInstanceOf(AppException.class)
                        .hasFieldOrPropertyWithValue("errorCode", ErrorCode.ZONE_ACCESS_DENIED);
                assertThatThrownBy(() -> scopedAlertService.resolveAlert("a-B-fire", "lib_a"))
                        .isInstanceOf(AppException.class)
                        .hasFieldOrPropertyWithValue("errorCode", ErrorCode.ZONE_ACCESS_DENIED);

                verify(alertRepository, never()).save(any());

                // Same-zone ZONE_A succeeds
                AlertResponse acked = scopedAlertService.acknowledgeAlert("a-A", "lib_a");
                assertThat(acked.getStatus()).isEqualTo(AlertStatus.ACKNOWLEDGED);
                AlertResponse resolved = scopedAlertService.resolveAlert("a-A", "lib_a");
                assertThat(resolved.getStatus()).isEqualTo(AlertStatus.RESOLVED);
            }
        }

        @Test
        @DisplayName("Test 2c (Legacy Alert Fallback + isAuthenticated=false): Alert thiếu zoneId kiểm tra qua Device/Room và không phụ thuộc auth.isAuthenticated()")
        void nonAdmin_legacyAlertWithoutZoneIdAndUnauthenticatedFlag_enforcesZoneScope() {
            Device devA = Device.builder().id("dev-A1").roomId("room-A1").zoneId("ZONE_A").build();
            Device devB = Device.builder().id("dev-B1").roomId("room-B1").zoneId("ZONE_B").build();
            User maintenance = User.builder().username("maint_a").assignedZones(Set.of("ZONE_A")).build();

            Alert legacyAllowedByDevice = Alert.builder().id("leg-A").deviceId("dev-A1").roomId("room-A1").zoneId(null)
                    .status(AlertStatus.FIRING).type(AlertType.AIR_UNHEALTHY).build();
            Alert legacyDeniedByDevice = Alert.builder().id("leg-B").deviceId("dev-B1").roomId("room-A1").zoneId(null)
                    .status(AlertStatus.FIRING).type(AlertType.AIR_UNHEALTHY).build();
            Alert legacyAllowedByRoom = Alert.builder().id("leg-room-A").deviceId("dev-deleted").roomId("room-A1").zoneId("")
                    .status(AlertStatus.FIRING).type(AlertType.AIR_UNHEALTHY).build();
            Alert legacyDeniedByRoom = Alert.builder().id("leg-room-B").deviceId("dev-deleted").roomId("room-B1").zoneId(null)
                    .status(AlertStatus.FIRING).type(AlertType.AIR_UNHEALTHY).build();

            when(userRepository.findByUsername("maint_a")).thenReturn(Optional.of(maintenance));
            when(deviceRepository.findByZoneIdIn(Set.of("ZONE_A"))).thenReturn(List.of(devA));
            when(deviceRepository.findById("dev-A1")).thenReturn(Optional.of(devA));
            when(deviceRepository.findById("dev-B1")).thenReturn(Optional.of(devB));
            when(deviceRepository.findById("dev-deleted")).thenReturn(Optional.empty());
            when(alertRepository.findById("leg-A")).thenReturn(Optional.of(legacyAllowedByDevice));
            when(alertRepository.findById("leg-B")).thenReturn(Optional.of(legacyDeniedByDevice));
            when(alertRepository.findById("leg-room-A")).thenReturn(Optional.of(legacyAllowedByRoom));
            when(alertRepository.findById("leg-room-B")).thenReturn(Optional.of(legacyDeniedByRoom));
            when(alertRepository.save(any(Alert.class))).thenAnswer(inv -> inv.getArgument(0));

            // Mocked Authentication intentionally leaves isAuthenticated() == false
            Authentication auth = mock(Authentication.class);
            doReturn(List.of(new SimpleGrantedAuthority("MAINTENANCE"))).when(auth).getAuthorities();
            when(auth.getName()).thenReturn("maint_a");
            SecurityContext ctx = mock(SecurityContext.class);
            when(ctx.getAuthentication()).thenReturn(auth);

            try (MockedStatic<SecurityContextHolder> holder = mockStatic(SecurityContextHolder.class)) {
                holder.when(SecurityContextHolder::getContext).thenReturn(ctx);

                assertThatThrownBy(() -> scopedAlertService.acknowledgeAlert("leg-B", "maint_a"))
                        .isInstanceOf(AppException.class)
                        .hasFieldOrPropertyWithValue("errorCode", ErrorCode.ZONE_ACCESS_DENIED);

                assertThatThrownBy(() -> scopedAlertService.resolveAlert("leg-room-B", "maint_a"))
                        .isInstanceOf(AppException.class)
                        .hasFieldOrPropertyWithValue("errorCode", ErrorCode.ZONE_ACCESS_DENIED);

                assertThat(scopedAlertService.acknowledgeAlert("leg-A", "maint_a").getStatus())
                        .isEqualTo(AlertStatus.ACKNOWLEDGED);
                assertThat(scopedAlertService.resolveAlert("leg-room-A", "maint_a").getStatus())
                        .isEqualTo(AlertStatus.RESOLVED);
            }
        }

        @Test
        @DisplayName("Test 3 (Empty assignedZones): Non-ADMIN không có assignedZones trả về rỗng (0 unread) và từ chối mọi ACK/Resolve")
        void nonAdmin_emptyAssignedZones_returnsEmptyAndDeniesMutations() {
            User emptyZonesUser = User.builder().username("nozone_user").assignedZones(Set.of()).build();
            Alert alertA = Alert.builder().id("a-A").zoneId("ZONE_A").status(AlertStatus.FIRING).type(AlertType.NOISE_EXCEEDED).build();

            when(userRepository.findByUsername("nozone_user")).thenReturn(Optional.of(emptyZonesUser));
            when(mongoTemplate.count(any(Query.class), eq(Alert.class))).thenReturn(0L);
            when(mongoTemplate.find(any(Query.class), eq(Alert.class))).thenReturn(List.of());
            when(alertRepository.findById("a-A")).thenReturn(Optional.of(alertA));

            SecurityContext ctx = buildSecurityContext("nozone_user", "VIEWER");
            try (MockedStatic<SecurityContextHolder> holder = mockStatic(SecurityContextHolder.class)) {
                holder.when(SecurityContextHolder::getContext).thenReturn(ctx);

                PageResponse<AlertResponse> page = scopedAlertService.getAlerts(null, null, null, PageRequest.of(0, 10));
                assertThat(page.getTotalElements()).isZero();
                assertThat(page.getContent()).isEmpty();

                long unread = scopedAlertService.getUnreadCount();
                assertThat(unread).isZero();

                assertThatThrownBy(() -> scopedAlertService.acknowledgeAlert("a-A", "nozone_user"))
                        .isInstanceOf(AppException.class)
                        .hasFieldOrPropertyWithValue("errorCode", ErrorCode.ZONE_ACCESS_DENIED);
                assertThatThrownBy(() -> scopedAlertService.resolveAlert("a-A", "nozone_user"))
                        .isInstanceOf(AppException.class)
                        .hasFieldOrPropertyWithValue("errorCode", ErrorCode.ZONE_ACCESS_DENIED);
            }

            ArgumentCaptor<Query> queryCaptor = ArgumentCaptor.forClass(Query.class);
            verify(mongoTemplate, times(2)).count(queryCaptor.capture(), eq(Alert.class));
            for (Query q : queryCaptor.getAllValues()) {
                assertThat(q.getQueryObject().get("_id")).isEqualTo("__none__");
            }
            verifyNoInteractions(deviceRepository);
            verify(alertRepository, never()).save(any());
        }
    }

    @Nested
    @DisplayName("Hạng mục 2 (P0-2): Chu kỳ 0,5s, Chống đếm trùng xung ồn (Cooldown 3s) & Giữ PENDING trong Deadband")
    class HalfSecondAndDeadbandTests {

        @Test
        @DisplayName("Test 1 (Burst 0,5s không nổ NOISE_PEAK giả): 4 gói 78.0 dBA ở 0.0s, 0.5s, 1.0s, 1.5s chỉ tính 1 xung")
        void noisePeak_halfSecondBurst_countsOnlyOnePulseWithinCooldown() {
            // t = 0.0s, 0.5s, 1.0s, 1.5s, 2.5s -> tất cả nằm trong cooldown 3s tính từ t = 0.0s
            alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", "ZONE_A", createAcousticsData(50.0, 78.0));

            mutableClock.advance(Duration.ofMillis(500));
            alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", "ZONE_A", createAcousticsData(50.0, 78.0));

            mutableClock.advance(Duration.ofMillis(500));
            alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", "ZONE_A", createAcousticsData(50.0, 78.0));

            mutableClock.advance(Duration.ofMillis(500));
            alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", "ZONE_A", createAcousticsData(50.0, 78.0));

            mutableClock.advance(Duration.ofMillis(1000)); // t = 2.5s (< 3.0s)
            alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", "ZONE_A", createAcousticsData(50.0, 78.0));

            assertThat(alertRuleEngine.getNoisePeakPulsesMap().get("dev-1:NOISE_PEAK_PULSES")).hasSize(1);
            assertThat(alertRuleEngine.getFsmMap()).doesNotContainKey("dev-1:NOISE_PEAK");
            verify(alertRepository, never()).save(any());
            verify(realtimePublisher, never()).publishAlert(any());
        }

        @Test
        @DisplayName("Test 2 (3 xung cách nhau >= 3s kích hoạt PENDING LED Tầng 1, duy trì 60s nổ HIGH): t=0s, 4s, 8s và biên t=0s, 3s, 6s")
        void noisePeak_threePulsesSpacedAtLeast3Seconds_firesHighAlert() {
            when(alertRepository.save(any(Alert.class))).thenAnswer(inv -> {
                Alert a = inv.getArgument(0);
                a.setId("alert-peak-high");
                return a;
            });

            // t = 0s -> Xung 1
            alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", "ZONE_A", createAcousticsData(50.0, 78.0));
            assertThat(alertRuleEngine.getNoisePeakPulsesMap().get("dev-1:NOISE_PEAK_PULSES")).hasSize(1);

            // t = 4s -> Xung 2
            mutableClock.advance(Duration.ofSeconds(4));
            alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", "ZONE_A", createAcousticsData(50.0, 78.0));
            assertThat(alertRuleEngine.getNoisePeakPulsesMap().get("dev-1:NOISE_PEAK_PULSES")).hasSize(2);
            verify(alertRepository, never()).save(any());

            // t = 8s -> Xung 3 -> Vào PENDING Tầng 1 (bật LED WARN_PULSE)
            mutableClock.advance(Duration.ofSeconds(4));
            alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", "ZONE_A", createAcousticsData(50.0, 78.0));
            assertThat(alertRuleEngine.getNoisePeakPulsesMap().get("dev-1:NOISE_PEAK_PULSES")).hasSize(3);
            assertThat(alertRuleEngine.getFsmMap().get("dev-1:NOISE_PEAK").getStatus()).isEqualTo(AlertStatus.PENDING);

            // Tiếp tục có xung ồn suốt 60s -> Nâng lên FIRING (HIGH)
            for (int i = 0; i < 4; i++) {
                mutableClock.advance(Duration.ofSeconds(15));
                alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", "ZONE_A", createAcousticsData(50.0, 78.0));
            }

            ArgumentCaptor<Alert> captor = ArgumentCaptor.forClass(Alert.class);
            verify(alertRepository, times(1)).save(captor.capture());
            Alert saved = captor.getValue();
            assertThat(saved.getStatus()).isEqualTo(AlertStatus.FIRING);
            assertThat(saved.getSeverity()).isEqualTo(AlertSeverity.HIGH);
            assertThat(saved.getMetricType()).isEqualTo("NOISE_PEAK");
            assertThat(saved.getCurrentValue()).isEqualTo(78.0);
            verify(realtimePublisher, times(1)).publishAlert(any(AlertResponse.class));

            // Kiểm tra biên chính xác 3s (t=0s, 3s, 6s) trên thiết bị khác rồi duy trì 60s
            alertRuleEngine.reset();
            alertService.evaluateTelemetry("dev-2", "HW-2", "room-1", "ZONE_A", createAcousticsData(50.0, 77.5));
            mutableClock.advance(Duration.ofSeconds(3));
            alertService.evaluateTelemetry("dev-2", "HW-2", "room-1", "ZONE_A", createAcousticsData(50.0, 77.5));
            mutableClock.advance(Duration.ofSeconds(3));
            alertService.evaluateTelemetry("dev-2", "HW-2", "room-1", "ZONE_A", createAcousticsData(50.0, 77.5));

            assertThat(alertRuleEngine.getNoisePeakPulsesMap().get("dev-2:NOISE_PEAK_PULSES")).hasSize(3);
            for (int i = 0; i < 4; i++) {
                mutableClock.advance(Duration.ofSeconds(15));
                alertService.evaluateTelemetry("dev-2", "HW-2", "room-1", "ZONE_A", createAcousticsData(50.0, 77.5));
            }
            verify(alertRepository, times(2)).save(any(Alert.class));
        }

        @Test
        @DisplayName("Test 3 (NOISE_PEAK >= 85 dBA nổ CRITICAL tức thì bất chấp cooldown)")
        void noisePeak_severeSpike_firesCriticalImmediatelyEvenDuringCooldown() {
            Alert[] room1Alert = new Alert[1];
            when(alertRepository.save(any(Alert.class))).thenAnswer(inv -> {
                Alert a = inv.getArgument(0);
                if (a.getId() == null) a.setId("alert-crit-" + a.getDeviceId());
                room1Alert[0] = a;
                return a;
            });
            lenient().when(alertRepository.findById(anyString())).thenAnswer(inv -> Optional.ofNullable(room1Alert[0]));

            // Trường hợp 3a: 1 gói duy nhất >= 85 dBA ở t = 0s
            alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", "ZONE_A", createAcousticsData(50.0, 86.0));

            ArgumentCaptor<Alert> captor = ArgumentCaptor.forClass(Alert.class);
            verify(alertRepository, times(1)).save(captor.capture());
            assertThat(captor.getValue().getSeverity()).isEqualTo(AlertSeverity.CRITICAL);
            assertThat(captor.getValue().getStatus()).isEqualTo(AlertStatus.FIRING);
            assertThat(captor.getValue().getCurrentValue()).isEqualTo(86.0);

            // Trường hợp 3b: Thiết bị khác có xung 78.0 dBA ở t = 0s, sau 0.5s (đang trong cooldown 3s) vọt 86.0 dBA -> Vẫn nổ CRITICAL ngay & trở thành tâm chấn mới
            alertService.evaluateTelemetry("dev-2", "HW-2", "room-1", "ZONE_A", createAcousticsData(50.0, 78.0));
            mutableClock.advance(Duration.ofMillis(500));
            alertService.evaluateTelemetry("dev-2", "HW-2", "room-1", "ZONE_A", createAcousticsData(50.0, 86.0));

            verify(alertRepository, times(2)).save(captor.capture());
            Alert secondSaved = captor.getAllValues().get(captor.getAllValues().size() - 1);
            assertThat(secondSaved.getDeviceId()).isEqualTo("dev-2");
            assertThat(secondSaved.getSeverity()).isEqualTo(AlertSeverity.CRITICAL);
            assertThat(secondSaved.getStatus()).isEqualTo(AlertStatus.FIRING);
            assertThat(secondSaved.getAffectedNodes()).hasSize(2);
        }

        @Test
        @DisplayName("Test 4a (Giữ PENDING trong vùng Deadband): Dao động nhẹ (63.0, 65.0] giữ nguyên pendingSince và nổ FIRING đúng mốc 60s")
        void pending_fluctuationInDeadband_retainsPendingAndFiresAt30s() {
            when(alertRepository.save(any(Alert.class))).thenAnswer(inv -> {
                Alert a = inv.getArgument(0);
                a.setId("alert-pending-db");
                return a;
            });

            // t = 0s: 66.0 dBA (> 65.0) -> Vào PENDING
            Instant t0 = mutableClock.instant();
            alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", "ZONE_A", createAcousticsData(66.0, null));
            AlertRuleEngine.FsmState pendingState = alertRuleEngine.getFsmMap().get("dev-1:NOISE_AVG");
            assertThat(pendingState).isNotNull();
            assertThat(pendingState.getStatus()).isEqualTo(AlertStatus.PENDING);
            assertThat(pendingState.getPendingSince()).isEqualTo(t0);

            // t = 30s: tụt nhẹ xuống 64.2 dBA (trong vùng deadband (63.0, 65.0]) -> vẫn giữ PENDING và pendingSince gốc
            mutableClock.advance(Duration.ofSeconds(30));
            alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", "ZONE_A", createAcousticsData(64.2, null));
            pendingState = alertRuleEngine.getFsmMap().get("dev-1:NOISE_AVG");
            assertThat(pendingState).isNotNull();
            assertThat(pendingState.getStatus()).isEqualTo(AlertStatus.PENDING);
            assertThat(pendingState.getPendingSince()).isEqualTo(t0);
            assertThat(pendingState.getLastValue()).isEqualTo(64.2);
            verify(alertRepository, never()).save(any());

            // t = 60s: Nếu vẫn đứng ở mức deadband 65.0 dBA (chưa vượt ngưỡng) -> vẫn PENDING, không bắn giả
            mutableClock.advance(Duration.ofSeconds(30));
            alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", "ZONE_A", createAcousticsData(65.0, null));
            assertThat(alertRuleEngine.getFsmMap().get("dev-1:NOISE_AVG").getStatus()).isEqualTo(AlertStatus.PENDING);
            verify(alertRepository, never()).save(any());

            // t = 60.5s: Vọt lại 66.5 dBA -> Đủ 60s tính từ t0 -> Nổ FIRING
            mutableClock.advance(Duration.ofMillis(500));
            alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", "ZONE_A", createAcousticsData(66.5, null));

            ArgumentCaptor<Alert> captor = ArgumentCaptor.forClass(Alert.class);
            verify(alertRepository, times(1)).save(captor.capture());
            assertThat(captor.getValue().getStatus()).isEqualTo(AlertStatus.FIRING);
            assertThat(captor.getValue().getCurrentValue()).isEqualTo(66.5);
            verify(realtimePublisher, times(1)).publishAlert(any(AlertResponse.class));
        }

        @Test
        @DisplayName("Test 4b (Hủy PENDING khi tụt về vùng an toàn <= ngưỡng - deadband): 62.5 dBA và biên 63.0 dBA đều hủy PENDING")
        void pending_dropsToSafeZoneBelowDeadband_cancelsPending() {
            // t = 0s: 66.0 dBA -> PENDING
            alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", "ZONE_A", createAcousticsData(66.0, null));
            assertThat(alertRuleEngine.getFsmMap()).containsKey("dev-1:NOISE_AVG");

            // t = 15s: tụt xuống 62.5 dBA (<= 63.0) -> Hủy PENDING về null
            mutableClock.advance(Duration.ofSeconds(15));
            alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", "ZONE_A", createAcousticsData(62.5, null));
            assertThat(alertRuleEngine.getFsmMap()).doesNotContainKey("dev-1:NOISE_AVG");

            // Kiểm tra biên chính xác 63.0 dBA (= 65.0 - 2.0) cũng hủy PENDING
            alertService.evaluateTelemetry("dev-2", "HW-2", "room-1", "ZONE_A", createAcousticsData(66.0, null));
            assertThat(alertRuleEngine.getFsmMap()).containsKey("dev-2:NOISE_AVG");
            mutableClock.advance(Duration.ofSeconds(10));
            alertService.evaluateTelemetry("dev-2", "HW-2", "room-1", "ZONE_A", createAcousticsData(63.0, null));
            assertThat(alertRuleEngine.getFsmMap()).doesNotContainKey("dev-2:NOISE_AVG");

            verify(alertRepository, never()).save(any());
        }

        @Test
        @DisplayName("Test 4c (Deadband ngưỡng dưới HUMIDITY_LOW tại BOOK_STORAGE): Giữ PENDING trong [45.0, 47.0), hủy khi >= 47.0")
        void pending_bookStorageLowHumidityDeadband_retainsOrCancelsCorrectly() {
            Room storageRoom = Room.builder()
                    .id("room-storage-deadband")
                    .code("TQB_202")
                    .name("Kho sách Tầng 2B")
                    .type(RoomType.BOOK_STORAGE)
                    .build();
            when(roomRepository.findById("room-storage-deadband")).thenReturn(Optional.of(storageRoom));
            when(alertRepository.save(any(Alert.class))).thenAnswer(inv -> {
                Alert a = inv.getArgument(0);
                a.setId("alert-hum-low");
                return a;
            });

            // t = 0s: 43.0 %RH (< 45.0) -> PENDING HUMIDITY_LOW
            Instant t0 = mutableClock.instant();
            TelemetryPayload.TelemetryData breachLow = TelemetryPayload.TelemetryData.builder()
                    .environment(TelemetryPayload.EnvironmentData.builder().temperature(20.0).humidity(43.0).build())
                    .build();
            alertService.evaluateTelemetry("dev-s2", "HW-S2", "room-storage-deadband", "ZONE_A", breachLow);
            assertThat(alertRuleEngine.getFsmMap().get("dev-s2:HUMIDITY_LOW").getStatus()).isEqualTo(AlertStatus.PENDING);

            // t = 15s: 46.0 %RH (trong deadband [45.0, 47.0)) -> giữ PENDING
            mutableClock.advance(Duration.ofSeconds(15));
            TelemetryPayload.TelemetryData deadbandLow = TelemetryPayload.TelemetryData.builder()
                    .environment(TelemetryPayload.EnvironmentData.builder().temperature(20.0).humidity(46.0).build())
                    .build();
            alertService.evaluateTelemetry("dev-s2", "HW-S2", "room-storage-deadband", "ZONE_A", deadbandLow);
            assertThat(alertRuleEngine.getFsmMap().get("dev-s2:HUMIDITY_LOW").getStatus()).isEqualTo(AlertStatus.PENDING);
            assertThat(alertRuleEngine.getFsmMap().get("dev-s2:HUMIDITY_LOW").getPendingSince()).isEqualTo(t0);

            // t = 30s: 44.0 %RH (< 45.0) -> FIRING HUMIDITY_LOW
            mutableClock.advance(Duration.ofSeconds(15));
            TelemetryPayload.TelemetryData rebreachLow = TelemetryPayload.TelemetryData.builder()
                    .environment(TelemetryPayload.EnvironmentData.builder().temperature(20.0).humidity(44.0).build())
                    .build();
            alertService.evaluateTelemetry("dev-s2", "HW-S2", "room-storage-deadband", "ZONE_A", rebreachLow);

            ArgumentCaptor<Alert> captor = ArgumentCaptor.forClass(Alert.class);
            verify(alertRepository, times(1)).save(captor.capture());
            assertThat(captor.getValue().getMetricType()).isEqualTo("HUMIDITY_LOW");
            assertThat(captor.getValue().getStatus()).isEqualTo(AlertStatus.FIRING);
        }
    }

    @Nested
    @DisplayName("Hạng mục 3 (P0-3): Cơ chế Tạm hoãn (Snooze) khi Đóng sự cố thủ công")
    class SnoozeTests {

        private Alert triggerFiringTempAlert(String alertId, String deviceId) {
            when(alertRepository.save(any(Alert.class))).thenAnswer(inv -> {
                Alert a = inv.getArgument(0);
                if (a.getId() == null) {
                    a.setId(alertId);
                }
                return a;
            });

            alertService.evaluateTelemetry(deviceId, "HW-" + deviceId, "room-1", "ZONE_A", createEnvironmentData(34.0));
            mutableClock.advance(Duration.ofSeconds(30));
            alertService.evaluateTelemetry(deviceId, "HW-" + deviceId, "room-1", "ZONE_A", createEnvironmentData(34.0));

            ArgumentCaptor<Alert> captor = ArgumentCaptor.forClass(Alert.class);
            verify(alertRepository, atLeastOnce()).save(captor.capture());
            Alert fired = captor.getValue();
            when(alertRepository.findById(alertId)).thenReturn(Optional.of(fired));
            return fired;
        }

        @Test
        @DisplayName("Test 1 & 2: Đóng sự cố áp dụng Snooze 15 phút (chặn PENDING/FIRING ở t+10s..t+60s) và tự mở lại sau 15 phút + 1 giây")
        void resolveAlert_appliesDefault15MinSnooze_andResumesAfterExpiry() {
            triggerFiringTempAlert("alert-snooze-1", "dev-1");

            // Đóng sự cố thủ công (mặc định 15 phút)
            AlertResponse resolved = alertService.resolveAlert("alert-snooze-1", "librarian_a");
            assertThat(resolved.getStatus()).isEqualTo(AlertStatus.RESOLVED);
            assertThat(alertRuleEngine.getFsmMap()).doesNotContainKey("dev-1:TEMPERATURE");
            assertThat(alertRuleEngine.getSnoozeUntilMap()).containsKey("dev-1:TEMPERATURE");

            // t + 10s .. t + 60s: nhiệt độ vẫn 33.8°C -> KHÔNG vào PENDING, KHÔNG lưu thêm cảnh báo
            for (int sec : List.of(10, 20, 30)) {
                mutableClock.advance(Duration.ofSeconds(sec == 10 ? 10 : 20));
                alertService.evaluateTelemetry("dev-1", "HW-dev-1", "room-1", "ZONE_A", createEnvironmentData(33.8));
            }
            assertThat(alertRuleEngine.getFsmMap()).doesNotContainKey("dev-1:TEMPERATURE");
            // 2 lần save trước đó: 1 lần FIRING + 1 lần RESOLVED
            verify(alertRepository, times(2)).save(any(Alert.class));

            // Sau 15 phút + 1 giây từ lúc resolve (tổng advance 50s đã đi qua + 14m11s) -> Hết hạn Snooze
            mutableClock.advance(Duration.ofMinutes(14).plusSeconds(11));
            alertService.evaluateTelemetry("dev-1", "HW-dev-1", "room-1", "ZONE_A", createEnvironmentData(33.8));

            assertThat(alertRuleEngine.getSnoozeUntilMap()).doesNotContainKey("dev-1:TEMPERATURE");
            assertThat(alertRuleEngine.getFsmMap()).containsKey("dev-1:TEMPERATURE");
            assertThat(alertRuleEngine.getFsmMap().get("dev-1:TEMPERATURE").getStatus()).isEqualTo(AlertStatus.PENDING);

            // Thêm 30s nữa -> Tạo cảnh báo mới
            mutableClock.advance(Duration.ofSeconds(30));
            alertService.evaluateTelemetry("dev-1", "HW-dev-1", "room-1", "ZONE_A", createEnvironmentData(33.9));
            verify(alertRepository, times(3)).save(any(Alert.class));
            verify(realtimePublisher, times(3)).publishAlert(any(AlertResponse.class));
        }

        @Test
        @DisplayName("Test 3: Tự xóa Snooze sớm nếu môi trường về vùng an toàn (<= 31.2°C), nhưng giữ Snooze nếu chỉ lơ lửng trong deadband")
        void snooze_clearsEarlyOnSafeRecovery_whileRetainedInDeadband() {
            triggerFiringTempAlert("alert-snooze-early", "dev-1");
            alertService.resolveAlert("alert-snooze-early", "librarian_a");
            assertThat(alertRuleEngine.getSnoozeUntilMap()).containsKey("dev-1:TEMPERATURE");

            // Phút thứ 3: tụt nhẹ vào deadband 31.6°C (> 31.2°C, chưa phải isRecovered) -> Vẫn giữ Snooze
            mutableClock.advance(Duration.ofMinutes(3));
            alertService.evaluateTelemetry("dev-1", "HW-dev-1", "room-1", "ZONE_A", createEnvironmentData(31.6));
            assertThat(alertRuleEngine.getSnoozeUntilMap()).containsKey("dev-1:TEMPERATURE");

            // Phút thứ 5: hạ hẳn xuống 30.0°C (<= 31.2°C, isRecovered == true) -> Tự gỡ Snooze sớm
            mutableClock.advance(Duration.ofMinutes(2));
            alertService.evaluateTelemetry("dev-1", "HW-dev-1", "room-1", "ZONE_A", createEnvironmentData(30.0));
            assertThat(alertRuleEngine.getSnoozeUntilMap()).doesNotContainKey("dev-1:TEMPERATURE");

            // Phút thứ 7: nhiệt độ vọt lại 34.0°C -> Bắt đầu PENDING và sau 30s nổ FIRING bình thường
            mutableClock.advance(Duration.ofMinutes(2));
            alertService.evaluateTelemetry("dev-1", "HW-dev-1", "room-1", "ZONE_A", createEnvironmentData(34.0));
            assertThat(alertRuleEngine.getFsmMap()).containsKey("dev-1:TEMPERATURE");
            assertThat(alertRuleEngine.getFsmMap().get("dev-1:TEMPERATURE").getStatus()).isEqualTo(AlertStatus.PENDING);

            mutableClock.advance(Duration.ofSeconds(30));
            alertService.evaluateTelemetry("dev-1", "HW-dev-1", "room-1", "ZONE_A", createEnvironmentData(34.2));
            verify(alertRepository, times(3)).save(any(Alert.class));
        }

        @Test
        @DisplayName("Test 4: Mức CRITICAL (NOISE_PEAK >= 85 dBA) phá vỡ Snooze ngay lập tức (cả khóa thiết bị và khóa phòng)")
        void snooze_overriddenImmediatelyByCriticalAlert() {
            when(alertRepository.save(any(Alert.class))).thenAnswer(inv -> {
                Alert a = inv.getArgument(0);
                if (a.getId() == null) {
                    a.setId(a.getSeverity() == AlertSeverity.CRITICAL ? "alert-peak-crit" : "alert-peak-high");
                }
                return a;
            });

            // 3 xung 78.0 dBA cách nhau 4s -> PENDING Tầng 1, tiếp tục duy trì đủ 60s -> Nổ NOISE_PEAK (HIGH)
            alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", "ZONE_A", createAcousticsData(50.0, 78.0));
            mutableClock.advance(Duration.ofSeconds(4));
            alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", "ZONE_A", createAcousticsData(50.0, 78.0));
            mutableClock.advance(Duration.ofSeconds(4));
            alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", "ZONE_A", createAcousticsData(50.0, 78.0));
            for (int i = 0; i < 4; i++) {
                mutableClock.advance(Duration.ofSeconds(15));
                alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", "ZONE_A", createAcousticsData(50.0, 78.0));
            }

            ArgumentCaptor<Alert> captor = ArgumentCaptor.forClass(Alert.class);
            verify(alertRepository, times(1)).save(captor.capture());
            Alert highAlert = captor.getValue();
            when(alertRepository.findById("alert-peak-high")).thenReturn(Optional.of(highAlert));

            // Đóng sự cố -> Snooze 15 phút cho cả trạm và cả phòng room:room-1:NOISE
            alertService.resolveAlert("alert-peak-high", "librarian_a");
            assertThat(alertRuleEngine.getSnoozeUntilMap()).containsKeys("dev-1:NOISE_PEAK", "room:room-1:NOISE");

            // Phút thứ 1: thêm xung 78.0 dBA (kể cả trên trạm khác cùng phòng) -> Bị Snooze chặn hoàn toàn
            mutableClock.advance(Duration.ofMinutes(1));
            alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", "ZONE_A", createAcousticsData(50.0, 78.0));
            mutableClock.advance(Duration.ofSeconds(4));
            alertService.evaluateTelemetry("dev-2", "HW-2", "room-1", "ZONE_A", createAcousticsData(68.0, 78.0));
            mutableClock.advance(Duration.ofSeconds(4));
            alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", "ZONE_A", createAcousticsData(50.0, 78.0));
            verify(alertRepository, times(2)).save(any(Alert.class)); // vẫn chỉ 1 FIRING + 1 RESOLVED

            // Phút thứ 2: xuất hiện tiếng nổ 88.0 dBA (CRITICAL) -> Phá Snooze và phát cảnh báo CRITICAL ngay lập tức
            mutableClock.advance(Duration.ofMinutes(1));
            alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", "ZONE_A", createAcousticsData(50.0, 88.0));

            assertThat(alertRuleEngine.getSnoozeUntilMap()).doesNotContainKey("dev-1:NOISE_PEAK");
            assertThat(alertRuleEngine.getSnoozeUntilMap()).doesNotContainKey("room:room-1:NOISE");
            verify(alertRepository, times(3)).save(captor.capture());
            Alert critAlert = captor.getValue();
            assertThat(critAlert.getSeverity()).isEqualTo(AlertSeverity.CRITICAL);
            assertThat(critAlert.getStatus()).isEqualTo(AlertStatus.FIRING);
            assertThat(critAlert.getCurrentValue()).isEqualTo(88.0);
        }

        @Test
        @DisplayName("Ca biên Snooze: Hỗ trợ snoozeMinutes tùy chỉnh (30 phút), snoozeMinutes=0 (không hoãn), và fallback khi fsmMap thiếu alertId")
        void snooze_customDurationZeroAndRestartFallback() {
            // 1. Custom 30 phút
            triggerFiringTempAlert("alert-custom-30", "dev-c1");
            alertService.resolveAlert("alert-custom-30", "admin", 30);

            mutableClock.advance(Duration.ofMinutes(20));
            alertService.evaluateTelemetry("dev-c1", "HW-c1", "room-1", "ZONE_A", createEnvironmentData(34.5));
            assertThat(alertRuleEngine.getFsmMap()).doesNotContainKey("dev-c1:TEMPERATURE");

            mutableClock.advance(Duration.ofMinutes(10).plusSeconds(1));
            alertService.evaluateTelemetry("dev-c1", "HW-c1", "room-1", "ZONE_A", createEnvironmentData(34.5));
            assertThat(alertRuleEngine.getFsmMap()).containsKey("dev-c1:TEMPERATURE");
            assertThat(alertRuleEngine.getFsmMap().get("dev-c1:TEMPERATURE").getStatus()).isEqualTo(AlertStatus.PENDING);

            // 2. snoozeMinutes = 0 -> không áp dụng Snooze
            alertRuleEngine.reset();
            triggerFiringTempAlert("alert-zero", "dev-z0");
            alertService.resolveAlert("alert-zero", "admin", 0);
            assertThat(alertRuleEngine.getSnoozeUntilMap()).doesNotContainKey("dev-z0:TEMPERATURE");

            alertService.evaluateTelemetry("dev-z0", "HW-z0", "room-1", "ZONE_A", createEnvironmentData(34.5));
            assertThat(alertRuleEngine.getFsmMap()).containsKey("dev-z0:TEMPERATURE");
            assertThat(alertRuleEngine.getFsmMap().get("dev-z0:TEMPERATURE").getStatus()).isEqualTo(AlertStatus.PENDING);

            // 3. Fallback khi fsmMap không chứa alertId (mô phỏng sau restart / lệch key)
            alertRuleEngine.reset();
            Alert legacyOrRestarted = Alert.builder()
                    .id("alert-restarted-99")
                    .deviceId("dev-r99")
                    .hardwareId("HW-r99")
                    .roomId("room-1")
                    .zoneId("ZONE_A")
                    .type(AlertType.AIR_UNHEALTHY)
                    .metricType("PM2_5")
                    .status(AlertStatus.ACKNOWLEDGED)
                    .build();
            when(alertRepository.findById("alert-restarted-99")).thenReturn(Optional.of(legacyOrRestarted));

            alertService.resolveAlert("alert-restarted-99", "admin", 15);
            assertThat(alertRuleEngine.getSnoozeUntilMap()).containsKey("dev-r99:PM2_5");

            // Trong 15 phút PM2.5 = 80.0 bị chặn bởi Snooze fallback
            alertService.evaluateTelemetry("dev-r99", "HW-r99", "room-1", "ZONE_A", createAirQualityData(80.0));
            assertThat(alertRuleEngine.getFsmMap()).doesNotContainKey("dev-r99:PM2_5");
        }
    }

    @Nested
    @DisplayName("Hạng mục 4 (P0-4): Chống kẹt cảnh báo FIRING / ACKNOWLEDGED vĩnh viễn")
    class AntiStuckAlertTests {

        @Test
        @DisplayName("Test 1 (Xóa hoặc Deactivate thiết bị đang có cảnh báo FIRING/ACKNOWLEDGED): tự đóng sang RESOLVED và publish realtime")
        void resolveActiveAlertsForDevice_clearsFsmAndResolvesDbAlerts() {
            when(alertRepository.save(any(Alert.class))).thenAnswer(inv -> {
                Alert a = inv.getArgument(0);
                if (a.getId() == null) {
                    a.setId("alert-" + a.getMetricType());
                }
                return a;
            });

            // 1. Tạo cảnh báo FIRING (TEMPERATURE) và trạng thái PENDING (NOISE_AVG) trên dev-1
            alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", "ZONE_A", createEnvironmentData(35.0));
            alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", "ZONE_A", createAcousticsData(68.0, 78.0));
            mutableClock.advance(Duration.ofSeconds(30));
            alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", "ZONE_A", createEnvironmentData(35.5));

            ArgumentCaptor<Alert> savedCaptor = ArgumentCaptor.forClass(Alert.class);
            verify(alertRepository, times(1)).save(savedCaptor.capture());
            Alert tempAlert = savedCaptor.getValue();
            when(alertRepository.findById(tempAlert.getId())).thenReturn(Optional.of(tempAlert));

            // Bổ sung 1 cảnh báo ACKNOWLEDGED chỉ tồn tại trong DB (mô phỏng trường hợp lệch FSM) + 1 thiết bị khác không liên quan
            Alert ackedPm25 = Alert.builder()
                    .id("alert-db-ack")
                    .deviceId("dev-1")
                    .hardwareId("HW-1")
                    .roomId("room-1")
                    .zoneId("ZONE_A")
                    .type(AlertType.AIR_UNHEALTHY)
                    .metricType("PM2_5")
                    .status(AlertStatus.ACKNOWLEDGED)
                    .build();
            Alert otherDeviceAlert = Alert.builder()
                    .id("alert-other-dev")
                    .deviceId("dev-2")
                    .hardwareId("HW-2")
                    .roomId("room-1")
                    .zoneId("ZONE_A")
                    .type(AlertType.AIR_UNHEALTHY)
                    .metricType("TEMPERATURE")
                    .status(AlertStatus.FIRING)
                    .build();
            when(alertRepository.findByStatusIn(List.of(AlertStatus.FIRING, AlertStatus.ACKNOWLEDGED)))
                    .thenReturn(List.of(tempAlert, ackedPm25, otherDeviceAlert));

            // 2. Xóa hoặc deactivate thiết bị dev-1
            alertService.resolveActiveAlertsForDevice("dev-1", "HW-1");

            // FSM của dev-1 sạch hoàn toàn (cả FIRING, PENDING, xung ồn); DB chuyển RESOLVED bởi SYSTEM; dev-2 không bị ảnh hưởng
            assertThat(alertRuleEngine.getFsmMap()).isEmpty();
            assertThat(alertRuleEngine.getNoisePeakPulsesMap()).isEmpty();
            assertThat(tempAlert.getStatus()).isEqualTo(AlertStatus.RESOLVED);
            assertThat(tempAlert.getResolvedBy()).isEqualTo("SYSTEM");
            assertThat(tempAlert.getResolvedAt()).isEqualTo(mutableClock.instant());
            assertThat(ackedPm25.getStatus()).isEqualTo(AlertStatus.RESOLVED);
            assertThat(ackedPm25.getResolvedBy()).isEqualTo("SYSTEM");
            assertThat(otherDeviceAlert.getStatus()).isEqualTo(AlertStatus.FIRING);

            // 1 lần FIRING + 2 lần RESOLVED được publish realtime để unread-count giảm ngay
            verify(realtimePublisher, times(3)).publishAlert(any(AlertResponse.class));
        }

        @Test
        @DisplayName("Test 2 (Đổi loại phòng BOOK_STORAGE -> STUDY_ROOM): Tự đóng ngay cảnh báo độ ẩm cả qua onRoomTypeChanged và evaluateTelemetry")
        void roomTypeChangedFromBookStorage_autoResolvesHumidityAlerts() {
            Room storageRoom = Room.builder()
                    .id("room-storage-1")
                    .code("TQB_201")
                    .name("Kho sách Tầng 2")
                    .type(RoomType.BOOK_STORAGE)
                    .build();
            when(roomRepository.findById("room-storage-1")).thenReturn(Optional.of(storageRoom));
            when(alertRepository.save(any(Alert.class))).thenAnswer(inv -> {
                Alert a = inv.getArgument(0);
                if (a.getId() == null) {
                    a.setId("alert-" + a.getMetricType());
                }
                return a;
            });

            // Kích hoạt FIRING HUMIDITY_HIGH và FIRING TEMPERATURE trong cùng phòng
            TelemetryPayload.TelemetryData breachData = TelemetryPayload.TelemetryData.builder()
                    .environment(TelemetryPayload.EnvironmentData.builder().temperature(35.0).humidity(68.0).build())
                    .build();
            alertService.evaluateTelemetry("dev-s1", "HW-S1", "room-storage-1", "ZONE_A", breachData);
            mutableClock.advance(Duration.ofSeconds(30));
            alertService.evaluateTelemetry("dev-s1", "HW-S1", "room-storage-1", "ZONE_A", breachData);

            ArgumentCaptor<Alert> savedCaptor = ArgumentCaptor.forClass(Alert.class);
            verify(alertRepository, times(2)).save(savedCaptor.capture());
            Alert humAlert = savedCaptor.getAllValues().stream()
                    .filter(a -> "HUMIDITY_HIGH".equals(a.getMetricType()))
                    .findFirst()
                    .orElseThrow();
            Alert tempAlert = savedCaptor.getAllValues().stream()
                    .filter(a -> "TEMPERATURE".equals(a.getMetricType()))
                    .findFirst()
                    .orElseThrow();
            when(alertRepository.findById(humAlert.getId())).thenReturn(Optional.of(humAlert));

            // 2a. Khi RoomService gọi onRoomTypeChanged(..., STUDY_ROOM) -> HUMIDITY_HIGH đóng ngay, TEMPERATURE giữ nguyên
            alertRuleEngine.onRoomTypeChanged("room-storage-1", RoomType.STUDY_ROOM);

            assertThat(alertRuleEngine.getFsmMap()).doesNotContainKey("dev-s1:HUMIDITY_HIGH");
            assertThat(alertRuleEngine.getFsmMap()).containsKey("dev-s1:TEMPERATURE");
            assertThat(humAlert.getStatus()).isEqualTo(AlertStatus.RESOLVED);
            assertThat(humAlert.getResolvedBy()).isEqualTo("SYSTEM");
            assertThat(tempAlert.getStatus()).isEqualTo(AlertStatus.FIRING);

            // 2b. Kiểm tra nhánh else trong evaluateTelemetry nếu vẫn còn HUMIDITY_LOW sót trong fsmMap khi phòng đổi sang STUDY_ROOM
            Alert leftoverHumLow = Alert.builder()
                    .id("alert-hum-low-leftover")
                    .deviceId("dev-s2")
                    .hardwareId("HW-S2")
                    .roomId("room-storage-2")
                    .type(AlertType.AIR_UNHEALTHY)
                    .metricType("HUMIDITY_LOW")
                    .status(AlertStatus.FIRING)
                    .build();
            AlertRuleEngine.FsmState leftoverState = new AlertRuleEngine.FsmState();
            leftoverState.setStatus(AlertStatus.FIRING);
            leftoverState.setAlertId("alert-hum-low-leftover");
            leftoverState.setRoomId("room-storage-2");
            leftoverState.setMetricType("HUMIDITY_LOW");
            alertRuleEngine.getFsmMap().put("dev-s2:HUMIDITY_LOW", leftoverState);

            Room studyRoom = Room.builder().id("room-storage-2").type(RoomType.STUDY_ROOM).build();
            when(roomRepository.findById("room-storage-2")).thenReturn(Optional.of(studyRoom));
            when(alertRepository.findById("alert-hum-low-leftover")).thenReturn(Optional.of(leftoverHumLow));

            alertService.evaluateTelemetry("dev-s2", "HW-S2", "room-storage-2", "ZONE_A", createEnvironmentData(25.0));

            assertThat(alertRuleEngine.getFsmMap()).doesNotContainKey("dev-s2:HUMIDITY_LOW");
            assertThat(leftoverHumLow.getStatus()).isEqualTo(AlertStatus.RESOLVED);
            assertThat(leftoverHumLow.getResolvedBy()).isEqualTo("SYSTEM");
        }

        @Test
        @DisplayName("Test 3 (Thiết bị mất kết nối khi đang báo động nhiệt độ): Tự đóng TEMPERATURE và kích hoạt DEVICE_OFFLINE")
        void triggerDeviceOfflineAlert_autoResolvesEnvironmentalAlerts() {
            when(alertRepository.save(any(Alert.class))).thenAnswer(inv -> {
                Alert a = inv.getArgument(0);
                if (a.getId() == null) {
                    a.setId("alert-" + a.getMetricType());
                }
                return a;
            });

            // Thiết bị dev-1 đang có TEMPERATURE FIRING + NOISE_AVG PENDING
            alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", "ZONE_A", createEnvironmentData(35.0));
            alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", "ZONE_A", createAcousticsData(68.0, null));
            mutableClock.advance(Duration.ofSeconds(30));
            alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", "ZONE_A", createEnvironmentData(35.0));

            ArgumentCaptor<Alert> savedCaptor = ArgumentCaptor.forClass(Alert.class);
            verify(alertRepository, times(1)).save(savedCaptor.capture());
            Alert tempAlert = savedCaptor.getValue();
            when(alertRepository.findById(tempAlert.getId())).thenReturn(Optional.of(tempAlert));

            // Thiết bị mất kết nối -> trigger DEVICE_OFFLINE
            mutableClock.advance(Duration.ofMinutes(2));
            alertService.triggerDeviceOfflineAlert("dev-1", "HW-1", "room-1", "ZONE_A");

            // Cảnh báo TEMPERATURE chuyển RESOLVED bởi SYSTEM, PENDING bị xóa, thay thế bằng DEVICE_OFFLINE
            assertThat(tempAlert.getStatus()).isEqualTo(AlertStatus.RESOLVED);
            assertThat(tempAlert.getResolvedBy()).isEqualTo("SYSTEM");
            assertThat(alertRuleEngine.getFsmMap()).doesNotContainKey("dev-1:TEMPERATURE");
            assertThat(alertRuleEngine.getFsmMap()).doesNotContainKey("dev-1:NOISE_AVG");
            assertThat(alertRuleEngine.getFsmMap()).containsKey("dev-1:DEVICE_OFFLINE");
            assertThat(alertRuleEngine.getFsmMap().get("dev-1:DEVICE_OFFLINE").getStatus()).isEqualTo(AlertStatus.FIRING);

            verify(alertRepository, times(3)).save(savedCaptor.capture());
            Alert offlineAlert = savedCaptor.getAllValues().get(savedCaptor.getAllValues().size() - 1);
            assertThat(offlineAlert.getType()).isEqualTo(AlertType.DEVICE_OFFLINE);
            assertThat(offlineAlert.getStatus()).isEqualTo(AlertStatus.FIRING);
            verify(realtimePublisher, times(3)).publishAlert(any(AlertResponse.class));
        }

        @Test
        @DisplayName("Test 4 (Mắt cảm biến đơn lẻ hỏng trả về null > 2 phút khi thiết bị vẫn online): Tự đóng cảnh báo treo")
        void evaluateTelemetry_missingMetricOverTwoMinutes_autoResolvesStuckAlert() {
            when(alertRepository.save(any(Alert.class))).thenAnswer(inv -> {
                Alert a = inv.getArgument(0);
                if (a.getId() == null) {
                    a.setId("alert-temp-stuck");
                }
                return a;
            });

            // 1. Kích hoạt FIRING TEMPERATURE ở t = 30s
            alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", "ZONE_A", createEnvironmentData(35.0));
            mutableClock.advance(Duration.ofSeconds(30));
            alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", "ZONE_A", createEnvironmentData(35.5));

            ArgumentCaptor<Alert> savedCaptor = ArgumentCaptor.forClass(Alert.class);
            verify(alertRepository, times(1)).save(savedCaptor.capture());
            Alert tempAlert = savedCaptor.getValue();
            when(alertRepository.findById("alert-temp-stuck")).thenReturn(Optional.of(tempAlert));
            Instant lastTempEvalAt = alertRuleEngine.getFsmMap().get("dev-1:TEMPERATURE").getLastEvaluatedAt();
            assertThat(lastTempEvalAt).isEqualTo(mutableClock.instant());

            // 2. Mắt cảm biến nhiệt hỏng -> 2 phút đúng (đ biên 120s) chỉ có acoustics -> CHƯA đóng
            mutableClock.advance(Duration.ofMinutes(2));
            alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", "ZONE_A", createAcousticsData(45.0, null));
            assertThat(tempAlert.getStatus()).isEqualTo(AlertStatus.FIRING);
            assertThat(alertRuleEngine.getFsmMap()).containsKey("dev-1:TEMPERATURE");
            assertThat(alertRuleEngine.getFsmMap().get("dev-1:TEMPERATURE").getLastEvaluatedAt()).isEqualTo(lastTempEvalAt);

            // 3. Quá 2 phút (2m + 1s) bản tin vẫn thiếu temperature -> Tự động đóng sang RESOLVED bởi SYSTEM
            mutableClock.advance(Duration.ofSeconds(1));
            alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", "ZONE_A", createAcousticsData(45.0, null));

            assertThat(alertRuleEngine.getFsmMap()).doesNotContainKey("dev-1:TEMPERATURE");
            assertThat(tempAlert.getStatus()).isEqualTo(AlertStatus.RESOLVED);
            assertThat(tempAlert.getResolvedBy()).isEqualTo("SYSTEM");
            verify(alertRepository, times(2)).save(any(Alert.class));
            verify(realtimePublisher, times(2)).publishAlert(any(AlertResponse.class));
        }

        @Test
        @DisplayName("Ca biên Test 4: Nếu metric vẫn gửi đều đặn (lastEvaluatedAt được làm mới), cảnh báo KHÔNG bị tự đóng nhầm")
        void evaluateTelemetry_activeMetricStillPresent_keepsAlertFiringBeyondTwoMinutes() {
            when(alertRepository.save(any(Alert.class))).thenAnswer(inv -> {
                Alert a = inv.getArgument(0);
                if (a.getId() == null) {
                    a.setId("alert-temp-active");
                }
                return a;
            });

            alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", "ZONE_A", createEnvironmentData(35.0));
            mutableClock.advance(Duration.ofSeconds(30));
            alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", "ZONE_A", createEnvironmentData(35.0));

            for (int i = 0; i < 4; i++) {
                mutableClock.advance(Duration.ofMinutes(1));
                alertService.evaluateTelemetry("dev-1", "HW-1", "room-1", "ZONE_A", createEnvironmentData(34.5));
            }

            assertThat(alertRuleEngine.getFsmMap()).containsKey("dev-1:TEMPERATURE");
            assertThat(alertRuleEngine.getFsmMap().get("dev-1:TEMPERATURE").getStatus()).isEqualTo(AlertStatus.FIRING);
            verify(alertRepository, times(1)).save(any(Alert.class));
        }
    }

    @Nested
    @DisplayName("Hạng mục 5 (P1-1): metricType & unit trong AlertResponse DTO")
    class AlertMetricTypeAndUnitTests {

        @Test
        @DisplayName("Test 1a (toAlertResponse): Trả về đúng metricType & unit cho tất cả 7 metricType tường minh")
        void toAlertResponse_mapsAllExplicitMetricTypesAndUnits() {
            Alert noiseAvg = Alert.builder()
                    .id("a-noise-avg")
                    .type(AlertType.NOISE_EXCEEDED)
                    .metricType("NOISE_AVG")
                    .status(AlertStatus.FIRING)
                    .build();
            Alert noisePeak = Alert.builder()
                    .id("a-noise-peak")
                    .type(AlertType.NOISE_EXCEEDED)
                    .metricType("NOISE_PEAK")
                    .status(AlertStatus.FIRING)
                    .build();
            Alert temp = Alert.builder()
                    .id("a-temp")
                    .type(AlertType.AIR_UNHEALTHY)
                    .metricType("TEMPERATURE")
                    .status(AlertStatus.FIRING)
                    .build();
            Alert humHigh = Alert.builder()
                    .id("a-hum-high")
                    .type(AlertType.AIR_UNHEALTHY)
                    .metricType("HUMIDITY_HIGH")
                    .status(AlertStatus.FIRING)
                    .build();
            Alert humLow = Alert.builder()
                    .id("a-hum-low")
                    .type(AlertType.AIR_UNHEALTHY)
                    .metricType("HUMIDITY_LOW")
                    .status(AlertStatus.FIRING)
                    .build();
            Alert pm25 = Alert.builder()
                    .id("a-pm25")
                    .type(AlertType.AIR_UNHEALTHY)
                    .metricType("PM2_5")
                    .status(AlertStatus.FIRING)
                    .build();
            Alert offline = Alert.builder()
                    .id("a-offline")
                    .type(AlertType.DEVICE_OFFLINE)
                    .metricType("DEVICE_OFFLINE")
                    .status(AlertStatus.FIRING)
                    .build();

            AlertResponse noiseAvgRes = AlertRuleEngine.toAlertResponse(noiseAvg);
            AlertResponse noisePeakRes = AlertRuleEngine.toAlertResponse(noisePeak);
            AlertResponse tempRes = AlertRuleEngine.toAlertResponse(temp);
            AlertResponse humHighRes = AlertRuleEngine.toAlertResponse(humHigh);
            AlertResponse humLowRes = AlertRuleEngine.toAlertResponse(humLow);
            AlertResponse pm25Res = AlertRuleEngine.toAlertResponse(pm25);
            AlertResponse offlineRes = AlertRuleEngine.toAlertResponse(offline);

            assertThat(noiseAvgRes.getMetricType()).isEqualTo("NOISE_AVG");
            assertThat(noiseAvgRes.getUnit()).isEqualTo("dBA");

            assertThat(noisePeakRes.getMetricType()).isEqualTo("NOISE_PEAK");
            assertThat(noisePeakRes.getUnit()).isEqualTo("dBA");

            assertThat(tempRes.getMetricType()).isEqualTo("TEMPERATURE");
            assertThat(tempRes.getUnit()).isEqualTo("°C");

            assertThat(humHighRes.getMetricType()).isEqualTo("HUMIDITY_HIGH");
            assertThat(humHighRes.getUnit()).isEqualTo("%RH");

            assertThat(humLowRes.getMetricType()).isEqualTo("HUMIDITY_LOW");
            assertThat(humLowRes.getUnit()).isEqualTo("%RH");

            assertThat(pm25Res.getMetricType()).isEqualTo("PM2_5");
            assertThat(pm25Res.getUnit()).isEqualTo("µg/m³");

            assertThat(offlineRes.getMetricType()).isEqualTo("DEVICE_OFFLINE");
            assertThat(offlineRes.getUnit()).isNull();
        }

        @Test
        @DisplayName("Test 1b (toAlertResponse fallback bản ghi cũ): Suy luận đúng metricType & unit khi DB chưa lưu metricType")
        void toAlertResponse_legacyRecordWithoutMetricType_infersMetricTypeUnitAndSop() {
            Alert legacyTemp = Alert.builder()
                    .id("legacy-temp")
                    .type(AlertType.AIR_UNHEALTHY)
                    .metricType(null)
                    .message("Temperature (34.2 °C) exceeded threshold (32.0 °C)")
                    .status(AlertStatus.FIRING)
                    .build();
            Alert legacyHumHigh = Alert.builder()
                    .id("legacy-hum-high")
                    .type(AlertType.AIR_UNHEALTHY)
                    .metricType("")
                    .message("Book storage humidity (65.0 %RH) exceeded max threshold (60.0 %RH)")
                    .status(AlertStatus.FIRING)
                    .build();
            Alert legacyHumLow = Alert.builder()
                    .id("legacy-hum-low")
                    .type(AlertType.AIR_UNHEALTHY)
                    .metricType(null)
                    .message("Book storage humidity (39.0 %RH) dropped below min threshold (45.0 %RH)")
                    .status(AlertStatus.FIRING)
                    .build();
            Alert legacyPm25 = Alert.builder()
                    .id("legacy-pm25")
                    .type(AlertType.AIR_UNHEALTHY)
                    .metricType(null)
                    .message("PM2.5 particulate level (60.0 µg/m³) exceeded threshold (50.0 µg/m³)")
                    .status(AlertStatus.FIRING)
                    .build();
            Alert legacyNoisePeak = Alert.builder()
                    .id("legacy-noise-peak")
                    .type(AlertType.NOISE_EXCEEDED)
                    .metricType(null)
                    .message("Peak noise spike (88.0 dBA) exceeded threshold (85.0 dBA)")
                    .status(AlertStatus.FIRING)
                    .build();
            Alert legacyOffline = Alert.builder()
                    .id("legacy-offline")
                    .type(AlertType.DEVICE_OFFLINE)
                    .metricType(null)
                    .message("Device is offline: hardwareId=HW-99")
                    .status(AlertStatus.FIRING)
                    .build();

            AlertResponse tempRes = AlertRuleEngine.toAlertResponse(legacyTemp);
            assertThat(tempRes.getMetricType()).isEqualTo("TEMPERATURE");
            assertThat(tempRes.getUnit()).isEqualTo("°C");
            assertThat(tempRes.getRecommendedAction()).contains("Điều hòa");

            AlertResponse humHighRes = AlertRuleEngine.toAlertResponse(legacyHumHigh);
            assertThat(humHighRes.getMetricType()).isEqualTo("HUMIDITY_HIGH");
            assertThat(humHighRes.getUnit()).isEqualTo("%RH");

            AlertResponse humLowRes = AlertRuleEngine.toAlertResponse(legacyHumLow);
            assertThat(humLowRes.getMetricType()).isEqualTo("HUMIDITY_LOW");
            assertThat(humLowRes.getUnit()).isEqualTo("%RH");

            AlertResponse pm25Res = AlertRuleEngine.toAlertResponse(legacyPm25);
            assertThat(pm25Res.getMetricType()).isEqualTo("PM2_5");
            assertThat(pm25Res.getUnit()).isEqualTo("µg/m³");

            AlertResponse peakRes = AlertRuleEngine.toAlertResponse(legacyNoisePeak);
            assertThat(peakRes.getMetricType()).isEqualTo("NOISE_PEAK");
            assertThat(peakRes.getUnit()).isEqualTo("dBA");

            AlertResponse offlineRes = AlertRuleEngine.toAlertResponse(legacyOffline);
            assertThat(offlineRes.getMetricType()).isEqualTo("DEVICE_OFFLINE");
            assertThat(offlineRes.getUnit()).isNull();
        }

        @Test
        @DisplayName("Test 1c (Realtime FSM publish): Cảnh báo FIRING phát ra đều đính kèm metricType & unit chính xác")
        void evaluateTelemetry_andOffline_publishAlertResponsesWithUnitAndMetricType() {
            Room storage = Room.builder().id("room-storage-u").type(RoomType.BOOK_STORAGE).build();
            when(roomRepository.findById("room-storage-u")).thenReturn(Optional.of(storage));
            when(alertRepository.save(any(Alert.class))).thenAnswer(inv -> {
                Alert a = inv.getArgument(0);
                if (a.getId() == null) {
                    a.setId("a-" + a.getMetricType());
                }
                return a;
            });

            TelemetryPayload.TelemetryData data = TelemetryPayload.TelemetryData.builder()
                    .acoustics(TelemetryPayload.AcousticsData.builder().noisePeak(88.0).build())
                    .environment(TelemetryPayload.EnvironmentData.builder().temperature(35.0).humidity(66.0).build())
                    .airQuality(TelemetryPayload.AirQualityData.builder().pm2_5(65.0).build())
                    .build();

            alertService.evaluateTelemetry("dev-u", "HW-U", "room-storage-u", "ZONE_A", data);
            mutableClock.advance(Duration.ofSeconds(30));
            alertService.evaluateTelemetry("dev-u", "HW-U", "room-storage-u", "ZONE_A", data);

            ArgumentCaptor<AlertResponse> publishedCaptor = ArgumentCaptor.forClass(AlertResponse.class);
            verify(realtimePublisher, times(4)).publishAlert(publishedCaptor.capture());

            List<AlertResponse> published = publishedCaptor.getAllValues();
            assertThat(published).extracting(AlertResponse::getMetricType, AlertResponse::getUnit)
                    .containsExactlyInAnyOrder(
                            org.assertj.core.groups.Tuple.tuple("NOISE_PEAK", "dBA"),
                            org.assertj.core.groups.Tuple.tuple("TEMPERATURE", "°C"),
                            org.assertj.core.groups.Tuple.tuple("HUMIDITY_HIGH", "%RH"),
                            org.assertj.core.groups.Tuple.tuple("PM2_5", "µg/m³")
                    );
        }
    }

    @Nested
    @DisplayName("Hạng mục 6 (P1-2): Leo thang Severity, Chống Lost Update & Chống Flapping DEVICE_OFFLINE")
    class EscalationLostUpdateAndFlappingTests {

        @Test
        @DisplayName("Test 1 (Leo thang HIGH -> CRITICAL): 3 xung 78 dBA rồi xung 89 dBA nâng cấp cùng Alert lên CRITICAL (rank 4, value 89.0) & publish lại")
        void evaluateTelemetry_noisePeakEscalatesFromHighToCritical_updatesExistingAlertAndRepublishes() {
            Alert[] dbHolder = new Alert[1];
            when(alertRepository.save(any(Alert.class))).thenAnswer(inv -> {
                Alert a = inv.getArgument(0);
                if (a.getId() == null) {
                    a.setId("alert-peak-esc-1");
                }
                dbHolder[0] = a;
                return a;
            });
            when(alertRepository.findById("alert-peak-esc-1")).thenAnswer(inv -> Optional.ofNullable(dbHolder[0]));

            // 3 xung 78 dBA cách nhau 4s (>= 3s cooldown) -> PENDING Tầng 1, tiếp tục duy trì đủ 60s -> FIRING ở mức HIGH (threshold 75.0)
            alertService.evaluateTelemetry("dev-esc", "HW-ESC", "room-1", "ZONE_A", createAcousticsData(50.0, 78.0));
            mutableClock.advance(Duration.ofSeconds(4));
            alertService.evaluateTelemetry("dev-esc", "HW-ESC", "room-1", "ZONE_A", createAcousticsData(50.0, 78.0));
            mutableClock.advance(Duration.ofSeconds(4));
            alertService.evaluateTelemetry("dev-esc", "HW-ESC", "room-1", "ZONE_A", createAcousticsData(50.0, 78.0));
            for (int i = 0; i < 4; i++) {
                mutableClock.advance(Duration.ofSeconds(15));
                alertService.evaluateTelemetry("dev-esc", "HW-ESC", "room-1", "ZONE_A", createAcousticsData(50.0, 78.0));
            }

            verify(alertRepository, times(1)).save(any(Alert.class));
            assertThat(dbHolder[0].getSeverity()).isEqualTo(AlertSeverity.HIGH);
            assertThat(dbHolder[0].getSeverityRank()).isEqualTo(3);
            assertThat(dbHolder[0].getCurrentValue()).isEqualTo(78.0);
            assertThat(dbHolder[0].getThreshold()).isEqualTo(75.0);

            // Đã ở trạng thái FIRING -> Nhân viên tiếp nhận (ACK) trước khi có xung nổ mới
            AlertResponse acked = alertService.acknowledgeAlert("alert-peak-esc-1", "librarian01");
            assertThat(acked.getStatus()).isEqualTo(AlertStatus.ACKNOWLEDGED);

            // Phát xung 89.0 dBA (>= 85.0) -> Phải leo thang lên CRITICAL trên CÙNG Alert, bảo toàn ACKNOWLEDGED và phát lại qua WebSocket
            mutableClock.advance(Duration.ofSeconds(2));
            alertService.evaluateTelemetry("dev-esc", "HW-ESC", "room-1", "ZONE_A", createAcousticsData(50.0, 89.0));

            assertThat(dbHolder[0].getId()).isEqualTo("alert-peak-esc-1");
            assertThat(dbHolder[0].getSeverity()).isEqualTo(AlertSeverity.CRITICAL);
            assertThat(dbHolder[0].getSeverityRank()).isEqualTo(4);
            assertThat(dbHolder[0].getCurrentValue()).isEqualTo(89.0);
            assertThat(dbHolder[0].getThreshold()).isEqualTo(85.0);
            assertThat(dbHolder[0].getMessage()).contains("89.0");
            assertThat(dbHolder[0].getStatus()).isEqualTo(AlertStatus.ACKNOWLEDGED);
            assertThat(dbHolder[0].getAcknowledgedBy()).isEqualTo("librarian01");

            // Xung 92.0 dBA tiếp theo (cùng rank CRITICAL = 4) không spam DB/WebSocket nữa
            mutableClock.advance(Duration.ofSeconds(4));
            alertService.evaluateTelemetry("dev-esc", "HW-ESC", "room-1", "ZONE_A", createAcousticsData(50.0, 92.0));

            // Tổng số lần save: 1 (FIRING HIGH) + 1 (ACK) + 1 (ESCALATE CRITICAL) = 3
            verify(alertRepository, times(3)).save(any(Alert.class));

            ArgumentCaptor<AlertResponse> pubCaptor = ArgumentCaptor.forClass(AlertResponse.class);
            verify(realtimePublisher, times(3)).publishAlert(pubCaptor.capture());
            AlertResponse escalatedPublish = pubCaptor.getAllValues().get(2);
            assertThat(escalatedPublish.getId()).isEqualTo("alert-peak-esc-1");
            assertThat(escalatedPublish.getSeverity()).isEqualTo(AlertSeverity.CRITICAL);
            assertThat(escalatedPublish.getSeverityRank()).isEqualTo(4);
            assertThat(escalatedPublish.getCurrentValue()).isEqualTo(89.0);
            assertThat(escalatedPublish.getStatus()).isEqualTo(AlertStatus.ACKNOWLEDGED);
        }

        @Test
        @DisplayName("Test 2 (Chống Flapping DEVICE_OFFLINE 30s): Offline -> Online -> Offline <= 30s mở lại Alert A; > 30s tạo Alert B mới")
        void triggerDeviceOfflineAlert_within30sReopensResolvedAlert_beyond30sCreatesNewAlert() {
            AtomicInteger seq = new AtomicInteger(0);
            Alert[] alertA = new Alert[1];
            Alert[] alertB = new Alert[1];

            when(alertRepository.save(any(Alert.class))).thenAnswer(inv -> {
                Alert a = inv.getArgument(0);
                if (a.getId() == null) {
                    int n = seq.incrementAndGet();
                    a.setId(n == 1 ? "alert-off-A" : "alert-off-B");
                }
                if ("alert-off-A".equals(a.getId())) {
                    alertA[0] = a;
                } else if ("alert-off-B".equals(a.getId())) {
                    alertB[0] = a;
                }
                return a;
            });

            // t = 0s: Thiết bị offline -> tạo Alert A (FIRING)
            alertService.triggerDeviceOfflineAlert("dev-flap", "HW-FLAP", "room-1", "ZONE_A");
            assertThat(alertA[0]).isNotNull();
            assertThat(alertA[0].getId()).isEqualTo("alert-off-A");
            assertThat(alertA[0].getStatus()).isEqualTo(AlertStatus.FIRING);

            when(alertRepository.findById("alert-off-A")).thenAnswer(inv -> Optional.ofNullable(alertA[0]));
            when(alertRepository.findTopByDeviceIdAndTypeAndStatusOrderByStartedAtDesc(
                    "dev-flap", AlertType.DEVICE_OFFLINE, AlertStatus.RESOLVED))
                    .thenAnswer(inv -> alertA[0] != null && alertA[0].getStatus() == AlertStatus.RESOLVED
                            ? Optional.of(alertA[0])
                            : Optional.empty());

            // t = 5s: Thiết bị online lại -> Alert A chuyển RESOLVED (resolvedAt = t+5s)
            mutableClock.advance(Duration.ofSeconds(5));
            Instant firstResolvedAt = mutableClock.instant();
            alertService.resolveDeviceOfflineAlert("HW-FLAP");
            assertThat(alertA[0].getStatus()).isEqualTo(AlertStatus.RESOLVED);
            assertThat(alertA[0].getResolvedAt()).isEqualTo(firstResolvedAt);
            assertThat(alertRuleEngine.getFsmMap()).doesNotContainKey("dev-flap:DEVICE_OFFLINE");

            // t = 15s (cách resolvedAt 10s <= 30s): Rớt mạng lại -> Mở lại CHÍNH Alert A về FIRING, xóa resolvedAt/resolvedBy
            mutableClock.advance(Duration.ofSeconds(10));
            alertService.triggerDeviceOfflineAlert("dev-flap", "HW-FLAP", "room-1", "ZONE_A");

            assertThat(seq.get()).isEqualTo(1);
            assertThat(alertA[0].getStatus()).isEqualTo(AlertStatus.FIRING);
            assertThat(alertA[0].getResolvedAt()).isNull();
            assertThat(alertA[0].getResolvedBy()).isNull();
            assertThat(alertRuleEngine.getFsmMap().get("dev-flap:DEVICE_OFFLINE").getAlertId()).isEqualTo("alert-off-A");

            // t = 20s: Online lại -> resolvedAt = t+20s
            mutableClock.advance(Duration.ofSeconds(5));
            alertService.resolveDeviceOfflineAlert("HW-FLAP");
            assertThat(alertA[0].getStatus()).isEqualTo(AlertStatus.RESOLVED);

            // Kiểm tra biên đúng 30s (t = 50s): vẫn mở lại Alert A
            mutableClock.advance(Duration.ofSeconds(30));
            alertService.triggerDeviceOfflineAlert("dev-flap", "HW-FLAP", "room-1", "ZONE_A");
            assertThat(seq.get()).isEqualTo(1);
            assertThat(alertA[0].getStatus()).isEqualTo(AlertStatus.FIRING);

            // t = 55s: Online lại (resolvedAt = t+55s)
            mutableClock.advance(Duration.ofSeconds(5));
            alertService.resolveDeviceOfflineAlert("HW-FLAP");
            assertThat(alertA[0].getStatus()).isEqualTo(AlertStatus.RESOLVED);

            // t = 96s (cách resolvedAt 41s > 30s): Offline lại -> Tạo Alert B mới hoàn toàn
            mutableClock.advance(Duration.ofSeconds(41));
            alertService.triggerDeviceOfflineAlert("dev-flap", "HW-FLAP", "room-1", "ZONE_A");

            assertThat(seq.get()).isEqualTo(2);
            assertThat(alertB[0]).isNotNull();
            assertThat(alertB[0].getId()).isEqualTo("alert-off-B");
            assertThat(alertB[0].getStatus()).isEqualTo(AlertStatus.FIRING);
            assertThat(alertRuleEngine.getFsmMap().get("dev-flap:DEVICE_OFFLINE").getAlertId()).isEqualTo("alert-off-B");
        }

        @Test
        @DisplayName("Test 3a (Bảo toàn ACK khi Auto-resolve): Đã ACK bởi librarian01 -> 60s hysteresis auto-resolve vẫn giữ acknowledgedBy & acknowledgedAt")
        void autoResolveAfter60sHysteresis_preservesAcknowledgedByAndAcknowledgedAt() {
            Alert[] dbAlert = new Alert[1];
            when(alertRepository.save(any(Alert.class))).thenAnswer(inv -> {
                Alert a = inv.getArgument(0);
                if (a.getId() == null) {
                    a.setId("alert-ack-preserve");
                }
                dbAlert[0] = a;
                return a;
            });
            when(alertRepository.findById("alert-ack-preserve")).thenAnswer(inv -> Optional.ofNullable(dbAlert[0]));

            // FIRING nhiệt độ 35°C sau 30s
            alertService.evaluateTelemetry("dev-ack", "HW-ACK", "room-1", "ZONE_A", createEnvironmentData(35.0));
            mutableClock.advance(Duration.ofSeconds(30));
            alertService.evaluateTelemetry("dev-ack", "HW-ACK", "room-1", "ZONE_A", createEnvironmentData(35.0));

            // Nhân viên ACK ở t = 40s
            mutableClock.advance(Duration.ofSeconds(10));
            Instant ackTime = mutableClock.instant();
            AlertResponse ackRes = alertService.acknowledgeAlert("alert-ack-preserve", "librarian01");
            assertThat(ackRes.getStatus()).isEqualTo(AlertStatus.ACKNOWLEDGED);
            assertThat(ackRes.getAcknowledgedBy()).isEqualTo("librarian01");
            assertThat(ackRes.getAcknowledgedAt()).isEqualTo(ackTime);

            // Nhiệt độ hạ an toàn 28°C và duy trì 60s -> System auto-resolve
            mutableClock.advance(Duration.ofSeconds(5));
            alertService.evaluateTelemetry("dev-ack", "HW-ACK", "room-1", "ZONE_A", createEnvironmentData(28.0));
            mutableClock.advance(Duration.ofSeconds(60));
            alertService.evaluateTelemetry("dev-ack", "HW-ACK", "room-1", "ZONE_A", createEnvironmentData(28.0));

            assertThat(dbAlert[0].getStatus()).isEqualTo(AlertStatus.RESOLVED);
            assertThat(dbAlert[0].getResolvedBy()).isEqualTo("SYSTEM");
            assertThat(dbAlert[0].getResolvedAt()).isEqualTo(mutableClock.instant());
            assertThat(dbAlert[0].getAcknowledgedBy()).isEqualTo("librarian01");
            assertThat(dbAlert[0].getAcknowledgedAt()).isEqualTo(ackTime);

            ArgumentCaptor<AlertResponse> pubCaptor = ArgumentCaptor.forClass(AlertResponse.class);
            verify(realtimePublisher, times(3)).publishAlert(pubCaptor.capture());
            AlertResponse resolvedEvent = pubCaptor.getAllValues().get(2);
            assertThat(resolvedEvent.getStatus()).isEqualTo(AlertStatus.RESOLVED);
            assertThat(resolvedEvent.getAcknowledgedBy()).isEqualTo("librarian01");
            assertThat(resolvedEvent.getAcknowledgedAt()).isEqualTo(ackTime);
        }

        @Test
        @DisplayName("Test 3b (Chống Lost Update khi ACK đua với Auto-resolve): Cảnh báo đã chuyển RESOLVED đồng thời không bị ACK ghi đè ngược về ACKNOWLEDGED")
        void acknowledgeAlert_concurrentlyResolvedInDb_doesNotOverwriteResolvedStatus() {
            Instant resolvedInstant = Instant.parse("2026-10-22T10:02:00Z");
            Alert staleFiringCopy = Alert.builder()
                    .id("alert-race-ack")
                    .version(0L)
                    .deviceId("dev-r")
                    .roomId("room-1")
                    .zoneId("ZONE_A")
                    .type(AlertType.AIR_UNHEALTHY)
                    .metricType("TEMPERATURE")
                    .status(AlertStatus.FIRING)
                    .build();
            Alert freshResolvedCopy = Alert.builder()
                    .id("alert-race-ack")
                    .version(1L)
                    .deviceId("dev-r")
                    .roomId("room-1")
                    .zoneId("ZONE_A")
                    .type(AlertType.AIR_UNHEALTHY)
                    .metricType("TEMPERATURE")
                    .status(AlertStatus.RESOLVED)
                    .resolvedAt(resolvedInstant)
                    .resolvedBy("SYSTEM")
                    .build();

            // Kịch bản 1: Lần đọc kiểm quyền thấy FIRING, tới lần save gặp OptimisticLockingFailureException do auto-resolve vừa lưu trước, retry thấy RESOLVED
            when(alertRepository.findById("alert-race-ack"))
                    .thenReturn(Optional.of(staleFiringCopy))
                    .thenReturn(Optional.of(staleFiringCopy))
                    .thenReturn(Optional.of(freshResolvedCopy));
            when(alertRepository.save(any(Alert.class)))
                    .thenThrow(new OptimisticLockingFailureException("Concurrent modification"));

            AlertResponse response = alertService.acknowledgeAlert("alert-race-ack", "librarian01");

            assertThat(response.getStatus()).isEqualTo(AlertStatus.RESOLVED);
            assertThat(response.getResolvedBy()).isEqualTo("SYSTEM");
            assertThat(response.getResolvedAt()).isEqualTo(resolvedInstant);
            verify(alertRepository, times(1)).save(any(Alert.class));
            verify(realtimePublisher, never()).publishAlert(any());
        }

        @Test
        @DisplayName("Test 3c (Chống Lost Update khi Auto-resolve gặp OptimisticLockingFailureException): Reload bản ghi đã ACK rồi mới chuyển RESOLVED")
        void autoResolve_optimisticLockConflictWithAck_reloadsAndPreservesAckMetadata() {
            Instant ackTime = Instant.parse("2026-10-22T10:01:00Z");
            Alert firingBeforeAck = Alert.builder()
                    .id("alert-race-res")
                    .version(0L)
                    .deviceId("dev-r2")
                    .hardwareId("HW-R2")
                    .roomId("room-1")
                    .zoneId("ZONE_A")
                    .type(AlertType.DEVICE_OFFLINE)
                    .metricType("DEVICE_OFFLINE")
                    .status(AlertStatus.FIRING)
                    .build();
            Alert ackedAfterConflict = Alert.builder()
                    .id("alert-race-res")
                    .version(1L)
                    .deviceId("dev-r2")
                    .hardwareId("HW-R2")
                    .roomId("room-1")
                    .zoneId("ZONE_A")
                    .type(AlertType.DEVICE_OFFLINE)
                    .metricType("DEVICE_OFFLINE")
                    .status(AlertStatus.ACKNOWLEDGED)
                    .acknowledgedBy("librarian01")
                    .acknowledgedAt(ackTime)
                    .build();

            AlertRuleEngine.FsmState state = new AlertRuleEngine.FsmState();
            state.setAlertId("alert-race-res");
            state.setDeviceId("dev-r2");
            state.setHardwareId("HW-R2");
            state.setMetricType("DEVICE_OFFLINE");
            state.setStatus(AlertStatus.FIRING);
            alertRuleEngine.getFsmMap().put("dev-r2:DEVICE_OFFLINE", state);

            when(alertRepository.findById("alert-race-res"))
                    .thenReturn(Optional.of(firingBeforeAck))
                    .thenReturn(Optional.of(ackedAfterConflict));
            when(alertRepository.save(any(Alert.class)))
                    .thenThrow(new OptimisticLockingFailureException("Concurrent ACK updated version"))
                    .thenAnswer(inv -> inv.getArgument(0));

            alertService.resolveDeviceOfflineAlert("HW-R2");

            assertThat(ackedAfterConflict.getStatus()).isEqualTo(AlertStatus.RESOLVED);
            assertThat(ackedAfterConflict.getResolvedBy()).isEqualTo("SYSTEM");
            assertThat(ackedAfterConflict.getAcknowledgedBy()).isEqualTo("librarian01");
            assertThat(ackedAfterConflict.getAcknowledgedAt()).isEqualTo(ackTime);
            verify(alertRepository, times(2)).save(any(Alert.class));
            verify(realtimePublisher, times(1)).publishAlert(any(AlertResponse.class));
        }

        @Test
        @DisplayName("Test 3d (@Version trên Alert & migration backfill): migrateLegacyAlertsSeverity backfill version=0L qua MongoTemplate cho bản ghi cũ")
        void migrateLegacyAlertsSeverity_backfillsNullVersionViaMongoTemplate() throws NoSuchFieldException {
            assertThat(Alert.class.getDeclaredField("version")
                    .getAnnotation(org.springframework.data.annotation.Version.class)).isNotNull();

            AlertRuleEngine engineWithMongo = new AlertRuleEngine(
                    alertRepository, realtimePublisher, mutableClock, roomRepository, mongoTemplate);
            when(mongoTemplate.find(any(Query.class), eq(Alert.class))).thenReturn(List.of());

            engineWithMongo.migrateLegacyAlertsSeverity();

            verify(mongoTemplate, times(1)).updateMulti(any(Query.class), any(Update.class), eq(Alert.class));
            verify(mongoTemplate, times(1)).find(any(Query.class), eq(Alert.class));
            verify(alertRepository, never()).findAll();
        }
    }

    @Nested
    @DisplayName("Hạng mục 7 (P2-1): Tích hợp Kênh Thông báo Email chống làm phiền")
    class EmailNotificationIntegrationTests {

        @Mock
        JavaMailSender mailSender;

        @Mock
        UserRepository userRepository;

        AlertEmailNotificationService emailService;
        AlertRuleEngine emailWiredEngine;
        AlertServiceImpl emailWiredService;

        @BeforeEach
        void setUpEmailPipeline() {
            emailService = new AlertEmailNotificationService(
                    mailSender,
                    userRepository,
                    alertRepository,
                    mutableClock,
                    roomRepository,
                    true,
                    "noreply@aiotlibtqb.edu.vn",
                    30,
                    10
            );
            emailWiredEngine = new AlertRuleEngine(
                    alertRepository,
                    realtimePublisher,
                    mutableClock,
                    roomRepository,
                    mongoTemplate,
                    emailService
            );
            emailWiredService = new AlertServiceImpl(
                    alertRepository,
                    realtimePublisher,
                    emailWiredEngine,
                    mongoTemplate,
                    mutableClock,
                    userRepository,
                    null,
                    emailService
            );

            Role adminRole = Role.builder().name("ADMIN").build();
            Role libRole = Role.builder().name("LIBRARIAN").build();

            User admin = User.builder()
                    .id("u-admin")
                    .username("admin")
                    .email("admin@lib.edu.vn")
                    .isActive(true)
                    .roles(Set.of(adminRole))
                    .build();
            User staffA = User.builder()
                    .id("u-staff-a")
                    .username("staff_a")
                    .email("zone-a@lib.edu.vn")
                    .isActive(true)
                    .roles(Set.of(libRole))
                    .assignedZones(Set.of("ZONE_A"))
                    .build();
            User staffB = User.builder()
                    .id("u-staff-b")
                    .username("staff_b")
                    .email("zone-b@lib.edu.vn")
                    .isActive(true)
                    .roles(Set.of(libRole))
                    .assignedZones(Set.of("ZONE_B"))
                    .build();

            lenient().when(userRepository.findAll()).thenReturn(List.of(admin, staffA, staffB));
        }

        @Test
        @DisplayName("Test 1 (MEDIUM không bao giờ gửi mail): TEMPERATURE hoặc NOISE_AVG (MEDIUM) quá 30 phút cũng không gọi mailSender")
        void mediumSeverityAlerts_neverTriggerEmailEvenAfter30Minutes() {
            Alert[] holder = new Alert[1];
            AtomicInteger seq = new AtomicInteger(0);
            when(alertRepository.save(any(Alert.class))).thenAnswer(inv -> {
                Alert a = inv.getArgument(0);
                if (a.getId() == null) {
                    a.setId("med-alert-" + seq.incrementAndGet());
                }
                holder[0] = a;
                return a;
            });

            // TEMPERATURE 34.0°C (MEDIUM) qua 30s -> FIRING
            emailWiredService.evaluateTelemetry("dev-temp", "HW-TEMP", "room-study", "ZONE_A", createEnvironmentData(34.0));
            mutableClock.advance(Duration.ofSeconds(30));
            emailWiredService.evaluateTelemetry("dev-temp", "HW-TEMP", "room-study", "ZONE_A", createEnvironmentData(34.5));

            assertThat(holder[0]).isNotNull();
            assertThat(holder[0].getSeverity()).isEqualTo(AlertSeverity.MEDIUM);
            verify(mailSender, never()).send(any(SimpleMailMessage.class));

            // Trôi qua 35 phút & chạy scheduler -> vẫn tuyệt đối không gửi mail
            mutableClock.advance(Duration.ofMinutes(35));
            when(alertRepository.findByStatus(AlertStatus.FIRING)).thenReturn(List.of(holder[0]));
            emailService.scanUnacknowledgedHighAlerts();

            verify(mailSender, never()).send(any(SimpleMailMessage.class));
        }

        @Test
        @DisplayName("Test 2 (CRITICAL gửi ngay + khóa 30p/phòng & leo thang HIGH->CRITICAL): Gửi cho ADMIN + staff ZONE_A, không gửi ZONE_B, chặn cảnh báo 2 trong 5p")
        void criticalAndEscalation_sendImmediatelyToZoneRecipients_andBlockDuplicateIn30MinPerRoom() {
            AtomicInteger seq = new AtomicInteger(0);
            when(alertRepository.save(any(Alert.class))).thenAnswer(inv -> {
                Alert a = inv.getArgument(0);
                if (a.getId() == null) {
                    a.setId("crit-alert-" + seq.incrementAndGet());
                }
                return a;
            });

            // Cảnh báo CRITICAL NOISE_PEAK 88 dBA tại room-1 / ZONE_A
            emailWiredService.evaluateTelemetry("dev-noise-1", "HW-N1", "room-1", "ZONE_A", createAcousticsData(50.0, 88.0));

            ArgumentCaptor<SimpleMailMessage> mailCaptor = ArgumentCaptor.forClass(SimpleMailMessage.class);
            verify(mailSender, times(1)).send(mailCaptor.capture());
            assertThat(mailCaptor.getValue().getTo()).containsExactlyInAnyOrder("admin@lib.edu.vn", "zone-a@lib.edu.vn");
            assertThat(mailCaptor.getValue().getTo()).doesNotContain("zone-b@lib.edu.vn");
            assertThat(mailCaptor.getValue().getText()).contains("88.0 dBA");

            // 5 phút sau, thiết bị khác cùng phòng room-1 phát NOISE_PEAK 90 dBA (CRITICAL) -> Bộ khóa 30p chặn
            mutableClock.advance(Duration.ofMinutes(5));
            emailWiredService.evaluateTelemetry("dev-noise-2", "HW-N2", "room-1", "ZONE_A", createAcousticsData(50.0, 90.0));
            verify(mailSender, times(1)).send(any(SimpleMailMessage.class));

            // Phòng khác (room-2 / ZONE_B) leo thang từ HIGH (3x78 dBA) lên CRITICAL (89 dBA) -> Vẫn gửi mail leo thang CRITICAL ngay
            Alert[] room2Holder = new Alert[1];
            when(alertRepository.save(any(Alert.class))).thenAnswer(inv -> {
                Alert a = inv.getArgument(0);
                if (a.getId() == null) {
                    a.setId("r2-peak-1");
                }
                room2Holder[0] = a;
                return a;
            });
            when(alertRepository.findById("r2-peak-1")).thenAnswer(inv -> Optional.ofNullable(room2Holder[0]));

            emailWiredService.evaluateTelemetry("dev-noise-r2", "HW-R2", "room-2", "ZONE_B", createAcousticsData(50.0, 78.0));
            mutableClock.advance(Duration.ofSeconds(4));
            emailWiredService.evaluateTelemetry("dev-noise-r2", "HW-R2", "room-2", "ZONE_B", createAcousticsData(50.0, 78.0));
            mutableClock.advance(Duration.ofSeconds(4));
            emailWiredService.evaluateTelemetry("dev-noise-r2", "HW-R2", "room-2", "ZONE_B", createAcousticsData(50.0, 78.0));
            for (int i = 0; i < 4; i++) {
                mutableClock.advance(Duration.ofSeconds(15));
                emailWiredService.evaluateTelemetry("dev-noise-r2", "HW-R2", "room-2", "ZONE_B", createAcousticsData(50.0, 78.0));
            }

            // Mới chỉ là HIGH -> chưa gửi mail ngay
            verify(mailSender, times(1)).send(any(SimpleMailMessage.class));

            // Vọt lên 89 dBA (CRITICAL) -> Leo thang & gửi mail ngay cho ADMIN + ZONE_B
            mutableClock.advance(Duration.ofSeconds(4));
            emailWiredService.evaluateTelemetry("dev-noise-r2", "HW-R2", "room-2", "ZONE_B", createAcousticsData(50.0, 89.0));

            ArgumentCaptor<SimpleMailMessage> escalatedCaptor = ArgumentCaptor.forClass(SimpleMailMessage.class);
            verify(mailSender, times(2)).send(escalatedCaptor.capture());
            SimpleMailMessage r2Mail = escalatedCaptor.getValue();
            assertThat(r2Mail.getTo()).containsExactlyInAnyOrder("admin@lib.edu.vn", "zone-b@lib.edu.vn");
            assertThat(r2Mail.getTo()).doesNotContain("zone-a@lib.edu.vn");
            assertThat(r2Mail.getText()).contains("89.0 dBA");
        }

        @Test
        @DisplayName("Test 3 (HIGH đã ACK trước 10 phút -> Không gửi mail): HUMIDITY_HIGH ACK ở phút thứ 4 -> Phút 11 scan không gửi mail")
        void highAlertAcknowledgedBefore10Minutes_neverTriggersEscalationEmail() {
            when(roomRepository.findById("room-kho-ack")).thenReturn(Optional.of(
                    Room.builder().id("room-kho-ack").type(RoomType.BOOK_STORAGE).build()));

            Alert[] holder = new Alert[1];
            when(alertRepository.save(any(Alert.class))).thenAnswer(inv -> {
                Alert a = inv.getArgument(0);
                if (a.getId() == null) {
                    a.setId("hum-high-ack");
                }
                holder[0] = a;
                return a;
            });
            when(alertRepository.findById("hum-high-ack")).thenAnswer(inv -> Optional.ofNullable(holder[0]));

            TelemetryPayload.TelemetryData humidHigh = TelemetryPayload.TelemetryData.builder()
                    .environment(TelemetryPayload.EnvironmentData.builder().humidity(75.0).build())
                    .build();

            emailWiredService.evaluateTelemetry("dev-kho-1", "HW-KHO-1", "room-kho-ack", "ZONE_A", humidHigh);
            mutableClock.advance(Duration.ofSeconds(30));
            emailWiredService.evaluateTelemetry("dev-kho-1", "HW-KHO-1", "room-kho-ack", "ZONE_A", humidHigh);

            assertThat(holder[0].getSeverity()).isEqualTo(AlertSeverity.HIGH);
            verify(mailSender, never()).send(any(SimpleMailMessage.class));

            // Phút thứ 4: Nhân viên bấm ACK
            mutableClock.advance(Duration.ofMinutes(4));
            AlertResponse acked = emailWiredService.acknowledgeAlert("hum-high-ack", "staff_a");
            assertThat(acked.getStatus()).isEqualTo(AlertStatus.ACKNOWLEDGED);

            // Phút thứ 11: Scheduler quét các bản ghi FIRING -> không gửi email
            mutableClock.advance(Duration.ofMinutes(7));
            when(alertRepository.findByStatus(AlertStatus.FIRING)).thenReturn(List.of());
            emailService.scanUnacknowledgedHighAlerts();

            verify(mailSender, never()).send(any(SimpleMailMessage.class));
        }

        @Test
        @DisplayName("Test 4 (HIGH quá 10 phút chưa ACK -> Gửi mail leo thang & Gửi mail RESOLVED khi đóng/auto-resolve)")
        void highAlertUnackedOver10Minutes_sendsEscalationEmailAndResolvedEmail() {
            when(roomRepository.findById("room-kho-unack")).thenReturn(Optional.of(
                    Room.builder().id("room-kho-unack").code("KHO-1").name("Kho sách hiếm").type(RoomType.BOOK_STORAGE).build()));

            Alert[] holder = new Alert[1];
            when(alertRepository.save(any(Alert.class))).thenAnswer(inv -> {
                Alert a = inv.getArgument(0);
                if (a.getId() == null) {
                    a.setId("hum-high-unack");
                }
                holder[0] = a;
                return a;
            });
            when(alertRepository.findById("hum-high-unack")).thenAnswer(inv -> Optional.ofNullable(holder[0]));

            TelemetryPayload.TelemetryData humidHigh = TelemetryPayload.TelemetryData.builder()
                    .environment(TelemetryPayload.EnvironmentData.builder().humidity(76.0).build())
                    .build();

            // Khởi phát FIRING HIGH
            emailWiredService.evaluateTelemetry("dev-kho-2", "HW-KHO-2", "room-kho-unack", "ZONE_A", humidHigh);
            mutableClock.advance(Duration.ofSeconds(30));
            emailWiredService.evaluateTelemetry("dev-kho-2", "HW-KHO-2", "room-kho-unack", "ZONE_A", humidHigh);
            assertThat(holder[0].getStatus()).isEqualTo(AlertStatus.FIRING);
            assertThat(holder[0].getSeverity()).isEqualTo(AlertSeverity.HIGH);

            // Phút thứ 11 chưa có ai ACK -> Scheduler gửi 1 email leo thang
            mutableClock.advance(Duration.ofMinutes(11));
            when(alertRepository.findByStatus(AlertStatus.FIRING)).thenReturn(List.of(holder[0]));
            emailService.scanUnacknowledgedHighAlerts();

            ArgumentCaptor<SimpleMailMessage> mailCaptor = ArgumentCaptor.forClass(SimpleMailMessage.class);
            verify(mailSender, times(1)).send(mailCaptor.capture());
            assertThat(mailCaptor.getValue().getSubject()).contains("LEO THANG - HIGH").contains("KHO-1 - Kho sách hiếm");
            assertThat(mailCaptor.getValue().getText()).contains("76.0 %RH");

            // Phút thứ 14: Độ ẩm về 55% và ổn định 60s -> System auto-resolve -> Gửi ngay 1 email Đã khắc phục
            TelemetryPayload.TelemetryData safeHumid = TelemetryPayload.TelemetryData.builder()
                    .environment(TelemetryPayload.EnvironmentData.builder().humidity(55.0).build())
                    .build();
            mutableClock.advance(Duration.ofMinutes(3));
            emailWiredService.evaluateTelemetry("dev-kho-2", "HW-KHO-2", "room-kho-unack", "ZONE_A", safeHumid);
            mutableClock.advance(Duration.ofSeconds(60));
            emailWiredService.evaluateTelemetry("dev-kho-2", "HW-KHO-2", "room-kho-unack", "ZONE_A", safeHumid);

            assertThat(holder[0].getStatus()).isEqualTo(AlertStatus.RESOLVED);
            ArgumentCaptor<SimpleMailMessage> autoResolvedCaptor = ArgumentCaptor.forClass(SimpleMailMessage.class);
            verify(mailSender, times(2)).send(autoResolvedCaptor.capture());
            SimpleMailMessage resolvedEmail = autoResolvedCaptor.getValue();
            assertThat(resolvedEmail.getSubject()).contains("ĐÃ KHẮC PHỤC - RESOLVED");
            assertThat(resolvedEmail.getText()).contains("SYSTEM");

            // Manual resolve đường truyền khác cũng gửi email RESOLVED chính xác
            Alert manualCritical = Alert.builder()
                    .id("crit-manual-res")
                    .roomId("room-manual")
                    .zoneId("ZONE_A")
                    .deviceId("dev-m")
                    .type(AlertType.NOISE_EXCEEDED)
                    .metricType("NOISE_PEAK")
                    .severity(AlertSeverity.CRITICAL)
                    .status(AlertStatus.FIRING)
                    .currentValue(92.0)
                    .threshold(85.0)
                    .startedAt(mutableClock.instant())
                    .build();
            emailService.onAlertFiredOrEscalated(manualCritical);
            verify(mailSender, times(3)).send(any(SimpleMailMessage.class));

            when(alertRepository.findById("crit-manual-res")).thenReturn(Optional.of(manualCritical));
            when(alertRepository.save(manualCritical)).thenReturn(manualCritical);
            emailWiredService.resolveAlert("crit-manual-res", "staff_a", 15);

            ArgumentCaptor<SimpleMailMessage> manualResolvedCaptor = ArgumentCaptor.forClass(SimpleMailMessage.class);
            verify(mailSender, times(4)).send(manualResolvedCaptor.capture());
            assertThat(manualResolvedCaptor.getValue().getSubject()).contains("ĐÃ KHẮC PHỤC - RESOLVED");
            assertThat(manualResolvedCaptor.getValue().getText()).contains("staff_a");
        }
    }

    @Nested
    @DisplayName("Hạng mục 9 (P3-1): Cảnh báo SENSOR_MALFUNCTION & Tối ưu Migration Khởi động")
    class SensorMalfunctionAndStartupMigrationTests {

        @Test
        @DisplayName("Test 1 (SENSOR_MALFUNCTION 30s FIRING -> 60s hợp lệ RESOLVED): temperature = -99.0°C qua sanitizer suốt 30s kích hoạt MEDIUM & 25.0°C suốt 60s tự hồi phục")
        void evaluateSensorHealth_sustainedOutOfBounds30sFiresMediumAndRecoversAfter60sValidReadings() {
            TelemetrySanitizerService realSanitizer = new TelemetrySanitizerService(mutableClock);

            Alert[] persistedHolder = new Alert[1];
            when(alertRepository.save(any(Alert.class))).thenAnswer(inv -> {
                Alert a = inv.getArgument(0);
                if (a.getId() == null) {
                    a.setId("sensor-mal-01");
                }
                persistedHolder[0] = a;
                return a;
            });
            when(alertRepository.findById("sensor-mal-01")).thenAnswer(inv -> Optional.ofNullable(persistedHolder[0]));

            TelemetryPayload.TelemetryData brokenTempPacket = createEnvironmentData(-99.0);

            // t = 0s: Lần đọc -99.0°C đầu tiên -> PENDING, chưa tạo Alert trong DB
            var s0 = realSanitizer.sanitize("dev-sm-1", brokenTempPacket);
            assertThat(s0.isHasOutOfBoundsSensor()).isTrue();
            assertThat(s0.isAllValidReadings()).isFalse();
            alertService.evaluateSensorHealth("dev-sm-1", "HW-SM-1", "room-1", "ZONE_A",
                    s0.isHasOutOfBoundsSensor(), s0.isAllValidReadings(), s0.getMalfunctioningSensors());

            assertThat(alertRuleEngine.getFsmMap()).containsKey("dev-sm-1:SENSOR_MALFUNCTION");
            assertThat(alertRuleEngine.getFsmMap().get("dev-sm-1:SENSOR_MALFUNCTION").getStatus())
                    .isEqualTo(AlertStatus.PENDING);
            verify(alertRepository, never()).save(any());

            // t = 20s (< 30s): Tiếp tục -99.0°C -> vẫn PENDING
            mutableClock.advance(Duration.ofSeconds(20));
            var s20 = realSanitizer.sanitize("dev-sm-1", brokenTempPacket);
            alertService.evaluateSensorHealth("dev-sm-1", "HW-SM-1", "room-1", "ZONE_A",
                    s20.isHasOutOfBoundsSensor(), s20.isAllValidReadings(), s20.getMalfunctioningSensors());
            assertThat(alertRuleEngine.getFsmMap().get("dev-sm-1:SENSOR_MALFUNCTION").getStatus())
                    .isEqualTo(AlertStatus.PENDING);
            verify(alertRepository, never()).save(any());

            // t = 30s: Đủ cửa sổ 30s liên tục -> FIRING MEDIUM với đúng SOP
            mutableClock.advance(Duration.ofSeconds(10));
            var s30 = realSanitizer.sanitize("dev-sm-1", brokenTempPacket);
            alertService.evaluateSensorHealth("dev-sm-1", "HW-SM-1", "room-1", "ZONE_A",
                    s30.isHasOutOfBoundsSensor(), s30.isAllValidReadings(), s30.getMalfunctioningSensors());

            assertThat(persistedHolder[0]).isNotNull();
            assertThat(persistedHolder[0].getType()).isEqualTo(AlertType.SENSOR_MALFUNCTION);
            assertThat(persistedHolder[0].getMetricType()).isEqualTo("SENSOR_MALFUNCTION");
            assertThat(persistedHolder[0].getSeverity()).isEqualTo(AlertSeverity.MEDIUM);
            assertThat(persistedHolder[0].getSeverityRank()).isEqualTo(2);
            assertThat(persistedHolder[0].getStatus()).isEqualTo(AlertStatus.FIRING);
            assertThat(persistedHolder[0].getZoneId()).isEqualTo("ZONE_A");
            assertThat(persistedHolder[0].getMessage()).contains("env.temperature");
            assertThat(persistedHolder[0].getRecommendedAction()).isEqualTo(
                    "SOP Kỹ thuật Cảm biến: Giá trị đo vượt ngoài dải vật lý hợp lệ liên tục; kiểm tra dây tín hiệu I2C/UART và hiệu chuẩn hoặc thay thế module cảm biến."
            );

            ArgumentCaptor<AlertResponse> publishedCaptor = ArgumentCaptor.forClass(AlertResponse.class);
            verify(realtimePublisher, times(1)).publishAlert(publishedCaptor.capture());
            assertThat(publishedCaptor.getValue().getType()).isEqualTo(AlertType.SENSOR_MALFUNCTION);
            assertThat(publishedCaptor.getValue().getMetricType()).isEqualTo("SENSOR_MALFUNCTION");
            assertThat(publishedCaptor.getValue().getUnit()).isNull();

            // t = 35s: Bắt đầu gửi nhiệt độ hợp lệ 25.0°C -> khởi động cửa sổ hồi phục 60s
            TelemetryPayload.TelemetryData healthyTempPacket = createEnvironmentData(25.0);
            mutableClock.advance(Duration.ofSeconds(5));
            var h0 = realSanitizer.sanitize("dev-sm-1", healthyTempPacket);
            assertThat(h0.isHasOutOfBoundsSensor()).isFalse();
            assertThat(h0.isAllValidReadings()).isTrue();
            alertService.evaluateSensorHealth("dev-sm-1", "HW-SM-1", "room-1", "ZONE_A",
                    h0.isHasOutOfBoundsSensor(), h0.isAllValidReadings(), h0.getMalfunctioningSensors());
            assertThat(persistedHolder[0].getStatus()).isEqualTo(AlertStatus.FIRING);

            // t = 65s (mới hồi phục 30s < 60s) -> vẫn FIRING
            mutableClock.advance(Duration.ofSeconds(30));
            var h30 = realSanitizer.sanitize("dev-sm-1", healthyTempPacket);
            alertService.evaluateSensorHealth("dev-sm-1", "HW-SM-1", "room-1", "ZONE_A",
                    h30.isHasOutOfBoundsSensor(), h30.isAllValidReadings(), h30.getMalfunctioningSensors());
            assertThat(persistedHolder[0].getStatus()).isEqualTo(AlertStatus.FIRING);

            // t = 95s (đủ 60s hợp lệ liên tục) -> Tự động RESOLVED bởi SYSTEM
            mutableClock.advance(Duration.ofSeconds(30));
            var h60 = realSanitizer.sanitize("dev-sm-1", healthyTempPacket);
            alertService.evaluateSensorHealth("dev-sm-1", "HW-SM-1", "room-1", "ZONE_A",
                    h60.isHasOutOfBoundsSensor(), h60.isAllValidReadings(), h60.getMalfunctioningSensors());

            assertThat(persistedHolder[0].getStatus()).isEqualTo(AlertStatus.RESOLVED);
            assertThat(persistedHolder[0].getResolvedBy()).isEqualTo("SYSTEM");
            assertThat(alertRuleEngine.getFsmMap()).doesNotContainKey("dev-sm-1:SENSOR_MALFUNCTION");
            verify(realtimePublisher, times(2)).publishAlert(any(AlertResponse.class));
        }

        @Test
        @DisplayName("Ca biên SENSOR_MALFUNCTION: Lọc nhiễu < 30s, bỏ qua gói rỗng khi đang hồi phục, reset hồi phục nếu lỗi tái diễn và chữ ký 6 tham số")
        void evaluateSensorHealth_edgeCases_filteringAndResetHysteresis() {
            Alert[] holder = new Alert[1];
            when(alertRepository.save(any(Alert.class))).thenAnswer(inv -> {
                Alert a = inv.getArgument(0);
                if (a.getId() == null) {
                    a.setId("sensor-mal-edge");
                }
                holder[0] = a;
                return a;
            });
            when(alertRepository.findById("sensor-mal-edge")).thenAnswer(inv -> Optional.ofNullable(holder[0]));

            // 1. Lỗi thoáng qua 15s rồi có mẫu đọc hợp lệ -> hủy PENDING, không lưu cảnh báo
            alertService.evaluateSensorHealth("dev-edge", "HW-EDGE", "room-1", "ZONE_A", true, false);
            assertThat(alertRuleEngine.getFsmMap()).containsKey("dev-edge:SENSOR_MALFUNCTION");
            mutableClock.advance(Duration.ofSeconds(15));
            alertService.evaluateSensorHealth("dev-edge", "HW-EDGE", "room-1", "ZONE_A", false, true);
            assertThat(alertRuleEngine.getFsmMap()).doesNotContainKey("dev-edge:SENSOR_MALFUNCTION");
            verify(alertRepository, never()).save(any());

            // 2. Kích hoạt FIRING sau 30s liên tục dùng chữ ký 6 tham số
            alertService.evaluateSensorHealth("dev-edge", "HW-EDGE", "room-1", "ZONE_A", true, false);
            mutableClock.advance(Duration.ofSeconds(30));
            alertService.evaluateSensorHealth("dev-edge", "HW-EDGE", "room-1", "ZONE_A", true, false);
            assertThat(holder[0]).isNotNull();
            assertThat(holder[0].getStatus()).isEqualTo(AlertStatus.FIRING);

            // 3. Bắt đầu hồi phục 1 lần, sau đó nhận gói (false, false) quá 60s -> KHÔNG được phép tự RESOLVED nếu chưa có mẫu hợp lệ mới
            mutableClock.advance(Duration.ofSeconds(5));
            alertService.evaluateSensorHealth("dev-edge", "HW-EDGE", "room-1", "ZONE_A", false, true);
            mutableClock.advance(Duration.ofSeconds(65));
            alertService.evaluateSensorHealth("dev-edge", "HW-EDGE", "room-1", "ZONE_A", false, false);
            assertThat(holder[0].getStatus()).isEqualTo(AlertStatus.FIRING);

            // 4. Trong lúc hồi phục nếu lỗi tái diễn (true, false) -> xóa recoverySince, phải đếm lại 60s hợp lệ
            alertService.evaluateSensorHealth("dev-edge", "HW-EDGE", "room-1", "ZONE_A", true, false);
            assertThat(alertRuleEngine.getFsmMap().get("dev-edge:SENSOR_MALFUNCTION").getRecoverySince()).isNull();

            mutableClock.advance(Duration.ofSeconds(5));
            alertService.evaluateSensorHealth("dev-edge", "HW-EDGE", "room-1", "ZONE_A", false, true);
            mutableClock.advance(Duration.ofSeconds(59));
            alertService.evaluateSensorHealth("dev-edge", "HW-EDGE", "room-1", "ZONE_A", false, true);
            assertThat(holder[0].getStatus()).isEqualTo(AlertStatus.FIRING);

            mutableClock.advance(Duration.ofSeconds(1));
            alertService.evaluateSensorHealth("dev-edge", "HW-EDGE", "room-1", "ZONE_A", false, true);
            assertThat(holder[0].getStatus()).isEqualTo(AlertStatus.RESOLVED);
        }

        @Test
        @DisplayName("Test 2 (M7 - Tối ưu Migration với MongoTemplate): Chỉ query bản ghi thiếu trường, điền đầy đủ cho SENSOR_MALFUNCTION và không gọi findAll()")
        void migrateLegacyAlertsSeverity_queriesOnlyLegacyRecordsViaMongoTemplateAndIsIdempotent() {
            AlertRuleEngine engineWithMongo = new AlertRuleEngine(
                    alertRepository, realtimePublisher, mutableClock, roomRepository, mongoTemplate);

            Alert legacySensorAlert = Alert.builder()
                    .id("legacy-sm-1")
                    .type(AlertType.SENSOR_MALFUNCTION)
                    .status(AlertStatus.FIRING)
                    .severity(null)
                    .metricType(null)
                    .recommendedAction(null)
                    .build();

            when(mongoTemplate.find(any(Query.class), eq(Alert.class)))
                    .thenReturn(List.of(legacySensorAlert))
                    .thenReturn(List.of());
            when(alertRepository.save(any(Alert.class))).thenAnswer(inv -> inv.getArgument(0));

            int firstRun = engineWithMongo.migrateLegacyAlertsSeverity();
            assertThat(firstRun).isEqualTo(1);
            assertThat(legacySensorAlert.getSeverity()).isEqualTo(AlertSeverity.MEDIUM);
            assertThat(legacySensorAlert.getSeverityRank()).isEqualTo(2);
            assertThat(legacySensorAlert.getMetricType()).isEqualTo("SENSOR_MALFUNCTION");
            assertThat(legacySensorAlert.getRecommendedAction()).isEqualTo(
                    AlertSopCatalog.resolveSop("SENSOR_MALFUNCTION", AlertType.SENSOR_MALFUNCTION, RoomType.STUDY_ROOM));

            ArgumentCaptor<Query> queryCaptor = ArgumentCaptor.forClass(Query.class);
            verify(mongoTemplate, times(1)).find(queryCaptor.capture(), eq(Alert.class));
            String queryJson = queryCaptor.getValue().getQueryObject().toJson();
            assertThat(queryJson)
                    .contains("$or")
                    .contains("severity")
                    .contains("severityRank")
                    .contains("metricType")
                    .contains("recommendedAction");

            // Chạy lần 2: query lọc trả rỗng -> không lưu thêm bản ghi nào và tuyệt đối không gọi findAll()
            int secondRun = engineWithMongo.migrateLegacyAlertsSeverity();
            assertThat(secondRun).isEqualTo(0);
            verify(alertRepository, times(1)).save(legacySensorAlert);
            verify(alertRepository, never()).findAll();
        }

        @Test
        @DisplayName("M7 (Kháng lỗi Migration): Ngoại lệ MongoDB khi migration khởi động trả 0 an toàn thay vì làm crash ứng dụng")
        void migrateLegacyAlertsSeverity_whenMongoThrows_returnsZeroSafelyWithoutCrashing() {
            AlertRuleEngine engineWithMongo = new AlertRuleEngine(
                    alertRepository, realtimePublisher, mutableClock, roomRepository, mongoTemplate);
            when(mongoTemplate.find(any(Query.class), eq(Alert.class)))
                    .thenThrow(new RuntimeException("Simulated MongoDB read failure"));

            int migrated = engineWithMongo.migrateLegacyAlertsSeverity();

            assertThat(migrated).isZero();
            verify(alertRepository, never()).save(any());
        }

        @Test
        @DisplayName("Test 3 (SOP & Response SENSOR_MALFUNCTION): AlertSopCatalog và toAlertResponse trả về đúng quy trình xử lý chuẩn")
        void alertSopCatalog_andToAlertResponse_returnExpectedSensorMalfunctionSop() {
            String expectedSop = "SOP Kỹ thuật Cảm biến: Giá trị đo vượt ngoài dải vật lý hợp lệ liên tục; kiểm tra dây tín hiệu I2C/UART và hiệu chuẩn hoặc thay thế module cảm biến.";

            assertThat(AlertSopCatalog.resolveSop("SENSOR_MALFUNCTION", AlertType.SENSOR_MALFUNCTION, RoomType.STUDY_ROOM))
                    .isEqualTo(expectedSop);
            assertThat(AlertSopCatalog.resolveSop(null, AlertType.SENSOR_MALFUNCTION, RoomType.BOOK_STORAGE))
                    .isEqualTo(expectedSop);

            AlertResponse res = AlertRuleEngine.toAlertResponse(Alert.builder()
                    .id("sm-resp-1")
                    .type(AlertType.SENSOR_MALFUNCTION)
                    .status(AlertStatus.FIRING)
                    .build());
            assertThat(res.getMetricType()).isEqualTo("SENSOR_MALFUNCTION");
            assertThat(res.getUnit()).isNull();
            assertThat(res.getRecommendedAction()).isEqualTo(expectedSop);
        }
    }

    @Nested
    @DisplayName("Hạng mục 6 (Giai đoạn 6): Alert Workflow 4 Trạng Thái, Giao Việc, Ghi Chú & Optimistic Locking")
    class AlertWorkflowPhase6Tests {

        @Mock
        UserRepository userRepository;

        @Mock
        DeviceRepository deviceRepository;

        @AfterEach
        void cleanSecurity() {
            SecurityContextHolder.clearContext();
        }

        @Test
        @DisplayName("TC-G6-01: Chuyển trạng thái tuần tự NEW -> ACKNOWLEDGED -> IN_PROGRESS (assignedTo, handlingNote) -> RESOLVED & phát STOMP")
        void updateAlertWorkflow_sequentialTransitions_persistsFieldsAndPublishesStomp() {
            Alert stored = Alert.builder()
                    .id("wf-alert-1")
                    .deviceId("dev-1")
                    .hardwareId("HW-1")
                    .roomId("room-1")
                    .zoneId("ZONE_A")
                    .type(AlertType.NOISE_EXCEEDED)
                    .metricType("NOISE_AVG")
                    .severity(AlertSeverity.HIGH)
                    .status(AlertStatus.FIRING)
                    .workflowStatus(null)
                    .currentValue(78.0)
                    .threshold(65.0)
                    .startedAt(mutableClock.instant())
                    .build();

            when(alertRepository.findById("wf-alert-1")).thenAnswer(inv -> Optional.of(stored));
            when(alertRepository.save(any(Alert.class))).thenAnswer(inv -> inv.getArgument(0));

            // 1. NEW -> ACKNOWLEDGED
            mutableClock.advance(Duration.ofSeconds(15));
            AlertResponse step1 = alertService.updateAlertWorkflow(
                    "wf-alert-1",
                    AlertWorkflowUpdateRequest.builder()
                            .workflowStatus(AlertWorkflowStatus.ACKNOWLEDGED)
                            .build(),
                    "manager.lan"
            );
            assertThat(step1.getStatus()).isEqualTo(AlertStatus.ACKNOWLEDGED);
            assertThat(step1.getWorkflowStatus()).isEqualTo(AlertWorkflowStatus.ACKNOWLEDGED);
            assertThat(step1.getAcknowledgedBy()).isEqualTo("manager.lan");
            assertThat(step1.getAcknowledgedAt()).isNotNull();

            // 2. ACKNOWLEDGED -> IN_PROGRESS với assignedTo và handlingNote
            mutableClock.advance(Duration.ofSeconds(20));
            AlertResponse step2 = alertService.updateAlertWorkflow(
                    "wf-alert-1",
                    AlertWorkflowUpdateRequest.builder()
                            .workflowStatus(AlertWorkflowStatus.IN_PROGRESS)
                            .assignedTo("ktv.nam")
                            .handlingNote("Đang chỉnh AHU")
                            .build(),
                    "manager.lan"
            );
            assertThat(step2.getStatus()).isEqualTo(AlertStatus.ACKNOWLEDGED);
            assertThat(step2.getWorkflowStatus()).isEqualTo(AlertWorkflowStatus.IN_PROGRESS);
            assertThat(step2.getAssignedTo()).isEqualTo("ktv.nam");
            assertThat(step2.getHandlingNote()).isEqualTo("Đang chỉnh AHU");
            assertThat(step2.getInProgressAt()).isNotNull();

            // 3. IN_PROGRESS -> RESOLVED
            mutableClock.advance(Duration.ofSeconds(30));
            AlertResponse step3 = alertService.updateAlertWorkflow(
                    "wf-alert-1",
                    AlertWorkflowUpdateRequest.builder()
                            .workflowStatus(AlertWorkflowStatus.RESOLVED)
                            .handlingNote("Đã xử lý xong")
                            .snoozeMinutes(20)
                            .build(),
                    "ktv.nam"
            );
            assertThat(step3.getStatus()).isEqualTo(AlertStatus.RESOLVED);
            assertThat(step3.getWorkflowStatus()).isEqualTo(AlertWorkflowStatus.RESOLVED);
            assertThat(step3.getResolvedBy()).isEqualTo("ktv.nam");
            assertThat(step3.getResolvedAt()).isNotNull();
            assertThat(step3.getHandlingNote()).isEqualTo("Đã xử lý xong");

            verify(alertRepository, times(3)).save(any(Alert.class));
            verify(realtimePublisher, times(3)).publishAlert(any(AlertResponse.class));
        }

        @Test
        @DisplayName("TC-G6-02: Tương thích ngược endpoint cũ acknowledgeAlert ánh xạ đúng workflowStatus=ACKNOWLEDGED")
        void acknowledgeAlert_backwardCompatibleMapsWorkflowStatus() {
            Alert firing = Alert.builder()
                    .id("wf-legacy-ack")
                    .deviceId("dev-1")
                    .roomId("room-1")
                    .type(AlertType.NOISE_EXCEEDED)
                    .status(AlertStatus.FIRING)
                    .workflowStatus(null)
                    .startedAt(mutableClock.instant())
                    .build();
            when(alertRepository.findById("wf-legacy-ack")).thenReturn(Optional.of(firing));
            when(alertRepository.save(any(Alert.class))).thenAnswer(inv -> inv.getArgument(0));

            AlertResponse res = alertService.acknowledgeAlert("wf-legacy-ack", "thuthu.lan");
            assertThat(res.getStatus()).isEqualTo(AlertStatus.ACKNOWLEDGED);
            assertThat(res.getWorkflowStatus()).isEqualTo(AlertWorkflowStatus.ACKNOWLEDGED);
            assertThat(res.getAcknowledgedBy()).isEqualTo("thuthu.lan");
            assertThat(AlertRuleEngine.toAlertResponse(firing).getWorkflowStatus())
                    .isEqualTo(AlertWorkflowStatus.ACKNOWLEDGED);
        }

        @Test
        @DisplayName("TC-G6-03: Bất biến M4 — Cảnh báo đã RESOLVED không bị ghi đè ngược về IN_PROGRESS")
        void updateAlertWorkflow_alreadyResolved_blocksBackwardMutationM4() {
            Alert resolved = Alert.builder()
                    .id("wf-resolved-1")
                    .deviceId("dev-1")
                    .roomId("room-1")
                    .type(AlertType.AIR_UNHEALTHY)
                    .status(AlertStatus.RESOLVED)
                    .workflowStatus(AlertWorkflowStatus.RESOLVED)
                    .resolvedBy("SYSTEM")
                    .resolvedAt(mutableClock.instant())
                    .assignedTo("ktv.nam")
                    .build();
            when(alertRepository.findById("wf-resolved-1")).thenReturn(Optional.of(resolved));

            AlertResponse result = alertService.updateAlertWorkflow(
                    "wf-resolved-1",
                    AlertWorkflowUpdateRequest.builder()
                            .workflowStatus(AlertWorkflowStatus.IN_PROGRESS)
                            .assignedTo("someone.else")
                            .handlingNote("Thử ghi đè ngược")
                            .build(),
                    "manager.lan"
            );

            assertThat(result.getStatus()).isEqualTo(AlertStatus.RESOLVED);
            assertThat(result.getWorkflowStatus()).isEqualTo(AlertWorkflowStatus.RESOLVED);
            assertThat(result.getAssignedTo()).isEqualTo("ktv.nam");
            verify(alertRepository, never()).save(any());
            verify(realtimePublisher, never()).publishAlert(any());
        }

        @Test
        @DisplayName("TC-G6-04: Cô lập phân khu — ZONE_MANAGER ZONE_A không thể cập nhật workflow cảnh báo thuộc ZONE_B (HTTP 403 / 4031)")
        void updateAlertWorkflow_outsideAssignedZone_throwsZoneAccessDenied() {
            AlertServiceImpl scoped = new AlertServiceImpl(
                    alertRepository, realtimePublisher, alertRuleEngine, mongoTemplate,
                    mutableClock, userRepository, deviceRepository);

            Alert zoneBAlert = Alert.builder()
                    .id("wf-zone-b")
                    .deviceId("dev-b")
                    .roomId("room-b")
                    .zoneId("ZONE_B")
                    .status(AlertStatus.FIRING)
                    .type(AlertType.NOISE_EXCEEDED)
                    .build();
            when(alertRepository.findById("wf-zone-b")).thenReturn(Optional.of(zoneBAlert));

            User zoneAUser = User.builder().username("zm_zone_a").assignedZones(Set.of("ZONE_A")).build();
            when(userRepository.findByUsername("zm_zone_a")).thenReturn(Optional.of(zoneAUser));
            when(deviceRepository.findByZoneIdIn(Set.of("ZONE_A")))
                    .thenReturn(List.of(Device.builder().id("dev-a").roomId("room-a").zoneId("ZONE_A").build()));

            Authentication auth = mock(Authentication.class);
            doReturn(List.of(new SimpleGrantedAuthority("ZONE_MANAGER"))).when(auth).getAuthorities();
            when(auth.getName()).thenReturn("zm_zone_a");
            SecurityContext ctx = mock(SecurityContext.class);
            when(ctx.getAuthentication()).thenReturn(auth);

            try (MockedStatic<SecurityContextHolder> holder = mockStatic(SecurityContextHolder.class)) {
                holder.when(SecurityContextHolder::getContext).thenReturn(ctx);
                assertThatThrownBy(() -> scoped.updateAlertWorkflow(
                        "wf-zone-b",
                        AlertWorkflowUpdateRequest.builder()
                                .workflowStatus(AlertWorkflowStatus.IN_PROGRESS)
                                .assignedTo("ktv.a")
                                .build(),
                        "zm_zone_a"
                ))
                        .isInstanceOf(AppException.class)
                        .satisfies(ex -> {
                            ErrorCode code = ((AppException) ex).getErrorCode();
                            assertThat(code).isEqualTo(ErrorCode.ZONE_ACCESS_DENIED);
                            assertThat(code.getCode()).isEqualTo(4031);
                            assertThat(code.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
                        });
            }
            verify(alertRepository, never()).save(any());
        }

        @Test
        @DisplayName("TC-G6-05: Xử lý xung đột @Version Optimistic Locking — retry tự động thành công trong giới hạn 3 lần")
        void updateAlertWorkflow_optimisticLockConflict_retriesAndSucceeds() {
            Alert attempt1Copy = Alert.builder()
                    .id("wf-opt-1")
                    .deviceId("dev-1")
                    .roomId("room-1")
                    .type(AlertType.NOISE_EXCEEDED)
                    .status(AlertStatus.FIRING)
                    .version(1L)
                    .startedAt(mutableClock.instant())
                    .build();
            Alert attempt2Copy = Alert.builder()
                    .id("wf-opt-1")
                    .deviceId("dev-1")
                    .roomId("room-1")
                    .type(AlertType.NOISE_EXCEEDED)
                    .status(AlertStatus.FIRING)
                    .version(2L)
                    .startedAt(mutableClock.instant())
                    .build();

            AtomicInteger findCount = new AtomicInteger(0);
            when(alertRepository.findById("wf-opt-1")).thenAnswer(inv -> {
                int c = findCount.incrementAndGet();
                return Optional.of(c <= 2 ? attempt1Copy : attempt2Copy);
            });

            AtomicInteger saveCount = new AtomicInteger(0);
            when(alertRepository.save(any(Alert.class))).thenAnswer(inv -> {
                if (saveCount.incrementAndGet() == 1) {
                    throw new OptimisticLockingFailureException("Concurrent modification on version 1");
                }
                return inv.getArgument(0);
            });

            AlertResponse res = alertService.updateAlertWorkflow(
                    "wf-opt-1",
                    AlertWorkflowUpdateRequest.builder()
                            .workflowStatus(AlertWorkflowStatus.IN_PROGRESS)
                            .assignedTo("ktv.minh")
                            .handlingNote("Phối hợp xử lý")
                            .build(),
                    "manager.tqb"
            );

            assertThat(saveCount.get()).isEqualTo(2);
            assertThat(res.getWorkflowStatus()).isEqualTo(AlertWorkflowStatus.IN_PROGRESS);
            assertThat(res.getAssignedTo()).isEqualTo("ktv.minh");
            assertThat(res.getHandlingNote()).isEqualTo("Phối hợp xử lý");
            verify(realtimePublisher, times(1)).publishAlert(any(AlertResponse.class));
        }
    }

    @Nested
    @DisplayName("Hạng mục 10: Quy trình Tinh gọn 2 Tầng (LED 60s tại chỗ, Gộp >4 Node theo Phòng & 2 Chạm Chờ Chốt Ca 15p)")
    class TwoTierAndRoomGroupingTests {

        @Test
        @DisplayName("Tầng 1 LED: Ồn phòng đọc bật WARN_PULSE ngay, tự êm trước 60s trả LED NORMAL & 0 tạo Alert; Nhiệt/Kho sách không nháy LED")
        void tier1Led_studyRoomNoiseSelfRegulatesUnder60s_whileTempAndBookStorageNeverBlinkLed() {
            DeviceCommandPublisher cmdPublisher = mock(DeviceCommandPublisher.class);
            alertRuleEngine.setDeviceCommandPublisher(cmdPublisher);

            // 1. Tiếng ồn phòng đọc 69 dBA -> bật WARN_PULSE ngay giây 0, không ghi DB
            alertService.evaluateTelemetry("dev-301-a", "ESP32_301_A", "room-301", "ZONE_A", createAcousticsData(69.0, null));
            verify(cmdPublisher, times(1)).publishLedState(
                    eq("ESP32_301_A"), eq(DeviceCommandPublisher.LED_WARN_PULSE), anyString(), eq(69.0), eq(65.0));
            verify(alertRepository, never()).save(any());

            // Sinh viên thấy đèn LED, hạ giọng về 55 dBA ở giây 40 (< 60s) -> trả LED về NORMAL, hủy ngầm
            mutableClock.advance(Duration.ofSeconds(40));
            alertService.evaluateTelemetry("dev-301-a", "ESP32_301_A", "room-301", "ZONE_A", createAcousticsData(55.0, null));
            verify(cmdPublisher, times(1)).publishLedState(
                    eq("ESP32_301_A"), eq(DeviceCommandPublisher.LED_NORMAL), anyString(), eq(55.0), eq(65.0));
            verify(alertRepository, never()).save(any());
            verify(realtimePublisher, never()).publishAlert(any());

            // 2. Nhiệt độ phòng đọc & Tiếng ồn kho sách BOOK_STORAGE -> KHÔNG bao giờ phát lệnh LED làm phân tâm
            reset(cmdPublisher);
            Room storage = Room.builder().id("room-storage-led").type(RoomType.BOOK_STORAGE).build();
            when(roomRepository.findById("room-storage-led")).thenReturn(Optional.of(storage));

            alertService.evaluateTelemetry("dev-301-a", "ESP32_301_A", "room-301", "ZONE_A", createEnvironmentData(35.0));
            alertService.evaluateTelemetry("dev-st-1", "ESP32_ST_1", "room-storage-led", "ZONE_A", createAcousticsData(74.0, 82.0));
            verify(cmdPublisher, never()).publishLedState(anyString(), anyString(), anyString(), any(), any());
        }

        @Test
        @DisplayName("Gộp phòng 460m² (5 cảm biến): 5 trạm cùng báo NOISE_AVG & NOISE_PEAK chỉ tạo 01 Alert, tự trỏ tâm chấn cao nhất & chỉ êm khi cả 5 trạm êm")
        void multiSensorRoomGrouping_fiveNodesMergeIntoSingleRoomAlertWithDynamicEpicenter() {
            Alert[] roomAlert = new Alert[1];
            AtomicInteger createdCount = new AtomicInteger(0);
            when(alertRepository.save(any(Alert.class))).thenAnswer(inv -> {
                Alert a = inv.getArgument(0);
                if (a.getId() == null) {
                    a.setId("room-460-noise-" + createdCount.incrementAndGet());
                }
                roomAlert[0] = a;
                return a;
            });
            lenient().when(alertRepository.findById(anyString())).thenAnswer(inv -> Optional.ofNullable(roomAlert[0]));

            // t = 0s..8s: 5 trạm trong phòng room-460 cùng vượt ngưỡng ồn (trạm 4 có cả NOISE_PEAK 3 xung 81 dBA)
            for (int step = 0; step < 3; step++) {
                if (step > 0) mutableClock.advance(Duration.ofSeconds(4));
                alertService.evaluateTelemetry("dev-1", "HW-1", "room-460", "ZONE_A", createAcousticsData(67.0, 55.0));
                alertService.evaluateTelemetry("dev-2", "HW-2", "room-460", "ZONE_A", createAcousticsData(71.5, 60.0));
                alertService.evaluateTelemetry("dev-3", "HW-3", "room-460", "ZONE_A", createAcousticsData(68.0, 58.0));
                alertService.evaluateTelemetry("dev-4", "HW-4", "room-460", "ZONE_A", createAcousticsData(72.0, 81.0));
                alertService.evaluateTelemetry("dev-5", "HW-5", "room-460", "ZONE_A", createAcousticsData(66.2, 54.0));
            }

            // Duy trì 60s vượt qua Tầng 1 LED
            for (int i = 0; i < 4; i++) {
                mutableClock.advance(Duration.ofSeconds(15));
                alertService.evaluateTelemetry("dev-1", "HW-1", "room-460", "ZONE_A", createAcousticsData(67.0, 55.0));
                alertService.evaluateTelemetry("dev-2", "HW-2", "room-460", "ZONE_A", createAcousticsData(71.5, 60.0));
                alertService.evaluateTelemetry("dev-3", "HW-3", "room-460", "ZONE_A", createAcousticsData(68.0, 58.0));
                alertService.evaluateTelemetry("dev-4", "HW-4", "room-460", "ZONE_A", createAcousticsData(72.0, 81.0));
                alertService.evaluateTelemetry("dev-5", "HW-5", "room-460", "ZONE_A", createAcousticsData(66.2, 54.0));
            }

            // Chỉ tạo DUY NHẤT 01 bản ghi Alert cho cả 5 trạm × 2 kênh âm học!
            assertThat(createdCount.get()).isEqualTo(1);
            assertThat(roomAlert[0]).isNotNull();
            assertThat(roomAlert[0].getId()).isEqualTo("room-460-noise-1");
            assertThat(roomAlert[0].getDeviceId()).isEqualTo("dev-4");
            assertThat(roomAlert[0].getHardwareId()).isEqualTo("HW-4");
            assertThat(roomAlert[0].getSeverity()).isEqualTo(AlertSeverity.HIGH);
            assertThat(roomAlert[0].getCurrentValue()).isEqualTo(81.0);
            assertThat(roomAlert[0].getAffectedNodes()).hasSize(5);

            // 4 trạm êm suốt 65s nhưng dev-2 vẫn ồn 70 dBA -> Sự cố phòng CHƯA đóng, tâm chấn tự chuyển sang dev-2
            mutableClock.advance(Duration.ofSeconds(5));
            for (int round = 0; round < 2; round++) {
                if (round == 1) mutableClock.advance(Duration.ofSeconds(65));
                alertService.evaluateTelemetry("dev-1", "HW-1", "room-460", "ZONE_A", createAcousticsData(48.0, 50.0));
                alertService.evaluateTelemetry("dev-2", "HW-2", "room-460", "ZONE_A", createAcousticsData(70.0, 58.0));
                alertService.evaluateTelemetry("dev-3", "HW-3", "room-460", "ZONE_A", createAcousticsData(48.0, 50.0));
                alertService.evaluateTelemetry("dev-4", "HW-4", "room-460", "ZONE_A", createAcousticsData(48.0, 50.0));
                alertService.evaluateTelemetry("dev-5", "HW-5", "room-460", "ZONE_A", createAcousticsData(48.0, 50.0));
            }

            assertThat(roomAlert[0].getStatus()).isEqualTo(AlertStatus.FIRING);
            assertThat(roomAlert[0].getDeviceId()).isEqualTo("dev-2");
            assertThat(roomAlert[0].getAffectedNodes()).hasSize(1);

            // Tới khi dev-2 cũng êm đủ 60s -> Tự đóng hoàn toàn
            mutableClock.advance(Duration.ofSeconds(5));
            alertService.evaluateTelemetry("dev-2", "HW-2", "room-460", "ZONE_A", createAcousticsData(48.0, 50.0));
            mutableClock.advance(Duration.ofSeconds(60));
            alertService.evaluateTelemetry("dev-2", "HW-2", "room-460", "ZONE_A", createAcousticsData(48.0, 50.0));

            assertThat(roomAlert[0].getStatus()).isEqualTo(AlertStatus.RESOLVED);
        }

        @Test
        @DisplayName("Quy trình 2 Chạm: Chạm 1 tự gán người nhận + LED STAFF_DISPATCHED -> Êm 60s giữ chờ 15p -> Quá 15p tự chốt & vẫn cho gắn Tag bổ sung")
        void twoTapWorkflow_claimHolds15MinGraceAfterSensorRecovery_sweepsAndAllowsPostResolveTagging() {
            DeviceCommandPublisher cmdPublisher = mock(DeviceCommandPublisher.class);
            alertRuleEngine.setDeviceCommandPublisher(cmdPublisher);

            Alert[] dbHolder = new Alert[1];
            when(alertRepository.save(any(Alert.class))).thenAnswer(inv -> {
                Alert a = inv.getArgument(0);
                if (a.getId() == null) a.setId("alert-2tap-1");
                dbHolder[0] = a;
                return a;
            });
            when(alertRepository.findById("alert-2tap-1")).thenAnswer(inv -> Optional.ofNullable(dbHolder[0]));
            when(alertRepository.findByStatusIn(anyList())).thenAnswer(inv ->
                    dbHolder[0] != null && dbHolder[0].getStatus() != AlertStatus.RESOLVED
                            ? List.of(dbHolder[0])
                            : List.of());

            // 1. Nổ cảnh báo ồn sau 60s
            alertService.evaluateTelemetry("dev-1", "HW-301", "room-301", "ZONE_A", createAcousticsData(70.0, null));
            mutableClock.advance(Duration.ofSeconds(60));
            alertService.evaluateTelemetry("dev-1", "HW-301", "room-301", "ZONE_A", createAcousticsData(70.5, null));
            assertThat(dbHolder[0].getStatus()).isEqualTo(AlertStatus.FIRING);

            // 2. CHẠM 1: Thủ thư bấm [Nhận xử lý] (IN_PROGRESS, không truyền assignedTo) -> Tự gán thuthu_lan & đổi LED STAFF_DISPATCHED
            AlertResponse claimed = alertService.updateAlertWorkflow(
                    "alert-2tap-1",
                    AlertWorkflowUpdateRequest.builder().workflowStatus(AlertWorkflowStatus.IN_PROGRESS).build(),
                    "thuthu_lan"
            );
            assertThat(claimed.getStatus()).isEqualTo(AlertStatus.ACKNOWLEDGED);
            assertThat(claimed.getWorkflowStatus()).isEqualTo(AlertWorkflowStatus.IN_PROGRESS);
            assertThat(claimed.getAssignedTo()).isEqualTo("thuthu_lan");
            verify(cmdPublisher).publishLedState(
                    eq("HW-301"), eq(DeviceCommandPublisher.LED_STAFF_DISPATCHED), anyString(), any(), any());

            // 3. Sinh viên được nhắc đã im lặng suốt 60s -> Cảm biến hồi phục: KHÔNG đóng cướp sang RESOLVED, bật sensorRecovered = true
            mutableClock.advance(Duration.ofSeconds(10));
            alertService.evaluateTelemetry("dev-1", "HW-301", "room-301", "ZONE_A", createAcousticsData(49.0, null));
            mutableClock.advance(Duration.ofSeconds(60));
            alertService.evaluateTelemetry("dev-1", "HW-301", "room-301", "ZONE_A", createAcousticsData(49.0, null));

            assertThat(dbHolder[0].getStatus()).isEqualTo(AlertStatus.ACKNOWLEDGED);
            assertThat(dbHolder[0].getWorkflowStatus()).isEqualTo(AlertWorkflowStatus.IN_PROGRESS);
            assertThat(dbHolder[0].getSensorRecovered()).isTrue();
            assertThat(dbHolder[0].getSensorRecoveredAt()).isEqualTo(mutableClock.instant());
            verify(cmdPublisher).publishLedState(
                    eq("HW-301"), eq(DeviceCommandPublisher.LED_NORMAL), anyString(), any(), any());

            // 4. Sau 10 phút (< 15 phút): Job quét chưa tự chốt, vẫn đợi thủ thư bấm Chạm 2
            mutableClock.advance(Duration.ofMinutes(10));
            assertThat(alertRuleEngine.sweepRecoveredUnconfirmedAlerts()).isZero();
            assertThat(dbHolder[0].getStatus()).isEqualTo(AlertStatus.ACKNOWLEDGED);

            // 5. Đủ 15 phút thủ thư bận quên bấm -> Tự động chốt kèm AUTO_STABILIZED và tên thuthu_lan
            mutableClock.advance(Duration.ofMinutes(5));
            assertThat(alertRuleEngine.sweepRecoveredUnconfirmedAlerts()).isEqualTo(1);
            assertThat(dbHolder[0].getStatus()).isEqualTo(AlertStatus.RESOLVED);
            assertThat(dbHolder[0].getResolutionTag()).isEqualTo(AlertRuleEngine.AUTO_STABILIZED_TAG);
            assertThat(dbHolder[0].getHandlingNote()).contains("thuthu_lan");

            // 6. Sau khi đã RESOLVED, thủ thư quay lại chọn bổ sung Quick-Tag vẫn lưu được vào nhật ký ca trực
            AlertResponse amended = alertService.updateAlertWorkflow(
                    "alert-2tap-1",
                    AlertWorkflowUpdateRequest.builder()
                            .workflowStatus(AlertWorkflowStatus.RESOLVED)
                            .resolutionTag("REMINDED_QUIET")
                            .handlingNote("Đã nhắc giữ trật tự dãy bàn giữa")
                            .build(),
                    "thuthu_lan"
            );
            assertThat(amended.getStatus()).isEqualTo(AlertStatus.RESOLVED);
            assertThat(amended.getResolutionTag()).isEqualTo("REMINDED_QUIET");
            assertThat(amended.getHandlingNote()).isEqualTo("Đã nhắc giữ trật tự dãy bàn giữa");
        }
    }
}
