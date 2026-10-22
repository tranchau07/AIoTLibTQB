# AIoTLibTQB — Hệ Thống IoT Giám Sát Vi Khí Hậu & Âm Học Thư Viện Thông Minh

> **Nền tảng công nghệ**: Spring Boot 3.5.8 | Java 21 LTS (Virtual Threads) | MongoDB 8.0 (Native TimeSeries) | Eclipse Mosquitto 2.0 (MQTT)  
> **Thuật toán cốt lõi**: Động cơ chấm điểm tiện nghi học tập phi tuyến (**Library Comfort Score - LCS**) theo **Nguyên lý Thùng gỗ Liebig**.

---

## 📚 MỤC LỤC TÀI LIỆU DỰ ÁN (DOCUMENTATION DIRECTORY)

Hệ thống tài liệu dự án được xây dựng toàn diện, giúp bạn dễ dàng theo dõi kiến trúc, lộ trình và bản thiết kế giao diện từ mọi thiết bị:

### 1. Báo Cáo Phân Tích Kỹ Thuật Toàn Diện (`docs/analysis/`)
| STT | Tài Liệu | Nội Dung Chính |
|:---:|:---|:---|
| **01** | [`01_code.md`](docs/analysis/01_code.md) | Phân tích kiến trúc mã nguồn Spring Boot, phân lớp Controller-Service-Repository, phân quyền RBAC 7 Roles / 14 Permissions, pipeline Ingestion MQTT đa luồng ảo Java 21, bộ lọc số liệu và ma trận 42 endpoints/handlers. |
| **02** | [`02_config.md`](docs/analysis/02_config.md) | Phân tích cấu hình hạ tầng, dependencies `pom.xml`, container hóa Docker Compose, cấu hình CSDL MongoDB 8.0 Native TimeSeries và bảo mật phân quyền Mosquitto MQTT. |
| **03** | [`03_docs.md`](docs/analysis/03_docs.md) | Rà soát tài liệu thiết kế gốc, phân tích lịch sử phát triển Git, và bảng đối chiếu 15 điểm mâu thuẫn giữa tài liệu và mã nguồn thực tế. |
| **04** | [`04_contract.md`](docs/analysis/04_contract.md) | Kiểm toán hợp đồng REST API, cấu trúc envelope chuẩn `ApiResponse<T>`, đánh giá độ bao phủ kiểm thử (124 unit tests, khoảng trống integration test), phân trang và validation. |
| **05** | [`05_p1_summary.md`](docs/analysis/05_p1_summary.md) | Báo cáo tóm tắt điều hành Phase 1: Tổng quan dự án, ma trận mức độ hoàn thiện, Top 5 rủi ro kỹ thuật trọng yếu và bảng dữ liệu UI sẵn sàng vs còn thiếu. |
| **06** | [`06_references.md`](docs/analysis/06_references.md) | Báo cáo đối chiếu thực tế 4 dự án nguồn mở hàng đầu cùng domain (**ThingsBoard CE**, **OpenRemote**, **AirGradient**, **openSenseMap**) theo 5 trục kỹ thuật, rút ra bài học kinh nghiệm và kiến trúc tham chiếu. |
| **07** | [`07_project_conclusion.md`](docs/analysis/07_project_conclusion.md) | **Kết luận toàn diện dự án**: Bản chất hệ thống, người dùng mục tiêu, giá trị cốt lõi, bản đồ chức năng chi tiết 42 nghiệp vụ và đánh giá 5 điểm mạnh / 5 điểm yếu kiến trúc. |
| **08** | [`08_roadmap.md`](docs/analysis/08_roadmap.md) | **Kế hoạch lộ trình phát triển**: Phân cấp thứ tự ưu tiên P0 (khẩn cấp), P1 (cốt lõi), P2 (mở rộng), ma trận rủi ro và các quyết định chiến lược cần phê duyệt. |
| **09** | [`09_ui_blueprint.md`](docs/analysis/09_ui_blueprint.md) | **Bản thiết kế kiến trúc giao diện UI/UX**: Ma trận 15 màn hình (M01–M15), luồng điều hướng, chuẩn hóa 4 trạng thái UI, đề xuất cấu trúc API nén dữ liệu Time Buckets, stack công nghệ khuyến nghị (Next.js + Tailwind + Canvas 2D + Recharts) và lộ trình 3 đợt triển khai UI. |

### 2. Hồ Sơ Đặc Tả Nghiệp Vụ Chuyên Sâu (`docs/business/`)
| STT | Tài Liệu | Nội Dung Nghiệp Vụ |
|:---:|:---|:---|
| **00** | [`00_TONG_QUAN.md`](docs/business/00_TONG_QUAN.md) | Tổng quan hệ thống cho ban quản trị, ma trận 7 vai trò tác nhân, sơ đồ ngữ cảnh C4 và bản đồ 25 chức năng nghiệp vụ cốt lõi. |
| **10A** | [`10_CHUC_NANG_IAM.md`](docs/business/10_CHUC_NANG_IAM.md) | Đặc tả 13 chức năng định danh & kiểm soát truy cập (IAM), luồng Access/Refresh Token Rotation, Token Blacklist và CRUD tài khoản. |
| **10B** | [`10_CHUC_NANG_SPACE_DEVICE.md`](docs/business/10_CHUC_NANG_SPACE_DEVICE.md) | Đặc tả 16 chức năng quản lý phòng đọc, lưu tọa độ đa giác tường `boundaryPolygon`, đăng ký trạm đo cấp `rawApiKey`, xác thực phần cứng và tự động dò tìm (Discovery). |
| **10C** | [`10_CHUC_NANG_TELEMETRY.md`](docs/business/10_CHUC_NANG_TELEMETRY.md) | Đặc tả pipeline Ingestion MQTT QoS 1, sơ đồ chân phần cứng ESP32-S3 (I2S, SPS30, I2C, UART), ngưỡng lọc vật lý, Forward-Fill 30s và kẹp timestamp. |
| **20** | [`20_MO_HINH_DU_LIEU.md`](docs/business/20_MO_HINH_DU_LIEU.md) | Mô hình dữ liệu toàn diện & sơ đồ ERD: Document collections (User, Role, Permission, Room, Device, Alert) và Native TimeSeries `telemetry_records`. |
| **30** | [`30_TICH_HOP_VA_TIEN_TRINH_NEN.md`](docs/business/30_TICH_HOP_VA_TIEN_TRINH_NEN.md) | Đặc tả tích hợp hạ tầng Mosquitto MQTT, Spring Integration qua Java 21 Virtual Threads và tiến trình nền Scheduled dọn token quá hạn. |
| **40** | [`40_BAO_MAT_VA_PHAN_QUYEN.md`](docs/business/40_BAO_MAT_VA_PHAN_QUYEN.md) | Kiến trúc an ninh đa tầng: Chuỗi lọc Servlet, JWT HMAC-SHA512, ma trận phân quyền 14 quyền $\times$ 7 roles, bảo vệ phân vùng Zone-based. |
| **50** | [`50_CAU_HINH_VA_VAN_HANH.md`](docs/business/50_CAU_HINH_VA_VAN_HANH.md) | Hồ sơ biến môi trường chuẩn 12-Factor, cấu hình Docker Compose (MongoDB 8.0, Mongo Express, Mosquitto 2.0) và giám sát Actuator. |
| **90** | [`90_DOI_CHIEU_VA_CAU_HOI_MO.md`](docs/business/90_DOI_CHIEU_VA_CAU_HOI_MO.md) | Báo cáo đối soát tài liệu sơ khởi, các tính năng chờ và danh mục Top 10 câu hỏi mở kỹ thuật. |

### 3. Kịch Bản Kiểm Thử & Kế Hoạch Triển Khai
- [`KE_HOACH_HOAN_THIEN_BACKEND.md`](KE_HOACH_HOAN_THIEN_BACKEND.md): **Kế hoạch hành động chi tiết hoàn thiện Backend** theo 2 giai đoạn (MVP cốt lõi $\rightarrow$ Tinh chỉnh mở rộng).
- [`AIoTLibTQB_Postman_Collection.json`](AIoTLibTQB_Postman_Collection.json): Bộ sưu tập Postman Collection đầy đủ 100% các kịch bản kiểm thử API cho môi trường phát triển và kiểm thử tự động.

---

## 🛠️ HƯỚNG DẪN KHỞI CHẠY DỰ ÁN (GETTING STARTED)

### 1. Chuẩn Bị Môi Trường
- **Java**: JDK 21 LTS
- **Maven**: 3.9+
- **Docker & Docker Compose**: Để chạy MongoDB 8.0 và Eclipse Mosquitto

### 2. Cấu Hình
Sao chép các file cấu hình mẫu và điền thông tin bí mật thực tế của môi trường:
```bash
# Tạo file cấu hình ứng dụng
cp src/main/resources/application.yaml.example src/main/resources/application.yaml

# Tạo file mật khẩu Mosquitto MQTT
cp mosquitto/config/password.txt.example mosquitto/config/password.txt
```

### 3. Khởi Chạy Hạ Tầng Docker
```bash
docker compose up -d
```
Lệnh trên sẽ khởi chạy:
- **MongoDB 8.0**: Cổng `27017`
- **Mongo Express UI**: Cổng `8081` (truy cập `http://localhost:8081`)
- **Mosquitto MQTT Broker**: Cổng TCP `1883`

### 4. Khởi Chạy Backend Spring Boot
```bash
# Trên Linux/macOS
./mvnw spring-boot:run

# Trên Windows
mvnw.cmd spring-boot:run
```
Máy chủ backend sẽ lắng nghe tại cổng `8080`.
Kiểm tra sức khỏe hệ thống: `http://localhost:8080/actuator/health`.

---
*Dự án được bảo trì bởi Trần Minh Châu — 2026.*
