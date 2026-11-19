# Bảo Mật, Xác Thực JWT & Ma Trận RBAC / Security, Auth & RBAC Specification

> **Cơ sở kiểm chứng / Verified From:** [`SecurityConfig`](../../src/main/java/com/example/AIoTLibTQB/configuration/SecurityConfig.java), [`CustomJwtDecoder`](../../src/main/java/com/example/AIoTLibTQB/configuration/CustomJwtDecoder.java), [`RateLimitFilter`](../../src/main/java/com/example/AIoTLibTQB/configuration/RateLimitFilter.java), [`ApplicationInitConfig`](../../src/main/java/com/example/AIoTLibTQB/configuration/ApplicationInitConfig.java), [`AuthenticationService`](../../src/main/java/com/example/AIoTLibTQB/service/AuthenticationService.java), [`AlertServiceImpl`](../../src/main/java/com/example/AIoTLibTQB/service/AlertServiceImpl.java), [`StompChannelInterceptor`](../../src/main/java/com/example/AIoTLibTQB/configuration/StompChannelInterceptor.java), [`mosquitto/config/acl.conf`](../../mosquitto/config/acl.conf).

---

## 1. Kiến Trúc An Ninh 3 Mặt Phẳng / 3-Plane Security Architecture

1. **Mặt phẳng API Biên & HTTP ([`SecurityConfig`](../../src/main/java/com/example/AIoTLibTQB/configuration/SecurityConfig.java) & [`RateLimitFilter`](../../src/main/java/com/example/AIoTLibTQB/configuration/RateLimitFilter.java))**:
   - Stateless JWT Resource Server, CORS khóa chặt theo `${cors.allowed-origins}` (`allowCredentials = true`, header `Authorization`, `Content-Type`).
   - Giới hạn tần suất Bucket4j + Caffeine (`maximumSize = 10,000`, hết hạn sau `10 phút` không hoạt động):
     - **`10 req/phút/IP`**: `POST /api/v1/auth/login`, `/refresh`, `/introspect`, `POST /api/v1/devices/authenticate`, `POST /api/v1/users`.
     - **`60 req/phút/IP`**: Toàn bộ `/api/v1/public/**`.
     - Khi vượt giới hạn trả HTTP `429` (mã `4029 TOO_MANY_REQUESTS`) kèm header `Retry-After`. Header `X-Forwarded-For` chỉ được tin cậy khi `remoteAddr` là loopback hoặc nằm trong `${security.rate-limit.trusted-proxies}` *(chống giả mạo IP)*.
   - **Tuyến đường công khai**: `OPTIONS /**`, `/actuator/health`, `/actuator/info`, 6 `POST` public endpoints trên, `GET /api/v1/public/**`, và `/ws-aiot/**` *(kiểm soát tiếp ở STOMP interceptor)*.

2. **Mặt phẳng Danh tính & Phiên JWT (`HS512` & Refresh Token Rotation)**:
   - Thuật toán ký: `HMAC-SHA512` (yêu cầu `${JWT_SECRET}` tối thiểu **64 ký tự**).
   - **Ba loại token (`tokenType` claim)**:
     - `ACCESS`: thời hạn `${JWT_EXPIRATION_HOURS:1}` giờ (`scope` chứa tên role + tên permission cách nhau dấu cách).
     - `REFRESH`: thời hạn `${JWT_REFRESHABLE_HOURS:24}` giờ (chặn dùng `REFRESH` để gọi API qua `CustomJwtDecoder`).
     - `DEVICE`: thời hạn cố định **`8` giờ** (`scope = "DEVICE WRITE_SENSOR_DATA"`, kèm claims `deviceId`, `zoneId`, `deviceType`).
   - **Thu hồi & Đổi mật khẩu**:
     - `POST /api/v1/auth/refresh` đưa `jti` của refresh token cũ vào `invalidated_tokens` (TTL index `expireAfter="0s"` + dọn định kỳ `02:00` sáng).
     - Khi user đổi mật khẩu (`changePassword`) hoặc `ADMIN` cập nhật mật khẩu user, `credentialsUpdatedAt` được cập nhật — `CustomJwtDecoder` & `AuthenticationService` tự động từ chối mọi Access/Refresh token phát hành trước mốc này.
   - Mật khẩu user và `apiKeyHash` của thiết bị băm bằng `BCryptPasswordEncoder(10)`.

3. **Mặt phẳng IoT & WebSocket STOMP**:
   - **Mosquitto Broker ACL ([`acl.conf`](../../mosquitto/config/acl.conf))**: `allow_anonymous false`. Tài khoản thiết bị đăng nhập với `username = hardwareId` bị khóa bởi `pattern write devices/%u/telemetry`, `pattern write devices/%u/status`, `pattern read devices/%u/command`.
   - **STOMP (`StompChannelInterceptor`)**: `CONNECT` đòi JWT hợp lệ trừ khi client gửi `X-Public-Kiosk: true` *(khi đó chỉ được subscribe `/topic/public/rooms/*`)*. Kênh `/topic/alerts` và `/topic/zones/*/alerts` (`^/topic/zones/[^/]+/alerts$`) yêu cầu quyền `VIEW_ALERTS` hoặc `ADMIN`; role `DEVICE` bị chặn subscribe `/topic/rooms/*`.

---

## 2. Ma Trận Phân Quyền `7 Roles × 14 Permissions` / Seeded RBAC Matrix

Được đồng bộ tự động mỗi lần khởi động tại [`ApplicationInitConfig`](../../src/main/java/com/example/AIoTLibTQB/configuration/ApplicationInitConfig.java) *(hợp nhất quyền mặc định với quyền gán thêm trong DB)*:

| Permission | `ADMIN` | `LIBRARIAN` | `ZONE_MANAGER` | `MAINTENANCE` | `VIEWER` | `USER` | `DEVICE` |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| `READ_SENSOR_DATA` | ✅ | ✅ | ✅ | ✅ | ✅ | — | — |
| `READ_SENSOR_DETAIL` | ✅ | ✅ | ✅ | — | — | — | — |
| `WRITE_SENSOR_DATA` | ✅ | — | — | — | — | — | ✅ |
| `VIEW_ALERTS` | ✅ | ✅ | ✅ | ✅ | ✅ | — | — |
| `ACKNOWLEDGE_ALERT` | ✅ | ✅ | ✅ | ✅ | — | — | — |
| `MANAGE_ALERT_CONFIG` | ✅ | ✅ | — | — | — | — | — |
| `MANAGE_DEVICES` | ✅ | ✅ | — | — | — | — | — |
| `VIEW_DEVICE_STATUS` | ✅ | ✅ | ✅ | ✅ | — | — | — |
| `MANAGE_ZONES` | ✅ | — | — | — | — | — | — |
| `VIEW_ZONE_SUMMARY` | ✅ | ✅ | ✅ | ✅ | ✅ | — | — |
| `GENERATE_REPORT` | ✅ | ✅ | ✅ | — | — | — | — |
| `VIEW_ANALYTICS` | ✅ | ✅ | ✅ | ✅ | — | — | — |
| `MANAGE_USERS` | ✅ | — | — | — | — | — | — |
| `MANAGE_ROLES` | ✅ | — | — | — | — | — | — |

> **Lưu ý kiểm chứng / Code Note:** Trên thực tế, nhiều `@PreAuthorize` ở Controller/Service kiểm tra trực tiếp tên Role (như `hasAnyAuthority('ADMIN', 'LIBRARIAN')` trên `RoomController`/`DeviceService`), nên `USER` (với `0` permission mặc định) vẫn xem được bản đồ đọc cơ bản thông qua tên Role `'USER'`. Ngoài ra khi khởi động ở profile `prod` / `production`, nếu thiếu `INITIAL_ADMIN_PASSWORD`, `ApplicationInitConfig` sẽ ném `IllegalStateException` và dừng ứng dụng ngay; ở môi trường non-prod, nếu bỏ trống biến này sẽ tự sinh mật khẩu ngẫu nhiên 16 ký tự và in 1 lần ra log console.

---

## 3. Phân Quyền Theo Phân Khu (ABAC `assignedZones`) / Zone Isolation

**[VI]** Trong [`AlertServiceImpl`](../../src/main/java/com/example/AIoTLibTQB/service/AlertServiceImpl.java), **chỉ `ADMIN`** (`ADMIN` / `ROLE_ADMIN`) mới được xem và thao tác cảnh báo toàn tòa nhà không giới hạn (`fullAccess = true`). Mọi vai trò khác (`LIBRARIAN`, `ZONE_MANAGER`, `MAINTENANCE`) bị lọc danh sách (`GET /api/v1/alerts`, `/unread-count`) theo trường `User.assignedZones` và chặn bằng `ErrorCode.ZONE_ACCESS_DENIED` (`4031`, HTTP `403`) khi gọi `acknowledge` / `resolve` / `workflow` cho cảnh báo ngoài khu vực được cấp.

**[EN]** In [`AlertServiceImpl`](../../src/main/java/com/example/AIoTLibTQB/service/AlertServiceImpl.java), **only `ADMIN`** has unrestricted building-wide alert visibility (`fullAccess = true`). Non-`ADMIN` staff (`LIBRARIAN`, `ZONE_MANAGER`, `MAINTENANCE`) are filtered by `User.assignedZones` on read endpoints and rejected with `4031 ZONE_ACCESS_DENIED` (HTTP `403`) when mutating alerts outside their assigned zones.
