package com.example.AIoTLibTQB.service;

import com.example.AIoTLibTQB.document.Alert;
import com.example.AIoTLibTQB.document.Role;
import com.example.AIoTLibTQB.document.Room;
import com.example.AIoTLibTQB.document.User;
import com.example.AIoTLibTQB.enums.AlertSeverity;
import com.example.AIoTLibTQB.enums.AlertStatus;
import com.example.AIoTLibTQB.enums.AlertType;
import com.example.AIoTLibTQB.repository.AlertRepository;
import com.example.AIoTLibTQB.repository.RoomRepository;
import com.example.AIoTLibTQB.repository.UserRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.mail.MailSendException;
import org.springframework.mail.SimpleMailMessage;
import org.springframework.mail.javamail.JavaMailSender;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class AlertEmailNotificationServiceTest {

    @Mock
    JavaMailSender mailSender;

    @Mock
    UserRepository userRepository;

    @Mock
    AlertRepository alertRepository;

    @Mock
    RoomRepository roomRepository;

    MutableClock clock;
    AlertEmailNotificationService service;

    static class MutableClock extends Clock {
        private Instant instant;

        MutableClock(Instant initial) {
            this.instant = initial;
        }

        void advance(Duration d) {
            this.instant = this.instant.plus(d);
        }

        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return instant;
        }
    }

    private User adminUser;
    private User librarianZoneA;
    private User librarianZoneB;
    private User inactiveZoneA;
    private User blankEmailZoneA;
    private User deviceZoneA;

    @BeforeEach
    void setUp() {
        clock = new MutableClock(Instant.parse("2026-10-22T10:00:00Z"));
        service = new AlertEmailNotificationService(
                mailSender,
                userRepository,
                alertRepository,
                clock,
                roomRepository,
                true,
                "noreply@aiotlibtqb.edu.vn",
                30,
                10
        );

        Role adminRole = Role.builder().name("ADMIN").build();
        Role libRole = Role.builder().name("LIBRARIAN").build();
        Role deviceRole = Role.builder().name("DEVICE").build();

        adminUser = User.builder()
                .id("u-admin")
                .username("admin")
                .email("admin@lib.edu.vn")
                .isActive(true)
                .roles(Set.of(adminRole))
                .build();
        librarianZoneA = User.builder()
                .id("u-lib-a")
                .username("lib_a")
                .email("lib-a@lib.edu.vn")
                .isActive(true)
                .roles(Set.of(libRole))
                .assignedZones(Set.of("ZONE_A"))
                .build();
        librarianZoneB = User.builder()
                .id("u-lib-b")
                .username("lib_b")
                .email("lib-b@lib.edu.vn")
                .isActive(true)
                .roles(Set.of(libRole))
                .assignedZones(Set.of("ZONE_B"))
                .build();
        inactiveZoneA = User.builder()
                .id("u-inactive")
                .username("old_staff")
                .email("inactive@lib.edu.vn")
                .isActive(false)
                .roles(Set.of(libRole))
                .assignedZones(Set.of("ZONE_A"))
                .build();
        blankEmailZoneA = User.builder()
                .id("u-no-email")
                .username("noemail_a")
                .email("   ")
                .isActive(true)
                .roles(Set.of(libRole))
                .assignedZones(Set.of("ZONE_A"))
                .build();
        deviceZoneA = User.builder()
                .id("u-device")
                .username("esp32_a")
                .email("device-a@lib.edu.vn")
                .isActive(true)
                .roles(Set.of(deviceRole))
                .assignedZones(Set.of("ZONE_A"))
                .build();
    }

    @Test
    @DisplayName("LOW và MEDIUM tuyệt đối không bao giờ gửi email, kể cả qua scheduler 30+ phút")
    void lowAndMediumSeverity_neverSendEmail() {
        Alert mediumTemp = Alert.builder()
                .id("alert-med-1")
                .roomId("room-1")
                .zoneId("ZONE_A")
                .deviceId("dev-1")
                .hardwareId("HW-1")
                .type(AlertType.AIR_UNHEALTHY)
                .metricType("TEMPERATURE")
                .severity(AlertSeverity.MEDIUM)
                .status(AlertStatus.FIRING)
                .currentValue(34.0)
                .threshold(32.0)
                .startedAt(clock.instant())
                .build();
        Alert lowAlert = Alert.builder()
                .id("alert-low-1")
                .roomId("room-1")
                .zoneId("ZONE_A")
                .type(AlertType.AIR_UNHEALTHY)
                .metricType("TEMPERATURE")
                .severity(AlertSeverity.LOW)
                .status(AlertStatus.FIRING)
                .startedAt(clock.instant())
                .build();

        service.onAlertFiredOrEscalated(mediumTemp);
        service.onAlertFiredOrEscalated(lowAlert);

        when(alertRepository.findByStatus(AlertStatus.FIRING)).thenReturn(List.of(mediumTemp, lowAlert));
        clock.advance(Duration.ofMinutes(35));
        service.scanUnacknowledgedHighAlerts();

        mediumTemp.setStatus(AlertStatus.RESOLVED);
        mediumTemp.setResolvedAt(clock.instant());
        mediumTemp.setResolvedBy("SYSTEM");
        service.onAlertResolved(mediumTemp);

        verify(mailSender, never()).send(any(SimpleMailMessage.class));
        assertThat(service.getEmailedAlertIds()).isEmpty();
    }

    @Test
    @DisplayName("CRITICAL gửi ngay cho ADMIN & staff đúng Zone; khóa 30p/phòng chặn spam cùng phòng nhưng cho phép phòng khác hoặc sau 30p")
    void criticalAlert_sendsImmediatelyToEligibleRecipients_andEnforces30MinRoomCooldown() {
        when(userRepository.findAll()).thenReturn(List.of(
                adminUser, librarianZoneA, librarianZoneB, inactiveZoneA, blankEmailZoneA, deviceZoneA));
        when(roomRepository.findById("room-1")).thenReturn(Optional.of(Room.builder()
                .id("room-1").code("P201").name("Phòng đọc yên tĩnh 201").build()));

        Alert firstCritical = Alert.builder()
                .id("alert-crit-1")
                .roomId("room-1")
                .zoneId("ZONE_A")
                .deviceId("dev-1")
                .hardwareId("HW-1")
                .type(AlertType.NOISE_EXCEEDED)
                .metricType("NOISE_PEAK")
                .severity(AlertSeverity.CRITICAL)
                .status(AlertStatus.FIRING)
                .currentValue(88.0)
                .threshold(85.0)
                .message("Peak noise exceeded 85 dBA: 88.0 dBA")
                .startedAt(clock.instant())
                .build();

        service.onAlertFiredOrEscalated(firstCritical);

        ArgumentCaptor<SimpleMailMessage> mailCaptor = ArgumentCaptor.forClass(SimpleMailMessage.class);
        verify(mailSender, times(1)).send(mailCaptor.capture());

        SimpleMailMessage sent1 = mailCaptor.getValue();
        assertThat(sent1.getTo()).containsExactlyInAnyOrder("admin@lib.edu.vn", "lib-a@lib.edu.vn");
        assertThat(sent1.getTo()).doesNotContain("lib-b@lib.edu.vn", "inactive@lib.edu.vn", "device-a@lib.edu.vn");
        assertThat(sent1.getFrom()).isEqualTo("noreply@aiotlibtqb.edu.vn");
        assertThat(sent1.getSubject()).contains("CRITICAL").contains("P201 - Phòng đọc yên tĩnh 201");
        assertThat(sent1.getText()).contains("88.0 dBA").contains("85.0 dBA").doesNotContain("SOP");

        // 5 phút sau, phòng room-1 phát sinh cảnh báo CRITICAL thứ 2 -> Bị khóa cooldown 30p chặn
        clock.advance(Duration.ofMinutes(5));
        Alert secondCriticalSameRoom = Alert.builder()
                .id("alert-crit-2")
                .roomId("room-1")
                .zoneId("ZONE_A")
                .deviceId("dev-2")
                .hardwareId("HW-2")
                .type(AlertType.NOISE_EXCEEDED)
                .metricType("NOISE_PEAK")
                .severity(AlertSeverity.CRITICAL)
                .status(AlertStatus.FIRING)
                .currentValue(91.0)
                .threshold(85.0)
                .startedAt(clock.instant())
                .build();
        service.onAlertFiredOrEscalated(secondCriticalSameRoom);
        verify(mailSender, times(1)).send(any(SimpleMailMessage.class));
        assertThat(service.getEmailedAlertIds()).containsExactly("alert-crit-1");

        // Cùng lúc đó ở phòng khác (room-2, ZONE_B) -> Vẫn gửi ngay bình thường
        Alert criticalOtherRoom = Alert.builder()
                .id("alert-crit-r2")
                .roomId("room-2")
                .zoneId("ZONE_B")
                .deviceId("dev-3")
                .hardwareId("HW-3")
                .type(AlertType.NOISE_EXCEEDED)
                .metricType("NOISE_PEAK")
                .severity(AlertSeverity.CRITICAL)
                .status(AlertStatus.FIRING)
                .currentValue(87.0)
                .threshold(85.0)
                .startedAt(clock.instant())
                .build();
        service.onAlertFiredOrEscalated(criticalOtherRoom);
        ArgumentCaptor<SimpleMailMessage> secondCaptor = ArgumentCaptor.forClass(SimpleMailMessage.class);
        verify(mailSender, times(2)).send(secondCaptor.capture());
        assertThat(secondCaptor.getValue().getTo())
                .containsExactlyInAnyOrder("admin@lib.edu.vn", "lib-b@lib.edu.vn");

        // Quá 30 phút (tổng 31p kể từ alert-crit-1) -> room-1 được mở khóa cho cảnh báo mới
        clock.advance(Duration.ofMinutes(26));
        Alert thirdCriticalSameRoom = Alert.builder()
                .id("alert-crit-3")
                .roomId("room-1")
                .zoneId("ZONE_A")
                .deviceId("dev-1")
                .type(AlertType.NOISE_EXCEEDED)
                .metricType("NOISE_PEAK")
                .severity(AlertSeverity.CRITICAL)
                .status(AlertStatus.FIRING)
                .currentValue(90.0)
                .threshold(85.0)
                .startedAt(clock.instant())
                .build();
        service.onAlertFiredOrEscalated(thirdCriticalSameRoom);
        verify(mailSender, times(3)).send(any(SimpleMailMessage.class));
    }

    @Test
    @DisplayName("HIGH chưa ACK > 10 phút gửi mail leo thang; đã ACK hoặc chưa đủ 10 phút không gửi; RESOLVED luôn gửi mail khắc phục bất chấp cooldown")
    void highUnackedEscalation_andResolvedBypassCooldown() {
        when(userRepository.findAll()).thenReturn(List.of(adminUser, librarianZoneA, librarianZoneB));

        Instant startTime = clock.instant();
        Alert highHumidity = Alert.builder()
                .id("alert-high-1")
                .roomId("room-kho-1")
                .zoneId("ZONE_A")
                .deviceId("dev-kho")
                .hardwareId("HW-KHO")
                .type(AlertType.AIR_UNHEALTHY)
                .metricType("HUMIDITY_HIGH")
                .severity(AlertSeverity.HIGH)
                .status(AlertStatus.FIRING)
                .currentValue(78.0)
                .threshold(70.0)
                .message("Humidity exceeded max threshold: 78.0 %RH > 70.0 %RH")
                .startedAt(startTime)
                .build();

        // Mới phát sinh HIGH: chưa gửi mail ngay
        service.onAlertFiredOrEscalated(highHumidity);
        verify(mailSender, never()).send(any(SimpleMailMessage.class));

        // Phút thứ 9: chưa quá 10 phút -> quét không gửi
        clock.advance(Duration.ofMinutes(9));
        when(alertRepository.findByStatus(AlertStatus.FIRING)).thenReturn(List.of(highHumidity));
        service.scanUnacknowledgedHighAlerts();
        verify(mailSender, never()).send(any(SimpleMailMessage.class));

        // Nếu đã chuyển ACKNOWLEDGED ở phút 9 rồi quét ở phút 11 -> findByStatus(FIRING) không trả hoặc filter loại bỏ -> không gửi
        Alert ackedCopy = Alert.builder()
                .id("alert-high-acked")
                .roomId("room-kho-2")
                .zoneId("ZONE_A")
                .severity(AlertSeverity.HIGH)
                .status(AlertStatus.ACKNOWLEDGED)
                .startedAt(startTime)
                .build();

        // Phút thứ 11: highHumidity vẫn FIRING -> Gửi 1 mail leo thang HIGH
        clock.advance(Duration.ofMinutes(2));
        when(alertRepository.findByStatus(AlertStatus.FIRING)).thenReturn(List.of(highHumidity, ackedCopy));
        service.scanUnacknowledgedHighAlerts();

        ArgumentCaptor<SimpleMailMessage> mailCaptor = ArgumentCaptor.forClass(SimpleMailMessage.class);
        verify(mailSender, times(1)).send(mailCaptor.capture());
        assertThat(mailCaptor.getValue().getSubject()).contains("LEO THANG - HIGH");
        assertThat(mailCaptor.getValue().getText()).contains("78.0 %RH").contains("10 phút");
        assertThat(service.getEmailedAlertIds()).contains("alert-high-1");

        // Chạy quét lại ở phút 12 -> Không gửi trùng cho alert-high-1
        clock.advance(Duration.ofMinutes(1));
        service.scanUnacknowledgedHighAlerts();
        verify(mailSender, times(1)).send(any(SimpleMailMessage.class));

        // Phút 13 (vẫn trong 30p cooldown mở sự cố): sự cố chuyển RESOLVED -> Phải gửi ngay 1 mail Đã khắc phục (không bị cooldown chặn)
        clock.advance(Duration.ofMinutes(1));
        highHumidity.setStatus(AlertStatus.RESOLVED);
        highHumidity.setResolvedAt(clock.instant());
        highHumidity.setResolvedBy("SYSTEM");
        service.onAlertResolved(highHumidity);

        ArgumentCaptor<SimpleMailMessage> resolvedCaptor = ArgumentCaptor.forClass(SimpleMailMessage.class);
        verify(mailSender, times(2)).send(resolvedCaptor.capture());
        SimpleMailMessage resolvedMail = resolvedCaptor.getValue();
        assertThat(resolvedMail.getSubject()).contains("ĐÃ KHẮC PHỤC - RESOLVED");
        assertThat(resolvedMail.getText()).contains("SYSTEM");
        assertThat(service.getEmailedAlertIds()).doesNotContain("alert-high-1");

        // Idempotent nếu gọi resolved thêm lần nữa
        service.onAlertResolved(highHumidity);
        verify(mailSender, times(2)).send(any(SimpleMailMessage.class));
    }

    @Test
    @DisplayName("Lỗi SMTP rollback trạng thái để không khóa nhầm phòng; enabled=false hoặc mailSender=null an toàn tuyệt đối")
    void smtpFailureRollsBackClaim_andDisabledOrNullMailSenderIsSafe() {
        when(userRepository.findAll()).thenReturn(List.of(adminUser));
        doThrow(new MailSendException("SMTP timeout"))
                .doNothing()
                .when(mailSender).send(any(SimpleMailMessage.class));

        Alert critical = Alert.builder()
                .id("alert-crit-err")
                .roomId("room-err")
                .zoneId("ZONE_A")
                .type(AlertType.NOISE_EXCEEDED)
                .metricType("NOISE_PEAK")
                .severity(AlertSeverity.CRITICAL)
                .status(AlertStatus.FIRING)
                .currentValue(90.0)
                .threshold(85.0)
                .startedAt(clock.instant())
                .build();

        // Lần 1 SMTP lỗi -> rollback claim
        service.onAlertFiredOrEscalated(critical);
        assertThat(service.getEmailedAlertIds()).isEmpty();
        assertThat(service.getRoomCooldownCache().getIfPresent("room:room-err")).isNull();

        // Lần 2 không bị cooldown oan và gửi thành công
        service.onAlertFiredOrEscalated(critical);
        assertThat(service.getEmailedAlertIds()).containsExactly("alert-crit-err");

        // Disabled flag & null mailSender
        AlertEmailNotificationService disabledService = new AlertEmailNotificationService(
                mailSender, userRepository, alertRepository, clock, roomRepository,
                false, "noreply@aiotlibtqb.edu.vn", 30, 10);
        disabledService.onAlertFiredOrEscalated(critical);
        disabledService.scanUnacknowledgedHighAlerts();
        disabledService.onAlertResolved(critical);
        verify(mailSender, times(2)).send(any(SimpleMailMessage.class));

        AlertEmailNotificationService nullMailService = new AlertEmailNotificationService(
                null, userRepository, alertRepository, clock);
        nullMailService.onAlertFiredOrEscalated(critical);
        nullMailService.scanUnacknowledgedHighAlerts();
        nullMailService.onAlertResolved(critical);
    }
}
