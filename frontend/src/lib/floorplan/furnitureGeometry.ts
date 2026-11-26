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
export const STRUCTURAL_COLUMN_SIZE_M = 0.6;

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
  readonly columnConflictIds: Set<string>;
  readonly overlappingPairs: Array<[string, string]>;
  readonly invalidIds: Set<string>;
  readonly errorsByItemId: Record<string, string[]>;
}

export interface AlignmentGuide {
  readonly orientation: 'vertical' | 'horizontal';
  readonly posNorm: number;
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

export function isPointInsideFurnitureItem(
  pointNorm: Point2D,
  item: Pick<FurnitureItem, 'x' | 'y' | 'widthM' | 'depthM' | 'rotationDeg'>,
  hitPaddingM = 0
): boolean {
  const ptM = normalizedToMetersPoint(pointNorm);
  const cx = item.x * TQB_BUILDING_WIDTH_M;
  const cy = item.y * TQB_BUILDING_DEPTH_M;
  const dx = ptM.x - cx;
  const dy = ptM.y - cy;
  const rad = ((item.rotationDeg ?? 0) * Math.PI) / 180;
  const ux = Math.cos(rad);
  const uy = Math.sin(rad);
  const vx = -Math.sin(rad);
  const vy = Math.cos(rad);
  const projU = dx * ux + dy * uy;
  const projV = dx * vx + dy * vy;
  const hw = item.widthM * 0.5 + hitPaddingM;
  const hd = item.depthM * 0.5 + hitPaddingM;
  return Math.abs(projU) <= hw && Math.abs(projV) <= hd;
}

export function findTopmostFurnitureAtPoint<T extends FurnitureItem>(
  pointNorm: Point2D,
  items: readonly T[],
  hitPaddingM = 0.08
): T | null {
  if (!items || items.length === 0) return null;
  const sorted = [...items].sort(
    (a, b) => a.widthM * a.depthM - b.widthM * b.depthM
  );
  for (const item of sorted) {
    if (isPointInsideFurnitureItem(pointNorm, item, hitPaddingM)) {
      return item;
    }
  }
  return null;
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

/**
 * Kiểm tra xem vật thể nội thất có đè lên Cột chịu lực BTCT (0.60m × 0.60m) trong phòng không.
 * Bỏ qua các đối tượng không chắn lối đi (IOT_NODE, DOOR).
 */
export function doesFurnitureOverlapColumn(
  item: Pick<FurnitureItem, 'typeId' | 'x' | 'y' | 'widthM' | 'depthM' | 'rotationDeg'>,
  columnsNorm?: readonly Point2D[] | null,
  columnSizeM = STRUCTURAL_COLUMN_SIZE_M,
  catalog: readonly FurnitureCatalogEntry[] = FURNITURE_CATALOG
): boolean {
  if (!columnsNorm || columnsNorm.length === 0) {
    return false;
  }
  const entry = resolveFurnitureCatalogEntry(item.typeId, catalog);
  if (!entry.blocksWalkway) {
    return false;
  }

  const cornersItem = getFurnitureObbCornersMeters(item);
  const itemAxes: Point2D[] = [
    edgeNormal(cornersItem[0], cornersItem[1]),
    edgeNormal(cornersItem[1], cornersItem[2]),
  ];

  for (const colNorm of columnsNorm) {
    const colBox: Pick<
      FurnitureItem,
      'x' | 'y' | 'widthM' | 'depthM' | 'rotationDeg'
    > = {
      x: colNorm.x,
      y: colNorm.y,
      widthM: columnSizeM,
      depthM: columnSizeM,
      rotationDeg: 0,
    };
    const cornersCol = getFurnitureObbCornersMeters(colBox);
    const axes: Point2D[] = [
      ...itemAxes,
      { x: 1, y: 0 },
      { x: 0, y: 1 },
    ];
    let separated = false;
    for (const axis of axes) {
      const projA = projectPolygonOnAxis(cornersItem, axis);
      const projB = projectPolygonOnAxis(cornersCol, axis);
      if (
        projA.max <= projB.min + GEOMETRY_EPS ||
        projB.max <= projA.min + GEOMETRY_EPS
      ) {
        separated = true;
        break;
      }
    }
    if (!separated) {
      return true;
    }
  }
  return false;
}

export function validateFurnitureLayout(
  items: readonly FurnitureItem[],
  polygonNorm?: readonly Point2D[] | null,
  catalog: readonly FurnitureCatalogEntry[] = FURNITURE_CATALOG,
  structuralColumnsNorm?: readonly Point2D[] | null
): FurnitureValidationResult {
  const outOfBoundsIds = new Set<string>();
  const columnConflictIds = new Set<string>();
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
    if (
      structuralColumnsNorm &&
      structuralColumnsNorm.length > 0 &&
      doesFurnitureOverlapColumn(
        item,
        structuralColumnsNorm,
        STRUCTURAL_COLUMN_SIZE_M,
        catalog
      )
    ) {
      columnConflictIds.add(item.id);
      invalidIds.add(item.id);
      pushErr(item.id, FLOORPLAN_I18N_VI.furniture.columnOverlapError);
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
    columnConflictIds,
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

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeUniqueFurnitureId(typeId: string): string {
  const slug = typeId.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const rand = Math.random().toString(36).slice(2, 7);
  return `furn_${slug}_${Date.now().toString(36)}_${rand}`;
}

/**
 * Tự động đánh số tên chuẩn cho nội thất mới thêm vào phòng:
 * "Bàn dài số 1", "Bàn dài số 2", "Ghế đơn số 1"...
 */
export function generateNextFurnitureLabel(
  typeId: string,
  existingItems: readonly FurnitureItem[],
  catalog: readonly FurnitureCatalogEntry[] = FURNITURE_CATALOG
): string {
  const entry = resolveFurnitureCatalogEntry(typeId, catalog);
  const base = entry.shortLabel.trim() || entry.labelVi.trim() || 'Nội thất';
  const pattern = new RegExp(`^${escapeRegExp(base)}\\s+số\\s+(\\d+)$`, 'i');
  const trailingNum = /(\d+)$/;

  let maxIdx = 0;
  const normalizedTarget = typeId.trim().toUpperCase();
  for (const it of existingItems) {
    const lbl = (it.label ?? '').trim();
    if (!lbl) continue;
    const match = lbl.match(pattern);
    if (match) {
      const n = Number.parseInt(match[1], 10);
      if (Number.isFinite(n) && n > maxIdx) maxIdx = n;
    } else if (it.typeId.trim().toUpperCase() === normalizedTarget) {
      const numMatch = lbl.match(trailingNum);
      if (numMatch) {
        const n = Number.parseInt(numMatch[1], 10);
        if (Number.isFinite(n) && n > maxIdx) maxIdx = n;
      }
    }
  }
  return `${base} số ${maxIdx + 1}`;
}

/**
 * Tăng số thứ tự khi nhân bản một món đồ (VD: "Bàn dài số 1" -> "Bàn dài số 2").
 */
export function incrementFurnitureLabel(
  baseLabel: string | undefined,
  existingLabels: readonly (string | undefined)[],
  fallbackPrefix = 'Nội thất'
): string {
  const used = new Set(
    existingLabels
      .map((l) => (l ?? '').trim().toLowerCase())
      .filter((l) => l.length > 0)
  );
  const clean = (baseLabel ?? '').trim() || fallbackPrefix;
  const trailingMatch = clean.match(/^(.*?)(\d+)$/);
  if (trailingMatch) {
    const prefix = trailingMatch[1];
    const rawNum = trailingMatch[2];
    const width = rawNum.length;
    let nextNum = Number.parseInt(rawNum, 10) + 1;
    while (nextNum < 10000) {
      const formatted =
        rawNum.startsWith('0') && String(nextNum).length < width
          ? String(nextNum).padStart(width, '0')
          : String(nextNum);
      const cand = `${prefix}${formatted}`;
      if (!used.has(cand.toLowerCase())) {
        return cand;
      }
      nextNum += 1;
    }
  }
  let suffix = 2;
  while (suffix < 10000) {
    const cand = `${clean} (${suffix})`;
    if (!used.has(cand.toLowerCase())) {
      return cand;
    }
    suffix += 1;
  }
  return `${clean} (${Date.now()})`;
}

function isPlacementCandidateValid(
  candidate: FurnitureItem,
  existingItems: readonly FurnitureItem[],
  polygonNorm?: readonly Point2D[] | null,
  structuralColumnsNorm?: readonly Point2D[] | null,
  catalog: readonly FurnitureCatalogEntry[] = FURNITURE_CATALOG
): boolean {
  if (!isFurnitureInsideRoom(candidate, polygonNorm)) {
    return false;
  }
  if (
    structuralColumnsNorm &&
    structuralColumnsNorm.length > 0 &&
    doesFurnitureOverlapColumn(
      candidate,
      structuralColumnsNorm,
      STRUCTURAL_COLUMN_SIZE_M,
      catalog
    )
  ) {
    return false;
  }
  for (const other of existingItems) {
    if (doFurnitureItemsOverlap(candidate, other, catalog)) {
      return false;
    }
  }
  return true;
}

/**
 * Quét xoắn ốc theo mét (step 0.4m, bán kính tới 28m) để tìm vị trí hợp lệ gần nhất
 * thỏa mãn đồng thời: trong ranh giới tường, không đè cột BTCT, không chồng đồ có sẵn.
 */
export function findNearestValidPlacement(
  candidateTemplate: Pick<
    FurnitureItem,
    'typeId' | 'widthM' | 'depthM' | 'rotationDeg'
  >,
  existingItems: readonly FurnitureItem[],
  polygonNorm?: readonly Point2D[] | null,
  structuralColumnsNorm?: readonly Point2D[] | null,
  preferredCenterNorm: Point2D = { x: 0.5, y: 0.5 },
  snapStepM = 0.1,
  catalog: readonly FurnitureCatalogEntry[] = FURNITURE_CATALOG
): Point2D {
  const prefM = normalizedToMetersPoint(preferredCenterNorm);
  const stepM = 0.4;
  const maxSteps = Math.ceil(28 / stepM);

  const testPt = (xM: number, yM: number): Point2D | null => {
    const rawNorm = metersToNormalizedPoint({
      x: Math.max(0.2, Math.min(TQB_BUILDING_WIDTH_M - 0.2, xM)),
      y: Math.max(0.2, Math.min(TQB_BUILDING_DEPTH_M - 0.2, yM)),
    });
    const snapped =
      snapStepM > 0 ? snapNormalizedPointToGrid(rawNorm, snapStepM) : rawNorm;
    const probe: FurnitureItem = {
      id: '__probe__',
      typeId: candidateTemplate.typeId,
      x: Number(snapped.x.toFixed(4)),
      y: Number(snapped.y.toFixed(4)),
      widthM: candidateTemplate.widthM,
      depthM: candidateTemplate.depthM,
      rotationDeg: candidateTemplate.rotationDeg ?? 0,
      locked: false,
    };
    if (
      isPlacementCandidateValid(
        probe,
        existingItems,
        polygonNorm,
        structuralColumnsNorm,
        catalog
      )
    ) {
      return { x: probe.x, y: probe.y };
    }
    return null;
  };

  const centerHit = testPt(prefM.x, prefM.y);
  if (centerHit) return centerHit;

  for (let r = 1; r <= maxSteps; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const hit = testPt(prefM.x + dx * stepM, prefM.y + dy * stepM);
        if (hit) return hit;
      }
    }
  }

  const fallback =
    snapStepM > 0
      ? snapNormalizedPointToGrid(preferredCenterNorm, snapStepM)
      : preferredCenterNorm;
  return {
    x: Number(fallback.x.toFixed(4)),
    y: Number(fallback.y.toFixed(4)),
  };
}

/**
 * Nhân bản thẳng hàng thông minh (+1 hoặc x3) dọc theo hướng xoay của vật thể gốc,
 * tự nhảy hàng song song hoặc dò vị trí trống nếu chạm tường/cột/đồ khác.
 */
export function duplicateFurnitureItemsSmartly(
  allItems: readonly FurnitureItem[],
  selectedIds: readonly string[],
  countCopies = 1,
  polygonNorm?: readonly Point2D[] | null,
  structuralColumnsNorm?: readonly Point2D[] | null,
  snapStepM = 0.1,
  catalog: readonly FurnitureCatalogEntry[] = FURNITURE_CATALOG
): FurnitureItem[] {
  const selectedSet = new Set(selectedIds);
  const sources = allItems.filter((it) => selectedSet.has(it.id));
  if (sources.length === 0 || countCopies <= 0) return [];

  const workingItems: FurnitureItem[] = [...allItems];
  const clones: FurnitureItem[] = [];

  for (const src of sources) {
    const entry = resolveFurnitureCatalogEntry(src.typeId, catalog);
    const rotRad = ((src.rotationDeg ?? 0) * Math.PI) / 180;
    const ux = Math.cos(rotRad);
    const uy = Math.sin(rotRad);
    const vx = -Math.sin(rotRad);
    const vy = Math.cos(rotRad);

    const gapM = entry.typeId.toUpperCase() === 'CHAIR' ? 0.15 : 0.4;
    const stepAlongM = src.widthM + gapM;
    const stepRowM = src.depthM + 0.6;

    let anchorM = normalizedToMetersPoint({ x: src.x, y: src.y });

    for (let copyIdx = 0; copyIdx < countCopies; copyIdx++) {
      let chosenNorm: Point2D | null = null;

      // Thử xếp nối tiếp dọc trục chính và dịch hàng song song khi cần
      const candidateOffsets: Array<{ along: number; across: number }> = [
        { along: stepAlongM, across: 0 },
        { along: -stepAlongM, across: 0 },
        { along: 0, across: stepRowM },
        { along: 0, across: -stepRowM },
        { along: stepAlongM * 2, across: 0 },
        { along: stepAlongM, across: stepRowM },
      ];

      for (const off of candidateOffsets) {
        const rawNorm = metersToNormalizedPoint({
          x: anchorM.x + off.along * ux + off.across * vx,
          y: anchorM.y + off.along * uy + off.across * vy,
        });
        const snapped =
          snapStepM > 0 ? snapNormalizedPointToGrid(rawNorm, snapStepM) : rawNorm;
        const probe: FurnitureItem = {
          id: '__dup_probe__',
          typeId: src.typeId,
          x: Number(snapped.x.toFixed(4)),
          y: Number(snapped.y.toFixed(4)),
          widthM: src.widthM,
          depthM: src.depthM,
          rotationDeg: src.rotationDeg ?? 0,
          locked: false,
        };
        if (
          isPlacementCandidateValid(
            probe,
            workingItems,
            polygonNorm,
            structuralColumnsNorm,
            catalog
          )
        ) {
          chosenNorm = { x: probe.x, y: probe.y };
          break;
        }
      }

      if (!chosenNorm) {
        const preferred = metersToNormalizedPoint({
          x: anchorM.x + stepAlongM * ux,
          y: anchorM.y + stepAlongM * uy,
        });
        chosenNorm = findNearestValidPlacement(
          src,
          workingItems,
          polygonNorm,
          structuralColumnsNorm,
          preferred,
          snapStepM,
          catalog
        );
      }

      const nextLabel = incrementFurnitureLabel(
        src.label || entry.shortLabel,
        workingItems.map((it) => it.label),
        entry.shortLabel
      );

      const clone: FurnitureItem = {
        ...src,
        id: makeUniqueFurnitureId(src.typeId),
        label: nextLabel,
        x: chosenNorm.x,
        y: chosenNorm.y,
        locked: false,
      };
      workingItems.push(clone);
      clones.push(clone);
      anchorM = normalizedToMetersPoint({ x: clone.x, y: clone.y });
    }
  }

  return clones;
}

/**
 * Tính vị trí kéo thả thông minh:
 * 1) Hút lưới snapStepM (0.10m) nếu snapEnabled = true
 * 2) Hút gióng hàng tự động (< 0.12m) theo tâm hoặc mép các món lân cận và trả về các đường AlignmentGuide.
 */
export function computeSmartDragPosition(
  draggedItem: Pick<FurnitureItem, 'id' | 'x' | 'y' | 'widthM' | 'depthM' | 'rotationDeg'>,
  rawNorm: Point2D,
  otherItems: readonly FurnitureItem[],
  snapEnabled: boolean,
  snapStepM = 0.1
): { x: number; y: number; guides: AlignmentGuide[] } {
  const basePos = snapEnabled
    ? snapNormalizedPointToGrid(rawNorm, snapStepM)
    : rawNorm;

  const baseM = normalizedToMetersPoint(basePos);
  const candItem = {
    x: basePos.x,
    y: basePos.y,
    widthM: draggedItem.widthM,
    depthM: draggedItem.depthM,
    rotationDeg: draggedItem.rotationDeg ?? 0,
  };
  const candCornersM = getFurnitureObbCornersMeters(candItem);
  const candMinX = Math.min(...candCornersM.map((c) => c.x));
  const candMaxX = Math.max(...candCornersM.map((c) => c.x));
  const candMinY = Math.min(...candCornersM.map((c) => c.y));
  const candMaxY = Math.max(...candCornersM.map((c) => c.y));

  const ALIGN_THRESHOLD_M = 0.12;
  let bestDxM = ALIGN_THRESHOLD_M + 1;
  let bestDyM = ALIGN_THRESHOLD_M + 1;
  let alignedXNorm = basePos.x;
  let alignedYNorm = basePos.y;
  let guideXNorm: number | null = null;
  let guideYNorm: number | null = null;

  for (const other of otherItems) {
    if (other.id === draggedItem.id) continue;
    const otherCornersM = getFurnitureObbCornersMeters(other);
    const oMinX = Math.min(...otherCornersM.map((c) => c.x));
    const oMaxX = Math.max(...otherCornersM.map((c) => c.x));
    const oMinY = Math.min(...otherCornersM.map((c) => c.y));
    const oMaxY = Math.max(...otherCornersM.map((c) => c.y));
    const oCenterM = normalizedToMetersPoint({ x: other.x, y: other.y });

    const xMatches: Array<{ delta: number; guideM: number }> = [
      { delta: oCenterM.x - baseM.x, guideM: oCenterM.x },
      { delta: oMinX - candMinX, guideM: oMinX },
      { delta: oMaxX - candMaxX, guideM: oMaxX },
    ];
    for (const m of xMatches) {
      if (Math.abs(m.delta) <= ALIGN_THRESHOLD_M && Math.abs(m.delta) < Math.abs(bestDxM)) {
        bestDxM = m.delta;
        alignedXNorm = (baseM.x + m.delta) / TQB_BUILDING_WIDTH_M;
        guideXNorm = m.guideM / TQB_BUILDING_WIDTH_M;
      }
    }

    const yMatches: Array<{ delta: number; guideM: number }> = [
      { delta: oCenterM.y - baseM.y, guideM: oCenterM.y },
      { delta: oMinY - candMinY, guideM: oMinY },
      { delta: oMaxY - candMaxY, guideM: oMaxY },
    ];
    for (const m of yMatches) {
      if (Math.abs(m.delta) <= ALIGN_THRESHOLD_M && Math.abs(m.delta) < Math.abs(bestDyM)) {
        bestDyM = m.delta;
        alignedYNorm = (baseM.y + m.delta) / TQB_BUILDING_DEPTH_M;
        guideYNorm = m.guideM / TQB_BUILDING_DEPTH_M;
      }
    }
  }

  const guides: AlignmentGuide[] = [];
  if (guideXNorm !== null) {
    guides.push({
      orientation: 'vertical',
      posNorm: Number(guideXNorm.toFixed(4)),
    });
  }
  if (guideYNorm !== null) {
    guides.push({
      orientation: 'horizontal',
      posNorm: Number(guideYNorm.toFixed(4)),
    });
  }

  return {
    x: Number(Math.max(0.005, Math.min(0.995, alignedXNorm)).toFixed(4)),
    y: Number(Math.max(0.005, Math.min(0.995, alignedYNorm)).toFixed(4)),
    guides,
  };
}
