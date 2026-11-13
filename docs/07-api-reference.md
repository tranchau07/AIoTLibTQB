# 07 — Đặc Tả REST API, STOMP Topics & Mã Lỗi

> **Tài liệu**: `docs/07-api-reference.md` | **Phiên bản**: 2.1 | **Mã nguồn SSOT**: [`controller/*.java`](../src/main/java/com/example/AIoTLibTQB/controller/TelemetryController.java), [`dto/request/*.java`](../src/main/java/com/example/AIoTLibTQB/dto/request/RoomThresholdUpdateRequest.java), [`ErrorCode.java`](../src/main/java/com/example/AIoTLibTQB/enums/ErrorCode.java)
>
> [!NOTE]
> **TL;DR**: Backend cung cấp **9 REST Controllers** dưới `/api/v1/**` (cộng `/actuator/health|info`) luôn bọc chuẩn `ApiResponse<T>` / `PageResponse<T>`, **1 endpoint WebSocket STOMP** (`/ws-aiot` với 3 topic), và **46 mã lỗi chuẩn hóa** (`ErrorCode`). Dự án không dùng Swagger/SpringDoc; tài liệu này là tham chiếu API chính thức.

---

## 1. Hợp Đồng Envelope & Bean Validation Thực Tế

### 1.1. Cấu trúc Phản hồi Chuẩn (`ApiResponse<T>` & `PageResponse<T>`)
```json
{
  "code": 1000,
  "message": "Operation successful",
  "result": {
    "content": [],
    "page": 0,
    "size": 10,
    "totalElements": 0,
    "totalPages": 0,
    "last": true
  }
}
```
- `code == 1000`: Thành công. Mọi lỗi nghiệp vụ đi qua `GlobalExceptionHandler` trả về `code` tương ứng trong `ErrorCode` và ẩn `result` (`@JsonInclude(NON_NULL)`).
- Phân trang 0-indexed, `size` luôn được kẹp an toàn trong `[1, 100]`.

### 1.2. Ràng buộc Validation Chính thức trên Request DTOs (`dto/request/`)

| Request DTO | Ràng buộc `@Valid` thực tế trong mã nguồn Java |
| :--- | :--- |
| `AuthenticationRequest` | `username`: `@NotBlank`, `password`: `@NotBlank` |
| `IntrospectRequest` / `RefreshRequest` | `token`: `@NotBlank(message = "TOKEN_REQUIRED")` |
| `UserCreationRequest` | `username`: `@NotBlank(USERNAME_REQUIRED)`, `@Size(min = 6, message = "USERNAME_INVALID")`; `password`: `@NotBlank(PASSWORD_REQUIRED)`, `@Size(min = 8, max = 72, message = "PASSWORD_INVALID")` |
| `PasswordChangeRequest` | `oldPassword`: `@NotBlank(PASSWORD_REQUIRED)`, `@Size(max = 72)`; `newPassword`: `@NotBlank(PASSWORD_REQUIRED)`, `@Size(min = 8, max = 72, message = "PASSWORD_INVALID")` |
| `RoleRequest` / `PermissionRequest` | `name`: `@NotBlank(ROLE_NAME_REQUIRED / PERMISSION_NAME_REQUIRED)` |
| `RoomCreationRequest` | `code`: `@NotBlank(ROOM_CODE_REQUIRED)`; `name`: `@NotBlank(ROOM_NAME_REQUIRED)`; `floor`: `@NotNull(FLOOR_REQUIRED)`; `capacity`, `targetComfortScore`, `boundaryPolygon`, `type` tùy chọn |
| `RoomThresholdUpdateRequest` | Các ngưỡng `noiseAvgMax`, `noisePeakMax`, `noisePeakImmediate`, `tempMin`, `tempMax`, `humidityMin`, `humidityMax`, `pm25Max` kiểm tra `min < max` tại `RoomService#updateThresholds` |
| `DeviceRegistrationRequest` | `name`: `@NotBlank(DEVICE_NAME_REQUIRED)`; `hardwareId`: `@NotBlank(HARDWARE_ID_REQUIRED)`; `zoneId`: `@NotBlank(ZONE_ID_REQUIRED)`; `deviceType`: `@NotBlank(DEVICE_TYPE_REQUIRED)` |
| `DeviceAuthRequest` | `hardwareId`: `@NotBlank(HARDWARE_ID_REQUIRED)`; `apiKey`: `@NotBlank(API_KEY_REQUIRED)` |

---

## 2. Danh Mục 9 REST Controllers (`/api/v1/**` & Actuator)

### 2.1. Xác thực (`AuthenticationController` — `/api/v1/auth`)
*(Public + Rate Limit `10 req/min/IP` trên login/refresh/introspect)*

| Method | Endpoint | Mô tả & Ghi chú |
| :---: | :--- | :--- |
| `POST` | `/api/v1/auth/login` | Đăng nhập bằng `username`, `password` $\rightarrow$ `{token (1h), refreshToken (24h)}` |
| `POST` | `/api/v1/auth/introspect` | Kiểm tra token còn hợp lệ (`{valid: true|false}`) |
| `POST` | `/api/v1/auth/refresh` | Xoay vòng Refresh Token một lần (`Single-Use RTR`) |
| `POST` | `/api/v1/auth/logout` | Đưa `token` và `refreshToken` vào `invalidated_tokens` |

### 2.2. Người dùng (`UserController` — `/api/v1/users`)

| Method | Endpoint | Quyền (`@PreAuthorize`) | Mô tả & Ghi chú |
| :---: | :--- | :--- | :--- |
| `POST` | `/api/v1/users` | Public (`10 req/min/IP`) | Tạo tài khoản mới (mặc định vai trò `USER`) |
| `GET` | `/api/v1/users` | `ADMIN` | Phân trang `page`, `size`, `sortBy`, `direction` |
| `GET` | `/api/v1/users/myInfo` | Authenticated | Thông tin người dùng hiện tại + `roles` + `assignedZones` |
| `POST` | `/api/v1/users/change-password` | Authenticated | Đổi mật khẩu; cập nhật `credentialsUpdatedAt` để thu hồi mọi JWT cũ |
| `GET` | `/api/v1/users/{userId}` | `ADMIN` | Xem chi tiết tài khoản |
| `PUT` | `/api/v1/users/{userId}` | `ADMIN` | Cập nhật `phone`, `email`, `roles`, `assignedZones` |
| `PATCH` | `/api/v1/users/{userId}/status` | `ADMIN` | Khóa/mở khóa (`UserStatusRequest {active}`); cấm tự khóa (`1013`) |
| `DELETE` | `/api/v1/users/{userId}` | `ADMIN` | Xóa tài khoản; cấm tự xóa chính mình (`1014`) |

### 2.3. Vai trò & Quyền hạn (`RoleController`, `PermissionController`)
Toàn bộ yêu cầu quyền `ADMIN`:
- `POST /api/v1/roles`, `GET /api/v1/roles`, `PUT /api/v1/roles/{name}`, `DELETE /api/v1/roles/{name}` (cấm xóa system roles: code `2006`).
- `POST /api/v1/permissions`, `GET /api/v1/permissions`, `DELETE /api/v1/permissions/{name}` (cấm xóa khi đang gắn với role: code `2005`).

### 2.4. Phòng đọc (`RoomController` — `/api/v1/rooms`)

| Method | Endpoint | Quyền (`@PreAuthorize`) | Mô tả & Ghi chú |
| :---: | :--- | :--- | :--- |
| `POST` | `/api/v1/rooms` | `ADMIN`, `LIBRARIAN` | Tạo phòng đọc (`code` tự viết hoa, `RoomType`, `boundaryPolygon`) |
| `GET` | `/api/v1/rooms` | 6 vai trò nhân sự/bạn đọc | Phân trang `page`, `size`, lọc tùy chọn `?floor=` |
| `GET` | `/api/v1/rooms/{id}` | 6 vai trò nhân sự/bạn đọc | Chi tiết phòng kèm `thresholds` và `boundaryPolygon` |
| `GET` | `/api/v1/rooms/code/{code}` | 6 vai trò nhân sự/bạn đọc | Tra cứu theo mã phòng (`P101`, `KHO101`...) |
| `PUT` | `/api/v1/rooms/{id}` | `ADMIN`, `LIBRARIAN` | Cập nhật thông tin, `type`, `boundaryPolygon`; tự xóa cache LCS |
| `PUT` | `/api/v1/rooms/{id}/thresholds` | `ADMIN`, `LIBRARIAN` | Cập nhật `RoomThresholdConfig` (`noiseAvgMax`, `noisePeakMax`, **`noisePeakImmediate`**, `tempMin`, `tempMax`, `humidityMin`, `humidityMax`, `pm25Max`) và xóa cache `AlertRuleEngine` |
| `DELETE` | `/api/v1/rooms/{id}` | **`ADMIN`** | Xóa phòng (từ chối bằng `5006: ROOM_HAS_DEVICES` nếu còn thiết bị) |

### 2.5. Thiết bị IoT (`DeviceController` — `/api/v1/devices`)

| Method | Endpoint | Quyền (`@PreAuthorize`) | Mô tả & Ghi chú |
| :---: | :--- | :--- | :--- |
| `POST` | `/api/v1/devices/authenticate` | Public (`10 req/min/IP`) | Xác thực `hardwareId + apiKey` $\rightarrow$ Device JWT 8h |
| `GET` | `/api/v1/devices/discovered` | `ADMIN`, `LIBRARIAN` | Danh sách trạm mới phát hiện qua MQTT trong RAM 10 phút |
| `POST` | `/api/v1/devices` *(và `/register`)* | `ADMIN`, `LIBRARIAN` | Đăng ký trạm đo, trả về `apiKey` thô **1 lần duy nhất** |
| `GET` | `/api/v1/devices` | `ADMIN`, `LIBRARIAN`, `ZONE_MANAGER`, `MAINTENANCE`, `VIEWER`, `USER` | Phân trang `page`, `size` (lọc ngầm theo `assignedZones` nếu `ZONE_MANAGER`) |
| `GET` | `/api/v1/devices/{id}` | `ADMIN`, `LIBRARIAN`, `ZONE_MANAGER`, `MAINTENANCE`, `VIEWER`, `USER` | Chi tiết thiết bị (kiểm tra ABAC `ZONE_ACCESS_DENIED`) |
| `GET` | `/api/v1/devices/zone/{zoneId}` | `ADMIN`, `LIBRARIAN`, `ZONE_MANAGER`, `MAINTENANCE` | Liệt kê thiết bị theo phân khu |
| `PUT` | `/api/v1/devices/{id}` | `ADMIN`, `LIBRARIAN`, `ZONE_MANAGER` | Cập nhật vị trí `(posX, posY)`, phòng, tên, phân khu |
| `PATCH` | `/api/v1/devices/{id}/status?active=` | `ADMIN`, `LIBRARIAN` | Bật/tắt kích hoạt thiết bị (`isActive`) |
| `POST` | `/api/v1/devices/{id}/regenerate-key` | `ADMIN`, `LIBRARIAN` | Thu hồi khóa cũ, sinh khóa mới trả về **1 lần duy nhất** |
| `POST` | `/api/v1/devices/{id}/heartbeat` | `ADMIN`, `DEVICE` | Cập nhật `lastSeenAt` |
| `DELETE` | `/api/v1/devices/{id}` | `ADMIN` | Xóa thiết bị khỏi CSDL |

### 2.6. Cảnh báo (`AlertController` — `/api/v1/alerts`)

| Method | Endpoint | Quyền (`@PreAuthorize`) | Mô tả & Ghi chú |
| :---: | :--- | :--- | :--- |
| `GET` | `/api/v1/alerts` | `VIEW_ALERTS` | Lọc `roomId`, `type`, `status`; sort whitelist `startedAt`, `severity` (ánh xạ `severityRank`), `severityRank`, `status`, `type`, `currentValue` (`ASC`/`DESC`); tự lọc theo `assignedZones` với `ZONE_MANAGER` |
| `GET` | `/api/v1/alerts/unread-count` | `VIEW_ALERTS` | Số lượng cảnh báo đang `FIRING` (lọc theo `assignedZones` nếu là `ZONE_MANAGER`) |
| `POST` / `PATCH` | `/api/v1/alerts/{id}/acknowledge` | `ACKNOWLEDGE_ALERT` | Chuyển `FIRING` $\rightarrow$ `ACKNOWLEDGED`, ghi `acknowledgedBy` |
| `POST` / `PATCH` | `/api/v1/alerts/{id}/resolve` | `MANAGE_ALERT_CONFIG` | Đóng cảnh báo thủ công (`RESOLVED`), ghi `resolvedBy` |

### 2.7. Chuỗi thời gian & Tổng hợp (`TelemetryController` — `/api/v1/telemetry`)
*(Yêu cầu `ADMIN`, `LIBRARIAN`, `ZONE_MANAGER`, `MAINTENANCE`, `USER`, `VIEWER`; kiểm tra ABAC `assignedZones` ở service)*

| Method | Endpoint | Mô tả & Tham số |
| :---: | :--- | :--- |
| `GET` | `/api/v1/telemetry/device/{deviceId}/latest` | Bản tin mới nhất từ RAM cache (`LatestTelemetryCache`) |
| `GET` | `/api/v1/telemetry/room/{roomId}/latest` | Bản tin mới nhất cấp phòng từ RAM cache |
| `GET` | `/api/v1/telemetry/device/{deviceId}` | Lịch sử thô theo `start`, `end` (ISO-8601 UTC) |
| `GET` | `/api/v1/telemetry/room/{roomId}` | Lịch sử thô cấp phòng theo `start`, `end` |
| `GET` | `/api/v1/telemetry/room/{roomId}/buckets` | Downsampling `$dateTrunc`: `interval` (`15m` \| `1h` \| `1d`), `start`, `end` ($\le 1000$ buckets) |
| `GET` | `/api/v1/telemetry/overview/summary` | Thống kê toàn thư viện (`totalRooms`, `optimalRoomsCount`, `averageComfortScore`, `overallGrade` = `"N/A"` khi rỗng, `bestRoom`, `attentionRoom`, `worstRoom`) |

### 2.8. Cổng Công khai Kiosk (`PublicController` — `/api/v1/public`)
*(Public GET, Rate Limit `60 req/min/IP` — ẩn hoàn toàn `deviceId`, `hardwareId`)*

| Method | Endpoint | Mô tả |
| :---: | :--- | :--- |
| `GET` | `/api/v1/public/rooms?floor={floor}` | Danh sách `PublicRoomStatusResponse` toàn thư viện hoặc theo tầng kèm dữ liệu mới nhất |
| `GET` | `/api/v1/public/rooms/{id}/latest` | Trạng thái vi khí hậu & điểm LCS mới nhất của 1 phòng (ném `5002` nếu không tồn tại phòng) |

### 2.9. Giám sát Hạ tầng (`Actuator`)
- `GET /actuator/health` & `GET /actuator/info` (Public, dùng cho Docker healthcheck).

---

## 3. Giao Tiếp WebSocket STOMP (`/ws-aiot`)

- **Endpoint**: `ws://<host>:8080/ws-aiot` (Native WebSocket, không dùng SockJS).
- **3 Topic Subscribe**:
  1. `/topic/rooms/{roomId}/telemetry` — Luồng telemetry 1Hz đầy đủ cho nhân sự/người dùng đăng nhập (chặn `DEVICE`).
  2. `/topic/public/rooms/{roomId}/telemetry` — Luồng telemetry 1Hz đã lược bỏ `deviceId`/`hardwareId`, cho phép Kiosk nặc danh (`X-Public-Kiosk: true`).
  3. `/topic/alerts` — Sự kiện cảnh báo `FIRING` / `RESOLVED` thời gian thực (yêu cầu `VIEW_ALERTS`).

---

## 4. Từ Điển Toàn Bộ 46 Mã Lỗi (`ErrorCode.java`)

| Code | Hằng số Enum | HTTP Status | Thông điệp mặc định (`ErrorCode.java`) |
| :---: | :--- | :---: | :--- |
| `9999` | `UNCATEGORIZED_EXCEPTION` | 500 | Uncategorized exception |
| `1001` | `USER_EXISTED` | 400 | User already existed |
| `1002` | `USERNAME_INVALID` | 400 | Username must be at least 6 characters |
| `1003` | `PASSWORD_INVALID` | 400 | Password must be at least 8 characters |
| `1004` | `INVALID_MESSAGE_KEY` | 400 | Validation key is invalid |
| `1005` | `USER_DID_NOT_EXIST` | 404 | User does not exist |
| `1006` | `UNAUTHENTICATED` | 401 | Unauthenticated |
| `1007` | `UNAUTHORIZED` | 403 | You do not have permission |
| `1008` | `USER_INACTIVE` | 403 | Account is disabled. Please contact administrator |
| `1009` | `USERNAME_REQUIRED` | 400 | Username is required |
| `1010` | `PASSWORD_REQUIRED` | 400 | Password is required |
| `1011` | `OLD_PASSWORD_INCORRECT` | 400 | Current password does not match |
| `1012` | `PASSWORD_SAME_AS_OLD` | 400 | New password must be different from current password |
| `1013` | `CANNOT_DEACTIVATE_SELF` | 400 | Cannot deactivate your own account |
| `1014` | `CANNOT_DELETE_SELF` | 400 | Cannot delete your own account |
| `1015` | `TOKEN_REQUIRED` | 400 | Token is required |
| `2001` | `ROLE_EXISTED` | 400 | Role already existed |
| `2002` | `ROLE_NOT_EXISTED` | 404 | Role does not exist |
| `2003` | `PERMISSION_EXISTED` | 400 | Permission already existed |
| `2004` | `PERMISSION_NOT_EXISTED` | 404 | Permission does not exist |
| `2005` | `PERMISSION_IN_USE` | 400 | Permission is currently in use by one or more roles |
| `2006` | `CANNOT_DELETE_SYSTEM_ROLE` | 400 | Cannot delete system default role |
| `2007` | `ROLE_NAME_REQUIRED` | 400 | Role name is required |
| `2008` | `PERMISSION_NAME_REQUIRED` | 400 | Permission name is required |
| `3001` | `DEVICE_NOT_EXISTED` | 404 | Device does not exist |
| `3002` | `DEVICE_INACTIVE` | 403 | Device is disabled |
| `3003` | `INVALID_API_KEY` | 401 | Invalid API key |
| `3004` | `DEVICE_NAME_REQUIRED` | 400 | Device name is required |
| `3005` | `HARDWARE_ID_REQUIRED` | 400 | Hardware ID is required |
| `3006` | `ZONE_ID_REQUIRED` | 400 | Zone ID is required |
| `3007` | `DEVICE_TYPE_REQUIRED` | 400 | Device type is required |
| `3008` | `API_KEY_REQUIRED` | 400 | API key is required |
| `4029` | `TOO_MANY_REQUESTS` | 429 | Too many requests. Please try again later |
| `4031` | `ZONE_ACCESS_DENIED` | 403 | You do not have access to this zone |
| `5001` | `ROOM_EXISTED` | 400 | Room already existed |
| `5002` | `ROOM_NOT_EXISTED` | 404 | Room does not exist |
| `5003` | `ROOM_CODE_REQUIRED` | 400 | Room code is required |
| `5004` | `ROOM_NAME_REQUIRED` | 400 | Room name is required |
| `5005` | `FLOOR_REQUIRED` | 400 | Floor is required |
| `5006` | `ROOM_HAS_DEVICES` | 400 | Cannot delete room with associated devices |
| `6001` | `ALERT_NOT_EXISTED` | 404 | Alert does not exist |
| `7001` | `INVALID_TIME_RANGE` | 400 | Invalid time range: start must be before end |
| `7002` | `TOO_MANY_BUCKETS` | 400 | Too many buckets requested: maximum allowed is 1000 |
| `7003` | `INVALID_INTERVAL` | 400 | Invalid interval: supported intervals are 15m, 1h, 1d |
| `9001` | `INVALID_REQUEST_PAYLOAD` | 400 | Invalid request payload |
| `9002` | `INVALID_PARAMETER` | 400 | Invalid request parameter |

---

**Đọc tiếp**: [06 — Bảo mật & RBAC](./06-security-and-rbac.md) · [08 — Kiến trúc Frontend](./08-frontend-architecture.md) · [12 — Cẩm nang Vận hành](./12-runbook.md)
