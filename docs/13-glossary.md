# 13 — Từ Điển Thuật Ngữ, Từ Viết Tắt & Quy Chuẩn Đo Lường

> **Tài liệu**: `docs/13-glossary.md` | **Phiên bản**: 2.1 | **Phạm vi**: Toàn hệ sinh thái **AIoTLibTQB**
>
> [!NOTE]
> **TL;DR**: Bảng tra cứu chuẩn hóa thuật ngữ nghiệp vụ, từ viết tắt kỹ thuật, dải đo vật lý 9 chỉ số cảm biến và quy ước định dạng dữ liệu giữa Backend Java, MongoDB 8.0, MQTT Broker và Frontend Canvas 2D.

---

## 1. Thuật Ngữ Chuyên Ngành & Kiến Trúc

| Thuật ngữ | Định nghĩa & Cơ chế trong AIoTLibTQB | Mã nguồn SSOT |
| :--- | :--- | :--- |
| **Anonymous Micro-Zone (`FE-VIZ-09`)** | Phân khu bàn đọc ẩn danh tổng hợp từ `roomTelemetry` cho `USER`/`VIEWER`/Kiosk khi `canViewDevices === false`, vừa vẽ được heatmap chi tiết vừa ẩn `hardwareId`. | `tqb-floorplan-presets.ts` |
| **Anti-Spoofing** | Đối chiếu bắt buộc `{hardwareId}` trên topic MQTT với `payload.hardware_id` để hủy mọi gói tin giả mạo danh tính trạm đo. | `MqttMessageDispatcherService` |
| **Blindspot (Vùng mù cảm biến)** | Khu vực trong phòng có độ hiện diện trường cảm biến $\text{fieldPresence} < 0.25$ do thiếu trạm đo hoặc trạm `OFFLINE`. | `weatherPalette.ts` |
| **Clamping (Kẹp ngưỡng)** | Ràng buộc giá trị đo trong dải vật lý `[Min, Max]` hoặc kẹp timestamp sai lệch (`< 2020` / `> now + 60s`) về `Instant.now()`. | `TelemetrySanitizerService`, `MqttMessageDispatcherService` |
| **Conflation `1Hz`** | Gom bản tin telemetry theo từng phòng và đẩy tối đa 1 frame/giây lên WebSocket STOMP để bảo vệ trình duyệt. | `TelemetryConflationService` |
| **Downsampling (`$dateTrunc`)** | Nén chuỗi thời gian thành bucket `15m`, `1h`, `1d` ngay trong MongoDB Aggregation Pipeline (giới hạn $\le 1000$ buckets). | `TelemetryService` |
| **Dynamic Re-weighting** | Tự động chuẩn hóa lại tỷ lệ trọng số LCS trên các cảm biến khả dụng khi có cảm biến tạm vắng dữ liệu. | `ComfortScoreService` |
| **Fair Semaphore** | Khóa đếm `Semaphore(30, true)` FIFO giới hạn 30 luồng ghi đồng thời xuống MongoDB với timeout `3000ms`. | `MqttMessageDispatcherService` |
| **Forward-Fill `30s`** | Bù giá trị hợp lệ gần nhất trong `30s` (Caffeine `fieldCache`) khi một chỉ số bị `null`/nhiễu; **loại trừ `noisePeak`**. | `TelemetrySanitizerService` |
| **FSM Alert & Hysteresis** | Máy trạng thái `NORMAL -> PENDING (30s) -> FIRING -> ACKNOWLEDGED -> RESOLVED` với trễ hồi phục `60s` + deadband chống flapping. | `AlertRuleEngine` |
| **Gaussian RBF & IDW** | Nội suy không gian 2D kết hợp hàm khuếch tán Gauss thích ứng diện tích (`computeAdaptiveSigma`) và trọng số nghịch đảo khoảng cách bậc 2. | `weatherPalette.ts`, `idw.ts` |
| **Hermite Smoothstep** | Đường cong chuyển màu $S(p) = 3p^2 - 2p^3$ trong `2.6s` giúp Canvas 2D chuyển trạng thái mượt mà không nhấp nháy. | `FloorplanCanvas.tsx` |
| **LCS (Library Comfort Score)** | Điểm tiện nghi thư viện `[0, 100]` áp dụng **Nguyên lý Thùng gỗ Liebig** (`0.30 + 0.70 * min(S_i)/S_weighted`) và 5 hạng (`Platinum`–`Poor`). | `ComfortScoreService` |
| **LOD Label Decluttering** | Phân tầng mật độ nhãn 3 mức (`clean`, `balanced`, `detailed`) và né va chạm 8 hướng trên không gian màn hình. | `labelLayout.ts` |
| **LWT (Last Will & Testament)** | Bản tin di chúc MQTT do Mosquitto tự phát lên `devices/{id}/status` khi trạm đo đứt socket TCP quá keep-alive `30s`. | `MqttMessageDispatcherService` |
| **Peak Protection** | Ngoại lệ cấm forward-fill `noisePeak` để bảo toàn bản chất xung âm thanh tức thời và tránh báo động giả. | `TelemetrySanitizerService` |
| **RTR & Single-Flight Queue** | Xoay vòng Refresh Token dùng 1 lần ở Backend kết hợp hàng đợi `SingleFlightRefreshCoordinator` ở Frontend chống bão 401. | `AuthenticationService`, `refresh-queue.ts` |
| **TimeSeries Bucket Retention** | Cơ chế nén cột của MongoDB 8.0 (`Granularity.SECONDS`) tự động xóa theo từng bucket sau **90 ngày** (`7,776,000s`). | `TelemetryRecord` |

---

## 2. Từ Viết Tắt Kỹ Thuật

| Viết tắt | Tên đầy đủ | Ý nghĩa ngắn gọn |
| :--- | :--- | :--- |
| **ABAC / RBAC** | Attribute / Role-Based Access Control | Phân quyền theo vai trò (`7 Roles × 14 Permissions`) và theo vùng (`assignedZones`) |
| **ACL** | Access Control List | Luật phân quyền topic MQTT theo `%u` trong Mosquitto (`acl.conf`) |
| **ASHRAE / ANSI** | Amer. Soc. of Heating... / Amer. Nat. Standards Inst. | Bộ tiêu chuẩn tiện nghi nhiệt (`55:2020`) và âm học (`S12.60`) |
| **CAD** | Computer-Aided Design | Bản vẽ kiến trúc AutoCAD 1:100 (`76.0m × 57.2m`) dùng làm nền 5 tầng SVG |
| **HMAC-SHA512 (`HS512`)** | Hash-based Message Authentication Code | Thuật toán ký số JWT (khóa tối thiểu 512-bit / 64 ký tự) |
| **HVAC / IAQ** | Heating, Ventilation, AC / Indoor Air Quality | Hệ thống điều hòa thông gió và chất lượng không khí trong nhà |
| **ISO / IFLA** | Int. Org. for Standardization / Int. Fed. of Library Assoc. | Tiêu chuẩn bảo tồn kho tài liệu (`ISO 11799:2015`) |
| **JTI / TTL** | JWT ID / Time To Live | Mã định danh token đưa vào blacklist `invalidated_tokens` tự hủy theo `expiryTime` |
| **MEMS / ADC** | Micro-Electro-Mechanical Systems / Analog-to-Digital | Công nghệ cảm biến vi cơ điện tử (INMP441) và chuyển đổi quang 16-bit (BH1750) |
| **MQTT / QoS 1** | Message Queuing Telemetry Transport | Giao thức pub/sub IoT nhẹ; mức QoS 1 đảm bảo giao tối thiểu 1 lần |
| **NTP / RTC** | Network Time Protocol / Real-Time Clock | Đồng bộ giờ mạng UTC và đồng hồ phần cứng trên vi điều khiển |
| **SOP** | Standard Operating Procedure | Hướng dẫn xử lý sự cố chuẩn gắn tự động vào cảnh báo (`AlertSopCatalog`) |
| **STOMP** | Simple Text Oriented Messaging Protocol | Giao thức nhắn tin thời gian thực chạy trên Native WebSocket (`/ws-aiot`) |

---

## 3. Đơn Vị Đo Lường & Quy Ước Định Dạng

- **9 chỉ số + sóng Wi-Fi**: `noiseAvg` (`dBA`, `[30, 110]`), `noisePeak` (`dBA`, `[30, 130]`), `pm1_0` / `pm2_5` / `pm4_0` / `pm10` (`µg/m³`, `[0, 1000]`), `temperature` (`°C`, `[0, 60]`), `humidity` (`%RH`, `[0, 100]`), `lux` (`Lux`, `[0, 65535]`), `wifiRssi` (`dBm`, `[-100, 0]`), `comfortScore.overall` (`điểm`, `[0, 100]`).
- **Thời gian**: Backend/MongoDB/REST dùng **UTC ISO-8601** (`Instant`); MQTT chấp nhận cả Epoch seconds (`< 10^11`) và Epoch milliseconds (`>= 10^11`).
- **JSON Naming**: REST API dùng `camelCase`; MQTT payload khuyến nghị `snake_case` (Backend tự ánh xạ cả hai qua `@JsonAlias`).
- **Hệ tọa độ 2D**: Gốc `(0.0, 0.0)` ở góc trên-trái, `(1.0, 1.0)` ở góc dưới-phải trên mặt bằng tỷ lệ `TQB_BUILDING_ASPECT_RATIO = 57.2 / 76.0`.

---

**Đọc tiếp**: [Cổng Tài liệu `docs/README.md`](./README.md) · [01 — Bài toán & Tiêu chuẩn](./01-domain-and-standards.md)
