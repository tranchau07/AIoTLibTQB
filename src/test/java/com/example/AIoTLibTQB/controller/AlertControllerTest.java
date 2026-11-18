package com.example.AIoTLibTQB.controller;

import com.example.AIoTLibTQB.dto.response.AlertResponse;
import com.example.AIoTLibTQB.dto.response.ApiResponse;
import com.example.AIoTLibTQB.enums.AlertStatus;
import com.example.AIoTLibTQB.service.AlertService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class AlertControllerTest {

    @Mock
    private AlertService alertService;

    @InjectMocks
    private AlertController alertController;

    @AfterEach
    void clearSecurityContext() {
        SecurityContextHolder.clearContext();
    }

    @Test
    @DisplayName("resolveAlert() - Mặc định snoozeMinutes=15 khi null, giữ giá trị hợp lệ và kẹp trong [0, 240]")
    void resolveAlert_handlesDefaultAndClampsSnoozeMinutes() {
        SecurityContextHolder.getContext().setAuthentication(
                new UsernamePasswordAuthenticationToken("librarian_tqb", "n/a", List.of())
        );

        AlertResponse resolvedResp = AlertResponse.builder()
                .id("a-1")
                .status(AlertStatus.RESOLVED)
                .build();
        when(alertService.resolveAlert("a-1", "librarian_tqb", 15)).thenReturn(resolvedResp);
        when(alertService.resolveAlert("a-1", "librarian_tqb", 30)).thenReturn(resolvedResp);
        when(alertService.resolveAlert("a-1", "librarian_tqb", 0)).thenReturn(resolvedResp);
        when(alertService.resolveAlert("a-1", "librarian_tqb", 240)).thenReturn(resolvedResp);

        ApiResponse<AlertResponse> defaultRes = alertController.resolveAlert("a-1", null);
        assertThat(defaultRes.getResult().getStatus()).isEqualTo(AlertStatus.RESOLVED);
        verify(alertService).resolveAlert("a-1", "librarian_tqb", 15);

        alertController.resolveAlert("a-1", 30);
        verify(alertService).resolveAlert("a-1", "librarian_tqb", 30);

        alertController.resolveAlert("a-1", -15);
        verify(alertService).resolveAlert("a-1", "librarian_tqb", 0);

        alertController.resolveAlert("a-1", 600);
        verify(alertService).resolveAlert("a-1", "librarian_tqb", 240);
    }
}
