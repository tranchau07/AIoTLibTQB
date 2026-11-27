import React, { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import FloorplanPage from '@/app/(protected)/floorplan/page';
import { ToastProvider } from '@/components/ui/primitives';
import { TQB_ROOM_PRESETS } from '@/config/tqb-floorplan-presets';
import { alertsApi } from '@/features/alerts/api';
import { useAuthStore } from '@/features/auth/store';
import { devicesApi } from '@/features/devices/api';
import { FloorplanCanvas } from '@/features/floorplan/components/FloorplanCanvas';
import { FloorRoomTree } from '@/features/floorplan/components/FloorRoomTree';
import { roomsApi } from '@/features/rooms/api';
import { telemetryApi } from '@/features/telemetry/api';
import { buildBuildingFloorTree } from '@/lib/floorplan/floorTreeBuilder';
import { buildCapabilities } from '@/lib/rbac/capabilities';
import { parseScopeString } from '@/lib/rbac/scope-parser';
import { stompManager } from '@/lib/realtime/stomp-client';
import type {
  AlertResponse,
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
  return vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockImplementation(function (this: HTMLCanvasElement, contextId: string) {
      if (contextId !== '2d') return null;
      const ctx = {
        canvas: this,
        fillStyle: '#000000',
        strokeStyle: '#000000',
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
      };
      return ctx as unknown as CanvasRenderingContext2D;
    });
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

function makeTelemetry(roomId: string, score: number): TelemetryResponse {
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
      temperature: 23.0,
      humidity: 50.0,
      lux: 400,
    },
    acoustics: {
      noiseAvg: 40.0,
      noisePeak: 45.0,
    },
    airQuality: {
      pm1_0: 8.0,
      pm2_5: 12.0,
      pm4_0: 14.0,
      pm10: 18.0,
    },
    wifiRssi: -56,
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
    deviceId: 'dev-1',
    hardwareId: 'ESP32-1',
    roomId: 'ROOM_1',
    zoneId: 'ZONE_A',
    type: 'NOISE_EXCEEDED',
    metricType: 'NOISE_AVG',
    unit: 'dBA',
    severity: 'CRITICAL',
    severityRank: 4,
    status: 'FIRING',
    workflowStatus: 'NEW',
    currentValue: 86,
    threshold: 75,
    message: 'Noise exceeded',
    startedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
    acknowledgedAt: null,
    resolvedAt: null,
    acknowledgedBy: null,
    resolvedBy: null,
    ...overrides,
  };
}

describe('Giai đoạn 2: Cây Điều Hướng WAI-ARIA Tầng -> Phòng, Đồng Bộ Hai Chiều & Breadcrumb', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    useAuthStore.setState({
      accessToken: null,
      refreshToken: null,
      user: null,
      capabilities: buildCapabilities(parseScopeString('')),
      hydrated: true,
      isKioskSession: false,
    });
  });

  it('TC-G2-01: Tổng hợp đúng trạng thái, mức cảnh báo cao nhất & tổng cảnh báo từ Phòng con lên Node Tầng', () => {
    const floor3Rooms = TQB_ROOM_PRESETS.filter((p) => p.floor === 3).map((p) =>
      makeRoomFromPreset(p.code, `ROOM_${p.code}`)
    );
    expect(floor3Rooms.length).toBeGreaterThanOrEqual(8);

    const telMap: Record<string, TelemetryResponse> = {};
    floor3Rooms.forEach((r, idx) => {
      if (idx === 0) telMap[r.id] = makeTelemetry(r.id, 42); // CRITICAL alert room
      else if (idx === 1) telMap[r.id] = makeTelemetry(r.id, 65); // ATTENTION
      else telMap[r.id] = makeTelemetry(r.id, 88); // GOOD
    });

    const alerts: AlertResponse[] = [
      makeAlert({
        id: 'a-1',
        roomId: floor3Rooms[0].id,
        severity: 'CRITICAL',
        severityRank: 4,
      }),
      makeAlert({
        id: 'a-2',
        roomId: floor3Rooms[0].id,
        severity: 'HIGH',
        severityRank: 3,
      }),
    ];

    const tree = buildBuildingFloorTree(floor3Rooms, telMap, alerts);
    expect(tree).toHaveLength(1);
    const f3 = tree[0];
    expect(f3.floor).toBe(3);
    expect(f3.totalOpenAlerts).toBe(2);
    expect(f3.highestAlertSeverity).toBe('CRITICAL');
    expect(f3.worstStatusLevel).toBe('POOR');
    expect(f3.rooms[0].openAlertsCount).toBe(2);
  });

  it('TC-G2-02: Tự động nhận diện Tầng/Phòng mới (Tầng 6 / TQB_601) từ API mà không cần sửa code', () => {
    const rooms: RoomResponse[] = [
      makeRoomFromPreset('TQB_301'),
      {
        id: 'ROOM_TQB_601',
        code: 'TQB_601',
        name: 'Phòng Nghiên Cứu Sau Đại Học',
        floor: 6,
        capacity: 40,
        type: 'STUDY_ROOM',
        targetComfortScore: 85,
        boundaryPolygon: [
          { x: 0.1, y: 0.1 },
          { x: 0.3, y: 0.1 },
          { x: 0.3, y: 0.3 },
          { x: 0.1, y: 0.3 },
        ],
      },
    ];

    const tree = buildBuildingFloorTree(rooms, {
      PRESET_TQB_301: makeTelemetry('PRESET_TQB_301', 88),
      ROOM_TQB_601: makeTelemetry('ROOM_TQB_601', 91),
    });

    expect(tree.map((f) => f.floor)).toEqual([3, 6]);

    render(
      <FloorRoomTree
        treeNodes={tree}
        selectedFloor={6}
        selectedRoomId={null}
        onSelectFloor={vi.fn()}
        onSelectRoom={vi.fn()}
        defaultExpandedFloors={[6]}
      />
    );

    expect(screen.getByTestId('tree-floor-6')).toHaveTextContent('Tầng 6');
    expect(screen.getByTestId('tree-room-TQB_601')).toHaveTextContent(
      'Phòng Nghiên Cứu Sau Đại Học'
    );
  });

  it('TC-G2-03: Điều hướng bàn phím ↓, ↑, Home, End chuẩn WAI-ARIA TreeView', () => {
    const allRooms = TQB_ROOM_PRESETS.map((p) => makeRoomFromPreset(p.code));
    const telMap: Record<string, TelemetryResponse> = {};
    allRooms.forEach((r) => {
      telMap[r.id] = makeTelemetry(r.id, 84);
    });
    const tree = buildBuildingFloorTree(allRooms, telMap, []);

    render(
      <FloorRoomTree
        treeNodes={tree}
        selectedFloor={3}
        selectedRoomId={null}
        onSelectFloor={vi.fn()}
        onSelectRoom={vi.fn()}
        defaultExpandedFloors={[3]}
      />
    );

    const floor1 = screen.getByTestId('tree-floor-1');
    const floor2 = screen.getByTestId('tree-floor-2');
    const floor3 = screen.getByTestId('tree-floor-3');
    const floor5 = screen.getByTestId('tree-floor-5');
    const firstRoomFloor3 = screen.getByTestId(
      `tree-room-${tree.find((f) => f.floor === 3)!.rooms[0].code}`
    );

    floor3.focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(document.activeElement).toBe(floor1);

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(floor2);

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(floor3);

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(firstRoomFloor3);

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(floor3);

    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(document.activeElement).toBe(floor5);
  });

  it('TC-G2-04: Điều hướng bàn phím → (mở rộng & đi vào phòng đầu) và ← (về cha & thu gọn)', () => {
    const floor2Rooms = TQB_ROOM_PRESETS.filter((p) => p.floor === 2).map((p) =>
      makeRoomFromPreset(p.code)
    );
    const floor1Rooms = TQB_ROOM_PRESETS.filter((p) => p.floor === 1).map((p) =>
      makeRoomFromPreset(p.code)
    );
    const rooms = [...floor1Rooms, ...floor2Rooms];
    const tree = buildBuildingFloorTree(rooms, {}, []);

    render(
      <FloorRoomTree
        treeNodes={tree}
        selectedFloor={1}
        selectedRoomId={null}
        onSelectFloor={vi.fn()}
        onSelectRoom={vi.fn()}
        defaultExpandedFloors={[1]}
      />
    );

    const floor2 = screen.getByTestId('tree-floor-2');
    expect(floor2).toHaveAttribute('aria-expanded', 'false');

    floor2.focus();
    // Lần 1 → mở rộng Tầng 2
    fireEvent.keyDown(floor2, { key: 'ArrowRight' });
    expect(floor2).toHaveAttribute('aria-expanded', 'true');
    expect(document.activeElement).toBe(floor2);

    // Lần 2 → focus vào phòng con đầu tiên (TQB_201)
    fireEvent.keyDown(floor2, { key: 'ArrowRight' });
    const firstRoomF2 = screen.getByTestId('tree-room-TQB_201');
    expect(document.activeElement).toBe(firstRoomF2);

    // ← lần 1 quay lại node cha Tầng 2
    fireEvent.keyDown(firstRoomF2, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(floor2);

    // ← lần 2 thu gọn Tầng 2
    fireEvent.keyDown(floor2, { key: 'ArrowLeft' });
    expect(floor2).toHaveAttribute('aria-expanded', 'false');
  });

  it('TC-G2-05: Phím Enter trên node TQB_502 chuyển tầng, chọn & zoom đúng phòng khác tầng', () => {
    const floor3 = makeRoomFromPreset('TQB_301');
    const floor5 = makeRoomFromPreset('TQB_502');
    const tree = buildBuildingFloorTree([floor3, floor5], {}, []);

    const onFloorChange = vi.fn();
    const onRoomChange = vi.fn();

    function CrossFloorHarness() {
      const [selectedFloor, setSelectedFloor] = useState(3);
      const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
      const [zoomedRoomId, setZoomedRoomId] = useState<string | null>(null);

      return (
        <div>
          <span data-testid="state-floor">{selectedFloor}</span>
          <span data-testid="state-selected">{selectedRoomId ?? 'none'}</span>
          <span data-testid="state-zoomed">{zoomedRoomId ?? 'none'}</span>
          <FloorRoomTree
            treeNodes={tree}
            selectedFloor={selectedFloor}
            selectedRoomId={selectedRoomId}
            defaultExpandedFloors={[3, 5]}
            onSelectFloor={(f) => {
              setSelectedFloor(f);
              setSelectedRoomId(null);
              setZoomedRoomId(null);
              onFloorChange(f);
            }}
            onSelectRoom={(r) => {
              setSelectedFloor(r.floor);
              setSelectedRoomId(r.id);
              setZoomedRoomId(r.id);
              onRoomChange(r);
            }}
          />
        </div>
      );
    }

    render(<CrossFloorHarness />);

    const r502Node = screen.getByTestId('tree-room-TQB_502');
    r502Node.focus();
    fireEvent.keyDown(r502Node, { key: 'Enter' });

    expect(onRoomChange).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('state-floor')).toHaveTextContent('5');
    expect(screen.getByTestId('state-selected')).toHaveTextContent('PRESET_TQB_502');
    expect(screen.getByTestId('state-zoomed')).toHaveTextContent('PRESET_TQB_502');
  });

  it('TC-G2-06: Đồng bộ chiều ngược — click đa giác phòng P.301 trên Canvas tự động mở rộng Tầng 3 và chọn node trên cây', () => {
    installCanvas2DMock();
    const room101 = makeRoomFromPreset('TQB_101');
    const room301 = makeRoomFromPreset('TQB_301');
    const tree = buildBuildingFloorTree([room101, room301], {}, []);

    function TwoWaySyncHarness() {
      const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
      return (
        <div>
          <FloorRoomTree
            treeNodes={tree}
            selectedFloor={1}
            selectedRoomId={selectedRoomId}
            defaultExpandedFloors={[1]}
            onSelectFloor={vi.fn()}
            onSelectRoom={(r) => setSelectedRoomId(r.id)}
          />
          <FloorplanCanvas
            rooms={[room301]}
            devices={[]}
            roomTelemetryMap={{ PRESET_TQB_301: makeTelemetry('PRESET_TQB_301', 86) }}
            layer="comfortScore"
            selectedRoomId={selectedRoomId}
            onSelectRoom={(r) => setSelectedRoomId(r.id)}
          />
        </div>
      );
    }

    render(<TwoWaySyncHarness />);

    // Ban đầu Tầng 3 bị đóng
    const floor3Node = screen.getByTestId('tree-floor-3');
    expect(floor3Node).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('tree-room-TQB_301')).not.toBeInTheDocument();

    // Tính tâm đa giác P.301 theo viewport 960x723 mặc định
    const canvas = screen.getByTestId('dynamic-heatmap-canvas');
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 960,
      bottom: 723,
      width: 960,
      height: 723,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    const minX = Math.min(...room301.boundaryPolygon!.map((p) => p.x));
    const maxX = Math.max(...room301.boundaryPolygon!.map((p) => p.x));
    const minY = Math.min(...room301.boundaryPolygon!.map((p) => p.y));
    const maxY = Math.max(...room301.boundaryPolygon!.map((p) => p.y));
    const clickX = ((minX + maxX) * 0.5) * 960;
    const clickY = ((minY + maxY) * 0.5) * 723;

    fireEvent.click(canvas, { clientX: clickX, clientY: clickY });

    expect(floor3Node).toHaveAttribute('aria-expanded', 'true');
    const r301Node = screen.getByTestId('tree-room-TQB_301');
    expect(r301Node).toHaveAttribute('aria-selected', 'true');
  });

  it('TC-G2-07: Tìm kiếm tiếng Việt không dấu ("doc dong", "302") tự động mở tầng khớp và hiện empty state khi không có kết quả', () => {
    const rooms = TQB_ROOM_PRESETS.map((p) => makeRoomFromPreset(p.code));
    const tree = buildBuildingFloorTree(rooms, {}, []);

    render(
      <FloorRoomTree
        treeNodes={tree}
        selectedFloor={3}
        selectedRoomId={null}
        onSelectFloor={vi.fn()}
        onSelectRoom={vi.fn()}
        defaultExpandedFloors={[]}
      />
    );

    const searchInput = screen.getByTestId('tree-search-input');

    // Nhập từ khóa không dấu "doc dong" (Cánh Đông: 203, 303, 503; không khớp Cánh Tây 202 hay Cánh Bắc 501)
    fireEvent.change(searchInput, { target: { value: 'doc dong' } });
    expect(screen.getByTestId('tree-room-TQB_203')).toBeInTheDocument();
    expect(screen.getByTestId('tree-room-TQB_303')).toBeInTheDocument();
    expect(screen.queryByTestId('tree-room-TQB_202')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tree-room-TQB_501')).not.toBeInTheDocument();

    // Nhập mã phòng "302"
    fireEvent.change(searchInput, { target: { value: '302' } });
    expect(screen.getByTestId('tree-room-TQB_302')).toBeInTheDocument();
    expect(screen.queryByTestId('tree-room-TQB_203')).not.toBeInTheDocument();

    // Từ khóa không khớp -> thông báo rỗng
    fireEvent.change(searchInput, { target: { value: 'khongtontaiphong' } });
    expect(screen.getByTestId('tree-empty-state')).toBeInTheDocument();
  });

  it('TC-G2-08: Bật bộ lọc "Chỉ cảnh báo" chỉ hiển thị Tầng 1 (P.103) và Tầng 3 (P.302)', () => {
    const rooms = TQB_ROOM_PRESETS.map((p) => makeRoomFromPreset(p.code));
    const alerts: AlertResponse[] = [
      makeAlert({ id: 'a1', roomId: 'PRESET_TQB_103', severity: 'HIGH' }),
      makeAlert({ id: 'a2', roomId: 'PRESET_TQB_302', severity: 'CRITICAL' }),
    ];
    const tree = buildBuildingFloorTree(rooms, {}, alerts);

    render(
      <FloorRoomTree
        treeNodes={tree}
        selectedFloor={3}
        selectedRoomId={null}
        onSelectFloor={vi.fn()}
        onSelectRoom={vi.fn()}
        defaultExpandedFloors={[]}
      />
    );

    const filterBtn = screen.getByTestId('tree-only-alerts-btn');
    fireEvent.click(filterBtn);

    expect(filterBtn).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('tree-floor-1')).toBeInTheDocument();
    expect(screen.getByTestId('tree-room-TQB_103')).toBeInTheDocument();
    expect(screen.getByTestId('tree-floor-3')).toBeInTheDocument();
    expect(screen.getByTestId('tree-room-TQB_302')).toBeInTheDocument();

    expect(screen.queryByTestId('tree-floor-2')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tree-floor-4')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tree-floor-5')).not.toBeInTheDocument();
  });

  it('TC-G2-09: Breadcrumb "Tầng › Phòng" bấm vào Tầng điều hướng ngược về toàn tầng (reset zoom/selection)', async () => {
    installCanvas2DMock();
    vi.spyOn(stompManager, 'isConnected').mockReturnValue(true);
    vi.spyOn(stompManager, 'onConnectionChange').mockImplementation((cb) => {
      cb(true);
      return vi.fn();
    });
    vi.spyOn(stompManager, 'subscribeRoom').mockImplementation(() => vi.fn());

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
      makeTelemetry('ROOM_302', 82)
    );

    const managerUser: UserResponse = {
      id: 'u-lib',
      username: 'thuthu.an',
      active: true,
      roles: [{ name: 'LIBRARIAN', description: 'Librarian', permissions: [] }],
      assignedZones: ['ZONE_A'],
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

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    window.history.replaceState({}, '', '/floorplan?floor=3&roomId=ROOM_302');
    render(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <FloorplanPage />
        </ToastProvider>
      </QueryClientProvider>
    );

    // Thành phần "Tầng & Phòng" không còn gắn trên trang Bản đồ mặt bằng
    expect(screen.queryByTestId('floor-room-tree-panel')).not.toBeInTheDocument();

    // Breadcrumb hiện "Tầng 3 › TQB_302 — ..." và bản đồ zoom vào P.302
    const roomCrumb = await screen.findByTestId('breadcrumb-room-label');
    expect(roomCrumb).toHaveTextContent(room302.code);
    const wrapper = screen.getByTestId('floorplan-canvas-wrapper');
    await waitFor(() => {
      expect(Number(wrapper.getAttribute('data-scale'))).toBeGreaterThan(1.05);
    });

    // Click nút "Tầng 3" trên Breadcrumb -> bỏ zoom & bỏ chọn phòng, scale về 1.00
    const floorCrumbBtn = screen.getByTestId('breadcrumb-floor-btn');
    fireEvent.click(floorCrumbBtn);

    await waitFor(() => {
      expect(screen.queryByTestId('breadcrumb-room-label')).not.toBeInTheDocument();
      expect(Number(wrapper.getAttribute('data-scale'))).toBe(1);
    });
    window.history.replaceState({}, '', '/floorplan');
  });

  it('TC-G2-10: Thu gọn / mở rộng ngăn Cây điều hướng sang dải 44px hiển thị chấm trạng thái 5 tầng', () => {
    const rooms = TQB_ROOM_PRESETS.map((p) => makeRoomFromPreset(p.code));
    const tree = buildBuildingFloorTree(rooms, {}, []);

    render(
      <FloorRoomTree
        treeNodes={tree}
        selectedFloor={3}
        selectedRoomId={null}
        onSelectFloor={vi.fn()}
        onSelectRoom={vi.fn()}
      />
    );

    const panel = screen.getByTestId('floor-room-tree-panel');
    expect(panel).toHaveAttribute('data-collapsed', 'false');

    const toggleBtn = screen.getByTestId('tree-collapse-toggle');
    fireEvent.click(toggleBtn);

    const collapsedPanel = screen.getByTestId('floor-room-tree-panel');
    expect(collapsedPanel).toHaveAttribute('data-collapsed', 'true');
    expect(collapsedPanel).toHaveStyle({ width: '44px' });
    for (const f of [1, 2, 3, 4, 5]) {
      expect(screen.getByTestId(`collapsed-floor-dot-${f}`)).toBeInTheDocument();
    }

    // Bấm mở lại cây
    fireEvent.click(screen.getByTestId('tree-collapse-toggle'));
    expect(screen.getByTestId('floor-room-tree-panel')).toHaveAttribute(
      'data-collapsed',
      'false'
    );
  });
});
