# Triển Khai Hạ Tầng & Chia Sẻ Public Tunnel / Deployment & Public Gateway Operations

> **Cơ sở kiểm chứng / Verified From:** [`docker-compose.yml`](../../docker-compose.yml), [`Dockerfile`](../../Dockerfile), [`frontend/Dockerfile`](../../frontend/Dockerfile), [`tools/iot-simulator/Dockerfile`](../../tools/iot-simulator/Dockerfile), [`tools/cloudflared/gateway.js`](../../tools/cloudflared/gateway.js), [`start-public-web.ps1`](../../tools/cloudflared/start-public-web.ps1) *(đã hợp nhất nội dung từ tài liệu `tools/cloudflared` cũ)*.

---

## 1. Kiến Trúc Container & Giới Hạn Tài Nguyên / Docker Compose Topology & Resource Limits

**[VI]** Hệ thống dùng Docker Compose gồm `5` dịch vụ chạy mặc định + `1` dịch vụ gỡ lỗi tùy chọn (`--profile dev` / `debug`), chuẩn hóa quay vòng log (`json-file`, `max-size: 10m`, `max-file: 3`), container non-root (`appuser`, `nextjs`, `node`) và JVM flag `-XX:+UseContainerSupport -XX:MaxRAMPercentage=75.0`.  
**[EN]** The stack runs `5` default services + `1` optional debug UI (`--profile dev` / `debug`), enforcing `json-file` log rotation (`10m × 3`), non-root container users (`appuser`, `nextjs`, `node`), and container-aware JVM memory limits (`MaxRAMPercentage=75.0`).

| Service (`container_name`) | Base Image | CPU / RAM Limit | Volumes / Persistent Data | Healthcheck |
| :--- | :--- | :---: | :--- | :--- |
| **`mongodb`** (`aiot_mongodb`) | `mongo:8.0` | `1.50 CPU` / `1024M` | `aiot_mongo_data` (`/data/db`) | `mongosh db.adminCommand('ping')` (10s) |
| **`mongo-express`** *(profile `dev/debug`)* | `mongo-express:1.0.2` | `0.50 CPU` / `256M` | — | HTTP `:8081` (15s) |
| **`mosquitto`** (`aiot_mosquitto`) | `eclipse-mosquitto:2.0` | `0.50 CPU` / `256M` | `aiot_mosquitto_data`, `aiot_mosquitto_log`, bind `mosquitto.conf` & `acl.conf` | `mosquitto_sub $SYS/broker/version` (10s) |
| **`backend`** (`aiot_backend`) | `eclipse-temurin:21-jre-alpine` | `1.50 CPU` / `1024M` | — | `wget http://localhost:8080/actuator/health` (10s) |
| **`frontend`** (`aiot_frontend`) | `node:20-alpine` (Next standalone) | `1.00 CPU` / `512M` | — | `wget http://127.0.0.1:3000` (15s) |
| **`simulator`** (`aiot_simulator`) | `node:20-alpine` | `0.50 CPU` / `256M` | — | Chờ `backend` & `mosquitto` healthy |

> **Lưu ý Mosquitto Provisioning:** Khi khởi động, entrypoint trong [`docker-compose.yml`](../../docker-compose.yml) tạo lại `/mosquitto/data/password.txt` cho `aiot_backend`, `admin`, và vòng lặp `26` mã thiết bị mẫu dùng chung `MQTT_DEVICE_PASSWORD`. Khi gắn phần cứng thực địa mới ngoài danh sách này, cần chạy `mosquitto_passwd` bổ sung user `<hardwareId>` và reload Mosquitto (`kill -HUP`).

---

## 2. Lưu Ý Quan Trọng Khi Build Frontend Cho Môi Trường Khác Localhost / Build-Time Public URLs

- Trong [`frontend/Dockerfile`](../../frontend/Dockerfile), hai biến `NEXT_PUBLIC_API_BASE_URL` và `NEXT_PUBLIC_WS_URL` được nhúng ở giai đoạn **`ARG` / `builder` (`npm run build`)**.
- Nếu triển khai qua Reverse Proxy cùng tên miền hoặc qua Unified Gateway (`:4000`), giữ mặc định `NEXT_PUBLIC_API_BASE_URL=/api/v1` (hoặc cấu hình trong `.env` trước khi chạy `docker compose up -d --build frontend`).

---

## 3. Chia Sẻ Public Web Nhanh Qua Cloudflare Tunnel / Cloudflare Quick Tunnel (`:4000`)

```text
[Remote Browser] --(HTTPS/WSS)--> [Cloudflare Edge] --> [cloudflared] --> [gateway.js :4000]
                                                                            ├── /api/*, /ws-*, /actuator/* --> Backend (:8080)
                                                                            └── /*                         --> Frontend (:3000)
```

**[VI]** [`tools/cloudflared/gateway.js`](../../tools/cloudflared/gateway.js) hợp nhất Backend (`:8080`) và Frontend (`:3000`) qua cổng duy nhất **`:4000`** (hỗ trợ cả HTTP và `upgrade` WebSocket thô TCP) để phát nhanh bản demo ra Internet mà không cần tên miền riêng hay mở port modem.  
**[EN]** [`gateway.js`](../../tools/cloudflared/gateway.js) unifies Next.js (`:3000`) and Spring Boot (`:8080`) behind port **`:4000`** (bridging HTTP and WebSocket `upgrade` sockets) for zero-domain demo exposure via `cloudflared`.

### Cách khởi chạy / Startup Commands
1. Đảm bảo Backend (`:8080`) và Frontend (`:3000`) đang lắng nghe.
2. Cài đặt `cloudflared` (`winget install Cloudflare.cloudflared` hoặc đặt `cloudflared.exe` vào `tools/cloudflared/` trên Windows; cài qua package manager trên Linux/macOS).
3. Chạy tunnel:
   - **Windows (1-Click)**: Mở `tools/cloudflared/start-public-web.bat` hoặc `.\tools\cloudflared\start-public-web.ps1`.
   - **Linux / macOS**:
     ```bash
     # Terminal 1: Unified Gateway (:4000)
     node tools/cloudflared/gateway.js

     # Terminal 2: Cloudflare Quick Tunnel
     cloudflared tunnel --url http://127.0.0.1:4000
     ```
4. Sao chép URL `https://<random>.trycloudflare.com` từ terminal; lưu ý thêm origin này vào `CORS_ALLOWED_ORIGINS` nếu Frontend cấu hình gọi trực tiếp domain backend thay vì relative path.

---

## 4. Hạng Mục Hạ Tầng Production Cần Bổ Sung / Missing Production Governance

- `[CẦN BỔ SUNG / TO BE ADDED: Kiến trúc triển khai Production chính thức (tên miền thực tế, Nginx/Traefik Reverse Proxy với chứng chỉ TLS/HTTPS cố định, bật MQTTS :8883 TLS trên Mosquitto).]`
- `[CẦN BỔ SUNG / TO BE ADDED: Lịch trình Backup / Restore định kỳ cho volume MongoDB (aiot_mongo_data), quy trình nâng cấp không gián đoạn (rolling update) và thông số SLA / RTO / RPO.]`
- `[CẦN BỔ SUNG / TO BE ADDED: Cấu hình SMTP server chính thức cho tính năng gửi Email cảnh báo (ALERT_EMAIL_ENABLED=true, spring.mail.host/port/username/password).]`
