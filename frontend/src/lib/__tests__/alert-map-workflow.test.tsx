import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FloorplanPage from '@/app/(protected)/floorplan/page';
import { ToastProvider } from '@/components/ui/primitives';
import { TIMING_CONFIG } from '@/config/floorplan-hmi.config';
import { TQB_ROOM_PRESETS } from '@/config/tqb-floorplan-presets';
import { alertsApi } from '@/features/alerts/api';
import { useAuthStore } from '@/features/auth/store';
import { devicesApi } from '@/features/devices/api';
import { roomsApi } from '@/features/rooms/api';
import { telemetryApi } from '@/features/telemetry/api';
import { buildCapabilities } from '@/lib/rbac/capabilities';
import { parseScopeString } from '@/lib/rbac/scope-parser';
import { stompManager } from '@/lib/realtime/stomp-client';
import type {
  AlertResponse,
  DeviceResponse,
  RoomResponse,
  TelemetryResponse,
  UserResponse,
} from '@/types/api';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/floorplan',
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

function installMinimalCanvas2DMock() {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    function (this: HTMLCanvasElement, contextId: string) {
      if (contextId !== '2d') return null;
      return {
        canvas: this,
        fillStyle: '#000000',
        strokeStyle: '#000000',
        lineWidth: 1,
        font: '12px sans-serif',
        textAlign: 'left',
        textBaseline: 'alphabetic',
        globalAlpha: 1,
        shadowColor: 'transparent',
        shadowBlur: 0,
        filter: 'none',
        imageSmoothingEnabled: true,
        imageSmoothingQuality: 'high' as ImageSmoothingQuality,
        save: vi.fn(),
        restore: vi.fn(),
        setTransform: vi.fn(),
        clearRect: vi.fn(),
        fillRect: vi.fn(),
        translate: vi.fn(),
        scale: vi.fn(),
        beginPath: vi.fn(),
        closePath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        arc: vi.fn(),
        rect: vi.fn(),
        roundRect: vi.fn(),
        clip: vi.fn(),
        fill: vi.fn(),
        stroke: vi.fn(),
        setLineDash: vi.fn(),
        createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
        createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
        measureText: vi.fn((text: string) => ({ width: text.length * 7 })),
        fillText: vi.fn(),
        strokeText: vi.fn(),
        createImageData: vi.fn((w: number, h: number) => ({
          width: w,
          height: h,
          data: new Uint8ClampedArray(w * h * 4),
          colorSpace: 'srgb' as PredefinedColorSpace,
        })),
        putImageData: vi.fn(),
        drawImage: vi.fn(),
      } as unknown as CanvasRenderingContext2D;
    }
  );
}

function makeRoomFromPreset(code: string, idOverride?: string): RoomResponse {
  const preset = TQB_ROOM_PRESETS.find((p) => p.code === code);
  if (!preset) throw new Error(`Missing preset ${code}`);
  return {
    id: idOverride ?? `PRESET_${preset.code}`,
    code: preset.code,
    name: preset.name,
    floor: preset.floor,
    capacity: preset.capacity,
    type: preset.roomType,
    targetComfortScore: preset.roomType === 'BOOK_STORAGE' ? 90 : 85,
    boundaryPolygon: [...preset.boundaryPolygon],
  };
}

function makeTelemetry(
  roomId: string,
  overrides: {
    score?: number;
    noiseAvg?: number;
    temperature?: number;
    humidity?: number;
    pm2_5?: number;
  } = {}
): TelemetryResponse {
  return {
    id: `tel-${roomId}`,
    timestamp: new Date().toISOString(),
    isSynthetic: false,
    metadata: {
      deviceId: `dev-${roomId}`,
      hardwareId: `ESP32_${roomId}`,
      roomId,
    },
    environment: {
      temperature: overrides.temperature ?? 23.8,
      humidity: overrides.humidity ?? 52.0,
      lux: 410,
    },
    acoustics: {
      noiseAvg: overrides.noiseAvg ?? 44.0,
      noisePeak: (overrides.noiseAvg ?? 44.0) + 6,
    },
    airQuality: {
      pm1_0: 8.0,
      pm2_5: overrides.pm2_5 ?? 12.0,
      pm4_0: 15.0,
      pm10: 18.0,
    },
    wifiRssi: -56,
    comfortScore: {
      overall: overrides.score ?? 84,
      grade: (overrides.score ?? 84) >= 80 ? 'Gold' : 'Poor',
      thermalScore: 85,
      acousticScore: 84,
      airScore: 86,
      lightScore: 82,
    },
  };
}

function makeDevice(
  id: string,
  hardwareId: string,
  roomId: string,
  zoneId = 'ZONE_A',
  pos = { x: 0.4, y: 0.4 }
): DeviceResponse {
  return {
    id,
    hardwareId,
    name: `Trạm ${hardwareId}`,
    roomId,
    zoneId,
    deviceType: 'ESP32_NODE',
    active: true,
    online: true,
    connectionState: 'ONLINE',
    posX: pos.x,
    posY: pos.y,
    lastSeenAt: new Date().toISOString(),
    lastOfflineAt: null,
  };
}

function makeAlert(overrides: Partial<AlertResponse> = {}): AlertResponse {
  return {
    id: 'alert-1',
    deviceId: 'dev-302',
    hardwareId: 'ESP32_302_01',
    roomId: 'ROOM_302',
    zoneId: 'ZONE_B',
    type: 'NOISE_EXCEEDED',
    metricType: 'NOISE_PEAK',
    severity: 'CRITICAL',
    status: 'FIRING',
    workflowStatus: 'NEW',
    assignedTo: null,
    handlingNote: null,
    inProgressAt: null,
    currentValue: 86.0,
    threshold: 85.0,
    message: 'Độ ồn đạt 86.0 dBA vượt ngưỡng cho phép 75.0 dBA',
    recommendedAction: 'Nhắc nhở nhóm sinh viên khu vực đa phương tiện giảm âm lượng.',
    startedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    acknowledgedAt: null,
    resolvedAt: null,
    acknowledgedBy: null,
    resolvedBy: null,
    ...overrides,
  };
}

function authenticateAs(
  role: 'LIBRARIAN' | 'ADMIN' | 'ZONE_MANAGER' = 'LIBRARIAN',
  assignedZones: string[] = ['ZONE_A', 'ZONE_B']
) {
  const user: UserResponse = {
    id: `u-${role.toLowerCase()}`,
    username: role === 'ADMIN' ? 'admin.tqb' : 'quanly.tqb',
    active: true,
    roles: [{ name: role, description: role, permissions: [] }],
    assignedZones,
  };

  const scope =
    role === 'ADMIN'
      ? 'ROLE_ADMIN VIEW_ROOMS MANAGE_ROOMS VIEW_DEVICES MANAGE_DEVICES VIEW_ALERTS ACKNOWLEDGE_ALERT MANAGE_ALERT_CONFIG'
      : 'ROLE_LIBRARIAN VIEW_ROOMS MANAGE_ROOMS VIEW_DEVICES VIEW_ALERTS ACKNOWLEDGE_ALERT MANAGE_ALERT_CONFIG';

  useAuthStore.setState({
    accessToken: 'test-token',
    refreshToken: 'test-refresh',
    user,
    capabilities: buildCapabilities(parseScopeString(scope)),
    hydrated: true,
    isKioskSession: false,
  });
}

function renderFloorplanPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <FloorplanPage />
        </ToastProvider>
      </QueryClientProvider>
    ),
  };
}

describe('Phase 6 — Xử lý Cảnh báo Trực tiếp Trên Bản Đồ (TC-G6-06..11)', () => {
  beforeEach(() => {
    installMinimalCanvas2DMock();
    vi.spyOn(stompManager, 'isConnected').mockReturnValue(true);
    vi.spyOn(stompManager, 'onConnectionChange').mockImplementation((cb) => {
      cb(true);
      return vi.fn();
    });
    vi.spyOn(stompManager, 'subscribeRoom').mockImplementation(() => vi.fn());
    vi.spyOn(stompManager, 'onAlert').mockImplementation(() => vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it('TC-G6-06: Click vùng cảnh báo trên bản đồ mở Drawer với tóm tắt dễ hiểu, SOP, người phụ trách và nút Xác nhận / Giao việc / Ghi chú', async () => {
    authenticateAs('LIBRARIAN');
    const room301 = makeRoomFromPreset('TQB_301', 'ROOM_301');
    const room302 = makeRoomFromPreset('TQB_302', 'ROOM_302');

    vi.spyOn(roomsApi, 'list').mockResolvedValue({
      content: [room301, room302],
      page: 0,
      size: 100,
      totalElements: 2,
      totalPages: 1,
      last: true,
    });
    vi.spyOn(devicesApi, 'list').mockResolvedValue({
      content: [makeDevice('dev-302', 'ESP32_302_01', 'ROOM_302', 'ZONE_B')],
      page: 0,
      size: 100,
      totalElements: 1,
      totalPages: 1,
      last: true,
    });
    vi.spyOn(alertsApi, 'list').mockResolvedValue({
      content: [
        makeAlert({
          id: 'alert-302-noise',
          roomId: 'ROOM_302',
          type: 'NOISE_EXCEEDED',
          message: 'Noise spike 86.0 dBA exceeds 75.0 dBA',
          recommendedAction: null,
        }),
      ],
      page: 0,
      size: 50,
      totalElements: 1,
      totalPages: 1,
      last: true,
    });
    vi.spyOn(telemetryApi, 'getRoomLatest').mockImplementation(async (id) =>
      makeTelemetry(id, {
        score: id === 'ROOM_302' ? 46 : 86,
        noiseAvg: id === 'ROOM_302' ? 86.0 : 42.0,
      })
    );

    renderFloorplanPage();

    const badge = await screen.findByTestId('room-alert-badge-ROOM_302');
    fireEvent.click(badge);

    const drawer = await screen.findByTestId('room-detail-drawer');
    const inspector = within(drawer).getByTestId('alert-inspector-drawer');

    // Tóm tắt ngôn ngữ tự nhiên tiếng Việt (dễ hiểu cho quản lý)
    expect(inspector).toHaveTextContent(/Độ ồn tại TQB_302/i);
    expect(inspector).toHaveTextContent(/86\.0 dBA/);
    expect(inspector).toHaveTextContent(/Cần nhắc nhở độc giả giữ trật tự/i);

    // Hiển thị SOP khuyến nghị & đầy đủ nút Xác nhận / Giao việc / Ghi chú
    expect(within(inspector).getByTestId('alert-sop-alert-302-noise')).toHaveTextContent(
      /SOP khuyến nghị/i
    );
    expect(within(inspector).getByTestId('alert-ack-btn-alert-302-noise')).toHaveTextContent(
      'Xác nhận'
    );
    expect(within(inspector).getByText(/Giao việc/i)).toBeInTheDocument();
    expect(within(inspector).getByLabelText(/Ghi chú xử lý/i)).toBeInTheDocument();
  });

  it('TC-G6-07: Giao việc và lưu Ghi chú xử lý trên Drawer gọi PATCH /alerts/alert-1/workflow và cập nhật UI ngay', async () => {
    authenticateAs('LIBRARIAN');
    const room302 = makeRoomFromPreset('TQB_302', 'ROOM_302');

    vi.spyOn(roomsApi, 'list').mockResolvedValue({
      content: [room302],
      page: 0,
      size: 100,
      totalElements: 1,
      totalPages: 1,
      last: true,
    });
    vi.spyOn(devicesApi, 'list').mockResolvedValue({
      content: [makeDevice('dev-302', 'ESP32_302_01', 'ROOM_302', 'ZONE_B')],
      page: 0,
      size: 100,
      totalElements: 1,
      totalPages: 1,
      last: true,
    });
    let storedAlert = makeAlert({ id: 'alert-1', roomId: 'ROOM_302' });

    vi.spyOn(alertsApi, 'list').mockImplementation(async () => ({
      content: [storedAlert],
      page: 0,
      size: 50,
      totalElements: 1,
      totalPages: 1,
      last: true,
    }));
    vi.spyOn(telemetryApi, 'getRoomLatest').mockImplementation(async (id) =>
      makeTelemetry(id, { score: 48, noiseAvg: 86.0 })
    );

    const updateWorkflowSpy = vi
      .spyOn(alertsApi, 'updateWorkflow')
      .mockImplementation(async (_id, body) => {
        storedAlert = makeAlert({
          id: 'alert-1',
          roomId: 'ROOM_302',
          status: 'ACKNOWLEDGED',
          workflowStatus: body.workflowStatus ?? 'IN_PROGRESS',
          assignedTo: body.assignedTo ?? 'nguyenvana',
          handlingNote: body.handlingNote ?? 'Đã nhắc nhóm sinh viên bàn 3',
          acknowledgedAt: new Date().toISOString(),
          inProgressAt: new Date().toISOString(),
        });
        return storedAlert;
      });

    renderFloorplanPage();

    const badge = await screen.findByTestId('room-alert-badge-ROOM_302');
    fireEvent.click(badge);

    const assigneeInput = await screen.findByTestId('alert-assignee-input-alert-1');
    const noteInput = screen.getByTestId('alert-note-input-alert-1');
    const workflowSelect = screen.getByTestId('alert-workflow-select-alert-1');
    const saveBtn = screen.getByTestId('alert-save-workflow-btn-alert-1');

    fireEvent.change(assigneeInput, { target: { value: 'nguyenvana' } });
    fireEvent.change(noteInput, {
      target: { value: 'Đã nhắc nhóm sinh viên bàn 3' },
    });
    fireEvent.change(workflowSelect, { target: { value: 'IN_PROGRESS' } });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(updateWorkflowSpy).toHaveBeenCalledWith('alert-1', {
        workflowStatus: 'IN_PROGRESS',
        assignedTo: 'nguyenvana',
        handlingNote: 'Đã nhắc nhóm sinh viên bàn 3',
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('alert-status-pill-alert-1')).toHaveTextContent(
        'Đang xử lý'
      );
      expect(screen.getByTestId('alert-assignee-badge-alert-1')).toHaveTextContent(
        'Phụ trách: nguyenvana'
      );
    });
  });

  it('TC-G6-08: Làm nổi bật cảnh báo tồn đọng lâu (> overdueAlertMs) và đẩy lên đầu danh sách', async () => {
    authenticateAs('LIBRARIAN');
    const room301 = makeRoomFromPreset('TQB_301', 'ROOM_301');
    const room302 = makeRoomFromPreset('TQB_302', 'ROOM_302');

    const now = Date.now();
    const overdueStarted = new Date(
      now - (TIMING_CONFIG.overdueAlertMs + 5 * 60_000)
    ).toISOString(); // 20 phút trước
    const freshStarted = new Date(now - 4 * 60_000).toISOString(); // 4 phút trước

    vi.spyOn(roomsApi, 'list').mockResolvedValue({
      content: [room301, room302],
      page: 0,
      size: 100,
      totalElements: 2,
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
      content: [
        makeAlert({
          id: 'alert-fresh',
          roomId: 'ROOM_301',
          severity: 'CRITICAL',
          startedAt: freshStarted,
          workflowStatus: 'NEW',
        }),
        makeAlert({
          id: 'alert-overdue',
          roomId: 'ROOM_302',
          severity: 'MEDIUM',
          startedAt: overdueStarted,
          workflowStatus: 'NEW',
        }),
      ],
      page: 0,
      size: 50,
      totalElements: 2,
      totalPages: 1,
      last: true,
    });
    vi.spyOn(telemetryApi, 'getRoomLatest').mockImplementation(async (id) =>
      makeTelemetry(id, { score: 52 })
    );

    renderFloorplanPage();

    const queuePanel = await screen.findByTestId('map-alert-queue-panel');
    const overdueGroup = within(queuePanel).getByTestId('alert-group-ROOM_302');
    const freshGroup = within(queuePanel).getByTestId('alert-group-ROOM_301');

    // Cảnh báo A tồn đọng 20 phút được gắn huy hiệu và xếp TRƯỚC cảnh báo B (4 phút) dù severity trung bình
    expect(within(overdueGroup).getByTestId('group-overdue-badge-ROOM_302')).toHaveTextContent(
      /Tồn đọng 20 phút/i
    );
    expect(
      within(freshGroup).queryByTestId('group-overdue-badge-ROOM_301')
    ).not.toBeInTheDocument();
    expect(
      overdueGroup.compareDocumentPosition(freshGroup) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    // Trên bản đồ Canvas, huy hiệu phòng ROOM_302 cũng mang đánh dấu tồn đọng nổi bật
    const mapBadge302 = await screen.findByTestId('room-alert-badge-ROOM_302');
    expect(mapBadge302).toHaveAttribute('data-overdue', 'true');
    expect(mapBadge302).toHaveTextContent(/Tồn đọng/i);
  });

  it('TC-G6-09: Gom nhóm nhiều cảnh báo trong cùng phòng P.301 (3 cảnh báo) với mức nghiêm trọng cao nhất & mở rộng xem con', async () => {
    authenticateAs('LIBRARIAN');
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
      content: [
        makeAlert({
          id: 'a-301-noise',
          roomId: 'ROOM_301',
          type: 'NOISE_EXCEEDED',
          severity: 'MEDIUM',
          message: 'Noise 71 dBA',
        }),
        makeAlert({
          id: 'a-301-temp',
          roomId: 'ROOM_301',
          type: 'AIR_UNHEALTHY',
          metricType: 'TEMPERATURE',
          severity: 'HIGH',
          message: 'Temperature 33.0 °C',
        }),
        makeAlert({
          id: 'a-301-pm25',
          roomId: 'ROOM_301',
          type: 'AIR_UNHEALTHY',
          metricType: 'PM2_5',
          severity: 'CRITICAL',
          message: 'PM2.5 78 µg/m³',
        }),
      ],
      page: 0,
      size: 50,
      totalElements: 3,
      totalPages: 1,
      last: true,
    });
    vi.spyOn(telemetryApi, 'getRoomLatest').mockImplementation(async (id) =>
      makeTelemetry(id, { score: 42 })
    );

    renderFloorplanPage();

    const group301 = await screen.findByTestId('alert-group-ROOM_301');
    expect(group301).toHaveTextContent('P.301 (3 cảnh báo)');
    expect(group301).toHaveTextContent('Khẩn cấp'); // Highest severity CRITICAL

    // Mặc định đang thu gọn nhóm 3 cảnh báo -> chưa hiện item con
    expect(
      within(group301).queryByTestId('queue-alert-item-a-301-pm25')
    ).not.toBeInTheDocument();

    // Bấm Mở rộng (3)
    const expandBtn = within(group301).getByTestId('toggle-group-ROOM_301');
    fireEvent.click(expandBtn);

    expect(
      await within(group301).findByTestId('queue-alert-item-a-301-pm25')
    ).toBeInTheDocument();
    expect(within(group301).getByTestId('queue-alert-item-a-301-temp')).toBeInTheDocument();
    expect(within(group301).getByTestId('queue-alert-item-a-301-noise')).toBeInTheDocument();
  });

  it('TC-G6-10: Bấm "Bay tới vị trí" trên cảnh báo Tầng 5 chuyển từ Tầng 1 → Tầng 5, đổi lớp temperature, zoom P.502 & ghim node ESP32_T5_02', async () => {
    authenticateAs('LIBRARIAN');
    const room101 = makeRoomFromPreset('TQB_101', 'ROOM_101');
    const room502 = makeRoomFromPreset('TQB_502', 'ROOM_502');
    const devT502 = makeDevice('dev-t5-02', 'ESP32_T5_02', 'ROOM_502', 'ZONE_A', {
      x: 0.12,
      y: 0.55,
    });

    vi.spyOn(roomsApi, 'list').mockResolvedValue({
      content: [room101, room502],
      page: 0,
      size: 100,
      totalElements: 2,
      totalPages: 1,
      last: true,
    });
    vi.spyOn(devicesApi, 'list').mockResolvedValue({
      content: [devT502],
      page: 0,
      size: 100,
      totalElements: 1,
      totalPages: 1,
      last: true,
    });
    vi.spyOn(alertsApi, 'list').mockResolvedValue({
      content: [
        makeAlert({
          id: 'alert-fl5',
          roomId: 'ROOM_502',
          deviceId: 'dev-t5-02',
          hardwareId: 'ESP32_T5_02',
          type: 'AIR_UNHEALTHY',
          metricType: 'TEMPERATURE',
          severity: 'HIGH',
          message: 'Temperature 34.5 °C exceeds threshold',
          recommendedAction: 'Hạ rèm nắng hướng Tây và mở thêm điều hòa phòng nhóm.',
        }),
      ],
      page: 0,
      size: 50,
      totalElements: 1,
      totalPages: 1,
      last: true,
    });
    vi.spyOn(telemetryApi, 'getRoomLatest').mockImplementation(async (id) =>
      makeTelemetry(id, { score: 58, temperature: 34.5 })
    );
    vi.spyOn(telemetryApi, 'getDeviceLatest').mockImplementation(async () =>
      makeTelemetry('ROOM_502', { score: 58, temperature: 34.5 })
    );

    renderFloorplanPage();

    // Chuyển về Tầng 1 trước để kiểm chứng hành động bay xuyên tầng (Tầng 1 -> Tầng 5)
    const floor1Btn = await screen.findByRole('button', { name: 'Tầng 1' });
    fireEvent.click(floor1Btn);
    await waitFor(() => {
      expect(screen.getByTestId('breadcrumb-floor-btn')).toHaveTextContent(
        'Tầng 1'
      );
    });

    // Click nút "Bay tới vị trí" trong hàng đợi cảnh báo
    const flyToBtn = await screen.findByTestId('queue-fly-to-alert-fl5');
    fireEvent.click(flyToBtn);

    await waitFor(() => {
      expect(screen.getByTestId('breadcrumb-floor-btn')).toHaveTextContent(
        'Tầng 5'
      );
      expect(screen.getByTestId('breadcrumb-room-label')).toHaveTextContent(
        'TQB_502'
      );
      expect(screen.getByTestId('layer-btn-temperature')).toHaveAttribute(
        'aria-pressed',
        'true'
      );
    });

    // Drawer mở đúng phòng P.502 & ghim node ESP32_T5_02
    const drawer = await screen.findByTestId('room-detail-drawer');
    expect(drawer).toHaveTextContent('Node cảm biến đang định vị');
    expect(drawer).toHaveTextContent('ESP32_T5_02');
    expect(screen.getByTestId('device-pin-dev-t5-02')).toBeInTheDocument();
  });

  it('TC-G6-11: Thông báo aria-live="assertive" khi có cảnh báo FIRING mới qua STOMP & giữ cô lập phân khu fail-closed', async () => {
    authenticateAs('ZONE_MANAGER', ['ZONE_A']);
    const room301 = makeRoomFromPreset('TQB_301', 'ROOM_301');

    let capturedAlertListener: ((alert: AlertResponse) => void) | null = null;
    vi.spyOn(stompManager, 'onAlert').mockImplementation((cb) => {
      capturedAlertListener = cb;
      return vi.fn();
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
      content: [makeDevice('dev-301', 'ESP32_301_01', 'ROOM_301', 'ZONE_A')],
      page: 0,
      size: 100,
      totalElements: 1,
      totalPages: 1,
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
    vi.spyOn(telemetryApi, 'getRoomLatest').mockImplementation(async (id) =>
      makeTelemetry(id, { score: 88 })
    );

    renderFloorplanPage();

    const liveRegion = await screen.findByTestId('alert-live-region');
    expect(liveRegion).toHaveAttribute('aria-live', 'assertive');
    expect(liveRegion).toHaveAttribute('role', 'alert');

    await waitFor(() => {
      expect(capturedAlertListener).not.toBeNull();
    });

    // 1. Gói tin STOMP ngoài phân khu (ZONE_B) phải bị chặn fail-closed
    act(() => {
      capturedAlertListener?.(
        makeAlert({
          id: 'alert-outside',
          zoneId: 'ZONE_B',
          roomId: 'ROOM_302',
          status: 'FIRING',
          severity: 'CRITICAL',
          message: 'Outside zone noise spike',
        })
      );
    });
    expect(liveRegion).toHaveTextContent('');

    // 2. Gói tin STOMP FIRING mới thuộc ZONE_A cập nhật vùng aria-live="assertive" bằng tiếng Việt
    act(() => {
      capturedAlertListener?.(
        makeAlert({
          id: 'alert-zone-a',
          zoneId: 'ZONE_A',
          roomId: 'ROOM_301',
          deviceId: 'dev-301',
          hardwareId: 'ESP32_301_01',
          status: 'FIRING',
          severity: 'CRITICAL',
          type: 'NOISE_EXCEEDED',
          message: 'Noise spike 87.2 dBA',
        })
      );
    });

    await waitFor(() => {
      expect(liveRegion).toHaveTextContent(/Cảnh báo mới mức Khẩn cấp/i);
      expect(liveRegion).toHaveTextContent(/TQB_301/);
      expect(liveRegion).toHaveTextContent(/87\.2 dBA/);
    });
  });
});
