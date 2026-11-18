import {
  FURNITURE_CATALOG,
  resolveFurnitureCatalogEntry,
  type FurnitureCatalogEntry,
} from '@/config/furniture-catalog';
import {
  TQB_BUILDING_DEPTH_M,
  TQB_BUILDING_WIDTH_M,
} from '@/config/tqb-floorplan-presets';
import { FLOORPLAN_I18N_VI } from '@/messages/vi';
import type { FurnitureItem, Point2D } from '@/types/api';

const GEOMETRY_EPS = 1e-4;

export interface FurnitureNormalizedSize {
  readonly widthNorm: number;
  readonly depthNorm: number;
  readonly halfWidthNorm: number;
  readonly halfDepthNorm: number;
}

export interface FurniturePixelSize {
  readonly widthPx: number;
  readonly heightPx: number;
}

export type FurnitureAlignMode =
  | 'left'
  | 'centerX'
  | 'right'
  | 'top'
  | 'middleY'
  | 'bottom'
  | 'distributeX'
  | 'distributeY';

export interface FurnitureValidationResult {
  readonly valid: boolean;
  readonly outOfBoundsIds: Set<string>;
  readonly overlappingPairs: Array<[string, string]>;
  readonly invalidIds: Set<string>;
  readonly errorsByItemId: Record<string, string[]>;
}

export interface FurnitureHistoryState<T = FurnitureItem[]> {
  readonly past: readonly T[];
  readonly present: T;
  readonly future: readonly T[];
}

export function normalizedToMetersPoint(pt: Point2D): Point2D {
  return {
    x: pt.x * TQB_BUILDING_WIDTH_M,
    y: pt.y * TQB_BUILDING_DEPTH_M,
  };
}

export function metersToNormalizedPoint(ptM: Point2D): Point2D {
  return {
    x: ptM.x / TQB_BUILDING_WIDTH_M,
    y: ptM.y / TQB_BUILDING_DEPTH_M,
  };
}

export function furnitureMetersToNormalizedSize(
  widthM: number,
  depthM: number
): FurnitureNormalizedSize {
  const widthNorm = widthM / TQB_BUILDING_WIDTH_M;
  const depthNorm = depthM / TQB_BUILDING_DEPTH_M;
  return {
    widthNorm,
    depthNorm,
    halfWidthNorm: widthNorm * 0.5,
    halfDepthNorm: depthNorm * 0.5,
  };
}

export function furnitureMetersToPixelSize(
  widthM: number,
  depthM: number,
  canvasWidthPx: number,
  canvasHeightPx: number,
  scale = 1.0
): FurniturePixelSize {
  return {
    widthPx: (widthM / TQB_BUILDING_WIDTH_M) * canvasWidthPx * scale,
    heightPx: (depthM / TQB_BUILDING_DEPTH_M) * canvasHeightPx * scale,
  };
}

export function snapToGridMeters(valM: number, stepM = 0.25): number {
  if (!Number.isFinite(valM) || stepM <= 0) return valM;
  return Number((Math.round(valM / stepM) * stepM).toFixed(4));
}

export function snapNormalizedPointToGrid(
  ptNorm: Point2D,
  stepM = 0.25
): Point2D {
  const ptM = normalizedToMetersPoint(ptNorm);
  const snappedM = {
    x: Math.max(0, Math.min(TQB_BUILDING_WIDTH_M, snapToGridMeters(ptM.x, stepM))),
    y: Math.max(0, Math.min(TQB_BUILDING_DEPTH_M, snapToGridMeters(ptM.y, stepM))),
  };
  return metersToNormalizedPoint(snappedM);
}

export function clampFurnitureDimensions(
  widthM: number,
  depthM: number,
  typeId: string,
  catalog: readonly FurnitureCatalogEntry[] = FURNITURE_CATALOG
): { widthM: number; depthM: number } {
  const entry = resolveFurnitureCatalogEntry(typeId, catalog);
  const safeW = Number.isFinite(widthM) ? widthM : entry.defaultWidthM;
  const safeD = Number.isFinite(depthM) ? depthM : entry.defaultDepthM;
  return {
    widthM: Number(
      Math.max(entry.minWidthM, Math.min(entry.maxWidthM, safeW)).toFixed(3)
    ),
    depthM: Number(
      Math.max(entry.minDepthM, Math.min(entry.maxDepthM, safeD)).toFixed(3)
    ),
  };
}

export function getFurnitureObbCornersMeters(
  item: Pick<FurnitureItem, 'x' | 'y' | 'widthM' | 'depthM' | 'rotationDeg'>
): [Point2D, Point2D, Point2D, Point2D] {
  const cx = item.x * TQB_BUILDING_WIDTH_M;
  const cy = item.y * TQB_BUILDING_DEPTH_M;
  const hw = item.widthM * 0.5;
  const hd = item.depthM * 0.5;
  const rad = ((item.rotationDeg ?? 0) * Math.PI) / 180;

  const ux = Math.cos(rad);
  const uy = Math.sin(rad);
  const vx = -Math.sin(rad);
  const vy = Math.cos(rad);

  return [
    { x: cx - hw * ux - hd * vx, y: cy - hw * uy - hd * vy },
    { x: cx + hw * ux - hd * vx, y: cy + hw * uy - hd * vy },
    { x: cx + hw * ux + hd * vx, y: cy + hw * uy + hd * vy },
    { x: cx - hw * ux + hd * vx, y: cy - hw * uy + hd * vy },
  ];
}

export function getFurnitureObbCornersNorm(
  item: Pick<FurnitureItem, 'x' | 'y' | 'widthM' | 'depthM' | 'rotationDeg'>
): [Point2D, Point2D, Point2D, Point2D] {
  const cornersM = getFurnitureObbCornersMeters(item);
  return [
    metersToNormalizedPoint(cornersM[0]),
    metersToNormalizedPoint(cornersM[1]),
    metersToNormalizedPoint(cornersM[2]),
    metersToNormalizedPoint(cornersM[3]),
  ];
}

function pointOnSegmentMeters(p: Point2D, a: Point2D, b: Point2D): boolean {
  const cross = Math.abs((p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x));
  if (cross > 1e-3) return false;
  const dot = (p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y);
  if (dot < -1e-6) return false;
  const sqLen = (b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y);
  return dot <= sqLen + 1e-6;
}

function isPointInOrOnPolygonMeters(
  pt: Point2D,
  poly: readonly Point2D[]
): boolean {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = poly[j];
    const b = poly[i];
    if (pointOnSegmentMeters(pt, a, b)) return true;
    const intersect =
      (b.y > pt.y) !== (a.y > pt.y) &&
      pt.x < ((a.x - b.x) * (pt.y - b.y)) / (a.y - b.y + 1e-12) + b.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

function cross2d(a: Point2D, b: Point2D, c: Point2D): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function segmentsStrictlyIntersectMeters(
  p1: Point2D,
  p2: Point2D,
  q1: Point2D,
  q2: Point2D
): boolean {
  const d1 = cross2d(q1, q2, p1);
  const d2 = cross2d(q1, q2, p2);
  const d3 = cross2d(p1, p2, q1);
  const d4 = cross2d(p1, p2, q2);
  return (
    ((d1 > GEOMETRY_EPS && d2 < -GEOMETRY_EPS) ||
      (d1 < -GEOMETRY_EPS && d2 > GEOMETRY_EPS)) &&
    ((d3 > GEOMETRY_EPS && d4 < -GEOMETRY_EPS) ||
      (d3 < -GEOMETRY_EPS && d4 > GEOMETRY_EPS))
  );
}

export function isFurnitureInsideRoom(
  item: Pick<FurnitureItem, 'x' | 'y' | 'widthM' | 'depthM' | 'rotationDeg'>,
  polygonNorm?: readonly Point2D[] | null
): boolean {
  if (
    !item ||
    !Number.isFinite(item.x) ||
    !Number.isFinite(item.y) ||
    !Number.isFinite(item.widthM) ||
    !Number.isFinite(item.depthM)
  ) {
    return false;
  }

  const cornersM = getFurnitureObbCornersMeters(item);
  for (const c of cornersM) {
    if (
      c.x < -GEOMETRY_EPS ||
      c.x > TQB_BUILDING_WIDTH_M + GEOMETRY_EPS ||
      c.y < -GEOMETRY_EPS ||
      c.y > TQB_BUILDING_DEPTH_M + GEOMETRY_EPS
    ) {
      return false;
    }
  }

  if (!polygonNorm || polygonNorm.length < 3) {
    return item.x >= 0 && item.x <= 1 && item.y >= 0 && item.y <= 1;
  }

  const polyM = polygonNorm.map(normalizedToMetersPoint);
  const centerM = normalizedToMetersPoint({ x: item.x, y: item.y });
  if (!isPointInOrOnPolygonMeters(centerM, polyM)) {
    return false;
  }

  for (let i = 0; i < 4; i++) {
    const c = cornersM[i];
    if (!isPointInOrOnPolygonMeters(c, polyM)) {
      return false;
    }
    const next = cornersM[(i + 1) % 4];
    const mid = { x: (c.x + next.x) * 0.5, y: (c.y + next.y) * 0.5 };
    if (!isPointInOrOnPolygonMeters(mid, polyM)) {
      return false;
    }
  }

  for (let i = 0; i < 4; i++) {
    const a1 = cornersM[i];
    const a2 = cornersM[(i + 1) % 4];
    for (let j = 0; j < polyM.length; j++) {
      const b1 = polyM[j];
      const b2 = polyM[(j + 1) % polyM.length];
      if (segmentsStrictlyIntersectMeters(a1, a2, b1, b2)) {
        return false;
      }
    }
  }

  return true;
}

function edgeNormal(p1: Point2D, p2: Point2D): Point2D {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return { x: 1, y: 0 };
  return { x: -dy / len, y: dx / len };
}

function projectPolygonOnAxis(
  pts: readonly Point2D[],
  axis: Point2D
): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const p of pts) {
    const proj = p.x * axis.x + p.y * axis.y;
    if (proj < min) min = proj;
    if (proj > max) max = proj;
  }
  return { min, max };
}

/**
 * Kiểm tra va chạm / chồng lấn giữa 2 hộp xoay OBB theo hệ mét thực bằng Định lý trục tách (SAT).
 */
export function doFurnitureItemsOverlap(
  a: Pick<FurnitureItem, 'typeId' | 'x' | 'y' | 'widthM' | 'depthM' | 'rotationDeg'>,
  b: Pick<FurnitureItem, 'typeId' | 'x' | 'y' | 'widthM' | 'depthM' | 'rotationDeg'>,
  catalog: readonly FurnitureCatalogEntry[] = FURNITURE_CATALOG
): boolean {
  const entryA = resolveFurnitureCatalogEntry(a.typeId, catalog);
  const entryB = resolveFurnitureCatalogEntry(b.typeId, catalog);
  if (!entryA.blocksWalkway || !entryB.blocksWalkway) {
    return false;
  }

  const cornersA = getFurnitureObbCornersMeters(a);
  const cornersB = getFurnitureObbCornersMeters(b);

  const axes: Point2D[] = [
    edgeNormal(cornersA[0], cornersA[1]),
    edgeNormal(cornersA[1], cornersA[2]),
    edgeNormal(cornersB[0], cornersB[1]),
    edgeNormal(cornersB[1], cornersB[2]),
  ];

  for (const axis of axes) {
    const projA = projectPolygonOnAxis(cornersA, axis);
    const projB = projectPolygonOnAxis(cornersB, axis);
    if (
      projA.max <= projB.min + GEOMETRY_EPS ||
      projB.max <= projA.min + GEOMETRY_EPS
    ) {
      return false;
    }
  }
  return true;
}

export function validateFurnitureLayout(
  items: readonly FurnitureItem[],
  polygonNorm?: readonly Point2D[] | null,
  catalog: readonly FurnitureCatalogEntry[] = FURNITURE_CATALOG
): FurnitureValidationResult {
  const outOfBoundsIds = new Set<string>();
  const overlappingPairs: Array<[string, string]> = [];
  const invalidIds = new Set<string>();
  const errorsByItemId: Record<string, string[]> = {};

  const pushErr = (id: string, msg: string) => {
    if (!errorsByItemId[id]) errorsByItemId[id] = [];
    if (!errorsByItemId[id].includes(msg)) {
      errorsByItemId[id].push(msg);
    }
  };

  for (const item of items) {
    if (!isFurnitureInsideRoom(item, polygonNorm)) {
      outOfBoundsIds.add(item.id);
      invalidIds.add(item.id);
      pushErr(item.id, FLOORPLAN_I18N_VI.furniture.outOfBoundsError);
    }
  }

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (doFurnitureItemsOverlap(items[i], items[j], catalog)) {
        overlappingPairs.push([items[i].id, items[j].id]);
        invalidIds.add(items[i].id);
        invalidIds.add(items[j].id);
        pushErr(items[i].id, FLOORPLAN_I18N_VI.furniture.overlapError);
        pushErr(items[j].id, FLOORPLAN_I18N_VI.furniture.overlapError);
      }
    }
  }

  return {
    valid: invalidIds.size === 0,
    outOfBoundsIds,
    overlappingPairs,
    invalidIds,
    errorsByItemId,
  };
}

/**
 * Căn hàng / Dàn đều nhiều đối tượng nội thất đang chọn (bỏ qua vật thể đang locked).
 * Giữ nguyên ranh giới phòng nếu polygonNorm được cung cấp.
 */
export function alignFurnitureItems(
  items: readonly FurnitureItem[],
  selectedIds: readonly string[],
  mode: FurnitureAlignMode,
  polygonNorm?: readonly Point2D[] | null
): FurnitureItem[] {
  const selectedSet = new Set(selectedIds);
  const targets = items.filter((item) => selectedSet.has(item.id) && !item.locked);
  if (targets.length < 2) {
    return [...items];
  }

  const nextPosById = new Map<string, { x: number; y: number }>();

  const bboxForItem = (it: FurnitureItem) => {
    const corners = getFurnitureObbCornersNorm(it);
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    return {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
    };
  };

  if (mode === 'left') {
    const minLeft = Math.min(...targets.map((t) => bboxForItem(t).minX));
    for (const t of targets) {
      const box = bboxForItem(t);
      const halfW = (box.maxX - box.minX) * 0.5;
      nextPosById.set(t.id, { x: Number((minLeft + halfW).toFixed(4)), y: t.y });
    }
  } else if (mode === 'right') {
    const maxRight = Math.max(...targets.map((t) => bboxForItem(t).maxX));
    for (const t of targets) {
      const box = bboxForItem(t);
      const halfW = (box.maxX - box.minX) * 0.5;
      nextPosById.set(t.id, { x: Number((maxRight - halfW).toFixed(4)), y: t.y });
    }
  } else if (mode === 'centerX') {
    const avgX = targets.reduce((sum, t) => sum + t.x, 0) / targets.length;
    for (const t of targets) {
      nextPosById.set(t.id, { x: Number(avgX.toFixed(4)), y: t.y });
    }
  } else if (mode === 'top') {
    const minTop = Math.min(...targets.map((t) => bboxForItem(t).minY));
    for (const t of targets) {
      const box = bboxForItem(t);
      const halfH = (box.maxY - box.minY) * 0.5;
      nextPosById.set(t.id, { x: t.x, y: Number((minTop + halfH).toFixed(4)) });
    }
  } else if (mode === 'bottom') {
    const maxBottom = Math.max(...targets.map((t) => bboxForItem(t).maxY));
    for (const t of targets) {
      const box = bboxForItem(t);
      const halfH = (box.maxY - box.minY) * 0.5;
      nextPosById.set(t.id, { x: t.x, y: Number((maxBottom - halfH).toFixed(4)) });
    }
  } else if (mode === 'middleY') {
    const avgY = targets.reduce((sum, t) => sum + t.y, 0) / targets.length;
    for (const t of targets) {
      nextPosById.set(t.id, { x: t.x, y: Number(avgY.toFixed(4)) });
    }
  } else if (mode === 'distributeX' && targets.length >= 3) {
    const sorted = [...targets].sort((a, b) => a.x - b.x);
    const minX = sorted[0].x;
    const maxX = sorted[sorted.length - 1].x;
    const step = (maxX - minX) / (sorted.length - 1);
    sorted.forEach((t, idx) => {
      nextPosById.set(t.id, { x: Number((minX + idx * step).toFixed(4)), y: t.y });
    });
  } else if (mode === 'distributeY' && targets.length >= 3) {
    const sorted = [...targets].sort((a, b) => a.y - b.y);
    const minY = sorted[0].y;
    const maxY = sorted[sorted.length - 1].y;
    const step = (maxY - minY) / (sorted.length - 1);
    sorted.forEach((t, idx) => {
      nextPosById.set(t.id, { x: t.x, y: Number((minY + idx * step).toFixed(4)) });
    });
  }

  return items.map((item) => {
    const nextPos = nextPosById.get(item.id);
    if (!nextPos) return item;
    const candidate: FurnitureItem = { ...item, ...nextPos };
    if (polygonNorm && polygonNorm.length >= 3 && !isFurnitureInsideRoom(candidate, polygonNorm)) {
      return item;
    }
    return candidate;
  });
}

export function createFurnitureHistory<T>(
  initialPresent: T
): FurnitureHistoryState<T> {
  return {
    past: [],
    present: initialPresent,
    future: [],
  };
}

export function pushFurnitureHistory<T>(
  state: FurnitureHistoryState<T>,
  nextPresent: T,
  maxDepth = 50
): FurnitureHistoryState<T> {
  const nextPast = [...state.past, state.present].slice(-maxDepth);
  return {
    past: nextPast,
    present: nextPresent,
    future: [],
  };
}

export function undoFurnitureHistory<T>(
  state: FurnitureHistoryState<T>
): FurnitureHistoryState<T> {
  if (state.past.length === 0) return state;
  const previous = state.past[state.past.length - 1];
  const nextPast = state.past.slice(0, -1);
  return {
    past: nextPast,
    present: previous,
    future: [state.present, ...state.future],
  };
}

export function redoFurnitureHistory<T>(
  state: FurnitureHistoryState<T>
): FurnitureHistoryState<T> {
  if (state.future.length === 0) return state;
  const next = state.future[0];
  const nextFuture = state.future.slice(1);
  return {
    past: [...state.past, state.present],
    present: next,
    future: nextFuture,
  };
}
