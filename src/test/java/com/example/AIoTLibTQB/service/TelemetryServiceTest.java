package com.example.AIoTLibTQB.service;

import com.example.AIoTLibTQB.document.AcousticMetrics;
import com.example.AIoTLibTQB.document.Device;
import com.example.AIoTLibTQB.document.TelemetryMetadata;
import com.example.AIoTLibTQB.document.TelemetryRecord;
import com.example.AIoTLibTQB.document.User;
import com.example.AIoTLibTQB.dto.response.TelemetryResponse;
import com.example.AIoTLibTQB.enums.ErrorCode;
import com.example.AIoTLibTQB.exception.AppException;
import com.example.AIoTLibTQB.repository.DeviceRepository;
import com.example.AIoTLibTQB.repository.TelemetryRepository;
import com.example.AIoTLibTQB.repository.UserRepository;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.MockedStatic;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContext;
import org.springframework.security.core.context.SecurityContextHolder;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class TelemetryServiceTest {

    @Mock TelemetryRepository telemetryRepository;
    @Mock DeviceRepository deviceRepository;
    @Mock UserRepository userRepository;

    @InjectMocks TelemetryService telemetryService;

    @Test
    @DisplayName("getLatestByDeviceId() - Trả về bản ghi mới nhất của thiết bị")
    void getLatestByDeviceId() {
        TelemetryRecord record = TelemetryRecord.builder()
                .id("rec-1")
                .timestamp(Instant.now())
                .metadata(TelemetryMetadata.builder().deviceId("dev-1").roomId("room-1").build())
                .acoustics(AcousticMetrics.builder().noiseAvg(45.0).build())
                .build();

        when(telemetryRepository.findTopByMetadataDeviceIdOrderByTimestampDesc("dev-1"))
                .thenReturn(Optional.of(record));

        TelemetryResponse res = telemetryService.getLatestByDeviceId("dev-1");
        assertThat(res).isNotNull();
        assertThat(res.getId()).isEqualTo("rec-1");
        assertThat(res.getAcoustics().getNoiseAvg()).isEqualTo(45.0);
    }

    @Test
    @DisplayName("getHistoryByRoomId() - Trả về danh sách chuỗi thời gian trong phòng")
    void getHistoryByRoomId() {
        TelemetryRecord record1 = TelemetryRecord.builder().id("rec-1").timestamp(Instant.now()).build();
        TelemetryRecord record2 = TelemetryRecord.builder().id("rec-2").timestamp(Instant.now().minusSeconds(10)).build();

        when(telemetryRepository.findByMetadataRoomIdAndTimestampBetweenOrderByTimestampDesc(eq("room-1"), any(), any()))
                .thenReturn(List.of(record1, record2));

        List<TelemetryResponse> list = telemetryService.getHistoryByRoomId("room-1", null, null);
        assertThat(list).hasSize(2);
    }

    @Test
    @DisplayName("getLatestByDeviceId() - ZONE_MANAGER bị từ chối khi thiết bị không thuộc assignedZones (C1)")
    void getLatestByDeviceId_zoneManagerDenied() {
        Authentication auth = mock(Authentication.class);
        SecurityContext ctx = mock(SecurityContext.class);
        doReturn(List.of(new SimpleGrantedAuthority("ZONE_MANAGER"))).when(auth).getAuthorities();
        when(auth.getName()).thenReturn("zm_user");
        when(ctx.getAuthentication()).thenReturn(auth);

        Device device = Device.builder().id("dev-1").zoneId("ZONE_SECRET").build();
        User manager = User.builder().username("zm_user").assignedZones(Set.of("ZONE_PUBLIC")).build();

        try (MockedStatic<SecurityContextHolder> holder = mockStatic(SecurityContextHolder.class)) {
            holder.when(SecurityContextHolder::getContext).thenReturn(ctx);
            when(deviceRepository.findById("dev-1")).thenReturn(Optional.of(device));
            when(userRepository.findByUsername("zm_user")).thenReturn(Optional.of(manager));

            assertThatThrownBy(() -> telemetryService.getLatestByDeviceId("dev-1"))
                    .isInstanceOf(AppException.class)
                    .extracting(e -> ((AppException) e).getErrorCode())
                    .isEqualTo(ErrorCode.ZONE_ACCESS_DENIED);
        }
    }
}
