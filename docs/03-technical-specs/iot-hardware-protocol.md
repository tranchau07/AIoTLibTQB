# Đặc Tả Phần Cứng IoT & Giao Thức MQTT / IoT Hardware & MQTT Protocol Specification

> **Đối tượng đọc / Audience:** Kỹ sư Phần cứng / Firmware (ESP32-S3) & Kỹ sư Hệ thống IoT.  
> **Cơ sở kiểm chứng / Verified From:** [`MqttConfig.java`](../../src/main/java/com/example/AIoTLibTQB/configuration/MqttConfig.java), [`MqttMessageDispatcherService.java`](../../src/main/java/com/example/AIoTLibTQB/service/MqttMessageDispatcherService.java), [`TelemetrySanitizerService.java`](../../src/main/java/com/example/AIoTLibTQB/service/TelemetrySanitizerService.java), [`mosquitto.conf`](../../mosquitto/config/mosquitto.conf), [`acl.conf`](../../mosquitto/config/acl.conf), [`DeviceController.java`](../../src/main/java/com/example/AIoTLibTQB/controller/DeviceController.java).

---

## 1. Kiến Trúc Trạm Đo ESP32-S3 & Cụm 4 Cảm Biến / ESP32-S3 Node & Sensor Suite

**[VI]** Thông số phần cứng tham chiếu của trạm đo thực địa (khớp với dải kiểm định của [`TelemetrySanitizerService`](../../src/main/java/com/example/AIoTLibTQB/service/TelemetrySanitizerService.java)):  
**[EN]** Reference hardware specification for deployed ESP32-S3 nodes aligned with server-side physical validation bounds:

- **MCU**: ESP32-S3 (Dual-core Xtensa LX7 @ 240 MHz, Wi-Fi 2.4 GHz 802.11 b/g/n; khuyến nghị 8 MB Octal PSRAM nếu đệm offline store-and-forward).
- **Cụm 4 cảm biến & dải giá trị hợp lệ bắt buộc / 4-Sensor Suite & Valid Physical Bounds**:

| Cảm biến / Sensor | Giao tiếp / Bus | Trường JSON (`@JsonAlias`) | Đơn vị / Unit | Dải hợp lệ `[Min, Max]` | Quy tắc firmware / Firmware Rule |
| :--- | :--- | :--- | :---: | :---: | :--- |
| **INMP441** *(MEMS Mic)* | I2S DMA 24-bit | `noise` (`sound`, `db`, `dBA`) **hoặc** `noise_avg` (`noiseAvg`) + `noise_peak` (`noisePeak`) | `dBA` | `noise`: `[30.0, 130.0]`<br>`noiseAvg`: `[30.0, 110.0]`<br>`noisePeak`: `[30.0, 130.0]` | **Cấm gửi `0`**. Gửi `noise` tức thời thì Server tự tính `noiseAvg` cửa sổ trượt `30s` (trần `110.0`) & `noisePeak`; `noise_peak` không bao giờ được forward-fill. |
| **Sensirion SPS30** | UART / I2C | `pm1_0` (`pm1`), `pm2_5` (`pm25`), `pm4_0` (`pm4`), `pm10` | `µg/m³` | `[0.0, 1000.0]` | Không gửi mã lỗi âm (`-1`). |
| **Sensirion SHT30/31** | I2C (`0x44`/`0x45`) | `temperature`, `humidity` | `°C`, `%RH` | `[0.0, 60.0]` °C<br>`[0.0, 100.0]` %RH | Đổi về độ C; gửi %RH thang `0–100` (không gửi `0.0–1.0`). |
| **ROHM BH1750 / VEML7700** | I2C (`0x23`/`0x10`) | `lux` | `Lux` | `[0.0, 65535.0]` | Loại bỏ giá trị tràn thanh ghi lỗi cảm biến trước khi gửi. |
| **ESP32 Wi-Fi Core** | Internal | `wifi_rssi` (`wifiRssi`) | `dBm` | Số nguyên âm (vd `-58`) | Phản ánh chất lượng sóng trên bản đồ heatmap `wifiRssi`. |

---

## 2. Kết Nối MQTT Broker, ACL & Quy Tắc Chống Giả Mạo / MQTT Broker, ACL & Anti-Spoofing

| Tham số / Parameter | Giá trị bắt buộc / Required Value | Chi tiết kỹ thuật / Technical Notes |
| :--- | :--- | :--- |
| **Protocol & Port** | **MQTT v3.1.1 over TCP :1883** | Không bật ẩn danh (`allow_anonymous false`). Giới hạn `max_packet_size 65536`, `max_connections 200`, `max_keepalive 300` ([`mosquitto.conf`](../../mosquitto/config/mosquitto.conf)). |
| **Authentication & ACL** | `username = <hardwareId>` | [`acl.conf`](../../mosquitto/config/acl.conf): thiết bị bị cô lập chặt: chỉ `write devices/%u/telemetry`, `write devices/%u/status`, `read devices/%u/command`. |
| **Client ID** | Duy nhất mỗi trạm (vd `node_<hardwareId>`) | Tránh 2 mạch đá phiên nhau khỏi Broker. |
| **QoS, Retain & Keep-Alive** | `QoS = 1`, `retain = false`, `keepalive = 30s` | Không bật `retain` để tránh phát lại gói tin cũ khi backend kết nối lại. |
| **Anti-Spoofing** | `topic.{hardwareId} === payload.hardware_id` | Server từ chối gói tin nếu `hardware_id` trong JSON lệch với `{hardwareId}` trên topic (kể cả hoa/thường). |
| **Auto-Discovery** | Plug-and-Play (cache 10 phút) | Mạch mới cắm điện phát MQTT sẽ hiện tại `GET /api/v1/devices/discovered` để Admin/Thủ thư gán phòng trên UI. |

---

## 3. Hợp Đồng JSON Payloads & Chuẩn Thời Gian / JSON Payloads & Timestamps

### 3.1. Telemetry (`devices/{hardwareId}/telemetry`)
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
- **Quy tắc Payload**: Bắt buộc bọc trong object `"data"` và có ít nhất 1 chỉ số hợp lệ; không gửi `NaN` / `Infinity` hoặc mã lỗi giả (`-1`, `-999`, `0 dBA`). Nếu 1 cảm biến hỏng tạm thời, bỏ qua key đó — server có bộ đệm **Forward-fill 30s** cho các trường trừ `noise_peak`.
- **`timestamp`**: Chuẩn Unix Epoch UTC — tự nhận diện **10 chữ số (giây)** hoặc **13 chữ số (mili-giây)**; nếu chưa đồng bộ NTP có thể bỏ qua trường này để Server gắn `Instant.now()`.
- **Chu kỳ gửi khuyến nghị**: Phát đều đặn (`0.5s` – `30s`, tối đa `<= 60s`) để không kích hoạt Watchdog offline (`> 120s`).

### 3.2. Status & Last Will and Testament (`devices/{hardwareId}/status`)
- **Khi kết nối thành công (`online`)**:
  ```json
  {
    "hardware_id": "ESP32_ROOM_101",
    "status": "online",
    "reason": "power_on",
    "firmware_version": "1.2.0",
    "uptime_seconds": 15,
    "timestamp": 1728543600000
  }
  ```
- **LWT (`offline`)** *(đăng ký trong `mqtt.connect()`, Will QoS `1`, Will Retain `false`)*:
  ```json
  { "hardware_id": "ESP32_ROOM_101", "status": "offline", "reason": "lwt" }
  ```
- **Command (`devices/{hardwareId}/command`)**: Khuyến nghị firmware `subscribe` kênh này khi kết nối để sẵn sàng cho điều khiển/OTA mở rộng.

---

## 4. REST API Dự Phòng & Mẫu Firmware ESP32 / HTTP Fallback & ESP32 Reference Snippet

- **Xác thực & Heartbeat qua HTTP** (dành cho kịch bản cần lấy Device JWT `8h`):
  - `POST /api/v1/devices/authenticate` với body `{"hardwareId": "...", "apiKey": "..."}` → trả JWT có `scope = "DEVICE WRITE_SENSOR_DATA"`.
  - `POST /api/v1/devices/{id}/heartbeat` kèm `Authorization: Bearer <DEVICE_JWT>`.

```cpp
// BẮT BUỘC với Arduino PubSubClient: gói JSON telemetry dài ~280-330 bytes,
// vượt quá mức mặc định 256 bytes nên phải tăng buffer tối thiểu 512 bytes.
mqttClient.setServer(MQTT_BROKER_IP, 1883);
mqttClient.setKeepAlive(30);
mqttClient.setBufferSize(512);
```

### Checklist 5 Lỗi Firmware Hay Gặp / Top 5 Hardware Integration Pitfalls
1. **Quên `mqttClient.setBufferSize(512)`**: `status` gửi được nhưng `telemetry` bị rớt âm thầm (`publish()` trả `false`).
2. **Lệch chữ hoa/thường `hardware_id` giữa Topic và JSON**: Bị `MqttMessageDispatcherService` chặn vì Anti-Spoofing.
3. **Gửi `0` dBA cho `noise_avg` / `noise_peak`**: Nằm dưới sàn `30.0 dBA` nên bị `TelemetrySanitizerService` loại bỏ.
4. **Gửi JSON phẳng không có `"data"` wrapper**: Bị coi là bản tin rỗng.
5. **Mạch chưa được duyệt từ Auto-Discovery**: Tin đến Broker nhưng chưa vào phòng đọc cho đến khi Admin/Thủ thư đăng ký tại `/admin/devices/discovery`.
