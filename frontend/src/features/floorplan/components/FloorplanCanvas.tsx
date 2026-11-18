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
  getLodConfig,
  type LabelDensity,
  type LabelRequest,
  type Obstacle,
  type RoomLabelStyle,
} from '@/lib/floorplan/labelLayout';
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
import { formatMetrics } from '@/lib/format/metrics';
import { FLOORPLAN_I18N_VI } from '@/messages/vi';
import {
  FloorplanMinimap,
  type MinimapRoomShape,
} from '@/features/floorplan/components/FloorplanMinimap';
import { RoomHoverPopover } from '@/features/floorplan/components/RoomHoverPopover';
import type {
  AlertSeverity,
  DeviceResponse,
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
  /** Trạng thái lọc đang kích hoạt từ Dải tóm tắt Quản lý */
  activeStatusFilter?: ManagerStatusFilter;
  /** Bản đồ đánh dấu phòng nào khớp với bộ lọc (phòng không khớp bị làm mờ) */
  roomMatchesFilterMap?: Record<string, boolean>;
  /** Điều khiển viewport từ bên ngoài (dành cho Deep Link / đồng bộ Minimap) */
  viewport?: ViewportTransform;
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
  /** Chỉ hiện vùng vượt ngưỡng (chế độ lọc ISA-101 Deviation) */
  onlyExceedingThreshold?: boolean;
  /** Chuỗi lịch sử gần nhất theo roomId (để vẽ sparkline trên hover popover) */
  roomTelemetryHistoryMap?: Record<string, readonly number[]>;
  /** Bật/tắt popover chi tiết khi di chuột qua phòng */
  showHoverPopover?: boolean;
}

export function FloorplanCanvas({
  rooms,
  devices,
  roomTelemetryMap,
  deviceTelemetryMap = {},
  layer,
  selectedRoomId,
  onSelectRoom,
  onSelectDevice,
  zoomedRoomId: controlledZoomedRoomId,
  onZoomRoomChange,
  selectedBayId,
  onSelectBay,
  showBlindspots = false,
  showTechOverlay = false,
  highlightedZoneIds,
  firingRoomIds = [],
  focusedDeviceId = null,
  alertingDeviceIds = [],
  defaultLabelDensity,
  roomAlertCounts,
  roomAlertSeverities,
  activeStatusFilter = 'ALL',
  roomMatchesFilterMap,
  viewport: controlledViewport,
  onViewportChange,
  isFullscreen: controlledFullscreen,
  onToggleFullscreen,
  maxViewportHeightPx,
  onHoverRoomChange,
  onlyExceedingThreshold = false,
  roomTelemetryHistoryMap,
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
  const [internalViewport, setInternalViewport] = useState<ViewportTransform>({
    scale: 1,
    tx: 0,
    ty: 0,
  });
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
  const prevFloorRef = useRef<number>(activeFloor);
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
    () => getLodConfig(labelDensity, zoomViewport.isZoomed),
    [labelDensity, zoomViewport.isZoomed]
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

    ctx.restore();
    ctx.restore();
  }, [
    canvasSize,
    activeFloor,
    showCadUnderlay,
    cadImageLoadedFloor,
    zoomViewport,
    lodConfig.showAtriumText,
    labelDensity,
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
          microZones.length > 0
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
            skipDarkBase: true,
            onlyExceedingThreshold,
            roomExceedsThreshold,
          }
        );

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
          : isSuppressedNormalRoom
            ? 'rgba(100, 116, 139, 0.55)'
            : getContinuousMetricColorCss(layer, primaryValue);

        ctx.beginPath();
        pixelVertices.forEach((p, vIdx) => {
          if (vIdx === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        });
        ctx.closePath();

        if (isSelected || isZoomTarget) {
          ctx.lineWidth = 3.2 / Math.sqrt(zoomViewport.scale);
          ctx.strokeStyle = '#38BDF8';
        } else if (isZoneHighlighted) {
          ctx.lineWidth = 2.6 / Math.sqrt(zoomViewport.scale);
          ctx.strokeStyle = '#F59E0B';
        } else {
          ctx.lineWidth = 1.8 / Math.sqrt(zoomViewport.scale);
          ctx.strokeStyle = wallColor;
        }
        ctx.stroke();

        if (hasAlert) {
          alertingRoomOutlines.push({
            roomId: room.id,
            pixelVertices,
            severity: alertSeverity,
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
        const isSmallGroupRoom = areaM2 < 65;

        const isSyntheticRoom =
          room.id.startsWith('PRESET_') || Boolean(roomLatest?.isSynthetic);
        const codeLabel = preset?.code ?? room.code;
        const shortCode = codeLabel.replace(/^TQB_/, 'P.');
        const metricLabel = hasOnlineTelemetry
          ? formatLayerMetricValue(primaryValue, layer)
          : 'Offline';
        const statusPrefix =
          metricStatus.level !== 'NO_DATA' && metricStatus.level !== 'NORMAL'
            ? `${metricStatus.symbol} `
            : '';
        const compactText = isSyntheticRoom
          ? `${statusPrefix}${shortCode} · ${metricLabel} (MP)`
          : `${statusPrefix}${shortCode} · ${metricLabel}`;

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
          ? `${codeLabel} · Mô phỏng`
          : codeLabel;
        const subLine =
          zoomViewport.isZoomed && spreadText
            ? `${statusPrefix}${metricLabel} · ${spreadText}`
            : `${statusPrefix}${metricLabel}`;

        let effectiveStyle: RoomLabelStyle = lodConfig.roomLabel;
        if (zoomViewport.isZoomed) {
          effectiveStyle = isZoomTarget ? 'rich' : 'code';
        } else if (
          effectiveStyle === 'rich' &&
          isSmallGroupRoom &&
          !isSelected
        ) {
          effectiveStyle = 'pill';
        }

        const shouldPlaceInPass =
          isZoomTarget ||
          isSelected ||
          hasAlert ||
          areaM2 >= lodConfig.hideSmallRoomsUnderM2;

        const severityWeight =
          alertSeverity === 'CRITICAL'
            ? 4
            : alertSeverity === 'HIGH'
              ? 3
              : alertSeverity === 'MEDIUM'
                ? 2
                : hasAlert
                  ? 1
                  : 0;

        const priority =
          (isZoomTarget ? 2_000_000 : 0) +
          severityWeight * 200_000 +
          (isSelected ? 50_000 : 0) +
          areaM2;

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

      for (const dev of positionedDevices) {
        const px = normToScreen({ x: dev.posX!, y: dev.posY! });
        if (px.x < -20 || px.x > width + 20 || px.y < -20 || px.y > height + 20)
          continue;
        const isInZoomedRoom =
          zoomViewport.isZoomed && dev.roomId === zoomedRoomId;
        const isPin = zoomViewport.isZoomed
          ? isInZoomedRoom
          : lodConfig.sensorStyle === 'pin';
        if (isPin) {
          obstacles.push({ x: px.x, y: px.y + 8, r: 22 });
        } else {
          obstacles.push({
            x: px.x,
            y: px.y,
            r: Math.round(lodConfig.sensorDotSizePx * 0.5) + 4,
          });
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

      const measureRoomLabelBox = (
        item: PreparedRoomLabel,
        style: RoomLabelStyle
      ): { width: number; height: number } => {
        if (style === 'code') {
          ctx.font = '700 10.5px JetBrains Mono, monospace';
          return {
            width: Math.ceil((ctx.measureText?.(item.shortCode)?.width ?? item.shortCode.length * 6.5) + 8),
            height: 16,
          };
        }
        if (style === 'pill') {
          ctx.font = '700 10.5px JetBrains Mono, monospace';
          return {
            width: Math.max(
              54,
              Math.ceil((ctx.measureText?.(item.compactText)?.width ?? item.compactText.length * 6.5) + 14)
            ),
            height: 20,
          };
        }
        ctx.font = 'bold 12px Inter, system-ui, sans-serif';
        const titleW = ctx.measureText?.(item.titleLine)?.width ?? item.titleLine.length * 7;
        ctx.font = '600 10.5px JetBrains Mono, monospace';
        const subW = ctx.measureText?.(item.subLine)?.width ?? item.subLine.length * 6.5;
        let warnW = 0;
        if (item.techWarningText) {
          ctx.font = 'bold 9.5px Inter, system-ui, sans-serif';
          warnW = ctx.measureText?.(item.techWarningText)?.width ?? item.techWarningText.length * 6;
        }
        return {
          width: Math.ceil(Math.max(titleW, subW, warnW) + 18),
          height: item.techWarningText ? 48 : 36,
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
          ctx.font = '700 10.5px JetBrains Mono, monospace';
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

          ctx.font = '700 10.5px JetBrains Mono, monospace';
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

        ctx.font = 'bold 12px Inter, system-ui, sans-serif';
        ctx.fillStyle = '#F8FAFC';
        ctx.fillText(
          item.titleLine,
          cx,
          cy - (item.techWarningText ? 13 : 7)
        );

        ctx.font = '600 10.5px JetBrains Mono, monospace';
        ctx.fillStyle = item.hasOnlineTelemetry ? '#38BDF8' : '#94A3B8';
        ctx.fillText(
          item.subLine,
          cx,
          cy + (item.techWarningText ? 1 : 8)
        );

        if (item.techWarningText) {
          ctx.font = 'bold 9.5px Inter, system-ui, sans-serif';
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
        return {
          id: item.roomId,
          anchor: item.anchorScreen,
          width: dims.width,
          height: dims.height,
          polygon: item.screenPolygon,
          priority: item.priority,
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

        if (item.hasAlert && item.alertCount > 0) {
          const bx = placement?.visible ? placement.x + req.width * 0.5 : item.anchorScreen.x + 18;
          const by = placement?.visible ? placement.y - req.height * 0.5 : item.anchorScreen.y - 14;
          computedBadges.push({
            roomId: item.roomId,
            code: item.shortCode,
            count: item.alertCount,
            severity: item.alertSeverity,
            x: Math.max(16, Math.min(width - 16, bx)),
            y: Math.max(16, Math.min(height - 16, by)),
          });
        }

        if (!placement || !placement.visible) continue;
        if (
          hoveredRoomId === item.roomId &&
          !hoveredDeviceId &&
          !hoveredBayId &&
          item.style !== 'rich'
        ) {
          continue;
        }
        drawRoomLabelAt(
          item,
          item.style,
          placement.x,
          placement.y,
          req.width,
          req.height,
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
          const wasRichAndVisible =
            placedIdx >= 0 &&
            activeCandidates[placedIdx].style === 'rich' &&
            placements[placedIdx]?.visible;
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
    positionedDevices,
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
    showTechOverlay,
    zoomViewport,
    highlightedZoneIds,
    firingRoomSet,
    roomAlertCounts,
    roomAlertSeverities,
    activeStatusFilter,
    roomMatchesFilterMap,
    onlyExceedingThreshold,
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

    const popoverW = 288;
    const popoverH = 240;
    const margin = 8;
    const gap = 28;
    const fitsRight = anchor.x + gap + popoverW <= canvasSize.width - margin;
    const rawLeft = fitsRight
      ? anchor.x + gap
      : Math.max(margin, anchor.x - gap - popoverW);
    const clampedLeft = Math.max(
      margin,
      Math.min(Math.max(margin, canvasSize.width - popoverW - margin), rawLeft)
    );
    const preferredTop = anchor.y - popoverH * 0.45;
    const clampedTop = Math.max(
      margin,
      Math.min(
        Math.max(margin, canvasSize.height - popoverH - margin),
        preferredTop
      )
    );

    const openAlertsCount =
      roomAlertCounts?.[room.id] ?? (firingRoomSet.has(room.id) ? 1 : 0);

    return {
      room,
      preset,
      value: primaryVal,
      historyValues: roomTelemetryHistoryMap?.[room.id],
      openAlertsCount,
      left: clampedLeft,
      top: clampedTop,
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

        {/* Layer 2B: Anonymous Reading Bay Micro-zones (FE-VIZ-09) */}
        <div className="pointer-events-none absolute inset-0 z-[6]">
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
                {showFullPill ? (
                  <button
                    type="button"
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
                    className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-semibold shadow-md transition-transform hover:scale-110 ${
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
                  </button>
                ) : (
                  <button
                    type="button"
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
                    className="flex h-3 w-3 items-center justify-center rounded-full border border-white/85 shadow transition-transform hover:scale-125"
                    style={{
                      backgroundColor: colorCss,
                      boxShadow: `0 0 8px ${colorCss}`,
                    }}
                  />
                )}

                {isHoveredBay && (
                  <div
                    role="tooltip"
                    className="pointer-events-none absolute bottom-8 left-1/2 z-30 w-56 -translate-x-1/2 rounded-lg border border-slate-200 bg-white p-2.5 text-xs text-slate-800 shadow-xl"
                  >
                    <p className="font-semibold text-slate-900">{bay.nameVi}</p>
                    <p className="mt-0.5 text-2xs text-slate-500">
                      {bay.descriptionVi}
                    </p>
                    <div className="mt-1.5 grid grid-cols-2 gap-1 border-t border-slate-100 pt-1.5 font-mono text-2xs text-slate-700">
                      <span>Tiện nghi: {bay.metrics.comfortScore}</span>
                      <span>Sức chứa: {bay.seatCapacity} chỗ</span>
                      <span>Nhiệt: {bay.metrics.temperature}°C</span>
                      <span>Ồn: {bay.metrics.noiseAvg} dBA</span>
                      <span>Sáng: {bay.metrics.lux} lx</span>
                      <span>Ẩm: {bay.metrics.humidity}%RH</span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Layer 2C: Interactive Hardware Device Pins Overlay */}
        <div className="pointer-events-none absolute inset-0 z-[8]">
          {positionedDevices.map((device) => {
            const px = toScreenPx({ x: device.posX!, y: device.posY! });
            if (
              px.x < -10 ||
              px.x > canvasSize.width + 10 ||
              px.y < -10 ||
              px.y > canvasSize.height + 10
            ) {
              return null;
            }
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
            const isHovered = hoveredDeviceId === device.id;

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
              alertingDeviceIds.includes(device.id) ||
              alertingDeviceIds.includes(device.hardwareId);

            const usePinStyle =
              isFocusedDevice ||
              isAlertingDevice ||
              (zoomViewport.isZoomed
                ? isInZoomedRoom
                : lodConfig.sensorStyle === 'pin');
            const showBadge =
              isFocusedDevice ||
              isAlertingDevice ||
              (zoomViewport.isZoomed
                ? isInZoomedRoom
                : lodConfig.showSensorBadge);
            const dotSizeClass =
              labelDensity === 'clean' && !zoomViewport.isZoomed
                ? 'h-2.5 w-2.5'
                : 'h-3 w-3';

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
                        ? '-inset-3.5 motion-safe:animate-ping bg-rose-500 opacity-80'
                        : isAlertingDevice
                          ? '-inset-2.5 motion-safe:animate-ping bg-rose-500 opacity-65'
                          : '-inset-2 motion-safe:animate-ping opacity-60'
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
                    className="pointer-events-none absolute -inset-2 rounded-full border-2 border-rose-400 shadow-[0_0_16px_rgba(244,63,94,0.9)]"
                  />
                )}
                {usePinStyle ? (
                  <button
                    type="button"
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
                    className={`relative group flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold transition-all hover:scale-125 focus:scale-125 focus:outline-none focus:ring-2 focus:ring-sky-400 ${
                      isFocusedDevice
                        ? 'scale-125 border-2 border-rose-300 ring-2 ring-rose-500 shadow-xl'
                        : device.online
                          ? 'border-2 border-white shadow-lg'
                          : 'border-2 border-dashed border-slate-400 bg-slate-800/90 text-slate-300 opacity-85'
                    }`}
                    style={
                      device.online
                        ? {
                            backgroundColor: isFocusedDevice ? '#F43F5E' : colorHex,
                            color: isFocusedDevice ? '#FFFFFF' : '#0F172A',
                            boxShadow: isFocusedDevice
                              ? '0 0 18px #F43F5E, 0 2px 6px rgba(0,0,0,0.75)'
                              : `0 0 14px ${colorHex}, 0 2px 4px rgba(0,0,0,0.6)`,
                            transition: pinTransitionCss,
                          }
                        : undefined
                    }
                  >
                    <span aria-hidden="true">{device.online ? '●' : '✕'}</span>
                  </button>
                ) : (
                  <button
                    type="button"
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
                    className={`relative group flex ${dotSizeClass} items-center justify-center rounded-full transition-all hover:scale-150 focus:scale-150 focus:outline-none focus:ring-2 focus:ring-sky-400 ${
                      device.online
                        ? 'border border-white/95 shadow'
                        : 'border border-dashed border-slate-400 bg-slate-800/90 opacity-85'
                    }`}
                    style={
                      device.online
                        ? {
                            backgroundColor: colorHex,
                            boxShadow: `0 0 10px ${colorHex}, 0 1px 3px rgba(0,0,0,0.65)`,
                            transition: pinTransitionCss,
                          }
                        : undefined
                    }
                  />
                )}

                {(showBadge && activeVal !== null) || isFocusedDevice ? (
                  <div
                    className="pointer-events-none mt-1 rounded border px-1.5 py-0.5 text-center font-mono text-2xs font-bold shadow-md"
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

                {(isHovered || isFocusedDevice) && (
                  <div
                    role="tooltip"
                    className={`pointer-events-none absolute bottom-10 left-1/2 z-30 w-56 -translate-x-1/2 rounded-lg border bg-white p-2.5 text-xs text-slate-800 shadow-lg ${
                      isFocusedDevice
                        ? 'border-rose-400 ring-2 ring-rose-500/30'
                        : 'border-slate-200'
                    }`}
                  >
                    {isFocusedDevice && (
                      <div className="mb-1.5 rounded bg-rose-50 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700">
                        Node cảnh báo đang định vị
                      </div>
                    )}
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-semibold text-slate-900">
                        {device.name}
                      </span>
                      <span
                        className={`badge ${
                          device.online ? 'badge-success' : 'badge-neutral'
                        }`}
                      >
                        {device.online ? 'Trực tuyến' : 'Mất kết nối'}
                      </span>
                    </div>
                    <p className="mt-0.5 font-mono text-2xs text-slate-400">
                      {device.hardwareId}
                    </p>
                    {room && (
                      <p className="mt-0.5 truncate text-2xs text-slate-500">
                        {room.code} — {room.name}
                      </p>
                    )}
                    <div className="mt-2 grid grid-cols-2 gap-1 border-t border-slate-100 pt-1.5 font-mono text-2xs text-slate-600">
                      <span>
                        Điểm:{' '}
                        {formatMetrics.comfortScore(
                          devTel?.comfortScore?.overall
                        )}
                      </span>
                      <span>
                        Ồn: {formatMetrics.noise(devTel?.acoustics?.noiseAvg)}
                      </span>
                      <span>
                        PM2.5: {formatMetrics.pm(devTel?.airQuality?.pm2_5)}
                      </span>
                      <span>
                        Nhiệt:{' '}
                        {formatMetrics.temperature(
                          devTel?.environment?.temperature
                        )}
                      </span>
                      <span>
                        Ẩm:{' '}
                        {formatMetrics.humidity(devTel?.environment?.humidity)}
                      </span>
                      <span>
                        Sáng: {formatMetrics.lux(devTel?.environment?.lux)}
                      </span>
                      <span className="col-span-2">
                        Wi-Fi RSSI: {formatMetrics.rssi(devTel?.wifiRssi)}
                      </span>
                    </div>
                  </div>
                )}
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
            {alertingScreenOutlines.map((outline) => (
              <polygon
                key={outline.roomId}
                points={outline.points}
                fill="none"
                stroke={outline.isSevere ? '#F87171' : '#FBBF24'}
                strokeWidth={2.5}
                className="motion-safe:animate-pulse"
                style={{
                  animationDuration: `${TIMING_CONFIG.alertPulsePeriodMs}ms`,
                }}
              />
            ))}
          </svg>
        )}

        {/* Layer 3 (Topmost DOM Alert Badges !N — never occluded by furniture or labels) */}
        <div
          data-testid="room-alert-badges-layer"
          className="pointer-events-none absolute inset-0 z-[15]"
        >
          {roomBadgeAnchors.map((badge) => {
            const roomObj = roomById.get(badge.roomId);
            const isSevere =
              badge.severity === 'CRITICAL' ||
              badge.severity === 'HIGH' ||
              !badge.severity;
            return (
              <button
                key={badge.roomId}
                type="button"
                data-testid={`room-alert-badge-${badge.roomId}`}
                style={{ left: `${badge.x}px`, top: `${badge.y}px` }}
                onClick={(ev) => {
                  ev.stopPropagation();
                  if (roomObj) onSelectRoom(roomObj);
                }}
                aria-label={`${badge.code}: ${badge.count} cảnh báo đang mở`}
                className={`pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 inline-flex items-center gap-0.5 rounded-full border border-white px-1.5 py-0.5 font-mono text-[10px] font-bold text-white shadow-md motion-safe:animate-pulse ${
                  isSevere ? 'bg-red-600' : 'bg-amber-600'
                }`}
              >
                <span>!{badge.count}</span>
              </button>
            );
          })}
        </div>

        {/* Hover / Click Quick Room Popover (Value, Threshold Status, Sparkline & SOP) */}
        {hoveredPopoverData && (
          <div
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
              openAlertsCount={hoveredPopoverData.openAlertsCount}
              preset={hoveredPopoverData.preset}
              onInspectRoom={(room) => {
                onSelectRoom(room);
                setZoomedRoomId(room.id);
              }}
            />
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
