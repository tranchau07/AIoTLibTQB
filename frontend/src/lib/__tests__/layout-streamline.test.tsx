import React from 'react';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FloorplanPage from '@/app/(protected)/floorplan/page';
import { AppShell } from '@/components/layout/AppShell';
import { ToastProvider } from '@/components/ui/primitives';
import { ZOOM_CONFIG } from '@/config/floorplan-hmi.config';
import { TQB_ROOM_PRESETS } from '@/config/tqb-floorplan-presets';
import { alertsApi } from '@/features/alerts/api';
import { authApi } from '@/features/auth/api';
import { useAuthStore } from '@/features/auth/store';
import { devicesApi } from '@/features/devices/api';
import { roomsApi } from '@/features/rooms/api';
import { telemetryApi } from '@/features/telemetry/api';
import { fitPolygonToViewport } from '@/lib/floorplan/coords';
import { buildCapabilities } from '@/lib/rbac/capabilities';
import { parseScopeString } from '@/lib/rbac/scope-parser';
import { stompManager } from '@/lib/realtime/stomp-client';
import type {
  AlertResponse,
  RoomResponse,
  TelemetryResponse,
  UserResponse,
} from '@/types/api';

const mockRouterPush = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockRouterPush,
    replace: vi.fn(),
    back: vi.fn(),
  }),
  usePathname: () => '/floorplan',
  useSearchParams: () => new URLSearchParams(),
}));

function makeAdminUser(): UserResponse {
  return {
    id: 'admin-1',
    username: 'admin_tqb',
    email: 'admin@tqb.edu.vn',
    active: true,
    assignedZones: ['ZONE_A', 'ZONE_B'],
    roles: [{ name: 'ADMIN', description: 'Admin', permissions: [] }],
  };
}

function makeRoomFromPreset(code: string, id: string): RoomResponse {
  const preset = TQB_ROOM_PRESETS.find((p) => p.code === code)!;
  return {
    id,
    code: preset.code,
    name: preset.name,
    floor: preset.floor,
    capacity: preset.capacity,
    type: preset.roomType,
    targetComfortScore: 85,
    boundaryPolygon: preset.boundaryPolygon.map((pt) => ({ ...pt })),
  };
}

function makeTelemetry(roomId: string): TelemetryResponse {
  return {
    id: `tel-${roomId}`,
    timestamp: new Date().toISOString(),
    metadata: { deviceId: `dev-${roomId}`, hardwareId: `HW-${roomId}`, roomId },
    environment: { temperature: 23.0, humidity: 50, lux: 420 },
    acoustics: { noiseAvg: 42, noisePeak: 48 },
    airQuality: { pm1_0: 8, pm2_5: 12, pm4_0: 15, pm10: 18 },
    comfortScore: {
      overall: 88,
      grade: 'Gold',
      acousticScore: 90,
      airScore: 88,
      thermalScore: 86,
      lightScore: 88,
    },
    wifiRssi: -55,
  };
}

function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>
  );
}

describe('Streamlined AppShell Sidebar & Floorplan Layout', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, '', '/floorplan');
    vi.spyOn(stompManager, 'activate').mockImplementation(() => {});
    vi.spyOn(stompManager, 'isConnected').mockReturnValue(true);

    const adminUser = makeAdminUser();
    useAuthStore.setState({
      accessToken: 'token-admin',
      refreshToken: 'refresh-admin',
      user: adminUser,
      capabilities: buildCapabilities(
        parseScopeString(
          'ROLE_ADMIN VIEW_ROOMS MANAGE_ROOMS VIEW_ALERTS ACKNOWLEDGE_ALERT RESOLVE_ALERT VIEW_DEVICE_STATUS MANAGE_DEVICES'
        )
      ),
      hydrated: true,
      isKioskSession: false,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('allows collapsing and expanding the desktop left navbar in AppShell and persists preference', async () => {
    const adminUser = makeAdminUser();
    vi.spyOn(authApi, 'getMyInfo').mockResolvedValue(adminUser);
    vi.spyOn(alertsApi, 'getUnreadCount').mockResolvedValue(0);

    const { container } = renderWithProviders(
      <AppShell>
        <div className="page">Nội dung chính</div>
      </AppShell>
    );

    const toggleBtn = await screen.findByTestId('desktop-sidebar-toggle');
    const sidebar = screen.getByTestId('desktop-sidebar');
    const rootShell = container.querySelector('[data-sidebar-collapsed]');

    expect(rootShell).toHaveAttribute('data-sidebar-collapsed', 'false');
    expect(sidebar).toHaveAttribute('data-collapsed', 'false');
    expect(toggleBtn).toHaveAttribute('aria-expanded', 'true');

    // Đóng navbar bên trái -> mở rộng màn hình sang 2 bên
    fireEvent.click(toggleBtn);
    expect(rootShell).toHaveAttribute('data-sidebar-collapsed', 'true');
    expect(sidebar).toHaveAttribute('data-collapsed', 'true');
    expect(sidebar.className).toContain('w-0');
    expect(toggleBtn).toHaveAttribute('aria-expanded', 'false');
    expect(window.localStorage.getItem('tqb_desktop_sidebar_collapsed')).toBe(
      'true'
    );

    // Mở lại navbar bên trái
    fireEvent.click(toggleBtn);
    expect(rootShell).toHaveAttribute('data-sidebar-collapsed', 'false');
    expect(sidebar).toHaveAttribute('data-collapsed', 'false');
    expect(sidebar.className).toContain('w-60');
    expect(toggleBtn).toHaveAttribute('aria-expanded', 'true');
    expect(window.localStorage.getItem('tqb_desktop_sidebar_collapsed')).toBe(
      'false'
    );
  });

  it('removes ManagerSummaryStrip, role-view-select, TimeComparisonBar, FloorRoomTree, and MapAlertQueuePanel from FloorplanPage', async () => {
    const room301 = makeRoomFromPreset('TQB_301', 'ROOM_301');
    vi.spyOn(roomsApi, 'list').mockResolvedValue({
      content: [room301],
      page: 0,
      size: 100,
      totalElements: 1,
      totalPages: 1,
      last: true,
    });
    vi.spyOn(devicesApi, 'list').mockResolvedValue({
      content: [],
      page: 0,
      size: 100,
      totalElements: 0,
      totalPages: 0,
      last: true,
    });
    vi.spyOn(alertsApi, 'list').mockResolvedValue({
      content: [],
      page: 0,
      size: 50,
      totalElements: 0,
      totalPages: 0,
      last: true,
    });
    vi.spyOn(telemetryApi, 'getRoomLatest').mockResolvedValue(
      makeTelemetry('ROOM_301')
    );
    vi.spyOn(roomsApi, 'getFurniture').mockResolvedValue({
      roomId: 'ROOM_301',
      version: 1,
      items: [],
      auditHistory: [],
    });

    renderWithProviders(<FloorplanPage />);

    const mainStage = await screen.findByTestId('floorplan-main-stage');
    expect(mainStage).toBeInTheDocument();

    // Xóa hẳn 5 đối tượng trên trang bản đồ nhiệt
    expect(screen.queryByTestId('summary-filter-alerts')).not.toBeInTheDocument();
    expect(document.getElementById('role-view-select')).toBeNull();
    expect(screen.queryByText(/Góc nhìn:/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('time-comparison-bar')).not.toBeInTheDocument();
    expect(screen.queryByTestId('floor-room-tree-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('map-alert-queue-panel')).not.toBeInTheDocument();

    // Giữ chế độ nhãn sạch trên wrapper và đã dọn sạch các nút mật độ thừa (Tinh gọn / Cân bằng / Chi tiết)
    const canvasWrapper = screen.getByTestId('floorplan-canvas-wrapper');
    expect(canvasWrapper).toHaveAttribute('data-label-density', 'clean');
    expect(
      screen.queryByRole('button', { name: 'Tinh gọn' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Cân bằng' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Chi tiết' })
    ).not.toBeInTheDocument();
  });

  it('shifts heatmap left beside room-detail-drawer instead of overlaying it when a room is selected', async () => {
    const room301 = makeRoomFromPreset('TQB_301', 'ROOM_301');
    vi.spyOn(roomsApi, 'list').mockResolvedValue({
      content: [room301],
      page: 0,
      size: 100,
      totalElements: 1,
      totalPages: 1,
      last: true,
    });
    vi.spyOn(devicesApi, 'list').mockResolvedValue({
      content: [],
      page: 0,
      size: 100,
      totalElements: 0,
      totalPages: 0,
      last: true,
    });
    vi.spyOn(alertsApi, 'list').mockResolvedValue({
      content: [],
      page: 0,
      size: 50,
      totalElements: 0,
      totalPages: 0,
      last: true,
    });
    vi.spyOn(telemetryApi, 'getRoomLatest').mockResolvedValue(
      makeTelemetry('ROOM_301')
    );
    vi.spyOn(roomsApi, 'getFurniture').mockResolvedValue({
      roomId: 'ROOM_301',
      version: 1,
      items: [],
      auditHistory: [],
    });

    window.history.replaceState({}, '', '/floorplan?floor=3&roomId=ROOM_301');
    renderWithProviders(<FloorplanPage />);

    const mainStage = await screen.findByTestId('floorplan-main-stage');
    const drawer = await screen.findByTestId('room-detail-drawer');

    await waitFor(() => {
      expect(mainStage).toHaveAttribute('data-drawer-open', 'true');
      expect(mainStage.className).toContain('lg:flex-row');
      expect(drawer.className).not.toContain('absolute');
    });

    window.history.replaceState({}, '', '/floorplan');
  });

  it('opens full alert details and action buttons directly in AlertBellPopover without bottom toast popups', async () => {
    mockRouterPush.mockClear();
    const adminUser = makeAdminUser();
    const room301 = makeRoomFromPreset('TQB_301', 'ROOM_301');

    const alertItem: AlertResponse = {
      id: 'alert-bell-1',
      deviceId: 'dev-301',
      hardwareId: 'ESP32_TQB_301',
      roomId: 'ROOM_301',
      zoneId: 'ZONE_A',
      type: 'NOISE_EXCEEDED',
      metricType: 'NOISE_AVG',
      unit: 'dBA',
      severity: 'CRITICAL',
      severityRank: 4,
      status: 'FIRING',
      workflowStatus: 'NEW',
      currentValue: 74.5,
      threshold: 55.0,
      message: 'Noise average (74.5 dBA) exceeded threshold (55.0 dBA)',
      recommendedAction: 'Nhắc giữ trật tự tại phòng đọc tầng 3.',
      startedAt: new Date().toISOString(),
      acknowledgedAt: null,
      resolvedAt: null,
      acknowledgedBy: null,
      resolvedBy: null,
    };

    vi.spyOn(authApi, 'getMyInfo').mockResolvedValue(adminUser);
    vi.spyOn(alertsApi, 'getUnreadCount').mockResolvedValue(1);
    vi.spyOn(alertsApi, 'list').mockResolvedValue({
      content: [alertItem],
      page: 0,
      size: 30,
      totalElements: 1,
      totalPages: 1,
      last: true,
    });
    vi.spyOn(roomsApi, 'list').mockResolvedValue({
      content: [room301],
      page: 0,
      size: 100,
      totalElements: 1,
      totalPages: 1,
      last: true,
    });
    vi.spyOn(devicesApi, 'list').mockResolvedValue({
      content: [],
      page: 0,
      size: 100,
      totalElements: 0,
      totalPages: 0,
      last: true,
    });

    const workflowSpy = vi.spyOn(alertsApi, 'updateWorkflow').mockResolvedValue({
      ...alertItem,
      status: 'ACKNOWLEDGED',
      workflowStatus: 'IN_PROGRESS',
      assignedTo: 'Thủ thư T3',
      handlingNote: 'Đang kiểm tra phòng',
    });

    renderWithProviders(
      <AppShell>
        <div>Nội dung trang</div>
      </AppShell>
    );

    const bellBtn = await screen.findByTestId('alert-bell-button');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    // Nhấn chuông -> mở bảng cảnh báo đầy đủ ngay tại chỗ
    fireEvent.click(bellBtn);
    const popover = await screen.findByTestId('alert-bell-popover');
    const item = await screen.findByTestId('bell-alert-item-alert-bell-1');

    expect(popover).toBeInTheDocument();
    expect(item).toHaveTextContent('Khẩn cấp');
    expect(item).toHaveTextContent('Kích hoạt');
    expect(item).toHaveTextContent('Vượt ngưỡng ồn');
    expect(item).toHaveTextContent(room301.code);
    expect(item).toHaveTextContent('ESP32_TQB_301');
    expect(item).toHaveTextContent('74.5 dBA');
    expect(item).toHaveTextContent('55.0 dBA');
    expect(item).toHaveTextContent('Nhắc giữ trật tự tại phòng đọc tầng 3.');

    // Tap 1: Nhận xử lý (gộp Tiếp nhận + Đang xử lý + auto-assign)
    fireEvent.click(screen.getByTestId('bell-ack-alert-bell-1'));
    await waitFor(() => {
      expect(workflowSpy).toHaveBeenCalledWith('alert-bell-1', {
        workflowStatus: 'IN_PROGRESS',
      });
    });

    // Thao tác Giao việc / Ghi chú
    fireEvent.click(screen.getByTestId('bell-edit-workflow-alert-bell-1'));
    fireEvent.change(screen.getByLabelText('Người phụ trách'), {
      target: { value: 'Thủ thư T3' },
    });
    fireEvent.change(screen.getByLabelText('Ghi chú xử lý'), {
      target: { value: 'Đang kiểm tra phòng' },
    });
    fireEvent.click(screen.getByTestId('bell-save-workflow-alert-bell-1'));
    await waitFor(() => {
      expect(workflowSpy).toHaveBeenCalledWith('alert-bell-1', {
        assignedTo: 'Thủ thư T3',
        handlingNote: 'Đang kiểm tra phòng',
      });
    });

    // Thao tác Xem bản đồ
    fireEvent.click(screen.getByTestId('bell-locate-alert-bell-1'));
    expect(mockRouterPush).toHaveBeenCalledWith(
      expect.stringContaining('/floorplan?')
    );

    // Mở lại chuông và Tap 2: Đã nhắc xong + 1-click Quick-Tag chip
    fireEvent.click(bellBtn);
    await screen.findByTestId('bell-resolve-alert-bell-1');
    fireEvent.click(screen.getByTestId('bell-resolve-alert-bell-1'));
    await screen.findByTestId('bell-tag-alert-bell-1-REMINDED_QUIET');
    fireEvent.click(screen.getByTestId('bell-tag-alert-bell-1-REMINDED_QUIET'));
    await waitFor(() => {
      expect(workflowSpy).toHaveBeenCalledWith('alert-bell-1', {
        workflowStatus: 'RESOLVED',
        resolutionTag: 'REMINDED_QUIET',
        handlingNote: 'Đang kiểm tra phòng',
      });
    });
  });

  it('Phase 1: nâng trần zoom lên 8.0x, auto-fit TQB_301 >= 2.15x và kẹp trần mật độ <= 48 px/m cho phòng nhỏ TQB_508', () => {
    expect(ZOOM_CONFIG.maxScale).toBe(8.0);
    expect(ZOOM_CONFIG.roomFitPaddingRatio).toBe(1.14);
    expect(ZOOM_CONFIG.maxAutoFitPxPerMeter).toBe(48);

    const p301 = TQB_ROOM_PRESETS.find((p) => p.code === 'TQB_301')!;
    const p508 = TQB_ROOM_PRESETS.find((p) => p.code === 'TQB_508')!;
    const width = 960;
    const height = 722;

    const vp301 = fitPolygonToViewport(
      p301.boundaryPolygon,
      width,
      height,
      ZOOM_CONFIG.roomFitPaddingRatio,
      ZOOM_CONFIG.maxScale
    );
    const vp508 = fitPolygonToViewport(
      p508.boundaryPolygon,
      width,
      height,
      ZOOM_CONFIG.roomFitPaddingRatio,
      ZOOM_CONFIG.maxScale
    );

    expect(vp301.scale).toBeGreaterThanOrEqual(2.15);
    expect(vp508.scale).toBeGreaterThan(vp301.scale);
    // 48 px/m trên canvas 960px (12.63 px/m) => kẹp ở ~3.80x thay vì phóng vọt lên 8.0x
    expect(vp508.scale).toBeLessThanOrEqual(4.0);
  });

  it('Phase 1: bấm phím Escape tự động thoát trạng thái chọn phòng và đặt lại zoom 1.0x', async () => {
    const room301 = makeRoomFromPreset('TQB_301', 'ROOM_301');
    vi.spyOn(roomsApi, 'list').mockResolvedValue({
      content: [room301],
      page: 0,
      size: 100,
      totalElements: 1,
      totalPages: 1,
      last: true,
    });
    vi.spyOn(devicesApi, 'list').mockResolvedValue({
      content: [],
      page: 0,
      size: 100,
      totalElements: 0,
      totalPages: 0,
      last: true,
    });
    vi.spyOn(alertsApi, 'list').mockResolvedValue({
      content: [],
      page: 0,
      size: 50,
      totalElements: 0,
      totalPages: 0,
      last: true,
    });
    vi.spyOn(telemetryApi, 'getRoomLatest').mockResolvedValue(
      makeTelemetry('ROOM_301')
    );
    vi.spyOn(roomsApi, 'getFurniture').mockResolvedValue({
      roomId: 'ROOM_301',
      version: 1,
      items: [],
      auditHistory: [],
    });

    window.history.replaceState({}, '', '/floorplan?floor=3&roomId=ROOM_301');
    renderWithProviders(<FloorplanPage />);

    await screen.findByTestId('room-detail-drawer');
    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => {
      expect(
        screen.queryByTestId('room-detail-drawer')
      ).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('floorplan-canvas-wrapper')).toHaveAttribute(
      'data-scale',
      '1'
    );
    window.history.replaceState({}, '', '/floorplan');
  });
});
