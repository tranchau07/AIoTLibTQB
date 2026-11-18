package com.example.AIoTLibTQB.configuration;

import lombok.AccessLevel;
import lombok.RequiredArgsConstructor;
import lombok.experimental.FieldDefaults;
import lombok.extern.slf4j.Slf4j;
import org.springframework.messaging.Message;
import org.springframework.messaging.MessageChannel;
import org.springframework.messaging.MessageDeliveryException;
import org.springframework.messaging.simp.stomp.StompCommand;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.messaging.support.ChannelInterceptor;
import org.springframework.messaging.support.MessageBuilder;
import org.springframework.messaging.support.MessageHeaderAccessor;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtException;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationConverter;
import org.springframework.stereotype.Component;

import java.security.Principal;
import java.util.Objects;
import java.util.regex.Pattern;

/**
 * STOMP inbound channel security interceptor.
 * - Frame CONNECT: Validates JWT token from native Authorization headers and establishes authenticated Principal.
 * - Frame SUBSCRIBE: Enforces authentication (rejects unauthenticated subscription attempts).
 */
@Slf4j
@Component
@RequiredArgsConstructor
@FieldDefaults(level = AccessLevel.PRIVATE, makeFinal = true)
public class StompChannelInterceptor implements ChannelInterceptor {

    static final Pattern ZONE_ALERTS_TOPIC_PATTERN = Pattern.compile("^/topic/zones/[^/]+/alerts$");

    CustomJwtDecoder customJwtDecoder;
    JwtAuthenticationConverter jwtAuthenticationConverter;

    @Override
    public Message<?> preSend(Message<?> message, MessageChannel channel) {
        StompHeaderAccessor accessor = MessageHeaderAccessor.getAccessor(message, StompHeaderAccessor.class);
        if (accessor == null) {
            accessor = StompHeaderAccessor.wrap(message);
        }

        StompCommand command = accessor.getCommand();
        if (StompCommand.SEND.equals(command)) {
            String destination = accessor.getDestination();
            if (destination != null && destination.startsWith("/topic/")) {
                log.warn("STOMP SEND rejected: client attempted to publish to broker topic '{}'", destination);
                throw new MessageDeliveryException("Client SEND to broker topics is forbidden");
            }
        } else if (StompCommand.CONNECT.equals(command)) {
            Authentication authentication = authenticateConnect(accessor);
            if (accessor.isMutable()) {
                accessor.setUser(authentication);
                return message;
            } else {
                StompHeaderAccessor mutableAccessor = StompHeaderAccessor.create(command);
                mutableAccessor.copyHeaders(accessor.toMap());
                mutableAccessor.setUser(authentication);
                mutableAccessor.setLeaveMutable(true);
                return MessageBuilder.createMessage(message.getPayload(), mutableAccessor.getMessageHeaders());
            }
        } else if (StompCommand.SUBSCRIBE.equals(command)) {
            handleSubscribe(accessor);
        }

        return message;
    }

    private Authentication authenticateConnect(StompHeaderAccessor accessor) {
        String token = extractToken(accessor);
        String publicMode = accessor.getFirstNativeHeader("X-Public-Kiosk");
        if (token == null || token.isBlank()) {
            if ("true".equalsIgnoreCase(publicMode)) {
                log.debug("STOMP CONNECT allowed in anonymous public kiosk mode");
                return null;
            }
            log.warn("STOMP CONNECT rejected: missing Authorization header");
            throw new MessageDeliveryException("Missing or empty Authorization token for STOMP connection");
        }

        try {
            Jwt jwt = customJwtDecoder.decode(token);
            Authentication authentication = jwtAuthenticationConverter.convert(jwt);
            log.info("STOMP CONNECT authenticated successfully: user={}",
                    authentication != null ? authentication.getName() : "unknown");
            return authentication;
        } catch (JwtException e) {
            log.warn("STOMP CONNECT rejected: invalid JWT token: {}", e.getMessage());
            throw new MessageDeliveryException("Invalid JWT token: " + e.getMessage());
        } catch (MessageDeliveryException e) {
            throw e;
        } catch (Exception e) {
            log.warn("STOMP CONNECT rejected: authentication error: {}", e.getMessage());
            throw new MessageDeliveryException("Authentication error: " + e.getMessage());
        }
    }

    private void handleSubscribe(StompHeaderAccessor accessor) {
        String destination = accessor.getDestination();
        Principal user = accessor.getUser();
        if (user == null) {
            if (destination != null && destination.startsWith("/topic/public/rooms/")) {
                return;
            }
            log.warn("STOMP SUBSCRIBE rejected: user is not authenticated for destination {}",
                    destination);
            throw new MessageDeliveryException("Access denied: user must be authenticated to subscribe");
        }
        if (destination == null) {
            return;
        }

        boolean isAlertDestination = "/topic/alerts".equals(destination)
                || ZONE_ALERTS_TOPIC_PATTERN.matcher(destination).matches();
        if (isAlertDestination) {
            boolean canViewAlerts = user instanceof Authentication auth
                    && auth.getAuthorities() != null
                    && !auth.getAuthorities().isEmpty()
                    && auth.getAuthorities().stream()
                            .filter(Objects::nonNull)
                            .anyMatch(a -> "VIEW_ALERTS".equals(a.getAuthority())
                                    || "ADMIN".equals(a.getAuthority())
                                    || "ROLE_ADMIN".equals(a.getAuthority()));
            if (!canViewAlerts) {
                log.warn("STOMP SUBSCRIBE rejected: user {} lacks VIEW_ALERTS for {}", user.getName(), destination);
                throw new MessageDeliveryException("Access denied: VIEW_ALERTS permission required for " + destination);
            }
        }

        if (destination.startsWith("/topic/rooms/") && user instanceof Authentication auth) {
            boolean isDevice = auth.getAuthorities() != null && auth.getAuthorities().stream()
                    .anyMatch(a -> "DEVICE".equals(a.getAuthority()) || "ROLE_DEVICE".equals(a.getAuthority()));
            if (isDevice) {
                log.warn("STOMP SUBSCRIBE rejected: device {} cannot subscribe to room telemetry", user.getName());
                throw new MessageDeliveryException("Access denied: DEVICE role cannot subscribe to room telemetry");
            }
        }
    }

    private String extractToken(StompHeaderAccessor accessor) {
        String authHeader = accessor.getFirstNativeHeader("Authorization");
        if (authHeader == null || authHeader.isBlank()) {
            authHeader = accessor.getFirstNativeHeader("authorization");
        }
        if (authHeader == null || authHeader.isBlank()) {
            authHeader = accessor.getFirstNativeHeader("token");
        }
        if (authHeader != null && !authHeader.isBlank()) {
            if (authHeader.startsWith("Bearer ") || authHeader.startsWith("bearer ")) {
                return authHeader.substring(7).trim();
            }
            return authHeader.trim();
        }
        return null;
    }
}
