# 10 — Phần Cứng IoT ESP32-S3, Giao Thức MQTT & Bộ Giả Lập

> **Tài liệu**: `docs/10-iot-hardware-and-simulator.md` | **Phiên bản**: 2.1 | **Mã nguồn SSOT**: [`mosquitto/config/acl.conf`](../mosquitto/config/acl.conf), [`TelemetrySanitizerService`](../src/main/java/com/example/AIoTLibTQB/service/TelemetrySanitizerService.java), [`tools/iot-simulator/`](../tools/iot-simulator/src/scenarios.js)
>
> [!NOTE]
> **TL;DR**: Trạm đo thực địa dùng vi điều khiển **ESP32-S3** kết nối cụm **4 cảm biến (INMP441, Sensirion SPS30, SHT30/31, ROHM BH1750/VEML7700)** thu thập 9 chỉ số + `wifi_rssi`, phát JSON UTF-8 lên Eclipse Mosquitto 2.0 (TCP `:1883`, QoS 1) kèm bản tin di chúc **LWT**. Đi kèm là bộ giả lập **Node.js `tools/iot-simulator`** mô phỏng **14 phòng / 23 thiết bị** với **10 kịch bản kiểm thử**.

---

## 1. Kiến Trúc Phần Cứng Trạm Đo ESP32-S3

- **Vi điều khiển**: ESP32-S3 (Dual-core Xtensa LX7 @ 240 MHz, 512 KB SRAM, 8 MB Flash + 8 MB Octal PSRAM hỗ trợ đệm **Offline Store-and-Forward**, Wi-Fi 2.4 GHz 802.11 b/g/n).
- **Cụm 4 cảm biến & dải đo hợp lệ ([`TelemetrySanitizerService`](../src/main/java/com/example/AIoTLibTQB/service/TelemetrySanitizerService.java))**:

| Cảm biến | Giao tiếp | Trường JSON (`@JsonAlias`) | Đơn vị | Dải hợp lệ `[Min, Max]` |
| :--- | :--- | :--- | :---: | :---: |
| **INMP441** (MEMS Audio) | I2S DMA 24-bit | `noise_avg` (`noiseAvg`)<br>`noise_peak` (`noisePeak`) | dBA | `[30.0, 110.0]`<br>`[30.0, 130.0]` *(Không forward-fill)* |
| **Sensirion SPS30** | UART / I2C | `pm1_0` (`pm1`), `pm2_5` (`pm25`), `pm4_0` (`pm4`), `pm10` | µg/m³ | `[0.0, 1000.0]` |
| **Sensirion SHT30/31** | I2C (`0x44`/`0x45`) | `temperature`, `humidity` | °C, %RH | `[0.0, 60.0]` °C, `[0.0, 100.0]` %RH |
| **ROHM BH1750 / VEML7700** | I2C (`0x23`/`0x10`) | `lux` | Lux | `[0.0, 65535.0]` |
| **ESP32 Wi-Fi Core** | Nội bộ | `wifi_rssi` (`wifiRssi`) | dBm | `[-100, 0]` (thường `-90` đến `-30`) |

> [!IMPORTANT]
> **Quy tắc Firmware bắt buộc**: (1) Không gửi giá trị lỗi giả (`-1`, `-999`, `0` dBA); nếu bus I2C/UART lỗi hãy bỏ qua field hoặc gửi `null`; (2) Kiểm tra `isnan()` / `isinf()` trước khi `serializeJson()` vì JSON chứa `NaN` bị Jackson drop toàn bộ gói; (3) Chu kỳ phát khuyến nghị `10s–30s` (tối đa $\le 60\text{s}$ để không kích hoạt Watchdog offline 120s).

---

## 2. Hợp Đồng MQTT Topics, Payloads & LWT

Broker Eclipse Mosquitto 2.0 lắng nghe trên cổng TCP `1883` (`QoS 1`, `Retain = false`).

### 2.1. Kênh Telemetry (`devices/{hardwareId}/telemetry`)
```json
{
  "hardware_id": "ESP32_ROOM_101",
  "timestamp": 1728543600000,
  "wifi_rssi": -58,
  "data": {
    "acoustics": { "noise_avg": 43.2, "noise_peak": 57.8 },
    "air_quality": { "pm1_0": 9.2, "pm2_5": 15.6, "pm4_0": 19.3, "pm10": 22.4 },
    "environment": { "temperature": 24.8, "humidity": 52.5, "lux": 460.0 }
  }
}
```
- `hardware_id` phải khớp 100% `{hardwareId}` trên topic (Anti-spoofing). `timestamp` nhận cả Epoch seconds (10 chữ số) và milliseconds (13 chữ số).

### 2.2. Kênh Trạng thái & Di chúc LWT (`devices/{hardwareId}/status`)
- **Bản tin chủ động khi khởi động**:
  ```json
  { "hardware_id": "ESP32_ROOM_101", "status": "online", "reason": "power_on", "firmware_version": "1.2.0", "uptime_seconds": 15, "timestamp": 1728543600000 }
  ```
- **Bản tin Di chúc LWT** (đăng ký trong `mqttClient.connect()`, `willQoS = 1`, `willRetain = false`):
  ```json
  { "hardware_id": "ESP32_ROOM_101", "status": "offline", "reason": "lwt" }
  ```
- **Kênh nhận lệnh (`devices/{hardwareId}/command`)**: Firmware `subscribe` sẵn khi kết nối để nhận lệnh OTA/cấu hình chu kỳ tương lai.

### 2.3. An Ninh Broker ACL & Firmware Mẫu (`PubSubClient` + `ArduinoJson` v7)
- Mosquitto [`acl.conf`](../mosquitto/config/acl.conf) cô lập từng thiết bị theo `username = hardwareId` (`%u`): chỉ được ghi `devices/%u/telemetry`, `devices/%u/status` và đọc `devices/%u/command`. Mật khẩu broker lưu dưới dạng PBKDF2/SHA512.
- Nếu kết nối qua REST dự phòng (`/api/v1/devices/authenticate`), mạch gửi `hardwareId + apiKey` để nhận Device JWT (8h).

```cpp
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <time.h>

const char* WIFI_SSID       = "Thuvien_TQB_IoT";
const char* WIFI_PASSWORD   = "<YOUR_WIFI_PASSWORD>";
const char* MQTT_BROKER_IP  = "192.168.1.100";
const char* HARDWARE_ID     = "ESP32_ROOM_101";
const char* MQTT_PASSWORD   = "<YOUR_MQTT_DEVICE_PASSWORD>";

WiFiClient espClient;
PubSubClient mqttClient(espClient);
String topicTelemetry = String("devices/") + HARDWARE_ID + "/telemetry";
String topicStatus    = String("devices/") + HARDWARE_ID + "/status";
String topicCommand   = String("devices/") + HARDWARE_ID + "/command";

bool isValidMetric(float v, float lo, float hi) { return !isnan(v) && !isinf(v) && v >= lo && v <= hi; }
int64_t epochMs() { struct timeval tv; gettimeofday(&tv, NULL); return (int64_t)tv.tv_sec * 1000LL + tv.tv_usec / 1000LL; }

void reconnectMqtt() {
  while (!mqttClient.connected()) {
    JsonDocument lwtDoc;
    lwtDoc["hardware_id"] = HARDWARE_ID; lwtDoc["status"] = "offline"; lwtDoc["reason"] = "lwt";
    char lwtBuf[128]; serializeJson(lwtDoc, lwtBuf);
    String cid = String("ESP32_") + HARDWARE_ID + "_" + String(random(0xffff), HEX);
    if (mqttClient.connect(cid.c_str(), HARDWARE_ID, MQTT_PASSWORD, topicStatus.c_str(), 1, false, lwtBuf)) {
      JsonDocument onDoc;
      onDoc["hardware_id"] = HARDWARE_ID; onDoc["status"] = "online"; onDoc["reason"] = "power_on";
      onDoc["firmware_version"] = "1.2.0"; onDoc["timestamp"] = epochMs();
      char onBuf[256]; serializeJson(onDoc, onBuf);
      mqttClient.publish(topicStatus.c_str(), onBuf, false);
      mqttClient.subscribe(topicCommand.c_str(), 1);
    } else { delay(5000); }
  }
}

void setup() {
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) delay(500);
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  mqttClient.setServer(MQTT_BROKER_IP, 1883);
  mqttClient.setBufferSize(512); // Bắt buộc >= 512 bytes cho JSON 9 chỉ số (PubSubClient mặc định 256)
  mqttClient.setKeepAlive(30);
}
```

---

## 3. Bộ Giả Lập Mạch Đo (`tools/iot-simulator/`)

Viết bằng **Node.js ($\ge 18$)** với 14 phòng và 23 thiết bị mẫu định nghĩa tại [`tools/iot-simulator/config/rooms.json`](../tools/iot-simulator/config/rooms.json):
- **Mô hình tín hiệu ([`signalModel.js`](../tools/iot-simulator/src/signalModel.js))**: Dao động hình sin ngày đêm 24h (đỉnh nhiệt 14:00, đáy 04:00), nhiễu trắng Gauss (biến đổi Box-Muller) và xung đột biến giờ cao điểm (`10:00–12:00`, `14:00–17:00`).
- **Rào an toàn ([`safety.js`](../tools/iot-simulator/src/safety.js))**: Chỉ cho phép kết nối broker nội bộ (`localhost`, `127.0.0.1`, `::1`, `host.docker.internal`, `*.local`) trừ khi truyền `--force-remote` hoặc `FORCE_REMOTE=true`.
- **Idempotent Provisioning (`npm run provision`)**: Gọi REST API tạo phòng, `boundaryPolygon`, `RoomType` và thiết bị khớp bản vẽ CAD mà không trùng lặp khi chạy lại.

### 3.1. Danh mục 10 Kịch bản Kiểm thử (`src/scenarios.js`)

| Tham số `--scenario` | Mô phỏng thực địa | Mục tiêu kiểm chứng phía Backend & UI |
| :--- | :--- | :--- |
| `normal` *(mặc định)* | Vi khí hậu ổn định theo chu kỳ ngày đêm | LCS đạt Platinum/Gold, không sinh cảnh báo |
| `noise-spike` | Ồn nền $> 68\text{ dBA}$ & đỉnh $> 82\text{ dBA}$ kéo dài | Kích hoạt Alert FSM (`NOISE_AVG` / `NOISE_PEAK`) |
| `pm25-high` | Bụi mịn $\text{PM}_{2.5}$ tăng lên `68–80 µg/m³` | Kích hoạt `PM2_5` `HIGH`, điểm LCS tụt theo Liebig |
| `heat/humid` | Nhiệt độ `35.5–36.5°C` và độ ẩm `85–88% RH` | Kích hoạt `TEMPERATURE` & `HUMIDITY_HIGH` (kho sách) |
| `device-dropout` | 1 trạm ngừng gửi tin $> 120\text{s}$ | Watchdog chuyển `OFFLINE` & sinh cảnh báo `DEVICE_OFFLINE` |
| `flap` | Liên tục đổi `online`/`offline` mỗi 2.5s | Kiểm chứng ổn định UI, không nhảy giật layout |
| `lwt` | Đóng socket TCP đột ngột không gửi `DISCONNECT` | Mosquitto tự phát LWT `reason: lwt` |
| `bad-payload` | Gửi `250°C`, `999 dBA`, số âm, `{}` hoặc sai `hardware_id` | Sanitizer kẹp/bỏ & Anti-spoofing drop tin |
| `burst` | Đẩy 100 bản tin trong 1 tick | Kiểm chứng `Semaphore(30, true)` và Conflation 1Hz |
| `demo` | Vòng lặp 24h hoàn chỉnh (kèm `--speed`) | Dùng cho container `aiot_simulator` & demo Kiosk/Floorplan |

*(Hướng dẫn lệnh chạy và biến môi trường xem tại [12-runbook.md](./12-runbook.md) và [`tools/iot-simulator/README.md`](../tools/iot-simulator/README.md).)*

---

**Đọc tiếp**: [04 — Ingestion & Cảnh báo](./04-ingestion-and-alerts.md) · [06 — Bảo mật & RBAC](./06-security-and-rbac.md) · [12 — Cẩm nang Vận hành](./12-runbook.md)
