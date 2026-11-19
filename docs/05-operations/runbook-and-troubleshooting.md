# Cẩm Nang Vận Hành, SOP Cảnh Báo & Xử Lý Sự Cố / Operations Runbook, Alert SOPs & Troubleshooting

> **Cơ sở kiểm chứng / Verified From:** [`AlertSopCatalog.java`](../../src/main/java/com/example/AIoTLibTQB/configuration/AlertSopCatalog.java), [`AlertEmailNotificationService.java`](../../src/main/java/com/example/AIoTLibTQB/service/AlertEmailNotificationService.java), [`RateLimitFilter.java`](../../src/main/java/com/example/AIoTLibTQB/configuration/RateLimitFilter.java), [`ApplicationInitConfig.java`](../../src/main/java/com/example/AIoTLibTQB/configuration/ApplicationInitConfig.java), [`application.yaml`](../../src/main/resources/application.yaml).

---

## 1. Giám Sát Sức Khỏe Hạ Tầng / Health & Observability Endpoints

| Endpoint | Quyền / Auth | Mục đích kiểm tra / Purpose |
| :--- | :---: | :--- |
| `GET /actuator/health` | Public *(chi tiết khi có auth: `when_authorized`)* | Trạng thái sống của Backend, kết nối MongoDB & đĩa. |
| `GET /actuator/info` | Public | Thông tin ứng dụng Spring Boot. |
| `GET /actuator/metrics` | Authenticated | Các bộ đếm JVM, heap, HTTP requests, Executor Virtual Threads. |

```bash
# Kiểm tra nhanh toàn cụm Docker / Quick container health inspection
docker compose ps
docker compose logs --tail=100 backend mosquitto
```

---

## 2. Bảng Quy Trình Xử Lý Chuẩn (SOP) Cho Cảnh Báo / Standard Operating Procedures ([`AlertSopCatalog`](../../src/main/java/com/example/AIoTLibTQB/configuration/AlertSopCatalog.java))

**[VI]** Khi hệ thống sinh cảnh báo, trường `recommendedAction` được gắn tự động theo loại chỉ số và loại phòng:  
**[EN]** Every triggered alert receives a tailored `recommendedAction` instruction mapped by metric and room type:

| `metricType` / `AlertType` | Phạm vi / Scope | Nội dung hướng dẫn xử lý trong hệ thống / Action Guidance in Code |
| :--- | :--- | :--- |
| `HUMIDITY_HIGH` | `BOOK_STORAGE` | Kích hoạt ngay máy hút ẩm công nghiệp về `45–55%RH`; đóng kín cửa thông gió tự nhiên chống nấm mốc giấy. |
| `HUMIDITY_LOW` | `BOOK_STORAGE` | Kiểm tra hệ thống bù ẩm, giảm lưu lượng gió khô HVAC để tránh giòn gãy sợi giấy cổ (`< 45%RH`). |
| `NOISE_PEAK` | `STUDY_ROOM` / `BOOK_STORAGE` / `CIRCULATION_HALL` | Tuần tra nhắc nhở trật tự (phòng đọc); kiểm tra bốc xếp/kệ sắt (kho); điều tiết luồng quầy thủ tục (sảnh). |
| `NOISE_AVG` | `STUDY_ROOM` / `BOOK_STORAGE` / `CIRCULATION_HALL` | Đề nghị bạn đọc chuyển phòng học nhóm Tầng 5 (phòng đọc); kiểm tra quạt cơ khí (kho); mở thêm quầy hỗ trợ (sảnh). |
| `TEMPERATURE` | `BOOK_STORAGE` / `STUDY_ROOM` / `CIRCULATION_HALL` | Kiểm tra Precision AC (kho); hạ setpoint FCU/AHU `-1.5°C` & kéo rèm (phòng đọc); kiểm tra rèm chắn gió air curtain (sảnh). |
| `PM2_5` (`AIR_UNHEALTHY`) | Mọi phòng / All rooms | Tăng quạt cấp khí tươi lọc HEPA (AHU), hạn chế mở cửa sổ trực tiếp ra mặt đường Giải Phóng – Trần Đại Nghĩa. |
| `DEVICE_OFFLINE` | Mọi thiết bị / All devices | Kiểm tra nguồn 5V DC của ESP32, cường độ sóng Wi-Fi RSSI và kết nối MQTT Broker. |
| `SENSOR_MALFUNCTION` | Mọi thiết bị / All devices | Kiểm tra dây tín hiệu I2C/UART và hiệu chuẩn/thay thế module cảm biến gửi giá trị lỗi ngoài dải liên tục. |

### Quy tắc gửi Email Cảnh báo SMTP (`AlertEmailNotificationService`)
- Bật qua `ALERT_EMAIL_ENABLED=true` (kèm cấu hình `spring.mail.*`).
- Gửi ngay `[KHẨN CẤP - CRITICAL]` khi phát sinh `CRITICAL`; nhắc `[LEO THANG - HIGH]` nếu cảnh báo `HIGH` vẫn `FIRING` quá `10 phút` chưa ACK (quét mỗi `60s`); gửi `[ĐÃ KHẮC PHỤC - RESOLVED]` khi đóng sự cố.
- Áp dụng **cooldown mở sự cố `30 phút`/phòng** để chống spam; người nhận gồm tất cả `ADMIN` active có email + user được gán `assignedZones` khớp `alert.zoneId`.

---

## 3. Cẩm Nang Xử Lý 9 Sự Cố Thường Gặp / Troubleshooting Guide

| # | Triệu chứng / Symptom | Nguyên nhân gốc / Root Cause | Cách khắc phục / Resolution |
| :---: | :--- | :--- | :--- |
| **1** | **Backend lỗi kết nối MongoDB khi khởi động** | Service `aiot_mongodb` chưa healthy hoặc sai `MONGO_ROOT_*` / trùng cổng `27017` trên host. | Kiểm tra `docker compose ps`, đối chiếu `.env` và tắt dịch vụ `mongod` local chiếm cổng `27017`. |
| **2** | **Backend hoặc ESP32 bị Mosquitto từ chối (`rc = 5`)** | Sai `MQTT_USERNAME`/`PASSWORD`, bật `MQTT_PER_DEVICE_AUTH=true` nhưng thiết bị không dùng `username == hardwareId`, hoặc device mới chưa có trong `password.txt`. | Đảm bảo `username == hardwareId`; chạy `mosquitto_passwd` trên container `mosquitto` hoặc `docker compose restart mosquitto`. |
| **3** | **Backend từ chối khởi động ở profile `prod`** | Thiếu `INITIAL_ADMIN_PASSWORD` hoặc `JWT_SECRET < 64` ký tự (`ApplicationInitConfig`). | Bổ sung đủ `JWT_SECRET` ($\ge 64$ chars) và `INITIAL_ADMIN_PASSWORD` trong môi trường `prod`. |
| **4** | **Quản lý/Thủ thư không thấy bất kỳ cảnh báo nào trên `/alerts`** | Tài khoản không phải `ADMIN` chưa được gán `assignedZones` trong MongoDB (`AlertServiceImpl` lọc theo `assignedZones`, trống sẽ trả `__none__`). | Đăng nhập bằng `ADMIN` → `/admin/users` → gán danh sách `assignedZones` phù hợp cho `LIBRARIAN`/`ZONE_MANAGER`/`MAINTENANCE`. |
| **5** | **UI mất Realtime WebSocket & hiện badge polling 15s** | Token hết hạn, sai `NEXT_PUBLIC_WS_URL` hoặc thiếu origin trong `CORS_ALLOWED_ORIGINS`. | Cập nhật `CORS_ALLOWED_ORIGINS` khớp URL trình duyệt, kiểm tra `/ws-aiot` qua reverse proxy hỗ trợ HTTP `Upgrade: websocket`. |
| **6** | **HTTP `429` (`4029: TOO_MANY_REQUESTS`)** | Vượt ngưỡng Bucket4j (`10 req/phút` ở Auth hoặc `60 req/phút` ở `/api/v1/public/**`), hoặc qua proxy nhưng chưa khai báo `security.rate-limit.trusted-proxies` khiến mọi user dùng chung IP proxy. | Đợi hết `Retry-After` (UI `/login` tự đếm ngược); thêm IP của Nginx/Traefik vào `security.rate-limit.trusted-proxies`. |
| **7** | **Lưu bố trí nội thất báo lỗi `5007` hoặc `5008`** | `5007` (`409`): người khác đã lưu phiên bản mới hơn (`@Version` mismatch); `5008` (`400`): vật thể nằm ngoài `boundaryPolygon` hoặc 2 vật cản (`DESK`, `BOOKSHELF`...) chồng lấn SAT. | `5007`: tải lại layout mới nhất của phòng; `5008`: di chuyển/thu nhỏ vật thể vào trong đường bao và tách rời nhau. |
| **8** | **Bản đồ hiển thị "Dữ liệu cũ (STALE)" (> 5 phút) nhưng mạch vẫn đang bật** | Mạch gửi giá trị ngoài dải vật lý (VD `noise = 0` hoặc `noise_avg = 0`) bị Sanitizer hủy toàn bộ, hoặc sai tên topic/anti-spoofing `hardware_id`. | Theo dõi log `MqttMessageDispatcherService` & kiểm tra checklist 5 lỗi trong [IoT Protocol Spec](../03-technical-specs/iot-hardware-protocol.md). |
| **9** | **Simulator báo `Safety Guard Rejection`** | Kết nối MQTT broker ngoài loopback mà chưa cho phép. | Thêm `--force-remote` hoặc đặt `FORCE_REMOTE=true`. |

---

## 4. Tổng Hợp Các Thông Tin Cần Bổ Sung Ngoài Mã Nguồn / Missing Organizational Knowledge

- `[CẦN BỔ SUNG / TO BE ADDED: Quy trình phân công trực ca (On-call Roster), kênh liên hệ leo thang khẩn cấp ngoài phần mềm (Hotline Bảo vệ / Ban quản lý tòa nhà Tạ Quang Bửu).]`
- `[CẦN BỔ SUNG / TO BE ADDED: Lịch bảo trì & hiệu chuẩn (Calibration SOP) định kỳ cho các module phần cứng SPS30, SHT31, INMP441, BH1750 ngoài thực địa.]`
- `[CẦN BỔ SUNG / TO BE ADDED: Quy trình kiểm tra & thay mới nguồn pin/adapter và cập nhật firmware OTA (khi kênh devices/{id}/command được kích hoạt ở pha sau).]`
