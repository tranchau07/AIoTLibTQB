# Tổng Quan Nghiệp Vụ & Miền Ứng Dụng / Business Overview & Domain Context

> **Đối tượng đọc / Audience:** Product Manager, Business Analyst, Quản lý Thư viện, Stakeholder, Kỹ sư mới gia nhập.  
> **Phạm vi kiểm chứng / Evidence Scope:** Quy tắc phân loại phòng, chuẩn ngưỡng môi trường, vai trò người dùng và tính năng UI được trích xuất từ mã nguồn (`RoomType.java`, `RoomThresholdConfig.java`, `ComfortScoreService.java`, `ApplicationInitConfig.java`, `frontend/src/app/`).

---

## 1. Bối Cảnh & Bài Toán / Context & Problem Statement

**[VI]** **Thư viện Tạ Quang Bửu (ĐH Bách khoa Hà Nội)** là tòa nhà học thuật đa tầng (5 tầng trong mô hình CAD `76.0m × 57.2m`) có lưu lượng sinh viên lớn cùng nhiều khu vực chức năng đối lập nhau về yêu cầu môi trường:
- **Phòng đọc sách & tự học (`STUDY_ROOM`)**: Cần sự yên tĩnh, ánh sáng đạt chuẩn đọc sách, không khí ít bụi mịn và nhiệt độ dễ chịu.
- **Kho bảo quản sách (`BOOK_STORAGE`)**: Nhạy cảm nghiêm trọng với độ ẩm cao (nguy cơ nấm mốc hư hại tài liệu) và nhiệt độ không ổn định; không yêu cầu khắt khe về ánh sáng cao hay độ ồn thấp như phòng đọc.
- **Phòng / Sảnh mượn trả (`CIRCULATION_HALL`)**: Khu vực giao dịch đông người, ngưỡng dung sai tiếng ồn và bụi mịn cao hơn.

Nếu chỉ xem từng bảng số rời rạc từ cảm biến, **Quản lý thư viện** rất khó trả lời nhanh trong vài giây: *"Tầng nào đang có phòng bất ổn? Do ồn, nóng, ẩm hay bụi? Đã có ai tiếp nhận xử lý chưa?"*. **AIoTLibTQB** giải quyết bài toán này bằng chỉ số tổng hợp **LCS (0–100)**, bản đồ nhiệt không gian 2D trực quan và luồng điều phối cảnh báo có trách nhiệm giải trình.

**[EN]** **Ta Quang Buu Library (Hanoi University of Science and Technology)** spans multiple floors (`76.0m × 57.2m` footprint across 5 CAD floors) with diverse functional zones holding conflicting environmental requirements:
- **Study Rooms (`STUDY_ROOM`)**: Require quiet acoustics, proper reading illumination, clean air, and comfortable temperature.
- **Book Storage (`BOOK_STORAGE`)**: Strictly sensitive to high humidity (mold risk to archival books) and thermal drift, while tolerant of moderate noise and dim lighting.
- **Circulation Halls (`CIRCULATION_HALL`)**: High-traffic service lobbies with wider acoustic and particulate tolerances.

Raw telemetry tables alone fail to let **Library Managers** answer within seconds: *"Which rooms need intervention right now, why, and who is handling it?"*. **AIoTLibTQB** solves this by synthesizing sensor streams into a 0–100 **Library Comfort Score (LCS)**, projecting them onto a 2D AutoCAD spatial heatmap, and driving a tracked 4-stage alert workflow.

---

## 2. Nhóm Người Dùng & Vai Trò / Actors & Target Personas

Ma trận vai trò thực tế được khởi tạo trong [`ApplicationInitConfig.java`](../../src/main/java/com/example/AIoTLibTQB/configuration/ApplicationInitConfig.java) kết hợp cổng công khai [`PublicController.java`](../../src/main/java/com/example/AIoTLibTQB/controller/PublicController.java):

| Vai trò / Role | Mô tả nghiệp vụ / Business Responsibility | Khu vực màn hình chính / Primary Screens |
| :--- | :--- | :--- |
| **Quản lý & Thủ thư chính**<br>`LIBRARIAN` / `ADMIN` | Giám sát toàn tòa nhà trên Dải tóm tắt (Summary Strip), xử lý sự cố từ Inspector Drawer, điều chỉnh ngưỡng phòng, duyệt thiết bị mới, xuất báo cáo PNG/PDF. `ADMIN` có toàn quyền IAM (user/role/permission) và chuyển góc nhìn thử vai trò. | `/floorplan`, `/dashboard`, `/alerts`, `/rooms/[id]`, `/telemetry-explorer`, `/admin/*` |
| **Thủ thư phụ trách khu vực**<br>`ZONE_MANAGER` | Giám sát dữ liệu telemetry, thiết bị và xử lý cảnh báo bị **cô lập chặt trong phạm vi `assignedZones`** được giao. | `/floorplan`, `/dashboard`, `/alerts`, `/rooms/[id]` |
| **Kỹ thuật viên bảo trì**<br>`MAINTENANCE` | Kiểm tra sức khỏe trạm đo (`ONLINE/OFFLINE`, `wifiRssi`), bật lớp **Data Reliability / Vùng mù (Blindspots)**, chỉnh sửa bố trí nội thất `1:100` (bàn, giá sách, vị trí cảm biến), xử lý sự cố thiết bị. | `/floorplan` (Tech Overlay & Furniture Editor), `/alerts`, `/admin/devices` |
| **Bạn đọc đã đăng nhập**<br>`VIEWER` / `USER` | Tra cứu độ yên tĩnh và gợi ý khu bàn đọc phù hợp (ẩn thông tin phần cứng theo quy tắc `FE-VIZ-09`). | `/floorplan`, `/dashboard`, `/rooms/[id]`, `/telemetry-explorer` |
| **Khách / Sinh viên tại Kiosk**<br>*(Public Unauthenticated)* | Xem màn hình Kiosk sảnh thư viện không cần đăng nhập: điểm LCS, nhiệt độ/ẩm/ồn và gợi ý khu vực đọc bài (ẩn hoàn toàn dữ liệu thiết bị & nhật ký bảo trì). | `/kiosk` |
| **Trạm cảm biến phần cứng**<br>`DEVICE` *(Machine Account)* | Gửi telemetry, heartbeat và trạng thái LWT thông qua MQTT hoặc REST API thiết bị; bị chặn đọc API phòng đọc/người dùng. | MQTT Broker `:1883`, `/api/v1/devices/authenticate` |

---

## 3. Tính Năng Cốt Lõi Theo Góc Nhìn Sản Phẩm / Core Product Capabilities

1. **Giám sát Bản đồ Nhiệt Không gian 2D (Spatial Heatmap 2D — `/floorplan`)**
   - **[VI]** Hiển thị 5 bản vẽ AutoCAD SVG chuẩn tỉ lệ thực `76.0m × 57.2m` (33 preset phòng), dải tóm tắt quản lý (số phòng Tốt / Lưu ý / Xấu, tổng cảnh báo mở, cảnh báo tồn đọng quá 15 phút), cây điều hướng `Tầng → Phòng` đồng bộ 2 chiều, Semantic Zoom 3 cấp (`Overview → Intermediate → Detail`), gom cụm cảm biến khi thu nhỏ, bảng màu thân thiện người mù màu kèm 4 ký hiệu hình học (`● ▲ ◆ ○`).
   - **[EN]** Renders 5 scaled `76.0m × 57.2m` AutoCAD SVG floorplans (33 room presets) with a top Manager Summary Strip, two-way `Floor → Room` navigation tree, 3-tier Semantic Zoom, node clustering, and colorblind-safe palettes paired with 4 geometric status symbols (`● ▲ ◆ ○`).
2. **Phân tích Thời gian & Trình Bày Báo cáo / Time Comparison & Reporting**
   - **[VI]** So sánh trực tiếp với `-1 giờ` (`compare_1h`), phát lại sự kiện lan truyền (`playback`), mô phỏng *Ngày điển hình* (`typical_day`), liên kết sâu URL 2 chiều (Deep Link) và xuất ảnh `PNG` / báo cáo `PDF`.
   - **[EN]** Supports `-1h` delta comparison, event propagation playback, typical-day profiles, shareable 2-way URL deep links, and one-click `PNG` / `PDF` export.
3. **Bố trí Nội thất Tỉ lệ 1:100 & Độ Tin Cậy Dữ Liệu / 1:100 Furniture Layout & Data Reliability**
   - **[VI]** Kỹ thuật viên/Quản trị chỉnh sửa vị trí bàn, ghế, giá sách, quầy, PC, cửa và trạm IoT ngay trên bản đồ (snap lưới `0.25m`, chống chồng lấn, lưu lịch sử phiên bản). Lớp chẩn đoán 4 trạng thái (`Đo trực tiếp`, `Ước lượng`, `Vùng mù`, `Dữ liệu cũ`) cho thấy nơi nào thiếu cảm biến phủ sóng.
   - **[EN]** Authorized roles edit 1:100 room furniture layouts (0.25m snap, overlap prevention, optimistic version audit log). A 4-state Data Reliability overlay flags `Measured`, `Interpolated`, `Blindspot`, and `Stale` areas.
4. **Động cơ Cảnh báo & Điều phối Sự cố / Alert Engine & 4-Step Incident Workflow**
   - **[VI]** Lọc nhiễu bằng bộ đếm bền vững `30s` và hồi phục chống rung `60s`; phân cấp mức độ `LOW / MEDIUM / HIGH / CRITICAL`; gắn sẵn hướng dẫn xử lý chuẩn (**SOP**); theo dõi 4 bước `Mới (NEW) → Đã tiếp nhận (ACKNOWLEDGED) → Đang xử lý (IN_PROGRESS) → Đã đóng (RESOLVED)` kèm người phụ trách, ghi chú và leo thang Email SMTP cho cảnh báo nghiêm trọng.
   - **[EN]** Anti-flapping FSM (`30s` sustain, `60s` recovery hysteresis), 4 severity ranks (`LOW..CRITICAL`), automated SOP action guides, 4-stage incident workflow (`NEW → ACKNOWLEDGED → IN_PROGRESS → RESOLVED`) with assignee tracking and automated SMTP email escalation.

---

## 4. Quy Chuẩn Môi Trường Áp Dụng Trong Code / Standards Implemented in Code

Bảng dưới đây đối chiếu chuẩn quốc tế được trích dẫn trong [`ComfortScoreService.java`](../../src/main/java/com/example/AIoTLibTQB/service/ComfortScoreService.java), cấu hình ngưỡng mặc định lưu ở [`RoomThresholdConfig.java`](../../src/main/java/com/example/AIoTLibTQB/document/RoomThresholdConfig.java) và luật phát cảnh báo tự động thực thi tại [`AlertRuleEngine.java`](../../src/main/java/com/example/AIoTLibTQB/service/AlertRuleEngine.java):

| Loại phòng (`RoomType`) | Tham chiếu chuẩn / Referenced Standards | Độ ồn TB / Đỉnh (`dBA`) | Nhiệt độ (`°C`) | Độ ẩm (`%RH`) | Bụi mịn `PM2.5` (`µg/m³`) | Ánh sáng tối ưu (`Lux`) |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| `STUDY_ROOM` *(Phòng đọc)* | ANSI/ASA S12.60, EN 12464-1, ASHRAE 55 | Cảnh báo `> 65` / `> 75` (tức thời `≥ 85`) | Tối ưu `23.5–25.5`<br>Cấu hình `18.0–32.0` *(Backend tự kích hoạt alert khi `> 32.0`)* | Tối ưu `40–60`<br>Cấu hình `35–70` *(không kích hoạt alert tự động trên phòng đọc)* | Cảnh báo `> 50` (tối ưu `≤ 10`) | `400–600` |
| `BOOK_STORAGE` *(Kho sách)* | ISO 11799, IFLA | Cảnh báo `> 70` / `> 80` (tức thời `≥ 85`) | Tối ưu `18.0–22.0`<br>Cấu hình `18.0–24.0` *(Backend tự kích hoạt alert khi `> 24.0`)* | Tối ưu `45–55`<br>**Cảnh báo tự động `< 45` hoặc `> 60`** | Cảnh báo `> 35` (tối ưu `≤ 10`) | `≤ 100` *(chống phai mực/giấy)* |
| `CIRCULATION_HALL` *(Sảnh mượn trả)* | Thực tế vận hành dịch vụ bạn đọc | Cảnh báo `> 70` / `> 80` (tức thời `≥ 85`) | Tối ưu `24.0–26.5`<br>Cấu hình `20.0–32.0` *(Backend tự kích hoạt alert khi `> 32.0`)* | Tối ưu `40–65`<br>Cấu hình `35–70` *(không kích hoạt alert tự động trên sảnh)* | Cảnh báo `> 50` (tối ưu `≤ 15`) | `300–500` |

> **Lưu ý từ [`AlertRuleEngine.java:410-452`](../../src/main/java/com/example/AIoTLibTQB/service/AlertRuleEngine.java):** Động cơ cảnh báo tự động Backend hiện chỉ bắn cảnh báo nhiệt độ chiều vượt trần (`temp > tempMax`) và **chỉ bắn cảnh báo độ ẩm (`HUMIDITY_HIGH` / `HUMIDITY_LOW`) đối với phòng loại `BOOK_STORAGE`**; các mốc cận dưới (`tempMin` và `humidity` ở `STUDY_ROOM`/`CIRCULATION_HALL`) phục vụ chấm điểm LCS và đánh giá trạng thái trực quan trên Heatmap UI (`weatherPalette.ts`).

---

## 5. Thông Tin Nghiệp Vụ Cần Bổ Sung / Business Information Pending Confirmation

- `[CẦN BỔ SUNG / TO BE ADDED: Mục tiêu KPI & SLA vận hành chính thức của Thư viện Tạ Quang Bửu — ví dụ: thời gian phản hồi tối đa khi có cảnh báo HIGH/CRITICAL, thời gian trực ca kỹ thuật và chủ sở hữu quy trình bàn giao thực địa.]`
- `[CẦN BỔ SUNG / TO BE ADDED: Quy trình đào tạo thủ thư và danh mục phân khu Zone vật lý chính thức khi đưa vào vận hành toàn bộ 33 phòng trên 5 tầng.]`
