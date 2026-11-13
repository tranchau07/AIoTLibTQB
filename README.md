# AIoTLibTQB — Hệ Thống Giám Sát Vi Khí Hậu & Âm Học Thông Minh Thư Viện Tạ Quang Bửu

Hệ thống IoT thời gian thực giám sát môi trường đọc sách, bảo tồn kho lưu trữ tài liệu quý và trực quan hóa bản đồ nhiệt không gian 2D tại Thư viện Tạ Quang Bửu (ĐH Bách khoa Hà Nội).

---

## Điểm nhấn Kiến trúc (v2.1)

- **Động cơ Điểm Tiện nghi Liebig (LCS)**: Chấm điểm phi tuyến theo 3 cấu hình không gian (`STUDY_ROOM`, `BOOK_STORAGE`, `CIRCULATION_HALL`), tự tái phân bổ trọng số khi thiếu cảm biến và áp dụng phạt nút cổ chai theo Nguyên lý Thùng gỗ Liebig ([`docs/03-lcs-algorithm.md`](docs/03-lcs-algorithm.md)).
- **Ingestion Pipeline & Alert FSM Thích ứng**: Tiếp nhận MQTT QoS 1 trên Java 21 Virtual Threads, lọc 9 chỉ số vật lý + forward-fill `30s` (loại trừ `noisePeak`), ngưỡng cảnh báo động theo từng phòng (`RoomThresholdConfig`), phát hiện xung ồn kép (`Dual-Threshold Noise Peak`), kiểm soát độ ẩm kho sách (`BOOK_STORAGE`) và danh mục SOP chuẩn ([`docs/04-ingestion-and-alerts.md`](docs/04-ingestion-and-alerts.md)).
- **Bản đồ Nhiệt Không gian 2D (CAD 1:100)**: Render Canvas 2D HiDPI trên nền 5 bản vẽ AutoCAD SVG (`76.0m × 57.2m`, 33 preset phòng), khuếch tán Gaussian RBF thích ứng diện tích (`computeAdaptiveSigma`), phóng đại 2 cấp, ẩn danh bàn đọc cho bạn đọc và lớp phủ chẩn đoán vùng mù cho kỹ thuật viên ([`docs/09-spatial-heatmap-2d.md`](docs/09-spatial-heatmap-2d.md)).
- **Cổng Kiosk Công khai & Bảo mật Đa lớp**: Kiosk sảnh tầng 1 (`/kiosk`) không cần đăng nhập qua `/api/v1/public/**` và STOMP ẩn danh (`X-Public-Kiosk: true`), đồng thời bảo vệ dữ liệu quản trị bằng Dual JWT `HS512`, 7 Roles × 14 Permissions, Bucket4j Rate Limit và Mosquitto ACL `%u` ([`docs/06-security-and-rbac.md`](docs/06-security-and-rbac.md)).

---

## Tech Stack Chính

| Thành phần | Công nghệ & Phiên bản (Kiểm chứng mã nguồn) |
| :--- | :--- |
| **Backend Core** | Spring Boot `3.5.8`, Java `21 LTS` (Virtual Threads), Spring Integration MQTT, STOMP WebSocket, MapStruct `1.5.5.Final`, Lombok `1.18.38` |
| **Bảo mật & Bộ đệm** | Nimbus JOSE+JWT `10.0.2` (`HS512`), Spring Security 6, Bucket4j `8.10.1`, Caffeine Cache |
| **Cơ sở Dữ liệu** | MongoDB `8.0` (Native TimeSeries `telemetry_records` TTL 90 ngày + 7 Document Collections) |
| **Message Broker** | Eclipse Mosquitto `2.0` (MQTT v3.1.1, QoS 1, PBKDF2 Auth, Per-device ACL `%u`) |
| **Frontend Web** | Next.js `^15.5.28` (App Router, 16 routes), React `^19.0.0`, TypeScript `^5.6.3`, Tailwind CSS `^3.4.14`, Zustand `^5.0.1`, TanStack Query `^5.59.0`, `@stomp/stompjs ^7.0.0` |
| **IoT & Hạ tầng** | ESP32-S3 (INMP441, SPS30, SHT30/31, BH1750), Node.js IoT Simulator (10 kịch bản), Docker Compose, Cloudflare Quick Tunnel |

---

## Quickstart 5 Phút (Docker Compose)

> [!IMPORTANT]
> **Yêu cầu**: Docker `24.0+` & Docker Compose `v2.20+`. Với chạy local không qua Docker cần JDK `21`, Maven `3.9+` (hoặc `./mvnw`), Node.js `20+` (`npm 10+`).

1. **Khởi tạo cấu hình môi trường** (chỉnh sửa các giá trị `CHANGE_ME_*` và `JWT_SECRET >= 64` ký tự trong `.env`):
   ```bash
   cp .env.example .env
   ```
2. **Khởi chạy toàn bộ cụm dịch vụ** (`mongodb`, `mosquitto`, `backend`, `frontend`, `simulator`):
   ```bash
   docker compose up -d --build
   # (Tùy chọn dev/debug) Bật thêm Mongo Express Web GUI trên cổng 8081:
   docker compose --profile dev up -d mongo-express
   ```
3. **Kiểm tra nhanh các cổng dịch vụ**:
   - **Web App & Kiosk**: `http://localhost:3000` (trang chủ `/` tự chuyển tới `/kiosk`; đăng nhập quản trị tại `/login`)
   - **Backend Healthcheck**: `http://localhost:8080/actuator/health` (`{"status":"UP"}`)
   - **MQTT Broker & MongoDB**: `127.0.0.1:1883` (Mosquitto), `127.0.0.1:27017` (MongoDB)

> Xem hướng dẫn chạy từng thành phần (local dev, nạp `rooms.json`, mở Cloudflare Tunnel công khai và xử lý sự cố) tại [`docs/12-runbook.md`](docs/12-runbook.md).

---

## Bản đồ Tài liệu Kỹ thuật (`docs/`)

Toàn bộ tài liệu chuẩn v2.1 được tổ chức tại [**Cổng Tài liệu Kỹ thuật (`docs/README.md`)**](docs/README.md):

| STT | Tài liệu | Nội dung chính |
| :---: | :--- | :--- |
| **01** | [Bài toán & Tiêu chuẩn (`01-domain-and-standards.md`)](docs/01-domain-and-standards.md) | Bối cảnh Thư viện TQB, tiêu chuẩn ISO 11799 / ASHRAE 55 / WHO / TCVN, 3 `RoomType` |
| **02** | [Kiến trúc Hệ thống (`02-architecture.md`)](docs/02-architecture.md) | Sơ đồ C4, Tech Stack, 6 Docker services, mạng cách ly & ADRs |
| **03** | [Thuật toán LCS (`03-lcs-algorithm.md`)](docs/03-lcs-algorithm.md) | Công thức chấm điểm thành phần, tái phân bổ trọng số động & phạt Liebig |
| **04** | [Ingestion & Alert FSM (`04-ingestion-and-alerts.md`)](docs/04-ingestion-and-alerts.md) | Pipeline MQTT 8 bước, Caffeine caches, Alert FSM thích ứng & SOP Catalog |
| **05** | [Mô hình Dữ liệu (`05-data-model.md`)](docs/05-data-model.md) | 8 MongoDB collections, TimeSeries compression, indexes & `$dateTrunc` |
| **06** | [Bảo mật & RBAC (`06-security-and-rbac.md`)](docs/06-security-and-rbac.md) | Dual JWT `HS512`, 7 Roles × 14 Permissions, Bucket4j Rate Limit & STOMP ACL |
| **07** | [API & Error Codes (`07-api-reference.md`)](docs/07-api-reference.md) | 9 REST Controllers, 3 STOMP topics, `ApiResponse<T>` & 46 mã lỗi |
| **08** | [Kiến trúc Frontend (`08-frontend-architecture.md`)](docs/08-frontend-architecture.md) | Next.js 15 App Router (16 routes), Zustand, TanStack Query & Light Mode UI |
| **09** | [Bản đồ Nhiệt 2D (`09-spatial-heatmap-2d.md`)](docs/09-spatial-heatmap-2d.md) | AutoCAD SVG 1:100 5 tầng, Gaussian RBF + IDW, Zoom 2 cấp & công cụ theo Role |
| **10** | [Phần cứng IoT & Simulator (`10-iot-hardware-and-simulator.md`)](docs/10-iot-hardware-and-simulator.md) | Node ESP32-S3, giao thức MQTT JSON payloads & 10 kịch bản giả lập |
| **11** | [Quy chuẩn Phát triển (`11-conventions.md`)](docs/11-conventions.md) | Quy chuẩn code Backend/Frontend, an toàn Virtual Threads & PR Checklist |
| **12** | [Cẩm nang Vận hành (`12-runbook.md`)](docs/12-runbook.md) | Cài đặt local/Docker, Cloudflare Tunnel, kiểm tra nghiệm thu & Troubleshooting |
| **13** | [Từ điển Thuật ngữ (`13-glossary.md`)](docs/13-glossary.md) | Thuật ngữ chuyên ngành, từ viết tắt, đơn vị đo & quy chuẩn dữ liệu |

---

## Cấu trúc Thư mục Dự án

```text
AIoTLibTQB/
├── src/                                  # Backend Spring Boot 3.5.8 (Java 21)
├── frontend/                             # Frontend Next.js 15 + React 19 + Canvas 2D
├── mosquitto/config/                     # Cấu hình Mosquitto & ACL per-device (%u)
├── tools/
│   ├── iot-simulator/                    # Bộ giả lập mạch Node.js (10 kịch bản kiểm thử)
│   └── cloudflared/                      # Unified Gateway (:4000) & Cloudflare Tunnel scripts
├── docs/                                 # Bộ tài liệu kỹ thuật chuẩn v2.1 (README + 01..13)
│   └── archive/                          # Hồ sơ nghiệp vụ & lịch sử audit/kế hoạch cũ
├── AIoTLibTQB_Postman_Collection.json    # Bộ sưu tập Postman kiểm thử REST API v2.1
├── docker-compose.yml                    # Điều phối 6 dịch vụ & 2 mạng Docker cách ly
└── .env.example                          # Mẫu biến môi trường chuẩn 12-Factor
```
