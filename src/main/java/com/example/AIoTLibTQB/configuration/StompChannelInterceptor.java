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

    CustomJwtDecoder customJwtDecoder;
    JwtAuthenticationConverter jwtAuthenticationConverter;

    @Override
    public Message<?> preSend(Message<?> message, MessageChannel channel) {
        StompHeaderAccessor accessor = MessageHeaderAccessor.getAccessor(message, StompHeaderAccessor.class);
        if (accessor == null) {
            accessor = StompHeaderAccessor.wrap(message);
        }

        StompCommand command = accessor.getCommand();
        if (StompCommand.CONNECT.equals(command)) {
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
        if (token == null || token.isBlank()) {
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
        Principal user = accessor.getUser();
        if (user == null) {
            log.warn("STOMP SUBSCRIBE rejected: user is not authenticated for destination {}",
                    accessor.getDestination());
            throw new MessageDeliveryException("Access denied: user must be authenticated to subscribe");
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
