'use client';

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Maximize2,
  Minimize2,
  Minus,
  Plus,
  RotateCcw,
  Scan,
} from 'lucide-react';
import {
  TQB_BUILDING_ASPECT_RATIO,
  getFloorCadSvgPath,
  getFloorLandmarks,
  resolveRoomPolygon,
  resolveRoomPreset,
  synthesizeAnonymousMicroZones,
  type AnonymousMicroZone,
  type TqbLandmark,
} from '@/config/tqb-floorplan-presets';
import { type HeatmapLayerMetric } from '@/config/thresholds';
import {
  FLOORPLAN_INTERACTION_CONFIG,
  TIMING_CONFIG,
  ZOOM_CONFIG,
  type ManagerStatusFilter,
} from '@/config/floorplan-hmi.config';
import {
  clampViewportTransform,
  computePinchScale,
  fitFloorToViewport,
  fitPolygonToViewport,
  normalizedToPixel,
  pixelToNormalized,
  zoomViewportAtPoint,
  type ViewportTransform,
} from '@/lib/floorplan/coords';
import { type IdwSamplePoint } from '@/lib/floorplan/idw';
import {
  computePolygonSignedArea,
  computeVisualPolygonCenter,
  isPointInPolygon,
} from '@/lib/floorplan/polygon';
import {
  computeLabelPlacements,
  computeRoomLabelPriority,
  getLodConfig,
  type LabelDensity,
  type LabelRequest,
  type LabelStyleTier,
  type Obstacle,
  type RoomLabelStyle,
} from '@/lib/floorplan/labelLayout';
import {
  clusterDeviceNodes,
  type DeviceCluster,
} from '@/lib/floorplan/clustering';
import { computePopoverPlacement } from '@/lib/floorplan/popoverPosition';
import {
  computeRoomBlindspotRatio,
  getContinuousMetricColorCss,
  getMetricStatusSymbol,
  renderWeatherDiffusionHeatmap,
} from '@/lib/floorplan/weatherPalette';
import {
  evaluateAnimatedMetricState,
  isReducedMotionPreferred,
  updateAnimatedMetricState,
  type AnimatedMetricState,
} from '@/lib/floorplan/metricTransition';
import {
  evaluateRoomReliability,
  type RoomReliabilitySummary,
} from '@/lib/floorplan/reliability';
import {
  FURNITURE_CATALOG,
  filterVisibleFurnitureItems,
  resolveFurnitureCatalogEntry,
  type FurnitureCatalogEntry,
} from '@/config/furniture-catalog';
import {
  getFurnitureObbCornersNorm,
  snapNormalizedPointToGrid,
} from '@/lib/floorplan/furnitureGeometry';
import type {
  OneHourDeltaResult,
  PlaybackRoomState,
} from '@/lib/floorplan/timeAnalysis';
import { formatMetrics } from '@/lib/format/metrics';
import { isTelemetryStale } from '@/lib/format/datetime';
import { FLOORPLAN_I18N_VI } from '@/messages/vi';
import {
  FloorplanMinimap,
  type MinimapRoomShape,
} from '@/features/floorplan/components/FloorplanMinimap';
import { RoomHoverPopover } from '@/features/floorplan/components/RoomHoverPopover';
import type {
  AlertSeverity,
  DeviceResponse,
  FurnitureItem,
  Point2D,
  RoomResponse,
  TelemetryResponse,
} from '@/types/api';

export function extractLayerMetricValue(
  telemetry: TelemetryResponse | null | undefined,
  layer: HeatmapLayerMetric
): number | null {
  if (!telemetry) return null;
  switch (layer) {
    case 'comfortScore':
      return telemetry.comfortScore?.overall ?? null;
    case 'noiseAvg':
      return telemetry.acoustics?.noiseAvg ?? null;
    case 'pm2_5':
      return telemetry.airQuality?.pm2_5 ?? null;
    case 'temperature':
      return telemetry.environment?.temperature ?? null;
    case 'humidity':
      return telemetry.environment?.humidity ?? null;
    case 'lux':
      return telemetry.environment?.lux ?? null;
    case 'wifiRssi':
      return telemetry.wifiRssi ?? null;
  }
}

export function formatLayerMetricValue(
  value: number | null | undefined,
  layer: HeatmapLayerMetric
): string {
  switch (layer) {
    case 'comfortScore':
      return formatMetrics.comfortScore(value);
    case 'noiseAvg':
      return formatMetrics.noise(value);
    case 'pm2_5':
      return formatMetrics.pm(value);
    case 'temperature':
      return formatMetrics.temperature(value);
    case 'humidity':
      return formatMetrics.humidity(value);
    case 'lux':
      return formatMetrics.lux(value);
    case 'wifiRssi':
      return formatMetrics.rssi(value);
  }
}

function resolveDeviceTelemetry(
  dev: DeviceResponse,
  deviceTelemetryMap: Record<string, TelemetryResponse | null | undefined>,
  roomTelemetryMap: Record<string, TelemetryResponse | null | undefined>,
  roomDeviceCount: number
): TelemetryResponse | null | undefined {
  const direct = deviceTelemetryMap[dev.id];
  if (direct) return direct;
  if (!dev.roomId) return undefined;
  const roomLatest = roomTelemetryMap[dev.roomId];
  if (!roomLatest) return undefined;
  if (roomLatest.metadata?.deviceId === dev.id || roomDeviceCount <= 1) {
    return roomLatest;
  }
  return undefined;
}

function computePolygonCentroid(vertices: readonly Point2D[]): Point2D {
  return computeVisualPolygonCenter(vertices);
}

export interface FloorplanCanvasProps {
  rooms: RoomResponse[];
  devices: DeviceResponse[];
  roomTelemetryMap: Record<string, TelemetryResponse | null | undefined>;
  deviceTelemetryMap?: Record<string, TelemetryResponse | null | undefined>;
  layer: HeatmapLayerMetric;
  selectedRoomId: string | null;
  onSelectRoom: (room: RoomResponse) => void;
  onSelectDevice?: (device: DeviceResponse, room?: RoomResponse) => void;
  /** Bật/tắt chế độ Phóng đại phòng */
  zoomedRoomId?: string | null;
  onZoomRoomChange?: (roomId: string | null) => void;
  /** Phân khu bàn đọc đang được chọn / gợi ý (dành cho Smart Study Spot Finder) */
  selectedBayId?: string | null;
  onSelectBay?: (bay: AnonymousMicroZone, room: RoomResponse) => void;
  /** Hiển thị vùng mù cảm biến (fieldPresence < 0.25) */
  showBlindspots?: boolean;
  /** Lớp Độ tin cậy dữ liệu cho Quản lý (Đo trực tiếp / Nội suy / Vùng mù / Dữ liệu trễ) */
  showReliabilityLayer?: boolean;
  /** Tóm tắt độ tin cậy dữ liệu theo roomId */
  roomReliabilityMap?: Record<string, RoomReliabilitySummary>;
  /** Hiển thị lớp chẩn đoán kỹ thuật (chênh nhiệt cục bộ ΔT, RSSI, % vùng mù) */
  showTechOverlay?: boolean;
  /** Danh sách mã Zone phụ trách của ZONE_MANAGER để làm nổi bật */
  highlightedZoneIds?: readonly string[];
  /** Danh sách roomId đang có cảnh báo FIRING để vẽ vòng cảnh báo */
  firingRoomIds?: readonly string[];
  /** Node cảm biến đang được định vị / chọn trực tiếp từ cảnh báo */
  focusedDeviceId?: string | null;
  /** Danh sách ID hoặc hardwareId của các node cảm biến đang có cảnh báo FIRING / ACKNOWLEDGED */
  alertingDeviceIds?: readonly string[];
  /** Mật độ hiển thị nhãn khởi tạo; người dùng vẫn đổi được qua nút gạt trên bản đồ */
  defaultLabelDensity?: LabelDensity;
  /** Số lượng cảnh báo mở theo roomId để vẽ huy hiệu !N ở lớp trên cùng */
  roomAlertCounts?: Record<string, number>;
  /** Mức cảnh báo cao nhất theo roomId */
  roomAlertSeverities?: Record<string, AlertSeverity | undefined>;
  /** Danh sách roomId có cảnh báo tồn đọng lâu chưa xử lý (> overdueAlertMs) */
  overdueRoomIds?: ReadonlySet<string> | readonly string[];
  /** Trạng thái lọc đang kích hoạt từ Dải tóm tắt Quản lý */
  activeStatusFilter?: ManagerStatusFilter;
  /** Bản đồ đánh dấu phòng nào khớp với bộ lọc (phòng không khớp bị làm mờ) */
  roomMatchesFilterMap?: Record<string, boolean>;
  /** Điều khiển viewport từ bên ngoài (dành cho Deep Link / đồng bộ Minimap) */
  viewport?: ViewportTransform;
  /** Khung nhìn khôi phục ban đầu từ Deep Link (giữ nguyên tương tác zoom/fit sau đó) */
  initialViewport?: ViewportTransform | null;
  onViewportChange?: (viewport: ViewportTransform) => void;
  /** Chế độ toàn màn hình (do trang cha truyền vào để giữ Tree/Drawer hoạt động khi fullscreen) */
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  /** Giới hạn chiều cao tối đa theo viewport để bản đồ hiển thị trọn vẹn above-the-fold */
  maxViewportHeightPx?: number;
  /** Theo dõi phòng đang hover */
  onHoverRoomChange?: (room: RoomResponse | null) => void;
  /** Bật tắt hiển thị nút lớp nội thất (dành cho GĐ8) */
  showFurnitureLayer?: boolean;
  /** Danh sách đối tượng nội thất (1:100) cần hiển thị / chỉnh sửa trên tầng */
  furnitureItems?: readonly FurnitureItem[];
  /** Độ mờ lớp nội thất [0..1] (mặc định 0.65) */
  furnitureOpacity?: number;
  /** Chế độ kéo thả/xoay chỉnh sửa nội thất (theo quyền RBAC) */
  furnitureEditMode?: boolean;
  /** Các ID nội thất đang được chọn */
  selectedFurnitureIds?: readonly string[];
  /** Các ID nội thất vi phạm ranh giới hoặc va chạm (hiển thị viền đỏ) */
  invalidFurnitureIds?: ReadonlySet<string> | readonly string[];
  /** Ẩn node phần cứng nhạy cảm (IOT_NODE) ở góc nhìn USER/VIEWER/Kiosk */
  hideSensitiveFurniture?: boolean;
  /** Thư viện định nghĩa đối tượng nội thất (mặc định FURNITURE_CATALOG) */
  furnitureCatalog?: readonly FurnitureCatalogEntry[];
  /** Bật tắt snap lưới 0.25m khi kéo thả nội thất */
  snapFurnitureGrid?: boolean;
  onSelectFurnitureIds?: (ids: string[]) => void;
  onUpdateFurnitureItems?: (items: FurnitureItem[]) => void;
  onCommitFurnitureItems?: (items: FurnitureItem[]) => void;
  /** Chỉ hiện vùng vượt ngưỡng (chế độ lọc ISA-101 Deviation) */
  onlyExceedingThreshold?: boolean;
  /** Chuỗi lịch sử gần nhất theo roomId (để vẽ sparkline trên hover popover) */
  roomTelemetryHistoryMap?: Record<string, readonly number[]>;
  /** Chênh lệch -1h theo roomId để hiển thị mũi tên xu hướng ↑ ↓ → */
  roomDeltaMap?: Record<string, OneHourDeltaResult>;
  /** Trạng thái khởi phát / lan truyền khi phát lại sự kiện */
  playbackRoomStateMap?: Record<string, PlaybackRoomState>;
  /** Bật/tắt popover chi tiết khi di chuột qua phòng */
  showHoverPopover?: boolean;
}

const EMPTY_FURNITURE_ITEMS: readonly FurnitureItem[] = [];
const EMPTY_STRING_IDS: readonly string[] = [];
const EMPTY_DEVICE_TELEMETRY_MAP: Record<string, TelemetryResponse | null | undefined> = {};

export function FloorplanCanvas({
  rooms,
  devices,
  roomTelemetryMap,
  deviceTelemetryMap = EMPTY_DEVICE_TELEMETRY_MAP,
  layer,
  selectedRoomId,
  onSelectRoom,
  onSelectDevice,
  zoomedRoomId: controlledZoomedRoomId,
  onZoomRoomChange,
  selectedBayId,
  onSelectBay,
  showBlindspots = false,
  showReliabilityLayer = false,
  roomReliabilityMap,
  showTechOverlay = false,
  highlightedZoneIds,
  firingRoomIds = EMPTY_STRING_IDS,
  focusedDeviceId = null,
  alertingDeviceIds = EMPTY_STRING_IDS,
  defaultLabelDensity,
  roomAlertCounts,
  roomAlertSeverities,
  overdueRoomIds,
  activeStatusFilter = 'ALL',
  roomMatchesFilterMap,
  viewport: controlledViewport,
  initialViewport = null,
  onViewportChange,
  isFullscreen: controlledFullscreen,
  onToggleFullscreen,
  maxViewportHeightPx,
  onHoverRoomChange,
  showFurnitureLayer = true,
  furnitureItems = EMPTY_FURNITURE_ITEMS,
  furnitureOpacity = 0.65,
  furnitureEditMode = false,
  selectedFurnitureIds = EMPTY_STRING_IDS,
  invalidFurnitureIds,
  hideSensitiveFurniture = false,
  furnitureCatalog = FURNITURE_CATALOG,
  snapFurnitureGrid = true,
  onSelectFurnitureIds,
  onUpdateFurnitureItems,
  onCommitFurnitureItems,
  onlyExceedingThreshold = false,
  roomTelemetryHistoryMap,
  roomDeltaMap,
  playbackRoomStateMap,
  showHoverPopover = true,
}: FloorplanCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const staticCanvasRef = useRef<HTMLCanvasElement>(null);
  const dynamicCanvasRef = useRef<HTMLCanvasElement>(null);

  const [canvasSize, setCanvasSize] = useState<{
    width: number;
    height: number;
  }>({
    width: 960,
    height: Math.round(960 * TQB_BUILDING_ASPECT_RATIO),
  });
  const [hoveredDeviceId, setHoveredDeviceId] = useState<string | null>(null);
  const [hoveredBayId, setHoveredBayId] = useState<string | null>(null);
  const [hoveredRoomId, setHoveredRoomId] = useState<string | null>(null);
  const [labelDensity, setLabelDensity] = useState<LabelDensity>(
    defaultLabelDensity ?? (showTechOverlay ? 'detailed' : 'balanced')
  );
  const [internalZoomedRoomId, setInternalZoomedRoomId] = useState<
    string | null
  >(null);
  const [showCadUnderlay, setShowCadUnderlay] = useState<boolean>(true);
  const [cadImageLoadedFloor, setCadImageLoadedFloor] = useState<number | null>(
    null
  );
  const [internalViewport, setInternalViewport] = useState<ViewportTransform>(
    () => initialViewport ?? { scale: 1, tx: 0, ty: 0 }
  );
  const [internalFullscreen, setInternalFullscreen] = useState<boolean>(false);
  const [roomBadgeAnchors, setRoomBadgeAnchors] = useState<
    Array<{
      roomId: string;
      code: string;
      count: number;
      severity: AlertSeverity | undefined;
      x: number;
      y: number;
    }>
  >([]);

  const activePointersRef = useRef<Map<number, { x: number; y: number }>>(
    new Map()
  );
  const pinchStartRef = useRef<{ dist: number; scale: number } | null>(null);
  const dragMovedDistRef = useRef<number>(0);
  const furnitureDragRef = useRef<{
    itemId: string;
    startClientX: number;
    startClientY: number;
    startNormX: number;
    startNormY: number;
    latestItems: FurnitureItem[];
    moved: boolean;
  } | null>(null);

  const visibleFurnitureItems = useMemo(
    () =>
      filterVisibleFurnitureItems(
        furnitureItems,
        furnitureCatalog,
        hideSensitiveFurniture
      ),
    [furnitureItems, furnitureCatalog, hideSensitiveFurniture]
  );

  const selectedFurnitureSet = useMemo(
    () => new Set(selectedFurnitureIds),
    [selectedFurnitureIds]
  );

  const invalidFurnitureSet = useMemo(
    () =>
      invalidFurnitureIds instanceof Set
        ? invalidFurnitureIds
        : new Set(invalidFurnitureIds ?? []),
    [invalidFurnitureIds]
  );

  useEffect(() => {
    if (defaultLabelDensity) {
      setLabelDensity(defaultLabelDensity);
    }
  }, [defaultLabelDensity]);

  const zoomedRoomId =
    controlledZoomedRoomId !== undefined
      ? controlledZoomedRoomId
      : internalZoomedRoomId;

  const setZoomedRoomId = useCallback(
    (nextId: string | null) => {
      setInternalZoomedRoomId(nextId);
      onZoomRoomChange?.(nextId);
    },
    [onZoomRoomChange]
  );

  // Sync standalone fullscreen state when onToggleFullscreen is not controlled externally
  useEffect(() => {
    if (typeof document === 'undefined' || onToggleFullscreen) return;
    const handleFsChange = () => {
      setInternalFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFsChange);
    };
  }, [onToggleFullscreen]);

  const isFullscreen =
    controlledFullscreen !== undefined
      ? controlledFullscreen
      : internalFullscreen;

  const handleFullscreenToggle = useCallback(async () => {
    if (onToggleFullscreen) {
      onToggleFullscreen();
      return;
    }
    try {
      if (typeof document === 'undefined') return;
      if (document.fullscreenElement) {
        await document.exitFullscreen?.();
        setInternalFullscreen(false);
      } else if (containerRef.current?.requestFullscreen) {
        await containerRef.current.requestFullscreen();
        setInternalFullscreen(true);
      }
    } catch {
      // Ignore fullscreen denial in headless/sandbox environments
    }
  }, [onToggleFullscreen]);

  // Xác định tầng hiện tại từ danh sách phòng
  const activeFloor = useMemo(() => {
    if (rooms.length === 0) return 1;
    const f = rooms[0].floor;
    return f === 0 ? 1 : f;
  }, [rooms]);

  // Cache ảnh SVG lớp nền kiến trúc CAD TQB theo tầng
  const cadImagesRef = useRef<Map<string, HTMLImageElement>>(new Map());
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const svgPath = getFloorCadSvgPath(activeFloor);
    if (cadImagesRef.current.has(svgPath)) {
      setCadImageLoadedFloor(activeFloor);
      return;
    }
    const img = new window.Image();
    img.onload = () => {
      cadImagesRef.current.set(svgPath, img);
      setCadImageLoadedFloor(activeFloor);
    };
    img.src = svgPath;
  }, [activeFloor]);

  // Chuẩn hóa danh sách phòng kèm đa giác TQB thực tế và phân khu bàn đọc (readingBays)
  const enrichedRooms = useMemo(() => {
    return rooms
      .map((room, idx) => {
        const preset = resolveRoomPreset(room, idx);
        const polygon = resolveRoomPolygon(room, idx);
        const roomLatest = roomTelemetryMap[room.id];
        const microZones = synthesizeAnonymousMicroZones(
          room,
          roomLatest,
          idx
        );
        return {
          room,
          idx,
          preset,
          polygon,
          microZones,
        };
      })
      .filter(
        (
          item
        ): item is typeof item & {
          polygon: readonly Point2D[];
        } => Boolean(item.polygon && item.polygon.length >= 3)
      );
  }, [rooms, roomTelemetryMap]);

  const roomById = useMemo(() => {
    const map = new Map<string, RoomResponse>();
    for (const r of rooms) {
      map.set(r.id, r);
    }
    return map;
  }, [rooms]);

  const firingRoomSet = useMemo(
    () => new Set(firingRoomIds),
    [firingRoomIds]
  );

  // Unified Viewport Transform [1.0, 4.0]
  const zoomViewport = useMemo(() => {
    const base = controlledViewport ?? internalViewport;
    const clamped = clampViewportTransform(
      base.scale,
      base.tx,
      base.ty,
      canvasSize.width,
      canvasSize.height,
      ZOOM_CONFIG.maxScale
    );
    return {
      ...clamped,
      isZoomed: clamped.scale > 1.01,
    };
  }, [
    controlledViewport,
    internalViewport,
    canvasSize.width,
    canvasSize.height,
  ]);

  const latestViewportRef = useRef<ViewportTransform & { isZoomed: boolean }>(
    zoomViewport
  );
  latestViewportRef.current = zoomViewport;

  const commitViewport = useCallback(
    (next: ViewportTransform) => {
      const clamped = clampViewportTransform(
        next.scale,
        next.tx,
        next.ty,
        canvasSize.width,
        canvasSize.height,
        ZOOM_CONFIG.maxScale
      );
      latestViewportRef.current = {
        ...clamped,
        isZoomed: clamped.scale > 1.01,
      };
      if (!controlledViewport) {
        setInternalViewport(clamped);
      }
      onViewportChange?.(clamped);
    },
    [
      canvasSize.width,
      canvasSize.height,
      controlledViewport,
      onViewportChange,
    ]
  );

  // Tự fit-to-view khi zoomedRoomId thay đổi
  const prevZoomedRoomIdRef = useRef<string | null>(null);
  const prevFloorRef = useRef<number>(activeFloor);
  const appliedInitialViewportSigRef = useRef<string | null>(null);

  // Khôi phục Viewport từ Deep Link trước các effect auto-fit để không bị ghi đè scale/tx/ty ban đầu
  useEffect(() => {
    if (!initialViewport || controlledViewport) return;
    const sig = `${initialViewport.scale.toFixed(3)}:${initialViewport.tx.toFixed(2)}:${initialViewport.ty.toFixed(2)}`;
    if (appliedInitialViewportSigRef.current === sig) return;
    appliedInitialViewportSigRef.current = sig;
    prevZoomedRoomIdRef.current = zoomedRoomId ?? null;
    prevFloorRef.current = activeFloor;
    commitViewport(initialViewport);
  }, [
    initialViewport,
    controlledViewport,
    zoomedRoomId,
    activeFloor,
    commitViewport,
  ]);

  const roomPolygonsSignature = useMemo(
    () => enrichedRooms.map((er) => er.room.id).join(','),
    [enrichedRooms]
  );

  useEffect(() => {
    if (controlledViewport) return;
    if (!zoomedRoomId) {
      if (prevZoomedRoomIdRef.current !== null) {
        prevZoomedRoomIdRef.current = null;
        commitViewport(fitFloorToViewport());
      }
      return;
    }

    const target = enrichedRooms.find((er) => er.room.id === zoomedRoomId);
    if (!target) return;

    if (prevZoomedRoomIdRef.current !== zoomedRoomId) {
      prevZoomedRoomIdRef.current = zoomedRoomId;
      commitViewport(
        fitPolygonToViewport(
          target.polygon,
          canvasSize.width,
          canvasSize.height,
          ZOOM_CONFIG.roomFitPaddingRatio,
          ZOOM_CONFIG.maxScale
        )
      );
    }
  }, [
    zoomedRoomId,
    roomPolygonsSignature,
    enrichedRooms,
    canvasSize.width,
    canvasSize.height,
    controlledViewport,
    commitViewport,
  ]);

  // Reset viewport về 1x khi chuyển sang tầng mới (trừ khi vừa fit theo deep-link/zoomedRoomId)
  useEffect(() => {
    if (prevFloorRef.current !== activeFloor) {
      prevFloorRef.current = activeFloor;
      if (!zoomedRoomId && !controlledViewport) {
        commitViewport(fitFloorToViewport());
      }
    }
  }, [activeFloor, zoomedRoomId, controlledViewport, commitViewport]);

  const toScreenPx = useCallback(
    (normPt: Point2D): Point2D => {
      const base = normalizedToPixel(normPt, canvasSize.width, canvasSize.height);
      return {
        x: base.x * zoomViewport.scale + zoomViewport.tx,
        y: base.y * zoomViewport.scale + zoomViewport.ty,
      };
    },
    [canvasSize.width, canvasSize.height, zoomViewport]
  );

  const lodConfig = useMemo(
    () => getLodConfig(labelDensity, zoomViewport.scale),
    [labelDensity, zoomViewport.scale]
  );

  // Devices on this floor (Role ADMIN / LIBRARIAN / MAINTENANCE)
  const positionedDevices = useMemo(() => {
    const polygonByRoomId = new Map<string, readonly Point2D[]>();
    for (const item of enrichedRooms) {
      polygonByRoomId.set(item.room.id, item.polygon);
    }
    const perRoomIdx = new Map<string, number>();

    return devices
      .filter((d) => d.roomId && roomById.has(d.roomId))
      .map((d) => {
        if (typeof d.posX === 'number' && typeof d.posY === 'number') {
          return d;
        }
        const poly = polygonByRoomId.get(d.roomId!);
        const center =
          poly && poly.length >= 3
            ? computePolygonCentroid(poly)
            : { x: 0.5, y: 0.5 };
        const idxInRoom = perRoomIdx.get(d.roomId!) ?? 0;
        perRoomIdx.set(d.roomId!, idxInRoom + 1);
        const angle = idxInRoom * 1.25;
        const radius = idxInRoom === 0 ? 0 : 0.022;
        return {
          ...d,
          posX: Number(
            Math.max(0.02, Math.min(0.98, center.x + Math.cos(angle) * radius)).toFixed(4)
          ),
          posY: Number(
            Math.max(0.02, Math.min(0.98, center.y + Math.sin(angle) * radius)).toFixed(4)
          ),
        };
      });
  }, [devices, roomById, enrichedRooms]);

  const alertingDeviceSet = useMemo(
    () => new Set(alertingDeviceIds),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [alertingDeviceIds.join('|')]
  );

  const overdueRoomSet = useMemo(
    () =>
      overdueRoomIds instanceof Set
        ? overdueRoomIds
        : new Set(overdueRoomIds ?? []),
    [overdueRoomIds]
  );

  // Spatial clustering of dense device pins at low zoom levels (< 1.55x)
  const deviceClusters = useMemo<Array<DeviceCluster<DeviceResponse>>>(() => {
    const inputs = positionedDevices.map((device) => {
      const screenPx = toScreenPx({ x: device.posX!, y: device.posY! });
      const isAlerting =
        alertingDeviceSet.has(device.id) ||
        alertingDeviceSet.has(device.hardwareId);
      const roomHasAlert = Boolean(
        device.roomId &&
          ((roomAlertCounts?.[device.roomId] ?? 0) > 0 ||
            firingRoomSet.has(device.roomId))
      );
      const roomSeverity = device.roomId
        ? roomAlertSeverities?.[device.roomId]
        : undefined;
      const severity =
        isAlerting || (roomHasAlert && alertingDeviceSet.size === 0)
          ? (roomSeverity ?? 'HIGH')
          : null;
      const isFocused = Boolean(
        focusedDeviceId &&
          (device.id === focusedDeviceId ||
            device.hardwareId === focusedDeviceId)
      );

      return {
        device,
        screenPx,
        severity,
        isAlerting: isAlerting || Boolean(severity),
        isFocused,
      };
    });

    return clusterDeviceNodes(inputs, zoomViewport.scale, {
      clusterRadiusPx: FLOORPLAN_INTERACTION_CONFIG.clusterRadiusPx,
      maxClusterScale: lodConfig.clusterSensors
        ? FLOORPLAN_INTERACTION_CONFIG.clusterMaxScale
        : 0,
      canvasWidth: canvasSize.width,
      canvasHeight: canvasSize.height,
    });
  }, [
    positionedDevices,
    toScreenPx,
    alertingDeviceSet,
    roomAlertCounts,
    roomAlertSeverities,
    firingRoomSet,
    focusedDeviceId,
    zoomViewport.scale,
    lodConfig.clusterSensors,
    canvasSize.width,
    canvasSize.height,
  ]);

  const handleClusterExpand = useCallback(
    (centroidNorm: Point2D, targetScale: number) => {
      const basePx = normalizedToPixel(
        centroidNorm,
        canvasSize.width,
        canvasSize.height
      );
      const rawTx = canvasSize.width * 0.5 - basePx.x * targetScale;
      const rawTy = canvasSize.height * 0.5 - basePx.y * targetScale;
      commitViewport(
        clampViewportTransform(
          targetScale,
          rawTx,
          rawTy,
          canvasSize.width,
          canvasSize.height,
          ZOOM_CONFIG.maxScale
        )
      );
    },
    [canvasSize.width, canvasSize.height, commitViewport]
  );

  // Wayfinding architectural landmarks on this floor (Stairs, Elevators, WC, Gate)
  const floorLandmarks = useMemo(
    () =>
      getFloorLandmarks(activeFloor).filter((lm) => lm.kind !== 'ATRIUM'),
    [activeFloor]
  );

  // Anonymous Reading Bays
  const visibleAnonymousBays = useMemo(() => {
    const items: Array<{ bay: AnonymousMicroZone; room: RoomResponse }> = [];
    for (const { room, preset, microZones } of enrichedRooms) {
      const roomHasDevices = positionedDevices.some(
        (d) => d.roomId === room.id
      );
      const isFocused = room.id === zoomedRoomId || room.id === selectedRoomId;
      const isLargeRoom = (preset?.areaM2 ?? 100) >= 120;

      if (!roomHasDevices && (isLargeRoom || isFocused)) {
        for (const bay of microZones) {
          items.push({ bay, room });
        }
      }
    }
    return items;
  }, [enrichedRooms, positionedDevices, zoomedRoomId, selectedRoomId]);

  // Animated smooth values map (TIMING_CONFIG.transitionDurationMs = 450ms, reduced-motion aware)
  const animValuesRef = useRef<Map<string, AnimatedMetricState>>(new Map());
  const prevLayerRef = useRef(layer);

  useEffect(() => {
    const layerChanged = prevLayerRef.current !== layer;
    prevLayerRef.current = layer;

    const prefersReducedMotion = isReducedMotionPreferred();
    const now = performance.now();
    const roomCounts = new Map<string, number>();
    for (const d of devices) {
      if (d.roomId) {
        roomCounts.set(d.roomId, (roomCounts.get(d.roomId) ?? 0) + 1);
      }
    }
    for (const dev of devices) {
      const devTel = resolveDeviceTelemetry(
        dev,
        deviceTelemetryMap,
        roomTelemetryMap,
        dev.roomId ? (roomCounts.get(dev.roomId) ?? 1) : 1
      );
      const targetVal = extractLayerMetricValue(devTel, layer);
      if (targetVal !== null && Number.isFinite(targetVal)) {
        const nextState = updateAnimatedMetricState(
          animValuesRef.current.get(dev.id),
          targetVal,
          now,
          prefersReducedMotion,
          TIMING_CONFIG.transitionDurationMs,
          layerChanged
        );
        animValuesRef.current.set(dev.id, nextState);
      }
    }
  }, [devices, deviceTelemetryMap, roomTelemetryMap, layer]);

  // Observe container resize for responsive HiDPI rendering keeping exact 76.0m × 57.2m aspect ratio
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return;
      const containerW = Math.max(320, Math.floor(rect.width));
      const maxH =
        maxViewportHeightPx && maxViewportHeightPx > 320
          ? maxViewportHeightPx
          : Infinity;
      let width = containerW;
      let height = Math.max(
        240,
        Math.floor(width * TQB_BUILDING_ASPECT_RATIO)
      );
      if (height > maxH) {
        height = Math.floor(maxH);
        width = Math.max(320, Math.floor(height / TQB_BUILDING_ASPECT_RATIO));
      }
      setCanvasSize((prev) =>
        prev.width === width && prev.height === height
          ? prev
          : { width, height }
      );
    };

    updateSize();
    const observer =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(updateSize)
        : null;
    observer?.observe(el);
    window.addEventListener('resize', updateSize);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updateSize);
    };
  }, [maxViewportHeightPx]);

  // Cập nhật kích thước buffer Canvas HiDPI CHỈ khi canvasSize hoặc DPR thay đổi (KHÔNG gán lại mỗi frame rAF)
  useEffect(() => {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const targetW = Math.floor(canvasSize.width * dpr);
    const targetH = Math.floor(canvasSize.height * dpr);

    for (const c of [staticCanvasRef.current, dynamicCanvasRef.current]) {
      if (!c) continue;
      if (c.width !== targetW) c.width = targetW;
      if (c.height !== targetH) c.height = targetH;
      c.style.width = `${canvasSize.width}px`;
      c.style.height = `${canvasSize.height}px`;
    }
  }, [canvasSize]);

  // Non-passive Wheel listener cho phóng to/thu nhỏ mượt quanh con trỏ chuột
  useEffect(() => {
    const canvas = dynamicCanvasRef.current;
    if (!canvas) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const focalPx: Point2D = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };
      const current = latestViewportRef.current;
      const factor =
        e.deltaY < 0
          ? 1 + ZOOM_CONFIG.wheelStep
          : 1 / (1 + ZOOM_CONFIG.wheelStep);
      const nextScale = current.scale * factor;
      const nextVp = zoomViewportAtPoint(
        current,
        nextScale,
        focalPx,
        canvasSize.width,
        canvasSize.height,
        ZOOM_CONFIG.maxScale
      );
      if (nextVp.scale <= 1.001 && zoomedRoomId) {
        setZoomedRoomId(null);
      }
      commitViewport(nextVp);
    };

    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      canvas.removeEventListener('wheel', handleWheel);
    };
  }, [
    canvasSize.width,
    canvasSize.height,
    commitViewport,
    zoomedRoomId,
    setZoomedRoomId,
  ]);

  // ============================================================================
  // LAYER 1: STATIC BASE CANVAS (Background, Grid, Atrium, CAD SVG Underlay)
  // Chỉ vẽ lại khi tầng / zoom / kích thước / bật-tắt CAD thay đổi. KHÔNG vẽ lại khi telemetry đổi 1Hz!
  // ============================================================================
  useEffect(() => {
    const canvas = staticCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const { width, height } = canvasSize;
    const targetW = Math.floor(width * dpr);
    const targetH = Math.floor(height * dpr);
    if (canvas.width !== targetW) canvas.width = targetW;
    if (canvas.height !== targetH) canvas.height = targetH;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // Architectural Blueprint Background
    ctx.fillStyle = '#0B1120';
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.translate(zoomViewport.tx, zoomViewport.ty);
    ctx.scale(zoomViewport.scale, zoomViewport.scale);

    // Coordinate grid (10m x 10m reference)
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.08)';
    ctx.lineWidth = 1 / zoomViewport.scale;
    const gridStepX = width / 7.6;
    const gridStepY = height / 5.72;
    for (let gx = gridStepX; gx < width; gx += gridStepX) {
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, height);
      ctx.stroke();
    }
    for (let gy = gridStepY; gy < height; gy += gridStepY) {
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(width, gy);
      ctx.stroke();
    }

    // Central Atrium Void (Floors 2..5)
    if (activeFloor >= 2) {
      const atriumX = 0.312 * width;
      const atriumY = 0.405 * height;
      const atriumW = 0.376 * width;
      const atriumH = 0.254 * height;
      const radius = Math.min(atriumW, atriumH) * 0.46;

      ctx.save();
      ctx.beginPath();
      ctx.roundRect?.(atriumX, atriumY, atriumW, atriumH, radius);
      ctx.fillStyle = 'rgba(2, 6, 23, 0.72)';
      ctx.fill();
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1.4 / zoomViewport.scale;
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.35)';
      ctx.stroke();
      ctx.setLineDash([]);

      if (lodConfig.showAtriumText) {
        ctx.font = `600 ${Math.max(9, Math.round(10.5 / Math.sqrt(zoomViewport.scale)))}px Inter, system-ui, sans-serif`;
        ctx.fillStyle =
          labelDensity === 'balanced' && !zoomViewport.isZoomed
            ? 'rgba(148, 163, 184, 0.38)'
            : 'rgba(148, 163, 184, 0.55)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('GIẾNG TRỜI', 0.5 * width, 0.532 * height);
      }
      ctx.restore();
    }

    // Authentic TQB Architectural CAD Underlay
    if (showCadUnderlay) {
      const svgPath = getFloorCadSvgPath(activeFloor);
      const cadImg = cadImagesRef.current.get(svgPath);
      if (cadImg) {
        ctx.save();
        ctx.globalAlpha = zoomViewport.isZoomed ? 0.68 : 0.52;
        ctx.drawImage(cadImg, 0, 0, width, height);
        ctx.restore();
      }
    }

    // Architectural Furniture Layer (1:100 real-world meters, isolated to Layer 1 StaticBaseCanvas)
    if (
      showFurnitureLayer &&
      (furnitureEditMode || lodConfig.showFurniture) &&
      visibleFurnitureItems.length > 0
    ) {
      const clampedOpacity = Math.max(0, Math.min(1, furnitureOpacity));
      const detailLevel = furnitureEditMode || lodConfig.showDetailedFurniture;

      for (const item of visibleFurnitureItems) {
        const entry = resolveFurnitureCatalogEntry(item.typeId, furnitureCatalog);
        const cornersNorm = getFurnitureObbCornersNorm(item);
        const cornersPx = cornersNorm.map((pt) =>
          normalizedToPixel(pt, width, height)
        );
        const centerPx = normalizedToPixel({ x: item.x, y: item.y }, width, height);
        const isSelected = selectedFurnitureSet.has(item.id);
        const isInvalid = invalidFurnitureSet.has(item.id);

        ctx.save();
        ctx.globalAlpha = clampedOpacity;

        ctx.beginPath();
        ctx.moveTo(cornersPx[0].x, cornersPx[0].y);
        ctx.lineTo(cornersPx[1].x, cornersPx[1].y);
        ctx.lineTo(cornersPx[2].x, cornersPx[2].y);
        ctx.lineTo(cornersPx[3].x, cornersPx[3].y);
        ctx.closePath();

        ctx.fillStyle = isInvalid
          ? 'rgba(127, 29, 29, 0.72)'
          : entry.fillColor;
        ctx.fill();

        ctx.lineWidth = (isSelected || isInvalid ? 2.2 : 1.1) / zoomViewport.scale;
        ctx.strokeStyle = isInvalid
          ? '#EF4444'
          : isSelected
            ? '#38BDF8'
            : item.locked
              ? '#F59E0B'
              : entry.strokeColor;
        ctx.stroke();

        // Architectural detail strokes at Detail zoom / Edit mode
        if (detailLevel) {
          if (entry.shape === 'bookshelf') {
            const midLeftX = (cornersPx[0].x + cornersPx[3].x) * 0.5;
            const midLeftY = (cornersPx[0].y + cornersPx[3].y) * 0.5;
            const midRightX = (cornersPx[1].x + cornersPx[2].x) * 0.5;
            const midRightY = (cornersPx[1].y + cornersPx[2].y) * 0.5;
            ctx.beginPath();
            ctx.moveTo(midLeftX, midLeftY);
            ctx.lineTo(midRightX, midRightY);
            ctx.stroke();
          } else if (entry.shape === 'desk_cluster') {
            const topMidX = (cornersPx[0].x + cornersPx[1].x) * 0.5;
            const topMidY = (cornersPx[0].y + cornersPx[1].y) * 0.5;
            const botMidX = (cornersPx[3].x + cornersPx[2].x) * 0.5;
            const botMidY = (cornersPx[3].y + cornersPx[2].y) * 0.5;
            ctx.beginPath();
            ctx.moveTo(topMidX, topMidY);
            ctx.lineTo(botMidX, botMidY);
            ctx.stroke();
          } else if (entry.shape === 'door_swing') {
            ctx.beginPath();
            ctx.moveTo(cornersPx[0].x, cornersPx[0].y);
            ctx.lineTo(cornersPx[2].x, cornersPx[2].y);
            ctx.stroke();
          } else if (entry.shape === 'sensor_node') {
            const rPx = Math.max(
              3,
              Math.min(
                10,
                Math.hypot(
                  cornersPx[1].x - cornersPx[0].x,
                  cornersPx[1].y - cornersPx[0].y
                ) * 0.38
              )
            );
            ctx.beginPath();
            ctx.arc(centerPx.x, centerPx.y, rPx, 0, Math.PI * 2);
            ctx.stroke();
          }

          if (item.label) {
            const labelFont = Math.max(
              7,
              Math.min(11, Math.round(9 / zoomViewport.scale))
            );
            ctx.font = `600 ${labelFont}px Inter, system-ui, sans-serif`;
            ctx.fillStyle = '#F8FAFC';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(item.label, centerPx.x, centerPx.y);
          }
        }

        ctx.restore();
      }
    }

    ctx.restore();
    ctx.restore();
  }, [
    canvasSize,
    activeFloor,
    showCadUnderlay,
    cadImageLoadedFloor,
    zoomViewport,
    lodConfig.showAtriumText,
    lodConfig.showFurniture,
    lodConfig.showDetailedFurniture,
    labelDensity,
    showFurnitureLayer,
    visibleFurnitureItems,
    furnitureOpacity,
    furnitureEditMode,
    selectedFurnitureSet,
    invalidFurnitureSet,
    furnitureCatalog,
  ]);

  // ============================================================================
  // LAYER 2: DYNAMIC HEATMAP & ALERT HIGHLIGHTS CANVAS
  // ============================================================================
  useEffect(() => {
    const canvas = dynamicCanvasRef.current;
    if (!canvas) return;

    let rafId = 0;
    let isCancelled = false;

    const render = () => {
      if (isCancelled) return;

      const now = performance.now();
      let isTransitioning = false;
      for (const state of animValuesRef.current.values()) {
        if (evaluateAnimatedMetricState(state, now).transitioning) {
          isTransitioning = true;
        }
      }

      const dpr =
        typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
      const { width, height } = canvasSize;
      const targetW = Math.floor(width * dpr);
      const targetH = Math.floor(height * dpr);
      if (canvas.width !== targetW) canvas.width = targetW;
      if (canvas.height !== targetH) canvas.height = targetH;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const normToScreen = (normPt: Point2D): Point2D => {
        const base = normalizedToPixel(normPt, width, height);
        return {
          x: base.x * zoomViewport.scale + zoomViewport.tx,
          y: base.y * zoomViewport.scale + zoomViewport.ty,
        };
      };

      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      // Apply Zoom Camera Transform
      ctx.save();
      ctx.translate(zoomViewport.tx, zoomViewport.ty);
      ctx.scale(zoomViewport.scale, zoomViewport.scale);

      interface PreparedRoomLabel {
        roomId: string;
        anchorScreen: Point2D;
        screenPolygon: Point2D[];
        areaM2: number;
        isSelected: boolean;
        isZoomTarget: boolean;
        hasAlert: boolean;
        alertCount: number;
        alertSeverity: AlertSeverity | undefined;
        hasOnlineTelemetry: boolean;
        isDimmed: boolean;
        style: RoomLabelStyle;
        shouldPlaceInPass: boolean;
        shortCode: string;
        compactText: string;
        titleLine: string;
        subLine: string;
        techWarningText: string | null;
        priority: number;
      }

      const preparedLabels: PreparedRoomLabel[] = [];
      const alertingRoomOutlines: Array<{
        roomId: string;
        pixelVertices: Point2D[];
        severity: AlertSeverity | undefined;
      }> = [];
      const playbackRoomOutlines: Array<{
        roomId: string;
        pixelVertices: Point2D[];
        role: 'ORIGIN' | 'SPREAD';
      }> = [];

      // Render each room polygon with strict ctx.clip() & area-adaptive Gaussian diffusion
      for (const {
        room,
        preset,
        polygon,
        microZones,
      } of enrichedRooms) {
        const pixelVertices = polygon.map((pt) =>
          normalizedToPixel(pt, width, height)
        );

        const roomDevices = devices.filter((d) => d.roomId === room.id);
        const onlineDevices = roomDevices.filter(
          (d) => d.online || d.connectionState === 'ONLINE'
        );
        const roomLatest = roomTelemetryMap[room.id];
        const roomMetricValue = extractLayerMetricValue(roomLatest, layer);
        const roomReliability = roomReliabilityMap?.[room.id];
        const oneHourDelta = roomDeltaMap?.[room.id];
        const playbackState = playbackRoomStateMap?.[room.id];
        const isSyntheticRoom =
          room.id.startsWith('PRESET_') || Boolean(roomLatest?.isSynthetic);
        const roomIsStale = Boolean(
          roomReliability
            ? roomReliability.state === 'STALE'
            : isTelemetryStale(roomLatest?.timestamp, Date.now(), isSyntheticRoom)
        );
        const roomIsBlindspot =
          roomReliability?.state === 'BLINDSPOT' ||
          (roomDevices.length > 0 && onlineDevices.length === 0);

        const idwSamples: IdwSamplePoint[] = [];
        for (const dev of onlineDevices) {
          if (typeof dev.posX === 'number' && typeof dev.posY === 'number') {
            const devTel = resolveDeviceTelemetry(
              dev,
              deviceTelemetryMap,
              roomTelemetryMap,
              roomDevices.length
            );
            const val = extractLayerMetricValue(devTel, layer);
            const animEntry = animValuesRef.current.get(dev.id);
            const smoothVal = animEntry ? animEntry.current : val;

            if (smoothVal !== null && Number.isFinite(smoothVal)) {
              idwSamples.push({
                x: dev.posX,
                y: dev.posY,
                value: smoothVal,
                online: true,
              });
            }
          }
        }

        if (
          idwSamples.length === 0 &&
          roomMetricValue !== null &&
          roomDevices.length === 0 &&
          microZones.length > 0 &&
          !(showReliabilityLayer && isSyntheticRoom)
        ) {
          for (const bay of microZones) {
            const bayVal = bay.metrics[layer];
            if (typeof bayVal === 'number' && Number.isFinite(bayVal)) {
              idwSamples.push({
                x: bay.posX,
                y: bay.posY,
                value: bayVal,
                online: true,
              });
            }
          }
        }

        const hasOnlineTelemetry =
          (roomDevices.length === 0 && roomMetricValue !== null) ||
          (onlineDevices.length > 0 &&
            (idwSamples.length > 0 || roomMetricValue !== null)) ||
          roomMetricValue !== null;

        const openAlertCount =
          roomAlertCounts?.[room.id] ?? (firingRoomSet.has(room.id) ? 1 : 0);
        const hasAlert = openAlertCount > 0 || firingRoomSet.has(room.id);
        const alertSeverity = roomAlertSeverities?.[room.id];

        const primaryValue =
          idwSamples.length > 0
            ? idwSamples.reduce((sum, s) => sum + s.value, 0) /
              idwSamples.length
            : roomMetricValue;

        const effectiveRoomType =
          preset?.roomType ?? room.type ?? 'STUDY_ROOM';
        const metricStatus = getMetricStatusSymbol(
          layer,
          primaryValue,
          effectiveRoomType,
          room.thresholds
        );
        const roomExceedsThreshold =
          metricStatus.isExceedingThreshold || hasAlert;
        const isSuppressedNormalRoom =
          onlyExceedingThreshold && !roomExceedsThreshold;

        const isDimmed = Boolean(
          (activeStatusFilter &&
            activeStatusFilter !== 'ALL' &&
            roomMatchesFilterMap &&
            roomMatchesFilterMap[room.id] === false) ||
            isSuppressedNormalRoom
        );

        ctx.save();
        if (isDimmed) {
          ctx.globalAlpha = isSuppressedNormalRoom
            ? 0.35
            : FLOORPLAN_INTERACTION_CONFIG.dimmedRoomOpacity;
        }

        renderWeatherDiffusionHeatmap(
          ctx,
          pixelVertices,
          idwSamples,
          layer,
          width,
          height,
          roomMetricValue,
          0.26,
          {
            normalizedPolygon: polygon,
            showBlindspots,
            reliabilityMode: showReliabilityLayer,
            roomIsStale,
            roomIsReferencePreset: isSyntheticRoom,
            roomIsBlindspot,
            skipDarkBase: true,
            onlyExceedingThreshold,
            roomExceedsThreshold,
          }
        );

        // Draw Measured Direct-Coverage Concentric Rings around ONLINE devices when Reliability Layer is active
        if (showReliabilityLayer && !roomIsStale && onlineDevices.length > 0) {
          ctx.save();
          const scaleFactor = Math.sqrt(zoomViewport.scale);
          for (const dev of onlineDevices) {
            if (typeof dev.posX !== 'number' || typeof dev.posY !== 'number') {
              continue;
            }
            const devPx = normalizedToPixel(
              { x: dev.posX, y: dev.posY },
              width,
              height
            );
            ctx.setLineDash([]);
            ctx.lineWidth = 1.2 / scaleFactor;
            ctx.strokeStyle = 'rgba(56, 189, 248, 0.72)';
            ctx.beginPath();
            ctx.arc(devPx.x, devPx.y, 11 / scaleFactor, 0, Math.PI * 2);
            ctx.stroke();

            ctx.setLineDash([2, 2]);
            ctx.strokeStyle = 'rgba(186, 230, 253, 0.45)';
            ctx.beginPath();
            ctx.arc(devPx.x, devPx.y, 18 / scaleFactor, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.setLineDash([]);
          ctx.restore();
        }

        // Draw Architectural Wall Stroke, BTCT Columns & Door
        const isSelected = room.id === selectedRoomId;
        const isZoomTarget = room.id === zoomedRoomId;
        const isZoneHighlighted =
          highlightedZoneIds &&
          highlightedZoneIds.length > 0 &&
          preset &&
          highlightedZoneIds.includes(preset.zoneCode);

        const wallColor = !hasOnlineTelemetry
          ? '#64748B'
          : roomIsStale
            ? '#94A3B8'
            : isSuppressedNormalRoom
              ? 'rgba(100, 116, 139, 0.55)'
              : getContinuousMetricColorCss(layer, primaryValue);

        ctx.beginPath();
        pixelVertices.forEach((p, vIdx) => {
          if (vIdx === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        });
        ctx.closePath();

        const useDashedReliabilityBorder =
          roomIsStale ||
          (showReliabilityLayer &&
            (roomReliability?.state === 'BLINDSPOT' ||
              roomReliability?.state === 'INTERPOLATED' ||
              roomIsBlindspot));

        if (isSelected || isZoomTarget) {
          ctx.setLineDash([]);
          ctx.lineWidth = 3.2 / Math.sqrt(zoomViewport.scale);
          ctx.strokeStyle = '#38BDF8';
        } else if (isZoneHighlighted) {
          ctx.setLineDash([]);
          ctx.lineWidth = 2.6 / Math.sqrt(zoomViewport.scale);
          ctx.strokeStyle = '#F59E0B';
        } else {
          ctx.setLineDash(useDashedReliabilityBorder ? [5, 4] : []);
          ctx.lineWidth = 1.8 / Math.sqrt(zoomViewport.scale);
          ctx.strokeStyle = wallColor;
        }
        ctx.stroke();
        ctx.setLineDash([]);

        if (hasAlert) {
          alertingRoomOutlines.push({
            roomId: room.id,
            pixelVertices,
            severity: alertSeverity,
          });
        }
        if (
          playbackState?.propagationRole === 'ORIGIN' ||
          playbackState?.propagationRole === 'SPREAD'
        ) {
          playbackRoomOutlines.push({
            roomId: room.id,
            pixelVertices,
            role: playbackState.propagationRole,
          });
        }

        // Structural Columns (BTCT) & Door Opening (CUA)
        if (
          preset?.structuralColumns &&
          (zoomViewport.isZoomed || preset.areaM2 >= 250)
        ) {
          for (const colPt of preset.structuralColumns) {
            const colPx = normalizedToPixel(colPt, width, height);
            ctx.beginPath();
            ctx.arc(colPx.x, colPx.y, 4.2, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(226, 232, 240, 0.45)';
            ctx.fill();
            ctx.lineWidth = 1.2 / zoomViewport.scale;
            ctx.strokeStyle = '#F8FAFC';
            ctx.stroke();
          }
        }

        if (preset?.doorPosition && (zoomViewport.isZoomed || isSelected)) {
          const doorPx = normalizedToPixel(preset.doorPosition, width, height);
          ctx.beginPath();
          ctx.arc(doorPx.x, doorPx.y, 5, 0, Math.PI * 2);
          ctx.fillStyle = '#38BDF8';
          ctx.fill();
          ctx.lineWidth = 1.5 / zoomViewport.scale;
          ctx.strokeStyle = '#0F172A';
          ctx.stroke();
        }

        // Focus Details: Reading Bays inside zoomed room
        if (isZoomTarget && microZones.length > 1) {
          for (const bay of microZones) {
            const bayPx = normalizedToPixel(
              { x: bay.posX, y: bay.posY },
              width,
              height
            );
            const isBaySelected = bay.bayId === selectedBayId;
            ctx.save();
            ctx.beginPath();
            ctx.arc(bayPx.x, bayPx.y, isBaySelected ? 34 : 26, 0, Math.PI * 2);
            ctx.setLineDash([4, 3]);
            ctx.lineWidth = (isBaySelected ? 2 : 1.2) / zoomViewport.scale;
            ctx.strokeStyle = isBaySelected
              ? '#38BDF8'
              : 'rgba(226, 232, 240, 0.45)';
            ctx.stroke();
            ctx.restore();
          }
        }

        ctx.restore(); // restore room dimming alpha

        // Collect label metadata for screen-space decluttered pass
        const centroidNorm = computePolygonCentroid(polygon);
        const anchorScreen = normToScreen(centroidNorm);
        const screenPolygon = polygon.map(normToScreen);
        const areaM2 =
          preset?.areaM2 ??
          Math.round(Math.abs(computePolygonSignedArea(polygon)) * 4347.2);

        const codeLabel = preset?.code ?? room.code;
        const shortCode = codeLabel.replace(/^TQB_/, 'P.');
        const metricLabel = hasOnlineTelemetry
          ? formatLayerMetricValue(primaryValue, layer)
          : 'Offline';
        const statusPrefix =
          metricStatus.level !== 'NO_DATA' && metricStatus.level !== 'NORMAL'
            ? `${metricStatus.symbol} `
            : '';
        const stalePrefix =
          roomIsStale && (showReliabilityLayer || !isSyntheticRoom) ? '⌛ ' : '';
        const playbackPrefix =
          playbackState?.propagationRole === 'ORIGIN'
            ? '★#1 '
            : playbackState?.propagationRole === 'SPREAD' && playbackState.rank
              ? `#${playbackState.rank} `
              : '';
        const deltaSuffix = oneHourDelta?.hasBaseline
          ? ` ${oneHourDelta.text}`
          : '';
        const compactText = isSyntheticRoom
          ? `${playbackPrefix}${stalePrefix}${statusPrefix}${shortCode} · ${metricLabel}${deltaSuffix} (MP)`
          : `${playbackPrefix}${stalePrefix}${statusPrefix}${shortCode} · ${metricLabel}${deltaSuffix}`;

        const values = idwSamples.map((s) => s.value);
        const minVal = values.length > 1 ? Math.min(...values) : null;
        const maxVal = values.length > 1 ? Math.max(...values) : null;
        const spreadText =
          minVal !== null &&
          maxVal !== null &&
          Math.abs(maxVal - minVal) >= 0.3
            ? `${minVal.toFixed(1)}–${maxVal.toFixed(1)}`
            : `${areaM2.toFixed(0)} m²`;

        let techWarningText: string | null = null;
        if (showTechOverlay && (lodConfig.showTechWarning || isSelected)) {
          const blindspot = computeRoomBlindspotRatio(polygon, idwSamples);
          if (blindspot.isUnderCovered) {
            techWarningText = `Vùng mù ${Math.round(blindspot.blindspotRatio * 100)}%`;
          } else if (
            layer === 'temperature' &&
            minVal !== null &&
            maxVal !== null &&
            maxVal - minVal >= 2.2
          ) {
            techWarningText = `ΔT ${(maxVal - minVal).toFixed(1)}°C`;
          }
        }

        const titleLine = isSyntheticRoom
          ? `${playbackPrefix}${codeLabel} · Mô phỏng`
          : `${playbackPrefix}${codeLabel}`;
        const baseSubLine = oneHourDelta
          ? `${stalePrefix}${statusPrefix}${metricLabel} (${oneHourDelta.text})`
          : zoomViewport.scale >= ZOOM_CONFIG.overviewMaxScale && spreadText
            ? `${stalePrefix}${statusPrefix}${metricLabel} · ${spreadText}`
            : `${stalePrefix}${statusPrefix}${metricLabel}`;
        const subLine = playbackState?.propagationLabelVi
          ? `${baseSubLine} · ${playbackState.propagationLabelVi}`
          : baseSubLine;

        let effectiveStyle: RoomLabelStyle = lodConfig.roomLabel;
        if (zoomedRoomId) {
          effectiveStyle = isZoomTarget ? 'rich' : 'code';
        } else if (isSelected && effectiveStyle === 'code') {
          effectiveStyle = 'pill';
        }

        const shouldPlaceInPass =
          isZoomTarget ||
          isSelected ||
          hasAlert ||
          playbackState?.propagationRole === 'ORIGIN' ||
          playbackState?.propagationRole === 'SPREAD' ||
          areaM2 >= lodConfig.hideSmallRoomsUnderM2;

        const priority = computeRoomLabelPriority({
          isZoomTarget,
          alertSeverity:
            playbackState?.propagationRole === 'ORIGIN'
              ? 'CRITICAL'
              : alertSeverity,
          hasAlert:
            hasAlert ||
            playbackState?.propagationRole === 'ORIGIN' ||
            playbackState?.propagationRole === 'SPREAD',
          isSelected,
          areaM2,
        });

        preparedLabels.push({
          roomId: room.id,
          anchorScreen,
          screenPolygon,
          areaM2,
          isSelected,
          isZoomTarget,
          hasAlert,
          alertCount: openAlertCount,
          alertSeverity,
          hasOnlineTelemetry,
          isDimmed,
          style: effectiveStyle,
          shouldPlaceInPass,
          shortCode,
          compactText,
          titleLine,
          subLine,
          techWarningText,
          priority,
        });
      }

      // Draw Event Playback Origin (#1) / Spread (#2+) highlights
      for (const pbOutline of playbackRoomOutlines) {
        const isOrigin = pbOutline.role === 'ORIGIN';
        ctx.save();
        ctx.beginPath();
        pbOutline.pixelVertices.forEach((p, vIdx) => {
          if (vIdx === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        });
        ctx.closePath();
        ctx.lineWidth = (isOrigin ? 5.5 : 3.5) / Math.sqrt(zoomViewport.scale);
        ctx.strokeStyle = isOrigin
          ? 'rgba(244, 63, 94, 0.5)'
          : 'rgba(245, 158, 11, 0.35)';
        ctx.stroke();

        ctx.setLineDash(isOrigin ? [] : [5, 3]);
        ctx.lineWidth = (isOrigin ? 2.6 : 2.0) / Math.sqrt(zoomViewport.scale);
        ctx.strokeStyle = isOrigin ? '#E11D48' : '#D97706';
        ctx.stroke();
        ctx.restore();
      }

      // Draw Highlighted Double Borders for Alerting Rooms ABOVE normal room borders
      for (const alertOutline of alertingRoomOutlines) {
        const isSevere =
          alertOutline.severity === 'CRITICAL' ||
          alertOutline.severity === 'HIGH' ||
          !alertOutline.severity;
        const mainColor = isSevere ? '#EF4444' : '#F59E0B';
        const haloColor = isSevere
          ? 'rgba(239, 68, 68, 0.36)'
          : 'rgba(245, 158, 11, 0.32)';

        ctx.save();
        ctx.beginPath();
        alertOutline.pixelVertices.forEach((p, vIdx) => {
          if (vIdx === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        });
        ctx.closePath();

        // Outer soft halo
        ctx.lineWidth = 7.0 / Math.sqrt(zoomViewport.scale);
        ctx.strokeStyle = haloColor;
        ctx.stroke();

        // Crisp inner high-contrast alert boundary
        ctx.lineWidth = 2.6 / Math.sqrt(zoomViewport.scale);
        ctx.strokeStyle = mainColor;
        ctx.stroke();

        // Inner highlight hairline (double border)
        ctx.lineWidth = 1.0 / Math.sqrt(zoomViewport.scale);
        ctx.strokeStyle = '#FEE2E2';
        ctx.stroke();
        ctx.restore();
      }

      ctx.restore(); // End zoom camera transform (back to screen-space)

      // Screen-Space Decluttered Room Labels Pass
      const obstacles: Obstacle[] = [];

      if (lodConfig.showSensors) {
        for (const cluster of deviceClusters) {
          const px = cluster.centroidScreen;
          if (px.x < -20 || px.x > width + 20 || px.y < -20 || px.y > height + 20)
            continue;
          if (cluster.isCluster) {
            obstacles.push({
              x: px.x,
              y: px.y,
              r: Math.max(16, Math.round(lodConfig.nodeVisualSizePx * 0.5) + 6),
            });
          } else {
            const dev = cluster.devices[0];
            const isInZoomedRoom =
              zoomViewport.isZoomed && dev.roomId === zoomedRoomId;
            const isPin = zoomedRoomId
              ? isInZoomedRoom
              : lodConfig.sensorStyle === 'pin';
            obstacles.push({
              x: px.x,
              y: isPin ? px.y + 6 : px.y,
              r: isPin
                ? Math.max(18, Math.round(lodConfig.nodeVisualSizePx * 0.5) + 8)
                : Math.round(lodConfig.nodeVisualSizePx * 0.5) + 4,
            });
          }
        }
      }

      if (lodConfig.bayStyle !== 'hidden') {
        for (const { bay } of visibleAnonymousBays) {
          const px = normToScreen({ x: bay.posX, y: bay.posY });
          if (px.x < 0 || px.x > width || px.y < 0 || px.y > height) continue;
          const isPill =
            lodConfig.bayStyle === 'pill' || bay.bayId === selectedBayId;
          obstacles.push({
            x: px.x,
            y: px.y,
            r: isPill ? 24 : 9,
          });
        }
      }

      for (const lm of floorLandmarks) {
        const px = normToScreen(lm.position);
        if (px.x < 0 || px.x > width || px.y < 0 || px.y > height) continue;
        obstacles.push({
          x: px.x,
          y: px.y,
          r: lodConfig.showLandmarkText ? 22 : 12,
        });
      }

      const labelFontPx = lodConfig.fontSizePx; // clamped strictly [10px, 14px]
      const richTitleFontPx = Math.min(14, Number((labelFontPx + 1.5).toFixed(1)));
      const warnFontPx = Math.max(10, Number((labelFontPx - 0.5).toFixed(1)));

      const measureRoomLabelBox = (
        item: PreparedRoomLabel,
        style: RoomLabelStyle
      ): { width: number; height: number } => {
        if (style === 'code') {
          ctx.font = `700 ${labelFontPx}px JetBrains Mono, monospace`;
          return {
            width: Math.ceil(
              (ctx.measureText?.(item.shortCode)?.width ??
                item.shortCode.length * (labelFontPx * 0.62)) + 8
            ),
            height: Math.max(16, Math.round(labelFontPx * 1.45)),
          };
        }
        if (style === 'pill') {
          ctx.font = `700 ${labelFontPx}px JetBrains Mono, monospace`;
          return {
            width: Math.max(
              54,
              Math.ceil(
                (ctx.measureText?.(item.compactText)?.width ??
                  item.compactText.length * (labelFontPx * 0.62)) + 14
              )
            ),
            height: Math.max(20, Math.round(labelFontPx * 1.8)),
          };
        }
        ctx.font = `bold ${richTitleFontPx}px Inter, system-ui, sans-serif`;
        const titleW =
          ctx.measureText?.(item.titleLine)?.width ??
          item.titleLine.length * (richTitleFontPx * 0.58);
        ctx.font = `600 ${labelFontPx}px JetBrains Mono, monospace`;
        const subW =
          ctx.measureText?.(item.subLine)?.width ??
          item.subLine.length * (labelFontPx * 0.62);
        let warnW = 0;
        if (item.techWarningText) {
          ctx.font = `bold ${warnFontPx}px Inter, system-ui, sans-serif`;
          warnW =
            ctx.measureText?.(item.techWarningText)?.width ??
            item.techWarningText.length * (warnFontPx * 0.58);
        }
        return {
          width: Math.ceil(Math.max(titleW, subW, warnW) + 18),
          height: item.techWarningText
            ? Math.max(48, Math.round(labelFontPx * 4.2))
            : Math.max(36, Math.round(labelFontPx * 3.2)),
        };
      };

      const drawRoomLabelAt = (
        item: PreparedRoomLabel,
        style: RoomLabelStyle,
        cx: number,
        cy: number,
        boxW: number,
        boxH: number,
        isHoverCard = false
      ) => {
        ctx.save();
        if (item.isDimmed && !isHoverCard) {
          ctx.globalAlpha = 0.32;
        }
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        if (style === 'code') {
          ctx.font = `700 ${labelFontPx}px JetBrains Mono, monospace`;
          ctx.strokeStyle = 'rgba(2, 6, 23, 0.92)';
          ctx.lineWidth = 3.2;
          ctx.lineJoin = 'round';
          ctx.strokeText?.(item.shortCode, cx, cy);
          ctx.fillStyle = item.hasAlert
            ? '#FCA5A5'
            : item.isSelected
              ? '#38BDF8'
              : '#E2E8F0';
          ctx.fillText(item.shortCode, cx, cy);
          ctx.restore();
          return;
        }

        if (style === 'pill') {
          ctx.fillStyle = item.hasAlert
            ? 'rgba(127, 29, 29, 0.92)'
            : 'rgba(15, 23, 42, 0.90)';
          ctx.strokeStyle = item.hasAlert
            ? '#EF4444'
            : item.isSelected
              ? '#38BDF8'
              : 'rgba(255, 255, 255, 0.28)';
          ctx.lineWidth = item.hasAlert || item.isSelected ? 1.5 : 1;
          ctx.beginPath();
          ctx.roundRect?.(cx - boxW / 2, cy - boxH / 2, boxW, boxH, 6);
          ctx.fill();
          ctx.stroke();

          ctx.font = `700 ${labelFontPx}px JetBrains Mono, monospace`;
          ctx.fillStyle = '#F8FAFC';
          ctx.fillText(item.compactText, cx, cy);
          ctx.restore();
          return;
        }

        // 'rich' card
        if (isHoverCard) {
          ctx.shadowColor = 'rgba(2, 6, 23, 0.75)';
          ctx.shadowBlur = 12;
        }
        ctx.fillStyle = isHoverCard
          ? 'rgba(15, 23, 42, 0.96)'
          : item.hasAlert
            ? 'rgba(69, 10, 10, 0.92)'
            : 'rgba(15, 23, 42, 0.90)';
        ctx.strokeStyle =
          item.hasAlert
            ? '#EF4444'
            : isHoverCard || item.isSelected || item.isZoomTarget
              ? '#38BDF8'
              : item.techWarningText
                ? '#F59E0B'
                : 'rgba(255, 255, 255, 0.28)';
        ctx.lineWidth =
          item.hasAlert || isHoverCard || item.isSelected || item.isZoomTarget
            ? 1.6
            : 1.2;
        ctx.beginPath();
        ctx.roundRect?.(cx - boxW / 2, cy - boxH / 2, boxW, boxH, 6);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.stroke();

        ctx.font = `bold ${richTitleFontPx}px Inter, system-ui, sans-serif`;
        ctx.fillStyle = '#F8FAFC';
        ctx.fillText(
          item.titleLine,
          cx,
          cy - (item.techWarningText ? 13 : 7)
        );

        ctx.font = `600 ${labelFontPx}px JetBrains Mono, monospace`;
        ctx.fillStyle = item.hasOnlineTelemetry ? '#38BDF8' : '#94A3B8';
        ctx.fillText(
          item.subLine,
          cx,
          cy + (item.techWarningText ? 1 : 8)
        );

        if (item.techWarningText) {
          ctx.font = `bold ${warnFontPx}px Inter, system-ui, sans-serif`;
          ctx.fillStyle = '#FBBF24';
          ctx.fillText(item.techWarningText, cx, cy + 15);
        }
        ctx.restore();
      };

      const activeCandidates = preparedLabels.filter(
        (item) => item.shouldPlaceInPass
      );
      const labelRequests: LabelRequest[] = activeCandidates.map((item) => {
        const dims = measureRoomLabelBox(item, item.style);
        const fallbackTiers: LabelStyleTier[] = [];
        if (item.style === 'rich') {
          const pillDims = measureRoomLabelBox(item, 'pill');
          const codeDims = measureRoomLabelBox(item, 'code');
          fallbackTiers.push(
            { style: 'pill', ...pillDims },
            { style: 'code', ...codeDims }
          );
        } else if (item.style === 'pill') {
          const codeDims = measureRoomLabelBox(item, 'code');
          fallbackTiers.push({ style: 'code', ...codeDims });
        }
        return {
          id: item.roomId,
          anchor: item.anchorScreen,
          width: dims.width,
          height: dims.height,
          polygon: item.screenPolygon,
          priority: item.priority,
          style: item.style,
          fallbackTiers,
        };
      });

      const placements = computeLabelPlacements(labelRequests, obstacles, {
        width,
        height,
      });

      const computedBadges: Array<{
        roomId: string;
        code: string;
        count: number;
        severity: AlertSeverity | undefined;
        x: number;
        y: number;
      }> = [];

      // Draw non-alerting room labels first, then alerting room labels LAST so alerts stay topmost
      const renderOrderIndices = activeCandidates
        .map((_, idx) => idx)
        .sort((a, b) => {
          const ha = activeCandidates[a].hasAlert ? 1 : 0;
          const hb = activeCandidates[b].hasAlert ? 1 : 0;
          return ha - hb;
        });

      for (const i of renderOrderIndices) {
        const item = activeCandidates[i];
        const placement = placements[i];
        const req = labelRequests[i];
        const actualStyle = placement?.placedStyle ?? item.style;
        const actualWidth = placement?.width ?? req.width;
        const actualHeight = placement?.height ?? req.height;

        if (item.hasAlert && item.alertCount > 0) {
          const bx = placement?.visible
            ? placement.x + actualWidth * 0.5
            : item.anchorScreen.x + 18;
          const by = placement?.visible
            ? placement.y - actualHeight * 0.5
            : item.anchorScreen.y - 14;
          computedBadges.push({
            roomId: item.roomId,
            code: item.shortCode,
            count: item.alertCount,
            severity: item.alertSeverity,
            x: Math.max(22, Math.min(width - 22, bx)),
            y: Math.max(22, Math.min(height - 22, by)),
          });
        }

        if (!placement || !placement.visible) continue;
        if (
          hoveredRoomId === item.roomId &&
          !hoveredDeviceId &&
          !hoveredBayId &&
          actualStyle !== 'rich'
        ) {
          continue;
        }
        drawRoomLabelAt(
          item,
          actualStyle,
          placement.x,
          placement.y,
          actualWidth,
          actualHeight,
          false
        );
      }

      // Update DOM top-layer alert badge anchors only when coordinates change (no loops!)
      setRoomBadgeAnchors((prev) => {
        if (
          prev.length === computedBadges.length &&
          prev.every(
            (p, idx) =>
              p.roomId === computedBadges[idx].roomId &&
              p.count === computedBadges[idx].count &&
              p.severity === computedBadges[idx].severity &&
              p.code === computedBadges[idx].code &&
              Math.abs(p.x - computedBadges[idx].x) < 1 &&
              Math.abs(p.y - computedBadges[idx].y) < 1
          )
        ) {
          return prev;
        }
        return computedBadges;
      });

      // Hovered Room Rich Card (fallback only when RoomHoverPopover overlay is disabled)
      if (!showHoverPopover && hoveredRoomId && !hoveredDeviceId && !hoveredBayId) {
        const hoveredItem = preparedLabels.find(
          (item) => item.roomId === hoveredRoomId
        );
        if (hoveredItem) {
          const placedIdx = activeCandidates.findIndex(
            (c) => c.roomId === hoveredRoomId
          );
          const placedLabel = placedIdx >= 0 ? placements[placedIdx] : undefined;
          const wasRichAndVisible =
            placedIdx >= 0 &&
            (placedLabel?.placedStyle ?? activeCandidates[placedIdx].style) ===
              'rich' &&
            placedLabel?.visible;
          if (!wasRichAndVisible) {
            const richDims = measureRoomLabelBox(hoveredItem, 'rich');
            const clampedX = Math.max(
              richDims.width * 0.5 + 8,
              Math.min(
                width - richDims.width * 0.5 - 8,
                hoveredItem.anchorScreen.x
              )
            );
            const clampedY = Math.max(
              richDims.height * 0.5 + 8,
              Math.min(
                height - richDims.height * 0.5 - 8,
                hoveredItem.anchorScreen.y
              )
            );
            drawRoomLabelAt(
              hoveredItem,
              'rich',
              clampedX,
              clampedY,
              richDims.width,
              richDims.height,
              true
            );
          }
        }
      }

      ctx.restore(); // End HiDPI scale

      if (isTransitioning) {
        rafId = window.requestAnimationFrame(render);
      }
    };

    rafId = window.requestAnimationFrame(render);

    return () => {
      isCancelled = true;
      if (rafId) window.cancelAnimationFrame(rafId);
    };
  }, [
    canvasSize,
    enrichedRooms,
    devices,
    deviceClusters,
    visibleAnonymousBays,
    floorLandmarks,
    roomTelemetryMap,
    deviceTelemetryMap,
    layer,
    selectedRoomId,
    zoomedRoomId,
    selectedBayId,
    hoveredRoomId,
    hoveredDeviceId,
    hoveredBayId,
    labelDensity,
    lodConfig,
    showBlindspots,
    showReliabilityLayer,
    roomReliabilityMap,
    showTechOverlay,
    zoomViewport,
    highlightedZoneIds,
    firingRoomSet,
    roomAlertCounts,
    roomAlertSeverities,
    activeStatusFilter,
    roomMatchesFilterMap,
    onlyExceedingThreshold,
    roomDeltaMap,
    playbackRoomStateMap,
    showHoverPopover,
  ]);

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = dynamicCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const rawPx: Point2D = {
      x: (e.clientX - rect.left - zoomViewport.tx) / zoomViewport.scale,
      y: (e.clientY - rect.top - zoomViewport.ty) / zoomViewport.scale,
    };
    const normPt = pixelToNormalized(
      rawPx,
      canvasSize.width,
      canvasSize.height
    );

    let foundRoom: RoomResponse | null = null;
    for (const { room, polygon } of enrichedRooms) {
      if (isPointInPolygon(normPt, polygon)) {
        foundRoom = room;
        break;
      }
    }
    const foundRoomId = foundRoom?.id ?? null;
    if (foundRoomId !== hoveredRoomId) {
      setHoveredRoomId(foundRoomId);
      onHoverRoomChange?.(foundRoom);
    }
  };

  const handleCanvasMouseLeave = () => {
    if (hoveredRoomId !== null) {
      setHoveredRoomId(null);
      onHoverRoomChange?.(null);
    }
  };

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (dragMovedDistRef.current > 6) {
      dragMovedDistRef.current = 0;
      return;
    }
    const canvas = dynamicCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const rawClickPx: Point2D = {
      x: (e.clientX - rect.left - zoomViewport.tx) / zoomViewport.scale,
      y: (e.clientY - rect.top - zoomViewport.ty) / zoomViewport.scale,
    };
    const normPt = pixelToNormalized(
      rawClickPx,
      canvasSize.width,
      canvasSize.height
    );

    for (const { room, polygon } of enrichedRooms) {
      if (isPointInPolygon(normPt, polygon)) {
        onSelectRoom(room);
        return;
      }
    }
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    dragMovedDistRef.current = 0;
    const pointerId = e.pointerId ?? 1;
    try {
      e.currentTarget.setPointerCapture?.(pointerId);
    } catch {
      // Ignore in jsdom / unsupported environments
    }
    activePointersRef.current.set(pointerId, {
      x: e.clientX,
      y: e.clientY,
    });
    if (activePointersRef.current.size === 2) {
      const pts = Array.from(activePointersRef.current.values());
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      pinchStartRef.current = {
        dist,
        scale: latestViewportRef.current.scale,
      };
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const pointerId = e.pointerId ?? 1;
    const prev = activePointersRef.current.get(pointerId);
    if (!prev) return;
    activePointersRef.current.set(pointerId, {
      x: e.clientX,
      y: e.clientY,
    });

    const current = latestViewportRef.current;

    if (activePointersRef.current.size === 2 && pinchStartRef.current) {
      const pts = Array.from(activePointersRef.current.values());
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const nextScale = computePinchScale(
        pinchStartRef.current.scale,
        pinchStartRef.current.dist,
        dist,
        ZOOM_CONFIG.maxScale
      );
      const rect = e.currentTarget.getBoundingClientRect();
      const midPx: Point2D = {
        x: (pts[0].x + pts[1].x) * 0.5 - rect.left,
        y: (pts[0].y + pts[1].y) * 0.5 - rect.top,
      };
      commitViewport(
        zoomViewportAtPoint(
          current,
          nextScale,
          midPx,
          canvasSize.width,
          canvasSize.height,
          ZOOM_CONFIG.maxScale
        )
      );
    } else if (
      activePointersRef.current.size === 1 &&
      current.scale > 1.01
    ) {
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      dragMovedDistRef.current += Math.hypot(dx, dy);
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        commitViewport(
          clampViewportTransform(
            current.scale,
            current.tx + dx,
            current.ty + dy,
            canvasSize.width,
            canvasSize.height,
            ZOOM_CONFIG.maxScale
          )
        );
      }
    }
  };

  const handlePointerUpOrCancel = (
    e: React.PointerEvent<HTMLCanvasElement>
  ) => {
    const pointerId = e.pointerId ?? 1;
    activePointersRef.current.delete(pointerId);
    try {
      e.currentTarget.releasePointerCapture?.(pointerId);
    } catch {
      // Ignore if pointer was not captured
    }
    if (activePointersRef.current.size < 2) {
      pinchStartRef.current = null;
    }
  };

  const handleCanvasDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = dynamicCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const rawClickPx: Point2D = {
      x: (e.clientX - rect.left - zoomViewport.tx) / zoomViewport.scale,
      y: (e.clientY - rect.top - zoomViewport.ty) / zoomViewport.scale,
    };
    const normPt = pixelToNormalized(
      rawClickPx,
      canvasSize.width,
      canvasSize.height
    );

    for (const { room, polygon } of enrichedRooms) {
      if (isPointInPolygon(normPt, polygon)) {
        onSelectRoom(room);
        setZoomedRoomId(zoomedRoomId === room.id ? null : room.id);
        return;
      }
    }
  };

  const handleZoomByStep = (delta: number) => {
    const current = latestViewportRef.current;
    const nextScale = Number(
      Math.max(
        ZOOM_CONFIG.minScale,
        Math.min(ZOOM_CONFIG.maxScale, current.scale + delta)
      ).toFixed(3)
    );
    const nextVp = zoomViewportAtPoint(
      current,
      nextScale,
      { x: canvasSize.width * 0.5, y: canvasSize.height * 0.5 },
      canvasSize.width,
      canvasSize.height,
      ZOOM_CONFIG.maxScale
    );
    if (nextVp.scale <= 1.001 && zoomedRoomId) {
      setZoomedRoomId(null);
    }
    commitViewport(nextVp);
  };

  const handleResetView = () => {
    prevZoomedRoomIdRef.current = null;
    setZoomedRoomId(null);
    commitViewport(fitFloorToViewport());
  };

  const handleFitRoomOrFloor = () => {
    if (selectedRoomId && zoomedRoomId !== selectedRoomId) {
      setZoomedRoomId(selectedRoomId);
    } else {
      handleResetView();
    }
  };

  const landmarkCode = (kind: TqbLandmark['kind']) => {
    switch (kind) {
      case 'ELEVATOR':
        return 'TM';
      case 'STAIRS':
        return 'TH';
      case 'WC':
        return 'WC';
      case 'ENTRANCE':
        return 'CỬA';
      default:
        return 'MỐC';
    }
  };

  const selectedRoomObj = selectedRoomId
    ? roomById.get(selectedRoomId) ?? null
    : null;

  const minimapRooms: MinimapRoomShape[] = useMemo(
    () =>
      enrichedRooms.map((er) => ({
        id: er.room.id,
        code: er.preset?.code ?? er.room.code,
        polygon: er.polygon,
        hasAlert:
          (roomAlertCounts?.[er.room.id] ?? 0) > 0 ||
          firingRoomSet.has(er.room.id),
        isSelected: er.room.id === selectedRoomId,
      })),
    [enrichedRooms, roomAlertCounts, firingRoomSet, selectedRoomId]
  );

  const alertingScreenOutlines = useMemo(() => {
    return enrichedRooms
      .filter(
        (er) =>
          (roomAlertCounts?.[er.room.id] ?? 0) > 0 ||
          firingRoomSet.has(er.room.id)
      )
      .map((er) => {
        const sev = roomAlertSeverities?.[er.room.id];
        const isSevere = sev === 'CRITICAL' || sev === 'HIGH' || !sev;
        const points = er.polygon
          .map((pt) => {
            const sp = toScreenPx(pt);
            return `${sp.x.toFixed(1)},${sp.y.toFixed(1)}`;
          })
          .join(' ');
        return {
          roomId: er.room.id,
          points,
          isSevere,
        };
      });
  }, [
    enrichedRooms,
    roomAlertCounts,
    firingRoomSet,
    roomAlertSeverities,
    toScreenPx,
  ]);

  const hoveredPopoverData = useMemo(() => {
    if (
      !showHoverPopover ||
      !hoveredRoomId ||
      hoveredDeviceId ||
      hoveredBayId
    ) {
      return null;
    }
    const found = enrichedRooms.find((er) => er.room.id === hoveredRoomId);
    if (!found) return null;
    const { room, preset, polygon } = found;
    const centroid = computePolygonCentroid(polygon);
    const anchor = toScreenPx(centroid);

    const roomDevices = positionedDevices.filter((d) => d.roomId === room.id);
    const onlineDevs = roomDevices.filter(
      (d) => d.online || d.connectionState === 'ONLINE'
    );
    let primaryVal = extractLayerMetricValue(roomTelemetryMap[room.id], layer);
    if (onlineDevs.length > 0) {
      const vals = onlineDevs
        .map((dev) =>
          extractLayerMetricValue(
            resolveDeviceTelemetry(
              dev,
              deviceTelemetryMap,
              roomTelemetryMap,
              roomDevices.length
            ),
            layer
          )
        )
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
      if (vals.length > 0) {
        primaryVal = vals.reduce((s, v) => s + v, 0) / vals.length;
      }
    }

    const popoverPlacement = computePopoverPlacement(
      anchor,
      { width: 288, height: 240 },
      canvasSize,
      {
        margin: FLOORPLAN_INTERACTION_CONFIG.viewportMarginPx,
        gap: 20,
        preferredPlacement: 'top',
      }
    );

    const openAlertsCount =
      roomAlertCounts?.[room.id] ?? (firingRoomSet.has(room.id) ? 1 : 0);
    const reliability =
      roomReliabilityMap?.[room.id] ??
      evaluateRoomReliability({
        room,
        telemetry: roomTelemetryMap[room.id],
        devices: roomDevices,
      });

    return {
      room,
      preset,
      value: primaryVal,
      historyValues: roomTelemetryHistoryMap?.[room.id],
      oneHourDelta: roomDeltaMap?.[room.id] ?? null,
      playbackState: playbackRoomStateMap?.[room.id] ?? null,
      openAlertsCount,
      reliability,
      left: popoverPlacement.left,
      top: popoverPlacement.top,
      placement: popoverPlacement.placement,
      align: popoverPlacement.align,
    };
  }, [
    showHoverPopover,
    hoveredRoomId,
    hoveredDeviceId,
    hoveredBayId,
    enrichedRooms,
    toScreenPx,
    positionedDevices,
    roomTelemetryMap,
    deviceTelemetryMap,
    layer,
    canvasSize.width,
    canvasSize.height,
    roomAlertCounts,
    firingRoomSet,
    roomTelemetryHistoryMap,
    roomReliabilityMap,
    roomDeltaMap,
    playbackRoomStateMap,
  ]);

  const hoveredBayTooltipData = useMemo(() => {
    if (!hoveredBayId) return null;
    const found = visibleAnonymousBays.find((b) => b.bay.bayId === hoveredBayId);
    if (!found) return null;
    const px = toScreenPx({ x: found.bay.posX, y: found.bay.posY });
    const pos = computePopoverPlacement(
      px,
      { width: 224, height: 152 },
      canvasSize,
      {
        margin: FLOORPLAN_INTERACTION_CONFIG.viewportMarginPx,
        gap: 18,
        preferredPlacement: 'top',
      }
    );
    return { bay: found.bay, ...pos };
  }, [hoveredBayId, visibleAnonymousBays, toScreenPx, canvasSize]);

  const hoveredDeviceTooltipData = useMemo(() => {
    const targetCluster = deviceClusters.find((cluster) => {
      if (cluster.isCluster) return false;
      const d = cluster.devices[0];
      return (
        d.id === hoveredDeviceId ||
        (focusedDeviceId &&
          (d.id === focusedDeviceId || d.hardwareId === focusedDeviceId))
      );
    });
    if (!targetCluster) return null;
    const device = targetCluster.devices[0];
    const room = device.roomId ? roomById.get(device.roomId) : undefined;
    const roomDeviceCount = device.roomId
      ? devices.filter((d) => d.roomId === device.roomId).length
      : 1;
    const devTel = resolveDeviceTelemetry(
      device,
      deviceTelemetryMap,
      roomTelemetryMap,
      roomDeviceCount
    );
    const isFocusedDevice = Boolean(
      focusedDeviceId &&
        (device.id === focusedDeviceId ||
          device.hardwareId === focusedDeviceId)
    );
    const pos = computePopoverPlacement(
      targetCluster.centroidScreen,
      { width: 224, height: 196 },
      canvasSize,
      {
        margin: FLOORPLAN_INTERACTION_CONFIG.viewportMarginPx,
        gap: 20,
        preferredPlacement: 'top',
      }
    );
    return {
      device,
      room,
      devTel,
      isFocusedDevice,
      ...pos,
    };
  }, [
    deviceClusters,
    hoveredDeviceId,
    focusedDeviceId,
    roomById,
    devices,
    deviceTelemetryMap,
    roomTelemetryMap,
    canvasSize,
  ]);

  return (
    <div
      ref={containerRef}
      data-testid="floorplan-canvas-wrapper"
      data-scale={zoomViewport.scale}
      data-tx={zoomViewport.tx}
      data-ty={zoomViewport.ty}
      data-canvas-width={canvasSize.width}
      data-canvas-height={canvasSize.height}
      data-status-filter={activeStatusFilter}
      data-only-exceeding={onlyExceedingThreshold ? 'true' : 'false'}
      data-reliability-layer={showReliabilityLayer ? 'true' : 'false'}
      data-furniture-layer={showFurnitureLayer ? 'true' : 'false'}
      data-furniture-edit={furnitureEditMode ? 'true' : 'false'}
      className="relative flex w-full items-center justify-center overflow-hidden rounded-2xl border border-slate-800 bg-[#0B1120] shadow-inner"
    >
      <div
        onMouseLeave={handleCanvasMouseLeave}
        className="relative overflow-hidden"
        style={{ width: canvasSize.width, height: canvasSize.height }}
      >
        {/* Top Floating Controls: CAD Layer Toggle, Display Density & Zoom Fit */}
        <div className="pointer-events-auto absolute left-3 top-3 z-20 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setShowCadUnderlay((v) => !v)}
            aria-pressed={showCadUnderlay}
            className={`rounded-lg border px-2.5 py-1 text-2xs font-semibold shadow-sm backdrop-blur transition-colors ${
              showCadUnderlay
                ? 'border-sky-500/60 bg-slate-900/90 text-sky-300'
                : 'border-slate-700 bg-slate-900/75 text-slate-400 hover:text-slate-200'
            }`}
            title="Bật/tắt lớp bản vẽ kỹ thuật AutoCAD"
          >
            {FLOORPLAN_I18N_VI.controls.cadToggle}
          </button>

          {/* Display Density Segmented Control (Tinh gọn | Cân bằng | Chi tiết) */}
          <div
            role="group"
            aria-label="Mật độ hiển thị nhãn bản đồ"
            className="flex items-center rounded-lg border border-slate-700/90 bg-slate-900/90 p-0.5 text-xs shadow-sm backdrop-blur"
          >
            {(
              [
                { key: 'clean', label: 'Tinh gọn' },
                { key: 'balanced', label: 'Cân bằng' },
                { key: 'detailed', label: 'Chi tiết' },
              ] as const
            ).map((opt) => {
              const active = labelDensity === opt.key;
              return (
                <button
                  key={opt.key}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setLabelDensity(opt.key)}
                  className={`rounded-md px-2 py-0.5 text-2xs font-semibold transition-colors ${
                    active
                      ? 'bg-sky-500 text-slate-950 shadow-xs'
                      : 'text-slate-300 hover:text-white'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>

          {zoomViewport.isZoomed ? (
            <button
              type="button"
              onClick={handleResetView}
              className="rounded-lg border border-amber-400/60 bg-slate-900/90 px-2.5 py-1 text-2xs font-semibold text-amber-300 shadow-sm backdrop-blur hover:bg-slate-800"
            >
              {FLOORPLAN_I18N_VI.controls.fitFloor}
            </button>
          ) : (
            selectedRoomObj && (
              <button
                type="button"
                onClick={handleFitRoomOrFloor}
                className="rounded-lg border border-sky-400/60 bg-slate-900/90 px-2.5 py-1 text-2xs font-semibold text-sky-300 shadow-sm backdrop-blur hover:bg-slate-800"
              >
                {FLOORPLAN_I18N_VI.controls.fitRoom} {selectedRoomObj.code}
              </button>
            )
          )}
        </div>

        {/* Top-Right Compact Zoom/Pan/Fullscreen Toolbar + Scale Badge */}
        <div className="pointer-events-auto absolute right-3 top-3 z-20 flex items-center gap-1.5">
          <div className="hidden items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-900/85 px-2.5 py-1 font-mono text-2xs text-slate-300 backdrop-blur sm:flex">
            <span className="font-semibold text-slate-100">BẮC</span>
            <span>·</span>
            <span>76×57m</span>
            <span>·</span>
            <span data-testid="zoom-scale-label" className="text-sky-300 tabular-nums">
              {zoomViewport.scale.toFixed(2)}x
            </span>
          </div>

          <div
            role="group"
            aria-label="Điều khiển phóng to, thu nhỏ và toàn màn hình"
            className="flex items-center rounded-lg border border-slate-700/90 bg-slate-900/92 p-0.5 shadow-sm backdrop-blur"
          >
            <button
              type="button"
              data-testid="zoom-out-btn"
              onClick={() => handleZoomByStep(-ZOOM_CONFIG.buttonStep)}
              disabled={zoomViewport.scale <= ZOOM_CONFIG.minScale + 0.001}
              aria-label={FLOORPLAN_I18N_VI.controls.zoomOut}
              title={FLOORPLAN_I18N_VI.controls.zoomOut}
              className="flex h-7 w-7 items-center justify-center rounded-md text-slate-200 transition-colors hover:bg-slate-800 disabled:opacity-40"
            >
              <Minus className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              data-testid="zoom-in-btn"
              onClick={() => handleZoomByStep(ZOOM_CONFIG.buttonStep)}
              disabled={zoomViewport.scale >= ZOOM_CONFIG.maxScale - 0.001}
              aria-label={FLOORPLAN_I18N_VI.controls.zoomIn}
              title={FLOORPLAN_I18N_VI.controls.zoomIn}
              className="flex h-7 w-7 items-center justify-center rounded-md text-slate-200 transition-colors hover:bg-slate-800 disabled:opacity-40"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              data-testid="zoom-fit-btn"
              onClick={handleFitRoomOrFloor}
              aria-label={
                selectedRoomObj
                  ? FLOORPLAN_I18N_VI.controls.fitRoom
                  : FLOORPLAN_I18N_VI.controls.fitFloor
              }
              title={
                selectedRoomObj
                  ? `${FLOORPLAN_I18N_VI.controls.fitRoom} ${selectedRoomObj.code}`
                  : FLOORPLAN_I18N_VI.controls.fitFloor
              }
              className="flex h-7 w-7 items-center justify-center rounded-md text-slate-200 transition-colors hover:bg-slate-800"
            >
              <Scan className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              data-testid="zoom-reset-btn"
              onClick={handleResetView}
              aria-label={FLOORPLAN_I18N_VI.controls.resetView}
              title={FLOORPLAN_I18N_VI.controls.resetView}
              className="flex h-7 items-center justify-center rounded-md px-1.5 text-2xs font-semibold text-slate-200 transition-colors hover:bg-slate-800"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="sr-only">Reset</span>
            </button>
            <button
              type="button"
              data-testid="fullscreen-toggle-btn"
              onClick={() => void handleFullscreenToggle()}
              aria-label={
                isFullscreen
                  ? FLOORPLAN_I18N_VI.controls.fullscreenExit
                  : FLOORPLAN_I18N_VI.controls.fullscreenEnter
              }
              title={
                isFullscreen
                  ? FLOORPLAN_I18N_VI.controls.fullscreenExit
                  : FLOORPLAN_I18N_VI.controls.fullscreenEnter
              }
              className="flex h-7 items-center gap-1 rounded-md px-2 text-2xs font-semibold text-sky-300 transition-colors hover:bg-slate-800"
            >
              {isFullscreen ? (
                <>
                  <Minimize2 className="h-3.5 w-3.5" aria-hidden="true" />
                  <span className="hidden md:inline">
                    {FLOORPLAN_I18N_VI.controls.fullscreenExit}
                  </span>
                </>
              ) : (
                <>
                  <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
                  <span className="hidden md:inline">
                    {FLOORPLAN_I18N_VI.controls.fullscreenEnter}
                  </span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Layer 1 Canvas: Static Base (Grid, Atrium, CAD SVG Underlay) */}
        <canvas
          ref={staticCanvasRef}
          data-testid="static-base-canvas"
          className="block select-none"
          aria-hidden="true"
        />

        {/* Layer 2 Canvas: Dynamic Thermal Diffusion, Alert Borders & Labels */}
        <canvas
          ref={dynamicCanvasRef}
          data-testid="dynamic-heatmap-canvas"
          onMouseMove={handleCanvasMouseMove}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUpOrCancel}
          onPointerCancel={handlePointerUpOrCancel}
          onClick={handleCanvasClick}
          onDoubleClick={handleCanvasDoubleClick}
          className="absolute inset-0 z-[2] block cursor-pointer bg-transparent touch-none select-none"
          aria-label="Bản đồ không gian mặt bằng và Heatmap 2D Thư viện Tạ Quang Bửu"
        />

        {/* Layer 2A: Architectural Landmarks (Stairs, Elevators, WC, Entrance) */}
        <div className="pointer-events-none absolute inset-0 z-[5]">
          {floorLandmarks.map((lm) => {
            const px = toScreenPx(lm.position);
            if (
              px.x < -20 ||
              px.x > canvasSize.width + 20 ||
              px.y < -20 ||
              px.y > canvasSize.height + 20
            ) {
              return null;
            }
            return (
              <div
                key={lm.id}
                style={{ left: `${px.x}px`, top: `${px.y}px` }}
                className="pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2"
                title={lm.labelVi}
              >
                <div className="flex items-center justify-center rounded border border-slate-700/80 bg-slate-900/85 px-1.5 py-0.5 font-mono text-[10px] font-medium text-slate-300 shadow-xs backdrop-blur">
                  <span>
                    {lodConfig.showLandmarkText
                      ? lm.shortLabel
                      : landmarkCode(lm.kind)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Layer 2B: Anonymous Reading Bay Micro-zones (FE-VIZ-09, >= 44x44px hit-box) */}
        <div
          data-testid="reading-bays-layer"
          className="pointer-events-none absolute inset-0 z-[6]"
        >
          {visibleAnonymousBays.map(({ bay, room }) => {
            const isSelectedBay = bay.bayId === selectedBayId;
            const isHoveredBay = bay.bayId === hoveredBayId;
            if (lodConfig.bayStyle === 'hidden' && !isSelectedBay) {
              return null;
            }

            const px = toScreenPx({ x: bay.posX, y: bay.posY });
            if (
              px.x < 0 ||
              px.x > canvasSize.width ||
              px.y < 0 ||
              px.y > canvasSize.height
            ) {
              return null;
            }
            const bayVal = bay.metrics[layer];
            const colorCss = getContinuousMetricColorCss(layer, bayVal);
            const showFullPill =
              lodConfig.bayStyle === 'pill' || isSelectedBay || isHoveredBay;

            return (
              <div
                key={bay.bayId}
                style={{ left: `${px.x}px`, top: `${px.y}px` }}
                className="pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2"
              >
                <button
                  type="button"
                  data-testid={`reading-bay-btn-${bay.bayId}`}
                  onMouseEnter={() => setHoveredBayId(bay.bayId)}
                  onMouseLeave={() => setHoveredBayId(null)}
                  onFocus={() => setHoveredBayId(bay.bayId)}
                  onBlur={() => setHoveredBayId(null)}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onSelectRoom(room);
                    onSelectBay?.(bay, room);
                  }}
                  aria-label={`Phân khu bàn đọc ${bay.nameVi} (${room.name})`}
                  className="group flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full bg-transparent focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
                >
                  {showFullPill ? (
                    <span
                      className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-semibold shadow-md transition-transform group-hover:scale-110 ${
                        isSelectedBay
                          ? 'scale-110 border-sky-300 bg-sky-950/95 text-sky-100 ring-2 ring-sky-400'
                          : 'border-white/40 bg-slate-900/90 text-slate-100'
                      }`}
                      style={{
                        boxShadow: `0 0 10px ${colorCss}`,
                      }}
                    >
                      <span
                        className="inline-block h-2 w-2 rounded-full"
                        style={{ backgroundColor: colorCss }}
                      />
                      <span>{bay.shortLabel}</span>
                      <span className="font-mono text-sky-300">
                        {formatLayerMetricValue(bayVal, layer)}
                      </span>
                    </span>
                  ) : (
                    <span
                      className="flex h-3 w-3 items-center justify-center rounded-full border border-white/85 shadow transition-transform group-hover:scale-125"
                      style={{
                        backgroundColor: colorCss,
                        boxShadow: `0 0 8px ${colorCss}`,
                      }}
                    />
                  )}
                </button>
              </div>
            );
          })}
        </div>

        {/* Layer 2C: Clustered & Individual Hardware Device Pins Overlay (>= 44x44px hit-box) */}
        <div
          data-testid="device-pins-layer"
          className="pointer-events-none absolute inset-0 z-[8]"
        >
          {deviceClusters.map((cluster) => {
            const px = cluster.centroidScreen;
            if (
              px.x < -20 ||
              px.x > canvasSize.width + 20 ||
              px.y < -20 ||
              px.y > canvasSize.height + 20
            ) {
              return null;
            }

            if (cluster.isCluster) {
              const isSevereCluster =
                cluster.highestSeverity === 'CRITICAL' ||
                cluster.highestSeverity === 'HIGH';
              const isWarningCluster =
                !isSevereCluster &&
                (cluster.highestSeverity === 'MEDIUM' ||
                  cluster.highestSeverity === 'LOW' ||
                  cluster.hasAlert);
              const clusterVisualPx = Math.max(
                24,
                Math.min(32, lodConfig.nodeVisualSizePx + 8)
              );

              return (
                <div
                  key={cluster.id}
                  style={{
                    left: `${px.x}px`,
                    top: `${px.y}px`,
                    zIndex: isSevereCluster ? 28 : isWarningCluster ? 24 : 18,
                  }}
                  className="pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2"
                >
                  {cluster.hasAlert && (
                    <span
                      aria-hidden="true"
                      className={`pointer-events-none absolute inset-1 rounded-full motion-safe:animate-ping ${
                        isSevereCluster
                          ? 'bg-red-500 opacity-55'
                          : 'bg-amber-400 opacity-45'
                      }`}
                    />
                  )}
                  <button
                    type="button"
                    data-testid={`device-cluster-${cluster.id}`}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      handleClusterExpand(
                        cluster.centroidNorm,
                        cluster.targetZoomScale
                      );
                    }}
                    aria-label={`Cụm ${cluster.count} trạm cảm biến — bấm để phóng to và tách cụm`}
                    title={`Cụm ${cluster.count} trạm cảm biến (${cluster.onlineCount}/${cluster.count} trực tuyến) — Bấm để phóng to`}
                    className="group relative flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full bg-transparent focus:outline-none focus:ring-2 focus:ring-sky-400"
                  >
                    <span
                      data-testid={`device-visual-${cluster.id}`}
                      data-visual-size={clusterVisualPx}
                      style={{
                        width: `${clusterVisualPx}px`,
                        height: `${clusterVisualPx}px`,
                      }}
                      className={`flex items-center justify-center rounded-full border-2 font-mono text-xs font-bold shadow-lg transition-transform group-hover:scale-110 ${
                        isSevereCluster
                          ? 'border-red-300 bg-red-900/95 text-white ring-2 ring-red-500/80'
                          : isWarningCluster
                            ? 'border-amber-300 bg-amber-900/95 text-amber-50 ring-2 ring-amber-400/75'
                            : 'border-sky-300 bg-slate-900/95 text-sky-100 ring-1 ring-sky-400/50'
                      }`}
                    >
                      <span data-testid="device-cluster-count">
                        {cluster.count}
                      </span>
                    </span>
                  </button>
                </div>
              );
            }

            const device = cluster.devices[0];
            const room = device.roomId ? roomById.get(device.roomId) : undefined;
            const roomDeviceCount = device.roomId
              ? devices.filter((d) => d.roomId === device.roomId).length
              : 1;
            const devTel = resolveDeviceTelemetry(
              device,
              deviceTelemetryMap,
              roomTelemetryMap,
              roomDeviceCount
            );
            const rawMetricVal = extractLayerMetricValue(devTel, layer);
            const activeVal = rawMetricVal;
            const pinTransitionCss = isReducedMotionPreferred()
              ? 'none'
              : `background-color ${TIMING_CONFIG.transitionDurationMs}ms ease-out, box-shadow ${TIMING_CONFIG.transitionDurationMs}ms ease-out`;
            const colorHex = device.online
              ? getContinuousMetricColorCss(layer, activeVal)
              : '#64748B';

            const isAbnormal =
              device.online &&
              ((layer === 'temperature' &&
                typeof activeVal === 'number' &&
                activeVal >= 24.5) ||
                (layer === 'noiseAvg' &&
                  typeof activeVal === 'number' &&
                  activeVal >= 50.0) ||
                (layer === 'pm2_5' &&
                  typeof activeVal === 'number' &&
                  activeVal >= 22.0) ||
                (layer === 'humidity' &&
                  typeof activeVal === 'number' &&
                  activeVal >= 60.0) ||
                (layer === 'wifiRssi' &&
                  typeof activeVal === 'number' &&
                  activeVal <= -75.0));

            const isInZoomedRoom =
              zoomViewport.isZoomed && device.roomId === zoomedRoomId;
            const isFocusedDevice = Boolean(
              focusedDeviceId &&
                (device.id === focusedDeviceId ||
                  device.hardwareId === focusedDeviceId)
            );
            const isAlertingDevice =
              alertingDeviceSet.has(device.id) ||
              alertingDeviceSet.has(device.hardwareId);

            const usePinStyle =
              isFocusedDevice ||
              isAlertingDevice ||
              (zoomedRoomId
                ? isInZoomedRoom
                : lodConfig.sensorStyle === 'pin');
            const showBadge =
              isFocusedDevice ||
              isAlertingDevice ||
              (zoomedRoomId
                ? isInZoomedRoom
                : lodConfig.showSensorBadge);

            const nodeVisualPx = Math.max(
              10,
              Math.min(
                32,
                usePinStyle
                  ? Math.max(20, lodConfig.nodeVisualSizePx)
                  : lodConfig.nodeVisualSizePx
              )
            );

            return (
              <div
                key={device.id}
                style={{
                  left: `${px.x}px`,
                  top: `${px.y}px`,
                  zIndex: isFocusedDevice ? 35 : isAlertingDevice ? 25 : undefined,
                }}
                className="pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2"
              >
                {(isFocusedDevice || isAlertingDevice || isAbnormal) && (
                  <span
                    className={`pointer-events-none absolute rounded-full ${
                      isFocusedDevice
                        ? 'inset-0 motion-safe:animate-ping bg-rose-500 opacity-75'
                        : isAlertingDevice
                          ? 'inset-1 motion-safe:animate-ping bg-rose-500 opacity-60'
                          : 'inset-2 motion-safe:animate-ping opacity-55'
                    }`}
                    style={
                      !isFocusedDevice && !isAlertingDevice
                        ? { backgroundColor: colorHex }
                        : undefined
                    }
                  />
                )}
                {isFocusedDevice && (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-1 rounded-full border-2 border-rose-400 shadow-[0_0_16px_rgba(244,63,94,0.9)]"
                  />
                )}

                <button
                  type="button"
                  data-testid={`device-pin-${device.id}`}
                  onMouseEnter={() => setHoveredDeviceId(device.id)}
                  onMouseLeave={() => setHoveredDeviceId(null)}
                  onFocus={() => setHoveredDeviceId(device.id)}
                  onBlur={() => setHoveredDeviceId(null)}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    if (room) onSelectRoom(room);
                    onSelectDevice?.(device, room);
                  }}
                  aria-label={`Trạm cảm biến ${device.name} (${device.hardwareId}) - ${
                    device.online ? 'Trực tuyến' : 'Mất kết nối'
                  }`}
                  className="group relative flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full bg-transparent focus:outline-none focus:ring-2 focus:ring-sky-400"
                >
                  {usePinStyle ? (
                    <span
                      data-testid={`device-visual-${device.id}`}
                      data-visual-size={nodeVisualPx}
                      className={`flex items-center justify-center rounded-full text-xs font-bold transition-transform group-hover:scale-125 group-focus:scale-125 ${
                        isFocusedDevice
                          ? 'scale-110 border-2 border-rose-300 ring-2 ring-rose-500 shadow-xl'
                          : device.online
                            ? 'border-2 border-white shadow-lg'
                            : 'border-2 border-dashed border-slate-400 bg-slate-800/90 text-slate-300 opacity-85'
                      }`}
                      style={{
                        width: `${nodeVisualPx}px`,
                        height: `${nodeVisualPx}px`,
                        ...(device.online
                          ? {
                              backgroundColor: isFocusedDevice
                                ? '#F43F5E'
                                : colorHex,
                              color: isFocusedDevice ? '#FFFFFF' : '#0F172A',
                              boxShadow: isFocusedDevice
                                ? '0 0 18px #F43F5E, 0 2px 6px rgba(0,0,0,0.75)'
                                : `0 0 14px ${colorHex}, 0 2px 4px rgba(0,0,0,0.6)`,
                              transition: pinTransitionCss,
                            }
                          : undefined),
                      }}
                    >
                      <span aria-hidden="true">{device.online ? '●' : '✕'}</span>
                    </span>
                  ) : (
                    <span
                      data-testid={`device-visual-${device.id}`}
                      data-visual-size={nodeVisualPx}
                      className={`flex items-center justify-center rounded-full transition-transform group-hover:scale-150 group-focus:scale-150 ${
                        device.online
                          ? 'border border-white/95 shadow'
                          : 'border border-dashed border-slate-400 bg-slate-800/90 opacity-85'
                      }`}
                      style={{
                        width: `${nodeVisualPx}px`,
                        height: `${nodeVisualPx}px`,
                        ...(device.online
                          ? {
                              backgroundColor: colorHex,
                              boxShadow: `0 0 10px ${colorHex}, 0 1px 3px rgba(0,0,0,0.65)`,
                              transition: pinTransitionCss,
                            }
                          : undefined),
                      }}
                    />
                  )}
                </button>

                {(showBadge && activeVal !== null) || isFocusedDevice ? (
                  <div
                    className="pointer-events-none absolute left-1/2 top-full -mt-1 -translate-x-1/2 rounded border px-1.5 py-0.5 text-center font-mono text-2xs font-bold shadow-md"
                    style={{
                      backgroundColor: isFocusedDevice
                        ? 'rgba(136, 19, 55, 0.95)'
                        : 'rgba(15, 23, 42, 0.92)',
                      borderColor: isFocusedDevice
                        ? '#FB7185'
                        : device.online
                          ? colorHex
                          : '#64748B',
                      color: '#F8FAFC',
                      whiteSpace: 'nowrap',
                      transition: isReducedMotionPreferred()
                        ? 'none'
                        : `border-color ${TIMING_CONFIG.transitionDurationMs}ms ease-out`,
                    }}
                  >
                    {isFocusedDevice
                      ? `${device.hardwareId}${activeVal !== null ? ` · ${formatLayerMetricValue(activeVal, layer)}` : ''}`
                      : formatLayerMetricValue(activeVal, layer)}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        {/* Layer 2.5: Gentle Breathing Alert Halo Overlay (respects prefers-reduced-motion) */}
        {alertingScreenOutlines.length > 0 && (
          <svg
            data-testid="alert-breathing-overlay"
            viewBox={`0 0 ${canvasSize.width} ${canvasSize.height}`}
            width={canvasSize.width}
            height={canvasSize.height}
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 z-[12]"
          >
            {alertingScreenOutlines.map((outline) => {
              const isOverdue = overdueRoomSet.has(outline.roomId);
              return (
                <polygon
                  key={outline.roomId}
                  points={outline.points}
                  fill="none"
                  stroke={
                    isOverdue
                      ? '#EF4444'
                      : outline.isSevere
                        ? '#F87171'
                        : '#FBBF24'
                  }
                  strokeWidth={isOverdue ? 3.5 : 2.5}
                  strokeDasharray={isOverdue ? '6 3' : undefined}
                  className="motion-safe:animate-pulse"
                  style={{
                    animationDuration: `${TIMING_CONFIG.alertPulsePeriodMs}ms`,
                  }}
                />
              );
            })}
          </svg>
        )}

        {/* Layer 3 (Topmost DOM Alert Badges !N — >= 44x44px touch target) */}
        <div
          data-testid="room-alert-badges-layer"
          className="pointer-events-none absolute inset-0 z-[15]"
        >
          {roomBadgeAnchors.map((badge) => {
            const roomObj = roomById.get(badge.roomId);
            const isOverdue = overdueRoomSet.has(badge.roomId);
            const isSevere =
              isOverdue ||
              badge.severity === 'CRITICAL' ||
              badge.severity === 'HIGH' ||
              !badge.severity;
            return (
              <button
                key={badge.roomId}
                type="button"
                data-testid={`room-alert-badge-${badge.roomId}`}
                data-overdue={isOverdue ? 'true' : undefined}
                style={{ left: `${badge.x}px`, top: `${badge.y}px` }}
                onClick={(ev) => {
                  ev.stopPropagation();
                  if (roomObj) onSelectRoom(roomObj);
                }}
                aria-label={`${badge.code}: ${badge.count} cảnh báo đang mở${
                  isOverdue ? ' (có cảnh báo tồn đọng lâu)' : ''
                }`}
                className="pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full bg-transparent focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
              >
                <span
                  className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 font-mono text-[10px] font-bold text-white shadow-md motion-safe:animate-pulse ${
                    isOverdue
                      ? 'border-amber-200 bg-red-700 ring-2 ring-amber-400'
                      : isSevere
                        ? 'border-white bg-red-600'
                        : 'border-white bg-amber-600'
                  }`}
                >
                  <span>!{badge.count}</span>
                  {isOverdue && (
                    <span className="font-sans text-[9px] uppercase tracking-tight text-amber-100">
                      Tồn đọng
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>

        {/* Interactive Furniture Edit Overlay (Visible strictly when furnitureEditMode && showFurnitureLayer) */}
        {furnitureEditMode && showFurnitureLayer && (
          <div
            data-testid="furniture-edit-overlay"
            className="pointer-events-auto absolute inset-0 z-[18] touch-none"
            onPointerMove={(ev) => {
              const drag = furnitureDragRef.current;
              if (!drag) return;
              const target = furnitureItems.find((i) => i.id === drag.itemId);
              if (!target || target.locked) return;

              const dxPx = ev.clientX - drag.startClientX;
              const dyPx = ev.clientY - drag.startClientY;
              if (Math.hypot(dxPx, dyPx) < 1) return;

              const rawNorm = {
                x: Math.max(
                  0.01,
                  Math.min(
                    0.99,
                    drag.startNormX +
                      dxPx / Math.max(1, canvasSize.width * zoomViewport.scale)
                  )
                ),
                y: Math.max(
                  0.01,
                  Math.min(
                    0.99,
                    drag.startNormY +
                      dyPx / Math.max(1, canvasSize.height * zoomViewport.scale)
                  )
                ),
              };
              const nextPos = snapFurnitureGrid
                ? snapNormalizedPointToGrid(rawNorm, 0.25)
                : rawNorm;

              const nextItems = furnitureItems.map((it) =>
                it.id === drag.itemId
                  ? {
                      ...it,
                      x: Number(nextPos.x.toFixed(4)),
                      y: Number(nextPos.y.toFixed(4)),
                    }
                  : it
              );
              drag.moved = true;
              drag.latestItems = nextItems;
              onUpdateFurnitureItems?.(nextItems);
            }}
            onPointerUp={() => {
              const drag = furnitureDragRef.current;
              if (drag?.moved) {
                onCommitFurnitureItems?.(drag.latestItems);
              }
              furnitureDragRef.current = null;
            }}
            onPointerCancel={() => {
              furnitureDragRef.current = null;
            }}
          >
            <svg
              viewBox={`0 0 ${canvasSize.width} ${canvasSize.height}`}
              width={canvasSize.width}
              height={canvasSize.height}
              aria-hidden="true"
              className="pointer-events-none absolute inset-0"
            >
              {visibleFurnitureItems.map((item) => {
                const cornersScreen = getFurnitureObbCornersNorm(item).map(toScreenPx);
                const points = cornersScreen
                  .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
                  .join(' ');
                const isSelected = selectedFurnitureSet.has(item.id);
                const isInvalid = invalidFurnitureSet.has(item.id);
                return (
                  <polygon
                    key={`poly-${item.id}`}
                    points={points}
                    fill={
                      isInvalid
                        ? 'rgba(239, 68, 68, 0.24)'
                        : isSelected
                          ? 'rgba(56, 189, 248, 0.22)'
                          : 'rgba(148, 163, 184, 0.14)'
                    }
                    stroke={
                      isInvalid
                        ? '#EF4444'
                        : isSelected
                          ? '#38BDF8'
                          : item.locked
                            ? '#F59E0B'
                            : '#CBD5E1'
                    }
                    strokeWidth={isSelected || isInvalid ? 2.2 : 1.2}
                    strokeDasharray={item.locked ? '3 2' : undefined}
                  />
                );
              })}
            </svg>

            {visibleFurnitureItems.map((item) => {
              const centerScreen = toScreenPx({ x: item.x, y: item.y });
              const entry = resolveFurnitureCatalogEntry(
                item.typeId,
                furnitureCatalog
              );
              const isSelected = selectedFurnitureSet.has(item.id);
              const isInvalid = invalidFurnitureSet.has(item.id);
              return (
                <div
                  key={item.id}
                  style={{
                    left: `${centerScreen.x}px`,
                    top: `${centerScreen.y}px`,
                  }}
                  className="absolute -translate-x-1/2 -translate-y-1/2"
                >
                  <button
                    type="button"
                    data-testid={`furniture-gizmo-${item.id}`}
                    data-locked={item.locked ? 'true' : 'false'}
                    data-selected={isSelected ? 'true' : 'false'}
                    data-invalid={isInvalid ? 'true' : 'false'}
                    data-x={item.x}
                    data-y={item.y}
                    aria-label={`${item.label || entry.shortLabel}${
                      item.locked ? ' (Đã khóa)' : ''
                    }`}
                    onPointerDown={(ev) => {
                      ev.stopPropagation();
                      if (ev.shiftKey) {
                        const nextSel = isSelected
                          ? selectedFurnitureIds.filter((id) => id !== item.id)
                          : [...selectedFurnitureIds, item.id];
                        onSelectFurnitureIds?.(nextSel);
                      } else {
                        onSelectFurnitureIds?.([item.id]);
                      }
                      if (item.locked) return;
                      furnitureDragRef.current = {
                        itemId: item.id,
                        startClientX: ev.clientX,
                        startClientY: ev.clientY,
                        startNormX: item.x,
                        startNormY: item.y,
                        latestItems: [...furnitureItems],
                        moved: false,
                      };
                    }}
                    onClick={(ev) => {
                      ev.stopPropagation();
                    }}
                    className={`flex min-h-[28px] min-w-[28px] items-center justify-center rounded border px-1 font-mono text-[10px] font-semibold shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
                      isInvalid
                        ? 'border-red-400 bg-red-950/90 text-red-100'
                        : isSelected
                          ? 'border-sky-300 bg-sky-900/95 text-white'
                          : 'border-slate-500/80 bg-slate-900/80 text-slate-100'
                    } ${item.locked ? 'cursor-not-allowed' : 'cursor-grab active:cursor-grabbing'}`}
                  >
                    <span>{item.label || entry.shortLabel}</span>
                    {item.locked && <span className="ml-1 text-amber-300">🔒</span>}
                  </button>

                  {isSelected &&
                    !item.locked &&
                    selectedFurnitureIds.length === 1 && (
                      <button
                        type="button"
                        data-testid={`furniture-gizmo-rotate-${item.id}`}
                        aria-label={`Xoay ${item.label || entry.shortLabel} +45 độ`}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          const nextItems = furnitureItems.map((it) =>
                            it.id === item.id
                              ? { ...it, rotationDeg: (it.rotationDeg + 45) % 360 }
                              : it
                          );
                          onUpdateFurnitureItems?.(nextItems);
                          onCommitFurnitureItems?.(nextItems);
                        }}
                        className="mt-1 block rounded border border-sky-400 bg-slate-900/95 px-1.5 py-0.5 text-[9px] font-bold text-sky-200 shadow hover:bg-sky-900"
                      >
                        ↻ 45°
                      </button>
                    )}
                </div>
              );
            })}
          </div>
        )}

        {/* Hover / Click Quick Room Popover (Edge-flipped inside viewport) */}
        {hoveredPopoverData && (
          <div
            data-testid="room-hover-popover-wrapper"
            data-placement={hoveredPopoverData.placement}
            data-align={hoveredPopoverData.align}
            style={{
              left: `${hoveredPopoverData.left}px`,
              top: `${hoveredPopoverData.top}px`,
            }}
            className="pointer-events-auto absolute z-20"
          >
            <RoomHoverPopover
              room={hoveredPopoverData.room}
              layer={layer}
              value={hoveredPopoverData.value}
              historyValues={hoveredPopoverData.historyValues}
              oneHourDelta={hoveredPopoverData.oneHourDelta}
              playbackState={hoveredPopoverData.playbackState}
              openAlertsCount={hoveredPopoverData.openAlertsCount}
              preset={hoveredPopoverData.preset}
              reliability={hoveredPopoverData.reliability}
              onInspectRoom={(room) => {
                onSelectRoom(room);
                setZoomedRoomId(room.id);
              }}
            />
          </div>
        )}

        {/* Edge-flipped Reading Bay Tooltip */}
        {hoveredBayTooltipData && (
          <div
            role="tooltip"
            data-testid="bay-hover-tooltip"
            data-placement={hoveredBayTooltipData.placement}
            data-align={hoveredBayTooltipData.align}
            style={{
              left: `${hoveredBayTooltipData.left}px`,
              top: `${hoveredBayTooltipData.top}px`,
            }}
            className="pointer-events-none absolute z-30 w-56 rounded-lg border border-slate-200 bg-white p-2.5 text-xs text-slate-800 shadow-xl"
          >
            <p className="font-semibold text-slate-900">
              {hoveredBayTooltipData.bay.nameVi}
            </p>
            <p className="mt-0.5 text-2xs text-slate-500">
              {hoveredBayTooltipData.bay.descriptionVi}
            </p>
            <div className="mt-1.5 grid grid-cols-2 gap-1 border-t border-slate-100 pt-1.5 font-mono text-2xs text-slate-700">
              <span>Tiện nghi: {hoveredBayTooltipData.bay.metrics.comfortScore}</span>
              <span>Sức chứa: {hoveredBayTooltipData.bay.seatCapacity} chỗ</span>
              <span>Nhiệt: {hoveredBayTooltipData.bay.metrics.temperature}°C</span>
              <span>Ồn: {hoveredBayTooltipData.bay.metrics.noiseAvg} dBA</span>
              <span>Sáng: {hoveredBayTooltipData.bay.metrics.lux} lx</span>
              <span>Ẩm: {hoveredBayTooltipData.bay.metrics.humidity}%RH</span>
            </div>
          </div>
        )}

        {/* Edge-flipped Device Tooltip */}
        {hoveredDeviceTooltipData && (
          <div
            role="tooltip"
            data-testid="device-hover-tooltip"
            data-placement={hoveredDeviceTooltipData.placement}
            data-align={hoveredDeviceTooltipData.align}
            style={{
              left: `${hoveredDeviceTooltipData.left}px`,
              top: `${hoveredDeviceTooltipData.top}px`,
            }}
            className={`pointer-events-none absolute z-30 w-56 rounded-lg border bg-white p-2.5 text-xs text-slate-800 shadow-lg ${
              hoveredDeviceTooltipData.isFocusedDevice
                ? 'border-rose-400 ring-2 ring-rose-500/30'
                : 'border-slate-200'
            }`}
          >
            {hoveredDeviceTooltipData.isFocusedDevice && (
              <div className="mb-1.5 rounded bg-rose-50 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700">
                Node cảnh báo đang định vị
              </div>
            )}
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-semibold text-slate-900">
                {hoveredDeviceTooltipData.device.name}
              </span>
              <span
                className={`badge ${
                  hoveredDeviceTooltipData.device.online
                    ? 'badge-success'
                    : 'badge-neutral'
                }`}
              >
                {hoveredDeviceTooltipData.device.online
                  ? 'Trực tuyến'
                  : 'Mất kết nối'}
              </span>
            </div>
            <p className="mt-0.5 font-mono text-2xs text-slate-400">
              {hoveredDeviceTooltipData.device.hardwareId}
            </p>
            {hoveredDeviceTooltipData.room && (
              <p className="mt-0.5 truncate text-2xs text-slate-500">
                {hoveredDeviceTooltipData.room.code} —{' '}
                {hoveredDeviceTooltipData.room.name}
              </p>
            )}
            <div className="mt-2 grid grid-cols-2 gap-1 border-t border-slate-100 pt-1.5 font-mono text-2xs text-slate-600">
              <span>
                Điểm:{' '}
                {formatMetrics.comfortScore(
                  hoveredDeviceTooltipData.devTel?.comfortScore?.overall
                )}
              </span>
              <span>
                Ồn:{' '}
                {formatMetrics.noise(
                  hoveredDeviceTooltipData.devTel?.acoustics?.noiseAvg
                )}
              </span>
              <span>
                PM2.5:{' '}
                {formatMetrics.pm(
                  hoveredDeviceTooltipData.devTel?.airQuality?.pm2_5
                )}
              </span>
              <span>
                Nhiệt:{' '}
                {formatMetrics.temperature(
                  hoveredDeviceTooltipData.devTel?.environment?.temperature
                )}
              </span>
              <span>
                Ẩm:{' '}
                {formatMetrics.humidity(
                  hoveredDeviceTooltipData.devTel?.environment?.humidity
                )}
              </span>
              <span>
                Sáng:{' '}
                {formatMetrics.lux(hoveredDeviceTooltipData.devTel?.environment?.lux)}
              </span>
              <span className="col-span-2">
                Wi-Fi RSSI:{' '}
                {formatMetrics.rssi(hoveredDeviceTooltipData.devTel?.wifiRssi)}
              </span>
            </div>
          </div>
        )}

        {/* Minimap Navigation Overlay (Visible when scale > 1.15) */}
        <FloorplanMinimap
          viewport={zoomViewport}
          canvasWidth={canvasSize.width}
          canvasHeight={canvasSize.height}
          rooms={minimapRooms}
          activeFloor={activeFloor}
          onNavigate={(nextVp) => commitViewport(nextVp)}
          positionCorner={selectedRoomId ? 'bottom-left' : 'bottom-right'}
        />
      </div>
    </div>
  );
}
