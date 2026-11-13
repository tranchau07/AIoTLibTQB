# AIoTLibTQB IoT Circuit Simulator

Bộ giả lập mạch IoT độc lập (*standalone IoT Circuit Simulator*) mô phỏng **14 phòng / 23 thiết bị** theo đúng mặt bằng AutoCAD Thư viện Tạ Quang Bửu (`config/rooms.json`), hỗ trợ kích hoạt toàn bộ luồng ingestion MQTT, LCS Liebig, Alert FSM, Watchdog Offline, Conflation 1Hz và MongoDB TimeSeries Aggregation.

---

## 1. Cài đặt & Biến Môi trường (13 Biến trong `.env.example`)

Yêu cầu: **Node.js >= 18** (đã kiểm chứng trên Node.js v20 và v24).

```bash
cd tools/iot-simulator
npm install
cp .env.example .env
```

> [!CAUTION]
> Tuyệt đối thay thế các giá trị `CHANGE_ME_LOCAL_DEV_*` khớp với `.env` gốc của bạn và không commit `.env` lên Git.

| Biến Môi Trường | Giá Trị Mẫu (`.env.example`) | Mô Tả |
| :--- | :--- | :--- |
| `MQTT_BROKER_URL` | `mqtt://localhost:1883` | Địa chỉ MQTT Broker (Mosquitto) |
| `MQTT_PER_DEVICE_AUTH` | `true` | Bật xác thực từng node (`username = hardwareId`) theo Mosquitto ACL `%u` |
| `MQTT_DEVICE_PASSWORD` | `CHANGE_ME_LOCAL_DEV_DEVICE` | Mật khẩu dùng cho các node thiết bị mẫu trên broker dev |
| `MQTT_USERNAME` | `aiot_backend` | Tài khoản MQTT dự phòng khi tắt per-device auth |
| `MQTT_PASSWORD` | `CHANGE_ME_LOCAL_DEV_MQTT` | Mật khẩu tài khoản `MQTT_USERNAME` |
| `MQTT_CLIENT_PREFIX` | `sim_node_` | Tiền tố `clientId` MQTT |
| `MQTT_KEEPALIVE` | `30` | Chu kỳ keep-alive (giây) |
| `API_BASE_URL` | `http://localhost:8080` | URL Backend REST API |
| `ADMIN_USERNAME` | `admin` | Tài khoản quản trị để gọi Provisioning |
| `ADMIN_PASSWORD` | `CHANGE_ME_LOCAL_DEV_ADMIN` | Mật khẩu Admin (khớp `INITIAL_ADMIN_PASSWORD`) |
| `SIM_INTERVAL_MS` | `5000` | Chu kỳ phát telemetry (ms) |
| `SIM_SPEED` | `1` | Hệ số tua nhanh thời gian mô phỏng |
| `DEFAULT_SCENARIO` | `normal` | Kịch bản mặc định (`normal`, `demo`...) |
| `FORCE_REMOTE` | `false` | Cho phép kết nối broker ngoài loopback |

---

## 2. Rào An Toàn (`src/safety.js`) & Provisioning (`npm run provision`)

- **Safety Guard**: Mặc định chỉ cho phép kết nối `localhost`, `127.0.0.1`, `::1`, `0.0.0.0`, `host.docker.internal`, `*.local`. Muốn trỏ ra ngoài phải truyền `--force-remote` hoặc `FORCE_REMOTE=true`.
- **Idempotent Provisioning**: `npm run provision` (hoặc `node src/provision.js`) đồng bộ toàn bộ **14 phòng + 23 thiết bị** từ `config/rooms.json` lên Backend mà không tạo trùng khi chạy lại.

---

## 3. Danh Sách 10 Kịch Bản (`src/scenarios.js`)

| Tham Số `--scenario` | Mô Tả & Mục Đích Kiểm Thử | Lệnh Chạy Mẫu |
| :--- | :--- | :--- |
| `normal` | Vi khí hậu ổn định theo chu kỳ ngày đêm | `node src/index.js --scenario normal --devices 3 --duration 60 --interval 5` |
| `noise-spike` | Ồn nền $> 68$ dBA & đỉnh $> 82$ dBA kích hoạt Alert FSM | `node src/index.js --scenario noise-spike --devices 3 --duration 35 --interval 3` |
| `pm25-high` | Bụi mịn $\text{PM}_{2.5}$ tăng `68–80` µg/m³ | `node src/index.js --scenario pm25-high --devices 2 --duration 30 --interval 3` |
| `heat/humid` | Quá nhiệt (`35.5–36.5°C`) & ẩm cao (`85–88% RH`) | `node src/index.js --scenario heat/humid --devices 2 --duration 30 --interval 3` |
| `device-dropout` | Ngừng gửi tin $> 2$ phút test `DeviceWatchdogService` | `node src/index.js --scenario device-dropout --devices 2 --duration 140 --interval 5` |
| `flap` | Đảo trạng thái `online`/`offline` mỗi 2.5s | `node src/index.js --scenario flap --devices 1 --duration 20` |
| `lwt` | Đóng socket đột ngột kích hoạt Mosquitto LWT | `node src/index.js --scenario lwt --devices 1` |
| `bad-payload` | Giá trị ngoài dải / `{}` / lệch `hardware_id` test Sanitizer | `node src/index.js --scenario bad-payload --devices 2 --duration 20 --interval 3` |
| `burst` | Đẩy 100 gói/tick test `Semaphore(30)` & Conflation 1Hz | `node src/index.js --scenario burst --devices 1` |
| `demo` | Chu kỳ 24h tuần hoàn kèm cờ `--speed` | `node src/index.js --scenario demo --speed 60 --duration 120 --interval 2` |

Kết hợp `--provision` để tự đồng bộ phòng/thiết bị trước khi phát: `node src/index.js --provision --scenario normal --devices 3 --duration 30`.

---

**Tài liệu liên quan**: [Đặc tả Phần cứng & Simulator](../../docs/10-iot-hardware-and-simulator.md) · [Cẩm nang Vận hành](../../docs/12-runbook.md)
