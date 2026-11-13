# 11 — Quy Chuẩn Phát Triển & Duyệt Pull Request (Engineering Conventions)

> **Tài liệu**: `docs/11-conventions.md` | **Phiên bản**: 2.1 | **Áp dụng cho**: Backend (Java 21 / Spring Boot 3.5.8) & Frontend (Next.js 15 / TypeScript)
>
> [!NOTE]
> **TL;DR**: Tài liệu quy định **12 bất biến kỹ thuật** kèm ví dụ Đúng/Sai đối chiếu từ mã nguồn thật: không giữ I/O trong `ConcurrentHashMap.compute()` hay khối `synchronized`, không `updateOne` trên TimeSeries, giới hạn ghi bằng `Semaphore(30, true)`, quản lý Secret qua biến môi trường, bọc `ApiResponse<T>`, kẹp phân trang $\le 100$, cô lập HTTP qua `SingleFlightRefreshCoordinator`, Singleton STOMP và HiDPI Canvas.

---

## 1. Quy Chuẩn Backend (Java 21 & MongoDB 8.0)

### 1.1. An toàn Virtual Threads (`Project Loom`)
- **Nguyên tắc**: Khi Virtual Thread thực thi I/O chặn bên trong `synchronized` hoặc bucket lock của `ConcurrentHashMap.compute()`, JVM có thể ghim (pin) luồng ảo vào Platform Carrier Thread, làm nghẽn hệ thống dưới tải cao.
- **Quy chuẩn**:
  - Chỉ tính toán trạng thái thuần RAM bên trong `fsmMap.compute(...)`; đưa toàn bộ `alertRepository.save()` và `realtimePublisher.publishAlert()` ra **bên ngoài** khối `compute()` (`AlertRuleEngine#evaluateMetric`).
  - Nếu buộc phải đồng bộ cục bộ một danh sách nhỏ trong RAM (như `noisePeakPulsesMap`), khối `synchronized` chỉ được chứa thao tác mảng bộ nhớ vài nanô-giây, **tuyệt đối không có Blocking I/O bên trong**.

### 1.2. Bất biến MongoDB TimeSeries (`telemetry_records`)
```java
// ❌ SAI: Update đơn lẻ làm giải nén và ghi lại toàn bộ columnar bucket
mongoTemplate.updateFirst(query, new Update().set("comfortScore.overall", 80.0), TelemetryRecord.class);

// ✅ ĐÚNG: Append-only khi ghi + Downsampling bằng Aggregation $dateTrunc khi đọc
// Xem TelemetryService#getBucketsByRoomId
```
- **Cấm** gọi `updateOne`/`updateMany` trên `telemetry_records` và **cấm** tải hàng trăm nghìn bản ghi thô về Java để tính trung bình trong RAM; luôn dùng `$dateTrunc` kèm kiểm tra $\le 1000$ buckets (`ErrorCode.TOO_MANY_BUCKETS`).

### 1.3. Điều tiết Tải & Truy vấn Zero-DB-Hit
- Ghi TimeSeries phải đi qua `Semaphore(30, true)` với timeout `3000ms` và luôn `release()` trong `finally` (`MqttMessageDispatcherService`).
- Cập nhật `lastSeenAt` tiết lưu qua Caffeine `lastSeenThrottleCache` (`30s`); phục hồi `OFFLINE -> ONLINE` dùng `ConcurrentHashMap.newKeySet()` để giữ 0 DB query trên luồng telemetry bình thường.

### 1.4. Bí mật & Khởi động An toàn (`Secrets Hygiene`)
- Không hardcode mật khẩu, JWT secret, hoặc URI có credential trong mã nguồn, cấu hình hay tài liệu (luôn dùng biến môi trường hoặc placeholder `CHANGE_ME_*`).
- `ApplicationInitConfig` kiểm tra `INITIAL_ADMIN_PASSWORD`: nếu trống trong profile `prod`/`production`, dừng khởi động ngay với `IllegalStateException`.

### 1.5. Hợp đồng API, Phân trang An toàn & DTO Mapping
- Mọi `@RestController` phải trả về `ApiResponse<T>`; lỗi nghiệp vụ ném qua `new AppException(ErrorCode.XXX)` để `GlobalExceptionHandler` chuẩn hóa.
- Phân trang luôn kẹp `safePage = Math.max(0, page)` và `safeSize = Math.max(1, Math.min(100, size))`, kết hợp whitelist trường `sortBy`.
- **MapStruct** (`@Mapper(componentModel = "spring")`) dùng cho CRUD 1:1 (`User`, `Role`, `Permission`); **Manual Builder** trong Service dùng cho DTO tổng hợp trạng thái động (`TelemetryResponse`, `AlertResponse`, `RoomResponse`).

---

## 2. Quy Chuẩn Frontend (Next.js 15 & Canvas 2D)

### 2.1. Cô lập HTTP, Single-Flight Auth & RBAC Matrix
- **FE-ARC / FE-API**: Không gọi `fetch` trực tiếp trong Component; mọi request đi qua `src/features/*/api.ts` $\to$ `src/lib/http/client.ts` (`unwrapEnvelope` kiểm tra `code === 1000`), ánh xạ lỗi qua `messages/vi.ts` và đọc `Retry-After` cho HTTP `429`.
- **FE-AUTH**: `accessToken` chỉ nằm trong RAM Zustand (`useAuthStore`); đồng bộ đa tab qua `BroadcastChannel('aiot_auth_channel')`; xử lý 401 đồng thời qua `SingleFlightRefreshCoordinator` (`refresh-queue.ts`).
- **FE-RBAC**: Chỉ dùng cờ trong `CapabilityMatrix` (`src/lib/rbac/capabilities.ts`), không viết `.includes('ADMIN')` rải rác trong UI.

### 2.2. STOMP Singleton, HiDPI Canvas & Trạng thái UI
- **FE-RT**: Dùng duy nhất `stompManager` (`src/lib/realtime/stomp-client.ts`), tiêm token động ở `beforeConnect`, hủy subscription khi unmount, lọc thứ tự thời gian qua `mergeRealtimeTelemetry` và bật polling `15s` khi mất kết nối.
- **FE-VIZ**: Quy đổi tọa độ tập trung qua `coords.ts`; khóa tỷ lệ `window.devicePixelRatio` (`ctx.scale(dpr, dpr)`); cắt khuôn đa giác bằng `ctx.clip()`; nội suy qua `idw.ts` (`computeIdwValue`) và `weatherPalette.ts` (`computeAdaptiveSigma`, `renderWeatherDiffusionHeatmap`) — **không tạo file nội suy trùng lặp**.
- **FE-UI / FE-A11Y**: Hỗ trợ đủ 4 trạng thái (Loading Skeleton, Empty + CTA, Error/Stale, Realtime Pulse); mọi số liệu thời gian thực bắt buộc dùng `tabular-nums`; cảnh báo `FIRING` gắn `aria-live="assertive"`.

---

## 3. Checklist Duyệt Pull Request (PR Review)

| STT | Phân hệ | Tiêu chí Kiểm tra | Đạt |
| :---: | :---: | :--- | :---: |
| 1 | Backend | Không chứa Blocking I/O trong `ConcurrentHashMap.compute()` hay khối `synchronized` | [ ] |
| 2 | Backend | Không gọi `updateOne`/`updateFirst` trên `telemetry_records`; dùng `$dateTrunc` + giới hạn `<= 1000` buckets | [ ] |
| 3 | Backend | Ghi TimeSeries được bảo vệ bởi `Semaphore(30, true)` và giải phóng trong `finally` | [ ] |
| 4 | Backend | Không hardcode secret/mật khẩu; mật khẩu & API key băm `BCrypt(10)` | [ ] |
| 5 | Backend | Endpoint bọc `ApiResponse<T>`; phân trang kẹp `size <= 100` và whitelist `sortBy` | [ ] |
| 6 | Frontend | Toàn bộ HTTP qua `features/*/api.ts` + `client.ts`; `rawApiKey` mutation đặt `gcTime: 0` | [ ] |
| 7 | Frontend | `accessToken` chỉ lưu RAM; kiểm tra quyền qua `CapabilityMatrix` | [ ] |
| 8 | Frontend | Canvas dùng `coords.ts`, `devicePixelRatio`, `ctx.clip()`, `idw.ts` & `weatherPalette.ts` | [ ] |
| 9 | Frontend | Số đo dùng `tabular-nums`, đủ 4 trạng thái UI, `npm run typecheck && npm test && npm run build` xanh | [ ] |

---

**Đọc tiếp**: [04 — Ingestion & Cảnh báo](./04-ingestion-and-alerts.md) · [08 — Kiến trúc Frontend](./08-frontend-architecture.md) · [12 — Cẩm nang Vận hành](./12-runbook.md)
