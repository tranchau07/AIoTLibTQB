# Hướng Dẫn Kiểm Thử & Nghiệm Thu / Testing & Verification Guide

> **Tình trạng kiểm chứng thực tế tại commit `e206162` / Verified Baseline (`e206162`):**
> - **Backend Maven Tests:** `32` lớp kiểm thử / `281` test cases — **PASSED** (`./mvnw test`)
> - **Frontend Typecheck:** `npx tsc --noEmit` — **PASSED (0 errors)**
> - **Frontend Vitest + A11y (`axe-core`):** `13` test suites / `146` test cases — **PASSED** (`npm test`)
> - **Frontend Production Build:** `next build` (`output: 'standalone'`, `16` routes) — **PASSED**
> - **CI/CD Status:** `[CẦN BỔ SUNG / TO BE ADDED: Thiết lập pipeline GitHub Actions chạy tự động toàn bộ các lệnh dưới đây trên mỗi Pull Request.]`

---

## 1. Kiểm Thử Backend (`JUnit 5` & `Mockito`) / Backend Test Suite

### Lệnh chạy / Commands
```bash
# Chạy toàn bộ 32 test classes (281 tests)
./mvnw test

# Chạy một class cụ thể (ví dụ kiểm tra Alert hoặc Telemetry)
./mvnw test -Dtest=AlertServiceTest
./mvnw test -Dtest=MqttMessageDispatcherServiceTest
```

### Phân bổ 32 Lớp Kiểm Thử trong [`src/test/java/`](../../src/test/java/com/example/AIoTLibTQB)
- **`configuration/` (`5` lớp)**: `ApplicationInitConfigTest`, `CustomJwtDecoderTest`, `JwtAuthenticationEntryPointTest`, `RateLimitFilterTest`, `StompChannelInterceptorTest`.
- **`controller/` & `exception/` (`7` lớp)**: `AlertControllerTest`, `PermissionControllerTest`, `PublicControllerTest`, `RoleControllerTest`, `TelemetryControllerTest`, `TelemetryOverviewTest`, `GlobalExceptionHandlerTest`.
- **`service/` (`20` lớp)**: `AlertServiceTest` *(2,969 dòng bao phủ FSM, dual noise peak, zone isolation, workflow, snooze)*, `AlertEmailNotificationServiceTest`, `AuthenticationServiceTest`, `ComfortScoreServiceTest`, `DeviceMetadataCacheTest`, `DeviceServiceTest`, `DeviceWatchdogServiceTest`, `DiscoveredDeviceServiceTest`, `IntrospectServiceTest`, `LatestTelemetryCacheTest`, `MqttMessageDispatcherServiceTest`, `PermissionServiceTest`, `RealtimePublisherImplTest`, `RoleServiceTest`, `RoomFurnitureTest` *(chống chồng lấn SAT & optimistic locking 5007)*, `RoomServiceTest`, `TelemetryConflationServiceTest`, `TelemetrySanitizerServiceTest`, `TelemetryServiceTest`, `UserServiceTest`.

---

## 2. Kiểm Thử Frontend (`TypeScript`, `Vitest`, `Testing Library`, `axe-core`) / Frontend Test Suite

### Lệnh chạy / Commands
```bash
cd frontend
npm run typecheck    # Kiểm tra kiểu TypeScript nghiêm ngặt (tsc --noEmit)
npm test             # Chạy 13 Vitest suites / 146 tests
npm run build        # Kiểm tra đóng gói Next.js standalone cho Docker
```

### Danh mục 13 Test Suites trong [`frontend/src/lib/__tests__/`](../../frontend/src/lib/__tests__)
1. `core-standard.test.ts` — Core HTTP envelope, RBAC `CapabilityMatrix`, error mapping, formatters.
2. `floorplan-manager-layout.test.tsx` — Bố cục max-space cho Quản lý, Dải tóm tắt lọc bản đồ, đồng bộ responsive.
3. `floor-room-tree.test.tsx` — Cây điều hướng WAI-ARIA Tree View (`↑↓←→`, `Home`/`End`, tìm kiếm, đồng bộ 2 chiều).
4. `furniture-editor.test.tsx` — Kéo thả/xoay/snap `0.25m`, SAT OBB va chạm, ranh giới phòng, Undo/Redo, Kiosk ẩn `IOT_NODE`.
5. `semantic-zoom-declutter.test.tsx` — 3 cấp Semantic Zoom, gom cụm node `< 44px`, chống đè nhãn.
6. `heatmap-color-transition.test.tsx` — Chuyển màu 450ms, Reduced Motion, Low-FPS fallback, bảng màu mù màu & WCAG contrast.
7. `data-reliability.test.tsx` — 4 trạng thái `MEASURED / INTERPOLATED / BLINDSPOT / STALE`.
8. `alert-display-unit.test.tsx`, `alert-map-workflow.test.tsx`, `alert-ux-polish.test.tsx`, `alert-zone-isolation.test.tsx` — Inspector Drawer, workflow 4 bước, phân quyền zone, `axe-core` A11y scan.
9. `time-deeplink-export.test.tsx` — So sánh `-1h`, Playback, Typical Day, Deep Link 2 chiều, Export PNG/PDF.
10. `step4-acceptance.test.tsx` — Bộ test nghiệm thu đầu-cuối (kết hợp kiểm toán `axe-core` A11y cho màn hình `/floorplan`).

---

## 3. Kiểm Thử Simulator & Nghiệm Thu Thực Địa / Simulator Tests & E2E Acceptance Criteria

```bash
# Chạy unit test của IoT Simulator
cd tools/iot-simulator && npm test
```

| Hạng mục / Scenario | Tiêu chí đạt / Acceptance Target | Cách kiểm chứng / Verification Method |
| :--- | :---: | :--- |
| **Phát hiện trạm mất kết nối** | `OFFLINE <= 120s`; phục hồi `ONLINE <= 5s` | Chạy `--scenario device-dropout` hoặc rút nguồn ESP32-S3; kiểm tra log `DeviceWatchdogService` & `GET /api/v1/alerts`. |
| **Gộp luồng STOMP Conflation** | Nhịp `500ms` (`~2 frames/s/phòng`) | Chạy `--scenario burst`; quan sát WebSocket frames `/ws-aiot` trên DevTools Network tab. |
| **Truy vấn Downsampling `$dateTrunc`** | Đúng bucket & chặn `<= 1000` buckets | Gọi `/api/v1/telemetry/room/{id}/buckets?interval=1h` trong 7 ngày (`168` buckets) và kiểm tra lỗi `7002` khi vượt `1000`. |
| **Xung đột đồng thời Nội thất (`5007`)** | Trả HTTP `409` khi sai `expectedVersion` | Mở 2 tab sửa cùng 1 phòng, lưu tab 1 trước rồi lưu tab 2. |
