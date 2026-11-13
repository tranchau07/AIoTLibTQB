# 03 — Thuật Toán Điểm Tiện Nghi Thư Viện (Library Comfort Score — LCS)

> **Tài liệu**: `docs/03-lcs-algorithm.md` | **Phiên bản**: 2.1 | **Mã nguồn SSOT**: [`ComfortScoreService.java`](../src/main/java/com/example/AIoTLibTQB/service/ComfortScoreService.java)
>
> [!NOTE]
> **TL;DR**: **LCS** chấm điểm không gian thư viện trên thang `0.0 – 100.0` qua 4 bước: (1) Chuẩn hóa từng nhóm chỉ số $S_i$ bằng hàm piece-wise linear theo `RoomType`, (2) Tái phân bổ trọng số động khi khuyết cảm biến, (3) Áp dụng **Nguyên lý Thùng gỗ Liebig** $\text{LCS} = S_{\text{weighted}} \times (0.30 + 0.70 \times \min(S_i)/S_{\text{weighted}})$ để chống bù trừ điểm ảo, và (4) Xếp 5 hạng (`Platinum`, `Gold`, `Silver`, `Bronze`, `Poor`).

---

## 1. Tại sao dùng Nguyên lý Thùng gỗ Liebig?

Nếu tính trung bình cộng gia quyền $S_{\text{weighted}} = \sum w_i S_i$, một phòng đọc hoàn hảo về không khí/nhiệt độ/ánh sáng ($100$đ) nhưng ồn $85\text{ dBA}$ ($0$đ) vẫn đạt $0.35\times 0 + 0.30\times 100 + 0.20\times 100 + 0.15\times 100 = 65.0\text{ đ}$ (*Silver*) dù thực tế không thể ngồi học.

`ComfortScoreService#calculate` khắc phục bằng **Liebig Non-linear Gating**:
$$\text{bottleneckRatio} = \operatorname{clamp}_{[0,1]}\left(\frac{\min_{i \in \text{avail}} S_i}{S_{\text{weighted}}}\right), \qquad \text{LCS} = \operatorname{clamp}_{[0,100]}\left(S_{\text{weighted}} \times \left(0.30 + 0.70 \times \text{bottleneckRatio}\right)\right)$$

Với ví dụ phòng ồn $85\text{ dBA}$ ở trên ($\min S_i = 0$): $\text{bottleneckRatio} = 0 \Rightarrow \text{LCS} = 65.0 \times 0.30 = \mathbf{19.5\text{ đ}}$ (*Poor*), phản ánh chính xác nút cổ chai nghiêm trọng nhất. Kết quả được làm tròn 1 chữ số thập phân (`RoundingMode.HALF_UP`).

---

## 2. Trọng số Cơ sở & Tái phân bổ Động (Dynamic Re-weighting)

Mỗi `RoomType` sử dụng vector trọng số cơ sở $w_{\text{base}}$ khác nhau (`ComfortScoreService#getBaseWeights`):

| Thành phần ($S_i$) | Chỉ số đầu vào | `STUDY_ROOM` | `BOOK_STORAGE` | `CIRCULATION_HALL` |
| :--- | :--- | :---: | :---: | :---: |
| **$S_{\text{acoustic}}$** (Âm học) | `noiseAvg`, `noisePeak` | `0.35` | `0.05` | `0.20` |
| **$S_{\text{air}}$** (Không khí) | `pm2_5` | `0.30` | `0.30` | `0.30` |
| **$S_{\text{thermal}}$** (Nhiệt ẩm) | `temperature`, `humidity` | `0.20` | `0.50` | `0.25` |
| **$S_{\text{light}}$** (Chiếu sáng) | `lux` | `0.15` | `0.15` | `0.25` |

Khi một hoặc nhiều cảm biến tạm vắng dữ liệu (trả về `null` sau khi qua bộ lọc forward-fill `30s`), trọng số của các nhóm còn lại được chuẩn hóa tự động theo tổng trọng số khả dụng:
$$S_{\text{weighted}} = \sum_{i \in \text{avail}} \frac{w_i}{\sum_{j \in \text{avail}} w_j} \cdot S_i$$
*(Nếu cả 4 nhóm đều `null`, hàm trả về `null`.)*

---

## 3. Công thức Chuẩn hóa 4 Thành phần ($S_i \in [0, 100]$)

### 3.1. Điểm Âm học ($S_{\text{acoustic}}$)

Hàm `ComfortScoreService#calculateAcousticScore`:

- **`STUDY_ROOM`**:
  - Điểm nền theo $L_{\text{avg}}$ (dBA):
    - $\le 35$: `100`
    - $(35, 55]$: `100 - (lAvg - 35) * 1.5` (giảm về `70`)
    - $(55, 70]$: `70 - (lAvg - 55) * (40/15)` (giảm về `30`)
    - $(70, 80]$: `30 - (lAvg - 70) * 3.0` (giảm về `0`)
    - $> 80$: `0`
  - **Phạt xung đỉnh ($L_{\text{peak}}$)**: Nếu `noisePeak > 70.0` dBA $\Rightarrow \text{penalty} = \min(20.0,\ L_{\text{peak}} - 70.0)$, $S_{\text{acoustic}} = \max(0.0,\ \text{base} - \text{penalty})$.
- **`BOOK_STORAGE`**: $\le 60 \Rightarrow 100$; $(60, 85] \Rightarrow \max(0,\ 100 - (L_{\text{avg}} - 60) \times 4.0)$; $> 85 \Rightarrow 0$ *(không phạt `noisePeak`)*.
- **`CIRCULATION_HALL`**: $\le 50 \Rightarrow 100$; $(50, 65] \Rightarrow 100 \rightarrow 80$; $(65, 75] \Rightarrow 80 \rightarrow 40$; $(75, 85] \Rightarrow 40 \rightarrow 0$; $> 85 \Rightarrow 0$. Nếu `noisePeak > 80.0` $\Rightarrow \text{penalty} = \min(15.0,\ L_{\text{peak}} - 80.0)$.

### 3.2. Điểm Không khí ($S_{\text{air}}$ — dựa trên $\text{PM}_{2.5}$, $\mu\text{g/m}^3$)

Hàm `ComfortScoreService#calculateAirScore`:

- **`STUDY_ROOM` & `BOOK_STORAGE`**:
  - $\le 10 \Rightarrow 100$
  - $(10, 15] \Rightarrow 100 - (\text{pm25} - 10) \times 3.0$ (`100` → `85`)
  - $(15, 35] \Rightarrow 85 - (\text{pm25} - 15) \times 1.25$ (`85` → `60`)
  - $(35, 55] \Rightarrow 60 - (\text{pm25} - 35) \times 1.5$ (`60` → `30`)
  - $(55, 100] \Rightarrow \max(0,\ 30 - (\text{pm25} - 55) \times \frac{30}{45})$ (`30` → `0`)
  - $> 100 \Rightarrow 0$
- **`CIRCULATION_HALL`**: $\le 15 \Rightarrow 100$; $(15, 25] \Rightarrow 100 \rightarrow 85$; $(25, 45] \Rightarrow 85 \rightarrow 60$; $(45, 65] \Rightarrow 60 \rightarrow 30$; $(65, 100] \Rightarrow 30 \rightarrow 0$; $> 100 \Rightarrow 0$.

### 3.3. Điểm Nhiệt ẩm ($S_{\text{thermal}}$)

Hàm `ComfortScoreService#calculateThermalScore` tính $S_T$ và $S_{RH}$ độc lập (nếu chỉ có 1 chỉ số thì lấy trực tiếp điểm đó):

| `RoomType` | Vùng tối ưu $S_T = 100$ & hệ số phạt | Vùng tối ưu $S_{RH} = 100$ & hệ số phạt | Tổ hợp $S_{\text{thermal}}$ |
| :--- | :--- | :--- | :--- |
| **`STUDY_ROOM`** | $[23.5,\ 25.5]^\circ\text{C}$; lệch phạt `8.0`/°C | $[40,\ 60]\%$; lệch phạt `2.0`/% | $0.70\,S_T + 0.30\,S_{RH}$ |
| **`BOOK_STORAGE`** | $[18.0,\ 22.0]^\circ\text{C}$; dưới phạt `5.0`/°C, trên phạt **`12.0`/°C** | $[45,\ 55]\%$; dưới phạt `3.0`/%, trên phạt **`6.0`/%** | $0.50\,S_T + 0.50\,S_{RH}$ |
| **`CIRCULATION_HALL`** | $[24.0,\ 26.5]^\circ\text{C}$; lệch phạt `8.0`/°C | $[40,\ 65]\%$; lệch phạt `2.0`/% | $0.60\,S_T + 0.40\,S_{RH}$ |

### 3.4. Điểm Chiếu sáng ($S_{\text{light}}$ — dựa trên `lux`)

Hàm `ComfortScoreService#calculateLightScore`:

- **`STUDY_ROOM`**: $[400, 600] \Rightarrow 100$; $[50, 400) \Rightarrow \frac{\text{lux} - 50}{3.5}$ ($\le 50 \Rightarrow 0$); $(600, 1200] \Rightarrow 100 \rightarrow 50$; $(1200, 2000] \Rightarrow 50 \rightarrow 0$; $> 2000 \Rightarrow 0$.
- **`BOOK_STORAGE`**: $\le 100 \Rightarrow 100$; $(100, 200] \Rightarrow 100 - (\text{lux} - 100)\times 0.5$ (`100` → `50`); $(200, 500] \Rightarrow 50 \rightarrow 0$; $> 500 \Rightarrow 0$.
- **`CIRCULATION_HALL`**: $[300, 500] \Rightarrow 100$; $[50, 300) \Rightarrow \frac{\text{lux} - 50}{2.5}$ ($\le 50 \Rightarrow 0$); $(500, 1000] \Rightarrow 100 \rightarrow 50$; $(1000, 2000] \Rightarrow 50 \rightarrow 0$; $> 2000 \Rightarrow 0$.

---

## 4. Bảng Phân hạng 5 Mức (`Grade`) & Quy tắc Màu UI

Khớp 100% giữa `ComfortScoreService#determineGrade` (Backend) và `GRADE_STYLES` / `resolveGradeFromScore` ([`frontend/src/config/thresholds.ts`](../frontend/src/config/thresholds.ts)):

| Ngưỡng điểm `overall` | Hạng (`grade`) | Nhãn Tiếng Việt UI | Mã màu HEX | Ý nghĩa vận hành |
| :---: | :--- | :--- | :---: | :--- |
| **`>= 90.0`** | **`Platinum`** | Tối ưu (`Platinum`) | `#10B981` | Môi trường học tập/bảo quản lý tưởng |
| **`75.0 – 89.9`** | **`Gold`** | Tốt (`Gold`) | `#22C55E` | Đạt chuẩn tốt (tính vào `optimalRoomsCount >= 75`) |
| **`60.0 – 74.9`** | **`Silver`** | Chú ý (`Silver`) | `#F59E0B` | Bắt đầu có yếu tố suy giảm nhẹ |
| **`45.0 – 59.9`** | **`Bronze`** | Kém (`Bronze`) | `#F97316` | Ảnh hưởng rõ rệt tới sự tập trung hoặc bảo quản |
| **`< 45.0`** | **`Poor`** | Cảnh báo (`Poor`) | `#EF4444` | Sụp đổ tiện nghi, cần kiểm tra xử lý ngay |
| *(Chưa có số liệu)* | **`N/A`** | Chưa có dữ liệu | `#64748B` | Phòng chưa có gói telemetry nào (Frontend & Summary rỗng) |

---

## 5. Tài liệu Liên quan

- Cách điểm LCS được tính trong pipeline MQTT & bộ nhớ đệm `roomTypeCache`: [`docs/04-ingestion-and-alerts.md`](./04-ingestion-and-alerts.md)
- Schema lưu trữ `comfortScore` trong `telemetry_records`: [`docs/05-data-model.md`](./05-data-model.md)
- Trực quan hóa lớp `comfortScore` trên mặt bằng 2D: [`docs/09-spatial-heatmap-2d.md`](./09-spatial-heatmap-2d.md)
