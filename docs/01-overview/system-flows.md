# Luồng Hoạt Động Hệ Thống / End-to-End System Flows

> **Đối tượng đọc / Audience:** Product Manager, BA, Quản lý Thư viện, Kỹ sư mới làm quen kiến trúc.  
> **Cơ sở kiểm chứng / Verification:** Dựa trên [`MqttMessageDispatcherService`](../../src/main/java/com/example/AIoTLibTQB/service/MqttMessageDispatcherService.java), [`TelemetryConflationService`](../../src/main/java/com/example/AIoTLibTQB/service/TelemetryConflationService.java), [`AlertRuleEngine`](../../src/main/java/com/example/AIoTLibTQB/service/AlertRuleEngine.java), [`AlertServiceImpl`](../../src/main/java/com/example/AIoTLibTQB/service/AlertServiceImpl.java), [`RoomService`](../../src/main/java/com/example/AIoTLibTQB/service/RoomService.java) và [`PublicController`](../../src/main/java/com/example/AIoTLibTQB/controller/PublicController.java).

---

## 1. Luồng Thu Thập Dữ Liệu, Tính Điểm & Cảnh Báo Thời Gian Thực / Real-Time Telemetry, Scoring & Alert Flow

**[VI]** Khi cảm biến ngoài phòng đọc hoặc bộ giả lập gửi một gói đo qua MQTT, dữ liệu đi qua 7 bước kiểm soát chất lượng trước khi tới màn hình của người quản lý trong vòng chưa tới 1 giây.  
**[EN]** When a sensor node or simulator publishes an MQTT packet, the message passes through 7 quality-control stages before reaching the operator's screen in sub-second latency.

```mermaid
flowchart LR
    DEV["Trạm đo ESP32-S3 / Simulator\n(MQTT QoS 1: devices/id/telemetry)"] --> MOSQ["Eclipse Mosquitto Broker\n(Xác thực & ACL theo hardwareId)"]
    MOSQ --> VT["Spring Integration Inbound\n(Java 21 Virtual Threads)"]
    VT --> AUTH["1. Chống giả mạo & Định tuyến\n(Kiểm tra hardwareId & Registry)"]
    AUTH -->|Thiết bị mới chưa gán phòng| DISC["Hàng đợi Auto-Discovery\n(Cache 10 phút cho Admin duyệt)"]
    AUTH -->|Thiết bị đã kích hoạt| SAN["2. Làm sạch 3 lớp (Sanitizer)\n(Dải vật lý, Cửa sổ ồn 30s, Forward-fill 30s)"]
    SAN --> LCS["3. Động cơ LCS Liebig\n(Tính điểm 0-100 & Hạng Platinum..Poor)"]
    LCS --> DB["4. Lưu MongoDB TimeSeries\n(Semaphore 30 permits, giữ 90 ngày)"]
    LCS --> CONF["5. Gộp luồng Conflation 500ms\n(Chống nghẽn WebSocket STOMP)"]
    CONF --> WS["Màn hình Bản đồ 2D & Kiosk\n(/topic/rooms/... & /topic/public/rooms/...)"]
    LCS --> FSM["6. Bộ đánh giá Cảnh báo FSM\n(30s chờ xác nhận / 60s hồi phục)"]
    FSM -->|Vượt ngưỡng| ALERTS["WebSocket /topic/alerts\n& Email SMTP (Critical / Leo thang 10p)"]
```

---

## 2. Luồng Vận Hành & Xử Lý Sự Cố Của Quản Lý Thư Viện / Manager Incident Handling Flow

**[VI]** Khi phòng đọc chuyển sang trạng thái cảnh báo, Quản lý thư viện không cần hiểu cấu trúc cảm biến mà thao tác trực tiếp trên **Alert Inspector Drawer** của Bản đồ nhiệt 2D (`PATCH /api/v1/alerts/{id}/workflow`).  
**[EN]** When a room enters an alert state, Library Managers act directly inside the 2D Heatmap **Alert Inspector Drawer** (`PATCH /api/v1/alerts/{id}/workflow`), updating workflow state with optimistic version locking (`@Version`).

```mermaid
sequenceDiagram
    actor M as Quản lý / Manager
    participant UI as Bản đồ 2D / Alert Drawer
    participant API as AlertController & Service
    participant DB as MongoDB (alerts @Version)
    participant Mail as AlertEmailNotificationService
    participant RT as WebSocket /topic/alerts

    Note over API,Mail: Cảnh báo CRITICAL mở hoặc HIGH > 10 phút chưa ACK
    API->>Mail: Trigger email mở sự cố (cooldown phòng 30p)
    Mail-->>M: Gửi Email [KHẨN CẤP / LEO THANG] kèm hướng dẫn SOP

    M->>UI: Mở phòng cảnh báo trên Bản đồ / Cây Tầng->Phòng
    UI-->>M: Hiển thị mức độ, giá trị đo, ngưỡng & SOP đề xuất
    M->>UI: Chọn "Tiếp nhận" (ACKNOWLEDGED) + giao kỹ thuật viên + ghi chú
    UI->>API: PATCH /api/v1/alerts/{id}/workflow
    API->>DB: Kiểm tra quyền Zone + lưu trạng thái (retry optimistic lock)
    API->>RT: Phát sự kiện cập nhật tới mọi phiên đang mở
    M->>UI: Xác nhận hoàn tất (RESOLVED, snooze mặc định 15p)
    UI->>API: PATCH /api/v1/alerts/{id}/workflow (RESOLVED)
    API->>Mail: Gửi email [ĐÃ KHẮC PHỤC - RESOLVED]
```

---

## 3. Luồng Hòa Mạng Thiết Bị Mới (Plug-and-Play Auto-Discovery) / New Device Onboarding Flow

**[VI]** Đội phần cứng chỉ cần nạp firmware với `hardwareId` duy nhất và cấp nguồn; không cần cấu hình ID cơ sở dữ liệu trước khi lắp đặt tại phòng đọc.  
**[EN]** Hardware engineers only flash a unique `hardwareId` and power on the node; Admin approval binds it to a library room without pre-creating database records.

```mermaid
sequenceDiagram
    actor Tech as Kỹ thuật viên Phần cứng
    actor Admin as Quản trị / Thủ thư (ADMIN / LIBRARIAN)
    participant MQTT as Mosquitto & Backend Dispatcher
    participant Cache as DiscoveredDeviceService (10m Cache)
    participant Web as /admin/devices/discovery

    Tech->>MQTT: Cấp nguồn ESP32-S3 -> gửi telemetry/status lên MQTT
    MQTT->>Cache: hardwareId chưa có trong DB -> ghi nhận lần thấy + RSSI
    Admin->>Web: Mở trang "Thiết bị mới phát hiện"
    Web->>Admin: GET /api/v1/devices/discovered
    Admin->>Web: Chọn Phòng, Zone, Tọa độ (posX, posY) -> Bấm Đăng ký
    Web->>MQTT: POST /api/v1/devices/register
    MQTT-->>Web: Trả về rawApiKey (chỉ hiện 1 lần qua OneTimeKeyDialog)
    Note over MQTT: Từ gói MQTT kế tiếp, dữ liệu đi thẳng vào phòng & bản đồ 2D
```

---

## 4. Luồng Chỉnh Sửa Nội Thất Tỉ Lệ 1:100 & Kiosk Công Khai / 1:100 Furniture Layout & Public Kiosk Flow

**[VI]** Hệ thống tách biệt hoàn toàn quyền thiết kế mặt bằng (dành cho Kỹ thuật/Quản trị) với luồng tra cứu công khai của Sinh viên tại Kiosk sảnh thư viện (`FE-VIZ-09`).  
**[EN]** Furniture editing (for authorized staff) is isolated via versioned validation, while the Public Kiosk stream strips all hardware identifiers (`FE-VIZ-09`).

```mermaid
flowchart TD
    subgraph EDIT ["Chỉnh sửa Nội thất / Furniture Editing (ADMIN, LIBRARIAN, MAINTENANCE, MANAGE_ZONES)"]
        E1["Kéo thả/Xoay vật thể (Snap 0.25m, Undo/Redo)"] --> E2["Kiểm tra biên phòng & Chồng lấn (SAT OBB)\n(trên Client + FurnitureGeometryValidator Server)"]
        E2 --> E3["PUT /api/v1/rooms/{id}/furniture\n(gửi expectedVersion tránh ghi đè)"]
        E3 -->|Xung đột version| ERR["HTTP 409: FURNITURE_VERSION_CONFLICT (5007)"]
        E3 -->|Hợp lệ| SAVE["Lưu room_furniture_layouts + ghi auditHistory"]
    end

    subgraph KIOSK ["Kiosk Công Khai / Public Kiosk (/kiosk — Không cần đăng nhập)"]
        K1["GET /api/v1/public/rooms & /furniture"] --> K2["Lọc bỏ các phần tử nhạy cảm (IOT_NODE)\n& Ẩn hardwareId/deviceId (FE-VIZ-09)"]
        K2 --> K3["Tạo vùng bàn đọc ẩn danh (AnonymousMicroZone)\n+ Nhận STOMP /topic/public/rooms/{id}/telemetry"]
    end
```
