# Hướng Dẫn Bộ Giả Lập Mạch IoT / IoT Circuit Simulator Guide

> **Vị trí mã nguồn / Source Path:** [`tools/iot-simulator/`](../../tools/iot-simulator) *(Node.js ESM `"type": "module"`, Dockerfile dùng `node:20-alpine`; hợp nhất nội dung từ tài liệu công cụ cũ).*

---

## 1. Tổng Quan & Cấu Hình Phòng Mẫu / Overview & Sample Topology

**[VI]** `tools/iot-simulator` mô phỏng luồng cảm biến độc lập tương thích 100% với **ESP32-S3 MQTT Contract**, đồng bộ tự động (idempotent) **`4` zones / `14` rooms / `23` thiết bị** chuẩn bản vẽ AutoCAD Thư viện Tạ Quang Bửu từ [`config/rooms.json`](../../tools/iot-simulator/config/rooms.json) lên Backend rồi phát tín hiệu vật lý theo chu kỳ ngày đêm 24h (nhiễu Gauss Box-Muller + đột biến giờ cao điểm).

**[EN]** `tools/iot-simulator` simulates hardware telemetry compliant with the ESP32-S3 MQTT specification, idempotently provisioning **`4` zones / `14` rooms / `23` devices** from [`config/rooms.json`](../../tools/iot-simulator/config/rooms.json) and streaming diurnal + Box-Muller Gaussian sensor waveforms.

### Cài đặt & Biến Môi trường ([`.env.example`](../../tools/iot-simulator/.env.example))
```bash
cd tools/iot-simulator
npm install
cp .env.example .env
# Lưu ý thay các giá trị mật khẩu (MQTT_DEVICE_PASSWORD, ADMIN_PASSWORD...) khớp với .env gốc
```

| Biến / Variable | Giá trị mẫu / Default | Mô tả / Description |
| :--- | :--- | :--- |
| `MQTT_BROKER_URL` | `mqtt://localhost:1883` | Broker MQTT đích |
| `MQTT_PER_DEVICE_AUTH` | `true` | Dùng `username = hardwareId` tuân thủ Mosquitto ACL `%u` |
| `MQTT_DEVICE_PASSWORD` | `***` | Mật khẩu dùng chung cho node thiết bị dev |
| `MQTT_USERNAME`, `MQTT_PASSWORD` | `aiot_backend` / `***` | Tài khoản fallback khi tắt per-device auth |
| `API_BASE_URL`, `ADMIN_USERNAME`, `ADMIN_PASSWORD` | `http://localhost:8080`, `admin`, `***` | Thông tin REST API cho bước `--provision` |
| `SIM_INTERVAL_MS`, `SIM_SPEED`, `DEFAULT_SCENARIO` | `500`, `1`, `normal` *(Compose: `demo`)* | Chu kỳ phát (ms), hệ số tua nhanh & kịch bản mặc định (`docker-compose.yml` đặt `demo`). |
| `FORCE_REMOTE` | `false` *(Compose: `true`)* | Cho phép kết nối broker ngoài localhost (`docker-compose.yml` đặt `true` để gọi `mosquitto`). |

---

## 2. Rào An Toàn & Provisioning / Safety Guard & Idempotent Provisioning

- **Safety Guard ([`src/safety.js`](../../tools/iot-simulator/src/safety.js))**: Chặn mọi kết nối tới host không nằm trong allowlist `7` host nội bộ (`localhost`, `127.0.0.1`, `::1`, `0.0.0.0`, `host.docker.internal`, `mosquitto`, `backend` — **không** cho phép `*.local`) trừ khi truyền `--force-remote` hoặc `FORCE_REMOTE=true`.
- **Idempotent Provisioning ([`src/provision.js`](../../tools/iot-simulator/src/provision.js))**: Lệnh `npm run provision` (hoặc thêm cờ `--provision`) tạo phân khu, phòng kèm `boundaryPolygon` / `RoomType` và thiết bị mẫu mà không tạo trùng lặp khi chạy lại.

---

## 3. Tham Số Dòng Lệnh & 10 Kịch Bản Kiểm Thử / CLI Flags & 10 Test Scenarios

### Các Cờ CLI Chính ([`src/index.js`](../../tools/iot-simulator/src/index.js))
- `--scenario <name>`: Chọn kịch bản (`normal`, `noise-spike`, `pm25-high`, `heat/humid`, `device-dropout`, `flap`, `lwt`, `bad-payload`, `burst`, `demo`).
- `--provision`: Tự động chạy provisioning trước khi phát telemetry.
- `--speed <number>`: Tua nhanh thời gian ảo (VD: `--speed 60`).
- `--interval <seconds>`: Chu kỳ gửi mỗi thiết bị tính bằng giây (VD: `--interval 0.5`).
- `--duration <seconds>`: Tự dừng sau N giây (`0` = chạy vô hạn).
- `--devices <count>`: Giới hạn số thiết bị giả lập.
- `--broker <url>` & `--force-remote`: Ghi đè URL MQTT broker.

### Bảng 10 Kịch Bản Thực Nghiệm ([`src/scenarios.js`](../../tools/iot-simulator/src/scenarios.js))

| `--scenario` | Mô phỏng thực địa / Simulated Condition | Lệnh chạy mẫu / Example Command |
| :--- | :--- | :--- |
| `normal` | Vi khí hậu ổn định theo chu kỳ 24h | `node src/index.js --provision --scenario normal --devices 3 --duration 60 --interval 0.5` |
| `noise-spike` | Ồn nền `>= 68.5 dBA` + xung đột ngột `77–86 dBA` kích hoạt `NOISE_AVG` & `NOISE_PEAK` | `node src/index.js --scenario noise-spike --devices 3 --duration 40 --interval 0.5` |
| `pm25-high` | Bụi mịn `PM2.5` mức `68–80 µg/m³` vượt ngưỡng `50` kích hoạt `AIR_UNHEALTHY` | `node src/index.js --scenario pm25-high --devices 2 --duration 40 --interval 2` |
| `heat/humid` | Quá nhiệt `35.5–36.5°C` & ẩm cao `85–88%RH` | `node src/index.js --scenario heat/humid --devices 2 --duration 40 --interval 2` |
| `device-dropout` | Ngừng gửi sau 2 bước để Watchdog đánh `OFFLINE` sau 2 phút | `node src/index.js --scenario device-dropout --devices 2 --duration 140 --interval 5` |
| `flap` | Bật/tắt kết nối liên tục test chống rung `OFFLINE_FLAP_WINDOW` | `node src/index.js --scenario flap --devices 1 --duration 30` |
| `lwt` | Đóng socket đột ngột kích hoạt Mosquitto Last Will & Testament | `node src/index.js --scenario lwt --devices 1` |
| `bad-payload` | Gửi `250°C`/`999 dBA`, `{}` rỗng, `null`, hoặc giả mạo `hardware_id` | `node src/index.js --scenario bad-payload --devices 2 --duration 20 --interval 3` |
| `burst` | Đẩy nhanh `100` gói kiểm tra `Semaphore(30)` & Conflation `500ms` | `node src/index.js --scenario burst --devices 1` |
| `demo` | Kịch bản demo liên tục kèm giờ cao điểm ở Zone B & Sảnh | `node src/index.js --provision --scenario demo --speed 30` |

```bash
# Chạy unit test nội bộ của simulator / Run simulator unit tests
cd tools/iot-simulator && npm test
```
