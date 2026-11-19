# Kiến Trúc Backend (Spring Boot & Java 21) / Backend Architecture

> **Cơ sở kiểm chứng / Verified From:** [`src/main/java/com/example/AIoTLibTQB/`](../../src/main/java/com/example/AIoTLibTQB) — `11` lớp cấu hình, `9` controllers, `26` tệp service, `18` document/sub-document models, `48` mã lỗi trong `ErrorCode`.

---

## 1. Cấu Trúc Gói Mã Nguồn / Package Topology

```text
src/main/java/com/example/AIoTLibTQB/
├── AIoTLibTqbApplication.java         # Entry point (@EnableScheduling, @EnableMongoAuditing)
├── configuration/                     # SecurityConfig, RateLimitFilter, MqttConfig, WebSocketConfig,
│                                      # StompChannelInterceptor, CustomJwtDecoder, ApplicationInitConfig,
│                                      # AlertConfiguration, AlertSopCatalog
├── controller/                        # 9 REST Controllers (/api/v1/*)
├── document/                          # 9 MongoDB @Document + 9 embedded/geometric records
├── dto/
│   ├── mqtt/                          # TelemetryPayload, StatusPayload
│   ├── request/                       # 19 Bean-validated request DTOs
│   └── response/                      # 18 ApiResponse / PageResponse / Domain DTOs
├── enums/                             # AlertSeverity, AlertStatus, AlertType, AlertWorkflowStatus,
│                                      # ErrorCode (48), Permission (14), Role (7), RoomType (3)
├── exception/                         # AppException, GlobalExceptionHandler
├── mapper/                            # MapStruct mappers (User, Role, Permission, Room, Device)
├── repository/                        # Spring Data MongoDB repositories
└── service/                           # 26 business, caching, ingestion, scoring, alert & watchdog classes
```

---

## 2. Pipeline Thu Nạp MQTT & Điều Tiết Tải / MQTT Ingestion Pipeline & Backpressure

**[VI]** Mọi gói tin đến từ `devices/+/telemetry` và `devices/+/status` được xử lý bất đồng bộ trên **Java 21 Virtual Threads** (`Executors.newVirtualThreadPerTaskExecutor()` trong [`MqttConfig`](../../src/main/java/com/example/AIoTLibTQB/configuration/MqttConfig.java)) rồi đi qua [`MqttMessageDispatcherService`](../../src/main/java/com/example/AIoTLibTQB/service/MqttMessageDispatcherService.java):

**[EN]** All MQTT frames arriving on `devices/+/telemetry` and `devices/+/status` execute on **Java 21 Virtual Threads** (`MqttConfig`) and flow through [`MqttMessageDispatcherService`](../../src/main/java/com/example/AIoTLibTQB/service/MqttMessageDispatcherService.java):

1. **Regex Routing & Anti-Spoofing**: Khớp `^devices/([^/]+)/telemetry$` hoặc `status`; từ chối ngay nếu `hardwareId` trong payload khác `{hardwareId}` trên MQTT topic.
2. **Zero-DB-Hit Device Lookup & Auto-Discovery**: Tra cứu thiết bị qua `DeviceMetadataCache` (Caffeine); nếu chưa tồn tại, đẩy vào `DiscoveredDeviceService` (cache 10 phút) để chờ Admin/Thủ thư duyệt thay vì tạo rác DB; bỏ qua nếu thiết bị `isActive == false`.
3. **Device Recovery & Throttled `lastSeenAt`**:
   - Nếu thiết bị nằm trong danh sách offline RAM (`DeviceWatchdogService`), khôi phục tức thời `ONLINE` và tự đóng cảnh báo `DEVICE_OFFLINE`.
   - Cập nhật trường `lastSeenAt` vào MongoDB chỉ chạy tối đa 1 lần / **`30s`** / thiết bị nhờ `lastSeenThrottleCache` (Caffeine `10,000` entries).
4. **3-Layer Sanitizer ([`TelemetrySanitizerService`](../../src/main/java/com/example/AIoTLibTQB/service/TelemetrySanitizerService.java))**:
   - **Lớp 1 — Giới hạn vật lý**: Kẹp/loại bỏ giá trị ngoài ngưỡng (`noiseAvg ∈ [30, 110]`, `noisePeak ∈ [30, 130]`, `PM ∈ [0, 1000]`, `temp ∈ [0, 60]`, `humidity ∈ [0, 100]`, `lux ∈ [0, 65535]`).
   - **Lớp 2 — Cửa sổ trượt âm học & Forward-fill 30s**: Tích hợp `NoiseSlidingWindow` (`30s`, tối đa `1,000` mẫu/thiết bị) tính trung bình trượt cho luồng phát 500ms; tự bù giá trị gần nhất trong vòng `30s` khi thiếu trường cảm biến tạm thời (**ngoại trừ `noisePeak` không bao giờ forward-fill** để tránh kéo dài cảnh báo giả).
   - **Lớp 3 — Timestamp & Guard**: Tự phân giải Unix epoch giây (10 số) hoặc mili-giây (13 số), hoặc fallback `Instant.now()`; hủy gói tin nếu toàn bộ chỉ số rỗng sau làm sạch. Theo dõi `RawValidationTracker` để báo cảnh báo `SENSOR_MALFUNCTION` nếu cảm biến gửi sai liên tục.
5. **MongoDB Write Semaphore**: Ghi vào `telemetry_records` qua `Semaphore(30, true)` (timeout `3000ms`, luôn giải phóng trong `finally`) nhằm tránh cạn kiệt connection pool khi thiết bị đồng loạt burst.

---

## 3. Thuật Toán Điểm Tiện Nghi Thư Viện (LCS) / Library Comfort Score (LCS) Algorithm

Hiện thực tại [`ComfortScoreService`](../../src/main/java/com/example/AIoTLibTQB/service/ComfortScoreService.java) với 2 nguyên lý cốt lõi:

### 3.1. Tái phân bổ trọng số động theo loại phòng / Dynamic Re-weighting by `RoomType`

| `RoomType` | Âm học ($W_{\text{acoustic}}$) | Không khí PM2.5 ($W_{\text{air}}$) | Nhiệt ẩm ($W_{\text{thermal}}$) | Ánh sáng ($W_{\text{light}}$) | Trọng tâm chuẩn |
| :--- | :---: | :---: | :---: | :---: | :--- |
| `STUDY_ROOM` | `0.35` | `0.30` | `0.20` | `0.15` | ANSI/ASA S12.60, EN 12464-1, ASHRAE 55 |
| `BOOK_STORAGE` | `0.05` | `0.30` | `0.50` | `0.15` | ISO 11799, IFLA *(ưu tiên nhiệt ẩm bảo quản sách)* |
| `CIRCULATION_HALL` | `0.20` | `0.30` | `0.25` | `0.25` | Cân bằng phục vụ sảnh bạn đọc |

Nếu một hoặc nhiều cảm biến vắng mặt (`null`), trọng số khả dụng được chuẩn hóa lại theo công thức $w_i' = \frac{W_i}{\sum_{j \in \text{available}} W_j}$ để điểm tổng vẫn phản ánh đúng thang `0–100`.

### 3.2. Công thức Thùng gỗ Liebig (Non-linear Gating Formula)

$$S_{\text{weighted}} = \sum_{i \in \text{available}} w_i' \cdot S_i, \qquad S_{\min} = \min_{i \in \text{available}} S_i$$

$$\text{bottleneckRatio} = \operatorname{clamp}\left(\frac{S_{\min}}{S_{\text{weighted}}}, 0, 1\right), \qquad \text{LCS} = \operatorname{clamp}\Big(S_{\text{weighted}} \cdot (0.30 + 0.70 \cdot \text{bottleneckRatio}),\, 0,\, 100\Big)$$

**[VI]** Khi một yếu tố tụt sâu (VD: ồn `80 dBA` khiến $S_{\text{acoustic}} = 0$), `bottleneckRatio = 0` kéo điểm LCS tổng tối đa chỉ còn `30%` của phần trung bình có trọng số — ngăn hiện tượng "lấy điểm đẹp che khuyết điểm nghiêm trọng".  
**[EN]** When a single dimension collapses (e.g. $S_{\text{acoustic}} = 0$), `bottleneckRatio = 0` caps total LCS at `30%` of the weighted sum — preventing healthy metrics from masking critical discomfort.

### 3.3. Bảng phân hạng 5 mức / 5-Tier Grading

| Hạng (`grade`) | Ngưỡng điểm `overall` | Ý nghĩa vận hành / Operational Meaning |
| :--- | :---: | :--- |
| **`Platinum`** | `>= 90.0` | Xuất sắc / Optimal conditions |
| **`Gold`** | `75.0 – 89.9` | Tốt / Good |
| **`Silver`** | `60.0 – 74.9` | Trung bình — cần lưu ý / Moderate (Attention) |
| **`Bronze`** | `45.0 – 59.9` | Kém — cần can thiệp / Poor |
| **`Poor`** | `< 45.0` *(hoặc `null`)* | Rất xấu / Critical discomfort |

---

## 4. Động Cơ Cảnh Báo, Watchdog & Gộp Luồng / Alert FSM, Watchdog & Conflation

### 4.1. Bốn Tiến Trình Nền Định Kỳ / 4 Scheduled Background Jobs

| Service & Method | Tần suất / Schedule | Trách nhiệm / Responsibility |
| :--- | :--- | :--- |
| [`TelemetryConflationService#conflateAndPublish`](../../src/main/java/com/example/AIoTLibTQB/service/TelemetryConflationService.java) | `${app.telemetry.conflation-ms:500}` (`500ms` = `2Hz`) | Gom `ConcurrentHashMap<roomId, TelemetryResponse>` và phát qua WebSocket STOMP tới `/topic/rooms/{id}/telemetry` và `/topic/public/rooms/{id}/telemetry`. |
| [`DeviceWatchdogService#scanOfflineDevices`](../../src/main/java/com/example/AIoTLibTQB/service/DeviceWatchdogService.java) | `15,000ms` (`15s`) | Phát hiện thiết bị `isActive=true` mất tin `> 2 phút` (`lastSeenAt < now - 2m` hoặc `null`), đánh dấu `OFFLINE` trong DB, kích hoạt cảnh báo `DEVICE_OFFLINE` (`HIGH`) và tự đóng cảnh báo môi trường cũ. |
| [`AlertEmailNotificationService#scanUnacknowledgedHighAlerts`](../../src/main/java/com/example/AIoTLibTQB/service/AlertEmailNotificationService.java) | `60,000ms` (`60s`) | Leo thang email cho các cảnh báo `HIGH` vẫn ở trạng thái `FIRING` quá `high-escalation-minutes` (`10 phút`). |
| [`AuthenticationService#cleanExpiredTokens`](../../src/main/java/com/example/AIoTLibTQB/service/AuthenticationService.java) | Cron `0 0 2 * * ?` (`02:00` hàng ngày) | Dọn phụ trợ các JWT hết hạn trong `invalidated_tokens` (song song TTL index `expireAfter="0s"`). |

### 4.2. Luật Cảnh Báo FSM & Leo Thang Email / Alert FSM & Email Escalation
- **Ngưỡng & Anti-Flapping ([`AlertRuleEngine`](../../src/main/java/com/example/AIoTLibTQB/service/AlertRuleEngine.java))**:
  - Thời gian xác nhận: `PENDING_WINDOW = 30s`; Thời gian hồi phục: `HYSTERESIS_WINDOW = 60s`.
  - Xung ồn đỉnh kép (`NOISE_PEAK`): kích hoạt **tức thời (`CRITICAL`)** nếu `noisePeak >= 85.0 dBA`; hoặc `HIGH` nếu `3` xung vượt `noisePeakMax` trong vòng `60s` (giãn cách xung tối thiểu `3s`).
  - Deadbands hồi phục: Âm học `2.0 dBA`, Nhiệt độ `0.8 °C`, Độ ẩm `2.0 %RH`, `PM2.5` `5.0 µg/m³`.
  - Chống rung Offline `30s` (`OFFLINE_FLAP_WINDOW`), tự đóng metric stale sau `2 phút` (`STALE_METRIC_RESOLVE_WINDOW`), và Snooze mặc định `15 phút` (`0–240 phút`) sau khi đóng thủ công.
  - Tự động đọc cấu hình ngưỡng riêng từng phòng từ `RoomThresholdConfig` (cache Caffeine `10 phút`) và gắn hướng dẫn SOP qua [`AlertSopCatalog`](../../src/main/java/com/example/AIoTLibTQB/configuration/AlertSopCatalog.java).
  - Bất biến Threading: Toàn bộ tính trạng FSM nằm trong `fsmMap.compute(...)` thuần RAM; thao tác DB (`alertRepository.save`) và STOMP (`realtimePublisher.publishAlert`) luôn chạy **bên ngoài lock** để tránh ghim Virtual Threads.
- **Email SMTP Escalation ([`AlertEmailNotificationService`](../../src/main/java/com/example/AIoTLibTQB/service/AlertEmailNotificationService.java))**:
  - Kích hoạt khi `app.alert.email.enabled=true` và có `JavaMailSender`.
  - Gửi email mở sự cố tức thì cho `CRITICAL`; gửi nhắc leo thang cho `HIGH` quá `10 phút` chưa ACK; gửi email `[ĐÃ KHẮC PHỤC - RESOLVED]` khi đóng sự cố.
  - Cooldown mở sự cố theo phòng (`cooldown-minutes: 30`) chống bão email; người nhận gồm toàn bộ tài khoản `ADMIN` đang hoạt động có email hợp lệ + nhân sự phụ trách zone (`assignedZones`, trừ tài khoản chỉ có role `DEVICE`).
