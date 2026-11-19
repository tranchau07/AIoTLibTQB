# Quy Chuẩn Phát Triển & Duyệt Code / Engineering Coding Conventions & PR Checklist

> **Cơ sở kiểm chứng / Enforced Invariants:** Đối chiếu trực tiếp từ mã nguồn Backend (Java 21) và Frontend (Next.js 15 / TypeScript / Canvas 2D).

---

## 1. Quy Chuẩn Backend (Java 21, Spring Boot & MongoDB 8.0) / Backend Conventions

1. **An toàn Virtual Threads (No Blocking I/O Inside Locks)**:
   - Không đặt thao tác DB (`save`/`find`) hoặc network (`convertAndSend`, `mailSender.send`) bên trong `ConcurrentHashMap.compute()` hoặc khối `synchronized` để tránh platform carrier thread pinning.
   - Tham chiếu chuẩn: [`AlertRuleEngine#evaluateMetric`](../../src/main/java/com/example/AIoTLibTQB/service/AlertRuleEngine.java) tính trạng thái RAM bên trong `fsmMap.compute(...)` và chỉ gọi `alertRepository.save()` / `realtimePublisher.publishAlert()` sau khi thoát lock.
2. **Bất biến MongoDB TimeSeries (`telemetry_records`)**:
   - **Cấm** dùng `updateOne`/`updateMulti` trên `telemetry_records` (sẽ ép MongoDB giải nén và ghi lại columnar bucket); chỉ ghi append-only (`insert`) được bảo vệ bởi `Semaphore(30, true)` và luôn giải phóng trong khối `finally`.
   - Truy vấn biểu đồ lịch sử luôn đẩy tổng hợp xuống MongoDB qua `$dateTrunc` (`TelemetryService#getBucketsByRoomId`) kèm chặn `TOO_MANY_BUCKETS` (`<= 1000`).
3. **Chuẩn Hợp đồng API & Phân trang An toàn**:
   - Mọi controller trả `ApiResponse<T>` (`code = 1000` khi thành công); lỗi nghiệp vụ ném `new AppException(ErrorCode.XXX)` để `GlobalExceptionHandler` xử lý tập trung.
   - Luôn kẹp phân trang `safePage = Math.max(0, page)`, `safeSize = Math.max(1, Math.min(100, size))` và whitelist `sortBy`.
4. **Mapping & Secrets Hygiene**:
   - Dùng MapStruct cho CRUD 1:1 (`User`, `Role`, `Permission`, `Room`, `Device`) và Builder thủ công khi hợp nhất trạng thái động (`AlertResponse`, `TelemetryResponse`).
   - Tuyệt đối không hard-code secret; `BCrypt(10)` cho mật khẩu và `apiKey`.

---

## 2. Quy Chuẩn Frontend (Next.js 15, TypeScript & Canvas 2D) / Frontend Conventions

1. **Cô lập HTTP, Auth RAM & RBAC Matrix**:
   - Mọi request đi qua `frontend/src/features/*/api.ts` → [`frontend/src/lib/http/client.ts`](../../frontend/src/lib/http/client.ts) (`unwrapEnvelope` + ánh xạ lỗi [`messages/vi.ts`](../../frontend/src/messages/vi.ts)).
   - `accessToken` chỉ sống trong RAM Zustand (`auth/store.ts`); mọi `401` đồng thời đi qua `SingleFlightRefreshCoordinator` (`refresh-queue.ts`); mutation trả `rawApiKey` bắt buộc đặt `gcTime: 0`.
   - Kiểm tra quyền UI tập trung qua cờ trong [`capabilities.ts`](../../frontend/src/lib/rbac/capabilities.ts), không rải `.includes('ADMIN')`.
2. **STOMP Singleton & Fallback**:
   - Mọi màn hình chỉ dùng duy nhất `stompManager` (`stomp-client.ts`); luôn hủy subscription ở cleanup hook; tự động bật polling `15s` khi STOMP rớt kết nối.
3. **Bản đồ 2D HiDPI, Nội thất & Kiosk (`FE-VIZ-*`)**:
   - Quy đổi tọa độ tập trung qua `coords.ts`; scale canvas theo `window.devicePixelRatio`; cắt đa giác bằng `ctx.clip()`; không viết trùng lặp hàm nội suy ngoài `idw.ts` và `weatherPalette.ts`.
   - Mọi vật thể nội thất mới thêm vào [`furniture-catalog.ts`](../../frontend/src/config/furniture-catalog.ts) bằng dữ liệu thuần, không sửa logic vẽ/SAT.
   - Đảm bảo ẩn phần cứng `IOT_NODE` và thông tin trạm trên `/kiosk` (`FE-VIZ-09`).
4. **UI/UX & Khả năng Tiếp cận (A11y / WCAG)**:
   - Dùng `tabular-nums` cho mọi số đo thời gian thực; đảm bảo đủ 4 trạng thái (Skeleton, Empty+CTA, Error/Stale, Realtime Pulse); cảnh báo khẩn cấp gắn `aria-live="assertive"`; mọi trạng thái trên heatmap luôn đi kèm ký hiệu hình học `● ▲ ◆ ○` ngoài màu sắc.

---

## 3. Checklist Duyệt Pull Request / PR Review Checklist

| Hạng mục / Area | Tiêu chí kiểm tra bắt buộc / Verification Gate |
| :--- | :--- |
| **Backend Concurrency** | Không có Blocking I/O trong `synchronized` hoặc `ConcurrentHashMap.compute()`; `Semaphore` luôn `release()` trong `finally`. |
| **MongoDB TimeSeries** | Chỉ `insert` vào `telemetry_records`; aggregation dùng `$dateTrunc` + chặn `<= 1000` buckets. |
| **API & Security** | Đủ `@PreAuthorize` + Zone ABAC (nếu liên quan Alert); không lộ secret/API key ra log; mọi endpoint mới cập nhật [API Spec](../03-technical-specs/api-and-realtime-spec.md). |
| **Frontend Arch & Viz** | HTTP qua `client.ts`; `accessToken` chỉ trên RAM; dùng `coords.ts` + `weatherPalette.ts`; tôn trọng `FE-VIZ-09` trên `/kiosk`. |
| **Automated Quality Gate** | `./mvnw test` xanh (`0` failed) + `cd frontend && npm run typecheck && npm test && npm run build` xanh hoàn toàn. |
