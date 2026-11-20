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
import { ToastProvider } from '@/components/ui/primitives';
import { TQB_ROOM_PRESETS } from '@/config/tqb-floorplan-presets';
import { alertsApi } from '@/features/alerts/api';
import { useAuthStore } from '@/features/auth/store';
import { devicesApi } from '@/features/devices/api';
import { TimeComparisonBar } from '@/features/floorplan/components/TimeComparisonBar';
import { roomsApi } from '@/features/rooms/api';
import { telemetryApi } from '@/features/telemetry/api';
import {
  parseFloorplanUrlState,
  serializeFloorplanUrlState,
} from '@/lib/floorplan/deepLink';
import {
  exportFloorplanReportPdf,
  exportFloorplanReportPng,
} from '@/lib/floorplan/exportReport';
import {
  buildEventPlaybackFrames,
  computeOneHourDelta,
  computeTypicalDayFloorSnapshot,
} from '@/lib/floorplan/timeAnalysis';
import { buildCapabilities } from '@/lib/rbac/capabilities';
import { parseScopeString } from '@/lib/rbac/scope-parser';
import { stompManager } from '@/lib/realtime/stomp-client';
import type {
  AlertResponse,
  BucketDataPoint,
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

function installCanvas2DMock() {
  const fillTextCalls: string[] = [];
  const drawImageCalls: unknown[] = [];

  const createMockCtx = (canvas?: HTMLCanvasElement) => {
    const grad = { addColorStop: vi.fn() };
    return {
      canvas,
      fillStyle: '#000',
      strokeStyle: '#000',
      lineWidth: 1,
      globalAlpha: 1,
      font: '12px sans-serif',
      textAlign: 'left',
      textBaseline: 'alphabetic',
      shadowColor: 'transparent',
      shadowBlur: 0,
      filter: 'none',
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'high' as ImageSmoothingQuality,
      setTransform: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      scale: vi.fn(),
      rotate: vi.fn(),
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
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
      createLinearGradient: vi.fn(() => grad),
      createRadialGradient: vi.fn(() => grad),
      measureText: vi.fn((text: string) => ({ width: text.length * 7 })),
      fillText: vi.fn((text: string) => {
        fillTextCalls.push(String(text));
      }),
      strokeText: vi.fn(),
      createImageData: vi.fn((w: number, h: number) => ({
        width: w,
        height: h,
        data: new Uint8ClampedArray(w * h * 4),
        colorSpace: 'srgb' as PredefinedColorSpace,
      })),
      putImageData: vi.fn(),
      drawImage: vi.fn((src: unknown) => {
        drawImageCalls.push(src);
      }),
    } as unknown as CanvasRenderingContext2D;
  };

  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    function (this: HTMLCanvasElement, contextId: string) {
      if (contextId !== '2d') return null;
      return createMockCtx(this);
    }
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(
    () => 'data:image/png;base64,MOCK_PNG_REPORT_DATA'
  );

  return { fillTextCalls, drawImageCalls, createMockCtx };
}

function makeRoomFromPreset(code: string, idOverride?: string): RoomResponse {
  const preset = TQB_ROOM_PRESETS.find((p) => p.code === code);
  if (!preset) {
    throw new Error(`Missing preset ${code}`);
  }
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
    temperature?: number;
    noiseAvg?: number;
    humidity?: number;
    pm25?: number;
    lux?: number;
    timestamp?: string;
  } = {}
): TelemetryResponse {
  const score = overrides.score ?? 82;
  return {
    id: `tel-${roomId}`,
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    isSynthetic: false,
    metadata: {
      deviceId: `dev-${roomId}`,
      hardwareId: `ESP32_${roomId}`,
      roomId,
    },
    environment: {
      temperature: overrides.temperature ?? 23.2,
      humidity: overrides.humidity ?? 52.0,
      lux: overrides.lux ?? 380,
    },
    acoustics: {
      noiseAvg: overrides.noiseAvg ?? 42.0,
      noisePeak: (overrides.noiseAvg ?? 42.0) + 6,
    },
    airQuality: {
      pm1_0: 8,
      pm2_5: overrides.pm25 ?? 12.0,
      pm4_0: 15,
      pm10: 18,
    },
    comfortScore: {
      overall: score,
      grade: score >= 75 ? 'Gold' : score >= 60 ? 'Silver' : 'Poor',
      acousticScore: score,
      airScore: score,
      thermalScore: score,
      lightScore: score,
    },
    wifiRssi: -55,
  };
}

function makeDevice(
  id: string,
  hardwareId: string,
  roomId: string,
  zoneId = 'ZONE_A'
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
    posX: 0.45,
    posY: 0.45,
    lastSeenAt: new Date().toISOString(),
    lastOfflineAt: null,
  };
}

function makeAlert(overrides: Partial<AlertResponse> = {}): AlertResponse {
  return {
    id: 'alert-g7-1',
    deviceId: 'dev-302',
    hardwareId: 'ESP32_302_01',
    roomId: 'ROOM_302',
    zoneId: 'ZONE_B',
    type: 'NOISE_EXCEEDED',
    metricType: 'NOISE_PEAK',
    severity: 'CRITICAL',
    status: 'FIRING',
    workflowStatus: 'NEW',
    assignedTo: 'ktv.nam',
    handlingNote: null,
    inProgressAt: null,
    currentValue: 86.0,
    threshold: 85.0,
    message: 'Độ ồn 86.0 dBA vượt ngưỡng',
    recommendedAction: 'Nhắc nhở giữ trật tự khu vực phòng nhóm.',
    startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    acknowledgedAt: null,
    resolvedAt: null,
    acknowledgedBy: null,
    resolvedBy: null,
    ...overrides,
  };
}

function authenticateAsLibrarian() {
  const user: UserResponse = {
    id: 'u-librarian-g7',
    username: 'quanly.thuvien',
    active: true,
    roles: [{ name: 'LIBRARIAN', description: 'Librarian', permissions: [] }],
    assignedZones: ['ZONE_A', 'ZONE_B'],
  };
  useAuthStore.setState({
    accessToken: 'test-token',
    refreshToken: 'test-refresh',
    user,
    capabilities: buildCapabilities(
      parseScopeString(
        'ROLE_LIBRARIAN VIEW_ROOMS MANAGE_ROOMS VIEW_DEVICES VIEW_ALERTS ACKNOWLEDGE_ALERT MANAGE_ALERT_CONFIG'
      )
    ),
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

describe('Phase 7 (GĐ7): Chiều Thời Gian (-1h, Playback, Ngày Điển Hình), Deep Link & Xuất Báo Cáo PNG/PDF', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/floorplan');
    installCanvas2DMock();
    vi.spyOn(stompManager, 'isConnected').mockReturnValue(true);
    vi.spyOn(stompManager, 'onConnectionChange').mockImplementation((cb) => {
      cb(true);
      return vi.fn();
    });
    vi.spyOn(stompManager, 'subscribeRoom').mockImplementation(() => vi.fn());
    vi.spyOn(stompManager, 'onAlert').mockImplementation(() => vi.fn());
  });

  afterEach(() => {
    window.history.replaceState({}, '', '/floorplan');
    vi.restoreAllMocks();
    cleanup();
    useAuthStore.setState({
      accessToken: null,
      refreshToken: null,
      user: null,
      capabilities: buildCapabilities(parseScopeString('')),
      hydrated: true,
      isKioskSession: false,
    });
  });

  it('TC-G7-01: Tính toán chênh lệch -1h, mũi tên xu hướng ↑ ↓ → theo deadband và hiển thị trong Drawer chế độ compare_1h', async () => {
    const anchorMs = Date.parse('2026-11-18T10:00:00.000Z');
    const buckets: BucketDataPoint[] = [
      {
        bucketTime: '2026-11-18T08:45:00.000Z',
        comfortScoreAvg: 84,
        tempAvg: 22.1,
        noiseAvg: 42.0,
      },
      {
        bucketTime: '2026-11-18T09:00:00.000Z', // đúng mốc -1h
        comfortScoreAvg: 82,
        tempAvg: 22.5,
        noiseAvg: 43.0,
      },
      {
        bucketTime: '2026-11-18T09:45:00.000Z',
        comfortScoreAvg: 70,
        tempAvg: 24.4,
        noiseAvg: 43.8,
      },
    ];

    const lcsDelta = computeOneHourDelta(68, buckets, 'comfortScore', anchorMs);
    expect(lcsDelta.delta).toBe(-14);
    expect(lcsDelta.trend).toBe('DOWN');
    expect(lcsDelta.arrow).toBe('↓');
    expect(lcsDelta.text).toBe('↓ -14đ');

    const tempDelta = computeOneHourDelta(24.6, buckets, 'temperature', anchorMs);
    expect(tempDelta.delta).toBe(2.1);
    expect(tempDelta.trend).toBe('UP');
    expect(tempDelta.arrow).toBe('↑');
    expect(tempDelta.text).toBe('↑ +2.1°C');

    // Trong vùng deadband (< 1.5 dBA) -> mũi tên ổn định →
    const noiseStable = computeOneHourDelta(44.0, buckets, 'noiseAvg', anchorMs);
    expect(noiseStable.trend).toBe('STABLE');
    expect(noiseStable.arrow).toBe('→');

    // Tích hợp UI: bật "So sánh 1 giờ trước" trên FloorplanPage và chọn phòng
    authenticateAsLibrarian();
    const room301 = makeRoomFromPreset('TQB_301', 'ROOM_301');
    const now = Date.now();
    const oneHourAgoIso = new Date(now - 60 * 60_000).toISOString();

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
      makeTelemetry('ROOM_301', { score: 68, temperature: 24.6 })
    );
    vi.spyOn(telemetryApi, 'getRoomBuckets').mockResolvedValue({
      roomId: 'ROOM_301',
      interval: '15m',
      dataPoints: [
        {
          bucketTime: oneHourAgoIso,
          comfortScoreAvg: 82,
          tempAvg: 22.5,
          noiseAvg: 42.0,
        },
      ],
    });

    window.history.replaceState(
      {},
      '',
      '/floorplan?floor=3&roomId=ROOM_301&timeMode=compare_1h'
    );
    renderFloorplanPage();

    expect(screen.queryByTestId('time-comparison-bar')).not.toBeInTheDocument();

    const drawerDelta = await screen.findByTestId('drawer-delta-1h');
    expect(drawerDelta).toHaveTextContent('↓ -14đ so với 1h trước');
    window.history.replaceState({}, '', '/floorplan');
  });

  it('TC-G7-02: Xử lý an toàn khi thiếu dữ liệu lịch sử -1h (buckets = []) không gây NaN', () => {
    const emptyRes = computeOneHourDelta(78, [], 'comfortScore');
    expect(emptyRes.delta).toBeNull();
    expect(emptyRes.trend).toBe('STABLE');
    expect(emptyRes.arrow).toBe('→');
    expect(emptyRes.hasBaseline).toBe(false);
    expect(emptyRes.text).toBe('Chưa đủ dữ liệu -1h');

    const nullCurRes = computeOneHourDelta(null, [], 'temperature');
    expect(nullCurRes.delta).toBeNull();
    expect(nullCurRes.text).toBe('Chưa đủ dữ liệu -1h');
  });

  it('TC-G7-03: Phát lại sự kiện (Event Playback) xác định đúng nơi khởi phát (#1), hướng lan truyền (#2) & đồng bộ thanh tua UI', async () => {
    const room301 = makeRoomFromPreset('TQB_301', 'ROOM_301');
    const room302 = makeRoomFromPreset('TQB_302', 'ROOM_302');

    const t0 = '2026-11-18T09:00:00.000Z';
    const t1 = '2026-11-18T09:15:00.000Z';
    const t2 = '2026-11-18T09:30:00.000Z';
    const t3 = '2026-11-18T09:45:00.000Z';

    const roomBuckets: Record<string, BucketDataPoint[]> = {
      ROOM_302: [
        { bucketTime: t0, noiseAvg: 44, comfortScoreAvg: 84 },
        { bucketTime: t1, noiseAvg: 76, comfortScoreAvg: 46 }, // Khởi phát vượt ngưỡng (P.302)
        { bucketTime: t2, noiseAvg: 78, comfortScoreAvg: 44 },
        { bucketTime: t3, noiseAvg: 43, comfortScoreAvg: 85 }, // Đã ổn định lại
      ],
      ROOM_301: [
        { bucketTime: t0, noiseAvg: 40, comfortScoreAvg: 90 },
        { bucketTime: t1, noiseAvg: 45, comfortScoreAvg: 82 },
        { bucketTime: t2, noiseAvg: 68, comfortScoreAvg: 58 }, // Lan truyền sang P.301 (> 60 dBA STUDY_ROOM)
        { bucketTime: t3, noiseAvg: 66, comfortScoreAvg: 60 },
      ],
    };

    const frames = buildEventPlaybackFrames(
      [room301, room302],
      roomBuckets,
      'noiseAvg'
    );
    expect(frames).toHaveLength(4);

    // Tại t0: chưa vượt ngưỡng
    expect(frames[0].exceedingRooms).toHaveLength(0);

    // Tại t1: P.302 khởi phát (#1)
    expect(frames[1].originRoomId).toBe('ROOM_302');
    expect(frames[1].roomStates['ROOM_302'].propagationRole).toBe('ORIGIN');
    expect(frames[1].roomStates['ROOM_302'].propagationLabelVi).toBe(
      'Khởi phát sự cố (#1)'
    );
    expect(frames[1].roomStates['ROOM_301'].propagationRole).toBe('NORMAL');

    // Tại t2: P.302 giữ ORIGIN (#1), P.301 gắn nhãn Lan truyền (#2)
    expect(frames[2].roomStates['ROOM_302'].propagationRole).toBe('ORIGIN');
    expect(frames[2].roomStates['ROOM_301'].propagationRole).toBe('SPREAD');
    expect(frames[2].roomStates['ROOM_301'].propagationLabelVi).toBe(
      'Lan truyền (#2)'
    );

    // Tại t3: P.302 hạ về 43 dBA -> Đã ổn định lại
    expect(frames[3].roomStates['ROOM_302'].propagationRole).toBe('RECOVERED');
    expect(frames[3].roomStates['ROOM_302'].propagationLabelVi).toBe(
      'Đã ổn định lại'
    );

    // Kiểm thử UI thanh tua Playback trên component TimeComparisonBar độc lập
    function ControlledPlaybackBar() {
      const [idx, setIdx] = React.useState(0);
      return (
        <TimeComparisonBar
          timeMode="playback"
          onTimeModeChange={() => {}}
          frames={frames}
          playbackIndex={idx}
          onPlaybackIndexChange={setIdx}
        />
      );
    }

    render(<ControlledPlaybackBar />);

    await screen.findByTestId('playback-subbar');
    const slider = screen.getByTestId('playback-slider');
    const summary = screen.getByTestId('playback-propagation-summary');
    expect(slider).toHaveAttribute('max', '3');

    // Tua sang t1 -> hiện Khởi phát sự cố (#1)
    fireEvent.change(slider, { target: { value: '1' } });
    expect(summary).toHaveTextContent('P.302: Khởi phát sự cố (#1)');

    // Bấm bước tiếp sang t2 -> hiện cả Lan truyền (#2)
    fireEvent.click(screen.getByTestId('playback-next-btn'));
    expect(summary).toHaveTextContent('P.302: Khởi phát sự cố (#1)');
    expect(summary).toHaveTextContent('P.301: Lan truyền (#2)');
  });

  it('TC-G7-04: Chế độ Ngày điển hình 07:00 – 21:00 phản ánh bức xạ nhiệt cánh Tây buổi chiều 15:00 cao hơn sáng 08:00', async () => {
    const floor3Rooms = TQB_ROOM_PRESETS.filter((p) => p.floor === 3).map((p) =>
      makeRoomFromPreset(p.code, `ROOM_${p.code}`)
    );

    const morning = computeTypicalDayFloorSnapshot(floor3Rooms, 8);
    const afternoon = computeTypicalDayFloorSnapshot(floor3Rooms, 15);

    expect(morning.hour).toBe(8);
    expect(morning.hourLabel).toBe('08:00');
    expect(afternoon.hour).toBe(15);
    expect(afternoon.hourLabel).toBe('15:00');
    expect(afternoon.westWingTempAvg).not.toBeNull();
    expect(morning.westWingTempAvg).not.toBeNull();
    expect(afternoon.westWingTempAvg!).toBeGreaterThan(morning.westWingTempAvg!);
    expect(afternoon.westWingTempAvg!).toBeGreaterThan(
      afternoon.nonWestWingTempAvg!
    );

    // Kịch bản tổng hợp dữ liệu lịch sử 7 ngày quan sát thật
    const westRoom = floor3Rooms[0];
    const observedBuckets: BucketDataPoint[] = Array.from({ length: 7 }, (_, d) => ({
      bucketTime: `2026-11-${String(10 + d).padStart(2, '0')}T15:00:00`,
      tempAvg: 27.4,
      noiseAvg: 53.0,
      comfortScoreAvg: 66,
    }));
    const withObs = computeTypicalDayFloorSnapshot(floor3Rooms, 15, {
      [westRoom.id]: observedBuckets,
    });
    expect(withObs.isHistoricalObserved).toBe(true);
    expect(withObs.telemetryByRoomId[westRoom.id].environment?.temperature).toBeCloseTo(
      27.4,
      1
    );

    // Kiểm thử thanh trượt giờ Ngày điển hình trên component TimeComparisonBar độc lập
    function ControlledTypicalBar() {
      const [hour, setHour] = React.useState(15);
      const snap = computeTypicalDayFloorSnapshot(floor3Rooms, hour);
      return (
        <TimeComparisonBar
          timeMode="typical_day"
          onTimeModeChange={() => {}}
          typicalHour={hour}
          onTypicalHourChange={setHour}
          typicalSummaryNote={snap.summaryNoteVi}
        />
      );
    }

    render(<ControlledTypicalBar />);

    const slider = await screen.findByTestId('typical-hour-slider');
    const hourLabel = screen.getByTestId('typical-hour-label');

    fireEvent.change(slider, { target: { value: '8' } });
    expect(hourLabel).toHaveTextContent('08:00');

    fireEvent.change(slider, { target: { value: '15' } });
    expect(hourLabel).toHaveTextContent('15:00');
    expect(screen.getByTestId('typical-day-summary')).toHaveTextContent(/cánh Tây/i);
  });

  it('TC-G7-05: Tuần tự hóa <-> khôi phục Deep Link chính xác 100%, chống tham số rác & khôi phục khung nhìn khi mở trang', async () => {
    const expectedState = {
      floor: 5,
      roomId: 'ROOM_502',
      layer: 'noiseAvg' as const,
      scale: 2.25,
      tx: -310,
      ty: -140,
      timeMode: 'compare_1h' as const,
      statusFilter: 'POOR' as const,
    };

    const query = serializeFloorplanUrlState(expectedState);
    const parsed = parseFloorplanUrlState(query, [1, 2, 3, 4, 5]);
    expect(parsed.floor).toBe(5);
    expect(parsed.roomId).toBe('ROOM_502');
    expect(parsed.layer).toBe('noiseAvg');
    expect(parsed.scale).toBe(2.25);
    expect(parsed.tx).toBe(-310);
    expect(parsed.ty).toBe(-140);
    expect(parsed.timeMode).toBe('compare_1h');
    expect(parsed.statusFilter).toBe('POOR');

    // Tham số rác -> tự động kẹp / fallback giá trị an toàn
    const sanitized = parseFloorplanUrlState(
      '?floor=99&scale=-5&tx=400&ty=abc&layer=unknown&timeMode=bogus&statusFilter=BAD',
      [1, 2, 3, 4, 5]
    );
    expect(sanitized.floor).toBe(3);
    expect(sanitized.scale).toBe(1);
    expect(sanitized.tx).toBe(0);
    expect(sanitized.ty).toBe(0);
    expect(sanitized.layer).toBe('comfortScore');
    expect(sanitized.timeMode).toBe('live');
    expect(sanitized.statusFilter).toBe('ALL');

    // Khôi phục toàn bộ trạng thái trên <FloorplanPage /> khi mở URL deep link
    authenticateAsLibrarian();
    const room502 = makeRoomFromPreset('TQB_502', 'ROOM_502');
    vi.spyOn(roomsApi, 'list').mockResolvedValue({
      content: [room502],
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
      makeTelemetry('ROOM_502', { score: 45, noiseAvg: 79 })
    );
    vi.spyOn(telemetryApi, 'getRoomBuckets').mockResolvedValue({
      roomId: 'ROOM_502',
      interval: '15m',
      dataPoints: [],
    });

    window.history.replaceState({}, '', `/floorplan?${query}`);
    renderFloorplanPage();

    expect(screen.queryByTestId('time-comparison-bar')).not.toBeInTheDocument();
    expect(screen.queryByTestId('summary-filter-poor')).not.toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByTestId('breadcrumb-floor-btn')).toHaveTextContent('Tầng 5');
      expect(screen.getByTestId('breadcrumb-room-label')).toHaveTextContent('TQB_502');
      expect(screen.getByTestId('layer-btn-noiseAvg')).toHaveAttribute(
        'aria-pressed',
        'true'
      );
      expect(screen.getByTestId('zoom-scale-label')).toHaveTextContent('2.25x');
    });
  });

  it('TC-G7-06: Xuất báo cáo PNG vẽ đầy đủ Bản đồ + Chú giải + Mốc thời gian + Tóm tắt cảnh báo & tải về .png', () => {
    const fillTextCalls: string[] = [];
    const drawImageCalls: unknown[] = [];

    const mockStatic = document.createElement('canvas');
    mockStatic.width = 960;
    mockStatic.height = 722;
    const mockDynamic = document.createElement('canvas');
    mockDynamic.width = 960;
    mockDynamic.height = 722;

    const createCanvas = (w: number, h: number) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const grad = { addColorStop: vi.fn() };
      vi.spyOn(c, 'getContext').mockReturnValue({
        fillStyle: '#000',
        strokeStyle: '#000',
        lineWidth: 1,
        font: '12px sans-serif',
        textBaseline: 'top',
        fillRect: vi.fn(),
        strokeRect: vi.fn(),
        beginPath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        stroke: vi.fn(),
        createLinearGradient: vi.fn(() => grad),
        fillText: vi.fn((text: string) => {
          fillTextCalls.push(String(text));
        }),
        drawImage: vi.fn((src: unknown) => {
          drawImageCalls.push(src);
        }),
      } as unknown as CanvasRenderingContext2D);
      vi.spyOn(c, 'toDataURL').mockReturnValue('data:image/png;base64,REPORT1920');
      return c;
    };

    const triggerDownload = vi.fn();
    const room301 = makeRoomFromPreset('TQB_301', 'ROOM_301');
    const room302 = makeRoomFromPreset('TQB_302', 'ROOM_302');

    const res = exportFloorplanReportPng({
      floor: 3,
      layer: 'noiseAvg',
      staticCanvas: mockStatic,
      dynamicCanvas: mockDynamic,
      rooms: [room301, room302],
      roomTelemetryMap: {
        ROOM_301: makeTelemetry('ROOM_301', { score: 88, noiseAvg: 40 }),
        ROOM_302: makeTelemetry('ROOM_302', { score: 45, noiseAvg: 86 }),
      },
      openAlerts: [makeAlert({ roomId: 'ROOM_302', assignedTo: 'ktv.nam' })],
      exportedAt: '2026-11-18T10:30:00.000Z',
      exportedBy: 'quanly.tqb',
      timeModeLabel: 'So sánh 1 giờ trước',
      createCanvas,
      triggerDownload,
    });

    expect(res.width).toBe(1920);
    expect(res.height).toBe(1080);
    expect(res.filename).toMatch(/^aiot-tqb-tang-3-\d{8}\.png$/);
    expect(triggerDownload).toHaveBeenCalledWith(
      'data:image/png;base64,REPORT1920',
      res.filename
    );
    expect(drawImageCalls).toContain(mockStatic);
    expect(drawImageCalls).toContain(mockDynamic);

    const renderedAllText = fillTextCalls.join(' | ');
    expect(renderedAllText).toContain('TẦNG 3');
    expect(renderedAllText).toContain('Chú giải thang màu');
    expect(renderedAllText).toContain('Mốc thời gian');
    expect(renderedAllText).toContain('Tổng cảnh báo mở: 1');
    expect(renderedAllText).toContain('TQB_302');
  });

  it('TC-G7-07: Xuất báo cáo PDF sinh tài liệu chuẩn trang ngang (A4 landscape) kèm chú giải, mốc thời gian & danh sách cảnh báo', () => {
    const mockStatic = document.createElement('canvas');
    mockStatic.width = 960;
    mockStatic.height = 722;
    const mockDynamic = document.createElement('canvas');
    mockDynamic.width = 960;
    mockDynamic.height = 722;

    const openPrintWindow = vi.fn(() => true);
    const room302 = makeRoomFromPreset('TQB_302', 'ROOM_302');

    const res = exportFloorplanReportPdf({
      floor: 3,
      layer: 'comfortScore',
      staticCanvas: mockStatic,
      dynamicCanvas: mockDynamic,
      rooms: [room302],
      roomTelemetryMap: {
        ROOM_302: makeTelemetry('ROOM_302', { score: 49, noiseAvg: 86 }),
      },
      openAlerts: [makeAlert({ roomId: 'ROOM_302', assignedTo: 'thuthu.lan' })],
      exportedAt: '2026-11-18T10:30:00.000Z',
      exportedBy: 'quanly.tqb',
      openPrintWindow,
    });

    expect(res.printed).toBe(true);
    expect(openPrintWindow).toHaveBeenCalledTimes(1);
    expect(res.html).toContain('@page { size: A4 landscape;');
    expect(res.html).toContain('TẦNG 3');
    expect(res.html).toContain('Mốc thời gian');
    expect(res.html).toContain('Thang màu');
    expect(res.html).toContain('Cảnh báo mở: 1');
    expect(res.html).toContain('TQB_302');
    expect(res.html).toContain('thuthu.lan');
    expect(res.html).toContain('data:image/png;base64,MOCK_PNG_REPORT_DATA');
  });
});
