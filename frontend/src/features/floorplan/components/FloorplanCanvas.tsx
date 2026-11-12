'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
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
  clampViewportTransform,
  computePinchScale,
  normalizedToPixel,
  pixelToNormalized,
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
  renderWeatherDiffusionHeatmap,
} from '@/lib/floorplan/weatherPalette';
import { formatMetrics } from '@/lib/format/metrics';
import type {
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
  /** Bật/tắt chế độ Phóng đại Cấp 2 (Room Focus Zoom) */
  zoomedRoomId?: string | null;
  onZoomRoomChange?: (roomId: string | null) => void;
  /** Phân khu bàn đọc đang được chọn / gợi ý (dành cho Smart Study Spot Finder) */
  selectedBayId?: string | null;
  onSelectBay?: (bay: AnonymousMicroZone, room: RoomResponse) => void;
  /** Hiển thị vùng mù cảm biến (fieldPresence < 0.25) cho Role MAINTENANCE */
  showBlindspots?: boolean;
  /** Hiển thị lớp chẩn đoán kỹ thuật (chênh nhiệt cục bộ ΔT, RSSI, % vùng mù) */
  showTechOverlay?: boolean;
  /** Danh sách mã Zone phụ trách của ZONE_MANAGER để làm nổi bật */
  highlightedZoneIds?: readonly string[];
  /** Danh sách roomId đang có cảnh báo FIRING để vẽ vòng nhấp nháy cảnh báo (GĐ3.5) */
  firingRoomIds?: readonly string[];
  /** Node cảm biến đang được định vị / chọn trực tiếp từ cảnh báo */
  focusedDeviceId?: string | null;
  /** Danh sách ID hoặc hardwareId của các node cảm biến đang có cảnh báo FIRING / ACKNOWLEDGED */
  alertingDeviceIds?: readonly string[];
  /** Mật độ hiển thị nhãn khởi tạo; người dùng vẫn đổi được qua nút gạt trên bản đồ */
  defaultLabelDensity?: LabelDensity;
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
}: FloorplanCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
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
  const [displayValues, setDisplayValues] = useState<Record<string, number>>(
    {}
  );
  const [internalZoomedRoomId, setInternalZoomedRoomId] = useState<
    string | null
  >(null);
  const [showCadUnderlay, setShowCadUnderlay] = useState<boolean>(true);
  const [cadImageLoadedFloor, setCadImageLoadedFloor] = useState<number | null>(
    null
  );
  const [gestureViewport, setGestureViewport] = useState<{
    scale: number;
    tx: number;
    ty: number;
  } | null>(null);
  const activePointersRef = useRef<Map<number, { x: number; y: number }>>(
    new Map()
  );
  const pinchStartRef = useRef<{ dist: number; scale: number } | null>(null);

  useEffect(() => {
    if (defaultLabelDensity) {
      setLabelDensity(defaultLabelDensity);
    }
  }, [defaultLabelDensity]);

  const zoomedRoomId =
    controlledZoomedRoomId !== undefined
      ? controlledZoomedRoomId
      : internalZoomedRoomId;

  const setZoomedRoomId = (nextId: string | null) => {
    setInternalZoomedRoomId(nextId);
    onZoomRoomChange?.(nextId);
  };

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

  // Tính toán khung nhìn Phóng đại 2 cấp (Level 1: Toàn tầng 1.0x <-> Level 2: Phóng to phòng 2.15x)
  const zoomViewport = useMemo(() => {
    if (!zoomedRoomId) {
      if (gestureViewport && gestureViewport.scale > 1.01) {
        return {
          scale: gestureViewport.scale,
          tx: gestureViewport.tx,
          ty: gestureViewport.ty,
          isZoomed: true,
        };
      }
      return { scale: 1, tx: 0, ty: 0, isZoomed: false };
    }
    const target = enrichedRooms.find((er) => er.room.id === zoomedRoomId);
    if (!target) {
      return { scale: 1, tx: 0, ty: 0, isZoomed: false };
    }

    let minX = 1;
    let maxX = 0;
    let minY = 1;
    let maxY = 0;
    for (const pt of target.polygon) {
      if (pt.x < minX) minX = pt.x;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.y > maxY) maxY = pt.y;
    }

    const spanX = Math.max(0.28, (maxX - minX) * 1.45);
    const spanY = Math.max(0.28, (maxY - minY) * 1.45);
    const scale = Math.max(1.65, Math.min(2.65, 1 / Math.max(spanX, spanY)));

    const centerX = ((minX + maxX) * 0.5) * canvasSize.width;
    const centerY = ((minY + maxY) * 0.5) * canvasSize.height;

    const rawTx = canvasSize.width * 0.5 - centerX * scale;
    const rawTy = canvasSize.height * 0.5 - centerY * scale;

    const minTx = canvasSize.width * (1 - scale);
    const minTy = canvasSize.height * (1 - scale);

    return {
      scale: gestureViewport?.scale ?? scale,
      tx: gestureViewport?.tx ?? Math.max(minTx, Math.min(0, rawTx)),
      ty: gestureViewport?.ty ?? Math.max(minTy, Math.min(0, rawTy)),
      isZoomed: true,
    };
  }, [
    zoomedRoomId,
    enrichedRooms,
    canvasSize.width,
    canvasSize.height,
    gestureViewport,
  ]);

  const toScreenPx = (normPt: Point2D): Point2D => {
    const base = normalizedToPixel(normPt, canvasSize.width, canvasSize.height);
    return {
      x: base.x * zoomViewport.scale + zoomViewport.tx,
      y: base.y * zoomViewport.scale + zoomViewport.ty,
    };
  };

  const lodConfig = useMemo(
    () => getLodConfig(labelDensity, zoomViewport.isZoomed),
    [labelDensity, zoomViewport.isZoomed]
  );

  // Devices on this floor (Role ADMIN / LIBRARIAN / MAINTENANCE), falling back to room centroid if posX/posY not yet set
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

  // Anonymous Reading Bays to display as interactive pills/dots when hardware devices are hidden (FE-VIZ-09) or when zoomed into a room
  const visibleAnonymousBays = useMemo(() => {
    const items: Array<{ bay: AnonymousMicroZone; room: RoomResponse }> = [];
    for (const { room, preset, microZones } of enrichedRooms) {
      const roomHasDevices = positionedDevices.some(
        (d) => d.roomId === room.id
      );
      const isFocused = room.id === zoomedRoomId || room.id === selectedRoomId;
      const isLargeRoom = (preset?.areaM2 ?? 100) >= 120;

      // Show reading bays if:
      // 1) User has no device visibility (USER/VIEWER role) and room is large or selected
      // 2) Room is zoomed in (Level 2 Focus) and has no raw device pin at the exact same spot
      if (!roomHasDevices && (isLargeRoom || isFocused)) {
        for (const bay of microZones) {
          items.push({ bay, room });
        }
      }
    }
    return items;
  }, [enrichedRooms, positionedDevices, zoomedRoomId, selectedRoomId]);

  // Animated smooth values map for gliding transitions (FE-VIZ-04: Anti-flicker temporal smoothstep)
  interface AnimDeviceState {
    current: number;
    from: number;
    target: number;
    startTime: number;
    duration: number;
  }
  const animValuesRef = useRef<Map<string, AnimDeviceState>>(new Map());
  const prevLayerRef = useRef(layer);
  const lastDisplayUpdateRef = useRef<number>(0);

  // Sync new incoming telemetry targets into animated values map
  useEffect(() => {
    const layerChanged = prevLayerRef.current !== layer;
    prevLayerRef.current = layer;

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
        const existing = animValuesRef.current.get(dev.id);
        if (!existing || layerChanged) {
          animValuesRef.current.set(dev.id, {
            current: targetVal,
            from: targetVal,
            target: targetVal,
            startTime: now,
            duration: 2600,
          });
        } else if (Math.abs(existing.target - targetVal) > 0.005) {
          existing.from = existing.current;
          existing.target = targetVal;
          existing.startTime = now;
          existing.duration = 2600;
        }
      }
    }
  }, [devices, deviceTelemetryMap, roomTelemetryMap, layer]);

  // Observe container resize for responsive HiDPI rendering with exact TQB aspect ratio (76.0m x 57.2m -> 0.7526)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      const width = Math.max(320, Math.floor(rect.width));
      const height = Math.max(
        400,
        Math.floor(width * TQB_BUILDING_ASPECT_RATIO)
      );
      setCanvasSize((prev) =>
        prev.width === width && prev.height === height
          ? prev
          : { width, height }
      );
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(el);
    window.addEventListener('resize', updateSize);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateSize);
    };
  }, []);

  // Dual-Layer Canvas Rendering with CAD Underlay, 2-Level Zoom, Adaptive Sigma & Screen-Space Decluttered Labels
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let rafId = 0;
    let isCancelled = false;

    const render = () => {
      if (isCancelled) return;

      const now = performance.now();
      let isTransitioning = false;
      for (const state of animValuesRef.current.values()) {
        const elapsed = now - state.startTime;
        if (elapsed < state.duration) {
          const p = Math.max(0, Math.min(1, elapsed / state.duration));
          const s = p * p * (3 - 2 * p);
          state.current = state.from + (state.target - state.from) * s;
          isTransitioning = true;
        } else {
          state.current = state.target;
        }
      }

      if (isTransitioning) {
        if (now - lastDisplayUpdateRef.current >= 80) {
          lastDisplayUpdateRef.current = now;
          const newDisplays: Record<string, number> = {};
          for (const [id, state] of animValuesRef.current.entries()) {
            newDisplays[id] = Math.round(state.current * 10) / 10;
          }
          setDisplayValues(newDisplays);
        }
      } else if (lastDisplayUpdateRef.current !== 0) {
        lastDisplayUpdateRef.current = 0;
        const newDisplays: Record<string, number> = {};
        for (const [id, state] of animValuesRef.current.entries()) {
          newDisplays[id] = Math.round(state.target * 10) / 10;
        }
        setDisplayValues(newDisplays);
      }

      const dpr =
        typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
      const { width, height } = canvasSize;

      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

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
      ctx.scale(dpr, dpr);

      // 1. Architectural Blueprint Background (Full viewport)
      ctx.fillStyle = '#0B1120';
      ctx.fillRect(0, 0, width, height);

      // Apply 2-Level Zoom Camera Transform
      ctx.save();
      ctx.translate(zoomViewport.tx, zoomViewport.ty);
      ctx.scale(zoomViewport.scale, zoomViewport.scale);

      // Subtle architectural coordinate grid (10m x 10m reference)
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.08)';
      ctx.lineWidth = 1 / zoomViewport.scale;
      const gridStepX = width / 7.6; // 10m intervals across 76.0m
      const gridStepY = height / 5.72; // 10m intervals across 57.2m
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

      // 2. Render Central Atrium Void (Giếng trời thông tầng 417.87 m² trên Tầng 2-5)
      if (activeFloor >= 2) {
        const atriumX = 0.312 * width;
        const atriumY = 0.405 * height;
        const atriumW = 0.376 * width;
        const atriumH = 0.254 * height;
        const radius = Math.min(atriumW, atriumH) * 0.46;

        ctx.save();
        ctx.beginPath();
        ctx.roundRect(atriumX, atriumY, atriumW, atriumH, radius);
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
          ctx.fillText(
            'GIẾNG TRỜI',
            0.5 * width,
            0.532 * height
          );
        }
        ctx.restore();
      }

      interface PreparedRoomLabel {
        roomId: string;
        anchorScreen: Point2D;
        screenPolygon: Point2D[];
        areaM2: number;
        isSelected: boolean;
        isZoomTarget: boolean;
        hasOnlineTelemetry: boolean;
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

      // 3. Render each room polygon with strict ctx.clip() & area-adaptive Gaussian diffusion
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

        // Build sample points from ONLINE devices using smooth animated values
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

        // FE-VIZ-09 Compliant Anonymous Micro-zone Diffusion for USER / VIEWER:
        // When device hardware list is restricted (devices.length === 0) or room only has room-level telemetry,
        // synthesize spatial micro-zones across reading bays so students see realistic Case C gradients!
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

        // Render Meteorological Continuous Gaussian RBF Diffusion Heatmap with Adaptive Sigma & Blindspots
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
          }
        );

        // 4. Draw Architectural Wall Stroke, BTCT Columns & Door inside zoom space
        const isSelected = room.id === selectedRoomId;
        const isZoomTarget = room.id === zoomedRoomId;
        const isZoneHighlighted =
          highlightedZoneIds &&
          highlightedZoneIds.length > 0 &&
          preset &&
          highlightedZoneIds.includes(preset.zoneCode);

        const primaryValue =
          idwSamples.length > 0
            ? idwSamples.reduce((sum, s) => sum + s.value, 0) /
              idwSamples.length
            : roomMetricValue;
        const wallColor = !hasOnlineTelemetry
          ? '#64748B'
          : getContinuousMetricColorCss(layer, primaryValue);

        ctx.save();
        ctx.beginPath();
        pixelVertices.forEach((p, vIdx) => {
          if (vIdx === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        });
        ctx.closePath();

        if (isSelected || isZoomTarget) {
          ctx.lineWidth = 3.2 / Math.sqrt(zoomViewport.scale);
          ctx.strokeStyle = '#38BDF8';
        } else if (firingRoomSet.has(room.id)) {
          ctx.lineWidth = 3.0 / Math.sqrt(zoomViewport.scale);
          ctx.strokeStyle = '#EF4444';
        } else if (isZoneHighlighted) {
          ctx.lineWidth = 2.6 / Math.sqrt(zoomViewport.scale);
          ctx.strokeStyle = '#F59E0B';
        } else {
          ctx.lineWidth = 1.8 / Math.sqrt(zoomViewport.scale);
          ctx.strokeStyle = wallColor;
        }
        ctx.stroke();

        // Vòng nhấp nháy (pulse ring) cho phòng đang có cảnh báo FIRING (GĐ3.5)
        if (firingRoomSet.has(room.id)) {
          const centroid = computePolygonCentroid(polygon);
          const centerPx = normalizedToPixel(centroid, width, height);
          ctx.save();
          ctx.beginPath();
          ctx.arc(centerPx.x, centerPx.y, 18 / zoomViewport.scale, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(239, 68, 68, 0.85)';
          ctx.lineWidth = 2.2 / zoomViewport.scale;
          ctx.setLineDash([4, 3]);
          ctx.stroke();
          ctx.restore();
        }

        // Render Structural Columns (BTCT) & Door Opening (CUA) when zoomed in or for large halls
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

        // Level 2 Focus Details: Draw Reading Bay (Micro-zone) dashed boundaries inside the focused room
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

        ctx.restore();

        // Collect label metadata for screen-space decluttered pass (drawn AFTER CAD & zoom restore)
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
        const compactText = isSyntheticRoom
          ? `${shortCode} · ${metricLabel} (MP)`
          : `${shortCode} · ${metricLabel}`;

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
            ? `${metricLabel} · ${spreadText}`
            : metricLabel;

        // Determine effective room label style per LOD matrix
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
          areaM2 >= lodConfig.hideSmallRoomsUnderM2;

        const priority = isZoomTarget
          ? 1_000_000
          : isSelected
            ? 500_000
            : areaM2;

        preparedLabels.push({
          roomId: room.id,
          anchorScreen,
          screenPolygon,
          areaM2,
          isSelected,
          isZoomTarget,
          hasOnlineTelemetry,
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

      // 5. Overlay Authentic TQB Architectural CAD Underlay (TUONG, CUA, BTCT, THANG, NOITHAT)
      if (showCadUnderlay) {
        const svgPath = getFloorCadSvgPath(activeFloor);
        const cadImg = cadImagesRef.current.get(svgPath);
        if (cadImg) {
          ctx.save();
          ctx.globalAlpha = zoomViewport.isZoomed ? 0.62 : 0.42;
          ctx.drawImage(cadImg, 0, 0, width, height);
          ctx.restore();
        }
      }

      ctx.restore(); // End zoom camera transform (back to fixed screen-space coordinates)

      // 6. Screen-Space Decluttered Room Labels Pass (Always above CAD underlay, fixed font size)
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
            width: Math.ceil(ctx.measureText(item.shortCode).width + 8),
            height: 16,
          };
        }
        if (style === 'pill') {
          ctx.font = '700 10.5px JetBrains Mono, monospace';
          return {
            width: Math.max(
              54,
              Math.ceil(ctx.measureText(item.compactText).width + 14)
            ),
            height: 20,
          };
        }
        ctx.font = 'bold 12px Inter, system-ui, sans-serif';
        const titleW = ctx.measureText(item.titleLine).width;
        ctx.font = '600 10.5px JetBrains Mono, monospace';
        const subW = ctx.measureText(item.subLine).width;
        let warnW = 0;
        if (item.techWarningText) {
          ctx.font = 'bold 9.5px Inter, system-ui, sans-serif';
          warnW = ctx.measureText(item.techWarningText).width;
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
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        if (style === 'code') {
          ctx.font = '700 10.5px JetBrains Mono, monospace';
          ctx.strokeStyle = 'rgba(2, 6, 23, 0.92)';
          ctx.lineWidth = 3.2;
          ctx.lineJoin = 'round';
          ctx.strokeText(item.shortCode, cx, cy);
          ctx.fillStyle = item.isSelected ? '#38BDF8' : '#E2E8F0';
          ctx.fillText(item.shortCode, cx, cy);
          ctx.restore();
          return;
        }

        if (style === 'pill') {
          ctx.fillStyle = 'rgba(15, 23, 42, 0.90)';
          ctx.strokeStyle = item.isSelected
            ? '#38BDF8'
            : 'rgba(255, 255, 255, 0.28)';
          ctx.lineWidth = item.isSelected ? 1.5 : 1;
          ctx.beginPath();
          ctx.roundRect(cx - boxW / 2, cy - boxH / 2, boxW, boxH, 6);
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
          : 'rgba(15, 23, 42, 0.88)';
        ctx.strokeStyle =
          isHoverCard || item.isSelected || item.isZoomTarget
            ? '#38BDF8'
            : item.techWarningText
              ? '#F59E0B'
              : 'rgba(255, 255, 255, 0.28)';
        ctx.lineWidth =
          isHoverCard || item.isSelected || item.isZoomTarget ? 1.6 : 1.2;
        ctx.beginPath();
        ctx.roundRect(cx - boxW / 2, cy - boxH / 2, boxW, boxH, 6);
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

      for (let i = 0; i < activeCandidates.length; i++) {
        const item = activeCandidates[i];
        const placement = placements[i];
        const req = labelRequests[i];
        if (!placement || !placement.visible) continue;
        // Skip normal draw if this room is currently hovered and will get a rich hover card
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

      // Draw Hovered Room Rich Card when label was hidden or simplified ('code' / 'pill')
      if (hoveredRoomId && !hoveredDeviceId && !hoveredBayId) {
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
    showCadUnderlay,
    cadImageLoadedFloor,
    activeFloor,
    zoomViewport,
    highlightedZoneIds,
  ]);

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
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

    let foundRoomId: string | null = null;
    for (const { room, polygon } of enrichedRooms) {
      if (isPointInPolygon(normPt, polygon)) {
        foundRoomId = room.id;
        break;
      }
    }
    if (foundRoomId !== hoveredRoomId) {
      setHoveredRoomId(foundRoomId);
    }
  };

  const handleCanvasMouseLeave = () => {
    if (hoveredRoomId !== null) {
      setHoveredRoomId(null);
    }
  };

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
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
    activePointersRef.current.set(e.pointerId, {
      x: e.clientX,
      y: e.clientY,
    });
    if (activePointersRef.current.size === 2) {
      const pts = Array.from(activePointersRef.current.values());
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      pinchStartRef.current = { dist, scale: zoomViewport.scale };
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const prev = activePointersRef.current.get(e.pointerId);
    if (!prev) return;
    activePointersRef.current.set(e.pointerId, {
      x: e.clientX,
      y: e.clientY,
    });

    if (activePointersRef.current.size === 2 && pinchStartRef.current) {
      const pts = Array.from(activePointersRef.current.values());
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const nextScale = computePinchScale(
        pinchStartRef.current.scale,
        pinchStartRef.current.dist,
        dist
      );
      setGestureViewport(
        clampViewportTransform(
          nextScale,
          zoomViewport.tx,
          zoomViewport.ty,
          canvasSize.width,
          canvasSize.height
        )
      );
    } else if (
      activePointersRef.current.size === 1 &&
      zoomViewport.scale > 1.01
    ) {
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
        setGestureViewport(
          clampViewportTransform(
            zoomViewport.scale,
            zoomViewport.tx + dx,
            zoomViewport.ty + dy,
            canvasSize.width,
            canvasSize.height
          )
        );
      }
    }
  };

  const handlePointerUpOrCancel = (
    e: React.PointerEvent<HTMLCanvasElement>
  ) => {
    activePointersRef.current.delete(e.pointerId);
    if (activePointersRef.current.size < 2) {
      pinchStartRef.current = null;
    }
  };

  const handleCanvasDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
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

  return (
    <div
      ref={containerRef}
      className="relative w-full overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 shadow-inner"
    >
      {/* Top Floating Controls: CAD Layer Toggle, Display Density Segmented Control & 2-Level Zoom Controls */}
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
          Nền CAD
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
            onClick={() => setZoomedRoomId(null)}
            className="rounded-lg border border-amber-400/60 bg-slate-900/90 px-2.5 py-1 text-2xs font-semibold text-amber-300 shadow-sm backdrop-blur hover:bg-slate-800"
          >
            Thu nhỏ
          </button>
        ) : (
          selectedRoomObj && (
            <button
              type="button"
              onClick={() => setZoomedRoomId(selectedRoomObj.id)}
              className="rounded-lg border border-sky-400/60 bg-slate-900/90 px-2.5 py-1 text-2xs font-semibold text-sky-300 shadow-sm backdrop-blur hover:bg-slate-800"
            >
              Phóng to {selectedRoomObj.code}
            </button>
          )
        )}
      </div>

      {/* Compass & Scale Badge (Top Right) */}
      <div className="pointer-events-none absolute right-3 top-3 z-20 hidden items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-900/85 px-2.5 py-1 text-2xs font-mono text-slate-400 backdrop-blur sm:flex">
        <span className="font-semibold text-slate-200">BẮC</span>
        <span>·</span>
        <span>76×57m</span>
        {zoomViewport.isZoomed && (
          <>
            <span>·</span>
            <span className="text-sky-300">
              {zoomViewport.scale.toFixed(1)}x
            </span>
          </>
        )}
      </div>

      <canvas
        ref={canvasRef}
        onMouseMove={handleCanvasMouseMove}
        onMouseLeave={handleCanvasMouseLeave}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUpOrCancel}
        onPointerCancel={handlePointerUpOrCancel}
        onClick={handleCanvasClick}
        onDoubleClick={handleCanvasDoubleClick}
        className="block cursor-pointer touch-none select-none"
        aria-label="Bản đồ không gian mặt bằng và Heatmap 2D Thư viện Tạ Quang Bửu"
      />

      {/* Layer 2A: Architectural Landmarks (Stairs, Elevators, WC, Entrance) */}
      <div className="pointer-events-none absolute inset-0">
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
              <div className="flex items-center justify-center rounded border border-slate-700/80 bg-slate-900/85 px-1.5 py-0.5 font-mono text-[10px] font-medium text-slate-400 shadow-xs backdrop-blur">
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

      {/* Layer 2B: Anonymous Reading Bay Micro-zones for USER / VIEWER (FE-VIZ-09 hardware-safe!) */}
      <div className="pointer-events-none absolute inset-0">
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

      {/* Layer 2C: Interactive Hardware Device Pins Overlay (Only when devices are provided for authorized roles) */}
      <div className="pointer-events-none absolute inset-0">
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
          const activeVal = displayValues[device.id] ?? rawMetricVal;
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
                      ? '-inset-3.5 animate-ping bg-rose-500 opacity-80'
                      : isAlertingDevice
                        ? '-inset-2.5 animate-ping bg-rose-500 opacity-65'
                        : '-inset-2 animate-ping opacity-60'
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
                          transition:
                            'background-color 0.4s ease-out, box-shadow 0.4s ease-out',
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
                          transition:
                            'background-color 0.4s ease-out, box-shadow 0.4s ease-out',
                        }
                      : undefined
                  }
                />
              )}

              {(showBadge && activeVal !== null) || isFocusedDevice ? (
                <div
                  className="pointer-events-none mt-1 -translate-x-0 rounded border px-1.5 py-0.5 text-center font-mono text-2xs font-bold shadow-md"
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
                    transition: 'border-color 0.4s ease-out',
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
    </div>
  );
}
