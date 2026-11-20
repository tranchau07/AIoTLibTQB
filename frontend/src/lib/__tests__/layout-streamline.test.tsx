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
import { TQB_ROOM_PRESETS } from '@/config/tqb-floorplan-presets';
import { alertsApi } from '@/features/alerts/api';
import { authApi } from '@/features/auth/api';
import { useAuthStore } from '@/features/auth/store';
import { devicesApi } from '@/features/devices/api';
import { roomsApi } from '@/features/rooms/api';
import { telemetryApi } from '@/features/telemetry/api';
import { buildCapabilities } from '@/lib/rbac/capabilities';
import { parseScopeString } from '@/lib/rbac/scope-parser';
import { stompManager } from '@/lib/realtime/stomp-client';
import type { RoomResponse, TelemetryResponse, UserResponse } from '@/types/api';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
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

    // Chỉ duy nhất chế độ "Tinh gọn" (xóa "Cân bằng" và "Chi tiết")
    const canvasWrapper = screen.getByTestId('floorplan-canvas-wrapper');
    expect(canvasWrapper).toHaveAttribute('data-label-density', 'clean');
    expect(screen.getByRole('button', { name: 'Tinh gọn' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
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
});
