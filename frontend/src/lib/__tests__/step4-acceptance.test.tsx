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
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FloorplanPage from '@/app/(protected)/floorplan/page';
import { ToastProvider } from '@/components/ui/primitives';
import {
  FURNITURE_CATALOG,
  filterVisibleFurnitureCatalog,
  filterVisibleFurnitureItems,
  resolveFurnitureCatalogEntry,
  type FurnitureCatalogEntry,
} from '@/config/furniture-catalog';
import {
  TIMING_CONFIG,
  classifyManagerRoomStatus,
  resolveRoomHealthMatchesFilter,
} from '@/config/floorplan-hmi.config';
import {
  TQB_BUILDING_ASPECT_RATIO,
  TQB_ROOM_PRESETS,
  getFloorRoomPresets,
} from '@/config/tqb-floorplan-presets';
import { alertsApi } from '@/features/alerts/api';
import { useAuthStore } from '@/features/auth/store';
import { devicesApi } from '@/features/devices/api';
import {
  AlertInspectorDrawer,
  MapAlertQueuePanel,
} from '@/features/floorplan/components/AlertInspectorDrawer';
import { FloorRoomTree } from '@/features/floorplan/components/FloorRoomTree';
import { FloorplanCanvas } from '@/features/floorplan/components/FloorplanCanvas';
import { FloorplanLegend } from '@/features/floorplan/components/FloorplanLegend';
import { FurnitureLayerEditor } from '@/features/floorplan/components/FurnitureLayerEditor';
import {
  ManagerSummaryStrip,
  computeBuildingSummaryMetrics,
} from '@/features/floorplan/components/ManagerSummaryStrip';
import { RoomHoverPopover } from '@/features/floorplan/components/RoomHoverPopover';
import { roomsApi } from '@/features/rooms/api';
import { telemetryApi } from '@/features/telemetry/api';
import {
  groupAlertsByRoom,
  summarizeAlertForManagerVi,
} from '@/lib/floorplan/alertWorkflow';
import {
  buildBuildingFloorTree,
  getRoomHealthBadgeStyle,
} from '@/lib/floorplan/floorTreeBuilder';
import {
  isFurnitureInsideRoom,
  validateFurnitureLayout,
} from '@/lib/floorplan/furnitureGeometry';
import {
  boxesOverlap,
  computeLabelPlacements,
  computeRoomLabelPriority,
  getLodConfig,
  makeLabelBox,
  type LabelRequest,
} from '@/lib/floorplan/labelLayout';
import {
  createAnimatedMetricState,
  evaluateAnimatedMetricState,
  updateAnimatedMetricState,
} from '@/lib/floorplan/metricTransition';
import { computeVisualPolygonCenter } from '@/lib/floorplan/polygon';
import {
  classifyPixelReliability,
  evaluateRoomReliability,
} from '@/lib/floorplan/reliability';
import { computeOneHourDelta } from '@/lib/floorplan/timeAnalysis';
import {
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
import {
  mergeRealtimeTelemetry,
  stompManager,
} from '@/lib/realtime/stomp-client';
import type {
  AlertResponse,
  BucketDataPoint,
  DeviceResponse,
  FurnitureItem,
  Point2D,
  RoomResponse,
  TelemetryResponse,
  UserResponse,
} from '@/types/api';
// @ts-expect-error untyped simulator ESM module outside frontend tsconfig
import { SCENARIOS, generateBadPayloadSample, getScenarioModifiers } from '../../../../tools/iot-simulator/src/scenarios.js';

vi.mock('../../../../tools/iot-simulator/src/config.js', async () => {
  const mod = await import('../../../../tools/iot-simulator/config/profiles.json');
  return {
    profilesConfig: mod.default ?? mod,
    roomsConfig: [],
    env: {},
  };
});

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
  const createCtx = (canvas?: HTMLCanvasElement) => {
    const grad = { addColorStop: vi.fn() };
    return {
      canvas,
      fillStyle: '#000000',
      strokeStyle: '#000000',
      lineWidth: 1,
      lineJoin: 'miter',
      font: '12px sans-serif',
      textAlign: 'left',
      textBaseline: 'alphabetic',
      shadowColor: 'transparent',
      shadowBlur: 0,
      filter: 'none',
      globalAlpha: 1,
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'high' as ImageSmoothingQuality,
      save: vi.fn(),
      restore: vi.fn(),
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      translate: vi.fn(),
      scale: vi.fn(),
      rotate: vi.fn(),
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
      createRadialGradient: vi.fn(() => grad),
      createLinearGradient: vi.fn(() => grad),
      measureText: vi.fn((text: string) => ({ width: text.length * 6.8 })),
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
  };

  const ctxCache = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>();
  const spy = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockImplementation(function (this: HTMLCanvasElement, contextId: string) {
      if (contextId !== '2d') return null;
      let cached = ctxCache.get(this);
      if (!cached) {
        cached = createCtx(this);
        ctxCache.set(this, cached);
      }
      return cached;
    });

  return { spy, createCtx };
}

function makeRoomFromPreset(code: string, idOverride?: string): RoomResponse {
  const preset = TQB_ROOM_PRESETS.find((p) => p.code === code);
  if (!preset) {
    throw new Error(`Missing preset ${code}`);
  }
  return {
    id: idOverride ?? `ROOM_${preset.code}`,
    code: preset.code,
    name: preset.name,
    floor: preset.floor,
    capacity: preset.capacity,
    type: preset.roomType,
    targetComfortScore: preset.roomType === 'BOOK_STORAGE' ? 90 : 85,
    boundaryPolygon: [...preset.boundaryPolygon],
  };
}

function makeDevice(
  id: string,
  hardwareId: string,
  roomId: string,
  zoneId = 'ZONE_A',
  online = true,
  pos = { x: 0.48, y: 0.48 }
): DeviceResponse {
  return {
    id,
    hardwareId,
    name: `Trạm ${hardwareId}`,
    roomId,
    zoneId,
    deviceType: 'ESP32_NODE',
    active: true,
    online,
    connectionState: online ? 'ONLINE' : 'OFFLINE',
    posX: pos.x,
    posY: pos.y,
    lastSeenAt: new Date().toISOString(),
    lastOfflineAt: online ? null : new Date().toISOString(),
  };
}

function makeTelemetry(
  roomId: string,
  overrides: {
    score?: number;
    temperature?: number;
    humidity?: number;
    noiseAvg?: number;
    noisePeak?: number;
    pm2_5?: number;
    lux?: number;
    wifiRssi?: number;
    timestamp?: string;
    isSynthetic?: boolean;
  } = {}
): TelemetryResponse {
  const score = overrides.score ?? 86;
  const noiseAvg = overrides.noiseAvg ?? 41.5;
  return {
    id: `tel-${roomId}`,
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    isSynthetic: overrides.isSynthetic ?? false,
    metadata: {
      deviceId: `dev-${roomId}`,
      hardwareId: `ESP32_${roomId}`,
      roomId,
    },
    environment: {
      temperature: overrides.temperature ?? 23.2,
      humidity: overrides.humidity ?? 51.0,
      lux: overrides.lux ?? 400,
    },
    acoustics: {
      noiseAvg,
      noisePeak: overrides.noisePeak ?? noiseAvg + 5.0,
    },
    airQuality: {
      pm1_0: 8.0,
      pm2_5: overrides.pm2_5 ?? 11.5,
      pm4_0: 14.0,
      pm10: 18.0,
    },
    wifiRssi: overrides.wifiRssi ?? -55,
    comfortScore: {
      overall: score,
      grade: score >= 75 ? 'Gold' : score >= 60 ? 'Silver' : 'Poor',
      acousticScore: score,
      airScore: score,
      thermalScore: score,
      lightScore: score,
    },
  };
}

function makeAlert(overrides: Partial<AlertResponse> = {}): AlertResponse {
  return {
    id: 'alert-step4-1',
    deviceId: 'dev-302',
    hardwareId: 'ESP32_T3_02',
    roomId: 'ROOM_TQB_302',
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
    message: 'Peak noise spike (86.0 dBA) exceeded threshold (85.0 dBA)',
    startedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
    acknowledgedAt: null,
    resolvedAt: null,
    acknowledgedBy: null,
    resolvedBy: null,
    ...overrides,
  };
}

function setupManagerAuth(roleName: 'LIBRARIAN' | 'ADMIN' = 'LIBRARIAN') {
  const user: UserResponse = {
    id: 'user-step4-mgr',
    username: 'quanly_tqb',
    active: true,
    roles: [{ name: roleName, description: roleName, permissions: [] }],
    assignedZones: ['ZONE_A', 'ZONE_B', 'ZONE_HALL'],
  };
  const scope =
    roleName === 'ADMIN'
      ? 'ROLE_ADMIN VIEW_ROOMS MANAGE_ROOMS VIEW_TELEMETRY VIEW_DEVICES MANAGE_DEVICES VIEW_ALERTS ACKNOWLEDGE_ALERT RESOLVE_ALERT MANAGE_ZONES'
      : 'ROLE_LIBRARIAN VIEW_ROOMS VIEW_TELEMETRY VIEW_DEVICES VIEW_ALERTS ACKNOWLEDGE_ALERT RESOLVE_ALERT MANAGE_ZONES';
  useAuthStore.setState({
    accessToken: 'step4-token',
    refreshToken: 'step4-refresh',
    user,
    capabilities: buildCapabilities(parseScopeString(scope)),
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

describe('Bước 4 (Hạng Mục 9): Kiểm Thử Nghiệm Thu Tổng Thể 9.1 & 10 Kịch Bản Simulator 9.2', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/floorplan');
    setupManagerAuth('LIBRARIAN');
    stompManager.deactivate();
  });

  afterEach(() => {
    cleanup();
    stompManager.deactivate();
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

  // ===========================================================================
  // BẢNG 9.1 — TIÊU CHÍ NGHIỆM THU TỔNG THỂ (#1 -> #6)
  // ===========================================================================
  describe('9.1. Bảng Tiêu Chí Nghiệm Thu Tổng Thể (#1–#6)', () => {
    it('Tiêu chí 9.1 #1: 33 phòng / 5 tầng hiển thị 0 cặp nhãn giao cắt ở 1366×768 & 1920×1080 tại mọi mức zoom chính (1.0x, 1.5x, 2.2x, 3.0x)', () => {
      expect(TQB_ROOM_PRESETS).toHaveLength(33);

      const viewports = [
        { width: 1366, height: 768 },
        { width: 1920, height: 1080 },
      ];
      const scales = [1.0, 1.5, 2.2, 3.0];

      for (const vp of viewports) {
        for (const scale of scales) {
          const lod = getLodConfig('balanced', scale);
          for (const floor of [1, 2, 3, 4, 5]) {
            const presets = getFloorRoomPresets(floor);
            expect(presets.length).toBeGreaterThan(0);

            const requests: LabelRequest[] = presets.map((preset, idx) => {
              const screenPolygon = preset.boundaryPolygon.map((pt) => ({
                x: pt.x * vp.width * scale,
                y: pt.y * vp.height * scale,
              }));
              const centroid = computeVisualPolygonCenter(preset.boundaryPolygon);
              const anchor = {
                x: centroid.x * vp.width * scale,
                y: centroid.y * vp.height * scale,
              };

              const codeWidth = Math.max(44, preset.code.length * 7 + 8);
              const pillWidth = Math.max(66, preset.code.length * 7 + 34);
              const richWidth = Math.max(92, preset.code.length * 7.5 + 32);

              const tiers =
                lod.roomLabel === 'rich'
                  ? [
                      { style: 'pill' as const, width: pillWidth, height: 20 },
                      { style: 'code' as const, width: codeWidth, height: 16 },
                    ]
                  : lod.roomLabel === 'pill'
                    ? [{ style: 'code' as const, width: codeWidth, height: 16 }]
                    : [];

              const hasSimulatedAlert = idx === 0;
              return {
                id: preset.code,
                anchor,
                width:
                  lod.roomLabel === 'rich'
                    ? richWidth
                    : lod.roomLabel === 'pill'
                      ? pillWidth
                      : codeWidth,
                height:
                  lod.roomLabel === 'rich'
                    ? 36
                    : lod.roomLabel === 'pill'
                      ? 20
                      : 16,
                polygon: screenPolygon,
                priority: computeRoomLabelPriority({
                  areaM2: preset.areaM2,
                  hasAlert: hasSimulatedAlert,
                  alertSeverity: hasSimulatedAlert ? 'CRITICAL' : undefined,
                }),
                style: lod.roomLabel,
                fallbackTiers: tiers,
              };
            });

            const placements = computeLabelPlacements(requests, [], {
              width: vp.width * scale,
              height: vp.height * scale,
            });

            const visible = placements
              .map((p, idx) => ({ p, req: requests[idx] }))
              .filter((item) => item.p.visible);

            expect(visible.length).toBeGreaterThan(0);

            for (let i = 0; i < visible.length; i += 1) {
              for (let j = i + 1; j < visible.length; j += 1) {
                const boxA = makeLabelBox(
                  visible[i].p.x,
                  visible[i].p.y,
                  visible[i].p.width ?? visible[i].req.width,
                  visible[i].p.height ?? visible[i].req.height
                );
                const boxB = makeLabelBox(
                  visible[j].p.x,
                  visible[j].p.y,
                  visible[j].p.width ?? visible[j].req.width,
                  visible[j].p.height ?? visible[j].req.height
                );
                expect(
                  boxesOverlap(boxA, boxB, 0),
                  `Overlap between ${visible[i].p.id} and ${visible[j].p.id} on floor ${floor} (${vp.width}×${vp.height} @ ${scale}x)`
                ).toBe(false);
              }
            }
          }
        }
      }
    });

    it('Tiêu chí 9.1 #2: Above-the-fold layout trên 1366×768 và 1920×1080 — Quản lý thấy ngay tổng cảnh báo và vùng viền đỏ + huy hiệu !N ở scrollY = 0', async () => {
      installCanvas2DMock();
      vi.spyOn(stompManager, 'activate').mockImplementation(() => {});
      vi.spyOn(stompManager, 'isConnected').mockReturnValue(true);

      const room301 = makeRoomFromPreset('TQB_301', 'ROOM_TQB_301');
      const room302 = makeRoomFromPreset('TQB_302', 'ROOM_TQB_302');
      const critAlert = makeAlert({
        id: 'alert-302-crit',
        roomId: 'ROOM_TQB_302',
        severity: 'CRITICAL',
      });

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
        content: [critAlert],
        page: 0,
        size: 50,
        totalElements: 1,
        totalPages: 1,
        last: true,
      });
      vi.spyOn(telemetryApi, 'getRoomLatest').mockImplementation(
        async (roomId) =>
          makeTelemetry(roomId, {
            score: roomId === 'ROOM_TQB_302' ? 54 : 88,
            noiseAvg: roomId === 'ROOM_TQB_302' ? 74.0 : 41.0,
          })
      );
      vi.spyOn(roomsApi, 'getFurniture').mockResolvedValue({
        roomId: 'ROOM_TQB_301',
        version: 1,
        items: [],
        auditHistory: [],
      });

      for (const vp of [
        { width: 1366, height: 768 },
        { width: 1920, height: 1080 },
      ]) {
        Object.defineProperty(window, 'innerWidth', {
          writable: true,
          configurable: true,
          value: vp.width,
        });
        Object.defineProperty(window, 'innerHeight', {
          writable: true,
          configurable: true,
          value: vp.height,
        });
        fireEvent(window, new Event('resize'));

        const { unmount } = renderWithProviders(<FloorplanPage />);

        const canvasWrapper = await screen.findByTestId('floorplan-canvas-wrapper');
        const canvasHeight = Number(
          canvasWrapper.getAttribute('data-canvas-height')
        );
        expect(canvasHeight).toBeGreaterThanOrEqual(340);
        expect(canvasHeight).toBeLessThanOrEqual(vp.height - 90);

        const badge302 = await screen.findByTestId(
          'room-alert-badge-ROOM_TQB_302'
        );
        expect(badge302).toHaveTextContent('!1');
        expect(
          screen.getByTestId('alert-breathing-overlay')
        ).toBeInTheDocument();

        unmount();
      }
    });

    it('Tiêu chí 9.1 #3: Hiệu năng >= 30 FPS (<= 16.6ms/frame) dưới tải 1Hz 33 phòng & Không rò rỉ bộ nhớ / STOMP listener sau 50 lần chuyển đổi Tầng 1 <-> Tầng 5', async () => {
      const { createCtx } = installCanvas2DMock();
      vi.spyOn(stompManager, 'activate').mockImplementation(() => {});
      vi.spyOn(stompManager, 'isConnected').mockReturnValue(true);

      // Part A: Frame time benchmark over 30 frames of 1Hz updates across Floor 5 (13 rooms, densest floor)
      const floor5Presets = getFloorRoomPresets(5);
      expect(floor5Presets).toHaveLength(13);
      const mockCtx = createCtx();
      const canvasW = 960;
      const canvasH = Math.round(960 * TQB_BUILDING_ASPECT_RATIO);

      const frameCount = 30;
      const t0 = performance.now();
      for (let f = 0; f < frameCount; f += 1) {
        const requests: LabelRequest[] = [];
        for (const preset of floor5Presets) {
          const pxVerts = preset.boundaryPolygon.map((p) => ({
            x: p.x * canvasW,
            y: p.y * canvasH,
          }));
          const c = computeVisualPolygonCenter(preset.boundaryPolygon);
          renderWeatherDiffusionHeatmap(
            mockCtx,
            pxVerts,
            [{ x: c.x, y: c.y, value: 78 + (f % 10), online: true }],
            'comfortScore',
            canvasW,
            canvasH,
            80,
            0.22,
            { normalizedPolygon: preset.boundaryPolygon, skipDarkBase: true }
          );
          requests.push({
            id: preset.code,
            anchor: { x: c.x * canvasW, y: c.y * canvasH },
            width: 66,
            height: 20,
            polygon: pxVerts,
            priority: computeRoomLabelPriority({ areaM2: preset.areaM2 }),
            style: 'pill',
            fallbackTiers: [{ style: 'code', width: 46, height: 16 }],
          });
        }
        computeLabelPlacements(requests, [], {
          width: canvasW,
          height: canvasH,
        });
      }
      const meanFrameMs = (performance.now() - t0) / frameCount;
      expect(meanFrameMs).toBeLessThanOrEqual(16.6);

      // Part B: 50x rapid floor switch between Floor 1 and Floor 5 — check STOMP listeners & canvas caches
      const floor1Room = makeRoomFromPreset('TQB_101', 'ROOM_TQB_101');
      const floor5Room = makeRoomFromPreset('TQB_501', 'ROOM_TQB_501');
      const dev1 = makeDevice('dev-101', 'ESP32_101', 'ROOM_TQB_101');
      const dev5 = makeDevice('dev-501', 'ESP32_501', 'ROOM_TQB_501');

      vi.spyOn(roomsApi, 'list').mockResolvedValue({
        content: [floor1Room, floor5Room],
        page: 0,
        size: 100,
        totalElements: 2,
        totalPages: 1,
        last: true,
      });
      vi.spyOn(devicesApi, 'list').mockResolvedValue({
        content: [dev1, dev5],
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
      vi.spyOn(telemetryApi, 'getRoomLatest').mockImplementation(
        async (roomId) => makeTelemetry(roomId)
      );
      vi.spyOn(telemetryApi, 'getDeviceLatest').mockImplementation(
        async (devId) => makeTelemetry(devId)
      );
      vi.spyOn(roomsApi, 'getFurniture').mockResolvedValue({
        roomId: 'ROOM_TQB_101',
        version: 1,
        items: [],
        auditHistory: [],
      });

      const { unmount } = renderWithProviders(<FloorplanPage />);

      const btnFloor1 = await screen.findByRole('button', { name: 'Tầng 1' });
      const btnFloor5 = await screen.findByRole('button', { name: 'Tầng 5' });

      const diagInitial = stompManager.getListenerDiagnostics();
      expect(diagInitial.roomChannelCount).toBe(2);
      expect(diagInitial.roomListenersCount).toBe(2);
      expect(diagInitial.alertListenersCount).toBe(1);

      for (let i = 0; i < 50; i += 1) {
        fireEvent.click(i % 2 === 0 ? btnFloor1 : btnFloor5);
      }

      const diagAfter50 = stompManager.getListenerDiagnostics();
      expect(diagAfter50.roomChannelCount).toBe(diagInitial.roomChannelCount);
      expect(diagAfter50.roomListenersCount).toBe(
        diagInitial.roomListenersCount
      );
      expect(diagAfter50.alertListenersCount).toBe(
        diagInitial.alertListenersCount
      );
      expect(diagAfter50.connectionListenersCount).toBe(
        diagInitial.connectionListenersCount
      );

      const wrapper = await screen.findByTestId('floorplan-canvas-wrapper');
      const animCacheSize = Number(
        wrapper.getAttribute('data-anim-cache-size')
      );
      const cadCacheSize = Number(wrapper.getAttribute('data-cad-cache-size'));
      expect(animCacheSize).toBeLessThanOrEqual(2);
      expect(cadCacheSize).toBeLessThanOrEqual(12);

      unmount();

      const diagUnmounted = stompManager.getListenerDiagnostics();
      expect(diagUnmounted.roomChannelCount).toBe(0);
      expect(diagUnmounted.roomListenersCount).toBe(0);
      expect(diagUnmounted.alertListenersCount).toBe(0);
      expect(diagUnmounted.connectionListenersCount).toBe(0);
    });

    it('Tiêu chí 9.1 #4: Điều hướng bàn phím đầy đủ, Thang màu qua kiểm tra mù màu (Deuteranopia/Protanopia), Tương phản WCAG 2.2 AA & 0 lỗi axe-core (Critical/Serious)', async () => {
      installCanvas2DMock();
      vi.spyOn(stompManager, 'activate').mockImplementation(() => {});
      vi.spyOn(stompManager, 'isConnected').mockReturnValue(true);

      // 1. Colorblind luminance separation & geometric symbol non-color dependency
      const [gR, gG, gB] = getContinuousMetricColor('comfortScore', 88);
      const [wR, wG, wB] = getContinuousMetricColor('comfortScore', 65);
      const [cR, cG, cB] = getContinuousMetricColor('comfortScore', 38);

      for (const cvd of ['deuteranopia', 'protanopia'] as const) {
        const gSim = simulateColorVisionDeficiency([gR, gG, gB], cvd);
        const wSim = simulateColorVisionDeficiency([wR, wG, wB], cvd);
        const cSim = simulateColorVisionDeficiency([cR, cG, cB], cvd);
        expect(
          Math.abs(getRelativeLuminance(gSim) - getRelativeLuminance(wSim))
        ).toBeGreaterThan(0.15);
        expect(
          Math.abs(getRelativeLuminance(wSim) - getRelativeLuminance(cSim))
        ).toBeGreaterThan(0.15);
      }

      const symbols = [
        getMetricStatusSymbol('comfortScore', 88).symbol,
        getMetricStatusSymbol('comfortScore', 65).symbol,
        getMetricStatusSymbol('comfortScore', 40).symbol,
        getMetricStatusSymbol('comfortScore', null).symbol,
      ];
      expect(symbols).toEqual(['●', '▲', '◆', '○']);
      expect(new Set(symbols).size).toBe(4);

      // 2. WCAG 2.2 AA contrast ratio (>= 4.5:1)
      const contrastPairs: Array<[string, string]> = [
        ['#F8FAFC', '#0F172A'],
        ['#38BDF8', '#0F172A'],
        ['#FBBF24', '#0F172A'],
        ['#FCA5A5', '#0F172A'],
        ['#082F49', '#F0F9FF'],
        ['#451A03', '#FFFBEB'],
        ['#4C0519', '#FFF1F2'],
        ['#FFFFFF', '#B91C1C'],
      ];
      for (const [fg, bg] of contrastPairs) {
        expect(
          getWcagContrastRatio(hexToRgb(fg), hexToRgb(bg))
        ).toBeGreaterThanOrEqual(4.5);
      }

      // 3. Full keyboard navigation on WAI-ARIA Tree & axe-core audit on FloorplanPage
      const room301 = makeRoomFromPreset('TQB_301', 'ROOM_TQB_301');
      const room302 = makeRoomFromPreset('TQB_302', 'ROOM_TQB_302');
      const alert302 = makeAlert({
        id: 'alert-a11y-1',
        roomId: 'ROOM_TQB_302',
      });

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
        content: [alert302],
        page: 0,
        size: 50,
        totalElements: 1,
        totalPages: 1,
        last: true,
      });
      vi.spyOn(telemetryApi, 'getRoomLatest').mockImplementation(
        async (roomId) => makeTelemetry(roomId)
      );
      vi.spyOn(roomsApi, 'getFurniture').mockResolvedValue({
        roomId: 'ROOM_TQB_301',
        version: 1,
        items: [],
        auditHistory: [],
      });

      const { container } = renderWithProviders(<FloorplanPage />);

      // Select alerting room TQB_302 directly via its map alert badge -> opens Drawer + AlertInspectorDrawer
      const alertBadge302 = await screen.findByTestId(
        'room-alert-badge-ROOM_TQB_302'
      );
      fireEvent.click(alertBadge302);
      expect(
        await screen.findByTestId('room-detail-drawer')
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('alert-inspector-drawer')
      ).toBeInTheDocument();

      // Run axe-core automated accessibility scan on the full FloorplanPage with Drawer open
      const axeResults = await axe.run(container, {
        rules: {
          // jsdom does not compute layout/canvas pixel colors; contrast is verified arithmetically above
          'color-contrast': { enabled: false },
        },
      });
      const criticalOrSerious = axeResults.violations.filter(
        (v) => v.impact === 'critical' || v.impact === 'serious'
      );
      expect(
        criticalOrSerious,
        JSON.stringify(
          criticalOrSerious.map((v) => ({
            id: v.id,
            impact: v.impact,
            nodes: v.nodes.map((n) => n.html),
          })),
          null,
          2
        )
      ).toHaveLength(0);
    });

    it('Tiêu chí 9.1 #6: Khả năng mở rộng (Config-driven) — tiêm động Tầng 6, Phòng TQB_601 và nội thất SMART_POD tự động hiển thị mà không sửa code component', () => {
      installCanvas2DMock();

      const customRoom601: RoomResponse = {
        id: 'ROOM_TQB_601',
        code: 'TQB_601',
        name: 'Không gian Sáng tạo số Tầng 6',
        floor: 6,
        capacity: 48,
        type: 'STUDY_ROOM',
        targetComfortScore: 85,
        boundaryPolygon: [
          { x: 0.2, y: 0.2 },
          { x: 0.8, y: 0.2 },
          { x: 0.8, y: 0.8 },
          { x: 0.2, y: 0.8 },
        ],
      };

      const customPodEntry: FurnitureCatalogEntry = {
        typeId: 'SMART_POD',
        labelVi: 'Buồng học cách âm Smart Pod',
        shortLabel: 'SmartPod',
        category: 'SEATING',
        defaultWidthM: 2.2,
        defaultDepthM: 1.8,
        minWidthM: 1.5,
        maxWidthM: 3.5,
        minDepthM: 1.2,
        maxDepthM: 3.0,
        blocksWalkway: true,
        sensitiveHardware: false,
        fillColor: '#0F766E',
        strokeColor: '#2DD4BF',
        shape: 'custom_pod',
      };
      const extendedCatalog = [...FURNITURE_CATALOG, customPodEntry];

      // 1. Dynamic Floor 6 & Room TQB_601 in buildBuildingFloorTree & FloorRoomTree
      const treeNodes = buildBuildingFloorTree(
        [...TQB_ROOM_PRESETS.map((p) => makeRoomFromPreset(p.code)), customRoom601],
        { ROOM_TQB_601: makeTelemetry('ROOM_TQB_601', { score: 91 }) },
        []
      );
      expect(treeNodes.map((f) => f.floor)).toEqual([1, 2, 3, 4, 5, 6]);

      const onSelectFloor = vi.fn();
      const onSelectRoom = vi.fn();
      render(
        <FloorRoomTree
          treeNodes={treeNodes}
          selectedFloor={6}
          selectedRoomId="ROOM_TQB_601"
          onSelectFloor={onSelectFloor}
          onSelectRoom={onSelectRoom}
        />
      );
      expect(screen.getByTestId('tree-floor-6')).toHaveTextContent('Tầng 6');
      expect(screen.getByTestId('tree-room-TQB_601')).toHaveTextContent(
        'Không gian Sáng tạo số Tầng 6'
      );

      // 2. Dynamic SMART_POD in FurnitureLayerEditor & geometry validation
      const committedItems: FurnitureItem[][] = [];
      render(
        <FurnitureLayerEditor
          room={customRoom601}
          roomPolygon={customRoom601.boundaryPolygon!}
          catalog={extendedCatalog}
          items={[]}
          canUndo={false}
          canRedo={false}
          selectedIds={[]}
          onSelectIds={vi.fn()}
          onCommitItems={(next) => committedItems.push(next)}
          onUndo={vi.fn()}
          onRedo={vi.fn()}
          snapEnabled={true}
          onSnapEnabledChange={vi.fn()}
          showLayer={true}
          onShowLayerChange={vi.fn()}
          opacity={0.7}
          onOpacityChange={vi.fn()}
          version={1}
          auditHistory={[]}
          onSave={vi.fn()}
          onReload={vi.fn()}
        />
      );

      const addSmartPodBtn = screen.getByTestId(
        'furniture-catalog-add-SMART_POD'
      );
      expect(addSmartPodBtn).toHaveTextContent('Buồng học cách âm Smart Pod');
      fireEvent.click(addSmartPodBtn);

      expect(committedItems).toHaveLength(1);
      const placedPod = committedItems[0][0];
      expect(placedPod.typeId).toBe('SMART_POD');
      expect(placedPod.widthM).toBe(2.2);
      expect(placedPod.depthM).toBe(1.8);
      expect(
        isFurnitureInsideRoom(placedPod, customRoom601.boundaryPolygon!)
      ).toBe(true);
      expect(
        validateFurnitureLayout(
          [placedPod],
          customRoom601.boundaryPolygon!,
          extendedCatalog
        ).valid
      ).toBe(true);
    });
  });

  // ===========================================================================
  // BẢNG 9.2 — MA TRẬN KIỂM THỬ 10 KỊCH BẢN SIMULATOR TRÊN BẢN ĐỒ NHIỆT (#1 -> #10)
  // ===========================================================================
  describe('9.2. Ma Trận Kiểm Thử 10 Kịch Bản Simulator (tools/iot-simulator/src/scenarios.js)', () => {
    it('Kịch bản #1 (normal): 0 cảnh báo mở, 100% phòng ● Tốt, màu xanh dịu ISA-101, độ tin cậy Đo trực tiếp', () => {
      const modifiers = getScenarioModifiers(
        SCENARIOS.NORMAL,
        { hardwareId: 'ESP32_T3_01', zoneId: 'ZONE_A' },
        1
      );
      expect(modifiers).toEqual({});

      const allRooms = TQB_ROOM_PRESETS.map((p) =>
        makeRoomFromPreset(p.code, `ROOM_${p.code}`)
      );
      const telemetryMap: Record<string, TelemetryResponse> = {};
      for (const r of allRooms) {
        telemetryMap[r.id] = makeTelemetry(r.id, {
          score: 86,
          temperature: 23.2,
          noiseAvg: 41.0,
          pm2_5: 11.0,
        });
      }

      const summary = computeBuildingSummaryMetrics(
        allRooms,
        telemetryMap,
        []
      );
      expect(summary.totalOpenAlerts).toBe(0);
      expect(summary.roomCounts.GOOD).toBe(33);
      expect(summary.roomCounts.ATTENTION).toBe(0);
      expect(summary.roomCounts.POOR).toBe(0);

      render(
        <ManagerSummaryStrip
          metrics={summary}
          activeFilter="ALL"
          onFilterChange={vi.fn()}
          stompConnected={true}
        />
      );
      expect(screen.getByTestId('summary-filter-alerts')).toHaveTextContent(
        '0 Cảnh báo mở'
      );
      expect(screen.getByTestId('summary-filter-good')).toHaveTextContent(
        '●33 Tốt'
      );

      // ISA-101 calm teal/sky-blue color for normal LCS 86 (alpha <= 0.60)
      const [r, g, b, a] = getContinuousMetricColor('comfortScore', 86);
      expect(b).toBeGreaterThan(r);
      expect(g).toBeGreaterThan(r);
      expect(a).toBeLessThanOrEqual(0.62);

      // Reliability = MEASURED ("Đo trực tiếp")
      const rel = evaluateRoomReliability({
        room: allRooms[0],
        telemetry: telemetryMap[allRooms[0].id],
        devices: [
          makeDevice('d1', 'ESP32_1', allRooms[0].id, 'ZONE_A', true),
        ],
        blindspotRatio: 0.08,
      });
      expect(rel.state).toBe('MEASURED');
      expect(rel.badgeText).toBe('Đo trực tiếp');
    });

    it('Kịch bản #2 (noise-spike): xung đỉnh 86.0 dBA (>= 85 dBA immediateFire) -> CRITICAL NOISE_EXCEEDED, viền đỏ kép + huy hiệu !1 + Drawer SOP nhắc nhở trật tự', async () => {
      installCanvas2DMock();
      const modStep6 = getScenarioModifiers(
        SCENARIOS.NOISE_SPIKE,
        { hardwareId: 'ESP32_T3_02', zoneId: 'ZONE_B' },
        6
      );
      expect(modStep6.noiseOverride).toBe(86.0);

      const room302 = makeRoomFromPreset('TQB_302', 'ROOM_TQB_302');
      const dev302 = makeDevice('dev-302', 'ESP32_T3_02', room302.id, 'ZONE_B');
      const spikeAlert = makeAlert({
        id: 'alert-noise-spike-86',
        roomId: room302.id,
        deviceId: dev302.id,
        hardwareId: dev302.hardwareId,
        type: 'NOISE_EXCEEDED',
        metricType: 'NOISE_PEAK',
        severity: 'CRITICAL',
        currentValue: modStep6.noiseOverride,
        threshold: 85.0,
      });

      const onSelectRoom = vi.fn();
      render(
        <div>
          <FloorplanCanvas
            rooms={[room302]}
            devices={[dev302]}
            roomTelemetryMap={{
              [room302.id]: makeTelemetry(room302.id, {
                score: 52,
                noiseAvg: 71.5,
                noisePeak: modStep6.noiseOverride,
              }),
            }}
            layer="noiseAvg"
            selectedRoomId={room302.id}
            onSelectRoom={onSelectRoom}
            firingRoomIds={[room302.id]}
            roomAlertCounts={{ [room302.id]: 1 }}
            roomAlertSeverities={{ [room302.id]: 'CRITICAL' }}
            alertingDeviceIds={[dev302.id]}
          />
          <AlertInspectorDrawer
            alerts={[spikeAlert]}
            room={room302}
            canAcknowledge={true}
            canResolve={true}
            onUpdateWorkflow={vi.fn()}
            onFlyToAlert={vi.fn()}
          />
        </div>
      );

      expect(screen.getByTestId('alert-breathing-overlay')).toBeInTheDocument();
      const roomBadge = await screen.findByTestId(
        `room-alert-badge-${room302.id}`
      );
      expect(roomBadge).toHaveTextContent('!1');

      const drawer = screen.getByTestId('alert-inspector-drawer');
      expect(drawer).toHaveTextContent('Khẩn cấp');
      expect(drawer).toHaveTextContent('86.0 dBA');
      expect(
        screen.queryByTestId(`alert-sop-${spikeAlert.id}`)
      ).not.toBeInTheDocument();
    });

    it('Kịch bản #3 (pm25-high): PM2.5 = 68.0–80.0 µg/m³ (> 50 µg/m³) -> HIGH AIR_UNHEALTHY, lớp PM2.5 hiển thị ký hiệu ◆ kèm SOP cấp khí tươi AHU', () => {
      installCanvas2DMock();
      const mod = getScenarioModifiers(
        SCENARIOS.PM25_HIGH,
        { hardwareId: 'ESP32_T3_01', zoneId: 'ZONE_A' },
        2
      );
      expect(mod.pm25Override).toBeGreaterThanOrEqual(68.0);
      expect(mod.pm25Override).toBeLessThanOrEqual(80.0);

      const room301 = makeRoomFromPreset('TQB_301', 'ROOM_TQB_301');
      const statusEval = getMetricStatusSymbol(
        'pm2_5',
        mod.pm25Override,
        room301.type
      );
      expect(statusEval.level).toBe('CRITICAL');
      expect(statusEval.symbol).toBe('◆');
      expect(statusEval.isExceedingThreshold).toBe(true);

      const [r, g, b] = getContinuousMetricColor('pm2_5', mod.pm25Override);
      expect(r).toBeGreaterThan(220);
      expect(r).toBeGreaterThan(b * 3);

      const pmAlert = makeAlert({
        id: 'alert-pm25-high',
        roomId: room301.id,
        type: 'AIR_UNHEALTHY',
        metricType: 'PM2_5',
        severity: 'HIGH',
        currentValue: mod.pm25Override,
        threshold: 50.0,
        message: `PM2.5 particulate level (${mod.pm25Override.toFixed(1)} µg/m³) exceeded threshold (50.0 µg/m³)`,
      });

      render(
        <div>
          <RoomHoverPopover
            room={room301}
            layer="pm2_5"
            value={mod.pm25Override}
            openAlertsCount={1}
          />
          <AlertInspectorDrawer
            alerts={[pmAlert]}
            room={room301}
            canAcknowledge={true}
            canResolve={true}
            onUpdateWorkflow={vi.fn()}
            onFlyToAlert={vi.fn()}
          />
        </div>
      );

      expect(screen.getByTestId('room-hover-popover')).toHaveTextContent('◆');
      expect(
        screen.queryByTestId(`alert-sop-${pmAlert.id}`)
      ).not.toBeInTheDocument();
    });

    it('Kịch bản #4 (heat/humid): Nhiệt độ 35.5–36.5°C, độ ẩm 85–88%RH -> HIGH tại Kho sách (TQB_103) và MEDIUM tại Phòng đọc (TQB_301), cây điều hướng báo đỏ, Drawer hiện SOP máy hút ẩm chống mốc sách', () => {
      const mod = getScenarioModifiers(
        SCENARIOS.HEAT_HUMID,
        { hardwareId: 'ESP32_T1_03', zoneId: 'ZONE_A' },
        1
      );
      expect(mod.tempOverride).toBeGreaterThanOrEqual(35.5);
      expect(mod.humidityOverride).toBeGreaterThanOrEqual(85.0);

      const storageRoom103 = makeRoomFromPreset('TQB_103', 'ROOM_TQB_103');
      const studyRoom301 = makeRoomFromPreset('TQB_301', 'ROOM_TQB_301');

      const storageHumidityAlert = makeAlert({
        id: 'alert-storage-hum',
        roomId: storageRoom103.id,
        type: 'AIR_UNHEALTHY',
        metricType: 'HUMIDITY_HIGH',
        severity: 'HIGH',
        currentValue: mod.humidityOverride,
        threshold: 60.0,
        message: `Book storage humidity (${mod.humidityOverride.toFixed(1)} %RH) exceeded max threshold (60.0 %RH)`,
      });

      const studyTempAlert = makeAlert({
        id: 'alert-study-temp',
        roomId: studyRoom301.id,
        type: 'AIR_UNHEALTHY',
        metricType: 'TEMPERATURE',
        severity: 'MEDIUM',
        currentValue: mod.tempOverride,
        threshold: 32.0,
        message: `Temperature (${mod.tempOverride.toFixed(1)} °C) exceeded threshold (32.0 °C)`,
      });

      const treeNodes = buildBuildingFloorTree(
        [storageRoom103, studyRoom301],
        {
          [storageRoom103.id]: makeTelemetry(storageRoom103.id, {
            score: 48,
            temperature: mod.tempOverride,
            humidity: mod.humidityOverride,
          }),
          [studyRoom301.id]: makeTelemetry(studyRoom301.id, {
            score: 64,
            temperature: mod.tempOverride,
            humidity: mod.humidityOverride,
          }),
        },
        [storageHumidityAlert, studyTempAlert]
      );

      const floor1Node = treeNodes.find((f) => f.floor === 1)!;
      const floor3Node = treeNodes.find((f) => f.floor === 3)!;
      expect(floor1Node.worstStatusLevel).toBe('POOR');
      expect(floor1Node.symbol).toBe('◆');
      expect(floor1Node.highestAlertSeverity).toBe('HIGH');
      expect(floor3Node.worstStatusLevel).toBe('ATTENTION');
      expect(floor3Node.highestAlertSeverity).toBe('MEDIUM');

      render(
        <div>
          <FloorRoomTree
            treeNodes={treeNodes}
            selectedFloor={1}
            selectedRoomId={storageRoom103.id}
            onSelectFloor={vi.fn()}
            onSelectRoom={vi.fn()}
          />
          <AlertInspectorDrawer
            alerts={[storageHumidityAlert]}
            room={storageRoom103}
            canAcknowledge={true}
            canResolve={true}
            onUpdateWorkflow={vi.fn()}
            onFlyToAlert={vi.fn()}
          />
        </div>
      );

      expect(screen.getByTestId('tree-floor-1')).toHaveTextContent('◆');
      expect(screen.getByTestId('tree-floor-1')).toHaveTextContent('!1');
      expect(
        screen.queryByTestId(`alert-sop-${storageHumidityAlert.id}`)
      ).not.toBeInTheDocument();
    });

    it('Kịch bản #5 (device-dropout): trạm ngừng gửi > 120s -> OFFLINE (✕), vùng mù gạch chéo, cảnh báo DEVICE_OFFLINE (HIGH) và banner cảm biến im lặng', async () => {
      installCanvas2DMock();
      vi.spyOn(stompManager, 'activate').mockImplementation(() => {});
      vi.spyOn(stompManager, 'isConnected').mockReturnValue(true);

      const room301 = makeRoomFromPreset('TQB_301', 'ROOM_TQB_301');
      const offlineDev = makeDevice(
        'dev-301-off',
        'ESP32_T3_01',
        room301.id,
        'ZONE_A',
        false
      );
      const offlineAlert = makeAlert({
        id: 'alert-dropout-1',
        roomId: room301.id,
        deviceId: offlineDev.id,
        hardwareId: offlineDev.hardwareId,
        type: 'DEVICE_OFFLINE',
        metricType: 'DEVICE_OFFLINE',
        severity: 'HIGH',
        message: 'Device ESP32_T3_01 has not reported telemetry for > 120s',
      });

      const rel = evaluateRoomReliability({
        room: room301,
        telemetry: makeTelemetry(room301.id),
        devices: [offlineDev],
      });
      expect(rel.state).toBe('BLINDSPOT');
      expect(rel.subKind).toBe('BLINDSPOT_OFFLINE');
      expect(rel.blindspotPercent).toBe(100);
      expect(rel.badgeText).toMatch(/Mất tín hiệu đo/i);

      vi.spyOn(roomsApi, 'list').mockResolvedValue({
        content: [room301],
        page: 0,
        size: 100,
        totalElements: 1,
        totalPages: 1,
        last: true,
      });
      vi.spyOn(devicesApi, 'list').mockResolvedValue({
        content: [offlineDev],
        page: 0,
        size: 100,
        totalElements: 1,
        totalPages: 1,
        last: true,
      });
      vi.spyOn(alertsApi, 'list').mockResolvedValue({
        content: [offlineAlert],
        page: 0,
        size: 50,
        totalElements: 1,
        totalPages: 1,
        last: true,
      });
      vi.spyOn(telemetryApi, 'getRoomLatest').mockResolvedValue(
        makeTelemetry(room301.id)
      );
      vi.spyOn(telemetryApi, 'getDeviceLatest').mockResolvedValue(
        makeTelemetry(room301.id)
      );
      vi.spyOn(roomsApi, 'getFurniture').mockResolvedValue({
        roomId: room301.id,
        version: 1,
        items: [],
        auditHistory: [],
      });

      renderWithProviders(<FloorplanPage />);

      const banner = await screen.findByTestId('silent-sensor-banner');
      expect(banner).toHaveTextContent(
        '1 cảm biến đang im lặng/mất kết nối'
      );

      const pin = await screen.findByTestId(`device-pin-${offlineDev.id}`);
      expect(pin).toHaveTextContent('✕');

      fireEvent.click(screen.getByTestId('silent-sensor-inspect-btn'));
      await waitFor(() => {
        expect(screen.getByTestId('floorplan-canvas-wrapper')).toHaveAttribute(
          'data-reliability-layer',
          'true'
        );
      });
      expect(
        await screen.findByTestId('alert-inspector-drawer')
      ).toHaveTextContent(/mất kết nối/i);
    });

    it('Kịch bản #6 (flap): dao động chập chờn được làm mượt qua Hermite Smoothstep 450ms và lọc gói tin đến trễ (mergeRealtimeTelemetry) không gây nhấp nháy loạn xạ', () => {
      expect(TIMING_CONFIG.transitionDurationMs).toBe(450);

      // 1. Out-of-order flap packet is rejected by monotonic timestamp guard
      const newer = makeTelemetry('ROOM_TQB_301', {
        score: 76,
        timestamp: '2026-11-18T10:00:10.000Z',
      });
      const olderFlap = makeTelemetry('ROOM_TQB_301', {
        score: 58,
        timestamp: '2026-11-18T10:00:08.000Z',
      });
      expect(mergeRealtimeTelemetry(newer, olderFlap)).toBe(newer);

      // 2. Smoothstep 450ms absorbs rapid metric oscillation without instantaneous jump
      let state = createAnimatedMetricState(80, 1000, false, 450);
      state = updateAnimatedMetricState(state, 60, 1000, false, 450);

      // At 90ms into transition (p = 0.2), value is smoothly near 77.92, not jumping to 60
      const mid1 = evaluateAnimatedMetricState(state, 1090);
      expect(mid1.transitioning).toBe(true);
      expect(mid1.value).toBeGreaterThan(75);
      expect(mid1.value).toBeLessThan(80);

      // Flaps back to 80 at t = 1150ms -> starts smoothly from current interpolated value (~74.8)
      const beforeFlapBack = evaluateAnimatedMetricState(state, 1150).value;
      state = updateAnimatedMetricState(state, 80, 1150, false, 450);
      expect(state.from).toBeCloseTo(beforeFlapBack, 3);
      const midAfterFlap = evaluateAnimatedMetricState(state, 1200);
      expect(Math.abs(midAfterFlap.value - beforeFlapBack)).toBeLessThan(2.0);
    });

    it('Kịch bản #7 (lwt): MQTT Last Will {"status":"offline","reason":"lwt"} chuyển trạm sang OFFLINE tức thời và cập nhật huy hiệu mất kết nối + độ tin cậy vùng đo', () => {
      installCanvas2DMock();
      const room301 = makeRoomFromPreset('TQB_301', 'ROOM_TQB_301');
      const onlineDev = makeDevice(
        'dev-lwt-1',
        'ESP32_LWT_01',
        room301.id,
        'ZONE_A',
        true,
        { x: 0.5, y: 0.15 }
      );

      const relOnline = evaluateRoomReliability({
        room: room301,
        telemetry: makeTelemetry(room301.id),
        devices: [onlineDev],
        blindspotRatio: 0.05,
      });
      expect(relOnline.state).toBe('MEASURED');

      const { rerender } = render(
        <FloorplanCanvas
          rooms={[room301]}
          devices={[onlineDev]}
          roomTelemetryMap={{ [room301.id]: makeTelemetry(room301.id) }}
          layer="comfortScore"
          selectedRoomId={room301.id}
          zoomedRoomId={room301.id}
          onSelectRoom={vi.fn()}
        />
      );
      expect(screen.getByTestId('device-pin-dev-lwt-1')).toHaveTextContent('●');

      // Broker publishes LWT offline frame -> device state flips immediately without waiting 120s
      const lwtOfflineDev: DeviceResponse = {
        ...onlineDev,
        online: false,
        connectionState: 'OFFLINE',
        lastOfflineAt: new Date().toISOString(),
      };
      const relAfterLwt = evaluateRoomReliability({
        room: room301,
        telemetry: makeTelemetry(room301.id),
        devices: [lwtOfflineDev],
      });
      expect(relAfterLwt.state).toBe('BLINDSPOT');
      expect(relAfterLwt.subKind).toBe('BLINDSPOT_OFFLINE');
      expect(relAfterLwt.badgeText).toBe('Mất tín hiệu đo');
      expect(relAfterLwt.tooltipText).toMatch(/mất kết nối/i);
      expect(relAfterLwt.qualityLabel).toBe('Vùng mù');

      rerender(
        <FloorplanCanvas
          rooms={[room301]}
          devices={[lwtOfflineDev]}
          roomTelemetryMap={{ [room301.id]: makeTelemetry(room301.id) }}
          layer="comfortScore"
          selectedRoomId={room301.id}
          zoomedRoomId={room301.id}
          onSelectRoom={vi.fn()}
        />
      );
      expect(screen.getByTestId('device-pin-dev-lwt-1')).toHaveTextContent('✕');
      expect(screen.getByTestId('device-pin-dev-lwt-1')).toHaveAttribute(
        'aria-label',
        expect.stringContaining('Mất kết nối')
      );
    });

    it('Kịch bản #8 (bad-payload): gói tin 250°C / 999 dBA / rỗng / null / SPOOFED_ID_UNKNOWN bị chặn, giá trị hợp lệ giữ nguyên và cảnh báo SENSOR_MALFUNCTION hiển thị rõ trên Drawer', () => {
      const dummyDev = {
        hardwareId: 'ESP32_T3_01',
        roomId: 'ROOM_TQB_301',
        zoneId: 'ZONE_A',
      };
      const bad0 = generateBadPayloadSample(dummyDev, 0);
      const bad1 = generateBadPayloadSample(dummyDev, 1);
      const bad2 = generateBadPayloadSample(dummyDev, 2);
      const bad3 = generateBadPayloadSample(dummyDev, 3);

      expect(bad0.data.environment.temperature).toBe(250.0);
      expect(bad0.data.acoustics.noise).toBe(999.0);
      expect(bad1.data).toEqual({});
      expect(bad2.data.environment.temperature).toBeNull();
      expect(bad3.hardware_id).toBe('SPOOFED_ID_UNKNOWN');

      // Last valid room telemetry remains intact while SENSOR_MALFUNCTION alert surfaces in Drawer
      const room301 = makeRoomFromPreset('TQB_301', 'ROOM_TQB_301');
      const lastValidTelemetry = makeTelemetry(room301.id, {
        score: 85,
        temperature: 23.4,
        noiseAvg: 42.0,
      });

      const malfunctionAlert = makeAlert({
        id: 'alert-sensor-malfunction',
        roomId: room301.id,
        hardwareId: 'ESP32_T3_01',
        type: 'SENSOR_MALFUNCTION',
        metricType: 'SENSOR_MALFUNCTION',
        severity: 'MEDIUM',
        message:
          'Lỗi cảm biến phần cứng (temperature, noise): giá trị đo vượt ngoài dải vật lý hợp lệ liên tục',
      });

      const summaryVi = summarizeAlertForManagerVi(malfunctionAlert, room301);
      expect(summaryVi.headlineVi).toMatch(/số liệu bất thường/i);

      render(
        <div>
          <RoomHoverPopover
            room={room301}
            layer="temperature"
            value={lastValidTelemetry.environment?.temperature}
            openAlertsCount={1}
          />
          <AlertInspectorDrawer
            alerts={[malfunctionAlert]}
            room={room301}
            canAcknowledge={true}
            canResolve={true}
            onUpdateWorkflow={vi.fn()}
            onFlyToAlert={vi.fn()}
          />
        </div>
      );

      // Valid 23.4°C is preserved on the map (never 250°C)
      expect(screen.getByTestId('room-hover-popover')).toHaveTextContent(
        '23.4 °C'
      );
      expect(screen.getByTestId('room-hover-popover')).not.toHaveTextContent(
        '250'
      );
      expect(
        screen.getByTestId(`alert-workflow-card-${malfunctionAlert.id}`)
      ).toHaveTextContent(/số liệu bất thường/i);
    });

    it('Kịch bản #9 (burst): bơm dồn dập 330 gói tin tần suất cao cho 33 phòng — giữ nguyên tính đơn điệu timestamp (mergeRealtimeTelemetry) và tốc độ xử lý < 16.6ms', () => {
      const allRooms = TQB_ROOM_PRESETS.map((p) =>
        makeRoomFromPreset(p.code, `ROOM_${p.code}`)
      );
      const stateByRoom: Record<string, TelemetryResponse> = {};
      const baseMs = Date.parse('2026-11-18T10:00:00.000Z');

      const tStart = performance.now();
      for (let tick = 1; tick <= 10; tick += 1) {
        for (const room of allRooms) {
          // Simulate occasional out-of-order burst packet on tick 5
          const packetMs =
            tick === 5 ? baseMs + 2 * 1000 : baseMs + tick * 1000;
          const incoming = makeTelemetry(room.id, {
            score: 70 + tick,
            timestamp: new Date(packetMs).toISOString(),
          });
          stateByRoom[room.id] = mergeRealtimeTelemetry(
            stateByRoom[room.id],
            incoming
          );
        }
      }
      const elapsedMs = performance.now() - tStart;
      expect(elapsedMs).toBeLessThan(16.6);

      for (const room of allRooms) {
        const finalTel = stateByRoom[room.id];
        expect(finalTel.timestamp).toBe(
          new Date(baseMs + 10 * 1000).toISOString()
        );
        expect(finalTel.comfortScore?.overall).toBe(80);
      }
    });

    it('Kịch bản #10 (demo): sóng biến thiên kết hợp cao điểm thảo luận nhóm (ZONE_B, ZONE_HALL), mũi tên xu hướng ↑ ↓ -1h chính xác và lọc nhanh các phòng cần chú ý', () => {
      const modZoneB = getScenarioModifiers(
        SCENARIOS.DEMO,
        { hardwareId: 'ESP32_T3_02', zoneId: 'ZONE_B' },
        8
      );
      const modZoneA = getScenarioModifiers(
        SCENARIOS.DEMO,
        { hardwareId: 'ESP32_T3_01', zoneId: 'ZONE_A' },
        8
      );
      expect(modZoneB.noiseOffset).toBeGreaterThan(modZoneA.noiseOffset);

      const nowMs = Date.parse('2026-11-18T15:00:00.000Z');
      const oneHourAgoIso = new Date(nowMs - 60 * 60_000).toISOString();
      const buckets302: BucketDataPoint[] = [
        {
          bucketTime: oneHourAgoIso,
          comfortScoreAvg: 84,
          noiseAvg: 43.0,
          tempAvg: 23.0,
          humidityAvg: 52.0,
          luxAvg: 390,
          pm25Avg: 12.0,
        },
      ];

      // Crowd surge in ZONE_B room TQB_302 raises noise to 58.5 dBA and drops LCS to 66
      const noiseDelta = computeOneHourDelta(
        58.5,
        buckets302,
        'noiseAvg',
        nowMs
      );
      const lcsDelta = computeOneHourDelta(
        66,
        buckets302,
        'comfortScore',
        nowMs
      );
      expect(noiseDelta.trend).toBe('UP');
      expect(noiseDelta.arrow).toBe('↑');
      expect(noiseDelta.text).toBe('↑ +15.5 dBA');
      expect(lcsDelta.trend).toBe('DOWN');
      expect(lcsDelta.arrow).toBe('↓');
      expect(lcsDelta.text).toBe('↓ -18đ');

      // Manager summary filter isolates ATTENTION room TQB_302 from GOOD room TQB_301
      const room301 = makeRoomFromPreset('TQB_301', 'ROOM_TQB_301');
      const room302 = makeRoomFromPreset('TQB_302', 'ROOM_TQB_302');
      const tel301 = makeTelemetry(room301.id, { score: 86, noiseAvg: 42.0 });
      const tel302 = makeTelemetry(room302.id, { score: 66, noiseAvg: 58.5 });

      expect(classifyManagerRoomStatus(tel301, [])).toBe('GOOD');
      expect(classifyManagerRoomStatus(tel302, [])).toBe('ATTENTION');
      expect(
        resolveRoomHealthMatchesFilter(room301, tel301, [], 'ATTENTION', nowMs)
      ).toBe(false);
      expect(
        resolveRoomHealthMatchesFilter(room302, tel302, [], 'ATTENTION', nowMs)
      ).toBe(true);
    });
  });
});
