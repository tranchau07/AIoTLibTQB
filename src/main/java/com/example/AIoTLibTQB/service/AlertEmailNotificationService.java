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
import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;
import com.github.benmanes.caffeine.cache.Ticker;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.experimental.FieldDefaults;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.lang.Nullable;
import org.springframework.mail.SimpleMailMessage;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Kênh thông báo Email có kiểm soát chống làm phiền (P2-1 / M2):
 * 1. Gửi ngay cho cảnh báo CRITICAL (hoặc leo thang lên CRITICAL).
 * 2. Gửi leo thang cho cảnh báo HIGH ở trạng thái FIRING quá thời gian cấu hình (mặc định 10 phút) chưa ACK.
 * 3. Gửi thông báo Đã khắc phục (RESOLVED) cho các cảnh báo từng gửi email mở sự cố.
 * 4. Giới hạn tối đa 01 email mở sự cố / cooldown (mặc định 30 phút) / phòng; không gửi cho LOW và MEDIUM.
 */
@Slf4j
@Service
@FieldDefaults(level = AccessLevel.PRIVATE, makeFinal = true)
public class AlertEmailNotificationService {

    static final String DEFAULT_FROM_ADDRESS = "noreply@aiotlibtqb.edu.vn";
    static final long DEFAULT_COOLDOWN_MINUTES = 30L;
    static final long DEFAULT_HIGH_ESCALATION_MINUTES = 10L;
    static final ZoneId DISPLAY_ZONE = ZoneId.of("Asia/Ho_Chi_Minh");
    static final DateTimeFormatter DISPLAY_TIME_FORMAT =
            DateTimeFormatter.ofPattern("dd/MM/yyyy HH:mm:ss z").withZone(DISPLAY_ZONE);

    JavaMailSender mailSender;
    UserRepository userRepository;
    AlertRepository alertRepository;
    RoomRepository roomRepository;
    Clock clock;
    boolean enabled;
    String fromAddress;
    Duration cooldownDuration;
    Duration highEscalationDuration;

    @Getter
    Cache<String, Instant> roomCooldownCache;

    @Getter
    Set<String> emailedAlertIds = ConcurrentHashMap.newKeySet();

    public AlertEmailNotificationService(
            JavaMailSender mailSender,
            UserRepository userRepository,
            AlertRepository alertRepository,
            Clock clock
    ) {
        this(
                mailSender,
                userRepository,
                alertRepository,
                clock,
                null,
                true,
                DEFAULT_FROM_ADDRESS,
                DEFAULT_COOLDOWN_MINUTES,
                DEFAULT_HIGH_ESCALATION_MINUTES
        );
    }

    @Autowired
    public AlertEmailNotificationService(
            @Nullable JavaMailSender mailSender,
            @Nullable UserRepository userRepository,
            @Nullable AlertRepository alertRepository,
            @Nullable Clock clock,
            @Nullable RoomRepository roomRepository,
            @Value("${app.alert.email.enabled:false}") boolean enabled,
            @Value("${app.alert.email.from:" + DEFAULT_FROM_ADDRESS + "}") String fromAddress,
            @Value("${app.alert.email.cooldown-minutes:" + DEFAULT_COOLDOWN_MINUTES + "}") long cooldownMinutes,
            @Value("${app.alert.email.high-escalation-minutes:" + DEFAULT_HIGH_ESCALATION_MINUTES + "}") long highEscalationMinutes
    ) {
        this.mailSender = mailSender;
        this.userRepository = userRepository;
        this.alertRepository = alertRepository;
        this.clock = clock != null ? clock : Clock.systemUTC();
        this.roomRepository = roomRepository;
        this.enabled = enabled;
        this.fromAddress = (fromAddress != null && !fromAddress.isBlank()) ? fromAddress.trim() : DEFAULT_FROM_ADDRESS;
        long safeCooldownMinutes = Math.max(0L, cooldownMinutes);
        long safeEscalationMinutes = Math.max(0L, highEscalationMinutes);
        this.cooldownDuration = Duration.ofMinutes(safeCooldownMinutes);
        this.highEscalationDuration = Duration.ofMinutes(safeEscalationMinutes);

        long baseMillis = this.clock.millis();
        Ticker clockTicker = () -> Math.max(0L, this.clock.millis() - baseMillis) * 1_000_000L;
        Caffeine<Object, Object> cacheBuilder = Caffeine.newBuilder()
                .ticker(clockTicker)
                .maximumSize(2000);
        if (safeCooldownMinutes > 0) {
            cacheBuilder.expireAfterWrite(safeCooldownMinutes, TimeUnit.MINUTES);
        }
        this.roomCooldownCache = cacheBuilder.build();
    }

    /**
     * Gửi email ngay lập tức khi cảnh báo mức CRITICAL được tạo mới hoặc leo thang lên CRITICAL.
     * Bỏ qua hoàn toàn các mức LOW, MEDIUM và HIGH (HIGH sẽ do scheduler kiểm tra sau 10 phút chưa ACK).
     */
    public void onAlertFiredOrEscalated(Alert alert) {
        if (!isOperational() || alert == null || alert.getId() == null || alert.getId().isBlank()) {
            return;
        }
        if (alert.getStatus() == AlertStatus.RESOLVED) {
            return;
        }
        if (alert.getSeverity() != AlertSeverity.CRITICAL) {
            return;
        }
        trySendOpeningEmail(
                alert,
                false,
                "Cảnh báo mức CRITICAL phát sinh (hoặc leo thang) yêu cầu xử lý khẩn cấp."
        );
    }

    /**
     * Quét định kỳ mỗi phút tìm các cảnh báo mức HIGH vẫn ở trạng thái FIRING quá 10 phút chưa được ACK.
     */
    @Scheduled(fixedRate = 60000)
    public void scanUnacknowledgedHighAlerts() {
        if (!isOperational() || alertRepository == null) {
            return;
        }
        List<Alert> firingAlerts;
        try {
            firingAlerts = alertRepository.findByStatus(AlertStatus.FIRING);
        } catch (Exception ex) {
            log.warn("Failed to query FIRING alerts for email escalation: {}", ex.getMessage());
            return;
        }
        if (firingAlerts == null || firingAlerts.isEmpty()) {
            return;
        }

        Instant now = clock.instant();
        Instant cutoff = now.minus(highEscalationDuration);
        String reason = String.format(
                Locale.ROOT,
                "Cảnh báo mức HIGH vẫn đang ở trạng thái FIRING quá %d phút mà chưa được tiếp nhận (ACK).",
                highEscalationDuration.toMinutes()
        );

        for (Alert alert : firingAlerts) {
            if (alert == null || alert.getId() == null || alert.getId().isBlank()) {
                continue;
            }
            if (alert.getStatus() != AlertStatus.FIRING) {
                continue;
            }
            if (alert.getSeverity() != AlertSeverity.HIGH) {
                continue;
            }
            if (alert.getStartedAt() == null || alert.getStartedAt().isAfter(cutoff)) {
                continue;
            }
            trySendOpeningEmail(alert, true, reason);
        }
    }

    /**
     * Gửi email thông báo "Đã khắc phục sự cố (RESOLVED)" cho các cảnh báo từng gửi email mở sự cố.
     * Không bị chặn bởi bộ khóa cooldown mở sự cố 30 phút.
     */
    public void onAlertResolved(Alert alert) {
        if (!isOperational() || alert == null || alert.getId() == null || alert.getId().isBlank()) {
            return;
        }
        String alertId = alert.getId();
        if (!emailedAlertIds.remove(alertId)) {
            return;
        }

        List<String> recipients = resolveRecipients(alert.getZoneId());
        if (recipients.isEmpty()) {
            log.debug("No eligible email recipients for RESOLVED notification of alertId={}, zoneId={}",
                    alertId, alert.getZoneId());
            return;
        }

        String roomLabel = resolveRoomDisplay(alert.getRoomId());
        String metricLabel = resolveMetricLabel(alert);

        SimpleMailMessage mail = new SimpleMailMessage();
        mail.setFrom(fromAddress);
        mail.setTo(recipients.toArray(String[]::new));
        mail.setSubject(String.format(
                "[ĐÃ KHẮC PHỤC - RESOLVED] Sự cố tại %s đã được xử lý (%s)",
                roomLabel,
                metricLabel
        ));
        mail.setText(buildResolvedBody(alert, roomLabel, metricLabel));

        try {
            mailSender.send(mail);
            log.info("Sent RESOLVED email notification for alertId={} to {} recipient(s)", alertId, recipients.size());
        } catch (RuntimeException ex) {
            log.warn("Failed to send RESOLVED email notification for alertId={}: {}", alertId, ex.getMessage());
        }
    }

    /**
     * Tìm danh sách email hợp lệ (active == true, email != blank) gồm ADMIN và nhân sự có assignedZones chứa zoneId.
     */
    public List<String> resolveRecipients(String zoneId) {
        if (userRepository == null) {
            return List.of();
        }
        List<User> allUsers;
        try {
            allUsers = userRepository.findAll();
        } catch (Exception ex) {
            log.warn("Failed to load users for alert email recipient resolution: {}", ex.getMessage());
            return List.of();
        }
        if (allUsers == null || allUsers.isEmpty()) {
            return List.of();
        }

        String normalizedZone = (zoneId != null && !zoneId.isBlank()) ? zoneId.trim() : null;
        Set<String> recipients = new LinkedHashSet<>();

        for (User user : allUsers) {
            if (user == null || !user.isActive()) {
                continue;
            }
            String email = user.getEmail() != null ? user.getEmail().trim() : null;
            if (email == null || email.isBlank()) {
                continue;
            }

            boolean isAdmin = hasRole(user, "ADMIN") || hasRole(user, "ROLE_ADMIN");
            boolean isDeviceOnly = user.getRoles() != null && !user.getRoles().isEmpty()
                    && user.getRoles().stream()
                    .filter(Objects::nonNull)
                    .map(Role::getName)
                    .filter(Objects::nonNull)
                    .allMatch(r -> "DEVICE".equalsIgnoreCase(r) || "ROLE_DEVICE".equalsIgnoreCase(r));

            boolean zoneAssigned = normalizedZone != null
                    && user.getAssignedZones() != null
                    && user.getAssignedZones().stream()
                    .filter(Objects::nonNull)
                    .map(String::trim)
                    .anyMatch(normalizedZone::equals);

            if (isAdmin || (!isDeviceOnly && zoneAssigned)) {
                recipients.add(email);
            }
        }
        return new ArrayList<>(recipients);
    }

    private void trySendOpeningEmail(Alert alert, boolean isEscalationReminder, String reason) {
        String alertId = alert.getId();
        if (emailedAlertIds.contains(alertId)) {
            return;
        }

        Instant now = clock.instant();
        String cooldownKey = resolveCooldownKey(alert);
        if (isRoomInCooldown(cooldownKey, now)) {
            log.debug("Email alert suppressed by {}m room cooldown: cooldownKey={}, alertId={}",
                    cooldownDuration.toMinutes(), cooldownKey, alertId);
            return;
        }

        List<String> recipients = resolveRecipients(alert.getZoneId());
        if (recipients.isEmpty()) {
            log.debug("No eligible email recipients found for alertId={}, zoneId={}", alertId, alert.getZoneId());
            return;
        }

        if (!emailedAlertIds.add(alertId)) {
            return;
        }

        boolean claimedCooldown = tryClaimRoomCooldown(cooldownKey, now);
        if (!claimedCooldown) {
            emailedAlertIds.remove(alertId);
            log.debug("Concurrent email alert suppressed by {}m room cooldown: cooldownKey={}, alertId={}",
                    cooldownDuration.toMinutes(), cooldownKey, alertId);
            return;
        }

        String roomLabel = resolveRoomDisplay(alert.getRoomId());
        String metricLabel = resolveMetricLabel(alert);
        String prefix = isEscalationReminder ? "[LEO THANG - HIGH]" : "[KHẨN CẤP - CRITICAL]";

        SimpleMailMessage mail = new SimpleMailMessage();
        mail.setFrom(fromAddress);
        mail.setTo(recipients.toArray(String[]::new));
        mail.setSubject(String.format("%s Cảnh báo tại %s: %s", prefix, roomLabel, metricLabel));
        mail.setText(buildOpeningBody(alert, roomLabel, metricLabel, reason));

        try {
            mailSender.send(mail);
            log.info("Sent opening alert email ({}): alertId={}, cooldownKey={}, recipients={}",
                    prefix, alertId, cooldownKey, recipients.size());
        } catch (RuntimeException ex) {
            emailedAlertIds.remove(alertId);
            if (!cooldownDuration.isZero()) {
                roomCooldownCache.asMap().remove(cooldownKey, now);
            }
            log.warn("Failed to send opening alert email for alertId={}: {}", alertId, ex.getMessage());
        }
    }

    private boolean isOperational() {
        return enabled && mailSender != null;
    }

    private boolean isRoomInCooldown(String cooldownKey, Instant now) {
        if (cooldownDuration.isZero()) {
            return false;
        }
        Instant lastSent = roomCooldownCache.getIfPresent(cooldownKey);
        return lastSent != null && !lastSent.isAfter(now)
                && Duration.between(lastSent, now).compareTo(cooldownDuration) < 0;
    }

    private boolean tryClaimRoomCooldown(String cooldownKey, Instant now) {
        if (cooldownDuration.isZero()) {
            return true;
        }
        AtomicBoolean acquired = new AtomicBoolean(false);
        roomCooldownCache.asMap().compute(cooldownKey, (k, lastSent) -> {
            if (lastSent != null && !lastSent.isAfter(now)
                    && Duration.between(lastSent, now).compareTo(cooldownDuration) < 0) {
                return lastSent;
            }
            acquired.set(true);
            return now;
        });
        return acquired.get();
    }

    static String resolveCooldownKey(Alert alert) {
        if (alert.getRoomId() != null && !alert.getRoomId().isBlank()) {
            return "room:" + alert.getRoomId().trim();
        }
        if (alert.getDeviceId() != null && !alert.getDeviceId().isBlank()) {
            return "device:" + alert.getDeviceId().trim();
        }
        if (alert.getHardwareId() != null && !alert.getHardwareId().isBlank()) {
            return "hw:" + alert.getHardwareId().trim();
        }
        return "alert:" + alert.getId();
    }

    private boolean hasRole(User user, String targetRole) {
        if (user.getRoles() == null) {
            return false;
        }
        return user.getRoles().stream()
                .filter(Objects::nonNull)
                .map(Role::getName)
                .filter(Objects::nonNull)
                .anyMatch(targetRole::equalsIgnoreCase);
    }

    private String resolveRoomDisplay(String roomId) {
        if (roomId == null || roomId.isBlank()) {
            return "Không xác định phòng";
        }
        if (roomRepository != null) {
            try {
                Optional<Room> roomOpt = roomRepository.findById(roomId);
                if (roomOpt != null && roomOpt.isPresent()) {
                    Room room = roomOpt.get();
                    String code = room.getCode();
                    String name = room.getName();
                    if (code != null && !code.isBlank() && name != null && !name.isBlank()) {
                        return code + " - " + name;
                    }
                    if (name != null && !name.isBlank()) {
                        return name;
                    }
                    if (code != null && !code.isBlank()) {
                        return code;
                    }
                }
            } catch (Exception ex) {
                log.debug("Unable to load room info for roomId={}: {}", roomId, ex.getMessage());
            }
        }
        return roomId;
    }

    private String resolveMetricLabel(Alert alert) {
        String metricType = AlertRuleEngine.resolveMetricType(alert);
        return switch (metricType) {
            case "NOISE_PEAK" -> "Tiếng ồn đột biến (Peak)";
            case "NOISE_AVG" -> "Độ ồn trung bình vượt ngưỡng";
            case "TEMPERATURE" -> "Nhiệt độ vượt ngưỡng";
            case "HUMIDITY_HIGH" -> "Độ ẩm vượt ngưỡng tối đa";
            case "HUMIDITY_LOW" -> "Độ ẩm xuống dưới ngưỡng tối thiểu";
            case "PM2_5" -> "Bụi mịn PM2.5 vượt ngưỡng";
            case "DEVICE_OFFLINE" -> "Thiết bị mất kết nối";
            default -> alert.getType() != null ? alert.getType().name() : "Cảnh báo môi trường";
        };
    }

    private String buildOpeningBody(Alert alert, String roomLabel, String metricLabel, String reason) {
        String metricType = AlertRuleEngine.resolveMetricType(alert);
        String unit = AlertRuleEngine.resolveUnit(metricType, alert.getType());
        String measuredText = formatValue(alert.getCurrentValue(), unit, alert.getType() == AlertType.DEVICE_OFFLINE, true);
        String thresholdText = formatValue(alert.getThreshold(), unit, alert.getType() == AlertType.DEVICE_OFFLINE, false);
        String startedText = alert.getStartedAt() != null
                ? DISPLAY_TIME_FORMAT.format(alert.getStartedAt())
                : "--";

        return new StringBuilder()
                .append("HỆ THỐNG GIÁM SÁT MÔI TRƯỜNG THƯ VIỆN TẠ QUANG BỬU (AIoTLibTQB)\n")
                .append("================================================================\n")
                .append("Lý do thông báo : ").append(reason).append('\n')
                .append("Mã cảnh báo     : ").append(alert.getId()).append('\n')
                .append("Mức độ          : ").append(alert.getSeverity()).append('\n')
                .append("Loại sự cố      : ").append(metricLabel).append('\n')
                .append("Phòng           : ").append(roomLabel).append('\n')
                .append("Khu vực (Zone)  : ").append(safeText(alert.getZoneId())).append('\n')
                .append("Thiết bị        : ").append(resolveDeviceLabel(alert)).append('\n')
                .append("Giá trị đo      : ").append(measuredText).append('\n')
                .append("Ngưỡng quy định : ").append(thresholdText).append('\n')
                .append("Thời điểm       : ").append(startedText).append('\n')
                .append("Chi tiết        : ").append(safeText(alert.getMessage())).append("\n\n")
                .append("(Email được gửi tự động từ AIoTLibTQB; giới hạn tối đa 01 email mở sự cố / ")
                .append(cooldownDuration.toMinutes())
                .append(" phút / phòng để tránh làm phiền.)\n")
                .toString();
    }

    private String buildResolvedBody(Alert alert, String roomLabel, String metricLabel) {
        String startedText = alert.getStartedAt() != null ? DISPLAY_TIME_FORMAT.format(alert.getStartedAt()) : "--";
        String resolvedText = alert.getResolvedAt() != null ? DISPLAY_TIME_FORMAT.format(alert.getResolvedAt()) : "--";

        return new StringBuilder()
                .append("THÔNG BÁO KHẮC PHỤC SỰ CỐ THƯ VIỆN TẠ QUANG BỬU (AIoTLibTQB)\n")
                .append("================================================================\n")
                .append("Trạng thái      : ĐÃ KHẮC PHỤC (RESOLVED)\n")
                .append("Mã cảnh báo     : ").append(alert.getId()).append('\n')
                .append("Loại sự cố      : ").append(metricLabel).append('\n')
                .append("Mức độ ban đầu  : ").append(alert.getSeverity()).append('\n')
                .append("Phòng           : ").append(roomLabel).append('\n')
                .append("Khu vực (Zone)  : ").append(safeText(alert.getZoneId())).append('\n')
                .append("Thiết bị        : ").append(resolveDeviceLabel(alert)).append('\n')
                .append("Phát sinh lúc   : ").append(startedText).append('\n')
                .append("Khắc phục lúc   : ").append(resolvedText).append('\n')
                .append("Xử lý bởi       : ").append(safeText(alert.getResolvedBy())).append('\n')
                .append("Tiếp nhận trước : ").append(safeText(alert.getAcknowledgedBy())).append('\n')
                .append("Nội dung gốc    : ").append(safeText(alert.getMessage())).append("\n\n")
                .append("Sự cố đã trở về trạng thái an toàn / đã được đóng trên hệ thống.\n")
                .toString();
    }

    private String formatValue(Double value, String unit, boolean isOffline, boolean isMeasured) {
        if (isOffline) {
            return isMeasured ? "Mất kết nối (Offline)" : "--";
        }
        if (value == null) {
            return "--";
        }
        String formatted = String.format(Locale.US, "%.1f", value);
        return (unit != null && !unit.isBlank()) ? formatted + " " + unit : formatted;
    }

    private String resolveDeviceLabel(Alert alert) {
        String hw = alert.getHardwareId();
        String devId = alert.getDeviceId();
        if (hw != null && !hw.isBlank() && devId != null && !devId.isBlank()) {
            return hw + " (" + devId + ")";
        }
        if (hw != null && !hw.isBlank()) {
            return hw;
        }
        if (devId != null && !devId.isBlank()) {
            return devId;
        }
        return "--";
    }

    private String safeText(String val) {
        return (val != null && !val.isBlank()) ? val : "--";
    }
}
