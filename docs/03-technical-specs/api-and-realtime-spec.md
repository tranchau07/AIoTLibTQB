# Đặc Tả REST API, STOMP Realtime & Mã Lỗi / API, STOMP & Error Specification

> **Cơ sở kiểm chứng / Verified From:** `9` REST Controllers ([`controller/`](../../src/main/java/com/example/AIoTLibTQB/controller)), `19` Request DTOs, `18` Response DTOs, [`ErrorCode.java`](../../src/main/java/com/example/AIoTLibTQB/enums/ErrorCode.java), [`StompChannelInterceptor.java`](../../src/main/java/com/example/AIoTLibTQB/configuration/StompChannelInterceptor.java), [`RealtimePublisherImpl.java`](../../src/main/java/com/example/AIoTLibTQB/service/RealtimePublisherImpl.java).  
> **Lưu ý:** Backend không cài `springdoc-openapi` (`/swagger-ui.html` không tồn tại ở runtime); tài liệu này là nguồn đặc tả chuẩn của hợp đồng API.

---

## 1. Cấu Trúc Envelope & Phân Trang Chuẩn / Standard Envelopes & Pagination

### 1.1. `ApiResponse<T>` ([`ApiResponse.java`](../../src/main/java/com/example/AIoTLibTQB/dto/response/ApiResponse.java))
- Thành công mặc định: `code = 1000` kèm `result` (bỏ qua field `null` nhờ `@JsonInclude(NON_NULL)`).
- Lỗi nghiệp vụ / validation / rate limit: `code != 1000` (xem mục 4 — 48 mã lỗi) kèm `message`.

### 1.2. `PageResponse<T>` ([`PageResponse.java`](../../src/main/java/com/example/AIoTLibTQB/dto/response/PageResponse.java))
- Phân trang **0-based**: `{ content, page, size, totalElements, totalPages, last }`.
- Backend kẹp an toàn `page = Math.max(0, page)` và `size = Math.max(1, Math.min(100, size))`.

---

## 2. Danh Mục 9 REST Controllers (`/api/v1/**` & `/actuator/**`)

### 2.1. Xác thực — [`AuthenticationController`](../../src/main/java/com/example/AIoTLibTQB/controller/AuthenticationController.java) (`/api/v1/auth`)
| Method & Path | Quyền / Auth | Body / Params | Kết quả (`result`) |
| :--- | :---: | :--- | :--- |
| `POST /api/v1/auth/login` | Public *(Rate limit 10/phút)* | `AuthenticationRequest` (`username`, `password` `@NotBlank`) | `AuthenticationResponse` (`token`, `refreshToken`) |
| `POST /api/v1/auth/introspect` | Public *(Rate limit 10/phút)* | `IntrospectRequest` (`token` `@NotBlank`) | `IntrospectResponse` (`valid`) |
| `POST /api/v1/auth/logout` | Public | `LogoutRequest` (`token` `@NotBlank`, `refreshToken`) | `Void` *(đưa vào `invalidated_tokens`)* |
| `POST /api/v1/auth/refresh` | Public *(Rate limit 10/phút)* | `RefreshRequest` (`token` `@NotBlank`) | `AuthenticationResponse` *(xoay vòng RTR)* |

### 2.2. Người dùng — [`UserController`](../../src/main/java/com/example/AIoTLibTQB/controller/UserController.java) (`/api/v1/users`)
| Method & Path | Quyền / Auth (`UserService`) | Chi tiết / Notes |
| :--- | :--- | :--- |
| `POST /api/v1/users` | Public *(Rate limit 10/phút)* | `UserCreationRequest`: `username` `>= 6`, `password` `8..72`, `phone`, `email`; `roles` & `assignedZones` chỉ có hiệu lực khi caller có quyền `ADMIN` (khách tự đăng ký bị gắn `USER` và `assignedZones` rỗng). |
| `GET /api/v1/users` | `ADMIN` | `page`, `size`, `sortBy` *(whitelist: `username`, `createdAt`, `email`)*, `sortDir`. Trả `PageResponse<UserResponse>`. |
| `GET /api/v1/users/myInfo` | Authenticated | Trả thông tin tài khoản hiện tại. |
| `POST /api/v1/users/change-password` | Authenticated | `PasswordChangeRequest`: `oldPassword`, `newPassword` (`8..72`). Thu hồi token cũ qua `credentialsUpdatedAt`. |
| `GET /api/v1/users/{userId}` | `ADMIN` hoặc chính user đó (`@PostAuthorize`) | Trả `UserResponse`. |
| `PUT /api/v1/users/{userId}` | `ADMIN` hoặc chính user đó | Chỉ `ADMIN` mới đổi được `roles`, `assignedZones` và reset `password` người khác. |
| `PATCH /api/v1/users/{userId}/status` | `ADMIN` | `UserStatusRequest` (`active`). Không thể tự khóa chính mình (`1013`). |
| `DELETE /api/v1/users/{userId}` | `ADMIN` | Trả `ApiResponse<String>`. Không thể tự xóa chính mình (`1014`). |

### 2.3. Vai trò & Quyền — [`RoleController`](../../src/main/java/com/example/AIoTLibTQB/controller/RoleController.java) & [`PermissionController`](../../src/main/java/com/example/AIoTLibTQB/controller/PermissionController.java)
- **Roles (`/api/v1/roles` — toàn bộ `ADMIN`)**: `POST /`, `GET /`, `PUT /{name}`, `DELETE /{name}` (chặn xóa role hệ thống `2006`).
- **Permissions (`/api/v1/permissions` — toàn bộ `ADMIN`)**: `POST /`, `GET /`, `DELETE /{name}` (chặn xóa nếu đang gắn role `2005`).

### 2.4. Phòng đọc & Nội thất 1:100 — [`RoomController`](../../src/main/java/com/example/AIoTLibTQB/controller/RoomController.java) (`/api/v1/rooms`)
| Method & Path | Quyền / Auth | Chi tiết / Body / Params |
| :--- | :--- | :--- |
| `POST /api/v1/rooms` | `ADMIN`, `LIBRARIAN` | `RoomCreationRequest` (`code`, `name`, `floor`, `capacity`, `targetComfortScore`, `boundaryPolygon`, `type`). |
| `GET /api/v1/rooms` | `ADMIN`, `LIBRARIAN`, `ZONE_MANAGER`, `MAINTENANCE`, `VIEWER`, `USER` | `page=0`, `size=10`, `floor` *(optional filter)*. Trả `PageResponse<RoomResponse>`. |
| `GET /api/v1/rooms/{id}` · `GET /code/{code}` | Như trên | Trả `RoomResponse` kèm `thresholds` hợp nhất mặc định theo `RoomType`. |
| `PUT /api/v1/rooms/{id}` | `ADMIN`, `LIBRARIAN` | Cập nhật thông tin phòng, `boundaryPolygon`, `type`. |
| `PUT /api/v1/rooms/{id}/thresholds` | `ADMIN`, `LIBRARIAN` | `RoomThresholdUpdateRequest` (`noiseAvgMax`, `noisePeakMax`, `noisePeakImmediate`, `tempMin/Max`, `humidityMin/Max`, `pm25Max`). |
| `DELETE /api/v1/rooms/{id}` | `ADMIN` | Chặn xóa nếu phòng còn thiết bị (`5006`); xóa kèm layout nội thất nếu có. |
| `GET /api/v1/rooms/{id}/furniture` | `ADMIN`, `LIBRARIAN`, `ZONE_MANAGER`, `MAINTENANCE`, `VIEWER`, `USER` | Trả `RoomFurnitureResponse` *(Controller truyền `includeSensitive = hasOperatorAuthority()` gồm `ADMIN`, `LIBRARIAN`, `ZONE_MANAGER`, `MAINTENANCE`, `MANAGE_ZONES`; do đó **`VIEWER` và `USER` vẫn nhận `includeSensitive = false`** — ẩn `IOT_NODE` và ẩn `auditHistory`/`updatedBy`)*. |
| `PUT /api/v1/rooms/{id}/furniture` | `ADMIN`, `LIBRARIAN`, `MAINTENANCE`, `MANAGE_ZONES` | `RoomFurnitureUpdateRequest` (`expectedVersion`, `items`, `changeNote`). Kiểm tra hình học trong biên phòng & SAT chồng lấn (`5008`), xung đột version (`5007`). |

### 2.5. Thiết bị IoT & Auto-Discovery — [`DeviceController`](../../src/main/java/com/example/AIoTLibTQB/controller/DeviceController.java) (`/api/v1/devices`)
| Method & Path | Quyền / Auth *(Controller & Service)* | Chi tiết / Notes |
| :--- | :--- | :--- |
| `GET /api/v1/devices/discovered` | `ADMIN`, `LIBRARIAN` | Hàng đợi Auto-Discovery (10 phút): `hardwareId`, `firstSeenAt`, `lastSeenAt`, `messageCount`, `lastWifiRssi`. |
| `POST /api/v1/devices` · `/register` | `ADMIN`, `LIBRARIAN` | Trả `DeviceRegistrationResponse` kèm `rawApiKey` **chỉ 1 lần** (`alreadyExisted` nếu đã có). |
| `PUT /api/v1/devices/{id}` | `ADMIN`, `LIBRARIAN` | Cập nhật thông tin phòng/zone/tọa độ `posX`, `posY`. |
| `POST /api/v1/devices/{id}/regenerate-key` | `ADMIN`, `LIBRARIAN` | Cấp lại `rawApiKey` mới (thu hồi hash cũ). |
| `PATCH /api/v1/devices/{id}/status` | `ADMIN`, `LIBRARIAN` | Query `?active=true|false`. |
| `DELETE /api/v1/devices/{id}` | `ADMIN` | Xóa thiết bị. |
| `GET /api/v1/devices` | `ADMIN`, `LIBRARIAN`, `ZONE_MANAGER`, `MAINTENANCE`, `VIEWER`, `USER` | `page`, `size`, optional `zoneId`, `roomId`. `ZONE_MANAGER` bị lọc theo `assignedZones` (`4031 ZONE_ACCESS_DENIED` nếu lọc `zoneId` ngoài quyền). |
| `GET /api/v1/devices/{id}` | `ADMIN`, `LIBRARIAN`, `ZONE_MANAGER`, `MAINTENANCE` | Chi tiết trạm đo (`ZONE_MANAGER` bị chặn `4031 ZONE_ACCESS_DENIED` ngoài `assignedZones`). |
| `GET /api/v1/devices/zone/{zoneId}` | `ADMIN`, `LIBRARIAN`, `ZONE_MANAGER` | Danh sách thiết bị theo zone (`ZONE_MANAGER` bị chặn `4031 ZONE_ACCESS_DENIED` ngoài `assignedZones`). |
| `POST /api/v1/devices/authenticate` | Public *(Rate limit 10/phút)* | `DeviceAuthRequest` (`hardwareId`, `apiKey`) → trả Device JWT `8h`. |
| `POST /api/v1/devices/{id}/heartbeat` | `ADMIN`, `DEVICE` | Cập nhật `lastSeenAt` thủ công qua HTTP. |

### 2.6. Cảnh báo & Workflow — [`AlertController`](../../src/main/java/com/example/AIoTLibTQB/controller/AlertController.java) (`/api/v1/alerts`)
| Method & Path | Quyền / Auth | Chi tiết / Notes |
| :--- | :--- | :--- |
| `GET /api/v1/alerts` | `VIEW_ALERTS` *(lọc ABAC theo `assignedZones` trừ `ADMIN`)* | `roomId`, `type`, `status`, `page=0`, `size=10`, `sortBy` *(whitelist: `startedAt`, `severity`→`severityRank`, `status`, `type`, `currentValue`)*, `direction`. |
| `GET /api/v1/alerts/unread-count` | `VIEW_ALERTS` | Số lượng cảnh báo `FIRING` (đã lọc theo `assignedZones` trừ `ADMIN`). |
| `POST` / `PATCH /api/v1/alerts/{id}/acknowledge` | `ACKNOWLEDGE_ALERT` *(+ check `assertAlertZoneAccess`)* | Chuyển `FIRING → ACKNOWLEDGED`. |
| `POST` / `PATCH /api/v1/alerts/{id}/resolve` | `MANAGE_ALERT_CONFIG` *(+ check `assertAlertZoneAccess`)* | Optional `?snoozeMinutes` (`0..240`, mặc định `15`); đóng cảnh báo & kích hoạt email `RESOLVED`. |
| `PATCH /api/v1/alerts/{id}/workflow` | `ACKNOWLEDGE_ALERT` hoặc `MANAGE_ALERT_CONFIG` | `AlertWorkflowUpdateRequest` (`workflowStatus`: `NEW/ACKNOWLEDGED/IN_PROGRESS/RESOLVED`, `assignedTo`, `handlingNote`, `snoozeMinutes`). |

### 2.7. Chuỗi thời gian & Tổng hợp — [`TelemetryController`](../../src/main/java/com/example/AIoTLibTQB/controller/TelemetryController.java) (`/api/v1/telemetry`)
- Toàn bộ yêu cầu `ADMIN`, `LIBRARIAN`, `ZONE_MANAGER`, `MAINTENANCE`, `USER`, `VIEWER` *(riêng `ZONE_MANAGER` bị chặn `4031 ZONE_ACCESS_DENIED` qua `checkDeviceAccess` / `checkRoomAccess` nếu thiết bị/phòng ngoài `assignedZones`; `ADMIN`/`LIBRARIAN` có toàn quyền)*:
  - `GET /api/v1/telemetry/device/{deviceId}/latest` & `GET /api/v1/telemetry/room/{roomId}/latest`
  - `GET /api/v1/telemetry/device/{deviceId}` & `GET /api/v1/telemetry/room/{roomId}` (`start`, `end` chuẩn ISO-8601 UTC; mặc định 1 giờ gần nhất nếu bỏ trống)
  - `GET /api/v1/telemetry/room/{roomId}/buckets` (`interval`: `15m` | `1h` | `1d`, mặc định `1h`; **bắt buộc** truyền cả `start` và `end` với `start < end`, lỗi `7001 INVALID_TIME_RANGE` nếu thiếu/sai; tối đa `1000` buckets — lỗi `7002`)
  - `GET /api/v1/telemetry/overview/summary` → `TelemetrySummaryResponse` (`totalRooms`, `optimalRoomsCount`, `averageComfortScore`, `overallGrade`, `bestRoom`, `attentionRoom`, `worstRoom`).

### 2.8. Cổng Công Khai Kiosk & Actuator — [`PublicController`](../../src/main/java/com/example/AIoTLibTQB/controller/PublicController.java) (`/api/v1/public`, `/actuator`)
- Public GET *(Rate limit `60 req/phút/IP`)*:
  - `GET /api/v1/public/rooms?floor=` → `List<PublicRoomStatusResponse>`
  - `GET /api/v1/public/rooms/{id}/latest` → `PublicRoomStatusResponse`
  - `GET /api/v1/public/rooms/{id}/furniture` → `RoomFurnitureResponse` *(`PublicController` truy vấn trực tiếp `roomFurnitureLayoutRepository`, lọc bỏ item `IOT_NODE`, đặt `auditHistory = []` và không gán `updatedBy`)*
- Actuator công khai: `GET /actuator/health`, `GET /actuator/info` (`metrics` được expose nhưng yêu cầu xác thực).

---

## 3. Giao Tiếp WebSocket STOMP (`/ws-aiot`) / Realtime STOMP Topics

Endpoint hỗ trợ cả SockJS và Raw WebSocket tại **`/ws-aiot`**, kiểm tra CORS từ `cors.allowed-origins` ([`WebSocketConfig`](../../src/main/java/com/example/AIoTLibTQB/configuration/WebSocketConfig.java)) và xác thực frame qua [`StompChannelInterceptor`](../../src/main/java/com/example/AIoTLibTQB/configuration/StompChannelInterceptor.java) *(mọi frame `SEND` từ client lên `/topic/*` đều bị từ chối)*:

| Topic Destination | Điều kiện `CONNECT` / `SUBSCRIBE` | Payload & Tần suất phát |
| :--- | :--- | :--- |
| `/topic/rooms/{roomId}/telemetry` | User JWT hợp lệ (cấm `DEVICE` role) | `TelemetryResponse` — nhịp conflation **`500ms` (`2Hz`)** |
| `/topic/public/rooms/{roomId}/telemetry` | Cho phép kết nối ẩn danh với header `X-Public-Kiosk: true` | `PublicRoomStatusResponse` (ẩn dữ liệu phần cứng) — nhịp **`500ms` (`2Hz`)** |
| `/topic/alerts` | Yêu cầu quyền `VIEW_ALERTS` hoặc `ADMIN` | `AlertResponse` — tức thời theo sự kiện FSM / workflow |
| `/topic/zones/{zoneId}/alerts` | Yêu cầu quyền `VIEW_ALERTS` hoặc `ADMIN` (`^/topic/zones/[^/]+/alerts$`); Publisher phát đồng thời khi alert có `zoneId` | `AlertResponse` — phục vụ tách kênh theo phân khu |

---

## 4. Từ Điển Toàn Bộ 48 Mã Lỗi / Complete 48-Entry Error Dictionary ([`ErrorCode.java`](../../src/main/java/com/example/AIoTLibTQB/enums/ErrorCode.java))

| Code | Enum Name | HTTP | Code | Enum Name | HTTP |
| :---: | :--- | :---: | :---: | :--- | :---: |
| `1001` | `USER_EXISTED` | 400 | `3001` | `DEVICE_NOT_EXISTED` | 404 |
| `1002` | `USERNAME_INVALID` | 400 | `3002` | `DEVICE_INACTIVE` | 403 |
| `1003` | `PASSWORD_INVALID` | 400 | `3003` | `INVALID_API_KEY` | 401 |
| `1004` | `INVALID_MESSAGE_KEY` | 400 | `3004` | `DEVICE_NAME_REQUIRED` | 400 |
| `1005` | `USER_DID_NOT_EXIST` | 404 | `3005` | `HARDWARE_ID_REQUIRED` | 400 |
| `1006` | `UNAUTHENTICATED` | 401 | `3006` | `ZONE_ID_REQUIRED` | 400 |
| `1007` | `UNAUTHORIZED` | 403 | `3007` | `DEVICE_TYPE_REQUIRED` | 400 |
| `1008` | `USER_INACTIVE` | 403 | `3008` | `API_KEY_REQUIRED` | 400 |
| `1009` | `USERNAME_REQUIRED` | 400 | `4029` | `TOO_MANY_REQUESTS` | 429 |
| `1010` | `PASSWORD_REQUIRED` | 400 | `4031` | `ZONE_ACCESS_DENIED` | 403 |
| `1011` | `OLD_PASSWORD_INCORRECT` | 400 | `5001` | `ROOM_EXISTED` | 400 |
| `1012` | `PASSWORD_SAME_AS_OLD` | 400 | `5002` | `ROOM_NOT_EXISTED` | 404 |
| `1013` | `CANNOT_DEACTIVATE_SELF` | 400 | `5003` | `ROOM_CODE_REQUIRED` | 400 |
| `1014` | `CANNOT_DELETE_SELF` | 400 | `5004` | `ROOM_NAME_REQUIRED` | 400 |
| `1015` | `TOKEN_REQUIRED` | 400 | `5005` | `FLOOR_REQUIRED` | 400 |
| `2001` | `ROLE_EXISTED` | 400 | `5006` | `ROOM_HAS_DEVICES` | 400 |
| `2002` | `ROLE_NOT_EXISTED` | 404 | `5007` | `FURNITURE_VERSION_CONFLICT` | 409 |
| `2003` | `PERMISSION_EXISTED` | 400 | `5008` | `FURNITURE_OUT_OF_BOUNDS` | 400 |
| `2004` | `PERMISSION_NOT_EXISTED` | 404 | `6001` | `ALERT_NOT_EXISTED` | 404 |
| `2005` | `PERMISSION_IN_USE` | 400 | `7001` | `INVALID_TIME_RANGE` | 400 |
| `2006` | `CANNOT_DELETE_SYSTEM_ROLE` | 400 | `7002` | `TOO_MANY_BUCKETS` | 400 |
| `2007` | `ROLE_NAME_REQUIRED` | 400 | `7003` | `INVALID_INTERVAL` | 400 |
| `2008` | `PERMISSION_NAME_REQUIRED` | 400 | `9001` | `INVALID_REQUEST_PAYLOAD` | 400 |
| `9999` | `UNCATEGORIZED_EXCEPTION` | 500 | `9002` | `INVALID_PARAMETER` | 400 |
