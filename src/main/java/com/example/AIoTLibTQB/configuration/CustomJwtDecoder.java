package com.example.AIoTLibTQB.configuration;

import com.example.AIoTLibTQB.repository.InvalidatedTokenRepository;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.security.oauth2.core.OAuth2Error;
import org.springframework.security.oauth2.core.OAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2TokenValidatorResult;
import org.springframework.security.oauth2.jose.jws.MacAlgorithm;
import org.springframework.security.oauth2.jwt.*;
import org.springframework.stereotype.Component;

import javax.crypto.spec.SecretKeySpec;

@Component
public class CustomJwtDecoder implements JwtDecoder {

    private final NimbusJwtDecoder nimbusJwtDecoder;

    public CustomJwtDecoder(
            @Value("${jwt.secret-key}") String secretKey,
            InvalidatedTokenRepository invalidatedTokenRepository) {

        SecretKeySpec secretKeySpec = new SecretKeySpec(secretKey.getBytes(), "HS512");
        NimbusJwtDecoder decoder = NimbusJwtDecoder.withSecretKey(secretKeySpec)
                .macAlgorithm(MacAlgorithm.HS512)
                .build();

        OAuth2TokenValidator<Jwt> blacklistValidator = jwt -> {
            String jwtId = jwt.getId();
            if (jwtId != null && invalidatedTokenRepository.existsById(jwtId)) {
                return OAuth2TokenValidatorResult.failure(
                        new OAuth2Error("invalid_token", "Token has been invalidated", null)
                );
            }
            return OAuth2TokenValidatorResult.success();
        };

        OAuth2TokenValidator<Jwt> tokenTypeValidator = jwt -> {
            String tokenType = jwt.getClaimAsString("tokenType");
            if ("REFRESH".equalsIgnoreCase(tokenType)) {
                return OAuth2TokenValidatorResult.failure(
                        new OAuth2Error("invalid_token", "Refresh token cannot be used as an access token", null)
                );
            }
            return OAuth2TokenValidatorResult.success();
        };

        decoder.setJwtValidator(JwtValidators.createDefaultWithValidators(blacklistValidator, tokenTypeValidator));
        this.nimbusJwtDecoder = decoder;
    }

    @Override
    public Jwt decode(String token) throws JwtException {
        return nimbusJwtDecoder.decode(token);
    }
}
