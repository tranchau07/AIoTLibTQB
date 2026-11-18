package com.example.AIoTLibTQB.service;

import com.example.AIoTLibTQB.document.AcousticMetrics;
import com.example.AIoTLibTQB.document.ComfortScoreRecord;
import com.example.AIoTLibTQB.document.Device;
import com.example.AIoTLibTQB.document.EnvironmentMetrics;
import com.example.AIoTLibTQB.document.TelemetryRecord;
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
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class MqttMessageDispatcherServiceTest {

    @Mock DeviceMetadataCache deviceMetadataCache;
    @Mock AlertService alertService;
    @Mock TelemetryRepository telemetryRepository;
    @Mock TelemetrySanitizerService telemetrySanitizerService;
    @Mock DiscoveredDeviceService discoveredDeviceService;
    @Mock ComfortScoreService comfortScoreService;
    @Mock MongoTemplate mongoTemplate;
    @Mock DeviceWatchdogService deviceWatchdogService;
    @Spy ObjectMapper objectMapper = new ObjectMapper();

    @InjectMocks MqttMessageDispatcherService dispatcherService;

    DeviceMetadata mockDevice;

    @BeforeEach
    void setUp() {
        mockDevice = DeviceMetadata.builder()
                .id("dev-1")
                .hardwareId("ESP32_ROOM_101")
                .roomId("room-1")
                .zoneId("zone-A")
                .deviceType("ESP32_S3")
                .isActive(true)
                .build();
        dispatcherService.lastSeenThrottleCache.invalidateAll();
        dispatcherService.setDeviceWatchdogService(deviceWatchdogService);
    }

    @Test
    @DisplayName("dispatch() - Nhận telemetry từ thiết bị hợp lệ -> Cập nhật nguyên tử, đánh giá alert và lưu vào Time-Series")
    void dispatch_telemetry_registeredDevice() {
        when(deviceMetadataCache.get("ESP32_ROOM_101")).thenReturn(Optional.of(mockDevice));
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
        verify(telemetryRepository).save(any(TelemetryRecord.class));
        verify(discoveredDeviceService, never()).recordDiscovered(any(), any());
        verify(alertService).evaluateTelemetry(eq("dev-1"), eq("ESP32_ROOM_101"), eq("room-1"), eq("zone-A"), any());
    }

    @Test
    @DisplayName("dispatch() - Nhận telemetry từ thiết bị lạ -> Ghi nhận vào hàng đợi discovery và không lưu DB")
    void dispatch_telemetry_unregisteredDevice() {
        when(deviceMetadataCache.get("ESP32_UNKNOWN")).thenReturn(Optional.empty());

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
        verify(alertService, never()).evaluateTelemetry(any(), any(), any(), any(), any());
    }

    @Test
    @DisplayName("dispatch() - Nhận status (LWT) từ thiết bị đã đăng ký -> Cập nhật offline và invalidate cache")
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
        verify(deviceMetadataCache).invalidate("ESP32_ROOM_101");
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

        verify(deviceMetadataCache, never()).get(any());
        verify(telemetryRepository, never()).save(any());
        verify(mongoTemplate, never()).updateFirst(any(), any(), eq(Device.class));
    }

    @Test
    @DisplayName("dispatch() - Kẹp timestamp năm 1970 (chưa sync NTP) về thời gian server (H4)")
    void dispatch_telemetry_timestampClamping() {
        when(deviceMetadataCache.get("ESP32_ROOM_101")).thenReturn(Optional.of(mockDevice));
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

        Instant savedTs = captor.getValue().getTimestamp();
        assertThat(Duration.between(savedTs, Instant.now()).abs().toSeconds()).isLessThan(5);
    }

    @Test
    @DisplayName("dispatch() - R3: Bỏ qua không lưu DB khi toàn bộ số liệu cảm biến đều null (Empty Record)")
    void dispatch_telemetry_emptyMetrics_discardedWithoutDbInsertion() {
        when(deviceMetadataCache.get("ESP32_ROOM_101")).thenReturn(Optional.of(mockDevice));
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

        verify(telemetryRepository, never()).save(any());
    }

    @Test
    @DisplayName("dispatch() - R4: Throttling ghi lastSeenAt trong 30 giây (chỉ update MongoDB 1 lần)")
    void dispatch_telemetry_throttling_lastSeenAtOnlyUpdatedOnceWithin30s() {
        when(deviceMetadataCache.get("ESP32_ROOM_101")).thenReturn(Optional.of(mockDevice));
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

        dispatcherService.dispatch(msg1);
        dispatcherService.dispatch(msg2);

        verify(mongoTemplate, times(1)).updateFirst(any(), any(), eq(Device.class));
        verify(telemetryRepository, times(2)).save(any(TelemetryRecord.class));
    }

    @Test
    @DisplayName("dispatch() - R1: Hỗ trợ timestamp 13 chữ số (epoch milliseconds)")
    void dispatch_telemetry_13DigitTimestamp_supportedCorrectly() {
        when(deviceMetadataCache.get("ESP32_ROOM_101")).thenReturn(Optional.of(mockDevice));
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
        when(deviceMetadataCache.get("ESP32_ROOM_101")).thenReturn(Optional.of(mockDevice));
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

    @Test
    @DisplayName("Semaphore - Khi cạn kiệt permits, ghi log WARN và an toàn bỏ qua lưu Time-Series không chặn vô hạn")
    void dispatch_telemetry_semaphoreTimeout_dropsSafely() {
        when(deviceMetadataCache.get("ESP32_ROOM_101")).thenReturn(Optional.of(mockDevice));
        when(telemetrySanitizerService.sanitize(eq("dev-1"), any())).thenReturn(
                new TelemetrySanitizerService.SanitizedMetrics(
                        AcousticMetrics.builder().noiseAvg(50.0).build(), null, null)
        );

        // Chiếm hết toàn bộ permits của Semaphore
        int permits = dispatcherService.mongoWriteSemaphore.drainPermits();
        try {
            String json = """
            {
              "hardware_id": "ESP32_ROOM_101",
              "timestamp": %d,
              "data": { "acoustics": { "noise_avg": 50.0 } }
            }
            """.formatted(Instant.now().getEpochSecond());

            var msg = MessageBuilder.withPayload(json)
                    .setHeader(MqttHeaders.RECEIVED_TOPIC, "devices/ESP32_ROOM_101/telemetry")
                    .build();

            // Sẽ cố acquire trong 3000ms nhưng thất bại và log WARN
            dispatcherService.dispatch(msg);

            // Xác nhận KHÔNG lưu telemetryRecord vào repository do timeout
            verify(telemetryRepository, never()).save(any());
        } finally {
            dispatcherService.mongoWriteSemaphore.release(permits);
        }

        // Sau khi release, số permit phải được hoàn trả đầy đủ
        assertThat(dispatcherService.mongoWriteSemaphore.availablePermits()).isEqualTo(permits);
    }

    @Test
    @DisplayName("Pipeline order: telemetrySanitizerService.sanitize runs strictly BEFORE alertService.evaluateTelemetry")
    void dispatch_telemetry_sanitizesBeforeAlertEvaluation() {
        when(deviceMetadataCache.get("ESP32_ROOM_101")).thenReturn(Optional.of(mockDevice));
        TelemetrySanitizerService.SanitizedMetrics metrics = new TelemetrySanitizerService.SanitizedMetrics(
                AcousticMetrics.builder().noiseAvg(45.0).build(), null, null
        );
        when(telemetrySanitizerService.sanitize(eq("dev-1"), any())).thenReturn(metrics);

        String json = """
        {
          "hardware_id": "ESP32_ROOM_101",
          "timestamp": %d,
          "data": { "acoustics": { "noise_avg": 45.0 } }
        }
        """.formatted(Instant.now().getEpochSecond());

        var msg = MessageBuilder.withPayload(json)
                .setHeader(MqttHeaders.RECEIVED_TOPIC, "devices/ESP32_ROOM_101/telemetry")
                .build();

        dispatcherService.dispatch(msg);

        org.mockito.InOrder inOrder = inOrder(telemetrySanitizerService, alertService);
        inOrder.verify(telemetrySanitizerService).sanitize(eq("dev-1"), any());
        inOrder.verify(alertService).evaluateTelemetry(eq("dev-1"), eq("ESP32_ROOM_101"), eq("room-1"), eq("zone-A"), any());
    }

    @Test
    @DisplayName("LWT offline status message triggers triggerDeviceOfflineAlert and records in watchdog")
    void dispatch_status_lwtOffline_triggersOfflineAlertAndRecordsWatchdog() {
        when(mongoTemplate.updateFirst(any(), any(), eq(Device.class)))
                .thenReturn(UpdateResult.acknowledged(1, 1L, null));
        when(deviceMetadataCache.get("ESP32_ROOM_101")).thenReturn(Optional.of(mockDevice));

        String json = """
        {
          "status": "offline",
          "reason": "LWT connection lost"
        }
        """;

        var msg = MessageBuilder.withPayload(json)
                .setHeader(MqttHeaders.RECEIVED_TOPIC, "devices/ESP32_ROOM_101/status")
                .build();

        dispatcherService.dispatch(msg);

        verify(alertService).triggerDeviceOfflineAlert("dev-1", "ESP32_ROOM_101", "room-1", "zone-A");
        verify(deviceWatchdogService).recordOfflineDevice("ESP32_ROOM_101");
        verify(deviceMetadataCache).invalidate("ESP32_ROOM_101");
    }

    @Test
    @DisplayName("dispatch() - Giải mã JSON chỉ có acoustics.noise và tính/lưu noiseAvg + noisePeak thông qua TelemetrySanitizerService")
    void dispatch_telemetry_rawNoiseField_computesAndSavesAcousticMetrics() {
        TelemetrySanitizerService realSanitizer = new TelemetrySanitizerService();
        MqttMessageDispatcherService realDispatcher = new MqttMessageDispatcherService(
                objectMapper,
                deviceMetadataCache,
                alertService,
                telemetryRepository,
                realSanitizer,
                discoveredDeviceService,
                comfortScoreService,
                mongoTemplate
        );
        realDispatcher.setDeviceWatchdogService(deviceWatchdogService);

        when(deviceMetadataCache.get("ESP32_ROOM_101")).thenReturn(Optional.of(mockDevice));

        String json = """
        {
          "hardware_id": "ESP32_ROOM_101",
          "timestamp": %d,
          "wifi_rssi": -60,
          "data": {
            "acoustics": { "noise": 86.0 },
            "environment": { "temperature": 24.5, "humidity": 55.0, "lux": 420.0 }
          }
        }
        """.formatted(Instant.now().toEpochMilli());

        var msg = MessageBuilder.withPayload(json)
                .setHeader(MqttHeaders.RECEIVED_TOPIC, "devices/ESP32_ROOM_101/telemetry")
                .build();

        realDispatcher.dispatch(msg);

        ArgumentCaptor<TelemetryRecord> captor = ArgumentCaptor.forClass(TelemetryRecord.class);
        verify(telemetryRepository).save(captor.capture());
        assertThat(captor.getValue().getAcoustics()).isNotNull();
        assertThat(captor.getValue().getAcoustics().getNoiseAvg()).isEqualTo(86.0);
        assertThat(captor.getValue().getAcoustics().getNoisePeak()).isEqualTo(86.0);
        verify(alertService).evaluateTelemetry(eq("dev-1"), eq("ESP32_ROOM_101"), eq("room-1"), eq("zone-A"), any());
    }

    @Test
    @DisplayName("Hạng mục 2 Test 5 (Store-and-Forward trễ > 60s): Bản tin timestamp = now - 120s (40°C) vẫn lưu MongoDB nhưng KHÔNG gọi alertService.evaluateTelemetry()")
    void dispatch_telemetry_staleBufferedPacket_savesHistoryButSkipsAlertFsm() {
        when(deviceMetadataCache.get("ESP32_ROOM_101")).thenReturn(Optional.of(mockDevice));
        when(telemetrySanitizerService.sanitize(eq("dev-1"), any())).thenReturn(
                new TelemetrySanitizerService.SanitizedMetrics(
                        null, null, EnvironmentMetrics.builder().temperature(40.0).build())
        );

        long staleEpochSeconds = Instant.now().minusSeconds(120).getEpochSecond();
        String json = """
        {
          "hardware_id": "ESP32_ROOM_101",
          "timestamp": %d,
          "data": {
            "environment": { "temperature": 40.0 }
          }
        }
        """.formatted(staleEpochSeconds);

        var msg = MessageBuilder.withPayload(json)
                .setHeader(MqttHeaders.RECEIVED_TOPIC, "devices/ESP32_ROOM_101/telemetry")
                .build();

        dispatcherService.dispatch(msg);

        ArgumentCaptor<TelemetryRecord> captor = ArgumentCaptor.forClass(TelemetryRecord.class);
        verify(telemetryRepository, times(1)).save(captor.capture());
        assertThat(captor.getValue().getTimestamp().getEpochSecond()).isEqualTo(staleEpochSeconds);
        assertThat(captor.getValue().getEnvironment().getTemperature()).isEqualTo(40.0);

        verify(alertService, never()).evaluateTelemetry(any(), any(), any(), any(), any());
        verify(alertService, never()).evaluateTelemetry(any(), any(), any(), any());
    }

    @Test
    @DisplayName("Hạng mục 2 (Store-and-Forward millis trễ > 60s vs trễ nhẹ 30s): Millis > 60s bỏ qua FSM; bản tin trễ 30s vẫn đánh giá FSM")
    void dispatch_telemetry_staleMillisSkipped_whileRecentWithin60sEvaluated() {
        when(deviceMetadataCache.get("ESP32_ROOM_101")).thenReturn(Optional.of(mockDevice));
        when(telemetrySanitizerService.sanitize(eq("dev-1"), any())).thenReturn(
                new TelemetrySanitizerService.SanitizedMetrics(
                        null, null, EnvironmentMetrics.builder().temperature(39.0).build())
        );

        long staleMillis = Instant.now().minusSeconds(120).toEpochMilli();
        String staleJson = """
        {
          "hardware_id": "ESP32_ROOM_101",
          "timestamp": %d,
          "data": { "environment": { "temperature": 39.0 } }
        }
        """.formatted(staleMillis);

        dispatcherService.dispatch(MessageBuilder.withPayload(staleJson)
                .setHeader(MqttHeaders.RECEIVED_TOPIC, "devices/ESP32_ROOM_101/telemetry")
                .build());

        verify(telemetryRepository, times(1)).save(any(TelemetryRecord.class));
        verify(alertService, never()).evaluateTelemetry(any(), any(), any(), any(), any());

        long recentMillis = Instant.now().minusSeconds(30).toEpochMilli();
        String recentJson = """
        {
          "hardware_id": "ESP32_ROOM_101",
          "timestamp": %d,
          "data": { "environment": { "temperature": 39.0 } }
        }
        """.formatted(recentMillis);

        dispatcherService.dispatch(MessageBuilder.withPayload(recentJson)
                .setHeader(MqttHeaders.RECEIVED_TOPIC, "devices/ESP32_ROOM_101/telemetry")
                .build());

        verify(telemetryRepository, times(2)).save(any(TelemetryRecord.class));
        verify(alertService, times(1)).evaluateTelemetry(eq("dev-1"), eq("ESP32_ROOM_101"), eq("room-1"), eq("zone-A"), any());
    }

    @Test
    @DisplayName("Hạng mục 9: Cảm biến hỏng hoàn toàn (-99.0°C, empty clean metrics) vẫn gọi evaluateSensorHealth nhưng không lưu TelemetryRecord rỗng vào DB")
    void dispatch_telemetry_completelyMalfunctioningSensor_evaluatesSensorHealthWithoutSavingEmptyRecord() {
        TelemetrySanitizerService realSanitizer = new TelemetrySanitizerService();
        MqttMessageDispatcherService realDispatcher = new MqttMessageDispatcherService(
                objectMapper,
                deviceMetadataCache,
                alertService,
                telemetryRepository,
                realSanitizer,
                discoveredDeviceService,
                comfortScoreService,
                mongoTemplate
        );
        realDispatcher.setDeviceWatchdogService(deviceWatchdogService);
        when(deviceMetadataCache.get("ESP32_ROOM_101")).thenReturn(Optional.of(mockDevice));

        String json = """
        {
          "hardware_id": "ESP32_ROOM_101",
          "timestamp": %d,
          "data": {
            "environment": { "temperature": -99.0 }
          }
        }
        """.formatted(Instant.now().getEpochSecond());

        var msg = MessageBuilder.withPayload(json)
                .setHeader(MqttHeaders.RECEIVED_TOPIC, "devices/ESP32_ROOM_101/telemetry")
                .build();

        realDispatcher.dispatch(msg);

        verify(alertService).evaluateSensorHealth(
                eq("dev-1"),
                eq("ESP32_ROOM_101"),
                eq("room-1"),
                eq("zone-A"),
                eq(true),
                eq(false),
                eq(List.of("env.temperature"))
        );
        verify(telemetryRepository, never()).save(any());
        verify(alertService, never()).evaluateTelemetry(any(), any(), any(), any(), any());
    }

    @Test
    @DisplayName("Hạng mục 9: Bản tin hợp lệ gọi evaluateSensorHealth(false, true, []) song song với evaluateTelemetry & lưu Time-Series")
    void dispatch_telemetry_validPacket_callsEvaluateSensorHealthHealthy() {
        TelemetrySanitizerService realSanitizer = new TelemetrySanitizerService();
        MqttMessageDispatcherService realDispatcher = new MqttMessageDispatcherService(
                objectMapper,
                deviceMetadataCache,
                alertService,
                telemetryRepository,
                realSanitizer,
                discoveredDeviceService,
                comfortScoreService,
                mongoTemplate
        );
        realDispatcher.setDeviceWatchdogService(deviceWatchdogService);
        when(deviceMetadataCache.get("ESP32_ROOM_101")).thenReturn(Optional.of(mockDevice));

        String json = """
        {
          "hardware_id": "ESP32_ROOM_101",
          "timestamp": %d,
          "data": {
            "environment": { "temperature": 25.0, "humidity": 55.0 }
          }
        }
        """.formatted(Instant.now().getEpochSecond());

        var msg = MessageBuilder.withPayload(json)
                .setHeader(MqttHeaders.RECEIVED_TOPIC, "devices/ESP32_ROOM_101/telemetry")
                .build();

        realDispatcher.dispatch(msg);

        verify(alertService).evaluateSensorHealth(
                eq("dev-1"),
                eq("ESP32_ROOM_101"),
                eq("room-1"),
                eq("zone-A"),
                eq(false),
                eq(true),
                eq(List.of())
        );
        verify(alertService).evaluateTelemetry(eq("dev-1"), eq("ESP32_ROOM_101"), eq("room-1"), eq("zone-A"), any());
        verify(telemetryRepository).save(any(TelemetryRecord.class));
    }

    @Test
    @DisplayName("Hạng mục 9: Bản tin trễ > 60s (store-and-forward) chứa giá trị ngoài dải cũng bỏ qua evaluateSensorHealth")
    void dispatch_telemetry_staleBufferedOutOfBoundsPacket_skipsEvaluateSensorHealth() {
        TelemetrySanitizerService realSanitizer = new TelemetrySanitizerService();
        MqttMessageDispatcherService realDispatcher = new MqttMessageDispatcherService(
                objectMapper,
                deviceMetadataCache,
                alertService,
                telemetryRepository,
                realSanitizer,
                discoveredDeviceService,
                comfortScoreService,
                mongoTemplate
        );
        realDispatcher.setDeviceWatchdogService(deviceWatchdogService);
        when(deviceMetadataCache.get("ESP32_ROOM_101")).thenReturn(Optional.of(mockDevice));

        String staleJson = """
        {
          "hardware_id": "ESP32_ROOM_101",
          "timestamp": %d,
          "data": {
            "environment": { "temperature": -99.0 }
          }
        }
        """.formatted(Instant.now().minusSeconds(120).getEpochSecond());

        var msg = MessageBuilder.withPayload(staleJson)
                .setHeader(MqttHeaders.RECEIVED_TOPIC, "devices/ESP32_ROOM_101/telemetry")
                .build();

        realDispatcher.dispatch(msg);

        verify(alertService, never()).evaluateSensorHealth(any(), any(), any(), any(), anyBoolean(), anyBoolean(), any());
        verify(alertService, never()).evaluateSensorHealth(any(), any(), any(), any(), anyBoolean(), anyBoolean());
        verify(telemetryRepository, never()).save(any());
    }
}
