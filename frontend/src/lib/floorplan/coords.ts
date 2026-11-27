import { ZOOM_CONFIG } from '@/config/floorplan-hmi.config';
import {
  TQB_BUILDING_DEPTH_M,
  TQB_BUILDING_WIDTH_M,
  resolveRoomPolygon,
} from '@/config/tqb-floorplan-presets';
import { computeVisualPolygonCenter } from '@/lib/floorplan/polygon';
import type { Point2D, RoomResponse } from '@/types/api';

/**
 * Coordinate conversion between normalized [0.0, 1.0] space and Canvas pixels (FE-VIZ-02, FE-VIZ-06).
 */
export function normalizedToPixel(
  point: Point2D,
  canvasWidth: number,
  canvasHeight: number
): Point2D {
  return {
    x: Math.max(0, Math.min(1, point.x)) * canvasWidth,
    y: Math.max(0, Math.min(1, point.y)) * canvasHeight,
  };
}

export function pixelToNormalized(
  pixel: Point2D,
  canvasWidth: number,
  canvasHeight: number
): Point2D {
  if (canvasWidth <= 0 || canvasHeight <= 0) {
    return { x: 0, y: 0 };
  }
  return {
    x: Number(Math.max(0, Math.min(1, pixel.x / canvasWidth)).toFixed(4)),
    y: Number(Math.max(0, Math.min(1, pixel.y / canvasHeight)).toFixed(4)),
  };
}

export interface ViewportTransform {
  scale: number;
  tx: number;
  ty: number;
}

/**
 * Clamp pan translation (tx, ty) for a given zoom scale [1.0, maxScale] so the floorplan stays in bounds.
 * Defaults to maxScale = 3 to keep existing core-standard viewport assertions intact.
 */
export function clampViewportTransform(
  scale: number,
  tx: number,
  ty: number,
  canvasWidth: number,
  canvasHeight: number,
  maxScale = 3
): ViewportTransform {
  if (
    !Number.isFinite(scale) ||
    !Number.isFinite(canvasWidth) ||
    !Number.isFinite(canvasHeight) ||
    canvasWidth <= 0 ||
    canvasHeight <= 0
  ) {
    return { scale: 1, tx: 0, ty: 0 };
  }
  const safeMax = Number.isFinite(maxScale) && maxScale >= 1 ? maxScale : 3;
  const safeScale = Math.max(1, Math.min(safeMax, scale));
  if (safeScale <= 1.001) {
    return { scale: 1, tx: 0, ty: 0 };
  }
  const roundedScale = Number(safeScale.toFixed(3));
  const safeTx = Number.isFinite(tx) ? tx : 0;
  const safeTy = Number.isFinite(ty) ? ty : 0;
  const minTx = canvasWidth * (1 - roundedScale);
  const minTy = canvasHeight * (1 - roundedScale);
  return {
    scale: roundedScale,
    tx: Math.max(minTx, Math.min(0, safeTx)),
    ty: Math.max(minTy, Math.min(0, safeTy)),
  };
}

/**
 * Compute new pinch-zoom scale from initial distance and current distance between two pointers.
 */
export function computePinchScale(
  initialScale: number,
  initialDistancePx: number,
  currentDistancePx: number,
  maxScale = 3
): number {
  const safeMax = Number.isFinite(maxScale) && maxScale >= 1 ? maxScale : 3;
  if (
    !Number.isFinite(initialDistancePx) ||
    !Number.isFinite(currentDistancePx) ||
    initialDistancePx <= 1
  ) {
    return Math.max(1, Math.min(safeMax, initialScale));
  }
  const ratio = currentDistancePx / initialDistancePx;
  return Number(Math.max(1, Math.min(safeMax, initialScale * ratio)).toFixed(3));
}

export function fitFloorToViewport(): ViewportTransform {
  return { scale: 1, tx: 0, ty: 0 };
}

/**
 * Fit a normalized [0, 1] polygon cleanly into the viewport with balanced padding,
 * keeping its centroid anchored at the viewport center (subject to boundary clamping).
 */
export function fitPolygonToViewport(
  polygon: readonly Point2D[] | undefined | null,
  canvasWidth: number,
  canvasHeight: number,
  paddingRatio: number = ZOOM_CONFIG.roomFitPaddingRatio,
  maxScale: number = ZOOM_CONFIG.maxScale
): ViewportTransform {
  if (
    !polygon ||
    polygon.length < 3 ||
    !Number.isFinite(canvasWidth) ||
    !Number.isFinite(canvasHeight) ||
    canvasWidth <= 0 ||
    canvasHeight <= 0
  ) {
    return { scale: 1, tx: 0, ty: 0 };
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const pt of polygon) {
    if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) continue;
    const clampedX = Math.max(0, Math.min(1, pt.x));
    const clampedY = Math.max(0, Math.min(1, pt.y));
    if (clampedX < minX) minX = clampedX;
    if (clampedX > maxX) maxX = clampedX;
    if (clampedY < minY) minY = clampedY;
    if (clampedY > maxY) maxY = clampedY;
  }

  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(maxX) ||
    maxX - minX <= 1e-6 ||
    maxY - minY <= 1e-6
  ) {
    return { scale: 1, tx: 0, ty: 0 };
  }

  const safePadding =
    Number.isFinite(paddingRatio) && paddingRatio >= 1
      ? paddingRatio
      : ZOOM_CONFIG.roomFitPaddingRatio;
  const spanX = Math.max(0.01, (maxX - minX) * safePadding);
  const spanY = Math.max(0.01, (maxY - minY) * safePadding);
  const rawScale = 1 / Math.max(spanX, spanY);
  const safeMax =
    Number.isFinite(maxScale) && maxScale >= ZOOM_CONFIG.minScale
      ? maxScale
      : ZOOM_CONFIG.maxScale;
  const basePxPerMeter = canvasWidth / TQB_BUILDING_WIDTH_M;
  const densityCapScale =
    basePxPerMeter > 0
      ? Math.max(
          ZOOM_CONFIG.intermediateMaxScale,
          ZOOM_CONFIG.maxAutoFitPxPerMeter / basePxPerMeter
        )
      : safeMax;
  const effectiveAutoMax = Math.min(safeMax, densityCapScale);
  const targetScale = Number(
    Math.max(
      ZOOM_CONFIG.minScale,
      Math.min(effectiveAutoMax, rawScale)
    ).toFixed(3)
  );

  if (targetScale <= 1.001) {
    return { scale: 1, tx: 0, ty: 0 };
  }

  const centerX = ((minX + maxX) * 0.5) * canvasWidth;
  const centerY = ((minY + maxY) * 0.5) * canvasHeight;
  const rawTx = canvasWidth * 0.5 - centerX * targetScale;
  const rawTy = canvasHeight * 0.5 - centerY * targetScale;

  return clampViewportTransform(
    targetScale,
    rawTx,
    rawTy,
    canvasWidth,
    canvasHeight,
    safeMax
  );
}

/**
 * Zoom smoothly around a fixed screen-space focal point (wheel cursor or gesture midpoint).
 */
export function zoomViewportAtPoint(
  current: ViewportTransform,
  nextScale: number,
  focalPx: Point2D,
  canvasWidth: number,
  canvasHeight: number,
  maxScale: number = ZOOM_CONFIG.maxScale
): ViewportTransform {
  if (
    !Number.isFinite(canvasWidth) ||
    !Number.isFinite(canvasHeight) ||
    canvasWidth <= 0 ||
    canvasHeight <= 0
  ) {
    return { scale: 1, tx: 0, ty: 0 };
  }

  const safeMax =
    Number.isFinite(maxScale) && maxScale >= ZOOM_CONFIG.minScale
      ? maxScale
      : ZOOM_CONFIG.maxScale;
  const rawNext = Number.isFinite(nextScale) ? nextScale : current.scale;
  const targetScale = Number(
    Math.max(ZOOM_CONFIG.minScale, Math.min(safeMax, rawNext)).toFixed(3)
  );

  if (targetScale <= 1.001) {
    return { scale: 1, tx: 0, ty: 0 };
  }

  const oldScale =
    Number.isFinite(current.scale) && current.scale > 0 ? current.scale : 1;
  const oldTx = Number.isFinite(current.tx) ? current.tx : 0;
  const oldTy = Number.isFinite(current.ty) ? current.ty : 0;
  const fx = Number.isFinite(focalPx.x) ? focalPx.x : canvasWidth * 0.5;
  const fy = Number.isFinite(focalPx.y) ? focalPx.y : canvasHeight * 0.5;

  const ratio = targetScale / oldScale;
  const rawTx = fx - (fx - oldTx) * ratio;
  const rawTy = fy - (fy - oldTy) * ratio;

  return clampViewportTransform(
    targetScale,
    rawTx,
    rawTy,
    canvasWidth,
    canvasHeight,
    safeMax
  );
}

/**
 * Navigate the zoomed viewport so a normalized [0, 1] minimap click is centered cleanly.
 */
export function minimapClickToViewport(
  clickNorm: Point2D,
  currentScale: number,
  canvasWidth: number,
  canvasHeight: number,
  maxScale: number = ZOOM_CONFIG.maxScale
): ViewportTransform {
  if (
    !Number.isFinite(canvasWidth) ||
    !Number.isFinite(canvasHeight) ||
    canvasWidth <= 0 ||
    canvasHeight <= 0
  ) {
    return { scale: 1, tx: 0, ty: 0 };
  }
  const safeMax =
    Number.isFinite(maxScale) && maxScale >= ZOOM_CONFIG.minScale
      ? maxScale
      : ZOOM_CONFIG.maxScale;
  const roundedScale = Number(
    Math.max(
      ZOOM_CONFIG.minScale,
      Math.min(safeMax, Number.isFinite(currentScale) ? currentScale : 1)
    ).toFixed(3)
  );
  if (roundedScale <= 1.001) {
    return { scale: 1, tx: 0, ty: 0 };
  }

  const nx = Math.max(0, Math.min(1, Number.isFinite(clickNorm.x) ? clickNorm.x : 0.5));
  const ny = Math.max(0, Math.min(1, Number.isFinite(clickNorm.y) ? clickNorm.y : 0.5));
  const targetPxX = nx * canvasWidth;
  const targetPxY = ny * canvasHeight;
  const rawTx = canvasWidth * 0.5 - targetPxX * roundedScale;
  const rawTy = canvasHeight * 0.5 - targetPxY * roundedScale;

  return clampViewportTransform(
    roundedScale,
    rawTx,
    rawTy,
    canvasWidth,
    canvasHeight,
    safeMax
  );
}

/**
 * Real-world bounding box of a room polygon in meters (based on 76.0m × 57.2m TQB CAD scale).
 */
export interface RoomBoundsMeters {
  minXM: number;
  minYM: number;
  maxXM: number;
  maxYM: number;
  widthM: number;
  depthM: number;
}

function clampUnit(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

/**
 * Convert a normalized [0.0, 1.0] floor coordinate into real-world building floor meters
 * (origin 0,0 at North-West corner of the 76.0m × 57.2m floorplate).
 */
export function normalizedToFloorMeters(point: Point2D): Point2D {
  return {
    x: Number((clampUnit(point.x) * TQB_BUILDING_WIDTH_M).toFixed(2)),
    y: Number((clampUnit(point.y) * TQB_BUILDING_DEPTH_M).toFixed(2)),
  };
}

/**
 * Convert real-world building floor meters back into normalized [0.0, 1.0] coordinates for API/DB storage.
 */
export function floorMetersToNormalized(pointM: Point2D): Point2D {
  const safeX = Number.isFinite(pointM.x) ? pointM.x : TQB_BUILDING_WIDTH_M * 0.5;
  const safeY = Number.isFinite(pointM.y) ? pointM.y : TQB_BUILDING_DEPTH_M * 0.5;
  return {
    x: Number(clampUnit(safeX / TQB_BUILDING_WIDTH_M).toFixed(4)),
    y: Number(clampUnit(safeY / TQB_BUILDING_DEPTH_M).toFixed(4)),
  };
}

/**
 * Compute real-world bounding box in meters for a room polygon (returns null if < 3 vertices).
 */
export function getRoomBoundsMeters(
  polygon: readonly Point2D[] | undefined | null
): RoomBoundsMeters | null {
  if (!polygon || polygon.length < 3) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const pt of polygon) {
    if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) continue;
    const xM = clampUnit(pt.x) * TQB_BUILDING_WIDTH_M;
    const yM = clampUnit(pt.y) * TQB_BUILDING_DEPTH_M;
    if (xM < minX) minX = xM;
    if (xM > maxX) maxX = xM;
    if (yM < minY) minY = yM;
    if (yM > maxY) maxY = yM;
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  const widthM = maxX - minX;
  const depthM = maxY - minY;
  if (widthM <= 0.05 || depthM <= 0.05) return null;

  return {
    minXM: Number(minX.toFixed(2)),
    minYM: Number(minY.toFixed(2)),
    maxXM: Number(maxX.toFixed(2)),
    maxYM: Number(maxY.toFixed(2)),
    widthM: Number(widthM.toFixed(2)),
    depthM: Number(depthM.toFixed(2)),
  };
}

/**
 * Convert a normalized [0.0, 1.0] sensor coordinate into room-local meters measured from
 * the North-West corner of the room's bounding box.
 */
export function normalizedToRoomLocalMeters(
  point: Point2D,
  polygon: readonly Point2D[] | undefined | null
): { localXM: number; localYM: number; bounds: RoomBoundsMeters } | null {
  const bounds = getRoomBoundsMeters(polygon);
  if (!bounds) return null;
  const floorM = normalizedToFloorMeters(point);
  return {
    localXM: Number((floorM.x - bounds.minXM).toFixed(2)),
    localYM: Number((floorM.y - bounds.minYM).toFixed(2)),
    bounds,
  };
}

/**
 * Convert room-local meters (distance from room's West & North edges) back into normalized [0.0, 1.0].
 */
export function roomLocalMetersToNormalized(
  localXM: number,
  localYM: number,
  polygon: readonly Point2D[] | undefined | null
): Point2D {
  const bounds = getRoomBoundsMeters(polygon);
  if (!bounds) {
    return floorMetersToNormalized({ x: localXM, y: localYM });
  }
  const safeLocalX = Number.isFinite(localXM) ? localXM : bounds.widthM * 0.5;
  const safeLocalY = Number.isFinite(localYM) ? localYM : bounds.depthM * 0.5;
  return floorMetersToNormalized({
    x: bounds.minXM + safeLocalX,
    y: bounds.minYM + safeLocalY,
  });
}

/**
 * Resolve a sensible default normalized sensor coordinate for a room:
 * visual polygon interior center when available, falling back to floor center (0.5, 0.5).
 */
export function getDefaultDevicePositionForRoom(
  room: RoomResponse | null | undefined
): Point2D {
  if (!room) return { x: 0.5, y: 0.5 };
  const poly = resolveRoomPolygon(room, 0);
  if (Array.isArray(poly) && poly.length >= 3) {
    const center = computeVisualPolygonCenter(poly);
    return {
      x: Number(clampUnit(center.x).toFixed(4)),
      y: Number(clampUnit(center.y).toFixed(4)),
    };
  }
  return { x: 0.5, y: 0.5 };
}

export interface FormattedDevicePositionVi {
  primary: string;
  secondary: string | null;
  isRoomLocal: boolean;
}

/**
 * Format a normalized sensor coordinate into human-readable Vietnamese real-world meters.
 */
export function formatDevicePositionMetersVi(
  point: Point2D | null | undefined,
  polygon?: readonly Point2D[] | null
): FormattedDevicePositionVi {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return {
      primary: 'Chưa chấm tọa độ',
      secondary: null,
      isRoomLocal: false,
    };
  }

  const floorM = normalizedToFloorMeters(point);
  const floorLabel = `Sàn: ${floorM.x.toFixed(1)} m × ${floorM.y.toFixed(1)} m`;
  const roomLocal = normalizedToRoomLocalMeters(point, polygon);

  if (roomLocal) {
    return {
      primary: `Tây ${roomLocal.localXM.toFixed(1)} m · Bắc ${roomLocal.localYM.toFixed(1)} m`,
      secondary: floorLabel,
      isRoomLocal: true,
    };
  }

  return {
    primary: `X: ${floorM.x.toFixed(1)} m · Y: ${floorM.y.toFixed(1)} m`,
    secondary: `Toàn sàn ${TQB_BUILDING_WIDTH_M.toFixed(0)} × ${TQB_BUILDING_DEPTH_M.toFixed(1)} m`,
    isRoomLocal: false,
  };
}


