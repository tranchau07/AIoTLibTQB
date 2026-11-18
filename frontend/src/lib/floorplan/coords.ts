import { ZOOM_CONFIG } from '@/config/floorplan-hmi.config';
import type { Point2D } from '@/types/api';

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
    Number.isFinite(paddingRatio) && paddingRatio >= 1 ? paddingRatio : 1.35;
  const spanX = Math.max(0.01, (maxX - minX) * safePadding);
  const spanY = Math.max(0.01, (maxY - minY) * safePadding);
  const rawScale = 1 / Math.max(spanX, spanY);
  const safeMax =
    Number.isFinite(maxScale) && maxScale >= ZOOM_CONFIG.minScale
      ? maxScale
      : ZOOM_CONFIG.maxScale;
  const targetScale = Number(
    Math.max(ZOOM_CONFIG.minScale, Math.min(safeMax, rawScale)).toFixed(3)
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

