# TÀI LIỆU HƯỚNG DẪN TRIỂN KHAI CHI TIẾT & CÂN NHẮC KIẾN TRÚC HỆ THỐNG IoT
## DỰ ÁN: AIoTLibTQB (SMART INDOOR ENVIRONMENTAL & ACOUSTIC MONITORING)
*Hệ thống giám sát môi trường & âm học phòng học/thư viện thông minh (ESP32-S3, Spring Boot 3.5.8, Java 21, MongoDB 8.0, Mosquitto 2.0, WebSocket STOMP)*

---

## MỤC LỤC
1. [TỔNG QUAN KIẾN TRÚC & PHẠM VI HỆ THỐNG](#1-tổng-quan-kiến-trúc--phạm-vi-hệ-thống)
2. [CHI TIẾT CÁC BƯỚC THỰC HIỆN TỪNG BƯỚC (STEP-BY-STEP)](#2-chi-tiết-các-bước-thực-hiện-từng-bước-step-by-step)
   - [Bước 1: Thiết lập hạ tầng Ingestion (Docker & Dependencies)](#bước-1-thiết-lập-hạ-tầng-ingestion-docker--dependencies)
   - [Bước 2: Thiết kế mô hình dữ liệu (Data Modeling & Time-Series)](#bước-2-thiết-kế-mô-hình-dữ-liệu-data-modeling--time-series)
   - [Bước 3: Xây dựng Inbound Adapter & Pipeline Ingestion MQTT](#bước-3-xây-dựng-inbound-adapter--pipeline-ingestion-mqtt)
   - [Bước 4: Pipeline lọc nhiễu cảm biến & Tính điểm tiện nghi LCS](#bước-4-pipeline-lọc-nhiễu-cảm-biến--tính-điểm-tiện-nghi-lcs)
   - [Bước 5: Cơ chế giám sát trạng thái kết nối hai tầng (Hybrid Offline Detection)](#bước-5-cơ-chế-giám-sát-trạng-thái-kết-nối-hai-tầng-hybrid-offline-detection)
   - [Bước 6: WebSocket Streaming & Phân quyền STOMP Channel](#bước-6-websocket-streaming--phân-quyền-stomp-channel)
   - [Bước 7: Tích hợp Frontend Dashboard & Kiểm thử E2E](#bước-7-tích-hợp-frontend-dashboard--kiểm-thử-e2e)
3. [CÁC CÂN NHẮC KỸ THUẬT, LÝ DO LỰA CHỌN & ĐỐI CHIẾU DỰ ÁN THỰC TẾ](#3-các-cân-nhắc-kỹ-thuật-lý-do-lựa-chọn--đối-chiếu-dự-án-thực-tế)
   - [3.1. Broker MQTT & Cơ chế xác thực: Mosquitto vs EMQX vs RabbitMQ MQTT](#31-broker-mqtt--cơ-chế-xác-thực-mosquitto-vs-emqx-vs-rabbitmq-mqtt)
   - [3.2. Tầng xử lý Ingestion: Spring Integration vs Netty Custom vs Vert.x](#32-tầng-xử-lý-ingestion-spring-integration-vs-netty-custom-vs-vertx)
   - [3.3. Cơ sở dữ liệu Time-Series: MongoDB 8.0 Native vs TimescaleDB vs InfluxDB](#33-cơ-sở-dữ-liệu-time-series-mongodb-80-native-vs-timescaledb-vs-influxdb)
   - [3.4. Phát hiện thiết bị Offline: 5 kịch bản đứt mạng & Giải pháp lai LWT + Watchdog](#34-phát-hiện-thiết-bị-offline-5-kịch-bản-đứt-mạng--giải-pháp-lai-lwt--watchdog)
   - [3.5. Xử lý nhiễu âm học & bụi mịn: Chuỗi lọc 4 tầng từ chuẩn SoundEar & RESET Air](#35-xử-lý-nhiễu-âm-học--bụi-mịn-chuỗi-lọc-4-tầng-từ-chuẩn-soundear--reset-air)
   - [3.6. Phân phối thời gian thực: Conflation 1Hz chống DOM Thrashing](#36-phân-phối-thời-gian-thực-conflation-1hz-chống-dom-thrashing)
4. [BẢN ĐỒ CASE STUDIES TỪ CÁC DỰ ÁN PRODUCTION THỰC TẾ](#4-bản-đồ-case-studies-từ-các-dự-án-production-thực-tế)
5. [CHECKLIST TRIỂN KHAI VÀ TIÊU CHÍ HOÀN THÀNH (DEFINITION OF DONE)](#5-checklist-triển-khai-và-tiêu-chí-hoàn-thành-definition-of-done)

---

## 1. TỔNG QUAN KIẾN TRÚC & PHẠM VI HỆ THỐNG

Hệ thống **AIoTLibTQB (Listen_Project)** được thiết kế theo mô hình **Edge-to-Cloud** nhằm giám sát môi trường vi khí hậu và âm học trong không gian kín (thư viện, phòng đọc, giảng đường thông minh).

```
┌────────────────────────────────────────────────────────┐
│                   EDGE LAYER (TRẠM ĐO)                 │
│ ESP32-S3 + Micro I2S (INMP441) + Bụi SPS30 + SHT30/Lux  │
└───────────────────────────┬────────────────────────────┘
                            │ MQTT over TLS (Port 1883/8883)
                            ▼
┌────────────────────────────────────────────────────────┐
│                  INGESTION BROKER LAYER                │
│  Eclipse Mosquitto 2.0 (allow_anonymous false)         │
│  Plugin Webhook Auth ──► Gọi Backend verify BCrypt Key │
└───────────────────────────┬────────────────────────────┘
                            │ Spring Integration MQTT (Java 21 Virtual Threads)
                            ▼
┌────────────────────────────────────────────────────────┐
│                   BACKEND CORE SERVICE                 │
│  - Pipeline lọc tín hiệu (Rate-of-Change, Median, FSM) │
│  - Engine tính điểm tiện nghi LCS chuẩn hóa            │
│  - Offline Watchdog Scheduler (30s)                    │
│  - STOMP WebSocket Message Broker (Throttled 1Hz)      │
└───────────────┬────────────────────────┬───────────────┘
                │                        │
                ▼                        ▼
┌──────────────────────────────┐ ┌───────────────────────┐
│     MONGODB 8.0 DATABASE     │ │  FRONTEND DASHBOARD   │
│ - IAM Documents (User, Role) │ │ - Real-time Heatmap   │
│ - Space Documents (Room)     │ │ - Room Canvas Clip    │
│ - Native Time-Series Records │ │ - Alert Center        │
└──────────────────────────────┘ └───────────────────────┘
```

---

## 2. CHI TIẾT CÁC BƯỚC THỰC HIỆN TỪNG BƯỚC (STEP-BY-STEP)

### Bước 1: Thiết lập hạ tầng Ingestion (Docker & Dependencies)

#### 1.1. Bổ sung Service Mosquitto vào `docker-compose.yml`
* **Vị trí file:** `docker-compose.yml`
* **Nội dung cấu hình:**
  ```yaml
  mosquitto:
    image: eclipse-mosquitto:2.0
    container_name: aiot_mosquitto
    restart: unless-stopped
    ports:
      - "1883:1883"
    volumes:
      - ./mosquitto/config/mosquitto.conf:/mosquitto/config/mosquitto.conf:ro
      - mosquitto_data:/mosquitto/data
      - mosquitto_log:/mosquitto/log
    networks:
      - aiot_network
  ```
* **Tạo file cấu hình `mosquitto/config/mosquitto.conf`:**
  ```ini
  listener 1883 0.0.0.0
  allow_anonymous false
  persistence true
  persistence_location /mosquitto/data/
  log_dest stdout
  log_type error
  log_type warning
  log_type notice
  log_type information
  ```

#### 1.2. Thêm Dependencies vào `pom.xml`
* **Vị trí file:** `pom.xml`
* **Nội dung bổ sung:**
  ```xml
  <!-- Spring Integration Core & MQTT Adapter -->
  <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-integration</artifactId>
  </dependency>
  <dependency>
      <groupId>org.springframework.integration</groupId>
      <artifactId>spring-integration-mqtt</artifactId>
  </dependency>

  <!-- Spring WebSocket & STOMP Messaging -->
  <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-websocket</artifactId>
  </dependency>
  ```
* **Kiểm tra biên dịch:** Chạy `.\mvnw.cmd clean compile` đảm bảo tải đúng thư viện Paho MQTT Client và Spring WebSocket.

---

### Bước 2: Thiết kế mô hình dữ liệu (Data Modeling & Time-Series)

#### 2.1. Tạo Document `Room.java` (Quản lý không gian & Đa giác tường)
* **Mục đích:** Quản lý thông tin phòng và danh sách tọa độ các đỉnh của tường phòng (`boundaryPolygon`) để frontend thực hiện cắt canvas (`ctx.clip()`), ngăn nhiệt lượng và tiếng ồn tràn xuyên qua các phòng khác nhau.
* **Cấu trúc trường:**
  * `id`: String (MongoDB ObjectId).
  * `name`: String (VD: "Phòng đọc Tầng 2").
  * `code`: String (VD: "ROOM_201", Unique).
  * `floor`: Integer.
  * `boundaryPolygon`: `List<Point2D>` (tọa độ các đỉnh đa giác chuẩn hóa $\in [0.0, 1.0]$ hoặc mét).
  * `targetComfortScore`: Double (Mục tiêu LCS kỳ vọng).
  * `createdAt`, `updatedAt`: Instant.

#### 2.2. Mở rộng Document `Device.java`
* **Cập nhật trường:**
  * `roomId`: String (Liên kết với Room tương ứng).
  * `posX`: Double (Tọa độ ngang chuẩn hóa trên mặt bằng phòng $\in [0.0, 1.0]$).
  * `posY`: Double (Tọa độ dọc chuẩn hóa trên mặt bằng phòng $\in [0.0, 1.0]$).
* **Cập nhật các DTO liên quan:**
  * `DeviceRegistrationRequest`, `DeviceUpdateRequest`, `DeviceResponse`.

#### 2.3. Tạo Document `TelemetryRecord.java` (Native Time-Series)
* **Mục đích:** Lưu trữ bản ghi đo đạc từ các cảm biến ở tốc độ cao mà không làm phình to dung lượng ổ đĩa.
* **Cấu trúc Collection trong MongoDB 8.0:**
  ```java
  @Document(collection = "telemetry_records")
  @TimeSeries(
      timeField = "timestamp",
      metaField = "metadata",
      granularity = Granularity.SECONDS
  )
  @Data
  @Builder
  public class TelemetryRecord {
      @Id
      String id;
      Instant timestamp;
      TelemetryMetadata metadata; // { deviceId, roomId, hardwareId }
      AcousticMetrics acoustics;   // noiseAvg, noisePeak
      AirQualityMetrics airQuality; // pm1_0, pm2_5, pm4_0, pm10
      EnvironmentMetrics environment; // temperature, humidity, lux
      ComfortScoreRecord comfortScore; // LCS, S_acoustic, S_air, S_thermal, S_light
  }
  ```

#### 2.4. Tạo Document `Alert.java` (Quản lý vòng đời cảnh báo)
* **Cấu trúc trường:**
  * `id`: String.
  * `deviceId`: String.
  * `roomId`: String.
  * `type`: Enum `AlertType` (`NOISE_EXCEEDED`, `AIR_UNHEALTHY`, `DEVICE_OFFLINE`, `SENSOR_MALFUNCTION`).
  * `status`: Enum `AlertStatus` (`PENDING`, `FIRING`, `ACKNOWLEDGED`, `RESOLVED`).
  * `currentValue`: Double.
  * `threshold`: Double.
  * `startedAt`, `acknowledgedAt`, `resolvedAt`: Instant.
  * `acknowledgedBy`: String (Username của Admin/Librarian).

---

### Bước 3: Xây dựng Inbound Adapter & Pipeline Ingestion MQTT

#### 3.1. Phân định Topic chuẩn
* **Telemetry topic:** `devices/{hardwareId}/telemetry`
* **Status / LWT topic:** `devices/{hardwareId}/status`
* **Command topic:** `devices/{hardwareId}/cmd`

#### 3.2. Cấu hình Spring Integration MQTT Inbound Flow
* **File:** `configuration/MqttConfig.java`
* **Kiến trúc luồng xử lý:**
  1. Khởi tạo `MqttPahoMessageDrivenChannelAdapter` kết nối đến `tcp://localhost:1883` với ClientID duy nhất của Backend (VD: `aiot_backend_consumer`).
  2. Subscribe các topic wildcard: `devices/+/telemetry` và `devices/+/status`.
  3. Sử dụng `ExecutorSubscribableChannel` kết hợp **Java 21 Virtual Threads** (`Executors.newVirtualThreadPerTaskExecutor()`) để giải phóng tài nguyên CPU khi nhận thông điệp dồn dập.
  4. Đẩy payload sang `MqttMessageDispatcherService` để phân luồng xử lý.

#### 3.3. Kiểm thực định dạng & Lọc ngoại lai (Validation & Sanitization)
* Trích xuất `hardwareId` từ header `mqtt_receivedTopic`.
* Parse JSON payload:
  * Nếu là topic `status`: Kiểm tra cờ `online` / `offline` để cập nhật tức thời vào `Device`.
  * Nếu là topic `telemetry`: Kiểm tra tính toàn vẹn (bỏ qua giá trị ngoại lai $noise\_avg \notin [30, 110]$, $temperature \notin [0, 60]$, $humidity \notin [0, 100]$). Áp dụng kỹ thuật **Forward-Fill** nếu 1 cảm biến trong cụm tạm thời trả về `null`.

---

### Bước 4: Pipeline lọc nhiễu cảm biến & Tính điểm tiện nghi LCS

#### 4.1. Chuỗi lọc tín hiệu 4 tầng (Signal Processing Service)
Xây dựng `service/SignalFilterService.java`:
1. **Tầng 1 - Rate of Change (Clamping):** Bỏ qua bước nhảy phi vật lý ($|\Delta x / \Delta t| > \Delta_{max}$).
2. **Tầng 2 - Moving Median Filter (Window N=5):**
   * Duy trì bộ nhớ đệm 5 mẫu đo gần nhất của từng thiết bị trong `ConcurrentHashMap`.
   * Lấy giá trị trung vị (Median) để triệt tiêu tiếng gõ bàn, đóng sách, ho hắng ngẫu nhiên.
3. **Tầng 3 - Hysteresis (Ngưỡng kép):**
   * Ngưỡng bật cảnh báo tiếng ồn: $50\text{ dBA}$.
   * Ngưỡng hạ giải tỏa cảnh báo: $47\text{ dBA}$ (Deadband = $3\text{ dBA}$).
4. **Tầng 4 - Time-over-Threshold Debounce:**
   * Sau khi vượt ngưỡng qua Hysteresis, bộ đếm trạng thái `PENDING` chạy $15\text{ giây}$. Nếu trong suốt 15 giây tín hiệu vẫn vượt ngưỡng, cảnh báo mới chuyển sang `FIRING`.

#### 4.2. Dịch vụ Tính toán Điểm Tiện nghi LCS (`ComfortScoreService.java`)
Cài đặt chính xác các hàm thành phần chuẩn hóa $C^0 \in [0, 100]$:
1. $S_{acoustic}(L_{avg}, L_{peak})$ (Chuẩn ANSI/ASA S12.60 & WHO): Trừ điểm theo $L_{avg}$ và phạt xung va đập $\Delta_{peak}$ ($L_{peak} > 70\text{ dBA}$).
2. $S_{air}(PM2.5)$ (Chuẩn WHO 2021 & EPA): Điểm tối đa khi $\le 10 \mu g/m^3$, giảm dần về $0$ tại $100 \mu g/m^3$.
3. $S_{thermal}(Temp, Hum)$ (Chuẩn ASHRAE 55-2020): Vùng nhiệt tối ưu $23.5 - 25.5^\circ\text{C}$, ẩm tối ưu $40 - 60\%$. $S_{thermal} = 0.70 \cdot S_T + 0.30 \cdot S_{RH}$.
4. $S_{light}(Lux)$ (Chuẩn EN 12464-1 & TCVN 7114): Vùng tối ưu $400 - 600\text{ Lux}$.
5. **Công thức tổng hợp Non-linear Liebig Penalty:**
   $$S_{weighted} = 0.35 \cdot S_{acoustic} + 0.30 \cdot S_{air} + 0.20 \cdot S_{thermal} + 0.15 \cdot S_{light}$$
   $$S_{min} = \min(S_{acoustic}, S_{air}, S_{thermal}, S_{light})$$
   $$LCS = S_{weighted} \cdot \left[ 0.30 + 0.70 \cdot \left(\frac{S_{min}}{100}\right) \right]$$

---

### Bước 5: Cơ chế giám sát trạng thái kết nối hai tầng (Hybrid Offline Detection)

#### 5.1. Tầng 1: Event-driven via MQTT LWT (Đáp ứng $\le 1.5\text{s}$)
* Firmware ESP32 cấu hình cờ LWT khi mở kết nối:
  * Topic: `devices/{hardwareId}/status`
  * Payload: `{"status": "offline", "reason": "connection_lost"}`
  * QoS: 1, Retain: true.
* Khi mất sóng Wi-Fi hoặc rút nguồn, Mosquitto broadcast LWT. Backend nhận bản tin, lập tức cập nhật:
  `device.setOnline(false)`, ghi nhận `lastSeenAt = now`.

#### 5.2. Tầng 2: Scheduled Watchdog Job (Đáp ứng $\le 30\text{s}$)
* **Mục đích:** Xử lý lỗi Socket treo nửa chừng (Half-open socket) hoặc chip bị deadlock ngắt I2C nhưng task TCP stack vẫn giữ kết nối ảo.
* **Cài đặt:** `service/DeviceWatchdogService.java`:
  * Sử dụng `@Scheduled(fixedDelay = 10000)` (quét mỗi 10 giây).
  * Truy vấn các thiết bị có `isActive == true` và `lastSeenAt < (now - 30s)`.
  * Đánh dấu thiết bị `OFFLINE` và phát sinh bản tin cảnh báo `DEVICE_OFFLINE`.

---

### Bước 6: WebSocket Streaming & Phân quyền STOMP Channel

#### 6.1. Cấu hình WebSocket Broker & Security Interceptor
* **File:** `configuration/WebSocketConfig.java`
* Đăng ký endpoint: `/ws-aiot` (Hỗ trợ SockJS fallback).
* Prefix: `/topic` (Broker đích) và `/app` (Application destination).
* **Bảo mật Frame STOMP (`ChannelInterceptor`):**
  * Frame `CONNECT`: Trích xuất `Authorization: Bearer <TOKEN>`, giải mã qua `CustomJwtDecoder`, xác thực không nằm trong blacklist và lưu `Authentication` vào STOMP header.
  * Frame `SUBSCRIBE`: Kiểm tra quyền truy cập đích:
    * `/topic/rooms/{roomId}/**`: User phải có quyền `ADMIN`, `LIBRARIAN` hoặc `ZONE_MANAGER` có `roomId` nằm trong `assignedZones`.
    * `/topic/alerts`: Yêu cầu các vai trò quản trị.
    * `/topic/rooms/{roomId}/comfort`: Cho phép khách đọc sách vãng lai xem điểm công cộng.

#### 6.2. Cơ chế Throttling / Conflation 1Hz
* Thay vì bắn dữ liệu 5Hz của từng cảm biến gây nghẽn trình duyệt client, Backend gom mẫu (Conflate) theo từng `roomId`:
  * Sử dụng bộ đệm in-memory (hoặc Reactive Streams Flux `sample(Duration.ofSeconds(1))`).
  * Định kỳ mỗi 1 giây phát đúng 1 gói tin tổng hợp về điểm LCS, các chỉ số trung bình và số lượng cảm biến hoạt động lên `/topic/rooms/{roomId}/telemetry`.

---

### Bước 7: Tích hợp Frontend Dashboard & Kiểm thử E2E

1. **Canvas Room Clipping (`ctx.clip()`):**
   * Sử dụng danh sách đỉnh `boundaryPolygon` từ API Room để thiết lập đường viền cắt trên HTML5 Canvas.
   * Vẽ bản đồ nhiệt độ / tiếng ồn nội suy (IDW - Inverse Distance Weighting) đảm bảo gradient không tràn ra ngoài hành lang hoặc phòng kế bên.
2. **Kiểm thử E2E & Đo tải:**
   * Dùng script Python / Locust giả lập 100 trạm đo gửi dữ liệu chu kỳ 5 giây lên Mosquitto (tải 20 msgs/s).
   * Kiểm tra độ trễ toàn trình (E2E Latency) từ lúc publish MQTT đến khi STOMP frame tới trình duyệt $\le 1.5\text{s}$.
   * Kiểm tra CPU Backend $\le 25\%$ và không rò rỉ bộ nhớ.

---

## 3. CÁC CÂN NHẮC KỸ THUẬT, LÝ DO LỰA CHỌN & ĐỐI CHIẾU DỰ ÁN THỰC TẾ

### 3.1. Broker MQTT & Cơ chế xác thực: Mosquitto vs EMQX vs RabbitMQ MQTT

| Tiêu chí | Eclipse Mosquitto 2.0 | EMQX Enterprise / Community | RabbitMQ (Plugin MQTT) |
| :--- | :--- | :--- | :--- |
| **Bản chất kiến trúc** | C native, Single-threaded Event Loop (epoll), siêu nhẹ | Erlang/OTP, phân tán cụm (Clustering), tải cực lớn | AMQP Core, chuyển đổi giao thức qua Erlang plugin |
| **Mức tiêu hao tài nguyên** | **Cực thấp (~15MB - 30MB RAM)** | Trung bình (~500MB - 1GB RAM) | Cao (~500MB - 1.5GB RAM do Erlang runtime) |
| **Xác thực động (Dynamic Auth)** | Hỗ trợ Plugin C / Go Auth / Webhook | Sẵn có Auth HTTP/SQL/Redis trên giao diện Dashboard | Phụ thuộc vào phân quyền User nội bộ của RabbitMQ |
| **Phù hợp quy mô** | 1 đến 50,000 thiết bị kết nối đồng thời | Hàng trăm nghìn đến hàng triệu thiết bị | Phù hợp khi hệ thống đã có sẵn cụm RabbitMQ AMQP |

> **Quyết định & Lý do lựa chọn cho AIoTLibTQB:**
> Chọn **Eclipse Mosquitto 2.0**:
> 1. Trọng lượng siêu nhẹ, tiêu tốn ít hơn 30MB RAM trong Docker, tối ưu chi phí hạ tầng trường học.
> 2. Đạt chuẩn bảo mật khắt khe khi cấu hình `allow_anonymous false`.
> 3. Tích hợp trực tiếp xác thực thiết bị thông qua Webhook gọi về API sẵn có của Backend `POST /api/v1/devices/authenticate`, tận dụng thuật toán băm BCrypt của `apiKeyHash` mà không cần duy trì thêm bảng tài khoản thứ hai trên Broker.

---

### 3.2. Tầng xử lý Ingestion: Spring Integration vs Netty Custom vs Vert.x

| Tiêu chí | Spring Integration MQTT | Netty Custom Pipeline (ThingsBoard) | Eclipse Vert.x Reactive |
| :--- | :--- | :--- | :--- |
| **Mô hình lập trình** | Declarative Message-driven Channels | EventLoop chuyên biệt, ByteBuf Zero-copy | Reactive Event Loop (Non-blocking) |
| **Throughput tối đa** | ~10k - 20k msg/s | >100k msg/s | ~60k - 100k msg/s |
| **Độ phức tạp mã nguồn** | **Thấp nhất** (Tích hợp tự nhiên trong Spring) | **Rất cao** (Tự viết codec, quản lý TCP state) | **Trung bình** (Tư duy lập trình bất đồng bộ) |
| **Tận dụng hạ tầng hiện tại** | Dùng chung trọn vẹn Spring Context, DI, Security | Phải cấu trúc thành 1 Microservice riêng biệt | Phải cấu trúc thành 1 Microservice riêng biệt |

> **Quyết định & Lý do lựa chọn:**
> Chọn **Spring Integration MQTT kết hợp Java 21 Virtual Threads**:
> - Đối với quy mô 100 - 500 trạm đo thư viện/phòng học (tần suất 5-10s/lần), thông lượng thực tế chỉ dao động từ **10 đến 100 msgs/s**, hoàn toàn nằm trong dải xử lý mượt mà của Spring Integration.
> - Sử dụng Java 21 Virtual Threads giải quyết triệt để vấn đề nghẽn Thread Pool truyền thống mà không phải trả giá bằng độ phức tạp kiến trúc đồ sộ như tầng `thingsboard-mqtt-transport` của ThingsBoard.

---

### 3.3. Cơ sở dữ liệu Time-Series: MongoDB 8.0 Native vs TimescaleDB vs InfluxDB

```
          ┌─────────────────────────────────────────────────────────┐
          │     SO SÁNH BỘ NHỚ VÀ ĐỘ PHỨC TẠP HẠ TẦNG CSDL          │
          └─────────────────────────────────────────────────────────┘
  [Giải pháp 2 CSDL (Polyglot)]               [Giải pháp Đơn khối Tinh gọn]
  ┌──────────────┐   ┌──────────────┐         ┌───────────────────────────────┐
  │  PostgreSQL  │ + │   InfluxDB   │         │          MongoDB 8.0          │
  │ (User/Room)  │   │ (Time-Series)│         │ - IAM & Quản lý phòng (Doc)   │
  └──────┬───────┘   └──────┬───────┘         │ - Time-Series Collections     │
         │                  │                 └───────────────┬───────────────┘
         └─────────┬────────┘                                 │
                   ▼                                          ▼
     • Tốn gấp đôi RAM/Disk                     • 1 Engine CSDL duy nhất
     • Dual-write rủi ro lệch dữ liệu           • Dễ backup, tận dụng Aggregation
     • Cần 2 pipeline backup riêng              • Giảm 20x RAM cache với bản 8.0
```

1. **Loại bỏ hoàn toàn rủi ro "Polyglot Persistence":**
   - Nếu dùng TimescaleDB hoặc InfluxDB, hệ thống buộc phải duy trì 2 CSDL: 1 CSDL lưu thông tin thiết bị, phòng học, tài khoản, phân quyền; và 1 CSDL lưu chuỗi thời gian.
   - Điều này dẫn đến nguy cơ lỗi giao dịch phân tán (Dual-write hazard) và làm phức tạp hóa quy trình DevOps/Backup.
2. **Đột phá công nghệ của MongoDB 8.0:**
   - **Columnar Compression:** MongoDB 8.0 nén thẳng các khối đo lường vào định dạng cột (Block Processing), giảm tỷ lệ chiếm dụng bộ nhớ cache WiredTiger từ **10x đến 20x** so với bản 6.0/7.0.
   - **Write Throughput:** Tăng hơn 200% tốc độ ghi và hỗ trợ các hàm phân tích cửa sổ chuỗi thời gian `$densify`, `$fill` trực tiếp trong Aggregation pipeline.
   - **Schema Polymorphism:** Cảm biến đo âm học gửi `{noise_avg, noise_peak}`, cảm biến môi trường gửi `{pm2_5, temp, lux}` đều được lưu trữ linh hoạt trong cùng một collection mà không cần chạy migration `ALTER TABLE` như CSDL quan hệ.

---

### 3.4. Phát hiện thiết bị Offline: 5 kịch bản đứt mạng & Giải pháp lai LWT + Watchdog

Trong triển khai thực tế, không có một cơ chế đơn lẻ nào có thể bắt trọn vẹn 100% các tình huống ngắt kết nối:

| Kịch bản sự cố | Biểu hiện vật lý | Cơ chế LWT đơn lẻ | Cơ chế Polling Watchdog | Cơ chế Lai (Hybrid Solution) |
| :--- | :--- | :---: | :---: | :---: |
| **1. Tắt máy chủ động** | ESP32 gửi gói `DISCONNECT` | ✅ Bắt được ngay | ⏱ Chờ sau 30s | ✅ **LWT bắt trong mili-giây** |
| **2. Đứt cáp mạng / Reset Router** | Router gửi TCP RST | ✅ Bắt được ngay | ⏱ Chờ sau 30s | ✅ **LWT bắt trong mili-giây** |
| **3. Mất điện đột ngột / Đứt sóng** | Socket bị treo (Half-open) | ❌ Chờ $1.5 \times KeepAlive$ (~90s) | ✅ Bắt được sau 30s | ✅ **Watchdog bắt sau 30s** |
| **4. Treo vi điều khiển (MCU Hang)** | Treo task I2C, nhưng WiFi/TCP stack vẫn ACK | ❌ **Hoàn toàn bất lực (kết nối vẫn mở)** | ✅ Bắt được do không có dữ liệu mới | ✅ **Watchdog bắt sau 30s** |
| **5. Cảm biến ngủ sâu (Deep-sleep)** | Tự ngắt kết nối theo chu kỳ pin | ❌ Báo động giả | ❌ Báo động giả | ✅ **FSM đánh dấu SLEEP, không báo lỗi** |

> **Kết luận:**
> Kiến trúc kết hợp **Tầng 1 (LWT 1.5s)** cho sự cố đứt kết nối mạng vật lý và **Tầng 2 (Scheduled Watchdog 30s)** cho sự cố ứng dụng treo hoặc half-open socket là giải pháp đạt chuẩn công nghiệp, loại bỏ hoàn toàn các điểm mù giám sát.

---

### 3.5. Xử lý nhiễu âm học & bụi mịn: Chuỗi lọc 4 tầng từ chuẩn SoundEar & RESET Air

#### A. Đối với Cảm biến Tiếng ồn (Acoustics)
* **Vấn đề thực tế:** Môi trường thư viện thường xuất hiện các âm thanh va đập tức thời (tiếng lật sách mạnh, tiếng rơi bút, ho, kéo ghế). Năng lượng âm của các sự kiện này rất lớn ($>75\text{ dBA}$) nhưng chỉ diễn ra trong vài trăm mili-giây.
* **Cách giải quyết từ chuẩn SoundEar 3 / SVANTEK:**
  - Không bao giờ cảnh báo dựa trên giá trị đỉnh tức thời $L_{peak}$.
  - Áp dụng **Bộ lọc trung vị (Moving Median 5 mẫu)** để triệt tiêu hoàn toàn đỉnh xung đơn lẻ mà không làm trễ pha tín hiệu như hàm trung bình.
  - Sử dụng **Hysteresis kép** (Bật cảnh báo ở $50\text{ dBA}$, chỉ tắt khi âm thanh duy trì dưới $47\text{ dBA}$) kết hợp **Debounce 15 giây** để loại bỏ hiện tượng rung chuông/đèn liên tục.

#### B. Đối với Cảm biến Bụi mịn (SPS30)
* **Vấn đề thực tế:** Cảm biến tán xạ quang học dễ bị xơ vải/sợi tóc bay qua buồng đếm tạo xung nhảy vọt từ $15 \mu g/m^3$ lên $500 \mu g/m^3$, hoặc hiện tượng hơi ẩm ngưng tụ khi trời nồm làm tăng ảo nồng độ bụi (Humidity Swelling).
* **Cách giải quyết từ chuẩn RESET Air Standard:**
  - Áp dụng bộ kẹp biến thiên **Rate-of-Change Limiter** loại bỏ các bước nhảy vọt phi vật lý.
  - Tích hợp cảm biến SHT30 để kiểm soát điều kiện độ ẩm $> 75\%$, tự động hiệu chỉnh hệ số bù trừ tán xạ hơi nước trước khi đưa vào tính điểm $S_{air}$.

---

### 3.6. Phân phối thời gian thực: Conflation 1Hz chống DOM Thrashing

* **Vấn đề:** Khi có 50 trạm đo gửi dữ liệu liên tục 2Hz - 5Hz, Backend nếu chuyển tiếp nguyên trạng qua WebSocket sẽ tạo ra cơn bão bản tin ($>200\text{ msgs/s}$) dội vào trình duyệt. Trình duyệt client sẽ bị hiện tượng **DOM Thrashing**, CPU máy trạm vọt lên $100\%$ và gây đơ giao diện hiển thị.
* **Giải pháp Conflation (Latest-Value Sampling):**
  - Mắt người và biểu đồ giám sát môi trường không có nhu cầu nhận biết thay đổi ở cấp độ mili-giây.
  - Backend thực hiện gom mẫu và chỉ phát tán đúng **1 bản tin mỗi giây (1Hz)** cho mỗi phòng.
  - Phía Frontend áp dụng `requestAnimationFrame` kết hợp chế độ render Canvas của Apache ECharts, đảm bảo Dashboard hiển thị mượt mà ở mức 60 FPS mà không tiêu hao tài nguyên CPU client.

---

## 4. BẢN ĐỒ CASE STUDIES TỪ CÁC DỰ ÁN PRODUCTION THỰC TẾ

```
┌────────────────────────────────────────────────────────────────────────┐
│              CASE STUDIES TỪ CÁC HỆ THỐNG IOT THỰC TẾ                  │
├───────────────────┬────────────────────────────────────────────────────┤
│ DỰ ÁN / TIÊU CHUẨN│ BÀI HỌC KIẾN TRÚC ĐƯỢC CHẮT LỌC VÀ ÁP DỤNG         │
├───────────────────┼────────────────────────────────────────────────────┤
│                   │ • Tách rời tầng Ingestion (Netty) khỏi Business Core│
│    ThingsBoard    │ • Phân cấp Topic rõ rệt: telemetry vs attributes vs rpc │
│ (IoT Platform số 1│ • Cơ chế kiểm tra Offline 2 lớp: Socket timeout    │
│    Mã nguồn mở)   │   kết hợp Scheduled Rule Engine quét inactivity.   │
├───────────────────┼────────────────────────────────────────────────────┤
│                   │ • Topic Hierarchy chuẩn phân cấp đa tầng:          │
│   AWS IoT Core    │   devices/{id}/telemetry và devices/{id}/status.   │
│   Smart Building  │ • Nguyên tắc Zero-Trust: Thiết bị chỉ được Publish │
│     Reference     │   vào topic của chính nó, cấm Subscribe wildcard.  │
├───────────────────┼────────────────────────────────────────────────────┤
│   SoundEar 3 &    │ • Đo lường âm học bằng mức năng lượng tích lũy Leq  │
│  SVANTEK Monitor  │ • Ứng dụng dải trễ Hysteresis và Time-over-threshold│
│ (Thiết bị chuyên  │   để chống báo động giả do tiếng đóng sách/lật ghế.│
│ dụng trường học)  │ • Cam kết Edge Privacy: Xóa buffer âm thanh ngay lập│
│                   │   tức trong 20ms, tuyệt đối không truyền dạng sóng.│
├───────────────────┼────────────────────────────────────────────────────┤
│                   │ • Yêu cầu chuẩn hóa cửa sổ thời gian trượt (Rolling│
│ RESET Air Standard│   average) cho nồng độ bụi PM2.5.                  │
│  & ASHRAE 55-2020 │ • Buộc phải có cảm biến nhiệt ẩm để bù trừ sai số  │
│                   │   tán xạ quang học của laser trong cảm biến bụi.   │
└───────────────────┴────────────────────────────────────────────────────┘
```

---

## 5. CHECKLIST TRIỂN KHAI VÀ TIÊU CHÍ HOÀN THÀNH (DEFINITION OF DONE)

### 5.1. Checklist Mã Nguồn Chi Tiết

| Hạng mục | Tác vụ chi tiết | File liên quan | Trạng thái |
| :--- | :--- | :--- | :---: |
| **Hạ tầng** | Thêm Mosquitto 2.0, tắt anonymous, gắn volume config | `docker-compose.yml`, `mosquitto.conf` | [ ] |
| **Thư viện** | Thêm `spring-integration-mqtt` và `websocket` | `pom.xml` | [ ] |
| **Mô hình** | Tạo Document `Room` kèm `boundaryPolygon` | `document/Room.java`, `RoomRepository.java` | [ ] |
| **Mô hình** | Mở rộng `Device` thêm `roomId`, `posX`, `posY` | `document/Device.java`, DTOs | [ ] |
| **Time-Series**| Tạo Time-Series Collection `TelemetryRecord` | `document/TelemetryRecord.java` | [ ] |
| **Cảnh báo** | Tạo Document và Enum quản lý máy trạng thái `Alert` | `document/Alert.java`, `AlertStatus.java` | [ ] |
| **MQTT** | Cấu hình Inbound Channel Adapter & Dispatcher | `configuration/MqttConfig.java`, Service | [ ] |
| **Lọc tín hiệu**| Cài đặt Moving Median & Hysteresis | `service/SignalFilterService.java` | [ ] |
| **LCS Engine** | Cài đặt công thức tiện nghi chuẩn hóa $C^0$ & Liebig | `service/ComfortScoreService.java` | [ ] |
| **Watchdog** | Scheduled job quét offline 10s (ngưỡng 30s) | `service/DeviceWatchdogService.java` | [ ] |
| **WebSocket** | ChannelInterceptor xác thực JWT & Throttling 1Hz | `configuration/WebSocketConfig.java` | [ ] |

### 5.2. Tiêu Chí Nghiệm Thu Định Lượng (DoD)
1. **Độ trễ toàn trình (E2E Latency):** $\le 1.5\text{ giây}$ từ khi ESP32 bắn gói tin MQTT đến khi Dashboard Web cập nhật số liệu.
2. **Khả năng chịu tải:** Chạy ổn định $\ge 100\text{ trạm}$ gửi chu kỳ $5\text{s}$ ($\ge 20\text{ msgs/s}$), CPU Backend duy trì $< 25\%$.
3. **Độ nhạy phát hiện Offline:**
   - Rút nguồn/đứt mạng: LWT phát hiện $\le 1.5\text{ giây}$.
   - Lỗi treo vi điều khiển: Watchdog phát hiện $\le 30\text{ giây}$.
4. **Tỷ lệ báo động giả:** $< 3\%$ đối với các xung âm va đập ngắn (lật sách, ho, tiếng gõ bút).
5. **Độ chính xác toán học LCS:** Điểm $LCS$ luôn liên tục $C^0 \in [0, 100]$, phản ứng đúng quy luật Liebig khi có 1 chỉ số chạm đáy.
