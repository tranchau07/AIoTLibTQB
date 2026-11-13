# AIoTLibTQB Public Web Access (Cloudflare Quick Tunnel)

Công cụ này hợp nhất Backend (`:8080`) và Frontend (`:3000`) qua một cổng duy nhất **`:4000`** (`gateway.js`) rồi mở đường hầm **HTTPS / WSS** tạm thời bằng `cloudflared` để chia sẻ hệ thống ra Internet mà không cần domain hay mở port modem.

---

## 1. Kiến Trúc Unified Gateway (`gateway.js :4000`)

```text
[Trình duyệt từ xa] --(HTTPS/WSS)--> [Cloudflare Edge]
                                           |
                                     [cloudflared]
                                           |
                           [Local Gateway - gateway.js :4000]
                             ├── /api/*        --> Backend (:8080)
                             ├── /ws-*         --> WebSocket STOMP (:8080)
                             ├── /actuator/*   --> Actuator Health (:8080)
                             └── /*            --> Next.js Frontend (:3000)
```

---

## 2. Điều Kiện Tiên Quyết

1. Đảm bảo Backend (`:8080`) và Frontend (`:3000`) đang chạy (`docker compose up -d` hoặc chạy dev local).
2. Cài đặt **`cloudflared`**:
   - **Windows**: Tải `cloudflared-windows-amd64.exe` từ trang phát hành chính thức của Cloudflare, đổi tên thành `cloudflared.exe` và đặt trực tiếp trong `tools/cloudflared/` (hoặc cài qua `winget install Cloudflare.cloudflared`).
   - **Linux / macOS**: Cài gói `cloudflared` vào `PATH` hệ thống.

---

## 3. Cách Khởi Chạy

### 3.1. Trên Windows (1-Click)
- Chạy `tools/cloudflared/start-public-web.bat`, hoặc trong PowerShell:
  ```powershell
  .\tools\cloudflared\start-public-web.ps1
  ```

### 3.2. Trên Linux / macOS
Mở 2 terminal riêng biệt:
```bash
# Terminal 1: Khởi chạy Unified Gateway trên cổng 4000
node tools/cloudflared/gateway.js

# Terminal 2: Tạo Cloudflare Quick Tunnel
cloudflared tunnel --url http://127.0.0.1:4000
```

Terminal sẽ in ra đường link công khai dạng `https://<random-words>.trycloudflare.com`. Nhấn `Ctrl + C` để tắt đường hầm khi kết thúc demo.

---

**Tài liệu liên quan**: [Cẩm nang Vận hành & Runbook](../../docs/12-runbook.md)
