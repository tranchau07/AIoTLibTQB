package com.example.AIoTLibTQB.service;

import com.example.AIoTLibTQB.dto.response.AlertResponse;
import com.example.AIoTLibTQB.enums.AlertSeverity;
import com.example.AIoTLibTQB.enums.AlertStatus;
import com.example.AIoTLibTQB.enums.AlertType;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.messaging.simp.SimpMessagingTemplate;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class RealtimePublisherImplTest {

    @Mock
    SimpMessagingTemplate messagingTemplate;

    @Test
    @DisplayName("publishAlert() - Khi có zoneId hợp lệ -> gửi đồng thời tới /topic/alerts và /topic/zones/{zoneId}/alerts")
    void publishAlert_withZoneId_publishesToGlobalAndZoneTopics() {
        RealtimePublisherImpl publisher = new RealtimePublisherImpl(messagingTemplate);
        AlertResponse alert = AlertResponse.builder()
                .id("alert-1")
                .deviceId("dev-1")
                .roomId("room-1")
                .zoneId("ZONE_A")
                .type(AlertType.NOISE_EXCEEDED)
                .severity(AlertSeverity.HIGH)
                .status(AlertStatus.FIRING)
                .build();

        publisher.publishAlert(alert);

        verify(messagingTemplate, times(1)).convertAndSend("/topic/alerts", alert);
        verify(messagingTemplate, times(1)).convertAndSend("/topic/zones/ZONE_A/alerts", alert);
        verifyNoMoreInteractions(messagingTemplate);
    }

    @Test
    @DisplayName("publishAlert() - Khi zoneId null hoặc rỗng -> chỉ gửi tới /topic/alerts")
    void publishAlert_withoutZoneId_publishesOnlyToGlobalTopic() {
        RealtimePublisherImpl publisher = new RealtimePublisherImpl(messagingTemplate);
        AlertResponse nullZoneAlert = AlertResponse.builder()
                .id("alert-null-zone")
                .zoneId(null)
                .type(AlertType.DEVICE_OFFLINE)
                .status(AlertStatus.FIRING)
                .build();
        AlertResponse blankZoneAlert = AlertResponse.builder()
                .id("alert-blank-zone")
                .zoneId("   ")
                .type(AlertType.DEVICE_OFFLINE)
                .status(AlertStatus.FIRING)
                .build();

        publisher.publishAlert(nullZoneAlert);
        publisher.publishAlert(blankZoneAlert);

        verify(messagingTemplate, times(1)).convertAndSend("/topic/alerts", nullZoneAlert);
        verify(messagingTemplate, times(1)).convertAndSend("/topic/alerts", blankZoneAlert);
        verifyNoMoreInteractions(messagingTemplate);
    }

    @Test
    @DisplayName("publishAlert() - An toàn khi alert null hoặc SimpMessagingTemplate null (stub mode)")
    void publishAlert_nullAlertOrNullTemplate_safeNoOp() {
        RealtimePublisherImpl publisherWithTemplate = new RealtimePublisherImpl(messagingTemplate);
        RealtimePublisherImpl stubPublisher = new RealtimePublisherImpl(null);
        AlertResponse alert = AlertResponse.builder()
                .id("alert-stub")
                .zoneId("ZONE_A")
                .type(AlertType.AIR_UNHEALTHY)
                .status(AlertStatus.FIRING)
                .build();

        assertThatCode(() -> publisherWithTemplate.publishAlert(null)).doesNotThrowAnyException();
        assertThatCode(() -> stubPublisher.publishAlert(null)).doesNotThrowAnyException();
        assertThatCode(() -> stubPublisher.publishAlert(alert)).doesNotThrowAnyException();

        verify(messagingTemplate, never()).convertAndSend(anyString(), any(Object.class));
    }
}
