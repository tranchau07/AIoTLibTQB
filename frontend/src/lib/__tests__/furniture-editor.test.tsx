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
import KioskLobbyPage from '@/app/kiosk/page';
import { ToastProvider } from '@/components/ui/primitives';
import {
  FURNITURE_CATALOG,
  type FurnitureCatalogEntry,
} from '@/config/furniture-catalog';
import { TQB_ROOM_PRESETS } from '@/config/tqb-floorplan-presets';
import { alertsApi } from '@/features/alerts/api';
import { useAuthStore } from '@/features/auth/store';
import { devicesApi } from '@/features/devices/api';
import { FloorplanCanvas } from '@/features/floorplan/components/FloorplanCanvas';
import { FurnitureLayerEditor } from '@/features/floorplan/components/FurnitureLayerEditor';
import { roomsApi } from '@/features/rooms/api';
import { telemetryApi } from '@/features/telemetry/api';
import {
  alignFurnitureItems,
  clampFurnitureDimensions,
  createFurnitureHistory,
  doFurnitureItemsOverlap,
  doesFurnitureOverlapColumn,
  duplicateFurnitureItemsSmartly,
  furnitureMetersToPixelSize,
  isFurnitureInsideRoom,
  pushFurnitureHistory,
  redoFurnitureHistory,
  snapToGridMeters,
  undoFurnitureHistory,
  validateFurnitureLayout,
} from '@/lib/floorplan/furnitureGeometry';
import { ApiError } from '@/lib/http/error-mapper';
import { buildCapabilities } from '@/lib/rbac/capabilities';
import { parseScopeString } from '@/lib/rbac/scope-parser';
import { stompManager } from '@/lib/realtime/stomp-client';
import type {
  FurnitureItem,
  Point2D,
  RoomFurnitureResponse,
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
  clearRectCalls: number;
  putImageDataCalls: number;
  drawImageCalls: number;
  fillCalls: number;
  strokeCalls: number;
  fillTextArgs: string[];
  alphaHistory: number[];
  lastPutImageData: Uint8ClampedArray | null;
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
        'offscreen-canvas';
      let stats = statsByCanvas.get(key);
      if (!stats) {
        stats = {
          clearRectCalls: 0,
          putImageDataCalls: 0,
          drawImageCalls: 0,
          fillCalls: 0,
          strokeCalls: 0,
          fillTextArgs: [],
          alphaHistory: [],
          lastPutImageData: null,
        };
        statsByCanvas.set(key, stats);
      }
      const capturedStats = stats;
      let currentAlpha = 1;
      let currentFill = '#000000';
      let currentStroke = '#000000';
      let currentLineWidth = 1;
      const stateStack: Array<{
        globalAlpha: number;
        fillStyle: string;
        strokeStyle: string;
        lineWidth: number;
      }> = [];

      const ctx = {
        canvas: this,
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
          capturedStats.alphaHistory.push(val);
        },
        get fillStyle() {
          return currentFill;
        },
        set fillStyle(val: string | CanvasGradient | CanvasPattern) {
          currentFill = String(val);
        },
        get strokeStyle() {
          return currentStroke;
        },
        set strokeStyle(val: string | CanvasGradient | CanvasPattern) {
          currentStroke = String(val);
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
            fillStyle: currentFill,
            strokeStyle: currentStroke,
            lineWidth: currentLineWidth,
          });
        }),
        restore: vi.fn(() => {
          const prev = stateStack.pop();
          if (prev) {
            currentAlpha = prev.globalAlpha;
            currentFill = prev.fillStyle;
            currentStroke = prev.strokeStyle;
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
        fill: vi.fn(() => {
          capturedStats.fillCalls += 1;
        }),
        stroke: vi.fn(() => {
          capturedStats.strokeCalls += 1;
        }),
        setLineDash: vi.fn(),
        createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
        createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
        measureText: vi.fn((text: string) => ({ width: text.length * 7 })),
        fillText: vi.fn((text: string) => {
          capturedStats.fillTextArgs.push(String(text));
        }),
        strokeText: vi.fn(),
        createImageData: vi.fn((w: number, h: number) => ({
          width: w,
          height: h,
          data: new Uint8ClampedArray(w * h * 4),
          colorSpace: 'srgb' as PredefinedColorSpace,
        })),
        putImageData: vi.fn((imgData?: ImageData) => {
          capturedStats.putImageDataCalls += 1;
          if (imgData?.data) {
            capturedStats.lastPutImageData = new Uint8ClampedArray(imgData.data);
          }
        }),
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
  temperature = 23.5
): TelemetryResponse {
  return {
    id: `tel-${roomId}`,
    timestamp: new Date().toISOString(),
    metadata: {
      deviceId: `dev-${roomId}`,
      hardwareId: `ESP32_${roomId}`,
      roomId,
    },
    environment: { temperature, humidity: 51.0, lux: 420 },
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

function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <ToastProvider>{ui}</ToastProvider>
      </QueryClientProvider>
    ),
  };
}

function setupAuthRole(
  roleName: 'ADMIN' | 'LIBRARIAN' | 'MAINTENANCE' | 'ZONE_MANAGER' | 'USER' | 'VIEWER',
  scopeStr: string
) {
  const user: UserResponse = {
    id: `u-${roleName.toLowerCase()}`,
    username: `user_${roleName.toLowerCase()}`,
    active: true,
    roles: [{ name: roleName, description: roleName, permissions: [] }],
    assignedZones: ['ZONE_A', 'ZONE_B'],
  };
  useAuthStore.setState({
    accessToken: `tok-${roleName}`,
    refreshToken: `ref-${roleName}`,
    user,
    capabilities: buildCapabilities(parseScopeString(scopeStr, user.username)),
    hydrated: true,
    isKioskSession: false,
  });
}

describe('Phase 8: Lớp Nội Thất 1:100, Chỉnh Sửa Theo Quyền & Optimistic Locking', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, '', '/floorplan');
    Object.defineProperty(window, 'innerWidth', {
      writable: true,
      configurable: true,
      value: 1440,
    });
    Object.defineProperty(window, 'innerHeight', {
      writable: true,
      configurable: true,
      value: 900,
    });
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    vi.spyOn(stompManager, 'isConnected').mockReturnValue(true);
    vi.spyOn(stompManager, 'onConnectionChange').mockImplementation((cb) => {
      cb(true);
      return vi.fn();
    });
    vi.spyOn(stompManager, 'subscribeRoom').mockImplementation(() => vi.fn());
    vi.spyOn(stompManager, 'onAlert').mockImplementation(() => vi.fn());
    vi.spyOn(stompManager, 'activate').mockImplementation(() => {});
    vi.spyOn(stompManager, 'deactivate').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('TC-G8-01: Mở rộng loại nội thất mới SMART_LOCKER qua FURNITURE_CATALOG mà không sửa logic component', () => {
    const extendedCatalog: FurnitureCatalogEntry[] = [
      ...FURNITURE_CATALOG,
      {
        typeId: 'SMART_LOCKER',
        labelVi: 'Tủ gửi đồ thông minh',
        shortLabel: 'Tủ đồ',
        category: 'STORAGE',
        defaultWidthM: 1.8,
        defaultDepthM: 0.6,
        minWidthM: 0.6,
        maxWidthM: 4.0,
        minDepthM: 0.4,
        maxDepthM: 1.2,
        blocksWalkway: true,
        sensitiveHardware: false,
        fillColor: '#1E3A8A',
        strokeColor: '#60A5FA',
        shape: 'rect',
      },
    ];

    const room301 = makeRoomFromPreset('TQB_301', 'ROOM_301');
    const onSave = vi.fn();

    function ExtensibleHarness() {
      const [items, setItems] = useState<FurnitureItem[]>([]);
      const [selectedIds, setSelectedIds] = useState<string[]>([]);
      return (
        <FurnitureLayerEditor
          room={room301}
          roomPolygon={room301.boundaryPolygon ?? []}
          catalog={extendedCatalog}
          items={items}
          canUndo={false}
          canRedo={false}
          selectedIds={selectedIds}
          onSelectIds={setSelectedIds}
          onCommitItems={setItems}
          onUndo={vi.fn()}
          onRedo={vi.fn()}
          snapEnabled={true}
          onSnapEnabledChange={vi.fn()}
          showLayer={true}
          onShowLayerChange={vi.fn()}
          opacity={0.65}
          onOpacityChange={vi.fn()}
          version={1}
          auditHistory={[]}
          onSave={(note) => onSave(items, note)}
          onReload={vi.fn()}
        />
      );
    }

    render(<ExtensibleHarness />);

    const smartLockerBtn = screen.getByTestId(
      'furniture-catalog-add-SMART_LOCKER'
    );
    expect(smartLockerBtn).toHaveTextContent('Tủ gửi đồ thông minh');
    expect(smartLockerBtn).toHaveTextContent('1.8×0.6m');

    fireEvent.click(smartLockerBtn);

    // Xuất hiện ngay trong danh sách đối tượng & inspector, xoay +45° và lưu được ngay
    fireEvent.click(screen.getByTestId('furniture-rotate-45-btn'));
    expect(screen.getByTestId('furniture-input-rotation')).toHaveValue(45);
    expect(
      screen.queryByTestId('furniture-validation-errors')
    ).not.toBeInTheDocument();

    const saveBtn = screen.getByTestId('furniture-save-btn');
    expect(saveBtn).toBeEnabled();
    fireEvent.click(saveBtn);

    expect(onSave).toHaveBeenCalledTimes(1);
    const savedItems = onSave.mock.calls[0][0] as FurnitureItem[];
    expect(savedItems).toHaveLength(1);
    expect(savedItems[0].typeId).toBe('SMART_LOCKER');
    expect(savedItems[0].widthM).toBe(1.8);
    expect(savedItems[0].depthM).toBe(0.6);
    expect(savedItems[0].rotationDeg).toBe(45);
  });

  it('TC-G8-02: Quy đổi kích thước mét thực 1:100 (76.0m × 57.2m) sang pixel chính xác', () => {
    const px = furnitureMetersToPixelSize(2.4, 1.2, 960, 722, 1.0);
    expect(px.widthPx).toBeCloseTo((2.4 / 76.0) * 960, 2);
    expect(px.heightPx).toBeCloseTo((1.2 / 57.2) * 722, 2);
    expect(px.widthPx).toBeCloseTo(30.32, 2);
    expect(px.heightPx).toBeCloseTo(15.15, 2);

    const zoomedPx = furnitureMetersToPixelSize(2.4, 1.2, 960, 722, 2.0);
    expect(zoomedPx.widthPx).toBeCloseTo(px.widthPx * 2, 2);
    expect(zoomedPx.heightPx).toBeCloseTo(px.heightPx * 2, 2);
  });

  it('TC-G8-03: Phát hiện va chạm OBB Collision (SAT) giữa 2 bàn đọc xoay góc 45° & bỏ qua vật thể không chắn lối đi', () => {
    const itemA: FurnitureItem = {
      id: 'desk-a',
      typeId: 'DESK',
      x: 0.5,
      y: 0.5,
      widthM: 2.4,
      depthM: 1.2,
      rotationDeg: 45,
      locked: false,
    };
    const itemBOverlap: FurnitureItem = {
      id: 'desk-b',
      typeId: 'DESK',
      x: 0.51,
      y: 0.505,
      widthM: 2.4,
      depthM: 1.2,
      rotationDeg: 0,
      locked: false,
    };
    expect(doFurnitureItemsOverlap(itemA, itemBOverlap)).toBe(true);

    const itemBClear: FurnitureItem = {
      ...itemBOverlap,
      x: 0.56,
      y: 0.56,
    };
    expect(doFurnitureItemsOverlap(itemA, itemBClear)).toBe(false);

    // IOT_NODE has blocksWalkway = false -> never collides physically with desk
    const sensorItem: FurnitureItem = {
      id: 'node-1',
      typeId: 'IOT_NODE',
      x: 0.5,
      y: 0.5,
      widthM: 0.5,
      depthM: 0.5,
      rotationDeg: 0,
      locked: false,
    };
    expect(doFurnitureItemsOverlap(itemA, sensorItem)).toBe(false);
  });

  it('TC-G8-04: Chặn kéo đồ nội thất vượt ra ngoài đa giác lõm P.201 (8 đỉnh ôm thang máy)', () => {
    const p201 = TQB_ROOM_PRESETS.find((p) => p.code === 'TQB_201')!;
    expect(p201.boundaryPolygon.length).toBe(8);

    // Bàn hợp lệ trong lòng Phòng 201
    const validDesk: FurnitureItem = {
      id: 'd-ok',
      typeId: 'DESK',
      x: 0.5,
      y: 0.14,
      widthM: 2.4,
      depthM: 1.2,
      rotationDeg: 0,
      locked: false,
    };
    expect(isFurnitureInsideRoom(validDesk, p201.boundaryPolygon)).toBe(true);

    // Bàn bị kéo vào vùng lõm thang máy (x=0.32, y=0.25) -> nằm ngoài đa giác 8 đỉnh
    const inCutoutCore: FurnitureItem = {
      ...validDesk,
      id: 'd-cutout',
      x: 0.32,
      y: 0.25,
    };
    expect(isFurnitureInsideRoom(inCutoutCore, p201.boundaryPolygon)).toBe(false);

    // Bàn cắt vắt ngang mép tường lõi thang máy (0.346, 0.25)
    const crossingWall: FurnitureItem = {
      ...validDesk,
      id: 'd-wall',
      x: 0.346,
      y: 0.25,
    };
    expect(isFurnitureInsideRoom(crossingWall, p201.boundaryPolygon)).toBe(false);
  });

  it('TC-G8-05: Snap lưới 0.25m, kẹp kích thước min/max và phản ánh trên Property Inspector', () => {
    expect(snapToGridMeters(12.13, 0.25)).toBe(12.25);
    expect(snapToGridMeters(8.39, 0.25)).toBe(8.5);

    const clamped = clampFurnitureDimensions(10.0, 1.2, 'DESK');
    expect(clamped.widthM).toBe(4.0);
    expect(clamped.depthM).toBe(1.2);

    const room301 = makeRoomFromPreset('TQB_301', 'ROOM_301');
    const desk: FurnitureItem = {
      id: 'desk-1',
      typeId: 'DESK',
      label: 'Bàn 1',
      x: 0.5,
      y: 0.14,
      widthM: 2.4,
      depthM: 1.2,
      rotationDeg: 0,
      locked: false,
    };

    function InspectorHarness() {
      const [items, setItems] = useState<FurnitureItem[]>([desk]);
      return (
        <FurnitureLayerEditor
          room={room301}
          roomPolygon={room301.boundaryPolygon ?? []}
          items={items}
          canUndo={false}
          canRedo={false}
          selectedIds={['desk-1']}
          onSelectIds={vi.fn()}
          onCommitItems={setItems}
          onUndo={vi.fn()}
          onRedo={vi.fn()}
          snapEnabled={true}
          onSnapEnabledChange={vi.fn()}
          showLayer={true}
          onShowLayerChange={vi.fn()}
          opacity={0.65}
          onOpacityChange={vi.fn()}
          version={1}
          auditHistory={[]}
          onSave={vi.fn()}
          onReload={vi.fn()}
        />
      );
    }

    render(<InspectorHarness />);
    const widthInput = screen.getByTestId('furniture-input-width');
    fireEvent.change(widthInput, { target: { value: '10.0' } });
    expect(widthInput).toHaveValue(4.0);

    const xInput = screen.getByTestId('furniture-input-xm');
    fireEvent.change(xInput, { target: { value: '38.13' } });
    // Snap 0.25m clamps/snaps 38.13 -> 38.25 -> normalized x = 38.25/76.0 = 0.5033 -> displays 38.25
    expect(Number((xInput as HTMLInputElement).value)).toBeCloseTo(38.25, 2);
  });

  it('TC-G8-06: Căn hàng (Align Middle Y) nhiều dãy bàn giữ nguyên ranh giới phòng', () => {
    const sampleRoomPoly: Point2D[] = [
      { x: 0.3, y: 0.3 },
      { x: 0.7, y: 0.3 },
      { x: 0.7, y: 0.55 },
      { x: 0.3, y: 0.55 },
    ];
    const items: FurnitureItem[] = [
      {
        id: 'b1',
        typeId: 'DESK',
        x: 0.4,
        y: 0.41,
        widthM: 2.4,
        depthM: 1.2,
        rotationDeg: 0,
        locked: false,
      },
      {
        id: 'b2',
        typeId: 'DESK',
        x: 0.5,
        y: 0.44,
        widthM: 2.4,
        depthM: 1.2,
        rotationDeg: 0,
        locked: false,
      },
      {
        id: 'b3',
        typeId: 'DESK',
        x: 0.6,
        y: 0.39,
        widthM: 2.4,
        depthM: 1.2,
        rotationDeg: 0,
        locked: false,
      },
    ];

    const aligned = alignFurnitureItems(
      items,
      ['b1', 'b2', 'b3'],
      'middleY',
      sampleRoomPoly
    );
    expect(aligned.map((i) => i.y)).toEqual([0.4133, 0.4133, 0.4133]);
    expect(aligned.every((i) => isFurnitureInsideRoom(i, sampleRoomPoly))).toBe(
      true
    );

    // Kiểm tra bấm nút "Căn thẳng hàng ngang" trong UI
    const room301 = makeRoomFromPreset('TQB_301', 'ROOM_301');
    const onCommit = vi.fn();
    render(
      <FurnitureLayerEditor
        room={room301}
        roomPolygon={room301.boundaryPolygon ?? []}
        items={[
          { ...items[0], x: 0.4, y: 0.11 },
          { ...items[1], x: 0.5, y: 0.14 },
          { ...items[2], x: 0.6, y: 0.09 },
        ]}
        canUndo={false}
        canRedo={false}
        selectedIds={['b1', 'b2', 'b3']}
        onSelectIds={vi.fn()}
        onCommitItems={onCommit}
        onUndo={vi.fn()}
        onRedo={vi.fn()}
        snapEnabled={true}
        onSnapEnabledChange={vi.fn()}
        showLayer={true}
        onShowLayerChange={vi.fn()}
        opacity={0.65}
        onOpacityChange={vi.fn()}
        version={1}
        auditHistory={[]}
        onSave={vi.fn()}
        onReload={vi.fn()}
      />
    );

    fireEvent.click(screen.getByTestId('furniture-align-middleY'));
    expect(onCommit).toHaveBeenCalledTimes(1);
    const committed = onCommit.mock.calls[0][0] as FurnitureItem[];
    expect(committed.map((c) => c.y)).toEqual([0.1133, 0.1133, 0.1133]);
  });

  it('TC-G8-07: Undo/Redo (Ctrl+Z / Ctrl+Y), Nhân bản, Khóa (chặn kéo chuột & sửa/xóa), Xóa đối tượng tự do', () => {
    installCanvas2DMock();
    const room301 = makeRoomFromPreset('TQB_301', 'ROOM_301');
    const telMap = { ROOM_301: makeTelemetry('ROOM_301', 88) };

    function FullEditHarness() {
      const [history, setHistory] = useState(() =>
        createFurnitureHistory<FurnitureItem[]>([])
      );
      const [selectedIds, setSelectedIds] = useState<string[]>([]);
      const [snapEnabled, setSnapEnabled] = useState(true);
      const [showLayer, setShowLayer] = useState(true);
      const [opacity, setOpacity] = useState(0.65);

      const commit = (next: FurnitureItem[]) =>
        setHistory((prev) => pushFurnitureHistory(prev, next));

      return (
        <div>
          <FloorplanCanvas
            rooms={[room301]}
            devices={[]}
            roomTelemetryMap={telMap}
            layer="comfortScore"
            selectedRoomId={room301.id}
            onSelectRoom={vi.fn()}
            showFurnitureLayer={showLayer}
            furnitureItems={history.present}
            furnitureOpacity={opacity}
            furnitureEditMode={true}
            selectedFurnitureIds={selectedIds}
            snapFurnitureGrid={snapEnabled}
            onSelectFurnitureIds={setSelectedIds}
            onUpdateFurnitureItems={(next) =>
              setHistory((prev) => ({ ...prev, present: next }))
            }
            onCommitFurnitureItems={commit}
          />
          <FurnitureLayerEditor
            room={room301}
            roomPolygon={room301.boundaryPolygon ?? []}
            items={history.present}
            canUndo={history.past.length > 0}
            canRedo={history.future.length > 0}
            selectedIds={selectedIds}
            onSelectIds={setSelectedIds}
            onCommitItems={commit}
            onUndo={() => setHistory((prev) => undoFurnitureHistory(prev))}
            onRedo={() => setHistory((prev) => redoFurnitureHistory(prev))}
            snapEnabled={snapEnabled}
            onSnapEnabledChange={setSnapEnabled}
            showLayer={showLayer}
            onShowLayerChange={setShowLayer}
            opacity={opacity}
            onOpacityChange={setOpacity}
            version={1}
            auditHistory={[]}
            onSave={vi.fn()}
            onReload={vi.fn()}
          />
        </div>
      );
    }

    render(<FullEditHarness />);

    // 1. Thêm bàn
    fireEvent.click(screen.getByTestId('furniture-catalog-add-DESK'));
    const xInput = screen.getByTestId('furniture-input-xm') as HTMLInputElement;
    const initialXm = Number(xInput.value);

    // 2. Di chuyển tọa độ X +1.0m
    fireEvent.change(xInput, { target: { value: String(initialXm + 1.0) } });
    // 3. Xoay +90°
    fireEvent.click(screen.getByTestId('furniture-rotate-90-btn'));
    expect(screen.getByTestId('furniture-input-rotation')).toHaveValue(90);

    // Undo lần 1 -> về 0° (nhưng vẫn giữ X mới)
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(screen.getByTestId('furniture-input-rotation')).toHaveValue(0);
    // Undo lần 2 -> về X cũ
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(
      Number((screen.getByTestId('furniture-input-xm') as HTMLInputElement).value)
    ).toBeCloseTo(initialXm, 1);

    // Redo 1 lần -> khôi phục X mới
    fireEvent.keyDown(window, { key: 'y', ctrlKey: true });
    expect(
      Number((screen.getByTestId('furniture-input-xm') as HTMLInputElement).value)
    ).toBeCloseTo(initialXm + 1.0, 1);

    // Khóa đối tượng
    fireEvent.click(screen.getByTestId('furniture-lock-btn'));
    expect(screen.getByTestId('furniture-locked-hint')).toBeInTheDocument();
    expect(screen.getByTestId('furniture-delete-btn')).toBeDisabled();
    expect(screen.getByTestId('furniture-input-xm')).toBeDisabled();

    // Thử kéo gizmo trên Canvas khi locked = true -> vị trí giữ nguyên
    const gizmo = document.querySelector(
      '[data-testid^="furniture-gizmo-furn_"]'
    ) as HTMLElement;
    expect(gizmo).toHaveAttribute('data-locked', 'true');
    const beforeX = gizmo.getAttribute('data-x');
    const overlay = screen.getByTestId('furniture-edit-overlay');
    fireEvent.pointerDown(gizmo, { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(overlay, { clientX: 180, clientY: 140 });
    fireEvent.pointerUp(overlay);
    expect(gizmo.getAttribute('data-x')).toBe(beforeX);

    // Nhân bản -> tạo bản sao không bị khóa -> Xóa được bản sao, giữ bản khóa
    fireEvent.click(screen.getByTestId('furniture-duplicate-btn'));
    expect(
      document.querySelectorAll('[data-testid^="furniture-list-item-"]').length
    ).toBe(2);
    expect(screen.getByTestId('furniture-delete-btn')).toBeEnabled();
    fireEvent.click(screen.getByTestId('furniture-delete-btn'));
    expect(
      document.querySelectorAll('[data-testid^="furniture-list-item-"]').length
    ).toBe(1);
  });

  it('TC-G8-08: Lớp nội thất chỉ vẽ trên StaticBaseCanvas, KHÔNG kích hoạt vẽ lại hay làm sai lệch giá trị nhiệt RBF DynamicHeatmapCanvas', async () => {
    const { statsByCanvas } = installCanvas2DMock();
    const room301 = makeRoomFromPreset('TQB_301', 'ROOM_301');
    const tel301 = makeTelemetry('ROOM_301', 84, 24.0);
    const dev1 = {
      id: 'dev-a',
      hardwareId: 'ESP32_A',
      name: 'Node A',
      roomId: 'ROOM_301',
      zoneId: 'ZONE_A',
      deviceType: 'ESP32_NODE',
      active: true,
      online: true,
      connectionState: 'ONLINE' as const,
      posX: 0.42,
      posY: 0.12,
      lastSeenAt: null,
      lastOfflineAt: null,
    };
    const dev2 = {
      ...dev1,
      id: 'dev-b',
      hardwareId: 'ESP32_B',
      name: 'Node B',
      posX: 0.58,
      posY: 0.16,
    };
    const devTelMap = {
      'dev-a': makeTelemetry('ROOM_301', 88, 23.0),
      'dev-b': makeTelemetry('ROOM_301', 79, 25.0),
    };
    const furnitureList: FurnitureItem[] = [
      {
        id: 'desk-1',
        typeId: 'DESK',
        label: 'Bàn 1',
        x: 0.46,
        y: 0.14,
        widthM: 2.4,
        depthM: 1.2,
        rotationDeg: 0,
        locked: false,
      },
      {
        id: 'shelf-1',
        typeId: 'BOOKSHELF',
        label: 'Giá A',
        x: 0.54,
        y: 0.14,
        widthM: 2.0,
        depthM: 0.8,
        rotationDeg: 90,
        locked: false,
      },
    ];

    const rooms = [room301];
    const devices = [dev1, dev2];
    const roomTelemetryMap = { ROOM_301: tel301 };
    const onSelectRoom = vi.fn();

    const { rerender } = render(
      <FloorplanCanvas
        rooms={rooms}
        devices={devices}
        roomTelemetryMap={roomTelemetryMap}
        deviceTelemetryMap={devTelMap}
        layer="temperature"
        selectedRoomId={null}
        onSelectRoom={onSelectRoom}
        zoomedRoomId="ROOM_301"
        showFurnitureLayer={false}
        furnitureItems={furnitureList}
        furnitureOpacity={0.65}
      />
    );

    // Chờ Layer 2 (rAF) vẽ hoàn tất & camera zoom vào ROOM_301 ổn định
    await waitFor(() => {
      const dyn = statsByCanvas.get('dynamic-heatmap-canvas');
      const off = statsByCanvas.get('offscreen-canvas');
      expect(dyn?.drawImageCalls).toBeGreaterThan(0);
      expect(off?.putImageDataCalls).toBeGreaterThan(0);
      expect(
        screen.getByTestId('floorplan-canvas-wrapper')
      ).not.toHaveAttribute('data-scale', '1');
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });

    const staticBefore = statsByCanvas.get('static-base-canvas')!.fillCalls;
    const dynClearBefore =
      statsByCanvas.get('dynamic-heatmap-canvas')!.clearRectCalls;
    const dynDrawBefore =
      statsByCanvas.get('dynamic-heatmap-canvas')!.drawImageCalls;
    const dynTextsBefore = [
      ...statsByCanvas.get('dynamic-heatmap-canvas')!.fillTextArgs,
    ];
    const rbfPixelsBefore = Array.from(
      statsByCanvas.get('offscreen-canvas')!.lastPutImageData ?? []
    );
    expect(rbfPixelsBefore.length).toBeGreaterThan(0);

    // Bật showFurnitureLayer = true và đổi opacity -> CHỈ StaticBaseCanvas vẽ lại nội thất, DynamicHeatmapCanvas giữ nguyên 0 vẽ lại!
    rerender(
      <FloorplanCanvas
        rooms={rooms}
        devices={devices}
        roomTelemetryMap={roomTelemetryMap}
        deviceTelemetryMap={devTelMap}
        layer="temperature"
        selectedRoomId={null}
        onSelectRoom={onSelectRoom}
        zoomedRoomId="ROOM_301"
        showFurnitureLayer={true}
        furnitureItems={furnitureList}
        furnitureOpacity={0.75}
      />
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });

    const staticAfter = statsByCanvas.get('static-base-canvas')!.fillCalls;
    const staticAlphas = statsByCanvas.get('static-base-canvas')!.alphaHistory;
    const dynClearAfter =
      statsByCanvas.get('dynamic-heatmap-canvas')!.clearRectCalls;
    const dynDrawAfter =
      statsByCanvas.get('dynamic-heatmap-canvas')!.drawImageCalls;
    const dynTextsAfter =
      statsByCanvas.get('dynamic-heatmap-canvas')!.fillTextArgs;

    expect(staticAfter).toBeGreaterThan(staticBefore);
    expect(staticAlphas.some((a) => Math.abs(a - 0.75) < 0.01)).toBe(true);
    expect(dynClearAfter).toBe(dynClearBefore);
    expect(dynDrawAfter).toBe(dynDrawBefore);
    expect(dynTextsAfter).toEqual(dynTextsBefore);

    // Kích hoạt lại một khung vẽ Layer 2 (đổi selectedRoomId) khi lớp nội thất đang bật -> Mảng pixel nhiệt RBF vẫn khớp 100% từng byte!
    rerender(
      <FloorplanCanvas
        rooms={rooms}
        devices={devices}
        roomTelemetryMap={roomTelemetryMap}
        deviceTelemetryMap={devTelMap}
        layer="temperature"
        selectedRoomId="ROOM_301"
        onSelectRoom={onSelectRoom}
        zoomedRoomId="ROOM_301"
        showFurnitureLayer={true}
        furnitureItems={furnitureList}
        furnitureOpacity={0.75}
      />
    );

    await waitFor(() => {
      expect(
        statsByCanvas.get('dynamic-heatmap-canvas')!.drawImageCalls
      ).toBeGreaterThan(dynDrawAfter);
    });
    const rbfPixelsAfter = Array.from(
      statsByCanvas.get('offscreen-canvas')!.lastPutImageData ?? []
    );
    expect(rbfPixelsAfter).toEqual(rbfPixelsBefore);
  });

  it('TC-G8-09: RBAC chặt chẽ (USER/VIEWER/ZONE_MANAGER/Kiosk ẩn nút sửa & IOT_NODE; MAINTENANCE/ADMIN chỉnh sửa + xử lý 409 Conflict)', async () => {
    const { statsByCanvas } = installCanvas2DMock();
    const room301 = makeRoomFromPreset('TQB_301', 'ROOM_301');

    const furnitureResponse: RoomFurnitureResponse = {
      roomId: 'ROOM_301',
      version: 2,
      updatedBy: 'ktv.minh',
      updatedAt: '2026-11-18T08:00:00Z',
      items: [
        {
          id: 'desk-1',
          typeId: 'DESK',
          label: 'Bàn 1',
          x: 0.45,
          y: 0.14,
          widthM: 2.4,
          depthM: 1.2,
          rotationDeg: 0,
          locked: false,
        },
        {
          id: 'iot-secret',
          typeId: 'IOT_NODE',
          label: 'ESP32_RAW_SECRET',
          x: 0.55,
          y: 0.14,
          widthM: 0.5,
          depthM: 0.5,
          rotationDeg: 0,
          locked: false,
        },
      ],
      auditHistory: [
        {
          timestamp: '2026-11-18T08:00:00Z',
          username: 'ktv.minh',
          actionSummary: 'Khởi tạo',
          version: 2,
        },
      ],
    };

    vi.spyOn(roomsApi, 'list').mockResolvedValue({
      content: [room301],
      page: 0,
      size: 100,
      totalElements: 1,
      totalPages: 1,
      last: true,
    });
    vi.spyOn(roomsApi, 'listPublic').mockResolvedValue([
      {
        id: 'ROOM_301',
        code: 'TQB_301',
        name: room301.name,
        floor: 3,
        capacity: 200,
        type: 'STUDY_ROOM',
        boundaryPolygon: room301.boundaryPolygon,
        comfortScore: {
          overall: 88,
          grade: 'Gold',
          acousticScore: 88,
          airScore: 88,
          thermalScore: 88,
          lightScore: 88,
        },
      },
    ]);
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
      makeTelemetry('ROOM_301', 88)
    );
    vi.spyOn(roomsApi, 'getFurniture').mockResolvedValue(furnitureResponse);
    vi.spyOn(roomsApi, 'getPublicFurniture').mockResolvedValue({
      roomId: 'ROOM_301',
      version: 2,
      items: [furnitureResponse.items[0]],
      auditHistory: [],
    });

    // 1. USER -> không có nút chỉnh sửa nội thất, không vẽ chữ đè lên bàn, hover bàn hiện 'Bàn 1' và IOT_NODE bị lọc hoàn toàn
    setupAuthRole('USER', 'ROLE_USER');
    renderWithProviders(<FloorplanPage />);
    const wrapper = await screen.findByTestId('floorplan-canvas-wrapper');
    const cw = Number(wrapper.getAttribute('data-canvas-width')) || 960;
    const ch = Number(wrapper.getAttribute('data-canvas-height')) || 722;
    const dynCanvas = screen.getByTestId('dynamic-heatmap-canvas');

    await waitFor(() => {
      const staticTexts =
        statsByCanvas.get('static-base-canvas')?.fillTextArgs ?? [];
      expect(staticTexts).not.toContain('Bàn 1');
      expect(staticTexts).not.toContain('ESP32_RAW_SECRET');
    });

    // Rê chuột lên vị trí bàn (0.45, 0.14) -> hiện furniture-hover-tooltip có 'Bàn 1'
    fireEvent.mouseMove(dynCanvas, {
      clientX: Math.round(0.45 * cw),
      clientY: Math.round(0.14 * ch),
    });
    expect(screen.getByTestId('furniture-hover-tooltip')).toHaveTextContent(
      'Bàn 1'
    );

    // Rê chuột qua vị trí IOT_NODE (0.55, 0.14) -> tuyệt đối không lộ node cảm biến nhạy cảm
    fireEvent.mouseMove(dynCanvas, {
      clientX: Math.round(0.55 * cw),
      clientY: Math.round(0.14 * ch),
    });
    expect(
      screen.queryByTestId('furniture-hover-tooltip')
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('furniture-edit-toggle-btn')
    ).not.toBeInTheDocument();

    cleanup();

    // 2. ZONE_MANAGER (không có MANAGE_ZONES) -> chỉ xem, không có nút sửa nội thất
    setupAuthRole(
      'ZONE_MANAGER',
      'ROLE_ZONE_MANAGER VIEW_ALERTS VIEW_DEVICE_STATUS READ_SENSOR_DATA'
    );
    renderWithProviders(<FloorplanPage />);
    await screen.findByTestId('floorplan-canvas-wrapper');
    expect(
      screen.queryByTestId('furniture-edit-toggle-btn')
    ).not.toBeInTheDocument();

    cleanup();

    // 3. Kiosk public -> ẩn nút sửa, ẩn auditHistory, ẩn IOT_NODE
    useAuthStore.setState({
      accessToken: null,
      refreshToken: null,
      user: null,
      capabilities: buildCapabilities(parseScopeString('', null)),
      hydrated: true,
      isKioskSession: true,
    });
    renderWithProviders(<KioskLobbyPage />);
    await screen.findByTestId('floorplan-canvas-wrapper');
    expect(
      screen.queryByTestId('furniture-edit-toggle-btn')
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('furniture-audit-history')
    ).not.toBeInTheDocument();

    cleanup();

    // 4. MAINTENANCE -> mở được trình chỉnh sửa, thấy IOT_NODE, lưu thành công & xử lý 409 Conflict
    setupAuthRole(
      'MAINTENANCE',
      'ROLE_MAINTENANCE VIEW_ALERTS VIEW_DEVICE_STATUS READ_SENSOR_DETAIL'
    );
    const updateSpy = vi
      .spyOn(roomsApi, 'updateFurniture')
      .mockRejectedValueOnce(
        new ApiError({
          code: 5007,
          httpStatus: 409,
          rawMessage: 'Conflict',
        })
      )
      .mockResolvedValueOnce({
        ...furnitureResponse,
        version: 3,
      });

    renderWithProviders(<FloorplanPage />);
    await screen.findByTestId('floorplan-canvas-wrapper');
    const editToggleBtn = await screen.findByTestId('furniture-edit-toggle-btn');
    fireEvent.click(editToggleBtn);

    await screen.findByTestId('furniture-layer-editor');
    expect(
      screen.getByTestId('furniture-list-item-iot-secret')
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('furniture-catalog-add-DESK')
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('furniture-catalog-add-CHAIR')
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('furniture-catalog-add-BENCH')
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('furniture-catalog-add-BOOKSHELF')
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('furniture-catalog-add-COUNTER')
    ).toBeInTheDocument();

    // Bấm lưu lần 1 -> dính 409 Conflict -> hiện banner & nút tải lại
    fireEvent.click(screen.getByTestId('furniture-save-btn'));
    await screen.findByTestId('furniture-conflict-banner');
    expect(updateSpy).toHaveBeenCalledTimes(1);

    // Bấm Tải lại bản mới nhất -> banner xung đột biến mất -> Lưu lại thành công
    fireEvent.click(screen.getByTestId('furniture-reload-btn'));
    await waitFor(() => {
      expect(
        screen.queryByTestId('furniture-conflict-banner')
      ).not.toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('furniture-save-btn'));
    });
    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(2));
  });

  it('Phase 3-1: Quy chuẩn 5 nội thất chính (Bàn dài, Ghế đơn, Ghế dài, Giá sách, Bàn thủ thư) và tự đánh số tên', () => {
    const p301 = TQB_ROOM_PRESETS.find((p) => p.code === 'TQB_301')!;
    const room301 = makeRoomFromPreset('TQB_301', 'ROOM_301');

    function FiveCatalogHarness() {
      const [items, setItems] = useState<FurnitureItem[]>([]);
      const [selectedIds, setSelectedIds] = useState<string[]>([]);
      return (
        <FurnitureLayerEditor
          room={room301}
          roomPolygon={room301.boundaryPolygon ?? []}
          structuralColumns={p301.structuralColumns}
          items={items}
          canUndo={false}
          canRedo={false}
          selectedIds={selectedIds}
          onSelectIds={setSelectedIds}
          onCommitItems={setItems}
          onUndo={vi.fn()}
          onRedo={vi.fn()}
          snapEnabled={true}
          gridStepM={0.1}
          onSnapEnabledChange={vi.fn()}
          showLayer={true}
          onShowLayerChange={vi.fn()}
          opacity={0.65}
          onOpacityChange={vi.fn()}
          version={1}
          auditHistory={[]}
          onSave={vi.fn()}
          onReload={vi.fn()}
        />
      );
    }

    render(<FiveCatalogHarness />);

    expect(FURNITURE_CATALOG.map((c) => c.typeId)).toEqual([
      'DESK',
      'CHAIR',
      'BENCH',
      'BOOKSHELF',
      'COUNTER',
    ]);

    fireEvent.click(screen.getByTestId('furniture-catalog-add-DESK'));
    expect(screen.getByTestId('furniture-input-label')).toHaveValue(
      'Bàn dài số 1'
    );
    fireEvent.click(screen.getByTestId('furniture-catalog-add-DESK'));
    expect(screen.getByTestId('furniture-input-label')).toHaveValue(
      'Bàn dài số 2'
    );
    fireEvent.click(screen.getByTestId('furniture-catalog-add-CHAIR'));
    expect(screen.getByTestId('furniture-input-label')).toHaveValue(
      'Ghế đơn số 1'
    );
    fireEvent.click(screen.getByTestId('furniture-catalog-add-BENCH'));
    expect(screen.getByTestId('furniture-input-label')).toHaveValue(
      'Ghế dài số 1'
    );
    fireEvent.click(screen.getByTestId('furniture-catalog-add-BOOKSHELF'));
    expect(screen.getByTestId('furniture-input-label')).toHaveValue(
      'Giá sách số 1'
    );
    fireEvent.click(screen.getByTestId('furniture-catalog-add-COUNTER'));
    expect(screen.getByTestId('furniture-input-label')).toHaveValue(
      'Bàn thủ thư số 1'
    );
  });

  it('Phase 3-2: Chống đè Cột chịu lực BTCT (0.60×0.60m) — đánh dấu lỗi và khóa nút Lưu bố cục', () => {
    const p301 = TQB_ROOM_PRESETS.find((p) => p.code === 'TQB_301')!;
    const room301 = makeRoomFromPreset('TQB_301', 'ROOM_301');

    const deskOnColumn: FurnitureItem = {
      id: 'desk-col',
      typeId: 'DESK',
      label: 'Bàn đè cột',
      x: 0.399,
      y: 0.032,
      widthM: 2.4,
      depthM: 1.0,
      rotationDeg: 0,
      locked: false,
    };
    expect(
      doesFurnitureOverlapColumn(deskOnColumn, p301.structuralColumns)
    ).toBe(true);

    const validation = validateFurnitureLayout(
      [deskOnColumn],
      p301.boundaryPolygon,
      FURNITURE_CATALOG,
      p301.structuralColumns
    );
    expect(validation.valid).toBe(false);
    expect(validation.columnConflictIds.has('desk-col')).toBe(true);

    render(
      <FurnitureLayerEditor
        room={room301}
        roomPolygon={p301.boundaryPolygon}
        structuralColumns={p301.structuralColumns}
        items={[deskOnColumn]}
        canUndo={false}
        canRedo={false}
        selectedIds={['desk-col']}
        onSelectIds={vi.fn()}
        onCommitItems={vi.fn()}
        onUndo={vi.fn()}
        onRedo={vi.fn()}
        snapEnabled={true}
        gridStepM={0.1}
        onSnapEnabledChange={vi.fn()}
        showLayer={true}
        onShowLayerChange={vi.fn()}
        opacity={0.65}
        onOpacityChange={vi.fn()}
        version={1}
        auditHistory={[]}
        onSave={vi.fn()}
        onReload={vi.fn()}
      />
    );

    expect(screen.getByTestId('furniture-validation-errors')).toHaveTextContent(
      'cột chịu lực'
    );
    expect(screen.getByTestId('furniture-save-btn')).toBeDisabled();
  });

  it('Phase 3-3: Nhân bản thông minh +1 và ×3 xếp nối tiếp thẳng hàng, tránh tường/cột và tự tăng số tên', () => {
    const p301 = TQB_ROOM_PRESETS.find((p) => p.code === 'TQB_301')!;
    const room301 = makeRoomFromPreset('TQB_301', 'ROOM_301');
    const desk1: FurnitureItem = {
      id: 'desk-src',
      typeId: 'DESK',
      label: 'Bàn dài số 1',
      x: 0.44,
      y: 0.11,
      widthM: 2.4,
      depthM: 1.0,
      rotationDeg: 0,
      locked: false,
    };

    const clones = duplicateFurnitureItemsSmartly(
      [desk1],
      ['desk-src'],
      3,
      p301.boundaryPolygon,
      p301.structuralColumns,
      0.1
    );
    expect(clones).toHaveLength(3);
    expect(clones.map((c) => c.label)).toEqual([
      'Bàn dài số 2',
      'Bàn dài số 3',
      'Bàn dài số 4',
    ]);
    const validation = validateFurnitureLayout(
      [desk1, ...clones],
      p301.boundaryPolygon,
      FURNITURE_CATALOG,
      p301.structuralColumns
    );
    expect(validation.valid).toBe(true);

    function DuplicateRowHarness() {
      const [items, setItems] = useState<FurnitureItem[]>([desk1]);
      const [selectedIds, setSelectedIds] = useState<string[]>(['desk-src']);
      return (
        <FurnitureLayerEditor
          room={room301}
          roomPolygon={p301.boundaryPolygon}
          structuralColumns={p301.structuralColumns}
          items={items}
          canUndo={false}
          canRedo={false}
          selectedIds={selectedIds}
          onSelectIds={setSelectedIds}
          onCommitItems={setItems}
          onUndo={vi.fn()}
          onRedo={vi.fn()}
          snapEnabled={true}
          gridStepM={0.1}
          onSnapEnabledChange={vi.fn()}
          showLayer={true}
          onShowLayerChange={vi.fn()}
          opacity={0.65}
          onOpacityChange={vi.fn()}
          version={1}
          auditHistory={[]}
          onSave={vi.fn()}
          onReload={vi.fn()}
        />
      );
    }

    render(<DuplicateRowHarness />);
    fireEvent.click(screen.getByTestId('furniture-duplicate-row-btn'));
    expect(
      document.querySelectorAll('[data-testid^="furniture-list-item-"]').length
    ).toBe(4);
    expect(screen.getByText('Bàn dài số 2')).toBeInTheDocument();
    expect(screen.getByText('Bàn dài số 3')).toBeInTheDocument();
    expect(screen.getByText('Bàn dài số 4')).toBeInTheDocument();
  });

  it('Phase 3-4: Tự khởi tạo phòng thật từ PRESET_ khi ADMIN bấm Lưu bố cục nội thất', async () => {
    installCanvas2DMock();
    setupAuthRole(
      'ADMIN',
      'ROLE_ADMIN VIEW_ROOMS MANAGE_ROOMS VIEW_ALERTS MANAGE_DEVICES VIEW_DEVICE_STATUS'
    );
    const p301 = TQB_ROOM_PRESETS.find((p) => p.code === 'TQB_301')!;
    const createdRoom: RoomResponse = {
      id: 'real-room-301',
      code: p301.code,
      name: p301.name,
      floor: p301.floor,
      capacity: p301.capacity,
      type: p301.roomType,
      boundaryPolygon: [...p301.boundaryPolygon],
    };

    vi.spyOn(roomsApi, 'list').mockResolvedValue({
      content: [],
      page: 0,
      size: 100,
      totalElements: 0,
      totalPages: 0,
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
    const createSpy = vi
      .spyOn(roomsApi, 'create')
      .mockResolvedValue(createdRoom);
    const updateFurnSpy = vi
      .spyOn(roomsApi, 'updateFurniture')
      .mockImplementation(async (roomId, body) => ({
        roomId,
        version: 0,
        items: body.items,
        updatedBy: 'user_admin',
        updatedAt: '2026-11-25T07:00:00Z',
        auditHistory: [],
      }));

    renderWithProviders(<FloorplanPage />);
    const editBtn = await screen.findByTestId('furniture-edit-toggle-btn');
    fireEvent.click(editBtn);

    await screen.findByTestId('furniture-layer-editor');
    fireEvent.click(screen.getByTestId('furniture-catalog-add-DESK'));

    const saveBtn = screen.getByTestId('furniture-save-btn');
    expect(saveBtn).toBeEnabled();
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(updateFurnSpy).toHaveBeenCalledTimes(1);
    });
    expect(updateFurnSpy.mock.calls[0][0]).toBe('real-room-301');
  });

  it('Phase 3-5: Mở khóa Zoom (wheel) và Pan (kéo vùng trống) ngay trong chế độ Sửa nội thất', () => {
    installCanvas2DMock();
    const hadPointerEvent = typeof window.PointerEvent !== 'undefined';
    if (!hadPointerEvent) {
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
    render(
      <FloorplanCanvas
        rooms={[room301]}
        devices={[]}
        roomTelemetryMap={{ ROOM_301: makeTelemetry('ROOM_301', 88) }}
        layer="temperature"
        selectedRoomId={room301.id}
        onSelectRoom={vi.fn()}
        showFurnitureLayer={true}
        furnitureEditMode={true}
        furnitureItems={[]}
      />
    );

    const wrapper = screen.getByTestId('floorplan-canvas-wrapper');
    const overlay = screen.getByTestId('furniture-edit-overlay');
    expect(wrapper).toHaveAttribute('data-scale', '1');

    // Lăn chuột lên overlay -> phóng to vượt 1.0x
    fireEvent.wheel(overlay, { deltaY: -120, clientX: 480, clientY: 360 });
    const afterZoomScale = Number(wrapper.getAttribute('data-scale'));
    expect(afterZoomScale).toBeGreaterThan(1.1);

    // Kéo vùng trống trên overlay -> pan thay đổi tx/ty
    const beforeTx = Number(wrapper.getAttribute('data-tx'));
    fireEvent.pointerDown(overlay, { clientX: 400, clientY: 300, pointerId: 1 });
    fireEvent.pointerMove(overlay, { clientX: 340, clientY: 260, pointerId: 1 });
    fireEvent.pointerUp(overlay, { clientX: 340, clientY: 260, pointerId: 1 });
    const afterTx = Number(wrapper.getAttribute('data-tx'));
    expect(afterTx).not.toBe(beforeTx);

    if (!hadPointerEvent) {
      vi.unstubAllGlobals();
    }
  });
});
