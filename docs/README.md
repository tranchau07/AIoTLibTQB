# Cổng Tài Liệu Kỹ Thuật AIoTLibTQB (`docs/`)

> **Phiên bản**: 2.1 | **Cập nhật**: 2026-11-13 | **Trạng thái**: Đồng bộ 100% với mã nguồn thực tế
>
> [!NOTE]
> **TL;DR**: Đây là bản đồ điều hướng trung tâm của bộ tài liệu kỹ thuật **AIoTLibTQB** (13 tài liệu chuẩn từ `01` đến `13`). Mọi tài liệu tuân thủ nguyên tắc *Single Source of Truth* (mỗi chủ đề chỉ trình bày chi tiết ở một tài liệu chủ quản) và đối chiếu trực tiếp với code đang chạy (`com.example.AIoTLibTQB`, `frontend/`, `tools/`).

---

## 1. Danh mục 13 Tài liệu Chuẩn (`01` → `13`)

| STT | Tài liệu | Phạm vi Nội dung Cốt lõi | Thời lượng đọc |
| :---: | :--- | :--- | :---: |
| **01** | [Bài toán & Tiêu chuẩn (`01-domain-and-standards.md`)](./01-domain-and-standards.md) | Bối cảnh Thư viện Tạ Quang Bửu, tiêu chuẩn ISO 11799 / ASHRAE 55 / WHO / TCVN, 3 `RoomType`, phạm vi In/Out-of-scope và các bên liên quan. | ~10 phút |
| **02** | [Kiến trúc Hệ thống (`02-architecture.md`)](./02-architecture.md) | Sơ đồ C4 (Context & Container), Tech Stack khớp `pom.xml` / `package.json`, mạng Docker cách ly 6 services và ADRs. | ~15 phút |
| **03** | [Thuật toán LCS (`03-lcs-algorithm.md`)](./03-lcs-algorithm.md) | **SSOT** công thức Library Comfort Score: 4 chỉ số thành phần, tái phân bổ trọng số động, phạt phi tuyến Liebig và bảng 5 hạng. | ~15 phút |
| **04** | [Ingestion & Cảnh báo (`04-ingestion-and-alerts.md`)](./04-ingestion-and-alerts.md) | **SSOT** pipeline MQTT 8 bước trên Virtual Threads, 7 vùng đệm RAM/Caffeine, Alert FSM động theo phòng, Dual Noise Peak & SOP Catalog. | ~20 phút |
| **05** | [Mô hình Dữ liệu (`05-data-model.md`)](./05-data-model.md) | 8 MongoDB collections (`telemetry_records` TimeSeries TTL 90 ngày + 7 Document collections), Indexes, `$dateTrunc` & Seed Matrix. | ~15 phút |
| **06** | [Bảo mật & RBAC (`06-security-and-rbac.md`)](./06-security-and-rbac.md) | **SSOT** an ninh 3 mặt phẳng: Dual JWT `HS512`, Blacklist TTL, ma trận `7 Roles × 14 Permissions`, Bucket4j Rate Limit & STOMP ACL. | ~15 phút |
| **07** | [REST API, STOMP & Mã lỗi (`07-api-reference.md`)](./07-api-reference.md) | Đặc tả toàn bộ 9 REST Controllers (`/api/v1/**`), 3 STOMP WebSocket topics, `ApiResponse<T>`/`PageResponse<T>` và 46 `ErrorCode`. | ~20 phút |
| **08** | [Kiến trúc Frontend (`08-frontend-architecture.md`)](./08-frontend-architecture.md) | Next.js 15 App Router (16 routes), Zustand + Single-Flight Refresh, TanStack Query fallback polling, `CapabilityMatrix` & UI Light Mode. | ~15 phút |
| **09** | [Bản đồ Nhiệt Không gian 2D (`09-spatial-heatmap-2d.md`)](./09-spatial-heatmap-2d.md) | **SSOT** CAD SVG 1:100 5 tầng (`76.0m × 57.2m`, 33 phòng preset), Gaussian RBF + IDW, Zoom 2 cấp, ẩn danh `FE-VIZ-09` & công cụ theo Role. | ~20 phút |
| **10** | [Phần cứng IoT & Simulator (`10-iot-hardware-and-simulator.md`)](./10-iot-hardware-and-simulator.md) | **SSOT** node ESP32-S3 (INMP441, SPS30, SHT30/31, BH1750), MQTT JSON Payloads/LWT và bộ giả lập Node.js 10 kịch bản. | ~15 phút |
| **11** | [Quy chuẩn Phát triển (`11-conventions.md`)](./11-conventions.md) | Quy chuẩn viết code Backend/Frontend kèm ví dụ Đúng/Sai (Virtual Threads, TimeSeries, Single-Flight Auth, HiDPI Canvas) & PR Checklist. | ~15 phút |
| **12** | [Cẩm nang Vận hành (`12-runbook.md`)](./12-runbook.md) | **SSOT** cài đặt môi trường, Docker Compose, Provisioning, Cloudflare Quick Tunnel, 4 bài nghiệm thu thực địa & Troubleshooting. | ~20 phút |
| **13** | [Từ điển Thuật ngữ (`13-glossary.md`)](./13-glossary.md) | Bảng thuật ngữ chuyên ngành, từ viết tắt kỹ thuật, đơn vị đo lường vật lý và định dạng dữ liệu chuẩn. | ~5 phút |

---

## 2. Lộ trình Đọc theo Vai trò

### 2.1. Thành viên mới (Onboarding — ~45 phút)
1. [01-domain-and-standards.md](./01-domain-and-standards.md) — Hiểu bài toán kép bảo tồn tài liệu & tiện nghi học tập.
2. [02-architecture.md](./02-architecture.md) — Nắm sơ đồ 5 tầng và mạng Docker 6 services.
3. [12-runbook.md](./12-runbook.md) — Tự dựng toàn bộ hệ thống trên máy cá nhân và chạy simulator.
4. [13-glossary.md](./13-glossary.md) — Tra cứu nhanh thuật ngữ khi đọc code.

### 2.2. Backend Engineer (Java / Spring Boot / MongoDB)
1. [03-lcs-algorithm.md](./03-lcs-algorithm.md) → [04-ingestion-and-alerts.md](./04-ingestion-and-alerts.md) — Luồng dữ liệu cảm biến, LCS & Alert FSM.
2. [05-data-model.md](./05-data-model.md) — Schema MongoDB 8.0, TimeSeries & `$dateTrunc`.
3. [06-security-and-rbac.md](./06-security-and-rbac.md) → [07-api-reference.md](./07-api-reference.md) — Bảo mật & hợp đồng API.
4. [11-conventions.md](./11-conventions.md) — Quy tắc an toàn Virtual Threads, `Semaphore` và Envelope.

### 2.3. Frontend Engineer (Next.js / React / Canvas 2D)
1. [08-frontend-architecture.md](./08-frontend-architecture.md) — 16 routes, Zustand Auth, TanStack Query & STOMP Singleton.
2. [09-spatial-heatmap-2d.md](./09-spatial-heatmap-2d.md) — Kiến trúc AutoCAD 5 tầng, Gaussian RBF Heatmap & LOD nhãn.
3. [07-api-reference.md](./07-api-reference.md) & [06-security-and-rbac.md](./06-security-and-rbac.md) — REST contracts, 46 mã lỗi & `CapabilityMatrix`.

### 2.4. IoT / Embedded & QA Engineer
1. [10-iot-hardware-and-simulator.md](./10-iot-hardware-and-simulator.md) — Phần cứng ESP32-S3, dải đo, MQTT Payloads/LWT & Simulator CLI.
2. [12-runbook.md](./12-runbook.md) — Chạy các kịch bản kiểm thử và 4 bài nghiệm thu phần cứng.
3. [Postman Collection](../AIoTLibTQB_Postman_Collection.json) — Bộ test API tự động cho toàn bộ endpoint v2.1.

### 2.5. Hội đồng Đánh giá / Nghiệm thu
1. [01-domain-and-standards.md](./01-domain-and-standards.md) — Cơ sở khoa học & tiêu chuẩn áp dụng.
2. [03-lcs-algorithm.md](./03-lcs-algorithm.md) & [04-ingestion-and-alerts.md](./04-ingestion-and-alerts.md) — Điểm sáng thuật toán & phòng vệ dữ liệu.
3. [09-spatial-heatmap-2d.md](./09-spatial-heatmap-2d.md) — Demo trực quan hóa mặt bằng 5 tầng & Kiosk công khai.

---

## 3. Tài nguyên Phụ trợ & Lưu trữ Lịch sử

- **Postman Collection v2.1**: [`AIoTLibTQB_Postman_Collection.json`](../AIoTLibTQB_Postman_Collection.json) — Bộ kiểm thử REST API (Auth, Users, Roles/Permissions, Devices, Rooms + Thresholds, Telemetry, Alerts, Public Kiosk, Actuator).
- **Công cụ Phụ trợ**:
  - [`tools/iot-simulator/README.md`](../tools/iot-simulator/README.md) — Hướng dẫn nhanh công cụ giả lập mạch Node.js.
  - [`tools/cloudflared/README.md`](../tools/cloudflared/README.md) — Hướng dẫn chia sẻ web công khai qua Cloudflare Tunnel.
- **Kho lưu trữ Lịch sử (`docs/archive/`)**:
  - `docs/archive/analysis/` & `docs/archive/business/`: Hồ sơ phân tích kỹ thuật và đặc tả nghiệp vụ pha khởi tạo.
  - [`docs/archive/history/`](./archive/history/): Lưu trữ các báo cáo kiểm toán và kế hoạch triển khai giai đoạn trước (`AIOT_LIBRARY_AUDIT_REPORT.md`, `KE_HOACH_HOAN_THIEN_BACKEND.md`, `KE_HOACH_HOAN_THIEN_FRONTEND.md`).
  - `docs/archive/implementation/` & `docs/archive/frontend/`: Tài liệu kỹ thuật thành phần trước khi hợp nhất về `docs/01..13`.
