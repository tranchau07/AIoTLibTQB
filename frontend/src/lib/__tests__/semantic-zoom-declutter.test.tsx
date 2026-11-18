import React from 'react';
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TQB_ROOM_PRESETS,
  getFloorRoomPresets,
} from '@/config/tqb-floorplan-presets';
import { FloorplanCanvas } from '@/features/floorplan/components/FloorplanCanvas';
import { clusterDeviceNodes } from '@/lib/floorplan/clustering';
import {
  boxesOverlap,
  computeLabelPlacements,
  computeRoomLabelPriority,
  computeScaledFontSizePx,
  computeScaledNodeSizePx,
  getLodConfig,
  makeLabelBox,
  type LabelRequest,
} from '@/lib/floorplan/labelLayout';
import { computeVisualPolygonCenter } from '@/lib/floorplan/polygon';
import { computePopoverPlacement } from '@/lib/floorplan/popoverPosition';
import type {
  DeviceResponse,
  Point2D,
  RoomResponse,
  TelemetryResponse,
} from '@/types/api';

function installCanvas2DMock() {
  return vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockImplementation(function (this: HTMLCanvasElement, contextId: string) {
      if (contextId !== '2d') return null;
      const ctx = {
        canvas: this,
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
        imageSmoothingEnabled: true,
        imageSmoothingQuality: 'high' as ImageSmoothingQuality,
        globalAlpha: 1,
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
        measureText: vi.fn((text: string) => ({ width: text.length * 6.4 })),
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
}

function makeRoom(code: string): RoomResponse {
  const preset = TQB_ROOM_PRESETS.find((p) => p.code === code)!;
  return {
    id: `PRESET_${preset.code}`,
    code: preset.code,
    name: preset.name,
    floor: preset.floor,
    capacity: preset.capacity,
    type: preset.roomType,
    targetComfortScore: 85,
    boundaryPolygon: [...preset.boundaryPolygon],
  };
}

function makeDevice(
  id: string,
  roomId: string,
  posX: number,
  posY: number,
  online = true
): DeviceResponse {
  return {
    id,
    hardwareId: `ESP32_${id.toUpperCase()}`,
    name: `Trạm ${id}`,
    roomId,
    zoneId: 'ZONE_A',
    deviceType: 'ENV_NODE',
    active: true,
    connectionState: online ? 'ONLINE' : 'OFFLINE',
    online,
    posX,
    posY,
    lastSeenAt: new Date().toISOString(),
    lastOfflineAt: null,
  };
}

function makeTelemetry(roomId: string, score = 84): TelemetryResponse {
  return {
    id: `tel-${roomId}`,
    timestamp: new Date().toISOString(),
    metadata: {
      deviceId: `dev-${roomId}`,
      hardwareId: `ESP32_${roomId}`,
      roomId,
    },
    environment: { temperature: 23.2, humidity: 52.0, lux: 380 },
    acoustics: { noiseAvg: 41.0, noisePeak: 47.0 },
    airQuality: { pm1_0: 8.0, pm2_5: 12.0, pm4_0: 14.0, pm10: 18.0 },
    wifiRssi: -56,
    comfortScore: {
      overall: score,
      grade: 'Gold',
      acousticScore: score,
      airScore: score,
      thermalScore: score,
      lightScore: score,
    },
  };
}

describe('Giai đoạn 5: Semantic Zoom 3 Cấp, Chống Đè Nhãn Ưu Tiên Cảnh Báo, Clustering Node & Vùng Chạm >= 44x44px', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('TC-G5-01: Ưu tiên đặt nhãn cho phòng có cảnh báo CRITICAL khi sát phòng lớn bình thường', () => {
    const bigNormalPoly: Point2D[] = [
      { x: 100, y: 100 },
      { x: 420, y: 100 },
      { x: 420, y: 340 },
      { x: 100, y: 340 },
    ];
    const smallAlertPoly: Point2D[] = [
      { x: 170, y: 150 },
      { x: 350, y: 150 },
      { x: 350, y: 290 },
      { x: 170, y: 290 },
    ];

    const requests: LabelRequest[] = [
      {
        id: 'room-big-normal',
        anchor: { x: 250, y: 220 },
        width: 96,
        height: 28,
        polygon: bigNormalPoly,
        priority: computeRoomLabelPriority({ areaM2: 300 }),
        style: 'rich',
        fallbackTiers: [
          { style: 'pill', width: 78, height: 20 },
          { style: 'code', width: 46, height: 16 },
        ],
      },
      {
        id: 'room-small-critical',
        anchor: { x: 260, y: 220 },
        width: 96,
        height: 28,
        polygon: smallAlertPoly,
        priority: computeRoomLabelPriority({
          alertSeverity: 'CRITICAL',
          hasAlert: true,
          areaM2: 40,
        }),
        style: 'rich',
        fallbackTiers: [
          { style: 'pill', width: 78, height: 20 },
          { style: 'code', width: 46, height: 16 },
        ],
      },
    ];

    const placements = computeLabelPlacements(requests, [], {
      width: 960,
      height: 722,
    });
    const bigPlacement = placements[0];
    const critPlacement = placements[1];

    expect(critPlacement.visible).toBe(true);
    expect(critPlacement.x).toBe(260);
    expect(critPlacement.y).toBe(220);
    expect(critPlacement.placedStyle).toBe('rich');

    if (bigPlacement.visible) {
      const shiftedOrDowngraded =
        bigPlacement.x !== 250 ||
        bigPlacement.y !== 220 ||
        bigPlacement.placedStyle !== 'rich';
      expect(shiftedOrDowngraded).toBe(true);
      const boxBig = makeLabelBox(
        bigPlacement.x,
        bigPlacement.y,
        bigPlacement.width ?? 96,
        bigPlacement.height ?? 28
      );
      const boxCrit = makeLabelBox(
        critPlacement.x,
        critPlacement.y,
        critPlacement.width ?? 96,
        critPlacement.height ?? 28
      );
      expect(boxesOverlap(boxBig, boxCrit, 0)).toBe(false);
    }
  });

  it('TC-G5-02: Không đè nhãn trên toàn bộ 33 phòng của 5 tầng ở 1366x768 & 1920x1080 tại zoom 1.0, 1.5, 2.2', () => {
    expect(TQB_ROOM_PRESETS.length).toBeGreaterThanOrEqual(33);

    const viewports = [
      { width: 1366, height: 768 },
      { width: 1920, height: 1080 },
    ];
    const scales = [1.0, 1.5, 2.2];

    for (const vp of viewports) {
      for (const scale of scales) {
        const lod = getLodConfig('balanced', scale);
        for (const floor of [1, 2, 3, 4, 5]) {
          const presets = getFloorRoomPresets(floor);
          const requests: LabelRequest[] = presets.map((preset) => {
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
              priority: computeRoomLabelPriority({ areaM2: preset.areaM2 }),
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
                `Overlap between ${visible[i].p.id} and ${visible[j].p.id} on floor ${floor} (${vp.width}x${vp.height} @ ${scale}x)`
              ).toBe(false);
            }
          }
        }
      }
    }
  });

  it('TC-G5-03: Hạ cấp nhãn 3 bước (rich -> pill -> code) cho cụm 8 phòng nhóm nhỏ Tầng 5', () => {
    const floor5GroupCodes = [
      'TQB_506',
      'TQB_507',
      'TQB_508',
      'TQB_509',
      'TQB_510',
      'TQB_511',
      'TQB_512',
      'TQB_513',
    ];
    const presets = getFloorRoomPresets(5).filter((p) =>
      floor5GroupCodes.includes(p.code)
    );
    expect(presets).toHaveLength(8);

    const width = 960;
    const height = 722;
    const requests: LabelRequest[] = presets.map((preset) => {
      const screenPolygon = preset.boundaryPolygon.map((pt) => ({
        x: pt.x * width,
        y: pt.y * height,
      }));
      const centroid = computeVisualPolygonCenter(preset.boundaryPolygon);
      return {
        id: preset.code,
        anchor: { x: centroid.x * width, y: centroid.y * height },
        width: 112,
        height: 36,
        polygon: screenPolygon,
        priority: computeRoomLabelPriority({ areaM2: preset.areaM2 }),
        style: 'rich',
        fallbackTiers: [
          { style: 'pill', width: 74, height: 20 },
          { style: 'code', width: 42, height: 16 },
        ],
      };
    });

    const placements = computeLabelPlacements(requests, [], { width, height });
    const downgradedCount = placements.filter(
      (p) => p.visible && (p.placedStyle === 'pill' || p.placedStyle === 'code')
    ).length;

    expect(placements.every((p) => p.visible)).toBe(true);
    expect(downgradedCount).toBeGreaterThan(0);

    for (let i = 0; i < placements.length; i += 1) {
      for (let j = i + 1; j < placements.length; j += 1) {
        const boxA = makeLabelBox(
          placements[i].x,
          placements[i].y,
          placements[i].width ?? 42,
          placements[i].height ?? 16
        );
        const boxB = makeLabelBox(
          placements[j].x,
          placements[j].y,
          placements[j].width ?? 42,
          placements[j].height ?? 16
        );
        expect(boxesOverlap(boxA, boxB, 0)).toBe(false);
      }
    }
  });

  it('TC-G5-04: Semantic Zoom 3 cấp đổi chi tiết hiển thị theo scale (1.0 -> 1.45 -> 2.1)', () => {
    const overview = getLodConfig('balanced', 1.0);
    expect(overview.zoomLevel).toBe('overview');
    expect(overview.roomLabel).toBe('code');
    expect(overview.showFurniture).toBe(false);
    expect(overview.showSensorBadge).toBe(false);
    expect(overview.clusterSensors).toBe(true);

    const intermediate = getLodConfig('balanced', 1.45);
    expect(intermediate.zoomLevel).toBe('intermediate');
    expect(intermediate.roomLabel).toBe('pill');
    expect(intermediate.showSensors).toBe(true);
    expect(intermediate.showSensorBadge).toBe(true);
    expect(intermediate.showFurniture).toBe(true);
    expect(intermediate.showDetailedFurniture).toBe(false);

    const detail = getLodConfig('balanced', 2.1);
    expect(detail.zoomLevel).toBe('detail');
    expect(detail.roomLabel).toBe('rich');
    expect(detail.showSensorBadge).toBe(true);
    expect(detail.showFurniture).toBe(true);
    expect(detail.showDetailedFurniture).toBe(true);
    expect(detail.bayStyle).toBe('pill');
    expect(detail.clusterSensors).toBe(false);
  });

  it('TC-G5-05: Cỡ chữ [10px, 14px] và kích thước hiển thị node [10px, 32px] co giãn có min/max', () => {
    for (const s of [0.5, 1.0, 1.45, 2.5, 4.0, 8.0]) {
      const font = computeScaledFontSizePx(s);
      const node = computeScaledNodeSizePx(s, 'balanced');
      const lod = getLodConfig('balanced', s);
      expect(font).toBeGreaterThanOrEqual(10);
      expect(font).toBeLessThanOrEqual(14);
      expect(node).toBeGreaterThanOrEqual(10);
      expect(node).toBeLessThanOrEqual(32);
      expect(lod.fontSizePx).toBeGreaterThanOrEqual(10);
      expect(lod.fontSizePx).toBeLessThanOrEqual(14);
      expect(lod.nodeVisualSizePx).toBeGreaterThanOrEqual(10);
      expect(lod.nodeVisualSizePx).toBeLessThanOrEqual(32);
    }

    installCanvas2DMock();
    const room = makeRoom('TQB_302');
    const devices = [makeDevice('d1', room.id, 0.5, 0.5)];
    render(
      <FloorplanCanvas
        rooms={[room]}
        devices={devices}
        roomTelemetryMap={{ [room.id]: makeTelemetry(room.id) }}
        layer="comfortScore"
        selectedRoomId={null}
        onSelectRoom={vi.fn()}
        viewport={{ scale: 4.0, tx: -1440, ty: -1084 }}
      />
    );

    const visual = screen.getByTestId('device-visual-d1');
    const renderedSize = Number(visual.getAttribute('data-visual-size'));
    expect(renderedSize).toBeGreaterThanOrEqual(10);
    expect(renderedSize).toBeLessThanOrEqual(32);
  });

  it('TC-G5-06: clusterDeviceNodes gom 3 node gần nhau ở scale = 1.0 và tách thành 3 node ở scale = 2.2', () => {
    const devices = [
      makeDevice('d1', 'ROOM_301', 0.25, 0.5),
      makeDevice('d2', 'ROOM_301', 0.265, 0.5),
      makeDevice('d3', 'ROOM_301', 0.255, 0.515),
    ];

    const clustered = clusterDeviceNodes(
      devices.map((device, idx) => ({
        device,
        severity: idx === 1 ? 'CRITICAL' : null,
      })),
      1.0,
      { canvasWidth: 960, canvasHeight: 722 }
    );
    expect(clustered).toHaveLength(1);
    expect(clustered[0].isCluster).toBe(true);
    expect(clustered[0].count).toBe(3);
    expect(clustered[0].highestSeverity).toBe('CRITICAL');

    const expanded = clusterDeviceNodes(
      devices.map((device) => ({ device })),
      2.2,
      { canvasWidth: 960, canvasHeight: 722 }
    );
    expect(expanded).toHaveLength(3);
    expect(expanded.every((c) => !c.isCluster && c.count === 1)).toBe(true);
  });

  it('TC-G5-07: Click vào Cluster Badge "3" tự động phóng to >= 1.85 và tách thành 3 chân pin riêng', () => {
    installCanvas2DMock();
    const room = makeRoom('TQB_302');
    const devices = [
      makeDevice('c1', room.id, 0.5, 0.45),
      makeDevice('c2', room.id, 0.512, 0.455),
      makeDevice('c3', room.id, 0.506, 0.465),
    ];

    render(
      <FloorplanCanvas
        rooms={[room]}
        devices={devices}
        roomTelemetryMap={{ [room.id]: makeTelemetry(room.id) }}
        layer="comfortScore"
        selectedRoomId={null}
        onSelectRoom={vi.fn()}
      />
    );

    const wrapper = screen.getByTestId('floorplan-canvas-wrapper');
    expect(Number(wrapper.getAttribute('data-scale'))).toBeCloseTo(1.0, 2);

    const clusterBtn = screen
      .getAllByTestId(/^device-cluster-/)
      .find((el) => el.textContent?.includes('3'));
    expect(clusterBtn).toBeTruthy();

    fireEvent.click(clusterBtn!);

    expect(Number(wrapper.getAttribute('data-scale'))).toBeGreaterThanOrEqual(
      1.85
    );
    expect(screen.queryAllByTestId(/^device-cluster-/)).toHaveLength(0);
    expect(screen.getAllByTestId(/^device-pin-/)).toHaveLength(3);
  });

  it('TC-G5-08: 100% nút tương tác trong các overlay bản đồ có vùng chạm >= 44x44 px', () => {
    installCanvas2DMock();
    const room = makeRoom('TQB_302');
    const devices = [
      makeDevice('solo', room.id, 0.35, 0.35),
      makeDevice('grp1', room.id, 0.65, 0.65),
      makeDevice('grp2', room.id, 0.66, 0.655),
    ];

    render(
      <FloorplanCanvas
        rooms={[room]}
        devices={devices}
        roomTelemetryMap={{ [room.id]: makeTelemetry(room.id) }}
        layer="comfortScore"
        selectedRoomId={room.id}
        onSelectRoom={vi.fn()}
        defaultLabelDensity="detailed"
        firingRoomIds={[room.id]}
        roomAlertCounts={{ [room.id]: 2 }}
        roomAlertSeverities={{ [room.id]: 'CRITICAL' }}
      />
    );

    const layers = [
      screen.getByTestId('reading-bays-layer'),
      screen.getByTestId('device-pins-layer'),
      screen.getByTestId('room-alert-badges-layer'),
    ];
    const buttons = layers.flatMap((layerEl) =>
      Array.from(layerEl.querySelectorAll('button'))
    );
    expect(buttons.length).toBeGreaterThan(0);

    for (const btn of buttons) {
      expect(btn.className).toContain('min-w-[44px]');
      expect(btn.className).toContain('min-h-[44px]');
    }
  });

  it('TC-G5-09: Tooltip tự lật hướng khi node nằm sát 4 mép bản đồ & nằm trọn trong viewport', () => {
    const viewport = { width: 960, height: 722 };
    const popoverSize = { width: 224, height: 180 };

    const nw = computePopoverPlacement({ x: 15, y: 12 }, popoverSize, viewport);
    expect(nw.placement).toBe('bottom');
    expect(nw.align).toBe('start');
    expect(nw.left).toBeGreaterThanOrEqual(8);
    expect(nw.top).toBeGreaterThanOrEqual(8);
    expect(nw.left + popoverSize.width).toBeLessThanOrEqual(viewport.width - 8);
    expect(nw.top + popoverSize.height).toBeLessThanOrEqual(
      viewport.height - 8
    );

    const se = computePopoverPlacement(
      { x: 945, y: 710 },
      popoverSize,
      viewport
    );
    expect(se.placement).toBe('top');
    expect(se.align).toBe('end');
    expect(se.left).toBeGreaterThanOrEqual(8);
    expect(se.top).toBeGreaterThanOrEqual(8);
    expect(se.left + popoverSize.width).toBeLessThanOrEqual(viewport.width - 8);
    expect(se.top + popoverSize.height).toBeLessThanOrEqual(
      viewport.height - 8
    );

    // Kiểm chứng DOM attribute data-placement & data-align khi focus node sát mép Bắc-Tây
    installCanvas2DMock();
    const room = makeRoom('TQB_302');
    const edgeDevice = makeDevice('edge-nw', room.id, 0.02, 0.02);
    render(
      <FloorplanCanvas
        rooms={[room]}
        devices={[edgeDevice]}
        roomTelemetryMap={{ [room.id]: makeTelemetry(room.id) }}
        layer="comfortScore"
        selectedRoomId={null}
        onSelectRoom={vi.fn()}
      />
    );

    const edgePin = screen.getByTestId('device-pin-edge-nw');
    fireEvent.mouseEnter(edgePin);

    const tooltip = screen.getByTestId('device-hover-tooltip');
    expect(tooltip.getAttribute('data-placement')).toBe('bottom');
    expect(tooltip.getAttribute('data-align')).toBe('start');
  });
});
