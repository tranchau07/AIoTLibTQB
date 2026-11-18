import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FloorplanPage from '@/app/(protected)/floorplan/page';
import { ToastProvider } from '@/components/ui/primitives';
import { TQB_ROOM_PRESETS } from '@/config/tqb-floorplan-presets';
import { alertsApi } from '@/features/alerts/api';
import { useAuthStore } from '@/features/auth/store';
import { devicesApi } from '@/features/devices/api';
import { roomsApi } from '@/features/rooms/api';
import { telemetryApi } from '@/features/telemetry/api';
import {
  classifyPixelReliability,
  evaluateRoomReliability,
} from '@/lib/floorplan/reliability';
import {
  computeAdaptiveSigma,
  renderWeatherDiffusionHeatmap,
} from '@/lib/floorplan/weatherPalette';
import { isTelemetryStale } from '@/lib/format/datetime';
import { UI_TEXT_VI } from '@/messages/vi';
import { buildCapabilities } from '@/lib/rbac/capabilities';
import { parseScopeString } from '@/lib/rbac/scope-parser';
import { stompManager } from '@/lib/realtime/stomp-client';
import type {
  DeviceResponse,
  Point2D,
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

interface CapturedCanvasOps {
  capturedImageData: ImageData[];
  arcCalls: Array<{ x: number; y: number; r: number }>;
  strokeCalls: number;
}

function installCanvasMockForReliability(): CapturedCanvasOps {
  const capturedImageData: ImageData[] = [];
  const arcCalls: Array<{ x: number; y: number; r: number }> = [];
  let strokeCalls = 0;

  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    function (this: HTMLCanvasElement, contextId: string) {
      if (contextId !== '2d') return null;
      const ctx = {
        canvas: this,
        font: '12px sans-serif',
        textAlign: 'left',
        textBaseline: 'alphabetic',
        shadowColor: 'transparent',
        shadowBlur: 0,
        filter: 'none',
        globalAlpha: 1,
        fillStyle: '#000000',
        strokeStyle: '#000000',
        lineWidth: 1,
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
        arc: vi.fn((x: number, y: number, r: number) => {
          arcCalls.push({ x, y, r });
        }),
        rect: vi.fn(),
        roundRect: vi.fn(),
        clip: vi.fn(),
        fill: vi.fn(),
        stroke: vi.fn(() => {
          strokeCalls++;
        }),
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
        putImageData: vi.fn((imgData: ImageData) => {
          capturedImageData.push(imgData);
        }),
        drawImage: vi.fn(),
      };
      return ctx as unknown as CanvasRenderingContext2D;
    }
  );

  return {
    capturedImageData,
    arcCalls,
    get strokeCalls() {
      return strokeCalls;
    },
  };
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
  timestamp: string,
  isSynthetic = false
): TelemetryResponse {
  return {
    id: `tel-${roomId}`,
    timestamp,
    isSynthetic,
    metadata: {
      deviceId: `dev-${roomId}`,
      hardwareId: `ESP32_${roomId}`,
      roomId,
    },
    environment: { temperature: 23.2, humidity: 51.0, lux: 410 },
    acoustics: { noiseAvg: 42.0, noisePeak: 47.0 },
    airQuality: { pm1_0: 8, pm2_5: 12, pm4_0: 15, pm10: 19 },
    comfortScore: {
      overall: 85,
      grade: 'Gold',
      acousticScore: 86,
      airScore: 88,
      thermalScore: 84,
      lightScore: 82,
    },
    wifiRssi: -55,
  };
}

function setupAuthLibrarian() {
  const user: UserResponse = {
    id: 'user-mgr-g4',
    username: 'quanly_tqb',
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
        'ROLE_LIBRARIAN VIEW_ROOMS VIEW_TELEMETRY VIEW_DEVICES VIEW_ALERTS ACKNOWLEDGE_ALERT RESOLVE_ALERT'
      )
    ),
    hydrated: true,
    isKioskSession: false,
  });
}

function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>
  );
}

describe('Phase 4 (GĐ4): Data Reliability (Measured/Interpolated/Blindspot/Stale) & Silent-Sensor Banners', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/floorplan');
    setupAuthLibrarian();
    vi.spyOn(stompManager, 'activate').mockImplementation(() => {});
    vi.spyOn(stompManager, 'isConnected').mockReturnValue(true);
    vi.spyOn(stompManager, 'onConnectionChange').mockImplementation((cb) => {
      cb(true);
      return vi.fn();
    });
    vi.spyOn(stompManager, 'subscribeRoom').mockImplementation(() => vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useAuthStore.setState({
      accessToken: null,
      refreshToken: null,
      user: null,
      capabilities: buildCapabilities(parseScopeString('')),
      hydrated: true,
      isKioskSession: false,
    });
  });

  it('TC-G4-01: classifies MEASURED when room has online sensors, fresh timestamp (10s), and low blindspotRatio', () => {
    const nowMs = Date.parse('2026-11-18T10:00:10.000Z');
    const summary = evaluateRoomReliability({
      room: { id: 'room-301', code: 'TQB_301', name: 'Phòng đọc 301' },
      telemetry: makeTelemetry('room-301', '2026-11-18T10:00:00.000Z'),
      devices: [
        { id: 'd1', online: true, connectionState: 'ONLINE' },
        { id: 'd2', online: true, connectionState: 'ONLINE' },
      ],
      blindspotRatio: 0.05,
      nowMs,
    });

    expect(summary.state).toBe('MEASURED');
    expect(summary.badgeText).toBe('Đo trực tiếp');
    expect(summary.onlineDeviceCount).toBe(2);
    expect(summary.totalDeviceCount).toBe(2);
    expect(summary.tooltipText).toContain('2/2 cảm biến');
  });

  it('TC-G4-02: classifies STALE when telemetry age exceeds default staleTelemetryMs (305s > 300s)', () => {
    const nowMs = Date.parse('2026-11-18T10:05:05.000Z');
    const summary = evaluateRoomReliability({
      room: { id: 'room-301', code: 'TQB_301', name: 'Phòng đọc 301' },
      telemetry: makeTelemetry('room-301', '2026-11-18T10:00:00.000Z'),
      devices: [{ id: 'd1', online: true, connectionState: 'ONLINE' }],
      nowMs,
    });

    expect(summary.state).toBe('STALE');
    expect(summary.badgeText).toBe('Dữ liệu trễ');
    expect(summary.isStale).toBe(true);
    expect(summary.relativeTimeText).toBe('5 phút trước');
    expect(summary.tooltipText).toContain('5 phút trước');
  });

  it('TC-G4-03: reacts immediately to configurable staleTelemetryMs override (60_000ms threshold at 90s age)', () => {
    const nowMs = Date.parse('2026-11-18T10:01:30.000Z');
    const ts = '2026-11-18T10:00:00.000Z';

    // Under default 5-minute threshold (300s), 90s is NOT stale
    expect(isTelemetryStale(ts, nowMs, false)).toBe(false);

    // Under custom 60s config threshold, 90s IS immediately stale
    expect(isTelemetryStale(ts, nowMs, false, 60_000)).toBe(true);

    const summary = evaluateRoomReliability({
      room: { id: 'room-301', code: 'TQB_301', name: 'Phòng đọc 301' },
      telemetry: makeTelemetry('room-301', ts),
      devices: [{ id: 'd1', online: true, connectionState: 'ONLINE' }],
      nowMs,
      config: { staleTelemetryMs: 60_000 },
    });

    expect(summary.state).toBe('STALE');
    expect(summary.badgeText).toBe('Dữ liệu trễ');
  });

  it('TC-G4-04: classifies BLINDSPOT (Mất tín hiệu đo, 100%) when all room sensors are OFFLINE', () => {
    const summary = evaluateRoomReliability({
      room: { id: 'room-301', code: 'TQB_301', name: 'Phòng đọc 301' },
      telemetry: makeTelemetry('room-301', '2026-11-18T10:00:00.000Z'),
      devices: [
        { id: 'd1', online: false, connectionState: 'OFFLINE' },
        { id: 'd2', online: false, connectionState: 'OFFLINE' },
      ],
      nowMs: Date.parse('2026-11-18T10:00:10.000Z'),
    });

    expect(summary.state).toBe('BLINDSPOT');
    expect(summary.subKind).toBe('BLINDSPOT_OFFLINE');
    expect(summary.badgeText).toBe('Mất tín hiệu đo');
    expect(summary.blindspotRatio).toBe(1);
    expect(summary.blindspotPercent).toBe(100);
  });

  it('TC-G4-05: uses manager-friendly reference copy for PRESET_ room without exposing RBF/IDW/isSynthetic jargon', () => {
    const summary = evaluateRoomReliability({
      room: {
        id: 'PRESET_TQB_508',
        code: 'TQB_508',
        name: 'Phòng thảo luận nhóm 508',
      },
      telemetry: makeTelemetry(
        'PRESET_TQB_508',
        '2026-11-18T10:00:00.000Z',
        true
      ),
      devices: [],
    });

    expect(summary.state).toBe('BLINDSPOT');
    expect(summary.subKind).toBe('REFERENCE_PRESET');
    expect(summary.badgeText).toBe('Số liệu tham khảo (chưa gắn cảm biến)');
    expect(summary.isReferencePreset).toBe(true);

    const combinedText = `${summary.badgeText} ${summary.qualityLabel} ${summary.tooltipText} ${summary.relativeTimeText}`;
    expect(combinedText).not.toMatch(/RBF|IDW|isSynthetic|synthetic|forward-fill/i);
  });

  it('TC-G4-06: visually distinguishes MEASURED, INTERPOLATED, BLINDSPOT hatch & STALE desaturation/stipple on Canvas ImageData', () => {
    expect(classifyPixelReliability(0.85, false, true)).toBe('MEASURED');
    expect(classifyPixelReliability(0.4, false, true)).toBe('INTERPOLATED');
    expect(classifyPixelReliability(0.15, false, true)).toBe('BLINDSPOT');
    expect(classifyPixelReliability(0.95, true, true)).toBe('STALE');

    const ops = installCanvasMockForReliability();

    // Wide room spanning [0.05..0.95] x [0.05..0.95] with single sensor near top-left (0.15, 0.15)
    // so the room naturally contains MEASURED center, INTERPOLATED mid-band, and BLINDSPOT far corner
    const normPoly: Point2D[] = [
      { x: 0.05, y: 0.05 },
      { x: 0.95, y: 0.05 },
      { x: 0.95, y: 0.95 },
      { x: 0.05, y: 0.95 },
    ];
    const width = 1000;
    const height = 750;
    const pixelVertices = normPoly.map((p) => ({
      x: p.x * width,
      y: p.y * height,
    }));
    const sigma = computeAdaptiveSigma(normPoly, 1, 0.26);
    const sensorSample = [{ x: 0.15, y: 0.15, value: 42.0, online: true }];

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;

    renderWeatherDiffusionHeatmap(
      ctx,
      pixelVertices,
      sensorSample,
      'comfortScore',
      width,
      height,
      null,
      0.26,
      {
        normalizedPolygon: normPoly,
        reliabilityMode: true,
        roomIsStale: false,
      }
    );

    const imgLive = ops.capturedImageData[0];
    expect(imgLive).toBeDefined();

    // Helper to read RGBA at normalized coordinate inside rendered grid
    const readPixelAtNorm = (img: ImageData, nx: number, ny: number) => {
      const gx = Math.max(
        0,
        Math.min(img.width - 1, Math.round(((nx - 0.05) / 0.9) * (img.width - 1)))
      );
      const gy = Math.max(
        0,
        Math.min(
          img.height - 1,
          Math.round(((ny - 0.05) / 0.9) * (img.height - 1))
        )
      );
      const ptr = (gy * img.width + gx) * 4;
      return {
        gx,
        gy,
        r: img.data[ptr],
        g: img.data[ptr + 1],
        b: img.data[ptr + 2],
        a: img.data[ptr + 3],
      };
    };

    // 1. Sensor center (d = 0) -> MEASURED high alpha
    const centerPx = readPixelAtNorm(imgLive, 0.15, 0.15);
    expect(centerPx.a).toBeGreaterThanOrEqual(170);
    // Critical thermal red-orange hue at comfortScore 42 (not amber hatch)
    expect(centerPx.r).toBeGreaterThan(200);
    expect(centerPx.g).toBeLessThan(120);

    // 2. Mid distance (~1.6 * sigma) -> INTERPOLATED (0.25 <= fieldPresence < 0.55) => softer alpha than center
    const midPx = readPixelAtNorm(imgLive, 0.15 + sigma * 1.6, 0.15);
    expect(midPx.a).toBeGreaterThan(25);
    expect(midPx.a).toBeLessThan(centerPx.a * 0.65);
    // Still carries thermal hue (not blindspot hatch [245, 158, 11])
    expect(midPx.g).toBeLessThan(120);

    // 3. Far corner (d = 3.0 * sigma) -> BLINDSPOT (fieldPresence < 0.25) => amber 45° diagonal hatch [245, 158, 11]
    const farNx = Math.min(0.92, 0.15 + sigma * 3.0);
    const farPx = readPixelAtNorm(imgLive, farNx, 0.15);
    expect(farPx.r).toBe(245);
    expect(farPx.g).toBe(158);
    expect(farPx.b).toBe(11);
    expect(farPx.a).toBeGreaterThan(0);

    // 4. Re-render same field with roomIsStale=true -> desaturated chroma & lower alpha + stipple arc calls
    const arcsBeforeStale = ops.arcCalls.length;
    renderWeatherDiffusionHeatmap(
      ctx,
      pixelVertices,
      sensorSample,
      'comfortScore',
      width,
      height,
      null,
      0.26,
      {
        normalizedPolygon: normPoly,
        reliabilityMode: true,
        roomIsStale: true,
      }
    );
    const imgStale = ops.capturedImageData[1];
    const staleCenterPx = readPixelAtNorm(imgStale, 0.15, 0.15);
    expect(staleCenterPx.a).toBeLessThan(centerPx.a);
    // Desaturated red shifts down towards luminance gray
    expect(staleCenterPx.r).toBeLessThan(centerPx.r);
    // Stipple dots drawn via arc()
    expect(ops.arcCalls.length).toBeGreaterThan(arcsBeforeStale);
  });

  it('TC-G4-07: displays role="status" reconnect banner with fallback polling info when STOMP is disconnected', async () => {
    installCanvasMockForReliability();
    vi.spyOn(stompManager, 'isConnected').mockReturnValue(false);
    vi.spyOn(stompManager, 'onConnectionChange').mockImplementation((cb) => {
      cb(false);
      return vi.fn();
    });

    const room301 = makeRoomFromPreset('TQB_301', 'room-301');
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
      makeTelemetry('room-301', new Date().toISOString())
    );

    renderWithProviders(<FloorplanPage />);

    const banner = await screen.findByTestId('ws-reconnecting-banner');
    expect(banner).toHaveAttribute('role', 'status');
    expect(banner).toHaveTextContent(UI_TEXT_VI.wsReconnectingBanner);
  });

  it('TC-G4-08: displays silent-sensor banner when STOMP is online but floor sensors are OFFLINE, and clicking activates reliability layer + highlights room', async () => {
    installCanvasMockForReliability();
    const room301 = makeRoomFromPreset('TQB_301', 'room-301');
    const offlineDevs: DeviceResponse[] = [
      {
        id: 'dev-off-1',
        hardwareId: 'ESP32_301_A',
        name: 'Trạm 301-A',
        roomId: 'room-301',
        zoneId: 'ZONE_A',
        deviceType: 'ESP32_NODE',
        active: true,
        online: false,
        connectionState: 'OFFLINE',
        lastSeenAt: '2026-11-18T09:50:00.000Z',
        lastOfflineAt: '2026-11-18T09:53:00.000Z',
        posX: 0.25,
        posY: 0.3,
      },
      {
        id: 'dev-off-2',
        hardwareId: 'ESP32_301_B',
        name: 'Trạm 301-B',
        roomId: 'room-301',
        zoneId: 'ZONE_A',
        deviceType: 'ESP32_NODE',
        active: true,
        online: false,
        connectionState: 'OFFLINE',
        lastSeenAt: '2026-11-18T09:50:00.000Z',
        lastOfflineAt: '2026-11-18T09:53:00.000Z',
        posX: 0.32,
        posY: 0.3,
      },
    ];

    vi.spyOn(roomsApi, 'list').mockResolvedValue({
      content: [room301],
      page: 0,
      size: 100,
      totalElements: 1,
      totalPages: 1,
      last: true,
    });
    vi.spyOn(devicesApi, 'list').mockResolvedValue({
      content: offlineDevs,
      page: 0,
      size: 100,
      totalElements: 2,
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
    vi.spyOn(telemetryApi, 'getRoomLatest').mockResolvedValue(
      makeTelemetry('room-301', new Date().toISOString())
    );
    vi.spyOn(telemetryApi, 'getDeviceLatest').mockResolvedValue(null);

    renderWithProviders(<FloorplanPage />);

    const silentBanner = await screen.findByTestId('silent-sensor-banner');
    expect(silentBanner).toHaveAttribute('role', 'status');
    expect(silentBanner).toHaveTextContent('2 cảm biến đang im lặng/mất kết nối');

    // Reliability layer initially off
    expect(screen.getByTestId('reliability-toggle-btn')).toHaveAttribute(
      'aria-pressed',
      'false'
    );

    // Click "Xem trên bản đồ" -> enables Reliability Layer, highlights room-301 & opens Drawer card
    fireEvent.click(screen.getByTestId('silent-sensor-inspect-btn'));

    expect(screen.getByTestId('reliability-toggle-btn')).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByTestId('floorplan-canvas-wrapper')).toHaveAttribute(
      'data-reliability-layer',
      'true'
    );
    expect(screen.getByTestId('legend-reliability-key')).toBeInTheDocument();

    const drawerCard = await screen.findByTestId('drawer-reliability-card');
    expect(drawerCard).toHaveTextContent('Độ tin cậy số liệu');
    expect(drawerCard).toHaveTextContent('Mất tín hiệu đo');
  });
});
