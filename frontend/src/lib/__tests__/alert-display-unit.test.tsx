import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AlertsCenterPage from '@/app/(protected)/alerts/page';
import { ToastProvider } from '@/components/ui/primitives';
import { alertsApi } from '@/features/alerts/api';
import { useAuthStore } from '@/features/auth/store';
import { devicesApi } from '@/features/devices/api';
import { roomsApi } from '@/features/rooms/api';
import { buildCapabilities } from '@/lib/rbac/capabilities';
import { parseScopeString } from '@/lib/rbac/scope-parser';
import { stompManager } from '@/lib/realtime/stomp-client';
import type { AlertResponse, DeviceResponse, RoomResponse } from '@/types/api';

const routerPushSpy = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: routerPushSpy,
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/alerts',
}));

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

function buildAlert(overrides: Partial<AlertResponse> = {}): AlertResponse {
  return {
    id: 'alert-base',
    deviceId: 'dev-1',
    hardwareId: 'ESP32-NODE-1',
    roomId: 'room-1',
    zoneId: 'ZONE_A',
    type: 'AIR_UNHEALTHY',
    metricType: 'TEMPERATURE',
    unit: '°C',
    severity: 'MEDIUM',
    severityRank: 2,
    status: 'FIRING',
    currentValue: 34.2,
    threshold: 32.0,
    message: 'Temperature (34.2 °C) exceeded threshold (32.0 °C)',
    startedAt: '2026-11-17T06:00:00Z',
    acknowledgedAt: null,
    resolvedAt: null,
    acknowledgedBy: null,
    resolvedBy: null,
    ...overrides,
  };
}

describe('Hạng mục 5 (P1-1): AlertsCenterPage hiển thị đúng đơn vị và liên kết lớp bản đồ nhiệt 2D', () => {
  beforeEach(() => {
    routerPushSpy.mockReset();
    vi.spyOn(stompManager, 'isConnected').mockReturnValue(true);
    vi.spyOn(stompManager, 'onConnectionChange').mockImplementation((cb) => {
      cb(true);
      return vi.fn();
    });
    vi.spyOn(stompManager, 'onAlert').mockImplementation(() => vi.fn());

    useAuthStore.setState({
      accessToken: 'token-admin',
      refreshToken: 'refresh-admin',
      user: {
        id: 'u-admin',
        username: 'admin',
        active: true,
        roles: [{ name: 'ADMIN', description: 'Admin', permissions: [] }],
        assignedZones: [],
      },
      capabilities: buildCapabilities(
        parseScopeString(
          'ADMIN VIEW_ALERTS ACKNOWLEDGE_ALERT MANAGE_ALERT_CONFIG VIEW_DEVICE_STATUS'
        )
      ),
      hydrated: true,
      isKioskSession: false,
    });
  });

  afterEach(() => {
    cleanup();
    useAuthStore.setState({
      accessToken: null,
      refreshToken: null,
      user: null,
      capabilities: buildCapabilities(parseScopeString('')),
      hydrated: false,
      isKioskSession: false,
    });
    vi.restoreAllMocks();
  });

  it('renders °C, %RH, µg/m³, dBA and Mất kết nối (never 0 giây), and links to exact heatmap layers', async () => {
    const rooms: RoomResponse[] = [
      {
        id: 'room-1',
        code: 'TQB_301',
        name: 'Phòng đọc 301',
        floor: 3,
        capacity: 60,
        type: 'STUDY_ROOM',
      },
      {
        id: 'room-2',
        code: 'TQB_201',
        name: 'Kho sách 201',
        floor: 2,
        capacity: 20,
        type: 'BOOK_STORAGE',
      },
    ];
    const devices: DeviceResponse[] = [
      {
        id: 'dev-1',
        name: 'Node 301',
        hardwareId: 'ESP32-301',
        zoneId: 'ZONE_A',
        roomId: 'room-1',
        deviceType: 'SENSOR_NODE',
        active: true,
        lastSeenAt: '2026-11-17T06:00:00Z',
        connectionState: 'ONLINE',
        lastOfflineAt: null,
        online: true,
      },
      {
        id: 'dev-2',
        name: 'Node 201',
        hardwareId: 'ESP32-201',
        zoneId: 'ZONE_A',
        roomId: 'room-2',
        deviceType: 'SENSOR_NODE',
        active: true,
        lastSeenAt: '2026-11-17T06:00:00Z',
        connectionState: 'ONLINE',
        lastOfflineAt: null,
        online: true,
      },
    ];

    const alerts: AlertResponse[] = [
      buildAlert({
        id: 'a-temp',
        roomId: 'room-1',
        deviceId: 'dev-1',
        hardwareId: 'ESP32-301',
        type: 'AIR_UNHEALTHY',
        metricType: 'TEMPERATURE',
        unit: '°C',
        currentValue: 34.2,
        threshold: 32.0,
        message: 'Temperature (34.2 °C) exceeded threshold (32.0 °C)',
      }),
      buildAlert({
        id: 'a-hum',
        roomId: 'room-2',
        deviceId: 'dev-2',
        hardwareId: 'ESP32-201',
        type: 'AIR_UNHEALTHY',
        metricType: 'HUMIDITY_HIGH',
        unit: '%RH',
        currentValue: 68.5,
        threshold: 60.0,
        message: 'Book storage humidity (68.5 %RH) exceeded max threshold (60.0 %RH)',
      }),
      buildAlert({
        id: 'a-pm25',
        roomId: 'room-1',
        deviceId: 'dev-1',
        hardwareId: 'ESP32-301',
        type: 'AIR_UNHEALTHY',
        metricType: 'PM2_5',
        unit: 'µg/m³',
        currentValue: 62.0,
        threshold: 50.0,
        message: 'PM2.5 particulate level (62.0 µg/m³) exceeded threshold (50.0 µg/m³)',
      }),
      buildAlert({
        id: 'a-noise',
        roomId: 'room-1',
        deviceId: 'dev-1',
        hardwareId: 'ESP32-301',
        type: 'NOISE_EXCEEDED',
        metricType: 'NOISE_AVG',
        unit: 'dBA',
        currentValue: 71.4,
        threshold: 65.0,
        message: 'Average noise level (71.4 dBA) exceeded threshold (65.0 dBA)',
      }),
      buildAlert({
        id: 'a-offline',
        roomId: 'room-2',
        deviceId: 'dev-2',
        hardwareId: 'ESP32-201',
        type: 'DEVICE_OFFLINE',
        metricType: 'DEVICE_OFFLINE',
        unit: null,
        currentValue: 0,
        threshold: 0,
        message: 'Device is offline: hardwareId=ESP32-201',
      }),
    ];

    vi.spyOn(alertsApi, 'list').mockResolvedValue({
      content: alerts,
      page: 0,
      size: 10,
      totalElements: alerts.length,
      totalPages: 1,
      last: true,
    });
    vi.spyOn(alertsApi, 'getUnreadCount').mockResolvedValue(alerts.length);
    vi.spyOn(roomsApi, 'list').mockResolvedValue({
      content: rooms,
      page: 0,
      size: 100,
      totalElements: rooms.length,
      totalPages: 1,
      last: true,
    });
    vi.spyOn(devicesApi, 'list').mockResolvedValue({
      content: devices,
      page: 0,
      size: 100,
      totalElements: devices.length,
      totalPages: 1,
      last: true,
    });
    const workflowSpy = vi.spyOn(alertsApi, 'updateWorkflow').mockResolvedValue({
      ...alerts[0],
      status: 'ACKNOWLEDGED',
      workflowStatus: 'IN_PROGRESS',
      assignedTo: 'admin',
    });

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <AlertsCenterPage />
        </ToastProvider>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('Đo: 34.2 °C')).toBeInTheDocument();
    });

    expect(screen.getByText('Ngưỡng: 32.0 °C')).toBeInTheDocument();
    expect(screen.getByText('Đo: 68.5 %RH')).toBeInTheDocument();
    expect(screen.getByText('Ngưỡng: 60.0 %RH')).toBeInTheDocument();
    expect(screen.getByText('Đo: 62.0 µg/m³')).toBeInTheDocument();
    expect(screen.getByText('Ngưỡng: 50.0 µg/m³')).toBeInTheDocument();
    expect(screen.getByText('Đo: 71.4 dBA')).toBeInTheDocument();
    expect(screen.getByText('Ngưỡng: 65.0 dBA')).toBeInTheDocument();

    // DEVICE_OFFLINE renders 'Mất kết nối' / 'Ngưỡng: --' instead of '0 giây'
    expect(screen.queryByText(/giây/)).not.toBeInTheDocument();
    expect(screen.getAllByText('Mất kết nối').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Ngưỡng: --')).toBeInTheDocument();

    // Verify heatmap links contain exact layers
    const heatmapLinks = screen.getAllByRole('link', { name: 'Bản đồ nhiệt' });
    expect(heatmapLinks.map((el) => el.getAttribute('href'))).toEqual([
      '/floorplan?floor=3&roomId=room-1&deviceId=dev-1&hardwareId=ESP32-301&layer=temperature&alertId=a-temp',
      '/floorplan?floor=2&roomId=room-2&deviceId=dev-2&hardwareId=ESP32-201&layer=humidity&alertId=a-hum',
      '/floorplan?floor=3&roomId=room-1&deviceId=dev-1&hardwareId=ESP32-301&layer=pm2_5&alertId=a-pm25',
      '/floorplan?floor=3&roomId=room-1&deviceId=dev-1&hardwareId=ESP32-301&layer=noiseAvg&alertId=a-noise',
      '/floorplan?floor=2&roomId=room-2&deviceId=dev-2&hardwareId=ESP32-201&layer=wifiRssi&alertId=a-offline',
    ]);

    // Click Tap 1 ('Nhận xử lý') on the TEMPERATURE alert -> claims in-place without forcing router.push
    const claimButtons = screen.getAllByRole('button', { name: 'Nhận xử lý' });
    fireEvent.click(claimButtons[0]);

    await waitFor(() => {
      expect(workflowSpy).toHaveBeenCalledWith('a-temp', {
        workflowStatus: 'IN_PROGRESS',
      });
    });
    expect(routerPushSpy).not.toHaveBeenCalled();
  });
});
