# Từ Điển Thuật Ngữ & Quy Chuẩn / Glossary & Standards

> **Đối tượng đọc / Audience:** Toàn bộ thành viên dự án (Non-tech & Kỹ sư).  
> **Phạm vi / Scope:** Chuẩn hóa thuật ngữ nghiệp vụ thư viện, thuật ngữ IoT/kiến trúc phần mềm và đơn vị đo lường được dùng nhất quán trong code và giao diện.

---

## 1. Thuật Ngữ Nghiệp Vụ & Miền Ứng Dụng / Domain & Operational Terms

| Thuật ngữ / Term | Giải thích Tiếng Việt | English Definition |
| :--- | :--- | :--- |
| **Vi khí hậu (Microclimate)** | Tập hợp các thông số vật lý môi trường trong nhà ảnh hưởng trực tiếp tới sức khỏe con người và tuổi thọ sách: nhiệt độ (`°C`), độ ẩm (`%RH`), ánh sáng (`Lux`) và bụi mịn (`PM`). | Indoor environmental conditions affecting occupant comfort and collection preservation: temperature (`°C`), humidity (`%RH`), illuminance (`Lux`), and particulate matter (`PM`). |
| **LCS (Library Comfort Score)** | Chỉ số tiện nghi tổng hợp thang `0–100` (5 hạng: `Platinum`, `Gold`, `Silver`, `Bronze`, `Poor`), tính theo **Nguyên lý Thùng gỗ Liebig** để yếu tố tệ nhất kéo điểm chung xuống thay vì bù trừ tuyến tính. | Composite comfort index (`0–100`, graded `Platinum..Poor`) calculated via a non-linear **Liebig bottleneck formula** so one severe flaw cannot be masked by averages. |
| **Vùng mù cảm biến (Blindspot)** | Khu vực trên mặt bằng phòng có mật độ phủ cảm biến dưới ngưỡng (`fieldPresence < 0.25`) hoặc trạm phụ trách bị `OFFLINE`, khiến số liệu hiển thị không còn đo trực tiếp. | Spatial sub-area in a room where sensor coverage falls below threshold (`fieldPresence < 0.25`) or stations go `OFFLINE`, marked in diagnostic overlays. |
| **Chống rung cảnh báo (Anti-Flapping / Hysteresis)** | Cơ chế yêu cầu chỉ số phải vượt ngưỡng liên tục trong `30s` (`PENDING → FIRING`) và hạ dưới ngưỡng an toàn trừ dải deadband liên tục `60s` (`RESOLVED`) để tránh bật/tắt cảnh báo liên tục. | State-machine debouncing requiring `30s` sustained breach (`PENDING → FIRING`) and `60s` recovery within a deadband before auto-resolving alerts. |
| **Snooze cảnh báo (Tạm hoãn sau đóng)** | Khi người dùng đóng cảnh báo thủ công, hệ thống tạm chặn không mở lại cùng cảnh báo đó trong thời gian chọn (`0–240` phút, mặc định `15` phút). | Temporary suppression window (`0–240` minutes, default `15m`) applied after manual alert resolution to prevent immediate re-triggering. |
| **SOP (Standard Operating Procedure)** | Hướng dẫn thao tác chuẩn gắn tự động vào mỗi cảnh báo theo từng loại phòng và chỉ số (tra cứu từ `AlertSopCatalog`). | Standardized remediation instructions attached automatically to alerts based on metric type and room profile (`AlertSopCatalog`). |
| **Ẩn danh Bàn đọc (`FE-VIZ-09`)** | Quy tắc bảo mật trên trang `/kiosk` và tài khoản `USER/VIEWER`: ẩn mã trạm phần cứng (`hardwareId`, trạng thái online/offline, nút cảm biến) và chỉ hiển thị phân khu bàn đọc ẩn danh. | Privacy/security rule on `/kiosk` and `USER/VIEWER` views: hides hardware IDs, device status, and `IOT_NODE` furniture items while keeping anonymous study bays visible. |

---

## 2. Thuật Ngữ Kiến Trúc & Công Nghệ / Architecture & Technical Terms

| Thuật ngữ / Term | Giải thích Tiếng Việt | English Definition |
| :--- | :--- | :--- |
| **MQTT & LWT** | Giao thức nhắn tin IoT nhẹ qua TCP (`:1883`). **LWT (Last Will and Testament)** là bản tin "di chúc" Broker tự phát khi trạm đo mất kết nối đột ngột. | Lightweight pub/sub IoT protocol over TCP (`:1883`). **LWT** lets the Mosquitto broker publish an `offline` status message automatically on abrupt client disconnect. |
| **STOMP over WebSocket** | Giao thức truyền khung sự kiện 2 chiều trên endpoint `/ws-aiot` giúp đẩy số liệu phòng và cảnh báo xuống trình duyệt theo thời gian thực. | Messaging sub-protocol over WebSocket (`/ws-aiot`) streaming real-time room telemetry and alert updates to connected browsers. |
| **Telemetry Conflation (2Hz)** | Kỹ thuật gom các bản tin telemetry rời rạc trong bộ đệm RAM và phát theo nhịp cố định mỗi **`500ms` (`2Hz`)** qua STOMP nhằm tránh quá tải trình duyệt. | Buffering rapid sensor frames and emitting coalesced room updates at a steady **`500ms` (`2Hz`)** cadence over STOMP to prevent UI overload. |
| **Gaussian RBF & IDW** | Hai phương pháp nội suy không gian trên Bản đồ nhiệt 2D: **IDW** (nghịch đảo bình phương khoảng cách) và **Gaussian RBF** thích ứng bán kính $\sigma$ theo diện tích phòng. | Spatial interpolation algorithms used on the 2D Canvas heatmap: inverse-distance weighting (**IDW**) and area-adaptive **Gaussian RBF** diffusion. |
| **Semantic Zoom & LOD** | Tự động thay đổi chi tiết hiển thị trên bản đồ theo mức phóng to: `Overview` (gom cụm) $\to$ `Intermediate` $\to$ `Detail` (hiện bàn đọc & nhãn đầy đủ). | Progressive level-of-detail switching across 3 zoom tiers (`Overview`, `Intermediate`, `Detail`) to avoid label clutter. |
| **Optimistic Locking (`@Version`)** | Khóa lạc quan sử dụng trường version trên `alerts` và `room_furniture_layouts` để ngăn hai người dùng ghi đè công sức của nhau (trả HTTP `409` mã `5007` khi xung đột). | Concurrency control via `@Version` fields on `alerts` and `room_furniture_layouts`, preventing silent overwrites (HTTP `409`, code `5007`). |
| **Refresh Token Rotation (RTR)** | Cơ chế bảo mật làm mới JWT theo từng lần dùng một: mỗi lần đổi refresh token, token cũ bị đưa ngay vào danh sách đen TTL (`invalidated_tokens`). | Security pattern invalidating each used refresh token in a TTL MongoDB blacklist (`invalidated_tokens`) upon issuing a new token pair. |
| **ABAC (`assignedZones`)** | Kiểm soát truy cập dựa trên thuộc tính: giới hạn nhân sự không phải `ADMIN` chỉ xem/xử lý cảnh báo thuộc các `zoneId` được cấp. | Attribute-Based Access Control restricting non-`ADMIN` staff to alerts within their assigned `assignedZones` set. |

---

## 3. Quy Chuẩn Đo Lường & Hệ Tọa Độ / Measurement Units & Coordinate System

| Đại lượng / Dimension | Đơn vị / Unit | Quy ước chuẩn trong hệ thống / System Convention |
| :--- | :---: | :--- |
| **Độ ồn / Acoustic Level (`noise_avg`, `noise_peak`)** | `dBA` | Trọng số tần số A theo thính giác người; dải hợp lệ `[30.0, 110.0]` (`noiseAvg`) và `[30.0, 130.0]` (`noisePeak`). |
| **Bụi mịn / Particulate Matter (`pm1_0..pm10`)** | `µg/m³` | Dải hợp lệ `[0.0, 1000.0]`. |
| **Nhiệt độ / Temperature** | `°C` | Độ Celsius; dải hợp lệ `[0.0, 60.0]`. |
| **Độ ẩm / Relative Humidity** | `%RH` | Phần trăm thang `0.0–100.0`. |
| **Độ rọi sáng / Illuminance (`lux`)** | `Lux` (`lx`) | Dải hợp lệ `[0.0, 65535.0]`. |
| **Tín hiệu Wi-Fi (`wifi_rssi`)** | `dBm` | Số nguyên âm (thực tế thường `-90` đến `-30` dBm). |
| **Thời gian trao đổi API / API Timestamp** | `ISO-8601 UTC` | Chuỗi UTC từ REST/STOMP; tầng UI chuyển sang múi giờ `Asia/Ho_Chi_Minh`. |
| **Hệ tọa độ Bản đồ 2D / 2D CAD Coordinates** | Chuẩn hóa `[0.0, 1.0]` & Mét (`m`) | Gốc `(0.0, 0.0)` ở góc trên-trái mặt bằng tỷ lệ `76.0m × 57.2m` (`aspect = 57.2 / 76.0`); kích thước nội thất lưu bằng mét thực (`widthM × depthM`). |
