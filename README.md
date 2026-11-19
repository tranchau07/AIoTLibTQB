# AIoTLibTQB — Hệ thống Giám sát Vi khí hậu & Âm học Thông minh | Smart Library Microclimate & Acoustic Monitoring

> **Bản quyền mã nguồn / Repository Truth:** Toàn bộ bộ tài liệu này được đối chiếu và trích xuất trực tiếp từ mã nguồn thực tế (`Java 21 / Spring Boot 3.5.8`, `Next.js 15 / React 19`, `Docker Compose`, `tools/iot-simulator`) — *Zero Hallucination*.

---

## 1. Tổng Quan Dự Án / Project Overview

**[VI]** **AIoTLibTQB** là hệ thống IoT thời gian thực giúp Ban quản lý, Thủ thư và Đội kỹ thuật tại **Thư viện Tạ Quang Bửu (Đại học Bách khoa Hà Nội)** giám sát liên tục chất lượng môi trường bên trong 5 tầng thư viện — bao gồm độ ồn (`LAeq`, dBA), nhiệt độ (`°C`), độ ẩm (`%RH`), bụi mịn (`PM1.0 / PM2.5 / PM4.0 / PM10`) và ánh sáng (`Lux`). Hệ thống quy đổi các chỉ số vật lý thành **Điểm Tiện nghi Thư viện (LCS — thang 0–100)** theo nguyên lý thùng gỗ Liebig, trực quan hóa qua **Bản đồ nhiệt 2D chuẩn AutoCAD 1:100** và tự động phát cảnh báo đa kênh (WebSocket STOMP & Email SMTP) kèm quy trình xử lý sự cố 4 bước để bảo vệ sức khỏe bạn đọc, chất lượng học tập và công tác bảo quản tài liệu lưu trữ.

**[EN]** **AIoTLibTQB** is a real-time IoT monitoring platform built for the **Ta Quang Buu Library (Hanoi University of Science and Technology)**. It continuously tracks indoor acoustics (`LAeq`, dBA), thermal comfort (`°C`, `%RH`), particulate matter (`PM1.0 / PM2.5 / PM4.0 / PM10`), and illuminance (`Lux`) across 5 library floors. Sensor readings are converted into a 0–100 **Library Comfort Score (LCS)** using a Liebig bottleneck model, visualized on a **1:100 AutoCAD 2D Spatial Heatmap**, and routed through a real-time **Alert Engine** (WebSocket STOMP & SMTP escalation) with a 4-stage incident workflow to support library managers, technicians, and students.

---

## 2. Điều Hướng Theo Vai Trò / Role-Based Documentation Map

| Đối tượng đọc / Audience | Tài liệu cần đọc theo thứ tự / Recommended Reading Path | Mục tiêu / Goal |
| :--- | :--- | :--- |
| **Non-tech: PM, BA, Quản lý thư viện, Stakeholder**<br>*(Library Managers & Stakeholders)* | 1. [Tổng quan Nghiệp vụ / Business Overview](./docs/01-overview/business-overview.md)<br>2. [Luồng Hoạt động Hệ thống / System Flows](./docs/01-overview/system-flows.md)<br>3. [Từ điển Thuật ngữ / Glossary](./docs/01-overview/glossary.md) | Nắm bài toán, vai trò người dùng, chuẩn vi khí hậu & quy trình xử lý cảnh báo không cần biết code. |
| **Kỹ sư Backend / Frontend / Full-stack**<br>*(Software Engineers)* | 1. [Kiến trúc Tổng thể / System Architecture](./docs/02-architecture/system-architecture.md)<br>2. [Kiến trúc Backend](./docs/02-architecture/backend-architecture.md) · [Kiến trúc Frontend & Bản đồ 2D](./docs/02-architecture/frontend-architecture.md)<br>3. [Mô hình Dữ liệu](./docs/03-technical-specs/data-model.md) · [REST API & STOMP](./docs/03-technical-specs/api-and-realtime-spec.md) · [Bảo mật & RBAC](./docs/03-technical-specs/security-and-rbac.md)<br>4. [Cài đặt Local](./docs/04-development/local-setup.md) · [Quy chuẩn Code](./docs/04-development/coding-conventions.md) · [Kiểm thử](./docs/04-development/testing-guide.md) | Hiểu kiến trúc pipeline, schema MongoDB, hợp đồng API/STOMP, quy tắc bất biến và cách dev/test. |
| **Kỹ sư Phần cứng IoT / Embedded**<br>*(Firmware & Hardware Engineers)* | 1. [Giao thức Phần cứng ESP32-S3 & MQTT](./docs/03-technical-specs/iot-hardware-protocol.md)<br>2. [Hướng dẫn Bộ giả lập IoT](./docs/04-development/iot-simulator-guide.md) | Cấu hình MQTT ACL, LWT, anti-spoofing, dải đo hợp lệ & kịch bản kiểm thử mô phỏng. |
| **DevOps / Kỹ thuật Vận hành**<br>*(Operations & DevOps)* | 1. [Triển khai Hạ tầng & Cloudflare Tunnel](./docs/05-operations/deployment.md)<br>2. [Quy trình Xử lý Sự cố & Runbook](./docs/05-operations/runbook-and-troubleshooting.md)<br>3. [Quyết định Kiến trúc & Nợ Kỹ thuật](./docs/02-architecture/decisions-and-tradeoffs.md) | Vận hành Docker Compose 6 service, giám sát Actuator, xử lý sự cố và rà soát rủi ro. |

---

## 3. Công Nghệ Cốt Lõi / Verified Tech Stack

| Lớp / Layer | Công nghệ & Phiên bản thực tế / Stack & Version | Tệp nguồn đối chiếu / Source Reference |
| :--- | :--- | :--- |
| **Backend Core** | Java `21` (Virtual Threads), Spring Boot `3.5.8`, Maven (`./mvnw`) | [`pom.xml`](./pom.xml) |
| **Database** | MongoDB `8.0` (`spring-boot-starter-data-mongodb`, `@TimeSeries` 90d TTL + 8 document collections) | [`docker-compose.yml`](./docker-compose.yml), [`TelemetryRecord.java`](./src/main/java/com/example/AIoTLibTQB/document/TelemetryRecord.java) |
| **IoT Broker** | Eclipse Mosquitto `2.0`, `spring-integration-mqtt`, Paho Client `1.2.5` (QoS 1, Per-device ACL `%u`) | [`mosquitto.conf`](./mosquitto/config/mosquitto.conf), [`acl.conf`](./mosquitto/config/acl.conf) |
| **Realtime & Email** | Spring WebSocket STOMP (`/ws-aiot`), `@stomp/stompjs ^7.0.0`, `spring-boot-starter-mail` (JavaMailSender) | [`WebSocketConfig.java`](./src/main/java/com/example/AIoTLibTQB/configuration/WebSocketConfig.java), [`AlertEmailNotificationService.java`](./src/main/java/com/example/AIoTLibTQB/service/AlertEmailNotificationService.java) |
| **Security & Auth** | Nimbus JOSE JWT `10.0.2` (HS512), Spring OAuth2 Resource Server, Bucket4j `8.10.1` + Caffeine, BCrypt(10) | [`SecurityConfig.java`](./src/main/java/com/example/AIoTLibTQB/configuration/SecurityConfig.java), [`RateLimitFilter.java`](./src/main/java/com/example/AIoTLibTQB/configuration/RateLimitFilter.java) |
| **Frontend Core** | Next.js `^15.5.28` (`output: 'standalone'`), React `^19.0.0`, TypeScript `^5.6.3`, Tailwind CSS `^3.4.14` | [`frontend/package.json`](./frontend/package.json), [`frontend/next.config.ts`](./frontend/next.config.ts) |
| **Frontend State & Viz** | `@tanstack/react-query ^5.59.0`, Zustand `^5.0.1`, Zod `^3.23.8`, HTML5 Canvas 2D HiDPI + AutoCAD SVG | [`FloorplanCanvas.tsx`](./frontend/src/features/floorplan/components/FloorplanCanvas.tsx) |
| **Testing & A11y** | JUnit 5 / Mockito (`32` test classes, `281` tests); Vitest `^2.1.4`, Testing Library `^16.0.1`, `axe-core ^4.14.1` (`13` files, `146` tests) | [`src/test/`](./src/test), [`frontend/src/lib/__tests__/`](./frontend/src/lib/__tests__) |
| **Simulator & Tunnel** | Node.js `20-alpine` (`mqtt ^5.10.3`, `dotenv ^16.4.7`), Unified Gateway (`:4000`) + `cloudflared` | [`tools/iot-simulator/package.json`](./tools/iot-simulator/package.json), [`gateway.js`](./tools/cloudflared/gateway.js) |

---

## 4. Khởi Chạy Nhanh / Quick Start

> **[VI]** Yêu cầu Docker Engine `24+` & Docker Compose `v2.20+` (chi tiết chạy dev native không Docker xem [Local Setup](./docs/04-development/local-setup.md)).  
> **[EN]** Requires Docker Engine `24+` & Docker Compose `v2.20+` (for native non-Docker dev setup, see [Local Setup](./docs/04-development/local-setup.md)).

```bash
# 1. Sao chép cấu hình môi trường & thay các giá trị bí mật (đặc biệt JWT_SECRET >= 64 ký tự)
#    Copy env template & replace placeholders (JWT_SECRET MUST be >= 64 chars for HS512)
cp .env.example .env

# 2. Khởi chạy toàn bộ 5 dịch vụ cốt lõi (mongodb, mosquitto, backend, frontend, simulator)
#    Start all 5 core services (add --profile dev to also launch mongo-express on :8081)
docker compose up -d --build

# 3. Kiểm tra sức khỏe dịch vụ / Verify health checks
docker compose ps
curl http://localhost:8080/actuator/health
```

- **Web Portal & Bản đồ nhiệt / Heatmap UI**: `http://localhost:3000` (tài khoản khởi tạo / seeded user: `admin` với mật khẩu `INITIAL_ADMIN_PASSWORD` trong `.env`)
- **Màn hình Kiosk công khai / Public Kiosk**: `http://localhost:3000/kiosk`
- **Backend REST API & Actuator**: `http://localhost:8080/api/v1` · `http://localhost:8080/actuator/health`
- **Mongo Express (`--profile dev`)**: `http://127.0.0.1:8081`

---

## 5. Cấu Trúc Thư Mục Tài Liệu / Documentation Tree

```text
├── README.md
└── docs/
    ├── 01-overview/
    │   ├── business-overview.md
    │   ├── system-flows.md
    │   └── glossary.md
    ├── 02-architecture/
    │   ├── system-architecture.md
    │   ├── backend-architecture.md
    │   ├── frontend-architecture.md
    │   └── decisions-and-tradeoffs.md
    ├── 03-technical-specs/
    │   ├── data-model.md
    │   ├── api-and-realtime-spec.md
    │   ├── security-and-rbac.md
    │   └── iot-hardware-protocol.md
    ├── 04-development/
    │   ├── local-setup.md
    │   ├── iot-simulator-guide.md
    │   ├── coding-conventions.md
    │   └── testing-guide.md
    └── 05-operations/
        ├── deployment.md
        └── runbook-and-troubleshooting.md
```
