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
 * Clamp pan translation (tx, ty) for a given zoom scale [1.0, 3.0] so the floorplan stays in bounds.
 */
export function clampViewportTransform(
  scale: number,
  tx: number,
  ty: number,
  canvasWidth: number,
  canvasHeight: number
): ViewportTransform {
  const safeScale = Math.max(1, Math.min(3, scale));
  if (safeScale <= 1.001) {
    return { scale: 1, tx: 0, ty: 0 };
  }
  const minTx = canvasWidth * (1 - safeScale);
  const minTy = canvasHeight * (1 - safeScale);
  return {
    scale: Number(safeScale.toFixed(3)),
    tx: Math.max(minTx, Math.min(0, tx)),
    ty: Math.max(minTy, Math.min(0, ty)),
  };
}

/**
 * Compute new pinch-zoom scale from initial distance and current distance between two pointers.
 */
export function computePinchScale(
  initialScale: number,
  initialDistancePx: number,
  currentDistancePx: number
): number {
  if (initialDistancePx <= 1) return Math.max(1, Math.min(3, initialScale));
  const ratio = currentDistancePx / initialDistancePx;
  return Number(Math.max(1, Math.min(3, initialScale * ratio)).toFixed(3));
}

