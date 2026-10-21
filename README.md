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

### 2. Hồ Sơ Đặc Tả Yêu Cầu Gốc (Root Documents)
- [`IOT_SYSTEM_SPECIFICATION.md`](IOT_SYSTEM_SPECIFICATION.md): Đặc tả hệ thống IoT và phân tích các chỉ số môi trường (nhiệt độ, độ ẩm, độ ồn, bụi mịn, ánh sáng).
- [`KE_HOACH_TRIEN_KHAI_PHAN_MEM_IOT.md`](KE_HOACH_TRIEN_KHAI_PHAN_MEM_IOT.md): Kế hoạch triển khai kiến trúc phần mềm và các kịch bản kiểm thử.
- [`HUONG_DAN_THUC_HIEN_VA_CAN_NHAC_GIAI_PHAP.md`](HUONG_DAN_THUC_HIEN_VA_CAN_NHAC_GIAI_PHAP.md): Hướng dẫn thực hiện và các giải pháp kỹ thuật đề xuất.
- [`AIoTLibTQB_Postman_Collection.json`](AIoTLibTQB_Postman_Collection.json): Bộ sưu tập Postman Collection đầy đủ các kịch bản kiểm thử API.

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
