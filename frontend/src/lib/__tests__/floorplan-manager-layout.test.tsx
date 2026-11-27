import React, { useState } from 'react';
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
import {
  FLOORPLAN_INTERACTION_CONFIG,
  ZOOM_CONFIG,
  resolveRoomHealthMatchesFilter,
} from '@/config/floorplan-hmi.config';
import {
  TQB_ROOM_PRESETS,
  buildPresetFallbackTelemetry,
} from '@/config/tqb-floorplan-presets';
import { alertsApi } from '@/features/alerts/api';
import { useAuthStore } from '@/features/auth/store';
import { devicesApi } from '@/features/devices/api';
import { FloorplanCanvas } from '@/features/floorplan/components/FloorplanCanvas';
import { FloorplanMinimap } from '@/features/floorplan/components/FloorplanMinimap';
import {
  ManagerSummaryStrip,
  computeBuildingSummaryMetrics,
} from '@/features/floorplan/components/ManagerSummaryStrip';
import { roomsApi } from '@/features/rooms/api';
import { telemetryApi } from '@/features/telemetry/api';
import {
  clampViewportTransform,
  fitPolygonToViewport,
  normalizedToPixel,
  pixelToNormalized,
  zoomViewportAtPoint,
  type ViewportTransform,
} from '@/lib/floorplan/coords';
import { buildCapabilities } from '@/lib/rbac/capabilities';
import { parseScopeString } from '@/lib/rbac/scope-parser';
import { stompManager } from '@/lib/realtime/stomp-client';
import type {
  AlertResponse,
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

interface CanvasMockStats {
  drawImageCalls: number;
  clearRectCalls: number;
  strokeCalls: Array<{ strokeStyle: string; lineWidth: number; globalAlpha: number }>;
  alphaValues: number[];
}

function installCanvas2DMock() {
  const statsByCanvas = new Map<string, CanvasMockStats>();

  const spy = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockImplementation(function (this: HTMLCanvasElement, contextId: string) {
      if (contextId !== '2d') return null;
      const key =
        this.getAttribute('data-testid') ||
        this.dataset?.testid ||
        `canvas-${statsByCanvas.size}`;
      let stats = statsByCanvas.get(key);
      if (!stats) {
        stats = {
          drawImageCalls: 0,
          clearRectCalls: 0,
          strokeCalls: [],
          alphaValues: [],
        };
        statsByCanvas.set(key, stats);
      }
      const capturedStats = stats;
      const stateStack: Array<{
        globalAlpha: number;
        strokeStyle: string;
        lineWidth: number;
      }> = [];
      let currentAlpha = 1;
      let currentStrokeStyle = '#000000';
      let currentLineWidth = 1;

      const ctx = {
        canvas: this,
        fillStyle: '#000000',
        font: '12px sans-serif',
        textAlign: 'left',
        textBaseline: 'alphabetic',
        shadowColor: 'transparent',
        shadowBlur: 0,
        filter: 'none',
        imageSmoothingEnabled: true,
        imageSmoothingQuality: 'high' as ImageSmoothingQuality,
        get globalAlpha() {
          return currentAlpha;
        },
        set globalAlpha(val: number) {
          currentAlpha = val;
          capturedStats.alphaValues.push(val);
        },
        get strokeStyle() {
          return currentStrokeStyle;
        },
        set strokeStyle(val: string | CanvasGradient | CanvasPattern) {
          currentStrokeStyle = String(val);
        },
        get lineWidth() {
          return currentLineWidth;
        },
        set lineWidth(val: number) {
          currentLineWidth = val;
        },
        save: vi.fn(() => {
          stateStack.push({
            globalAlpha: currentAlpha,
            strokeStyle: currentStrokeStyle,
            lineWidth: currentLineWidth,
          });
        }),
        restore: vi.fn(() => {
          const prev = stateStack.pop();
          if (prev) {
            currentAlpha = prev.globalAlpha;
            currentStrokeStyle = prev.strokeStyle;
            currentLineWidth = prev.lineWidth;
          }
        }),
        setTransform: vi.fn(),
        clearRect: vi.fn(() => {
          capturedStats.clearRectCalls += 1;
        }),
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
        stroke: vi.fn(() => {
          capturedStats.strokeCalls.push({
            strokeStyle: currentStrokeStyle,
            lineWidth: currentLineWidth,
            globalAlpha: currentAlpha,
          });
        }),
        setLineDash: vi.fn(),
        createRadialGradient: vi.fn(() => ({
          addColorStop: vi.fn(),
        })),
        createLinearGradient: vi.fn(() => ({
          addColorStop: vi.fn(),
        })),
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
        drawImage: vi.fn(() => {
          capturedStats.drawImageCalls += 1;
        }),
      };

      return ctx as unknown as CanvasRenderingContext2D;
    });

  return { spy, statsByCanvas };
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
  timestamp: string = new Date().toISOString(),
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
    environment: {
      temperature: 23.2,
      humidity: 51.0,
      lux: 380,
    },
    acoustics: {
      noiseAvg: 42.0,
      noisePeak: 48.0,
    },
    airQuality: {
      pm1_0: 8.0,
      pm2_5: 12.0,
      pm4_0: 14.0,
      pm10: 18.0,
    },
    wifiRssi: -55,
    comfortScore: {
      overall: score,
      grade: score >= 80 ? 'Gold' : score >= 65 ? 'Bronze' : 'Poor',
      acousticScore: score,
      airScore: score,
      thermalScore: score,
      lightScore: score,
    },
  };
}

function makeAlert(overrides: Partial<AlertResponse> = {}): AlertResponse {
  return {
    id: 'alert-1',
    deviceId: 'dev-302',
    hardwareId: 'ESP32_302',
    roomId: 'ROOM_302',
    zoneId: 'ZONE_A',
    type: 'NOISE_EXCEEDED',
    metricType: 'NOISE_AVG',
    unit: 'dBA',
    severity: 'CRITICAL',
    severityRank: 4,
    status: 'FIRING',
    workflowStatus: 'NEW',
    currentValue: 86.0,
    threshold: 75.0,
    message: 'Average noise level exceeded threshold',
    startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    acknowledgedAt: null,
    resolvedAt: null,
    acknowledgedBy: null,
    resolvedBy: null,
    ...overrides,
  };
}

describe('Giai đoạn 1: Layout Tối Đa Không Gian, ManagerSummaryStrip, Fit-to-View, Zoom/Pan Mượt & Minimap', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
    useAuthStore.setState({
      accessToken: null,
      refreshToken: null,
      user: null,
      capabilities: buildCapabilities(parseScopeString('')),
      hydrated: true,
      isKioskSession: false,
    });
  });

  it('TC-G1-01: fitPolygonToViewport tính scale lớn hơn cho phòng nhỏ (P.506) so với phòng lớn (P.302) và giữ tâm trong viewport', () => {
    const p302 = TQB_ROOM_PRESETS.find((p) => p.code === 'TQB_302')!;
    const p506 = TQB_ROOM_PRESETS.find((p) => p.code === 'TQB_506')!;
    const width = 960;
    const height = 722;

    const vp302 = fitPolygonToViewport(
      p302.boundaryPolygon,
      width,
      height,
      ZOOM_CONFIG.roomFitPaddingRatio,
      ZOOM_CONFIG.maxScale
    );
    const vp506 = fitPolygonToViewport(
      p506.boundaryPolygon,
      width,
      height,
      ZOOM_CONFIG.roomFitPaddingRatio,
      ZOOM_CONFIG.maxScale
    );

    expect(vp302.scale).toBeGreaterThanOrEqual(ZOOM_CONFIG.minScale);
    expect(vp302.scale).toBeLessThanOrEqual(ZOOM_CONFIG.maxScale);
    expect(vp506.scale).toBeGreaterThanOrEqual(ZOOM_CONFIG.minScale);
    expect(vp506.scale).toBeLessThanOrEqual(ZOOM_CONFIG.maxScale);
    expect(vp506.scale).toBeGreaterThan(vp302.scale);

    // Kiểm tra tâm P.506 (phòng nội suy xa biên hợp lý hoặc tính toán kỳ vọng kẹp biên)
    const minX = Math.min(...p506.boundaryPolygon.map((p) => p.x));
    const maxX = Math.max(...p506.boundaryPolygon.map((p) => p.x));
    const minY = Math.min(...p506.boundaryPolygon.map((p) => p.y));
    const maxY = Math.max(...p506.boundaryPolygon.map((p) => p.y));
    const cxNorm = (minX + maxX) * 0.5;
    const cyNorm = (minY + maxY) * 0.5;
    const centerPx = normalizedToPixel({ x: cxNorm, y: cyNorm }, width, height);
    const screenX = centerPx.x * vp506.scale + vp506.tx;
    const screenY = centerPx.y * vp506.scale + vp506.ty;

    // Nếu không chạm biên [minTx, 0] / [minTy, 0], độ lệch tâm viewport < 2px
    const minTx = width * (1 - vp506.scale);
    const minTy = height * (1 - vp506.scale);
    if (vp506.tx > minTx + 1 && vp506.tx < -1) {
      expect(Math.abs(screenX - width * 0.5)).toBeLessThan(2);
    }
    if (vp506.ty > minTy + 1 && vp506.ty < -1) {
      expect(Math.abs(screenY - height * 0.5)).toBeLessThan(2);
    }
  });

  it('TC-G1-02: fitPolygonToViewport an toàn với đa giác rỗng, 2 điểm hoặc suy biến', () => {
    expect(fitPolygonToViewport([], 960, 722)).toEqual({ scale: 1, tx: 0, ty: 0 });
    expect(
      fitPolygonToViewport(
        [
          { x: 0.1, y: 0.1 },
          { x: 0.2, y: 0.2 },
        ],
        960,
        722
      )
    ).toEqual({ scale: 1, tx: 0, ty: 0 });
    expect(
      fitPolygonToViewport(
        [
          { x: 0.5, y: 0.5 },
          { x: 0.5, y: 0.5 },
          { x: 0.5, y: 0.5 },
        ],
        960,
        722
      )
    ).toEqual({ scale: 1, tx: 0, ty: 0 });
    expect(fitPolygonToViewport(null, 0, 0)).toEqual({ scale: 1, tx: 0, ty: 0 });
  });

  it('TC-G1-03: zoomViewportAtPoint giữ cố định điểm chuẩn hóa dưới con trỏ chuột (sai số < 1e-3)', () => {
    const width = 960;
    const height = 722;
    const current: ViewportTransform = { scale: 1, tx: 0, ty: 0 };
    const focalPx: Point2D = { x: 480, y: 360 };
    const beforeNorm = pixelToNormalized(
      {
        x: (focalPx.x - current.tx) / current.scale,
        y: (focalPx.y - current.ty) / current.scale,
      },
      width,
      height
    );

    const next = zoomViewportAtPoint(current, 2.0, focalPx, width, height, 4.0);
    expect(next.scale).toBe(2.0);

    const afterNorm = pixelToNormalized(
      {
        x: (focalPx.x - next.tx) / next.scale,
        y: (focalPx.y - next.ty) / next.scale,
      },
      width,
      height
    );

    expect(Math.abs(afterNorm.x - beforeNorm.x)).toBeLessThan(1e-3);
    expect(Math.abs(afterNorm.y - beforeNorm.y)).toBeLessThan(1e-3);
  });

  it('TC-G1-04: Pan sau khi đã Fit-to-Room (zoomedRoomId) kế thừa đúng (tx, ty) không bị giật về (0, 0)', () => {
    installCanvas2DMock();
    if (typeof window.PointerEvent === 'undefined') {
      class MockPointerEvent extends MouseEvent {
        pointerId: number;
        constructor(type: string, params: PointerEventInit = {}) {
          super(type, params);
          this.pointerId = params.pointerId ?? 1;
        }
      }
      vi.stubGlobal('PointerEvent', MockPointerEvent);
    }
    const room301 = makeRoomFromPreset('TQB_301', 'ROOM_301');
    const onViewportChange = vi.fn();

    function ControlledCanvasHarness() {
      const [vp, setVp] = useState<ViewportTransform>({
        scale: 2.1,
        tx: -320,
        ty: -180,
      });
      return (
        <FloorplanCanvas
          rooms={[room301]}
          devices={[]}
          roomTelemetryMap={{ ROOM_301: buildPresetFallbackTelemetry(room301, 0) }}
          layer="comfortScore"
          selectedRoomId="ROOM_301"
          zoomedRoomId="ROOM_301"
          onSelectRoom={vi.fn()}
          viewport={vp}
          onViewportChange={(nextVp) => {
            onViewportChange(nextVp);
            setVp(nextVp);
          }}
        />
      );
    }

    render(<ControlledCanvasHarness />);
    const dynamicCanvas = screen.getByTestId('dynamic-heatmap-canvas');
    const wrapper = screen.getByTestId('floorplan-canvas-wrapper');

    expect(Number(wrapper.getAttribute('data-scale'))).toBeCloseTo(2.1, 2);
    expect(Number(wrapper.getAttribute('data-tx'))).toBe(-320);
    expect(Number(wrapper.getAttribute('data-ty'))).toBe(-180);

    fireEvent.pointerDown(dynamicCanvas, { clientX: 200, clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(dynamicCanvas, { clientX: 240, clientY: 170, pointerId: 1 });
    fireEvent.pointerUp(dynamicCanvas, { clientX: 240, clientY: 170, pointerId: 1 });

    expect(onViewportChange).toHaveBeenCalled();
    const lastCall = onViewportChange.mock.calls.at(-1)?.[0] as ViewportTransform;
    expect(lastCall.scale).toBeCloseTo(2.1, 2);
    expect(lastCall.tx).toBe(-280);
    expect(lastCall.ty).toBe(-210);
  });

  it('TC-G1-05: Nút + / − / Fit / Reset trên thanh công cụ bản đồ điều chỉnh scale mượt và bật/tắt Minimap', () => {
    installCanvas2DMock();
    const room301 = makeRoomFromPreset('TQB_301', 'ROOM_301');

    render(
      <FloorplanCanvas
        rooms={[room301]}
        devices={[]}
        roomTelemetryMap={{ ROOM_301: makeTelemetry('ROOM_301', 88) }}
        layer="comfortScore"
        selectedRoomId={null}
        onSelectRoom={vi.fn()}
      />
    );

    expect(screen.getByTestId('zoom-scale-label')).toHaveTextContent('1.00x');
    expect(screen.queryByTestId('floorplan-minimap')).not.toBeInTheDocument();

    const zoomInBtn = screen.getByTestId('zoom-in-btn');
    fireEvent.click(zoomInBtn);
    expect(screen.getByTestId('zoom-scale-label')).toHaveTextContent('1.35x');
    expect(screen.getByTestId('floorplan-minimap')).toBeInTheDocument();

    fireEvent.click(zoomInBtn);
    expect(screen.getByTestId('zoom-scale-label')).toHaveTextContent('1.70x');

    const resetBtn = screen.getByTestId('zoom-reset-btn');
    fireEvent.click(resetBtn);
    expect(screen.getByTestId('zoom-scale-label')).toHaveTextContent('1.00x');
    expect(screen.queryByTestId('floorplan-minimap')).not.toBeInTheDocument();
  });

  it('TC-G1-06: FloorplanMinimap hiển thị khi scale > 1.15 và click góc Đông Nam dịch khung nhìn chính hợp lệ', () => {
    const onNavigate = vi.fn();
    const room301 = makeRoomFromPreset('TQB_301', 'ROOM_301');

    const { rerender } = render(
      <FloorplanMinimap
        viewport={{ scale: 1.0, tx: 0, ty: 0 }}
        canvasWidth={960}
        canvasHeight={722}
        rooms={[
          {
            id: room301.id,
            code: room301.code,
            polygon: room301.boundaryPolygon!,
            hasAlert: false,
            isSelected: false,
          },
        ]}
        activeFloor={3}
        onNavigate={onNavigate}
      />
    );
    expect(screen.queryByTestId('floorplan-minimap')).not.toBeInTheDocument();

    rerender(
      <FloorplanMinimap
        viewport={{ scale: 2.5, tx: -400, ty: -300 }}
        canvasWidth={960}
        canvasHeight={722}
        rooms={[
          {
            id: room301.id,
            code: room301.code,
            polygon: room301.boundaryPolygon!,
            hasAlert: true,
            isSelected: true,
          },
        ]}
        activeFloor={3}
        onNavigate={onNavigate}
      />
    );

    expect(screen.getByTestId('floorplan-minimap')).toBeInTheDocument();
    const svg = screen.getByTestId('floorplan-minimap-svg');
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 148,
      bottom: 111,
      width: 148,
      height: 111,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    // Click góc Đông Nam (0.95w, 0.95h)
    fireEvent.click(svg, { clientX: 140, clientY: 105 });

    expect(onNavigate).toHaveBeenCalledTimes(1);
    const navVp = onNavigate.mock.calls[0][0] as ViewportTransform;
    expect(navVp.scale).toBe(2.5);
    const minTx = 960 * (1 - 2.5);
    const minTy = 722 * (1 - 2.5);
    expect(navVp.tx).toBe(minTx);
    expect(navVp.ty).toBe(minTy);
  });

  it('TC-G1-07: ManagerSummaryStrip tổng hợp đúng 33 phòng, cảnh báo theo mức độ & tồn đọng lâu', () => {
    const nowMs = Date.UTC(2026, 10, 18, 9, 0, 0);
    const rooms: RoomResponse[] = TQB_ROOM_PRESETS.map((p) =>
      makeRoomFromPreset(p.code, `ROOM_${p.code}`)
    );
    expect(rooms).toHaveLength(33);

    const telMap: Record<string, TelemetryResponse> = {};
    rooms.forEach((r, idx) => {
      let score = 85; // 26 GOOD
      if (idx >= 26 && idx < 30) score = 68; // 4 ATTENTION
      if (idx >= 30) score = 48; // 3 POOR
      telMap[r.id] = makeTelemetry(
        r.id,
        score,
        new Date(nowMs - 15_000).toISOString()
      );
    });

    const alerts: AlertResponse[] = [
      makeAlert({
        id: 'a-crit-overdue',
        roomId: rooms[30].id,
        severity: 'CRITICAL',
        severityRank: 4,
        status: 'FIRING',
        workflowStatus: 'NEW',
        startedAt: new Date(nowMs - 20 * 60_000).toISOString(),
      }),
      makeAlert({
        id: 'a-high-1',
        roomId: rooms[31].id,
        severity: 'HIGH',
        severityRank: 3,
        status: 'FIRING',
        workflowStatus: 'NEW',
        startedAt: new Date(nowMs - 3 * 60_000).toISOString(),
      }),
      makeAlert({
        id: 'a-high-2',
        roomId: rooms[32].id,
        severity: 'HIGH',
        severityRank: 3,
        status: 'ACKNOWLEDGED',
        workflowStatus: 'ACKNOWLEDGED',
        assignedTo: 'ktv.minh',
        startedAt: new Date(nowMs - 3 * 60_000).toISOString(),
      }),
    ];

    const metrics = computeBuildingSummaryMetrics(rooms, telMap, alerts, nowMs);
    expect(metrics.totalOpenAlerts).toBe(3);
    expect(metrics.bySeverity.CRITICAL).toBe(1);
    expect(metrics.bySeverity.HIGH).toBe(2);
    expect(metrics.overdueCount).toBe(1);
    expect(metrics.roomCounts).toEqual({
      GOOD: 26,
      ATTENTION: 4,
      POOR: 3,
      NO_DATA: 0,
      total: 33,
    });

    render(
      <ManagerSummaryStrip
        metrics={metrics}
        activeFilter="ALL"
        onFilterChange={vi.fn()}
        stompConnected={true}
        nowMs={nowMs}
      />
    );

    expect(screen.getByTestId('summary-filter-alerts')).toHaveTextContent(
      '3 Cảnh báo mở(1 Khẩn cấp · 2 Cao)'
    );
    expect(screen.getByTestId('summary-filter-overdue')).toHaveTextContent(
      '1 Tồn đọng'
    );
    expect(screen.getByTestId('summary-filter-good')).toHaveTextContent('26 Tốt');
    expect(screen.getByTestId('summary-filter-attention')).toHaveTextContent(
      '4 Lưu ý'
    );
    expect(screen.getByTestId('summary-filter-poor')).toHaveTextContent('3 Xấu');
  });

  it('TC-G1-08: Lọc bản đồ 1 chạm từ ManagerSummaryStrip bật/tắt POOR và làm mờ phòng không khớp', async () => {
    const { statsByCanvas } = installCanvas2DMock();
    const rooms = [
      makeRoomFromPreset('TQB_301', 'ROOM_301'),
      makeRoomFromPreset('TQB_302', 'ROOM_302'),
    ];
    const telMap = {
      ROOM_301: makeTelemetry('ROOM_301', 88), // GOOD
      ROOM_302: makeTelemetry('ROOM_302', 45), // POOR
    };
    const metrics = computeBuildingSummaryMetrics(rooms, telMap, []);

    function FilterHarness() {
      const [activeFilter, setActiveFilter] = useState<'ALL' | 'POOR' | 'GOOD' | 'ATTENTION' | 'ALERTS' | 'OVERDUE'>('ALL');
      const roomMatchesFilterMap = {
        ROOM_301: resolveRoomHealthMatchesFilter(rooms[0], telMap.ROOM_301, [], activeFilter),
        ROOM_302: resolveRoomHealthMatchesFilter(rooms[1], telMap.ROOM_302, [], activeFilter),
      };
      return (
        <div>
          <ManagerSummaryStrip
            metrics={metrics}
            activeFilter={activeFilter}
            onFilterChange={setActiveFilter}
            stompConnected={true}
          />
          <FloorplanCanvas
            rooms={rooms}
            devices={[]}
            roomTelemetryMap={telMap}
            layer="comfortScore"
            selectedRoomId={null}
            onSelectRoom={vi.fn()}
            activeStatusFilter={activeFilter}
            roomMatchesFilterMap={roomMatchesFilterMap}
          />
        </div>
      );
    }

    render(<FilterHarness />);
    const poorBtn = screen.getByTestId('summary-filter-poor');
    const wrapper = screen.getByTestId('floorplan-canvas-wrapper');

    expect(wrapper).toHaveAttribute('data-status-filter', 'ALL');

    // Click lần 1: Bật lọc POOR -> phòng GOOD bị làm mờ (0.22)
    fireEvent.click(poorBtn);
    expect(wrapper).toHaveAttribute('data-status-filter', 'POOR');
    expect(poorBtn).toHaveAttribute('aria-pressed', 'true');

    await waitFor(() => {
      const dynStats = statsByCanvas.get('dynamic-heatmap-canvas');
      expect(
        dynStats?.alphaValues.some(
          (a) => Math.abs(a - FLOORPLAN_INTERACTION_CONFIG.dimmedRoomOpacity) < 0.01
        )
      ).toBe(true);
    });

    // Click lần 2: Hủy lọc về ALL
    fireEvent.click(poorBtn);
    expect(wrapper).toHaveAttribute('data-status-filter', 'ALL');
    expect(poorBtn).toHaveAttribute('aria-pressed', 'false');
  });

  it('TC-G1-09 & TC-G1-10: Mở Drawer nổi không co kích thước Canvas; Fullscreen + Esc giữ Drawer trong container', async () => {
    installCanvas2DMock();
    vi.spyOn(stompManager, 'isConnected').mockReturnValue(true);
    vi.spyOn(stompManager, 'onConnectionChange').mockImplementation((cb) => {
      cb(true);
      return vi.fn();
    });
    vi.spyOn(stompManager, 'subscribeRoom').mockImplementation(() => vi.fn());

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
      content: [],
      page: 0,
      size: 100,
      totalElements: 0,
      totalPages: 0,
      last: true,
    });
    vi.spyOn(alertsApi, 'list').mockResolvedValue({
      content: [makeAlert({ roomId: 'ROOM_302' })],
      page: 0,
      size: 50,
      totalElements: 1,
      totalPages: 1,
      last: true,
    });
    vi.spyOn(telemetryApi, 'getRoomLatest').mockImplementation(async (id) =>
      makeTelemetry(id, id === 'ROOM_302' ? 52 : 88)
    );

    const managerUser: UserResponse = {
      id: 'u-lib',
      username: 'thuthu.an',
      active: true,
      roles: [{ name: 'LIBRARIAN', description: 'Librarian', permissions: [] }],
      assignedZones: ['ZONE_A', 'ZONE_B'],
    };
    useAuthStore.setState({
      accessToken: 'token-lib',
      refreshToken: 'refresh-lib',
      user: managerUser,
      capabilities: buildCapabilities(
        parseScopeString('ROLE_LIBRARIAN VIEW_ROOMS VIEW_ALERTS VIEW_DEVICE_STATUS')
      ),
      hydrated: true,
      isKioskSession: false,
    });

    // Mô phỏng viewport 1366x768 & Fullscreen API
    Object.defineProperty(window, 'innerWidth', { value: 1366, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true });

    let fsEl: Element | null = null;
    Object.defineProperty(document, 'fullscreenElement', {
      get: () => fsEl,
      configurable: true,
    });
    const reqFsMock = vi.fn(async function (this: Element) {
      fsEl = this;
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    const exitFsMock = vi.fn(async () => {
      fsEl = null;
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    Element.prototype.requestFullscreen = reqFsMock;
    document.exitFullscreen = exitFsMock;

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <FloorplanPage />
        </ToastProvider>
      </QueryClientProvider>
    );

    const canvasWrapper = await screen.findByTestId('floorplan-canvas-wrapper');
    const widthBeforeDrawer = canvasWrapper.getAttribute('data-canvas-width');

    // Click badge !1 của ROOM_302 để mở Drawer nổi bên phải
    const alertBadge = await screen.findByTestId('room-alert-badge-ROOM_302');
    fireEvent.click(alertBadge);

    const drawer = await screen.findByTestId('room-detail-drawer');
    expect(drawer).toHaveAttribute('role', 'complementary');
    expect(drawer).toHaveTextContent(room302.name);

    // Kích thước Canvas KHÔNG bị co lại khi mở Drawer
    expect(canvasWrapper.getAttribute('data-canvas-width')).toBe(widthBeforeDrawer);

    // Chế độ Toàn màn hình giữ cả Drawer bên trong workspace container
    const workspace = screen.getByTestId('floorplan-workspace');
    const fsBtn = screen.getByTestId('fullscreen-toggle-btn');
    fireEvent.click(fsBtn);

    await waitFor(() => {
      expect(reqFsMock).toHaveBeenCalledTimes(1);
    });
    expect(fsEl).toBe(workspace);
    expect(workspace.contains(drawer)).toBe(true);
    expect(screen.getByTestId('fullscreen-toggle-btn')).toHaveAttribute(
      'aria-label',
      'Thoát toàn màn hình'
    );

    // Mô phỏng thoát toàn màn hình (Esc)
    act(() => {
      fsEl = null;
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    expect(screen.getByTestId('fullscreen-toggle-btn')).toHaveAttribute(
      'aria-label',
      'Toàn màn hình'
    );
  });

  it('TC-G1-11: Vùng cảnh báo nổi bật với viền kép, breathing glow SVG và huy hiệu !2 trên cùng', async () => {
    const { statsByCanvas } = installCanvas2DMock();
    const room302 = makeRoomFromPreset('TQB_302', 'ROOM_302');

    render(
      <FloorplanCanvas
        rooms={[room302]}
        devices={[]}
        roomTelemetryMap={{ ROOM_302: makeTelemetry('ROOM_302', 45) }}
        layer="comfortScore"
        selectedRoomId={null}
        onSelectRoom={vi.fn()}
        firingRoomIds={['ROOM_302']}
        roomAlertCounts={{ ROOM_302: 2 }}
        roomAlertSeverities={{ ROOM_302: 'CRITICAL' }}
      />
    );

    const badge = await screen.findByTestId('room-alert-badge-ROOM_302');
    expect(badge).toHaveTextContent('!2');
    expect(badge).toHaveAttribute(
      'aria-label',
      expect.stringContaining('2 cảnh báo đang mở')
    );

    const breathingSvg = screen.getByTestId('alert-breathing-overlay');
    expect(breathingSvg).toBeInTheDocument();

    // Đảm bảo Canvas đã vẽ viền kép (#EF4444 + viền trong #FEE2E2) ở lượt cuối
    await waitFor(() => {
      const dynStats = statsByCanvas.get('dynamic-heatmap-canvas');
      expect(
        dynStats?.strokeCalls.some(
          (s) => s.strokeStyle.toUpperCase() === '#EF4444'
        )
      ).toBe(true);
      expect(
        dynStats?.strokeCalls.some(
          (s) => s.strokeStyle.toUpperCase() === '#FEE2E2'
        )
      ).toBe(true);
    });
  });

  it('TC-G1-12: Tách 2 lớp Canvas — telemetry cập nhật 1Hz KHÔNG vẽ lại nền tĩnh (drawImage = 0 lần)', async () => {
    const { statsByCanvas } = installCanvas2DMock();
    const createdImages: Array<{ onload: (() => void) | null; src: string }> = [];
    const OriginalImage = window.Image;
    class MockImage {
      onload: (() => void) | null = null;
      private _src = '';
      get src() {
        return this._src;
      }
      set src(val: string) {
        this._src = val;
        createdImages.push(this);
      }
    }
    vi.stubGlobal('Image', MockImage);

    try {
      const room301 = makeRoomFromPreset('TQB_301', 'ROOM_301');
      const dev1 = {
        id: 'dev-1',
        hardwareId: 'ESP32_301_A',
        name: 'Trạm 301-A',
        roomId: 'ROOM_301',
        zoneId: 'ZONE_A',
        deviceType: 'ESP32_NODE',
        active: true,
        online: true,
        connectionState: 'ONLINE' as const,
        posX: 0.25,
        posY: 0.25,
        lastSeenAt: null,
        lastOfflineAt: null,
      };

      const { rerender } = render(
        <FloorplanCanvas
          rooms={[room301]}
          devices={[dev1]}
          roomTelemetryMap={{ ROOM_301: makeTelemetry('ROOM_301', 82) }}
          layer="comfortScore"
          selectedRoomId={null}
          onSelectRoom={vi.fn()}
        />
      );

      // Kích hoạt CAD Image load xong lần đầu cho Tầng 3
      expect(createdImages.length).toBeGreaterThanOrEqual(1);
      act(() => {
        createdImages.forEach((img) => img.onload?.());
      });

      const staticStats = statsByCanvas.get('static-base-canvas')!;
      expect(staticStats.drawImageCalls).toBe(1);
      const initialDraws = staticStats.drawImageCalls;

      // Bơm 3 lần cập nhật telemetry 1Hz (không đổi tầng, zoom, kích thước)
      for (const score of [79, 74, 71]) {
        rerender(
          <FloorplanCanvas
            rooms={[room301]}
            devices={[dev1]}
            roomTelemetryMap={{
              ROOM_301: makeTelemetry(
                'ROOM_301',
                score,
                new Date(Date.now() + score * 1000).toISOString()
              ),
            }}
            layer="comfortScore"
            selectedRoomId={null}
            onSelectRoom={vi.fn()}
          />
        );
      }

      // Nền tĩnh StaticBaseCanvas không gọi lại drawImage thêm bất kỳ lần nào
      await waitFor(() => {
        const dynamicStats = statsByCanvas.get('dynamic-heatmap-canvas');
        expect(dynamicStats?.clearRectCalls).toBeGreaterThan(0);
      });
      expect(staticStats.drawImageCalls).toBe(initialDraws);
    } finally {
      vi.stubGlobal('Image', OriginalImage);
    }
  });
});
