# BẢN KẾ HOẠCH CHI TIẾT TRIỂN KHAI PHẦN MỀM HỆ THỐNG IoT
# LISTEN_PROJECT (AIoTLibTQB) - PHIÊN BẢN CHUẨN HÓA TOÀN DIỆN
### Hệ thống Trạm Đo Môi Trường & Giám sát Âm học Thông minh Trong Nhà (Smart Indoor Environmental & Acoustic Station)
*(Tích hợp trạm phần cứng ESP32-S3 + Micro I2S INMP441 + Bụi Sensirion SPS30 + SHT30/BME280 + BH1750)*

---

* **Mã hiệu tài liệu:** `PLAN-AIOT-LIB-2026-V1.1-FINAL`
* **Tình trạng văn bản:** **CHÍNH THỨC (Approved for Implementation)**
* **Hệ thống Backend tham chiếu:** `AIoTLibTQB` (Spring Boot 3.5.8, Java 21, MongoDB 8.0)
* **Thời điểm cập nhật:** Tháng 10 năm 2026
* **Các tiêu chuẩn đối soát:** EU ALDREN TAIL, ASHRAE 55-2020, WHO 2021 Air Quality, ANSI/ASA S12.60, WELL Building Standard v2, Nghị định 13/2023/NĐ-CP

---

## MỤC LỤC

1. [TỔNG QUAN HỆ THỐNG & ĐỐI CHIẾU HIỆN TRẠNG](#1-tổng-quan-hệ-thống--đối-chiếu-hiện-trạng)
2. [BẢO MẬT TOÀN DIỆN: MQTT BROKER & STOMP WEBSOCKET (1a & WebSocket)](#2-bảo-mật-toàn-diện-mqtt-broker--stomp-websocket-1a--websocket)
3. [CHUẨN HÓA TOÁN HỌC & SỬA LỖI CÔNG THỨC LCS (1b, 1c, 1d)](#3-chuẩn-hóa-toán-học--sửa-lỗi-công-thức-lcs-1b-1c-1d)
4. [THỐNG NHẤT TRẠNG THÁI TÀI LIỆU & CƠ CHẾ OFFLINE HAI TẦNG (1e, 1f)](#4-thống-nhất-trạng-thái-tài-liệu--cơ-chế-offline-hai-tầng-1e-1f)
5. [ĐẶC TẢ PAYLOAD CHUẨN, XỬ LÝ DỮ LIỆU THIẾU & QUẢN LÝ CẢNH BÁO](#5-đặc-tả-payload-chuẩn-xử-lý-dữ-liệu-thiếu--quản-lý-cảnh-báo)
6. [QUYỀN RIÊNG TƯ ÂM HỌC & TIÊU CHÍ NGHIỆM THU ĐỊNH LƯỢNG (DoD)](#6-quyền-riêng-tư-âm-học--tiêu-chí-nghiệm-thu-định-lượng-dod)
7. [LỘ TRÌNH 4 GIAI ĐOẠN TRIỂN KHAI VÀ CHECKLIST MÃ NGUỒN](#7-lộ-trình-4-giai-đoạn-triển-khai-và-checklist-mã-nguồn)

---

## 1. TỔNG QUAN HỆ THỐNG & ĐỐI CHIẾU HIỆN TRẠNG

### 1.1. Hiện trạng Backend đã có trong `AIoTLibTQB`
- **IAM vững chắc:** Phân quyền RBAC/ABAC (`ADMIN`, `LIBRARIAN`, `ZONE_MANAGER`, `MAINTENANCE`, `DEVICE`), Access Token (1h) & Refresh Token Rotation (24h) qua Nimbus JWT HMAC-SHA512, RateLimitFilter (Bucket4j + Caffeine).
- **Quản lý thiết bị:** Đăng ký thiết bị tập trung, sinh `rawApiKey`, băm BCrypt lưu `apiKeyHash`, thiết bị xác thực qua `POST /api/v1/devices/authenticate` nhận JWT `DEVICE`, heartbeat, CRUD, `assignedZones`.
- **Cơ sở dữ liệu:** Đang vận hành **MongoDB 8.0** trong Docker container.

### 1.2. Quyết định Kiến trúc Tinh chỉnh
- **Hạ tầng Ingestion:** Bổ sung **Eclipse Mosquitto 2.0** vào `docker-compose.yml`, tích hợp `spring-integration-mqtt`.
- **Lưu trữ Time-Series:** **Sử dụng MongoDB 8.0 Time Series Collections native** (loại bỏ hoàn toàn đề xuất dùng thêm TimescaleDB để tránh phức tạp hóa hạ tầng).
- **Mặt bằng & Cảm biến:** Mở rộng Document `Room` (lưu `boundaryPolygon` đa giác tường), bổ sung tọa độ chuẩn hóa $(posX, posY \in [0.0, 1.0])$ vào `Device`.

---

## 2. BẢO MẬT TOÀN DIỆN: MQTT BROKER & STOMP WEBSOCKET (1a & WebSocket)

### 2.1. Bảo mật MQTT Broker (Mosquitto 2.0 - Khắc phục 1a)
*Cảnh báo an toàn:* Tuyệt đối **KHÔNG sử dụng `allow_anonymous true`** trên môi trường triển khai thực tế. Cấu hình bảo mật bắt buộc:

1. **Khóa truy cập nặc danh:** `allow_anonymous false`.
2. **Xác thực Thiết bị (Authentication Mechanism):**
   * Thiết bị ESP32-S3 gửi thông tin trong gói `MQTT CONNECT`:
     * `Username` = `hardwareId` (ví dụ: `ESP32_ROOM_101`).
     * `Password` = `rawApiKey` (mã bí mật 32 ký tự hex được cấp khi đăng ký).
   * **Cơ chế xác thực Ủy quyền (Mosquitto Auth Plugin / Go-Auth Webhook):** Mosquitto gọi HTTP POST nội bộ về Backend `http://backend:8080/api/v1/devices/authenticate` để xác minh với hash BCrypt trong MongoDB.
3. **Phân quyền Kênh truyền (Topic-level ACL):**
   * Trạm đo chỉ được phép PUBLISH vào topic riêng của mình: `devices/{hardwareId}/telemetry` và `devices/{hardwareId}/status`.
   * Trạm đo chỉ được phép SUBSCRIBE vào kênh nhận lệnh của chính nó: `devices/{hardwareId}/cmd`.
   * Trạm đo bị cấm tuyệt đối lắng nghe dữ liệu của các trạm khác.
   * Service Ingestion của Backend sử dụng tài khoản Superuser riêng biệt có quyền SUBSCRIBE wildcard `devices/+/telemetry`, `devices/+/status`.
4. **Mã hóa đường truyền (Transport Security):** Khi triển khai ngoài mạng LAN bệnh viện/thư viện, kích hoạt cổng MQTTS `8883` với TLS 1.3.

### 2.2. Bảo mật STOMP over WebSocket
1. **Xác thực kết nối (Handshake & Connect Authentication):**
   * Endpoint WebSocket: `/ws-aiot`.
   * Client trình duyệt khi gửi STOMP frame `CONNECT` bắt buộc đính kèm header:
     `Authorization: Bearer <JWT_ACCESS_TOKEN>`.
   * Đăng ký Spring `ChannelInterceptor` trên `clientInboundChannel`:
     ```java
     @Override
     public Message<?> preSend(Message<?> message, MessageChannel channel) {
         StompHeaderAccessor accessor = MessageHeaderAccessor.getAccessor(message, StompHeaderAccessor.class);
         if (StompCommand.CONNECT.equals(accessor.getCommand())) {
             String authHeader = accessor.getFirstNativeHeader("Authorization");
             if (authHeader == null || !authHeader.startsWith("Bearer ")) {
                 throw new AppException(ErrorCode.UNAUTHENTICATED);
             }
             String token = authHeader.substring(7);
             Jwt jwt = customJwtDecoder.decode(token); // Verify HMAC-512 & Blacklist
             Authentication auth = authenticationConverter.convert(jwt);
             accessor.setUser(auth);
         }
         return message;
     }
     ```
2. **Ủy quyền Đăng ký Chủ đề (Subscription Authorization):**
   * Kênh `/topic/rooms/{roomId}/**`: Kiểm tra quyền hạn của user. Nếu mang role `ZONE_MANAGER`, kiểm tra `roomId \in user.assignedZones`. Từ chối đăng ký (Ném AccessDenied) nếu vi phạm.
   * Kênh `/topic/alerts`: Chỉ cho phép `ADMIN`, `LIBRARIAN`, `ZONE_MANAGER`.
   * Người dùng vãng lai (khách đọc sách) chỉ được phép SUBSCRIBE kênh công cộng hiển thị điểm tiện nghi `/topic/rooms/{roomId}/comfort`.

---

## 3. CHUẨN HÓA TOÁN HỌC & SỬA LỖI CÔNG THỨC LCS (1b, 1c, 1d)

### 3.1. Sửa lỗi Tính liên tục và Đơn điệu của các Hàm Điểm Thành phần (1b)
Bốn hàm thành phần $S_i \in [0, 100]$ được chuẩn hóa liên tục $C^0$ trên toàn miền giá trị:

#### A. Hàm Điểm Tiện nghi Âm học ($S_{acoustic}$ - Tiêu chuẩn ANSI/ASA S12.60 & WHO)
Dựa trên mức ồn trung bình $L_{avg}$ và mức ồn đỉnh tức thời $L_{peak}$ (dBA):
$$S_{acoustic\_base}(L_{avg}) = \begin{cases} 
100 & \text{khi } L_{avg} \le 35\text{ dBA} \\ 
100 - 2 \cdot (L_{avg} - 35) & \text{khi } 35 < L_{avg} \le 45 \quad (\text{tại } 45 \Rightarrow 80) \\ 
80 - 4 \cdot (L_{avg} - 45) & \text{khi } 45 < L_{avg} \le 55 \quad (\text{tại } 55 \Rightarrow 40) \\ 
40 - 2 \cdot (L_{avg} - 55) & \text{khi } 55 < L_{avg} \le 70 \quad (\text{tại } 70 \Rightarrow 10) \\ 
\max\left(0,\; 10 - 1.0 \cdot (L_{avg} - 70)\right) & \text{khi } 70 < L_{avg} \le 80 \quad (\text{tại } 80 \Rightarrow 0) \\
0 & \text{khi } L_{avg} > 80\text{ dBA}
\end{cases}$$

*Phạt xung âm va đập tức thời ($L_{peak} > 70\text{ dBA}$):*
$$\Delta_{peak} = \begin{cases} 
0 & \text{khi } L_{peak} \le 70\text{ dBA} \\ 
20 \cdot \frac{L_{peak} - 70}{20} & \text{khi } 70 < L_{peak} \le 90 \quad (\text{tối đa phạt 20 điểm}) \\ 
20 & \text{khi } L_{peak} > 90\text{ dBA} 
\end{cases}$$

$$\mathbf{S_{acoustic} = \max\left(0,\; S_{acoustic\_base} - \Delta_{peak}\right)}$$

#### B. Hàm Điểm Bụi mịn PM2.5 ($S_{air}$ - Tiêu chuẩn WHO 2021 & US EPA)
$$S_{air}(PM2.5) = \begin{cases} 
100 & \text{khi } PM2.5 \le 10\ \mu\text{g/m}^3 \quad (\text{WELL Enhanced}) \\ 
100 - 3 \cdot (PM2.5 - 10) & \text{khi } 10 < PM2.5 \le 15 \quad (\text{tại } 15 \Rightarrow 85\text{ - WHO 2021}) \\ 
85 - 1.25 \cdot (PM2.5 - 15) & \text{khi } 15 < PM2.5 \le 35 \quad (\text{tại } 35 \Rightarrow 60\text{ - EPA Moderate}) \\ 
60 - 1.5 \cdot (PM2.5 - 35) & \text{khi } 35 < PM2.5 \le 55 \quad (\text{tại } 55 \Rightarrow 30) \\ 
\max\left(0,\; 30 - 30 \cdot \frac{PM2.5 - 55}{45}\right) & \text{khi } 55 < PM2.5 \le 100 \quad (\text{tại } 100 \Rightarrow 0) \\ 
0 & \text{khi } PM2.5 > 100\ \mu\text{g/m}^3 
\end{cases}$$

#### C. Hàm Điểm Tiện nghi Nhiệt Ẩm ($S_{thermal}$ - Tiêu chuẩn ASHRAE 55-2020)
Khắc phục lỗi trước đây (phạt bậc hai quá dốc gây điểm âm), chuẩn hóa phạt tuyến tính êm dịu:
- **Điểm nhiệt độ ($S_T$):** Vùng tối ưu $23.5^\circ\text{C} - 25.5^\circ\text{C}$; ngoài vùng phạt $8\text{ điểm}/^\circ\text{C}$:
  $$S_T(Temp) = \begin{cases} 
  100 & \text{khi } 23.5 \le Temp \le 25.5^\circ\text{C} \\ 
  \max\left(0,\; 100 - 8 \cdot (23.5 - Temp)\right) & \text{khi } Temp < 23.5^\circ\text{C} \\ 
  \max\left(0,\; 100 - 8 \cdot (Temp - 25.5)\right) & \text{khi } Temp > 25.5^\circ\text{C} 
  \end{cases}$$
- **Điểm độ ẩm ($S_{RH}$):** Vùng tối ưu $40\% - 60\%$:
  $$S_{RH}(Hum) = \begin{cases} 
  100 & \text{khi } 40\% \le Hum \le 60\% \\ 
  \max\left(0,\; 100 - 2 \cdot (40 - Hum)\right) & \text{khi } Hum < 40\% \\ 
  \max\left(0,\; 100 - 2 \cdot (Hum - 60)\right) & \text{khi } Hum > 60\% 
  \end{cases}$$
- **Điểm nhiệt ẩm tổng hợp:**
  $$\mathbf{S_{thermal} = 0.70 \cdot S_T + 0.30 \cdot S_{RH}}$$

#### D. Hàm Điểm Chiếu sáng Bàn đọc ($S_{light}$ - Tiêu chuẩn EN 12464-1 & TCVN 7114)
Chuẩn chiếu sáng đọc sách là $500\text{ Lux}$ (dải tốt $400 - 600\text{ Lux}$):
$$S_{light}(Lux) = \begin{cases} 
\max\left(0,\; 40 \cdot \frac{Lux}{150}\right) & \text{khi } Lux < 150 \\ 
40 + 45 \cdot \frac{Lux - 150}{150} & \text{khi } 150 \le Lux < 300 \quad (\text{tại } 300 \Rightarrow 85) \\ 
85 + 15 \cdot \frac{Lux - 300}{100} & \text{khi } 300 \le Lux < 400 \quad (\text{tại } 400 \Rightarrow 100) \\ 
100 & \text{khi } 400 \le Lux \le 600 \\ 
100 - 15 \cdot \frac{Lux - 600}{200} & \text{khi } 600 < Lux \le 800 \quad (\text{tại } 800 \Rightarrow 85) \\ 
85 - 45 \cdot \frac{Lux - 800}{400} & \text{khi } 800 < Lux \le 1200 \quad (\text{tại } 1200 \Rightarrow 40) \\ 
\max\left(0,\; 40 - 40 \cdot \frac{Lux - 1200}{800}\right) & \text{khi } Lux > 1200 
\end{cases}$$

### 3.2. Thống nhất Bộ Trọng số Duy nhất (1c)
Thống nhất duy nhất một bộ trọng số phản ánh đúng đặc thù không gian thư viện / phòng học:
$$\mathbf{w_{acoustic} = 0.35, \quad w_{air} = 0.30, \quad w_{thermal} = 0.20, \quad w_{light} = 0.15} \quad (\sum w_i = 1.00)$$
*Giải trình:* Âm học ($35\%$) và chất lượng không khí ($30\%$) quyết định $65\%$ năng lực tập trung nhận thức của người đọc sách. Nhiệt độ ($20\%$) và ánh sáng ($15\%$) là điều kiện nền tảng sinh lý.

### 3.3. Sửa lỗi Công thức Chặn trần Liebig's Bottleneck Penalty (1d)
*Khắc phục lỗi trước đây:* Bản thảo trước viết $S_{cap} = \min(S_i) + 25$, dẫn đến sai lệch khi $\min(S_i) = 0$ thì điểm vẫn được $25$.

*Công thức chuẩn xác về mặt toán học (Non-linear Gating Formula):*
$$S_{weighted} = 0.35 \cdot S_{acoustic} + 0.30 \cdot S_{air} + 0.20 \cdot S_{thermal} + 0.15 \cdot S_{light}$$
$$S_{min} = \min\left(S_{acoustic},\; S_{air},\; S_{thermal},\; S_{light}\right)$$
$$\mathbf{LCS = S_{weighted} \cdot \left[ 0.30 + 0.70 \cdot \left(\frac{S_{min}}{100}\right) \right]}$$

*Kiểm chứng toán học:*
- Khi tất cả đạt 100 điểm ($S_{min} = 100$): $LCS = 100 \cdot [0.30 + 0.70 \cdot 1.0] = \mathbf{100.0}$.
- Khi có 1 yếu tố vi phạm thảm họa ($S_{min} = 0$): $LCS = S_{weighted} \cdot 0.30 \le \mathbf{30.0}$ (rơi ngay xuống hạng Kém/Báo động).
- Nếu yếu tố bị 0 điểm là Tiếng ồn ($S_{acoustic} = 0$): $S_{weighted} \le 65 \Rightarrow LCS \le 65 \cdot 0.30 \approx \mathbf{19.5}$ (Hạng Nguy cấp - Critical).

---

## 4. THỐNG NHẤT TRẠNG THÁI TÀI LIỆU & CƠ CHẾ OFFLINE HAI TẦNG (1e, 1f)

### 4.1. Thống nhất Trạng thái Tài liệu (1e)
- Tài liệu `IOT_SYSTEM_SPECIFICATION.md` ban đầu là bản **Đặc tả Sơ bộ Phần cứng (Hardware Integration Draft v1.0)**.
- Tài liệu `KE_HOACH_TRIEN_KHAI_PHAN_MEM_IOT.md` hiện tại là bản **Kế hoạch Triển khai & Đặc tả Kiến trúc Chi tiết Chính thức (v1.1 - Approved)**.
- **Thống nhất hạ tầng CSDL:** Triển khai **MongoDB 8.0 Time Series Collections native** trong file `docker-compose.yml`, không dùng TimescaleDB.

### 4.2. Cơ chế Offline Hai Tầng Thống nhất (1f)
Giải quyết dứt điểm mâu thuẫn giữa "MQTT LWT 1 giây" và "Heartbeat 5 phút":

```
                        ┌──────────────────────────────────────────────┐
                        │          TRẠM CẢM BIẾN (ESP32-S3)            │
                        └──────────────┬───────────────────────────────┘
                                       │
            ┌──────────────────────────┴──────────────────────────┐
            │ Mất nguồn / Đứt Wi-Fi                               │ Socket bị treo (Half-open)
            ▼                                                     ▼
┌──────────────────────────────────────┐              ┌──────────────────────────────────────┐
│  TẦNG 1: EVENT-DRIVEN (MQTT LWT)     │              │  TẦNG 2: POLLING WATCHDOG JOB        │
│  • Mosquitto phát hiện đứt kết nối   │              │  • Scheduled Task chạy mỗi 10 giây   │
│  • Broker tự động bắn LWT message:   │              │  • Kiểm tra (now - lastSeenAt) > 30s │
│    Topic: devices/{id}/status        │              │  • Chuyển trạng thái: OFFLINE        │
│    Payload: {"status":"offline"}     │              │  • Phát sinh Alert: DEVICE_OFFLINE   │
│  • Thời gian đáp ứng: ≤ 1.5 GIÂY     │              │  • Thời gian đáp ứng: 30 GIÂY        │
└──────────────────────────────────────┘              └──────────────────────────────────────┘
```

* **Tầng 1 (Tức thời - Event-driven via MQTT LWT):**
  * ESP32 khi kết nối gửi cờ LWT: Topic `devices/{hardwareId}/status`, payload `{"status":"offline","reason":"connection_lost"}`, QoS 1, Retain = true.
  * Ngay khi đứt kết nối TCP, Mosquitto phát hiện và broadcast gói tin trong vòng **1.0 – 1.5 giây**. Backend cập nhật ngay lập tức `device.online = false`.
* **Tầng 2 (Dự phòng - Watchdog Scheduler cho lỗi Half-open TCP):**
  * Rút ngắn ngưỡng timeout từ 5 phút xuống **30 giây** (vì thiết bị gửi chu kỳ 5–10s, quá 30s tương đương mất 3 chu kỳ liên tiếp).
  * Backend scheduler chạy chu kỳ 10 giây: Nếu `now - lastSeenAt > 30s` mà thiết bị chưa nhận được event LWT, hệ thống chủ động đánh dấu `OFFLINE` và tạo cảnh báo `DEVICE_OFFLINE`.

---

## 5. ĐẶC TẢ PAYLOAD CHUẨN, XỬ LÝ DỮ LIỆU THIẾU & QUẢN LÝ CẢNH BÁO

### 5.1. Đặc tả Chi tiết các Mẫu Payload JSON

#### 1. Telemetry Payload (Thiết bị $\rightarrow$ MQTT Topic `devices/{hardwareId}/telemetry`)
```json
{
  "hardware_id": "ESP32_ROOM_101",
  "timestamp": 1728543600,
  "wifi_rssi": -65,
  "data": {
    "acoustics": {
      "noise_avg": 42.5,
      "noise_peak": 58.1
    },
    "air_quality": {
      "pm1_0": 8.4,
      "pm2_5": 12.8,
      "pm4_0": 16.2,
      "pm10": 19.5
    },
    "environment": {
      "temperature": 24.8,
      "humidity": 52.3,
      "lux": 485.0
    }
  }
}
```

#### 2. Status Payload (Thiết bị $\rightarrow$ MQTT Topic `devices/{hardwareId}/status` & LWT)
```json
{
  "hardware_id": "ESP32_ROOM_101",
  "status": "online",
  "reason": "boot_complete",
  "firmware_version": "v1.2.0",
  "uptime_seconds": 3600,
  "timestamp": 1728543600
}
```

#### 3. Command Payload (Server $\rightarrow$ MQTT Topic `devices/{hardwareId}/cmd`)
```json
{
  "action": "trigger_auto_clean",
  "duration_seconds": 10,
  "timestamp": 1728543600
}
```

#### 4. WebSocket Broadcast Payload (Server $\rightarrow$ Client STOMP `/topic/rooms/{roomId}/telemetry`)
```json
{
  "room_id": "6708f1c8a1b2c3d4e5f60001",
  "timestamp": 1728543600,
  "comfort_score": {
    "overall": 91.2,
    "grade": "Platinum",
    "acoustic_score": 85.0,
    "air_score": 93.6,
    "thermal_score": 98.4,
    "light_score": 100.0
  },
  "metrics": {
    "noise_avg": 42.5,
    "noise_peak": 58.1,
    "pm2_5": 12.8,
    "temperature": 24.8,
    "humidity": 52.3,
    "lux": 485.0
  },
  "active_sensors_count": 3
}
```

### 5.2. Xử lý Dữ liệu Thiếu & Giá trị Dị thường (Missing & Anomalous Data)
1. **Lọc Giá trị Ngoại lai (Out-of-Bounds Validation):**
   * $noise\_avg \notin [30, 110]\text{ dBA}$ hoặc $noise\_peak \notin [30, 130]\text{ dBA}$ $\rightarrow$ Đánh dấu `CORRUPTED`, ghi log cảnh báo micro.
   * $temperature \notin [0, 60]^\circ\text{C}$ hoặc $humidity \notin [0, 100]\%$ $\rightarrow$ Bỏ qua giá trị ngoại lai.
2. **Cảm biến cục bộ bị lỗi (Sensor Fault Isolation):**
   * Nếu cảm biến SHT30 trả về `null` do kẹt bus I2C trong khi Micro và SPS30 vẫn hoạt động:
     * Hệ thống **không từ chối cả gói tin**.
     * Áp dụng cơ chế **Forward-Fill** (sử dụng giá trị hợp lệ gần nhất trong vòng tối đa $30\text{ giây}$).
     * Nếu mất dữ liệu quá $30\text{ giây}$, tính điểm $LCS$ dựa trên các thành phần còn lại (điều chỉnh tổng trọng số về $1.0$) và sinh cảnh báo bảo trì thiết bị `MAINTENANCE_REQUIRED`.

### 5.3. Máy Trạng thái Cảnh báo (Alert State Machine)

```
[Mức bình thường] ──(Vượt ngưỡng)──► [PENDING: Đếm cửa sổ 30s]
                                            │
               ┌────────────────────────────┴────────────────────────────┐
               │ Sau 30s vẫn vượt ngưỡng                                 │ Giảm dưới ngưỡng trước 30s
               ▼                                                         ▼
       [FIRING: Bắn Alert]                                      [Hủy PENDING: Báo động giả]
               │
               ├──► (Admin/Librarian bấm Xác nhận) ──► [ACKNOWLEDGED]
               │                                            │
               ▼                                            ▼
       [RESOLVED: Tự phục hồi khi giá trị < (Ngưỡng - 3 dBA) liên tục 60 giây]
```

1. **Bộ lọc Trung vị (Moving Median 5 mẫu):** Áp dụng cho chuỗi `noise_avg` trước khi so ngưỡng nhằm triệt tiêu tiếng ho, lật sách hoặc tiếng đóng nắp bút ngẫu nhiên.
2. **Trễ ngưỡng (Hysteresis):** Ngưỡng bật cảnh báo $50\text{ dBA}$; ngưỡng tự giải tỏa $47\text{ dBA}$ duy trì tối thiểu $60\text{ giây}$ để chống hiện tượng rung bật tắt chuông liên tục (Alert Flapping).

---

## 6. QUYỀN RIÊNG TƯ ÂM HỌC & TIÊU CHÍ NGHIỆM THU ĐỊNH LƯỢNG (DoD)

### 6.1. Bảo vệ Quyền Riêng tư Âm học (Edge Privacy by Design)
Trong môi trường thư viện và cơ quan, việc lắp đặt trạm đo có micro thường gây lo ngại về thu âm lén. Dự án xác lập cam kết kiến trúc cứng:

* **Không lưu trữ tệp âm thanh (Zero Audio Storage):** Mạch phần cứng ESP32-S3 không có thẻ nhớ và không lưu tệp WAV/MP3/PCM nào.
* **Xử lý Biên Tức thời (Instant Edge Processing):** Buffer mẫu âm thanh từ cổng I2S của micro INMP441 được chuyển trực tiếp vào bộ tính toán căn quân phương (RMS) trong RAM chip và **bị xóa sạch (zero-out) ngay lập tức trong vòng 20 mili-giây**.
* **Không truyền tải dạng sóng (No Waveform Transmission):** Giao thức mạng MQTT tuyệt đối không truyền dạng sóng âm hay giọng nói. Gói tin gửi lên máy chủ **chỉ duy nhất chứa 2 con số decibel vô tri**: `noise_avg` và `noise_peak`.
* **Tuân thủ Pháp lý:** Đáp ứng quy định về bảo vệ dữ liệu phi nhận dạng theo Nghị định số 13/2023/NĐ-CP của Chính phủ.

### 6.2. Tiêu chí Nghiệm thu Hệ thống Định lượng (Definition of Done - DoD)

| Chỉ số Đo lường | Tiêu chuẩn Chấp nhận Nghiệm thu | Phương pháp Kiểm chứng / Đo lường |
| :--- | :--- | :--- |
| **Độ trễ toàn trình (E2E Latency)** | $\le 1.5\text{ giây}$ | Từ lúc trạm đo phát sinh thay đổi đến khi bản đồ nhiệt trên Web cập nhật |
| **Tải chịu đựng Ingestion** | $\ge 100\text{ trạm}$ gửi chu kỳ $5\text{s}$ ($\ge 20\text{ msgs/s}$) | Dùng công cụ Locust giả lập 100 client MQTT; CPU Server $< 25\%$ |
| **Độ chính xác Đo âm học** | Sai số $\le \pm 1.5\text{ dBA}$ | Đối soát với máy đo âm thanh chuyên dụng Sound Level Meter Class 1 |
| **Tỷ lệ Báo động Giả (False Alarms)** | $< 3\%$ | Thử nghiệm với các xung âm ngắn (lật sách, ho, tiếng bút gõ) |
| **Tốc độ Phát hiện Offline** | $\le 2\text{ giây}$ (khi đứt nguồn/WiFi) | Rút dây nguồn trạm đo và quan sát Dashboard chuyển trạng thái xám |
| **Khả năng Phục hồi (Fault Recovery)**| Tự kết nối lại $\le 5\text{ giây}$ | Bật tắt Access Point Wi-Fi, trạm tự reconnect và phục hồi gửi dữ liệu |
| **Tính sẵn sàng của Hệ thống** | Uptime $\ge 99.5\%$ | Giám sát qua Spring Boot Actuator `/actuator/health` trong 7 ngày liên tục |

---

## 7. LỘ TRÌNH 4 GIAI ĐOẠN TRIỂN KHAI VÀ CHECKLIST MÃ NGUỒN

### 7.1. Bốn Giai đoạn Triển khai (Sprints)
* **Giai đoạn 1 (Tuần 1 - 2):** Hạ tầng Mosquitto Broker có xác thực, Inbound Adapter, Quản lý Phòng (`Room`) với sơ đồ đa giác tường, bổ sung tọa độ tương đối (`posX, posY`) cho `Device`.
* **Giai đoạn 2 (Tuần 3 - 4):** MongoDB Time Series Collections, Watchdog Scheduler 30s, Rule Engine có Moving Median & Hysteresis, STOMP WebSocket Throttled 1Hz.
* **Giai đoạn 3 (Tuần 5 - 6):** React Web Dashboard, Canvas Floorplan Map với Room Polygon Clipping (`ctx.clip()`) chống xuyên tường, Sparkline ECharts, Notification Center.
* **Giai đoạn 4 (Tuần 7 - 8):** Báo cáo thống kê Excel/PDF, nạp firmware ESP32-S3 theo sơ đồ chân, kiểm thử E2E với máy đo chuẩn và kiểm thử tải 100 thiết bị.

### 7.2. Checklist Mã nguồn Cần thực hiện trong `AIoTLibTQB`
- [ ] `docker-compose.yml`: Bổ sung Mosquitto 2.0 (tắt anonymous, cấu hình auth).
- [ ] `pom.xml`: Thêm `spring-integration-mqtt` và `spring-boot-starter-websocket`.
- [ ] `document/Room.java`: Entity phòng và `boundaryPolygon`.
- [ ] `document/Device.java`: Bổ sung `roomId`, `posX`, `posY`.
- [ ] `document/TelemetryRecord.java`: Time Series Collection native MongoDB 8.0.
- [ ] `document/Alert.java`: Quản lý vòng đời cảnh báo.
- [ ] `service/ComfortScoreService.java`: Triển khai công thức $LCS$ chuẩn hóa.
- [ ] `service/AlertEngineService.java`: Triển khai Moving Median và Hysteresis.
- [ ] `service/DeviceWatchdogService.java`: Job quét offline 10s (ngưỡng 30s).
- [ ] `frontend-dashboard/src/components/FloorplanCanvas.tsx`: Vẽ sơ đồ cắt vùng đa giác phòng.
