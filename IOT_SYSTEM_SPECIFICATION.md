# TÀI LIỆU ĐẶC TẢ TÍCH HỢP HỆ THỐNG IoT: LISTEN_PROJECT
*(Dành cho đội ngũ phát triển Phần mềm: Backend, Frontend, Mobile & Quản trị hệ thống)*

---

## 1. TỔNG QUAN HỆ THỐNG (SYSTEM OVERVIEW)

Hệ thống **Listen_Project** là trạm đo lường môi trường thông minh (IoT Indoor Environmental & Acoustic Station), được thiết kế để giám sát tự động và liên tục chất lượng không gian kín (như thư viện, phòng học, phòng làm việc).

### 1.1. Kiến trúc tổng thể (Edge-to-Cloud Model)
```
┌─────────────────────────────────┐
│     TRẠM PHẦN CỨNG (EDGE)       │
│  ESP32-S3 + Micro I2S + SPS30   │
│  + Cảm biến Nhiệt/Ẩm/Ánh sáng   │
└────────────────┬────────────────┘
                 │ Wi-Fi (MQTT Protocol)
                 ▼
┌─────────────────────────────────┐
│      MQTT BROKER TRUNG GIAN     │
│  (Mosquitto / EMQX / HiveMQ)    │
└────────────────┬────────────────┘
                 │ Spring Integration MQTT
                 ▼
┌─────────────────────────────────┐
│         BACKEND SERVER          │
│        Java Spring Boot         │
│  • Rule Engine (Cảnh báo ngưỡng)│
│  • Xử lý & tổng hợp dữ liệu     │
└────────┬───────────────┬────────┘
         │               │ STOMP over WebSocket
         ▼               ▼
┌─────────────────┐  ┌───────────────────────────────────┐
│  CƠ SỞ DỮ LIỆU  │  │        FRONTEND WEB DASHBOARD         │
│  PostgreSQL +   │  │  • Heatmap phòng thời gian thực       │
│  TimescaleDB    │  │  • Biểu đồ lịch sử, CRUD Room & Sensor│
└─────────────────┘  └───────────────────────────────────┘
```

---

## 2. BẢN ĐỒ DỮ LIỆU PHẦN CỨNG (DATA DICTIONARY)

Các thông số mà trạm phần cứng thu thập và truyền tải:

| Tên trường (Field) | Đơn vị | Dải đo tiêu chuẩn | Cảm biến sinh dữ liệu | Ý nghĩa nghiệp vụ trên Phần mềm |
| :--- | :---: | :---: | :--- | :--- |
| `noise_avg` | dBA | 30 – 100 | Micro I2S (INMP441) | Mức cường độ âm trung bình (dùng để giám sát độ yên tĩnh). |
| `noise_peak` | dBA | 30 – 120 | Micro I2S (INMP441) | Mức ồn đỉnh tức thời (phát hiện tiếng la hét, va đập, kéo ghế). |
| `pm1_0` | $\mu\text{g/m}^3$ | 0 – 1000 | Sensirion SPS30 | Nồng độ hạt bụi siêu mịn PM1.0. |
| `pm2_5` | $\mu\text{g/m}^3$ | 0 – 1000 | Sensirion SPS30 | Nồng độ hạt bụi mịn PM2.5 (chỉ số đánh giá chất lượng không khí). |
| `pm4_0` | $\mu\text{g/m}^3$ | 0 – 1000 | Sensirion SPS30 | Nồng độ hạt bụi PM4.0. |
| `pm10` | $\mu\text{g/m}^3$ | 0 – 1000 | Sensirion SPS30 | Nồng độ hạt bụi thô PM10. |
| `temperature` | °C | -40 – 85 | SHT30 / BME280 (I2C) | Nhiệt độ môi trường phòng. |
| `humidity` | %RH | 0 – 100 | SHT30 / BME280 (I2C) | Độ ẩm tương đối không khí. |
| `lux` | Lux | 0 – 65535 | BH1750 (I2C - Tùy chọn) | Cường độ ánh sáng (đánh giá tiêu chuẩn chiếu sáng đọc sách). |

---

## 3. SƠ ĐỒ ÁNH XẠ CHÂN PHẦN CỨNG (HARDWARE PINOUT MAPPING)

Dành cho lập trình viên Firmware (ESP32-S3) và đối soát kỹ thuật:

* **Micro I2S (Cổng P2):**
  * `SD` (Serial Data) $\rightarrow$ **GPIO5**
  * `SCK` (Serial Clock) $\rightarrow$ **GPIO6**
  * `WS` (Word Select) $\rightarrow$ **GPIO7**
  * Nguồn: `3.3V` & `GND`
* **Cảm biến bụi Sensirion SPS30 (Cổng P5):**
  * `TX_SPS30` (ESP32 TX) $\rightarrow$ **GPIO17**
  * `RX_SPS30` (ESP32 RX) $\leftarrow$ **GPIO18** (đã qua cầu phân áp an toàn $2.2\text{k}\Omega / 3.3\text{k}\Omega$)
  * Nguồn: `5V` & `GND`
* **Bus Cảm biến môi trường I2C (Cổng P3 & P4):**
  * `SCL` $\rightarrow$ **GPIO10** (có trở kéo $4.7\text{k}\Omega$ lên 3.3V)
  * `SDA` $\rightarrow$ **GPIO11** (có trở kéo $4.7\text{k}\Omega$ lên 3.3V)
  * Nguồn: `3.3V` & `GND`
* **Cổng UART Debug / Flash (Cổng P1):**
  * `U0TXD` $\rightarrow$ **GPIO43** (chân RX trên header)
  * `U0RXD` $\rightarrow$ **GPIO44** (chân TX trên header)

---

## 4. ĐẶC TẢ GIAO THỨC TRUYỀN THÔNG (MQTT PROTOCOL SPECIFICATION)

### 4.1. Quy ước Topic MQTT
1. **Telemetry Topic (Thiết bị gửi dữ liệu định kỳ):**
   * Định dạng: `devices/{device_id}/telemetry`
   * Ví dụ: `devices/ESP32_ROOM_101/telemetry`
   * Tần suất gửi mặc định: `5000 ms` (5 giây/lần) hoặc `10000 ms` (10 giây/lần).
2. **Status Topic (Báo trạng thái Online / Offline):**
   * Định dạng: `devices/{device_id}/status`
   * Thiết bị cấu hình **MQTT LWT (Last Will and Testament)** với payload: `{"status": "offline"}`. Khi vừa kết nối gửi: `{"status": "online"}`.
3. **Configuration / Command Topic (Server điều khiển xuống trạm):**
   * Định dạng: `devices/{device_id}/cmd`
   * Ví dụ payload: `{"action": "set_interval", "interval_ms": 10000}` hoặc `{"action": "reboot"}`.

### 4.2. Mẫu Payload JSON Chuẩn (Telemetry JSON Payload)
```json
{
  "device_id": "ESP32_ROOM_101",
  "timestamp": 1728543600,
  "wifi_rssi": -65,
  "data": {
    "acoustics": {
      "noise_avg": 43.2,
      "noise_peak": 57.8
    },
    "air_quality": {
      "pm1_0": 9.2,
      "pm2_5": 15.6,
      "pm4_0": 19.3,
      "pm10": 22.4
    },
    "environment": {
      "temperature": 26.1,
      "humidity": 61.5,
      "lux": 380.0
    }
  }
}
```

---

## 5. Ý TƯỞNG THIẾT KẾ & PHÁT TRIỂN MODULE PHẦN MỀM

### 5.1. Module Bản đồ nhiệt tương tác (Interactive Floorplan Heatmap)
* **Ý tưởng cốt lõi:** Người quản lý thư viện mở Dashboard sẽ thấy ngay sơ đồ mặt bằng các tầng đọc sách dưới dạng bản đồ nhiệt trực quan.
* **Tính năng:**
  * **Chuyển đổi các lớp nhiệt (Layer Toggles):**
    * *Lớp Tiếng ồn (Noise Layer):* Màu xanh lá ($< 45\text{ dBA}$ - Im lặng), màu vàng cam ($45 - 55\text{ dBA}$ - Hơi ồn), màu đỏ ($> 55\text{ dBA}$ - Rất ồn, cần nhắc nhở).
    * *Lớp Bụi mịn (AQI Layer):* Hiển thị mật độ bụi PM2.5 theo ngưỡng an toàn của WHO.
    * *Lớp Nhiệt độ/Độ ẩm:* Giám sát vùng lạnh/nóng do điều hòa không đều.
  * **Click xem chi tiết (Detail Modal):** Nhấp vào vị trí trạm cảm biến bất kỳ trên mặt bằng để hiển thị pop-up biểu đồ trực tiếp.

### 5.2. Module Quản trị Phòng & Thiết bị (CRUD Rooms & Sensors)
* **Quản lý phòng (Room CRUD):**
  * Tên phòng, tầng, diện tích, sức chứa tối đa.
  * Tải lên ảnh sơ đồ mặt bằng phòng (Floor plan image: SVG/PNG).
  * Cấu hình ngưỡng cảnh báo riêng theo tính chất phòng (ví dụ: Phòng tự học im lặng đặt ngưỡng $45\text{ dBA}$, phòng thảo luận nhóm đặt $60\text{ dBA}$).
* **Quản lý thiết bị (Device CRUD & Placement):**
  * Khai báo `device_id`, tên trạm, ngày lắp đặt.
  * Gán thiết bị vào phòng cụ thể.
  * Kéo-thả (Drag & Drop) thiết bị lên ảnh sơ đồ để lưu tọa độ phần trăm $(x\%, y\%)$. Đây là cơ sở để thuật toán vẽ Heatmap định vị nguồn phát tán.

### 5.3. Module Cảnh báo thời gian thực (Real-time Rule & Alerting Engine)
* **Quy tắc cảnh báo thông minh:**
  * *Tiếng ồn kéo dài:* Phát hiện `noise_avg > 50 dBA` liên tục quá 30 giây (tránh báo động ảo do tiếng ho, tiếng lật sách ngẫu nhiên).
  * *Tiếng động đột ngột (Peak Noise):* `noise_peak > 75 dBA` (phát hiện va đập, ngã đồ vật).
  * *Ô nhiễm không khí:* $PM2.5 > 35\ \mu\text{g/m}^3$ kéo dài quá 5 phút.
* **Kênh truyền thông báo:**
  * Đẩy thông báo tức thời qua WebSocket lên thanh Notification của Web Dashboard.
  * Tích hợp Telegram Bot gửi tin nhắn kèm vị trí phòng đến bảo vệ / quản lý thư viện.

### 5.4. Module Đánh giá & Báo cáo (Analytics & Reporting)
* **Chỉ số Thoải mái Thư viện (Library Comfort Score):**
  * Xây dựng công thức tổng hợp từ 0 đến 100 điểm:
    $$\text{Score} = w_1 \cdot S_{noise} + w_2 \cdot S_{pm2.5} + w_3 \cdot S_{temp} + w_4 \cdot S_{lux}$$
* **Báo cáo phân tích:**
  * Bảng xếp hạng các phòng yên tĩnh nhất / ồn nhất trong tuần.
  * Biểu đồ phân bố tiếng ồn theo các khung giờ trong ngày (giúp bố trí nhân sự hỗ trợ).
  * Xuất file báo cáo thống kê định dạng Excel / PDF.

---

## 6. ĐỀ XUẤT TECH STACK & CƠ SỞ DỮ LIỆU PHÍA PHẦN MỀM

### 6.1. Backend Architecture (Spring Boot)
* **Framework:** Java Spring Boot 3.x.
* **IoT Adapter:** `spring-integration-mqtt` (Lắng nghe message từ MQTT Broker chuyển thành Java Application Event).
* **Real-time Push:** `spring-boot-starter-websocket` với giao thức STOMP.
* **Bảo mật & Phân quyền:** Spring Security + JWT (Phân quyền Admin, Quản lý thư viện, Khách xem công cộng).

### 6.2. Thiết kế Cơ sở dữ liệu (Database Schema)
* **Bảng Quan hệ (PostgreSQL / MySQL):**
  * `users (id, username, password, role)`
  * `rooms (id, name, floor, floorplan_url, noise_threshold, pm25_threshold)`
  * `devices (id, device_id, room_id, pos_x, pos_y, status, last_seen)`
  * `alerts (id, device_id, room_id, alert_type, message, value, created_at, is_resolved)`
* **Bảng Dữ liệu Thời gian (TimescaleDB / InfluxDB):**
  * `telemetry_data (time, device_id, noise_avg, noise_peak, pm1_0, pm2_5, pm4_0, pm10, temp, hum, lux)`

### 6.3. Frontend Web Dashboard
* **Framework:** React.js / Next.js hoặc Vue.js.
* **Vẽ bản đồ nhiệt (Heatmap):** `heatmap.js` hoặc Leaflet (với Custom Image Floorplan).
* **Đồ thị thời gian thực (Charts):** Apache ECharts hoặc Chart.js.
* **Giao diện:** Tailwind CSS / Ant Design / Shadcn UI.
