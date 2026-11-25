package com.example.AIoTLibTQB.controller;

import com.example.AIoTLibTQB.dto.request.AlertWorkflowUpdateRequest;
import com.example.AIoTLibTQB.dto.response.AlertResponse;
import com.example.AIoTLibTQB.dto.response.ApiResponse;
import com.example.AIoTLibTQB.enums.AlertStatus;
import com.example.AIoTLibTQB.enums.AlertWorkflowStatus;
import com.example.AIoTLibTQB.service.AlertService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.annotation.PatchMapping;

import java.lang.reflect.Method;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
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
    void resolveAlert_handlesDefaultAndClampsSnoozeMinutes() throws NoSuchMethodException {
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

        Method resolveMethod = AlertController.class.getMethod("resolveAlert", String.class, Integer.class);
        PreAuthorize resolveAuth = resolveMethod.getAnnotation(PreAuthorize.class);
        assertThat(resolveAuth).isNotNull();
        assertThat(resolveAuth.value()).isEqualTo("hasAnyAuthority('ACKNOWLEDGE_ALERT', 'MANAGE_ALERT_CONFIG')");
    }

    @Test
    @DisplayName("TC-G6-04 (Controller): PATCH /api/v1/alerts/{id}/workflow bảo vệ quyền ACKNOWLEDGE_ALERT/MANAGE_ALERT_CONFIG và truyền đúng operator")
    void updateAlertWorkflow_delegatesWithOperatorAndSecuresEndpoint() throws NoSuchMethodException {
        SecurityContextHolder.getContext().setAuthentication(
                new UsernamePasswordAuthenticationToken("manager.tqb", "n/a", List.of())
        );

        AlertWorkflowUpdateRequest req = AlertWorkflowUpdateRequest.builder()
                .workflowStatus(AlertWorkflowStatus.IN_PROGRESS)
                .assignedTo("ktv.nam")
                .handlingNote("Đang chỉnh AHU")
                .build();
        AlertResponse updated = AlertResponse.builder()
                .id("alert-99")
                .status(AlertStatus.ACKNOWLEDGED)
                .workflowStatus(AlertWorkflowStatus.IN_PROGRESS)
                .assignedTo("ktv.nam")
                .handlingNote("Đang chỉnh AHU")
                .build();
        when(alertService.updateAlertWorkflow("alert-99", req, "manager.tqb")).thenReturn(updated);

        ApiResponse<AlertResponse> response = alertController.updateAlertWorkflow("alert-99", req);
        assertThat(response.getResult().getWorkflowStatus()).isEqualTo(AlertWorkflowStatus.IN_PROGRESS);
        assertThat(response.getResult().getAssignedTo()).isEqualTo("ktv.nam");
        assertThat(response.getResult().getHandlingNote()).isEqualTo("Đang chỉnh AHU");
        verify(alertService).updateAlertWorkflow("alert-99", req, "manager.tqb");

        // Null payload falls back safely to empty AlertWorkflowUpdateRequest
        when(alertService.updateAlertWorkflow(eq("alert-99"), any(AlertWorkflowUpdateRequest.class), eq("manager.tqb")))
                .thenReturn(updated);
        alertController.updateAlertWorkflow("alert-99", null);

        Method m = AlertController.class.getMethod("updateAlertWorkflow", String.class, AlertWorkflowUpdateRequest.class);
        PatchMapping patchMapping = m.getAnnotation(PatchMapping.class);
        PreAuthorize preAuthorize = m.getAnnotation(PreAuthorize.class);
        assertThat(patchMapping).isNotNull();
        assertThat(patchMapping.value()).containsExactly("/{id}/workflow");
        assertThat(preAuthorize).isNotNull();
        assertThat(preAuthorize.value()).isEqualTo("hasAnyAuthority('ACKNOWLEDGE_ALERT', 'MANAGE_ALERT_CONFIG')");
    }
}
