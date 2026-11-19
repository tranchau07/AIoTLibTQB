# Cài Đặt Môi Trường Phát Triển Local & Biến Môi Trường / Local Setup & Environment Variables

> **Cơ sở kiểm chứng / Verified From:** [`.env.example`](../../.env.example), [`application.yaml`](../../src/main/resources/application.yaml), [`application.yaml.example`](../../src/main/resources/application.yaml.example), [`RateLimitFilter.java`](../../src/main/java/com/example/AIoTLibTQB/configuration/RateLimitFilter.java), [`TelemetryConflationService.java`](../../src/main/java/com/example/AIoTLibTQB/service/TelemetryConflationService.java), [`AlertEmailNotificationService.java`](../../src/main/java/com/example/AIoTLibTQB/service/AlertEmailNotificationService.java), [`frontend/src/config/env.ts`](../../frontend/src/config/env.ts).

---

## 1. Yêu Cầu Công Cụ / Prerequisites

| Công cụ / Tool | Phiên bản thực tế / Version | Lệnh kiểm tra / Verify Command |
| :--- | :--- | :--- |
| **Docker Engine & Compose** | Docker `24+`, Compose `v2.20+` | `docker --version && docker compose version` |
| **Java JDK** | **Java 21 LTS** *(chạy Backend ngoài Docker)* | `java -version` |
| **Maven Wrapper** | Dùng sẵn `./mvnw` (`.\mvnw.cmd` trên Windows) | `./mvnw -v` |
| **Node.js & npm** | Node.js `20+` (`20-alpine` trong Docker; test tốt trên `v20/v24`) | `node -v && npm -v` |

---

## 2. Danh Mục Toàn Bộ Biến Môi Trường / Complete Environment Variables Reference

> **[VI] Cảnh báo bảo mật & Đồng bộ cấu hình:** Không commit `.env` chứa secret thật lên Git. Ngoài các biến có sẵn trong `.env.example`, mã nguồn Backend còn đọc thêm nhóm biến Email cảnh báo (`ALERT_EMAIL_*`), Conflation (`app.telemetry.conflation-ms`) và Proxy tin cậy (`security.rate-limit.trusted-proxies`).  
> **[EN] Secrets & Config Sync Warning:** Never commit real secrets. Beyond `.env.example`, Backend code consumes additional properties for alert emails (`ALERT_EMAIL_*`), STOMP conflation rate, and trusted reverse proxies.

| Biến / Property | Giá trị mặc định trong code / Default | Mô tả / Description | Nguồn code / Source |
| :--- | :--- | :--- | :--- |
| `MONGO_ROOT_USERNAME`, `MONGO_ROOT_PASSWORD`, `MONGO_DATABASE` | `root` / `***` / `aiot_identity_db` | Tài khoản & DB MongoDB `8.0` trong Docker Compose. | [`.env.example`](../../.env.example) |
| `MONGO_URI` | `mongodb://localhost:27017/aiot_identity_db` | Chuỗi kết nối MongoDB cho Backend (`docker-compose.yml` tiêm trực tiếp `MONGO_URI`). | [`application.yaml`](../../src/main/resources/application.yaml) |
| `JWT_SECRET` | **Bắt buộc (`>= 64` ký tự)** | Khóa ký HMAC-SHA512. | [`application.yaml`](../../src/main/resources/application.yaml) |
| `JWT_EXPIRATION_HOURS` | `1` | Thời hạn Access Token (giờ). | [`AuthenticationService`](../../src/main/java/com/example/AIoTLibTQB/service/AuthenticationService.java) |
| `JWT_REFRESHABLE_HOURS` | `24` | Thời hạn Refresh Token (giờ). | [`AuthenticationService`](../../src/main/java/com/example/AIoTLibTQB/service/AuthenticationService.java) |
| `JWT_ISSUER` | `AIoTLibTQB.com` | Claim `iss` trong JWT. | [`application.yaml`](../../src/main/resources/application.yaml) |
| `INITIAL_ADMIN_PASSWORD` | Bắt buộc ở `prod`; non-prod sinh ngẫu nhiên nếu trống | Mật khẩu tài khoản `admin` khởi tạo lần đầu. | [`ApplicationInitConfig`](../../src/main/java/com/example/AIoTLibTQB/configuration/ApplicationInitConfig.java) |
| `CORS_ALLOWED_ORIGINS` | `http://localhost:3000` | Danh sách Origin phân cách dấu phẩy cho CORS & STOMP. | [`SecurityConfig`](../../src/main/java/com/example/AIoTLibTQB/configuration/SecurityConfig.java), [`WebSocketConfig`](../../src/main/java/com/example/AIoTLibTQB/configuration/WebSocketConfig.java) |
| `MQTT_BROKER_URL`, `MQTT_CLIENT_ID`, `MQTT_USERNAME`, `MQTT_PASSWORD` | `tcp://localhost:1883`, `aiot_backend_consumer`, `aiot_backend` | Kết nối Mosquitto Broker. | [`MqttProperties`](../../src/main/java/com/example/AIoTLibTQB/configuration/MqttProperties.java) |
| `MQTT_TELEMETRY_TOPIC`, `MQTT_STATUS_TOPIC` | `devices/+/telemetry`, `devices/+/status` | Wildcard MQTT topic đăng ký. | [`application.yaml`](../../src/main/resources/application.yaml) |
| `ALERT_EMAIL_ENABLED` | `false` | Bật/tắt gửi Email SMTP cho `CRITICAL` & leo thang `HIGH` *(chưa có trong `.env.example`)*. | [`AlertEmailNotificationService`](../../src/main/java/com/example/AIoTLibTQB/service/AlertEmailNotificationService.java) |
| `ALERT_EMAIL_FROM`, `ALERT_EMAIL_COOLDOWN_MINUTES`, `ALERT_EMAIL_HIGH_ESCALATION_MINUTES` | `noreply@aiotlibtqb.edu.vn` / `30` / `10` | Địa chỉ gửi, thời gian cooldown phòng (phút) và ngưỡng leo thang `HIGH`. | [`application.yaml`](../../src/main/resources/application.yaml) |
| `app.telemetry.conflation-ms` | `500` | Nhịp gộp STOMP WebSocket (`500ms = 2Hz`) *(chưa có trong `application.yaml.example`)*. | [`TelemetryConflationService`](../../src/main/java/com/example/AIoTLibTQB/service/TelemetryConflationService.java) |
| `security.rate-limit.trusted-proxies` | *(empty — chỉ tin loopback mặc định)* | Danh sách IP Reverse Proxy được tin cậy đọc header `X-Forwarded-For`. | [`RateLimitFilter`](../../src/main/java/com/example/AIoTLibTQB/configuration/RateLimitFilter.java) |
| `NEXT_PUBLIC_API_BASE_URL` | `http://localhost:8080/api/v1` | Endpoint REST cho Frontend; nếu để trống, trình duyệt tự nối `${window.location.origin}/api/v1`, còn SSR fallback về `http://localhost:8080/api/v1`. | [`frontend/src/config/env.ts`](../../frontend/src/config/env.ts) |
| `NEXT_PUBLIC_WS_URL` | `ws://localhost:8080/ws-aiot` | Endpoint STOMP; nếu để trống, trình duyệt tự nối `${ws\|wss}://${window.location.host}/ws-aiot`, còn SSR fallback về `ws://localhost:8080/ws-aiot`. | [`frontend/src/config/env.ts`](../../frontend/src/config/env.ts) |
| `SIM_INTERVAL_MS` | `500` (`docker-compose`) / `5000` (`.env.example`) | Chu kỳ phát Simulator *(lưu ý đồng bộ biến này về `500` khi chạy Docker).* | [`docker-compose.yml`](../../docker-compose.yml) |

---

## 3. Hai Cách Chạy Local / Two Ways to Run Locally

### Cách A — Docker Compose Trọn Gói / Full Stack via Docker Compose
```bash
cp .env.example .env
# Chỉnh sửa JWT_SECRET (>= 64 ký tự) & các mật khẩu trong .env
docker compose up -d --build
# Hoặc bật kèm Mongo Express (cổng 8081):
# docker compose --profile dev up -d --build
```

### Cách B — Chạy Dev Native (Hot-Reload Backend & Frontend) / Native Hybrid Dev
```bash
# Bước 1: Bật MongoDB và Mosquitto bằng Docker
docker compose up -d mongodb mosquitto

# Bước 2: Chạy Backend Spring Boot (Java 21) — nhớ export JWT_SECRET & MONGO_URI nếu cần
./mvnw spring-boot:run

# Bước 3: Chạy Frontend Next.js 15 (terminal thứ 2)
cd frontend
npm install
npm run dev   # http://localhost:3000

# Bước 4 (Tùy chọn): Bơm dữ liệu mẫu + mô phỏng IoT (terminal thứ 3)
cd tools/iot-simulator
npm install && cp .env.example .env
node src/index.js --provision --scenario demo --speed 5
```
