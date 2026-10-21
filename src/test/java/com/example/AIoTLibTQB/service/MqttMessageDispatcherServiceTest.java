package com.example.AIoTLibTQB.service;

import com.example.AIoTLibTQB.document.AcousticMetrics;
import com.example.AIoTLibTQB.document.ComfortScoreRecord;
import com.example.AIoTLibTQB.document.Device;
import com.example.AIoTLibTQB.document.TelemetryRecord;
import com.example.AIoTLibTQB.repository.DeviceRepository;
import com.example.AIoTLibTQB.repository.TelemetryRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.mongodb.client.result.UpdateResult;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.Spy;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.integration.mqtt.support.MqttHeaders;
import org.springframework.messaging.support.MessageBuilder;

import java.time.Duration;
import java.time.Instant;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class MqttMessageDispatcherServiceTest {

    @Mock DeviceRepository deviceRepository;
    @Mock TelemetryRepository telemetryRepository;
    @Mock TelemetrySanitizerService telemetrySanitizerService;
    @Mock DiscoveredDeviceService discoveredDeviceService;
    @Mock ComfortScoreService comfortScoreService;
    @Mock MongoTemplate mongoTemplate;
    @Spy ObjectMapper objectMapper = new ObjectMapper();

    @InjectMocks MqttMessageDispatcherService dispatcherService;

    Device mockDevice;

    @BeforeEach
    void setUp() {
        mockDevice = Device.builder()
                .id("dev-1")
                .hardwareId("ESP32_ROOM_101")
                .roomId("room-1")
                .isActive(true)
                .build();
        dispatcherService.lastSeenThrottleCache.invalidateAll();
    }

    @Test
    @DisplayName("dispatch() - Nhận telemetry từ thiết bị hợp lệ -> Cập nhật nguyên tử và lưu vào Time-Series")
    void dispatch_telemetry_registeredDevice() {
        when(deviceRepository.findByHardwareId("ESP32_ROOM_101")).thenReturn(Optional.of(mockDevice));
        when(telemetrySanitizerService.sanitize(eq("dev-1"), any())).thenReturn(
                new TelemetrySanitizerService.SanitizedMetrics(
                        AcousticMetrics.builder().noiseAvg(42.0).build(), null, null)
        );

        String json = """
        {
          "hardware_id": "ESP32_ROOM_101",
          "timestamp": %d,
          "wifi_rssi": -65,
          "data": {
            "acoustics": { "noise_avg": 42.0, "noise_peak": 55.0 }
          }
        }
        """.formatted(Instant.now().getEpochSecond());

        var msg = MessageBuilder.withPayload(json)
                .setHeader(MqttHeaders.RECEIVED_TOPIC, "devices/ESP32_ROOM_101/telemetry")
                .build();

        dispatcherService.dispatch(msg);

        verify(mongoTemplate).updateFirst(any(), any(), eq(Device.class));
        verify(deviceRepository, never()).save(any());
        verify(telemetryRepository).save(any(TelemetryRecord.class));
        verify(discoveredDeviceService, never()).recordDiscovered(any(), any());
    }

    @Test
    @DisplayName("dispatch() - Nhận telemetry từ thiết bị lạ -> Ghi nhận vào hàng đợi discovery và không lưu DB")
    void dispatch_telemetry_unregisteredDevice() {
        when(deviceRepository.findByHardwareId("ESP32_UNKNOWN")).thenReturn(Optional.empty());

        String json = """
        {
          "hardware_id": "ESP32_UNKNOWN",
          "wifi_rssi": -72,
          "data": { "acoustics": { "noise_avg": 50.0 } }
        }
        """;

        var msg = MessageBuilder.withPayload(json)
                .setHeader(MqttHeaders.RECEIVED_TOPIC, "devices/ESP32_UNKNOWN/telemetry")
                .build();

        dispatcherService.dispatch(msg);

        verify(discoveredDeviceService).recordDiscovered("ESP32_UNKNOWN", -72);
        verify(telemetryRepository, never()).save(any());
        verify(mongoTemplate, never()).updateFirst(any(), any(), eq(Device.class));
    }

    @Test
    @DisplayName("dispatch() - Nhận status (LWT) từ thiết bị đã đăng ký -> Cập nhật nguyên tử offline không đổi lastSeenAt")
    void dispatch_status_knownDevice() {
        when(mongoTemplate.updateFirst(any(), any(), eq(Device.class)))
                .thenReturn(UpdateResult.acknowledged(1L, 1L, null));

        String json = """
        {
          "hardware_id": "ESP32_ROOM_101",
          "status": "offline",
          "reason": "connection_lost"
        }
        """;

        var msg = MessageBuilder.withPayload(json)
                .setHeader(MqttHeaders.RECEIVED_TOPIC, "devices/ESP32_ROOM_101/status")
                .build();

        dispatcherService.dispatch(msg);

        verify(mongoTemplate).updateFirst(any(), any(), eq(Device.class));
        verify(deviceRepository, never()).save(any());
        verify(discoveredDeviceService, never()).recordDiscovered(any(), any());
    }

    @Test
    @DisplayName("dispatch() - Phát hiện mạo danh hardware_id trong payload khác topic -> Bỏ qua bản tin (C2)")
    void dispatch_telemetry_hardwareIdMismatch() {
        String json = """
        {
          "hardware_id": "ESP32_ATTACKER_ID",
          "wifi_rssi": -50,
          "data": { "acoustics": { "noise_avg": 90.0 } }
        }
        """;

        var msg = MessageBuilder.withPayload(json)
                .setHeader(MqttHeaders.RECEIVED_TOPIC, "devices/ESP32_ROOM_101/telemetry")
                .build();

        dispatcherService.dispatch(msg);

        verify(deviceRepository, never()).findByHardwareId(any());
        verify(telemetryRepository, never()).save(any());
        verify(mongoTemplate, never()).updateFirst(any(), any(), eq(Device.class));
    }

    @Test
    @DisplayName("dispatch() - Kẹp timestamp năm 1970 (chưa sync NTP) về thời gian server (H4)")
    void dispatch_telemetry_timestampClamping() {
        when(deviceRepository.findByHardwareId("ESP32_ROOM_101")).thenReturn(Optional.of(mockDevice));
        when(telemetrySanitizerService.sanitize(eq("dev-1"), any())).thenReturn(
                new TelemetrySanitizerService.SanitizedMetrics(
                        AcousticMetrics.builder().noiseAvg(42.0).build(), null, null)
        );

        String json = """
        {
          "hardware_id": "ESP32_ROOM_101",
          "timestamp": 100,
          "data": { "acoustics": { "noise_avg": 42.0 } }
        }
        """;

        var msg = MessageBuilder.withPayload(json)
                .setHeader(MqttHeaders.RECEIVED_TOPIC, "devices/ESP32_ROOM_101/telemetry")
                .build();

        dispatcherService.dispatch(msg);

        ArgumentCaptor<TelemetryRecord> captor = ArgumentCaptor.forClass(TelemetryRecord.class);
        verify(telemetryRepository).save(captor.capture());

        // Timestamp phải được kẹp về khoảng thời gian hiện tại thay vì epoch 100s
        Instant savedTs = captor.getValue().getTimestamp();
        assertThat(Duration.between(savedTs, Instant.now()).abs().toSeconds()).isLessThan(5);
    }

    @Test
    @DisplayName("dispatch() - R3: Bỏ qua không lưu DB khi toàn bộ số liệu cảm biến đều null (Empty Record)")
    void dispatch_telemetry_emptyMetrics_discardedWithoutDbInsertion() {
        when(deviceRepository.findByHardwareId("ESP32_ROOM_101")).thenReturn(Optional.of(mockDevice));
        when(telemetrySanitizerService.sanitize(eq("dev-1"), any())).thenReturn(
                new TelemetrySanitizerService.SanitizedMetrics(null, null, null)
        );

        String json = """
        {
          "hardware_id": "ESP32_ROOM_101",
          "timestamp": %d,
          "data": {}
        }
        """.formatted(Instant.now().getEpochSecond());

        var msg = MessageBuilder.withPayload(json)
                .setHeader(MqttHeaders.RECEIVED_TOPIC, "devices/ESP32_ROOM_101/telemetry")
                .build();

        dispatcherService.dispatch(msg);

        // telemetryRepository.save KHÔNG ĐƯỢC PHÉP GỌI
        verify(telemetryRepository, never()).save(any());
    }

    @Test
    @DisplayName("dispatch() - R4: Throttling ghi lastSeenAt trong 30 giây (chỉ update MongoDB 1 lần)")
    void dispatch_telemetry_throttling_lastSeenAtOnlyUpdatedOnceWithin30s() {
        when(deviceRepository.findByHardwareId("ESP32_ROOM_101")).thenReturn(Optional.of(mockDevice));
        when(telemetrySanitizerService.sanitize(eq("dev-1"), any())).thenReturn(
                new TelemetrySanitizerService.SanitizedMetrics(
                        AcousticMetrics.builder().noiseAvg(40.0).build(), null, null)
        );

        String json = """
        {
          "hardware_id": "ESP32_ROOM_101",
          "timestamp": %d,
          "data": { "acoustics": { "noise_avg": 40.0 } }
        }
        """.formatted(Instant.now().getEpochSecond());

        var msg1 = MessageBuilder.withPayload(json)
                .setHeader(MqttHeaders.RECEIVED_TOPIC, "devices/ESP32_ROOM_101/telemetry")
                .build();
        var msg2 = MessageBuilder.withPayload(json)
                .setHeader(MqttHeaders.RECEIVED_TOPIC, "devices/ESP32_ROOM_101/telemetry")
                .build();

        // Gửi 2 bản tin liên tiếp trong vòng 30s
        dispatcherService.dispatch(msg1);
        dispatcherService.dispatch(msg2);

        // mongoTemplate.updateFirst chỉ được gọi 1 lần duy nhất cho Device lastSeenAt
        verify(mongoTemplate, times(1)).updateFirst(any(), any(), eq(Device.class));
        // Nhưng telemetry record vẫn được lưu cả 2 lần
        verify(telemetryRepository, times(2)).save(any(TelemetryRecord.class));
    }

    @Test
    @DisplayName("dispatch() - R1: Hỗ trợ timestamp 13 chữ số (epoch milliseconds)")
    void dispatch_telemetry_13DigitTimestamp_supportedCorrectly() {
        when(deviceRepository.findByHardwareId("ESP32_ROOM_101")).thenReturn(Optional.of(mockDevice));
        when(telemetrySanitizerService.sanitize(eq("dev-1"), any())).thenReturn(
                new TelemetrySanitizerService.SanitizedMetrics(
                        AcousticMetrics.builder().noiseAvg(43.0).build(), null, null)
        );

        long nowMillis = System.currentTimeMillis();
        String json = """
        {
          "hardware_id": "ESP32_ROOM_101",
          "timestamp": %d,
          "data": { "acoustics": { "noise_avg": 43.0 } }
        }
        """.formatted(nowMillis);

        var msg = MessageBuilder.withPayload(json)
                .setHeader(MqttHeaders.RECEIVED_TOPIC, "devices/ESP32_ROOM_101/telemetry")
                .build();

        dispatcherService.dispatch(msg);

        ArgumentCaptor<TelemetryRecord> captor = ArgumentCaptor.forClass(TelemetryRecord.class);
        verify(telemetryRepository).save(captor.capture());

        Instant savedTs = captor.getValue().getTimestamp();
        assertThat(savedTs.toEpochMilli()).isEqualTo(nowMillis);
    }

    @Test
    @DisplayName("dispatch() - Tính toán và lưu trữ ComfortScoreRecord vào TelemetryRecord")
    void dispatch_telemetry_comfortScoreSaved() {
        when(deviceRepository.findByHardwareId("ESP32_ROOM_101")).thenReturn(Optional.of(mockDevice));
        TelemetrySanitizerService.SanitizedMetrics metrics = new TelemetrySanitizerService.SanitizedMetrics(
                AcousticMetrics.builder().noiseAvg(34.0).build(), null, null
        );
        when(telemetrySanitizerService.sanitize(eq("dev-1"), any())).thenReturn(metrics);

        ComfortScoreRecord expectedComfort = ComfortScoreRecord.builder()
                .overall(100.0)
                .grade("Platinum")
                .acousticScore(100.0)
                .build();
        when(comfortScoreService.calculateForRoom(eq(metrics), eq("room-1"))).thenReturn(expectedComfort);

        String json = """
        {
          "hardware_id": "ESP32_ROOM_101",
          "timestamp": %d,
          "data": { "acoustics": { "noise_avg": 34.0 } }
        }
        """.formatted(Instant.now().getEpochSecond());

        var msg = MessageBuilder.withPayload(json)
                .setHeader(MqttHeaders.RECEIVED_TOPIC, "devices/ESP32_ROOM_101/telemetry")
                .build();

        dispatcherService.dispatch(msg);

        ArgumentCaptor<TelemetryRecord> captor = ArgumentCaptor.forClass(TelemetryRecord.class);
        verify(telemetryRepository).save(captor.capture());

        assertThat(captor.getValue().getComfortScore()).isEqualTo(expectedComfort);
        verify(comfortScoreService).calculateForRoom(eq(metrics), eq("room-1"));
    }
}
