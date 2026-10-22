# BÁO CÁO PREFLIGHT WAVE 0: KHẢO SÁT & KHÓA GIAO DIỆN HỆ THỐNG

> **Dự án**: AIoTLibTQB | **Giai đoạn**: MVP Backend (T1–T6) | **Thời điểm**: 2026-10-22  
> **Trạng thái Baseline Test**: **PASS 100%** (`.\mvnw.cmd -q test` — 19 test files, 0 failures, exit code 0).

---

## 1. Kết Quả Xác Minh 9 Giả Định Kỹ Thuật (a)–(i)

| Giả định | Hiện trạng mã nguồn thực tế | Kết luận kỹ thuật |
| :--- | :--- | :--- |
| **(a) Trạng thái & lastSeenAt** | `Device.java:48,50` có sẵn `lastSeenAt: Instant` và `connectionState: String`. Cập nhật tại `MqttMessageDispatcherService:113,118,171` (`MongoTemplate $set`) và `DeviceService:79,171`. | Sử dụng `$set` qua `MongoTemplate` cho Watchdog (T3) và Ingestion; không gọi `save()` toàn entity. |
| **(b) Ngưỡng cảnh báo phòng** | `Room.java:37` chỉ có `targetComfortScore`, không có trường threshold động. Ngưỡng lọc nằm tại `TelemetrySanitizerService`, công thức tại `ComfortScoreService`. | Rule Engine FSM (T2) sử dụng ngưỡng hằng số nghiệp vụ chuẩn; không cần mở rộng DB Room schema. |
| **(c) Cơ chế ErrorCode & Handler** | `ErrorCode.java` định nghĩa `(code, message, httpStatus)`. `GlobalExceptionHandler` bắt `AppException`, `MethodArgumentNotValidException`, `AccessDeniedException`. | Đăng ký bổ sung mã lỗi chuẩn: `ROOM_HAS_DEVICES(5006)`, `INVALID_TIME_RANGE(7001)`, `TOO_MANY_BUCKETS(7002)`, `INVALID_INTERVAL(7003)`. |
| **(d) SecurityConfig & RateLimit** | `SecurityConfig.PUBLIC_POST_ENDPOINTS` & `RateLimitFilter.RATE_LIMITED_ENDPOINTS` đang dùng `/api/...`. `RateLimitFilter` chỉ lọc `POST`. | Wave 1 (T1) đổi URI sang `/api/v1/**`. Wave 2 (T5) mở permit `/ws-aiot/**`; không sợ bị RateLimit chặn WebSocket handshake. |
| **(e) WebSocket Dependency** | `pom.xml:108-110` đã khai báo sẵn `spring-boot-starter-websocket`. | Đã sẵn sàng 100%, tuyệt đối không thêm dependency ngoài vào `pom.xml`. |
| **(f) @EnableScheduling** | `AIoTLibTQBApplication.java:9` đã có annotation `@EnableScheduling`. | Đã kích hoạt sẵn cho tiến trình Watchdog định kỳ (T3) và Conflation 1Hz (T5). |
| **(g) noisePeak Sanitization** | `TelemetrySanitizerService:82,94` kiểm tra `[30.0, 130.0]` và **KHÔNG dùng forward-fill** cho `noisePeak`. | Cảnh báo đỉnh 75 dBA kích hoạt theo bản tin tức thời; FSM phải xử lý an toàn khi `noisePeak == null`. |
| **(h) Khai báo & Seed Permission** | `ApplicationInitConfig.java:42-89` đã seed 14 permissions: `VIEW_ALERTS`, `ACKNOWLEDGE_ALERT`, `MANAGE_ALERT_CONFIG`... | `AlertController` dùng trực tiếp `@PreAuthorize("hasAuthority('...')")` với quyền đã có. |
| **(i) Khái niệm Zone & STOMP** | `User` có `assignedZones` cho RBAC thiết bị, nhưng `Room` không có `zoneId` và không có Entity `Zone`. Topic là `/topic/rooms/{roomId}/**`. | Khung STOMP `SUBSCRIBE` tại `ChannelInterceptor` **chỉ kiểm tra xác thực người dùng (JWT hợp lệ)**. |

---

## 2. Khóa Chữ Ký Giao Diện Dùng Chung (Locked Signatures)

```java
// 1. DeviceMetadataCache (Caffeine Cache theo hardwareId - T6, dùng tại T1, T2, T3)
public interface DeviceMetadataCache {
    Optional<DeviceMetadata> get(String hardwareId);
    void put(String hardwareId, DeviceMetadata metadata);
    void invalidate(String hardwareId); // Hook bắt buộc cho T1 (DeviceService) và T3 (Watchdog)
}

// 2. AlertService (Quản lý cảnh báo & Máy trạng thái FSM - T2)
public interface AlertService {
    PageResponse<AlertResponse> getAlerts(String roomId, AlertType type, AlertStatus status, Pageable pageable);
    long getUnreadCount();
    AlertResponse acknowledgeAlert(String id, String username);
    AlertResponse resolveAlert(String id, String username);
    void evaluateTelemetry(String deviceId, String hardwareId, String roomId, TelemetryPayload.TelemetryData data);
    void triggerDeviceOfflineAlert(String deviceId, String hardwareId, String roomId);
    void resolveDeviceOfflineAlert(String hardwareId);
}

// 3. LatestTelemetryCache (Cache in-memory telemetry mới nhất theo phòng - T5, dùng tại T4 summary)
public interface LatestTelemetryCache {
    void putRoomTelemetry(String roomId, TelemetryResponse telemetry);
    Optional<TelemetryResponse> getRoomTelemetry(String roomId);
    Map<String, TelemetryResponse> getAllRoomLatest(); // Phục vụ tính bestRoom/attentionRoom không N+1
}

// 4. RealtimePublisher (Phát dữ liệu WebSocket STOMP - T5, dùng tại T2)
public interface RealtimePublisher {
    void publishRoomTelemetry(String roomId, Object payload);
    void publishAlert(AlertResponse alert);
}
```

---

## 3. Bảng Phân Công Sở Hữu Tệp (File Ownership Matrix)

| Agent / Wave | Nhiệm vụ | Danh mục Tệp Thuộc Quyền Sở Hữu Độc Quyền |
| :--- | :--- | :--- |
| **Agent A** (Wave 1) | **T1** + Chuẩn hóa API & Validation | `AuthenticationController`, `UserController`, `RoleController`, `PermissionController`, `DeviceController`, `RoomController`, `SecurityConfig` (Wave 1), `RateLimitFilter`, `DeviceService` (chỉ gọi hook `invalidate`), `RoomService`, `RoleService`, `ErrorCode`, `AuthenticationRequest` & DTOs T1, `AIoTLibTQB_Postman_Collection.json`, unit tests T1. |
| **Agent B** (Wave 1) | **T4 (Buckets)** | `TelemetryController` (chỉ endpoint `buckets`), `TelemetryService` (MongoDB Aggregation `$dateTrunc`), DTOs nén buckets, unit tests buckets. |
| **Agent C** (Wave 1) | **T6 → T2** | `DeviceMetadataCache`, `DeviceMetadataCacheImpl`, Semaphore trong `MqttMessageDispatcherService`, `AlertService`, `AlertServiceImpl`, `AlertController`, `AlertRuleEngine` (FSM in-memory), DTOs Alert, unit tests T6 & T2. |
| **Agent D** (Wave 2) | **T3** | `DeviceRepository` (`findByIsActiveTrueAndLastSeenAtBefore`), `DeviceWatchdogService` (`@Scheduled`, in-memory offline set, gọi hook `invalidate`), unit tests T3. |
| **Agent E** (Wave 2) | **T5 + T4 (Summary)** | `WebSocketConfig`, `StompChannelInterceptor`, `SecurityConfig` (Wave 2 mở `/ws-aiot/**`), `LatestTelemetryCache`, `LatestTelemetryCacheImpl`, `RealtimePublisher`, Conflation scheduler 1Hz, `TelemetryController` (endpoint `summary`), unit tests T5 & T4 summary. |
| **Reviewer** (Wave 3) | **Audit độc lập** | Read-only toàn bộ codebase theo DoD Mục 6 & ĐC1–ĐC7. Lead xử lý blocker nếu có. |

---

## 4. Wave 0 Gate & Dừng Chờ Lệnh

- **Kết luận Wave 0**: Đủ điều kiện kỹ thuật 100%. Không phát hiện xung đột hay lỗi tiềm ẩn.
- **Hành động bắt buộc**: Dừng toàn bộ tiến trình, gửi báo cáo tới Sentinel và **chờ phản hồi `"tiếp tục"` từ người dùng** trước khi kích hoạt Wave 1.
