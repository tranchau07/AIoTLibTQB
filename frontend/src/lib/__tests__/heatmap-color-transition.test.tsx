import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FloorplanPage from '@/app/(protected)/floorplan/page';
import { ToastProvider } from '@/components/ui/primitives';
import { TIMING_CONFIG } from '@/config/floorplan-hmi.config';
import type { HeatmapLayerMetric } from '@/config/thresholds';
import {
  TQB_BUILDING_ASPECT_RATIO,
  TQB_ROOM_PRESETS,
} from '@/config/tqb-floorplan-presets';
import { alertsApi } from '@/features/alerts/api';
import { useAuthStore } from '@/features/auth/store';
import { devicesApi } from '@/features/devices/api';
import { FloorplanCanvas } from '@/features/floorplan/components/FloorplanCanvas';
import { RoomHoverPopover } from '@/features/floorplan/components/RoomHoverPopover';
import { roomsApi } from '@/features/rooms/api';
import { telemetryApi } from '@/features/telemetry/api';
import {
  createAnimatedMetricState,
  evaluateAnimatedMetricState,
  updateAnimatedMetricState,
} from '@/lib/floorplan/metricTransition';
import { computeVisualPolygonCenter } from '@/lib/floorplan/polygon';
import {
  METRIC_LAYER_META,
  WEATHER_PALETTES,
  getContinuousMetricColor,
  getMetricStatusSymbol,
  getRelativeLuminance,
  getWcagContrastRatio,
  hexToRgb,
  renderWeatherDiffusionHeatmap,
  simulateColorVisionDeficiency,
} from '@/lib/floorplan/weatherPalette';
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

interface FillRectRecord {
  fillStyle: string;
  w: number;
  h: number;
}

function installCanvasMock() {
  const fillRectCallsByCanvas = new Map<string, FillRectRecord[]>();

  const spy = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockImplementation(function (this: HTMLCanvasElement, contextId: string) {
      if (contextId !== '2d') return null;
      const key =
        this.getAttribute('data-testid') ||
        this.dataset?.testid ||
        `canvas-${fillRectCallsByCanvas.size}`;
      let list = fillRectCallsByCanvas.get(key);
      if (!list) {
        list = [];
        fillRectCallsByCanvas.set(key, list);
      }
      const capturedList = list;
      let currentFill = '#000000';

      const ctx = {
        canvas: this,
        font: '12px sans-serif',
        textAlign: 'left',
        textBaseline: 'alphabetic',
        shadowColor: 'transparent',
        shadowBlur: 0,
        filter: 'none',
        globalAlpha: 1,
        strokeStyle: '#000000',
        lineWidth: 1,
        imageSmoothingEnabled: true,
        imageSmoothingQuality: 'high' as ImageSmoothingQuality,
        get fillStyle() {
          return currentFill;
        },
        set fillStyle(val: string | CanvasGradient | CanvasPattern) {
          currentFill = String(val);
        },
        save: vi.fn(),
        restore: vi.fn(),
        setTransform: vi.fn(),
        clearRect: vi.fn(),
        fillRect: vi.fn((_x: number, _y: number, w: number, h: number) => {
          capturedList.push({ fillStyle: currentFill, w, h });
        }),
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
      };
      return ctx as unknown as CanvasRenderingContext2D;
    });

  return { spy, fillRectCallsByCanvas };
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
  score: number,
  humidity = 50.0,
  temperature = 23.0
): TelemetryResponse {
  return {
    id: `tel-${roomId}`,
    timestamp: new Date().toISOString(),
    metadata: {
      deviceId: `dev-${roomId}`,
      hardwareId: `ESP32_${roomId}`,
      roomId,
    },
    environment: { temperature, humidity, lux: 400 },
    acoustics: { noiseAvg: 42.0, noisePeak: 48.0 },
    airQuality: { pm1_0: 8, pm2_5: 12, pm4_0: 15, pm10: 19 },
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

function setupAuthLibrarian() {
  const user: UserResponse = {
    id: 'user-mgr-g3',
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
        'ROLE_LIBRARIAN VIEW_ROOMS VIEW_TELEMETRY VIEW_ALERTS ACKNOWLEDGE_ALERT RESOLVE_ALERT'
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

function mockMatchMedia(prefersReducedMotion: boolean) {
  const original = window.matchMedia;
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches:
        prefersReducedMotion && query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  return () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: original,
    });
  };
}

describe('Phase 3 (GĐ3): Metric selector, ISA-101 & Colorblind-safe Palette, 450ms Transitions & Hover Popover', () => {
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

  it('TC-G3-01: defaults active metric selector to comfortScore (LCS) with 0–100 legend on initial load', async () => {
    installCanvasMock();
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
      makeTelemetry('room-301', 86)
    );

    renderWithProviders(<FloorplanPage />);

    const lcsBtn = await screen.findByTestId('layer-btn-comfortScore');
    expect(lcsBtn).toHaveAttribute('aria-pressed', 'true');
    expect(lcsBtn).toHaveTextContent('Điểm tiện nghi (LCS)');

    const legend = await screen.findByTestId('floorplan-legend');
    expect(legend).toHaveTextContent('Điểm tiện nghi (LCS) (0–100)');
    expect(legend).toHaveTextContent('≥ 75đ');
  });

  it('TC-G3-02: switches unit, color gradient & palette stop labels across all 7 metrics', async () => {
    installCanvasMock();
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
      makeTelemetry('room-301', 86)
    );

    renderWithProviders(<FloorplanPage />);

    await screen.findByTestId('floorplan-legend');

    const metrics: HeatmapLayerMetric[] = [
      'comfortScore',
      'noiseAvg',
      'temperature',
      'humidity',
      'lux',
      'pm2_5',
      'wifiRssi',
    ];

    for (const metric of metrics) {
      fireEvent.click(screen.getByTestId(`layer-btn-${metric}`));
      const unitNode = screen.getByTestId('legend-metric-unit');
      expect(unitNode).toHaveTextContent(METRIC_LAYER_META[metric].unitLabel);

      const legend = screen.getByTestId('floorplan-legend');
      for (const stop of WEATHER_PALETTES[metric]) {
        if (stop.label) {
          expect(legend).toHaveTextContent(stop.label);
        }
      }
    }
  });

  it('TC-G3-03: interpolates smoothstep transition over 450ms (300–600ms range) when reduced-motion is off', () => {
    const restoreMM = mockMatchMedia(false);
    try {
      expect(TIMING_CONFIG.transitionDurationMs).toBeGreaterThanOrEqual(300);
      expect(TIMING_CONFIG.transitionDurationMs).toBeLessThanOrEqual(600);
      expect(TIMING_CONFIG.transitionDurationMs).toBe(450);

      const initial = createAnimatedMetricState(22.0, 0, false, 450);
      const updated = updateAnimatedMetricState(initial, 26.0, 0, false, 450);

      expect(updated.duration).toBe(450);

      const atZero = evaluateAnimatedMetricState(updated, 0);
      expect(atZero.value).toBeCloseTo(22.0, 3);
      expect(atZero.transitioning).toBe(true);

      const atHalf = evaluateAnimatedMetricState(updated, 225);
      // Hermite smoothstep S(0.5) = 0.5 => exact midpoint 24.0°C
      expect(atHalf.value).toBeCloseTo(24.0, 3);
      expect(atHalf.transitioning).toBe(true);

      const atEnd = evaluateAnimatedMetricState(updated, 450);
      expect(atEnd.value).toBeCloseTo(26.0, 3);
      expect(atEnd.transitioning).toBe(false);
    } finally {
      restoreMM();
    }
  });

  it('TC-G3-04: sets duration=0 and updates immediately when prefers-reduced-motion: reduce is active', () => {
    const restoreMM = mockMatchMedia(true);
    try {
      const initial = createAnimatedMetricState(40.0, 100);
      expect(initial.duration).toBe(0);

      const updated = updateAnimatedMetricState(initial, 72.0, 120);
      expect(updated.duration).toBe(0);

      const firstFrame = evaluateAnimatedMetricState(updated, 120);
      expect(firstFrame.value).toBe(72.0);
      expect(firstFrame.transitioning).toBe(false);
    } finally {
      restoreMM();
    }
  });

  it('TC-G3-05: differentiates Good (88), Warning (65), and Critical (38) by geometric symbols and luminance under Deuteranopia & Protanopia', () => {
    const goodEval = getMetricStatusSymbol('comfortScore', 88);
    const warnEval = getMetricStatusSymbol('comfortScore', 65);
    const critEval = getMetricStatusSymbol('comfortScore', 38);

    expect(goodEval.symbol).toBe('●');
    expect(warnEval.symbol).toBe('▲');
    expect(critEval.symbol).toBe('◆');
    expect(new Set([goodEval.symbol, warnEval.symbol, critEval.symbol]).size).toBe(3);

    const [gr, gg, gb] = getContinuousMetricColor('comfortScore', 88);
    const [wr, wg, wb] = getContinuousMetricColor('comfortScore', 65);
    const [cr, cg, cb] = getContinuousMetricColor('comfortScore', 38);

    const checkPairwiseLuminanceSep = (
      a: readonly [number, number, number],
      b: readonly [number, number, number],
      c: readonly [number, number, number]
    ) => {
      const la = getRelativeLuminance(a);
      const lb = getRelativeLuminance(b);
      const lc = getRelativeLuminance(c);
      expect(Math.abs(la - lb)).toBeGreaterThan(0.15);
      expect(Math.abs(lb - lc)).toBeGreaterThan(0.15);
      expect(Math.abs(la - lc)).toBeGreaterThan(0.15);
    };

    // Normal trichromatic vision
    checkPairwiseLuminanceSep([gr, gg, gb], [wr, wg, wb], [cr, cg, cb]);

    // Simulated Deuteranopia
    checkPairwiseLuminanceSep(
      simulateColorVisionDeficiency([gr, gg, gb], 'deuteranopia'),
      simulateColorVisionDeficiency([wr, wg, wb], 'deuteranopia'),
      simulateColorVisionDeficiency([cr, cg, cb], 'deuteranopia')
    );

    // Simulated Protanopia
    checkPairwiseLuminanceSep(
      simulateColorVisionDeficiency([gr, gg, gb], 'protanopia'),
      simulateColorVisionDeficiency([wr, wg, wb], 'protanopia'),
      simulateColorVisionDeficiency([cr, cg, cb], 'protanopia')
    );
  });

  it('TC-G3-06: meets WCAG 2.2 AA contrast ratio (>= 4.5:1) for label pills, popovers & summary badges', () => {
    const darkPillBg = hexToRgb('#0F172A');
    const darkTextColors = ['#F8FAFC', '#38BDF8', '#FBBF24', '#FCA5A5'];
    for (const fgHex of darkTextColors) {
      const ratio = getWcagContrastRatio(hexToRgb(fgHex), darkPillBg);
      expect(ratio, `${fgHex} on #0F172A`).toBeGreaterThanOrEqual(4.5);
    }

    const legendLightPairs: Array<[string, string]> = [
      ['#082F49', '#F0F9FF'], // sky-950 on sky-50
      ['#451A03', '#FFFBEB'], // amber-950 on amber-50
      ['#4C0519', '#FFF1F2'], // rose-950 on rose-50
      ['#0F172A', '#FFFFFF'], // slate-900 on white
      ['#FFFFFF', '#B91C1C'], // critical badge white on red-700
    ];
    for (const [fg, bg] of legendLightPairs) {
      const ratio = getWcagContrastRatio(hexToRgb(fg), hexToRgb(bg));
      expect(ratio, `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('TC-G3-07: ISA-101 Deviation Mode (onlyExceedingThreshold) mutes normal rooms and highlights TQB_103 Book Storage (> 60%RH)', async () => {
    const { fillRectCallsByCanvas } = installCanvasMock();
    const tqb103 = makeRoomFromPreset('TQB_103', 'room-103');
    const tqb101 = makeRoomFromPreset('TQB_101', 'room-101');
    const tqb102 = makeRoomFromPreset('TQB_102', 'room-102');

    vi.spyOn(roomsApi, 'list').mockResolvedValue({
      content: [tqb101, tqb102, tqb103],
      page: 0,
      size: 100,
      totalElements: 3,
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
    vi.spyOn(telemetryApi, 'getRoomLatest').mockImplementation(async (roomId) => {
      if (roomId === 'room-103') {
        return makeTelemetry('room-103', 62, 64.0, 23.0);
      }
      return makeTelemetry(roomId, 90, 50.0, 23.0);
    });

    renderWithProviders(<FloorplanPage />);

    // Select Floor 1 and Humidity metric
    fireEvent.click(await screen.findByRole('button', { name: 'Tầng 1' }));
    fireEvent.click(screen.getByTestId('layer-btn-humidity'));

    const toggle = screen.getByTestId('only-exceeding-toggle');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');

    await waitFor(() => {
      expect(screen.getByTestId('floorplan-canvas-wrapper')).toHaveAttribute(
        'data-only-exceeding',
        'true'
      );
    });

    // Also verify pure renderWeatherDiffusionHeatmap behavior for normal vs exceeding rooms
    const fakeCtx = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      clip: vi.fn(),
      fillRect: vi.fn(),
      stroke: vi.fn(),
      fillStyle: '#000',
      strokeStyle: '#000',
      lineWidth: 1,
      globalAlpha: 1,
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'high' as ImageSmoothingQuality,
      filter: 'none',
      createImageData: vi.fn((w: number, h: number) => ({
        width: w,
        height: h,
        data: new Uint8ClampedArray(w * h * 4),
      })),
      putImageData: vi.fn(),
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D;

    const polyPx: Point2D[] = [
      { x: 50, y: 50 },
      { x: 200, y: 50 },
      { x: 200, y: 180 },
      { x: 50, y: 180 },
    ];

    renderWeatherDiffusionHeatmap(
      fakeCtx,
      polyPx,
      [],
      'humidity',
      960,
      723,
      50.0,
      0.26,
      {
        skipDarkBase: true,
        onlyExceedingThreshold: true,
        roomExceedsThreshold: false,
      }
    );
    expect(fakeCtx.fillStyle).toBe('rgba(30, 41, 59, 0.36)');
    expect(fakeCtx.fillRect).toHaveBeenCalledTimes(1);

    (fakeCtx.fillRect as ReturnType<typeof vi.fn>).mockClear();
    renderWeatherDiffusionHeatmap(
      fakeCtx,
      polyPx,
      [],
      'humidity',
      960,
      723,
      64.0,
      0.26,
      {
        skipDarkBase: true,
        onlyExceedingThreshold: true,
        roomExceedsThreshold: true,
      }
    );
    expect(fakeCtx.fillStyle).not.toBe('rgba(30, 41, 59, 0.36)');
    expect(fillRectCallsByCanvas.size).toBeGreaterThan(0);
  });

  it('TC-G3-08: renders RoomHoverPopover with measured value, BOOK_STORAGE threshold status, SVG sparkline & SOP action', () => {
    installCanvasMock();
    const tqb103 = makeRoomFromPreset('TQB_103', 'room-103');
    const onInspect = vi.fn();

    render(
      <RoomHoverPopover
        room={tqb103}
        layer="humidity"
        value={64.0}
        historyValues={[54, 57, 59, 61, 63, 64]}
        openAlertsCount={1}
        onInspectRoom={onInspect}
      />
    );

    const popover = screen.getByTestId('room-hover-popover');
    expect(popover).toHaveTextContent('TQB_103');
    expect(popover).toHaveTextContent('64 %RH');
    expect(popover).toHaveTextContent('Vượt ngưỡng bảo quản (> 60%RH)');
    expect(popover).toHaveTextContent(/máy hút ẩm/i);

    const sparkline = screen.getByTestId('popover-sparkline');
    expect(sparkline.tagName.toLowerCase()).toBe('svg');
    expect(sparkline.querySelector('polyline')).not.toBeNull();

    fireEvent.click(
      screen.getByRole('button', { name: /Xử lý & Xem chi tiết/i })
    );
    expect(onInspect).toHaveBeenCalledWith(tqb103);

    // Also verify hover on FloorplanCanvas mounts RoomHoverPopover for TQB_103
    cleanup();
    const rooms = [tqb103];
    const devs: DeviceResponse[] = [];
    const onSelectRoom = vi.fn();
    render(
      <FloorplanCanvas
        rooms={rooms}
        devices={devs}
        roomTelemetryMap={{
          'room-103': makeTelemetry('room-103', 60, 64.0, 23.0),
        }}
        layer="humidity"
        selectedRoomId={null}
        onSelectRoom={onSelectRoom}
        roomTelemetryHistoryMap={{
          'room-103': [55, 58, 61, 64],
        }}
      />
    );

    const canvas = screen.getByTestId('dynamic-heatmap-canvas');
    const canvasH = Math.round(960 * TQB_BUILDING_ASPECT_RATIO);
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 960,
      height: canvasH,
      right: 960,
      bottom: canvasH,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    const preset103 = TQB_ROOM_PRESETS.find((p) => p.code === 'TQB_103')!;
    const center103 = computeVisualPolygonCenter(preset103.boundaryPolygon);

    act(() => {
      fireEvent.mouseMove(canvas, {
        clientX: center103.x * 960,
        clientY: center103.y * canvasH,
      });
    });

    const hoverPopover = screen.getByTestId('room-hover-popover');
    expect(hoverPopover).toHaveTextContent('TQB_103');
    expect(hoverPopover).toHaveTextContent('Vượt ngưỡng bảo quản (> 60%RH)');
    expect(screen.getByTestId('popover-sparkline')).toBeInTheDocument();
  });
});
