package com.example.AIoTLibTQB.service;

import com.example.AIoTLibTQB.configuration.MqttProperties;
import com.example.AIoTLibTQB.dto.mqtt.DeviceCommandPayload;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.experimental.FieldDefaults;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.integration.mqtt.support.MqttHeaders;
import org.springframework.messaging.Message;
import org.springframework.messaging.MessageChannel;
import org.springframework.messaging.support.MessageBuilder;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

@Slf4j
@Component
@FieldDefaults(level = AccessLevel.PRIVATE, makeFinal = true)
public class DeviceCommandPublisherImpl implements DeviceCommandPublisher {

    MessageChannel mqttOutboundChannel;
    MqttProperties mqttProperties;
    ObjectMapper objectMapper;
    Clock clock;

    @Getter
    Map<String, String> lastSentLedStates = new ConcurrentHashMap<>();

    @Autowired
    public DeviceCommandPublisherImpl(
            @Autowired(required = false) @Qualifier("mqttOutboundChannel") MessageChannel mqttOutboundChannel,
            @Autowired(required = false) MqttProperties mqttProperties,
            @Autowired(required = false) ObjectMapper objectMapper,
            @Autowired(required = false) Clock clock
    ) {
        this.mqttOutboundChannel = mqttOutboundChannel;
        this.mqttProperties = mqttProperties;
        this.objectMapper = objectMapper != null ? objectMapper : new ObjectMapper();
        this.clock = clock != null ? clock : Clock.systemUTC();
    }

    @Override
    public void publishLedState(
            String hardwareId,
            String ledState,
            String reason,
            Double measuredValue,
            Double thresholdValue
    ) {
        if (hardwareId == null || hardwareId.isBlank() || ledState == null || ledState.isBlank()) {
            return;
        }
        String normalizedHw = hardwareId.trim();
        String normalizedState = ledState.trim();

        String previous = lastSentLedStates.get(normalizedHw);
        if (normalizedState.equals(previous)) {
            return;
        }
        // Không gửi lệnh NORMAL dư thừa nếu thiết bị vốn chưa từng bật đèn cảnh báo
        if (LED_NORMAL.equals(normalizedState) && previous == null) {
            return;
        }

        if (LED_NORMAL.equals(normalizedState)) {
            lastSentLedStates.remove(normalizedHw);
        } else {
            lastSentLedStates.put(normalizedHw, normalizedState);
        }

        String template = (mqttProperties != null && mqttProperties.getCommandTopicTemplate() != null
                && !mqttProperties.getCommandTopicTemplate().isBlank())
                ? mqttProperties.getCommandTopicTemplate()
                : "devices/%s/command";
        String topic = String.format(template, normalizedHw);

        DeviceCommandPayload payload = DeviceCommandPayload.builder()
                .command("SET_LED_STATE")
                .hardwareId(normalizedHw)
                .ledState(normalizedState)
                .reason(reason)
                .measuredValue(measuredValue)
                .thresholdValue(thresholdValue)
                .timestamp(clock.millis())
                .build();

        if (mqttOutboundChannel != null) {
            try {
                String json = objectMapper.writeValueAsString(payload);
                Message<String> msg = MessageBuilder.withPayload(json)
                        .setHeader(MqttHeaders.TOPIC, topic)
                        .setHeader(MqttHeaders.QOS, 1)
                        .setHeader(MqttHeaders.RETAINED, false)
                        .build();
                mqttOutboundChannel.send(msg);
                log.info("Published device LED command to {}: state={}, reason={}", topic, normalizedState, reason);
            } catch (Exception e) {
                log.warn("Failed to publish device LED command to {}: {}", topic, e.getMessage());
            }
        } else {
            log.debug("DeviceCommandPublisher (in-memory/stub): hardwareId={}, ledState={}, reason={}",
                    normalizedHw, normalizedState, reason);
        }
    }

    @Override
    public void clearDeviceState(String hardwareId) {
        if (hardwareId != null && !hardwareId.isBlank()) {
            lastSentLedStates.remove(hardwareId.trim());
        }
    }

    @Override
    public void reset() {
        lastSentLedStates.clear();
    }
}
