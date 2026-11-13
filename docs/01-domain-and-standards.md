# 01 — Bài Toán Nghiệp Vụ & Tiêu Chuẩn Môi Trường

> **Tài liệu**: `docs/01-domain-and-standards.md` | **Phiên bản**: 2.1 | **Mã nguồn chính**: `ComfortScoreService`, `RoomThresholdConfig`, `ApplicationInitConfig`
>
> [!NOTE]
> **TL;DR**: **AIoTLibTQB** giải quyết bài toán kép tại Thư viện Tạ Quang Bửu (ĐH Bách khoa Hà Nội): **bảo tồn kho tài liệu quý** khỏi nồm ẩm/nhiệt/ánh sáng theo ISO 11799 và **duy trì tiện nghi học tập** theo ASHRAE 55, WHO, ANSI S12.60 và TCVN. Hệ thống phân loại không gian thành 3 `RoomType` trên mô hình số hóa **5 tầng CAD (`Tầng 1`–`Tầng 5`)** của tòa nhà 10 tầng thực tế.

---

## 1. Bối cảnh & Bài toán Kép tại Thư viện Tạ Quang Bửu

Thư viện Tạ Quang Bửu (TQB) là tòa nhà **10 tầng vật lý** với hơn $20.000\,\text{m}^2$ sàn phục vụ hàng chục nghìn sinh viên, học viên cao học và giảng viên. Trong hệ thống **AIoTLibTQB**, khối không gian phục vụ bạn đọc và lưu trữ trọng điểm được số hóa thành **5 mặt bằng tầng chuẩn CAD 1:100 (`Tầng 1` → `Tầng 5`)** với 33 không gian định sẵn ở Frontend và 14 phòng / 23 thiết bị mẫu trong Simulator.

Hệ thống phải đồng thời giải quyết hai thách thức đối lập nhau:
1. **Bảo tồn tài liệu học thuật quý hiếm dưới khí hậu nhiệt đới ẩm Hà Nội**: Độ ẩm mùa nồm thường vượt 90% RH; khi kho lưu trữ vượt 55–60% RH kết hợp nhiệt độ > $22^\circ\text{C}$, nấm mốc (*Aspergillus*, *Penicillium*) phát triển và phản ứng thủy phân axit tăng tốc theo định luật Arrhenius. Bức xạ ánh sáng > 100 Lux thúc đẩy quang oxy hóa làm phai mực và ố vàng giấy.
2. **Bảo vệ tập trung sâu (*Deep Work*) và sức khỏe hô hấp tại phòng đọc mở**: Tiếng ồn xung kích (kéo ghế, nói chuyện) và bụi mịn $\text{PM}_{2.5}$ tích tụ trong phòng điều hòa kín làm suy giảm hiệu suất học tập. Nếu chấm điểm kiểu trung bình cộng thông thường, một phòng cực ồn vẫn có thể nhận điểm cao giả tạo — đây là lý do hệ thống áp dụng **Nguyên lý Thùng gỗ Liebig** ([`docs/03-lcs-algorithm.md`](./03-lcs-algorithm.md)).

---

## 2. Phân loại 3 `RoomType` & Tiêu chuẩn Tham chiếu

Mọi phòng (`Room`) trong hệ thống mang thuộc tính `RoomType` quyết định cả **bộ hàm chấm điểm LCS** (`ComfortScoreService`) lẫn **bộ ngưỡng cảnh báo động mặc định** (`RoomThresholdConfig#defaultFor`):

| `RoomType` | Không gian áp dụng | Tiêu chuẩn Tham chiếu | Mục tiêu Vi khí hậu Cốt lõi | Ngưỡng Cảnh báo Mặc định (`RoomThresholdConfig`) |
| :--- | :--- | :--- | :--- | :--- |
| **`STUDY_ROOM`** | Phòng đọc yên tĩnh, tự học, phòng học nhóm, Multimedia | **ASHRAE 55:2020**<br>**ANSI/ASA S12.60**<br>**WHO 2021** | - Âm học: $L_{\text{avg}} \le 35$ dBA tối ưu<br>- Nhiệt độ: $23.5 - 25.5^\circ\text{C}$; Ẩm: $40 - 60\%$ RH<br>- $\text{PM}_{2.5} \le 10\,\mu\text{g/m}^3$; Sáng: $400 - 600$ Lux | `noiseAvgMax = 65.0` dBA<br>`noisePeakMax = 75.0` / `Immediate = 85.0` dBA<br>`tempMax = 32.0` °C, `pm25Max = 50.0` µg/m³ |
| **`BOOK_STORAGE`** | Kho sách tự chọn, kho tài liệu quý, Phòng Truyền thống | **ISO 11799:2015**<br>**IFLA Guidelines** | - Nhiệt độ: $18.0 - 22.0^\circ\text{C}$ (phạt nặng $12$đ/$^\circ\text{C}$)<br>- Ẩm: $45 - 55\%$ RH (chống mốc & giòn giấy)<br>- Ánh sáng: $\le 100$ Lux (chống bạc mực) | `noiseAvgMax = 70.0` dBA<br>`noisePeakMax = 80.0` / `Immediate = 85.0` dBA<br>`tempMax = 24.0` °C, `pm25Max = 35.0` µg/m³<br>**Giám sát ẩm kho sách**: `humidityMin = 45.0%`, `humidityMax = 60.0%` |
| **`CIRCULATION_HALL`** | Sảnh mượn trả, cửa kiểm soát, hành lang trung tâm, căng tin | **ASHRAE 55:2020**<br>**TCVN 7114-1:2008**<br>**QCVN 26:2016/BTNMT** | - Chịu ồn tốt hơn: $L_{\text{avg}} \le 50$ dBA tối ưu<br>- Nhiệt độ: $24.0 - 26.5^\circ\text{C}$; Ẩm: $40 - 65\%$ RH<br>- Ánh sáng: $300 - 500$ Lux | `noiseAvgMax = 70.0` dBA<br>`noisePeakMax = 80.0` / `Immediate = 85.0` dBA<br>`tempMax = 32.0` °C, `pm25Max = 50.0` µg/m³ |

> [!TIP]
> **Quy chuẩn Việt Nam & Quốc tế đối chiếu**:
> - **TCVN 4601:2012 & TCVN 5687:2024**: Yêu cầu vi khí hậu & thông gió điều hòa không khí cho công trình công cộng.
> - **TCVN 7114-1:2008 & EN 12464-1**: Độ rọi nơi làm việc và đọc sách trong nhà ($300 - 500$ Lux).
> - **QCVN 26:2016/BTNMT & QCVN 05:2023/BTNMT**: Quy chuẩn kỹ thuật quốc gia về tiếng ồn và chất lượng không khí xung quanh ($\text{PM}_{2.5}$).

---

## 3. Phạm vi Hệ thống (In-Scope & Out-of-Scope)

| Trong phạm vi (**In-Scope**) | Ngoài phạm vi (**Out-of-Scope**) |
| :--- | :--- |
| Thu nạp 9 chỉ số cảm biến IoT qua MQTT QoS 1 (chu kỳ chuẩn 5s–30s). | Điều khiển đóng/ngắt trực tiếp hệ thống HVAC, điều hòa hay đèn tòa nhà. |
| Làm sạch ngưỡng vật lý, forward-fill `30s` (trừ `noisePeak`), kẹp timestamp. | Ghi âm nội dung đàm thoại hoặc camera AI nhận diện khuôn mặt (bảo vệ quyền riêng tư). |
| Lưu trữ TimeSeries 90 ngày trên MongoDB 8.0 và downsampling `$dateTrunc`. | Quản lý nghiệp vụ lưu thông mượn/trả sách (ILS) hoặc cổng từ RFID. |
| Động cơ LCS phi tuyến Liebig & Alert FSM thích ứng theo từng phòng (`SOP Catalog`). | Dự báo thời tiết vĩ mô ngoài trời hoặc thanh toán dịch vụ thư viện. |
| Bản đồ nhiệt 2D CAD 5 tầng, Cổng Kiosk công khai và RBAC 7 vai trò. | — |

---

## 4. Tóm tắt Các Bên Liên quan & Vai trò Vận hành

Hệ thống phục vụ 8 nhóm đối tượng (chi tiết phân quyền từng endpoint xem tại [`docs/06-security-and-rbac.md`](./06-security-and-rbac.md)):

| Vai trò | Mục tiêu Nghiệp vụ chính | Kênh Tương tác chính |
| :--- | :--- | :--- |
| **`ADMIN`** | Quản trị toàn quyền user, role/permission, cấu hình phòng, ngưỡng, xóa phòng/thiết bị, kiểm thử mọi góc nhìn UI. | `/admin/users`, `/admin/roles`, `/floorplan` |
| **`LIBRARIAN`** | Quản trị danh mục phòng/đa giác, duyệt thiết bị từ hàng đợi discovery, cấu hình ngưỡng cảnh báo, xử lý cảnh báo toàn thư viện. | `/admin/rooms`, `/admin/devices`, `/alerts`, `/floorplan` |
| **`ZONE_MANAGER`** | Giám sát và tiếp nhận cảnh báo giới hạn trong các phân khu được giao (`assignedZones`). | `/dashboard`, `/floorplan`, `/alerts` |
| **`MAINTENANCE`** | Theo dõi sức khỏe trạm (`ONLINE/OFFLINE`, `wifiRssi`), kiểm tra vùng mù cảm biến và lệch nhiệt $\Delta T$ điều hòa. | `/floorplan` (Tech Overlay), `/admin/devices`, `/alerts` |
| **`VIEWER` / `USER`** | Tra cứu phòng đọc yên tĩnh, điểm LCS, gợi ý phân khu bàn đọc ẩn danh và biểu đồ chất lượng không khí. | `/dashboard`, `/floorplan`, `/rooms/[id]`, `/telemetry-explorer` |
| **`PUBLIC_GUEST`** | Sinh viên/khách xem bảng tin Kiosk sảnh Tầng 1 không cần đăng nhập (ẩn hoàn toàn thông tin phần cứng). | `/kiosk` + `/api/v1/public/**` + STOMP `/topic/public/rooms/**` |
| **`DEVICE`** | Mạch ESP32-S3 gửi telemetry, trạng thái LWT qua MQTT và gọi `authenticate`/`heartbeat` REST API. | MQTT Broker (`:1883`) + `/api/v1/devices/authenticate` |

> **Dẫn chiếu lưu trữ nghiệp vụ gốc**: Các tài liệu phân tích bối cảnh ban đầu được lưu tại `docs/archive/business/`.
