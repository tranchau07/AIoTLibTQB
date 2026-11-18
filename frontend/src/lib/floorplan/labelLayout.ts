import {
  FLOORPLAN_INTERACTION_CONFIG,
  ZOOM_CONFIG,
} from '@/config/floorplan-hmi.config';
import { isPointInPolygon } from '@/lib/floorplan/polygon';
import type { AlertSeverity, Point2D } from '@/types/api';

export type LabelDensity = 'clean' | 'balanced' | 'detailed';

export type SemanticZoomLevel = 'overview' | 'intermediate' | 'detail';
export type RoomLabelStyle = 'code' | 'pill' | 'rich';
export type SensorPinStyle = 'dot' | 'pin';
export type BayMarkerStyle = 'hidden' | 'dot' | 'pill';

export interface LabelStyleTier {
  style: RoomLabelStyle;
  width: number;
  height: number;
}

export interface LodConfig {
  zoomLevel: SemanticZoomLevel;
  roomLabel: RoomLabelStyle;
  hideSmallRoomsUnderM2: number;
  sensorStyle: SensorPinStyle;
  sensorDotSizePx: number;
  nodeVisualSizePx: number;
  fontSizePx: number;
  fontScale: number;
  showSensors: boolean;
  clusterSensors: boolean;
  showSensorBadge: boolean;
  bayStyle: BayMarkerStyle;
  showFurniture: boolean;
  showDetailedFurniture: boolean;
  showLandmarkText: boolean;
  showAtriumText: boolean;
  showTechWarning: boolean;
}

export interface LabelRequest {
  id: string;
  anchor: Point2D;
  width: number;
  height: number;
  polygon: readonly Point2D[];
  priority: number;
  /** Optional preferred label style; enables placedStyle metadata and fallback cascade */
  style?: RoomLabelStyle;
  /** Optional ordered fallback tiers (e.g. rich -> pill -> code) when primary tier doesn't fit */
  fallbackTiers?: readonly LabelStyleTier[];
}

export interface Obstacle {
  x: number;
  y: number;
  r: number;
}

export interface LabelPlacement {
  id: string;
  x: number;
  y: number;
  visible: boolean;
  placedStyle?: RoomLabelStyle;
  width?: number;
  height?: number;
}

const OBSTACLE_PADDING_PX = 4;
const LABEL_PADDING_PX = 4;
const VIEWPORT_MARGIN_PX = 4;

const MIN_FONT_SIZE_PX = 10;
const MAX_FONT_SIZE_PX = 14;
const BASE_FONT_SIZE_PX = 10.5;
const MIN_NODE_SIZE_PX = 10;
const MAX_NODE_SIZE_PX = 32;

/**
 * Co giãn cỡ chữ theo mức zoom nhưng luôn kẹp chặt trong [10px, 14px] để dễ đọc (Mục B.4).
 */
export function computeScaledFontSizePx(scale: number): number {
  if (!Number.isFinite(scale)) return BASE_FONT_SIZE_PX;
  const clampedScale = Math.max(
    ZOOM_CONFIG.minScale,
    Math.min(ZOOM_CONFIG.maxScale, scale)
  );
  const t =
    (clampedScale - ZOOM_CONFIG.minScale) /
    Math.max(0.01, ZOOM_CONFIG.maxScale - ZOOM_CONFIG.minScale);
  const raw = BASE_FONT_SIZE_PX + t * (MAX_FONT_SIZE_PX - BASE_FONT_SIZE_PX);
  return Number(
    Math.max(MIN_FONT_SIZE_PX, Math.min(MAX_FONT_SIZE_PX, raw)).toFixed(1)
  );
}

/**
 * Co giãn kích thước hiển thị node cảm biến theo mức zoom, kẹp chặt trong [10px, 32px].
 */
export function computeScaledNodeSizePx(
  scale: number,
  density: LabelDensity = 'balanced'
): number {
  if (!Number.isFinite(scale)) return density === 'clean' ? 10 : 12;
  const clampedScale = Math.max(
    ZOOM_CONFIG.minScale,
    Math.min(ZOOM_CONFIG.maxScale, scale)
  );

  let raw: number;
  if (clampedScale < ZOOM_CONFIG.overviewMaxScale) {
    if (density === 'detailed') {
      raw = 24;
    } else if (density === 'clean') {
      raw = 10;
    } else {
      const t =
        (clampedScale - ZOOM_CONFIG.minScale) /
        Math.max(0.01, ZOOM_CONFIG.overviewMaxScale - ZOOM_CONFIG.minScale);
      raw = 12 + t * 2;
    }
  } else if (clampedScale < ZOOM_CONFIG.intermediateMaxScale) {
    const t =
      (clampedScale - ZOOM_CONFIG.overviewMaxScale) /
      Math.max(
        0.01,
        ZOOM_CONFIG.intermediateMaxScale - ZOOM_CONFIG.overviewMaxScale
      );
    raw = density === 'detailed' ? 24 + t * 4 : 16 + t * 6;
  } else {
    const t =
      (clampedScale - ZOOM_CONFIG.intermediateMaxScale) /
      Math.max(0.01, ZOOM_CONFIG.maxScale - ZOOM_CONFIG.intermediateMaxScale);
    raw = 24 + t * 8;
  }

  return Math.round(Math.max(MIN_NODE_SIZE_PX, Math.min(MAX_NODE_SIZE_PX, raw)));
}

export function getAlertSeverityWeight(
  severity?: AlertSeverity | null,
  hasAlert = false
): number {
  if (severity === 'CRITICAL') return 4;
  if (severity === 'HIGH') return 3;
  if (severity === 'MEDIUM') return 2;
  if (severity === 'LOW' || hasAlert) return 1;
  return 0;
}

/**
 * Công thức ưu tiên chống đè nhãn theo chuẩn HMI:
 * ZoomTarget > Mức độ cảnh báo mở (CRITICAL > HIGH > MEDIUM > LOW) > Selected > Diện tích.
 */
export function computeRoomLabelPriority(params: {
  isZoomTarget?: boolean;
  alertSeverity?: AlertSeverity | null;
  hasAlert?: boolean;
  isSelected?: boolean;
  areaM2?: number;
}): number {
  const severityWeight = getAlertSeverityWeight(
    params.alertSeverity,
    Boolean(params.hasAlert)
  );
  return (
    (params.isZoomTarget ? 2_000_000 : 0) +
    severityWeight * 200_000 +
    (params.isSelected ? 50_000 : 0) +
    (params.areaM2 ?? 0)
  );
}

/**
 * Resolves 3-level Semantic Zoom Level-of-Detail (LOD) visibility rules
 * across Canvas and DOM layers based on user-selected density and continuous zoom scale (or boolean legacy flag).
 */
export function getLodConfig(
  density: LabelDensity,
  zoomOrIsZoomed: boolean | number = 1.0
): LodConfig {
  // Legacy boolean mode preserved strictly for backwards compatibility with core-standard tests
  if (typeof zoomOrIsZoomed === 'boolean') {
    if (zoomOrIsZoomed) {
      const fontSizePx = computeScaledFontSizePx(2.1);
      const nodeSize = 28;
      return {
        zoomLevel: 'detail',
        roomLabel: 'rich',
        hideSmallRoomsUnderM2: 0,
        sensorStyle: 'pin',
        sensorDotSizePx: nodeSize,
        nodeVisualSizePx: nodeSize,
        fontSizePx,
        fontScale: Number((fontSizePx / BASE_FONT_SIZE_PX).toFixed(3)),
        showSensors: true,
        clusterSensors: false,
        showSensorBadge: true,
        bayStyle: 'pill',
        showFurniture: true,
        showDetailedFurniture: true,
        showLandmarkText: true,
        showAtriumText: true,
        showTechWarning: true,
      };
    }

    switch (density) {
      case 'clean':
        return {
          zoomLevel: 'overview',
          roomLabel: 'code',
          hideSmallRoomsUnderM2: 65,
          sensorStyle: 'dot',
          sensorDotSizePx: 10,
          nodeVisualSizePx: 10,
          fontSizePx: BASE_FONT_SIZE_PX,
          fontScale: 1,
          showSensors: true,
          clusterSensors: true,
          showSensorBadge: false,
          bayStyle: 'hidden',
          showFurniture: false,
          showDetailedFurniture: false,
          showLandmarkText: false,
          showAtriumText: false,
          showTechWarning: false,
        };
      case 'balanced':
        return {
          zoomLevel: 'overview',
          roomLabel: 'pill',
          hideSmallRoomsUnderM2: 0,
          sensorStyle: 'dot',
          sensorDotSizePx: 12,
          nodeVisualSizePx: 12,
          fontSizePx: BASE_FONT_SIZE_PX,
          fontScale: 1,
          showSensors: true,
          clusterSensors: true,
          showSensorBadge: false,
          bayStyle: 'dot',
          showFurniture: false,
          showDetailedFurniture: false,
          showLandmarkText: false,
          showAtriumText: true,
          showTechWarning: false,
        };
      case 'detailed':
        return {
          zoomLevel: 'detail',
          roomLabel: 'rich',
          hideSmallRoomsUnderM2: 0,
          sensorStyle: 'pin',
          sensorDotSizePx: 28,
          nodeVisualSizePx: 28,
          fontSizePx: 11.5,
          fontScale: Number((11.5 / BASE_FONT_SIZE_PX).toFixed(3)),
          showSensors: true,
          clusterSensors: false,
          showSensorBadge: true,
          bayStyle: 'pill',
          showFurniture: true,
          showDetailedFurniture: true,
          showLandmarkText: true,
          showAtriumText: true,
          showTechWarning: true,
        };
    }
  }

  const scale = Number.isFinite(zoomOrIsZoomed) ? zoomOrIsZoomed : 1.0;
  const fontSizePx = computeScaledFontSizePx(scale);
  const fontScale = Number((fontSizePx / BASE_FONT_SIZE_PX).toFixed(3));
  const nodeVisualSizePx = computeScaledNodeSizePx(scale, density);
  const clusterSensors = scale < FLOORPLAN_INTERACTION_CONFIG.clusterMaxScale;

  // Cấp 3 — Chi tiết (scale >= 1.85)
  if (scale >= ZOOM_CONFIG.intermediateMaxScale) {
    return {
      zoomLevel: 'detail',
      roomLabel: 'rich',
      hideSmallRoomsUnderM2: 0,
      sensorStyle: 'pin',
      sensorDotSizePx: nodeVisualSizePx,
      nodeVisualSizePx,
      fontSizePx,
      fontScale,
      showSensors: true,
      clusterSensors: false,
      showSensorBadge: true,
      bayStyle: 'pill',
      showFurniture: true,
      showDetailedFurniture: true,
      showLandmarkText: true,
      showAtriumText: true,
      showTechWarning: true,
    };
  }

  // Cấp 2 — Trung gian (1.25 <= scale < 1.85)
  if (scale >= ZOOM_CONFIG.overviewMaxScale) {
    const isDetailed = density === 'detailed';
    const isClean = density === 'clean';
    return {
      zoomLevel: 'intermediate',
      roomLabel: isDetailed ? 'rich' : 'pill',
      hideSmallRoomsUnderM2: 0,
      sensorStyle: 'pin',
      sensorDotSizePx: nodeVisualSizePx,
      nodeVisualSizePx,
      fontSizePx,
      fontScale,
      showSensors: true,
      clusterSensors,
      showSensorBadge: !isClean,
      bayStyle: isDetailed ? 'pill' : 'dot',
      showFurniture: !isClean,
      showDetailedFurniture: isDetailed,
      showLandmarkText: isDetailed,
      showAtriumText: true,
      showTechWarning: isDetailed,
    };
  }

  // Cấp 1 — Tổng quan (1.00 <= scale < 1.25)
  if (density === 'detailed') {
    return {
      zoomLevel: 'overview',
      roomLabel: 'rich',
      hideSmallRoomsUnderM2: 0,
      sensorStyle: 'pin',
      sensorDotSizePx: nodeVisualSizePx,
      nodeVisualSizePx,
      fontSizePx,
      fontScale,
      showSensors: true,
      clusterSensors: false,
      showSensorBadge: true,
      bayStyle: 'pill',
      showFurniture: true,
      showDetailedFurniture: false,
      showLandmarkText: true,
      showAtriumText: true,
      showTechWarning: true,
    };
  }

  return {
    zoomLevel: 'overview',
    roomLabel: 'code',
    hideSmallRoomsUnderM2: density === 'clean' ? 65 : 0,
    sensorStyle: 'dot',
    sensorDotSizePx: nodeVisualSizePx,
    nodeVisualSizePx,
    fontSizePx,
    fontScale,
    showSensors: true,
    clusterSensors: true,
    showSensorBadge: false,
    bayStyle: 'hidden',
    showFurniture: false,
    showDetailedFurniture: false,
    showLandmarkText: false,
    showAtriumText: density !== 'clean',
    showTechWarning: false,
  };
}

export interface Box2D {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export function makeLabelBox(
  cx: number,
  cy: number,
  width: number,
  height: number
): Box2D {
  const hw = width * 0.5;
  const hh = height * 0.5;
  return {
    left: cx - hw,
    right: cx + hw,
    top: cy - hh,
    bottom: cy + hh,
  };
}

function boxIntersectsCircle(
  box: Box2D,
  obstacle: Obstacle,
  padding: number
): boolean {
  const nearestX = Math.max(box.left, Math.min(obstacle.x, box.right));
  const nearestY = Math.max(box.top, Math.min(obstacle.y, box.bottom));
  const dx = obstacle.x - nearestX;
  const dy = obstacle.y - nearestY;
  const effectiveR = obstacle.r + padding;
  return dx * dx + dy * dy < effectiveR * effectiveR;
}

export function boxesOverlap(
  a: Box2D,
  b: Box2D,
  padding = LABEL_PADDING_PX
): boolean {
  return !(
    a.right + padding <= b.left ||
    a.left - padding >= b.right ||
    a.bottom + padding <= b.top ||
    a.top - padding >= b.bottom
  );
}

function isCandidateInsidePolygon(
  cx: number,
  cy: number,
  width: number,
  height: number,
  polygon: readonly Point2D[]
): boolean {
  if (!isPointInPolygon({ x: cx, y: cy }, polygon)) {
    return false;
  }
  const rx = width * 0.36;
  const ry = height * 0.36;
  return (
    isPointInPolygon({ x: cx - rx, y: cy }, polygon) &&
    isPointInPolygon({ x: cx + rx, y: cy }, polygon) &&
    isPointInPolygon({ x: cx, y: cy - ry }, polygon) &&
    isPointInPolygon({ x: cx, y: cy + ry }, polygon)
  );
}

function buildCandidateOffsets(width: number, height: number): Point2D[] {
  const dx1 = Math.round(width * 0.6 + 8);
  const dy1 = Math.round(height * 0.6 + 8);
  const dx2 = Math.round(width * 0.65 + 22);
  const dy2 = Math.round(height * 0.65 + 22);
  const tightDy = Math.round(height * 0.5 + 15);
  const tightDx = Math.round(width * 0.5 + 14);

  return [
    { x: 0, y: 0 },
    { x: 0, y: -dy1 },
    { x: 0, y: dy1 },
    { x: -dx1, y: 0 },
    { x: dx1, y: 0 },
    { x: -dx1, y: -dy1 },
    { x: dx1, y: -dy1 },
    { x: -dx1, y: dy1 },
    { x: dx1, y: dy1 },
    { x: 0, y: -dy2 },
    { x: 0, y: dy2 },
    { x: -dx2, y: 0 },
    { x: dx2, y: 0 },
    { x: -dx2, y: -dy2 },
    { x: dx2, y: -dy2 },
    { x: -dx2, y: dy2 },
    { x: dx2, y: dy2 },
    // Extra tight offsets helpful for dodging small center obstacles in compact study rooms
    { x: 0, y: -tightDy },
    { x: 0, y: tightDy },
    { x: -tightDx, y: 0 },
    { x: tightDx, y: 0 },
  ];
}

/**
 * Greedy screen-space collision avoidance for room labels.
 * Places highest-priority labels first (ZoomTarget -> CRITICAL/HIGH alerts -> Selected -> Area)
 * and supports 3-step style fallback (rich -> pill -> code) when narrow rooms cannot fit a rich card.
 */
export function computeLabelPlacements(
  requests: readonly LabelRequest[],
  obstacles: readonly Obstacle[],
  viewport: { width: number; height: number }
): LabelPlacement[] {
  const indexed = requests.map((req, index) => ({ req, index }));
  indexed.sort(
    (a, b) => b.req.priority - a.req.priority || a.index - b.index
  );

  const results: LabelPlacement[] = new Array(requests.length);
  const placedBoxes: Box2D[] = [];

  for (const { req, index } of indexed) {
    const includeStyleMeta =
      req.style !== undefined ||
      (req.fallbackTiers !== undefined && req.fallbackTiers.length > 0);

    if (
      req.width <= 0 ||
      req.height <= 0 ||
      !req.polygon ||
      req.polygon.length < 3
    ) {
      results[index] = includeStyleMeta
        ? {
            id: req.id,
            x: req.anchor.x,
            y: req.anchor.y,
            visible: false,
            placedStyle: req.style,
            width: req.width,
            height: req.height,
          }
        : {
            id: req.id,
            x: req.anchor.x,
            y: req.anchor.y,
            visible: false,
          };
      continue;
    }

    const tiersToTry: Array<{
      style: RoomLabelStyle | undefined;
      width: number;
      height: number;
    }> = [
      { style: req.style, width: req.width, height: req.height },
      ...(req.fallbackTiers ?? []),
    ].filter((t) => t.width > 0 && t.height > 0);

    let chosen: Point2D | null = null;
    let chosenBox: Box2D | null = null;
    let chosenTier: {
      style: RoomLabelStyle | undefined;
      width: number;
      height: number;
    } | null = null;

    for (const tier of tiersToTry) {
      const candidateOffsets = buildCandidateOffsets(tier.width, tier.height);

      for (const offset of candidateOffsets) {
        const cx = req.anchor.x + offset.x;
        const cy = req.anchor.y + offset.y;
        const box = makeLabelBox(cx, cy, tier.width, tier.height);

        // 1. Must stay inside viewport bounds
        if (
          box.left < VIEWPORT_MARGIN_PX ||
          box.right > viewport.width - VIEWPORT_MARGIN_PX ||
          box.top < VIEWPORT_MARGIN_PX ||
          box.bottom > viewport.height - VIEWPORT_MARGIN_PX
        ) {
          continue;
        }

        // 2. Center and inset cardinal points must lie inside the room polygon
        if (
          !isCandidateInsidePolygon(
            cx,
            cy,
            tier.width,
            tier.height,
            req.polygon
          )
        ) {
          continue;
        }

        // 3. Must not intersect any obstacle (sensor pin/cluster, reading bay, landmark)
        let hitsObstacle = false;
        for (const obs of obstacles) {
          if (boxIntersectsCircle(box, obs, OBSTACLE_PADDING_PX)) {
            hitsObstacle = true;
            break;
          }
        }
        if (hitsObstacle) continue;

        // 4. Must not overlap any already-placed higher-priority label
        let hitsPlacedLabel = false;
        for (const placed of placedBoxes) {
          if (boxesOverlap(box, placed, LABEL_PADDING_PX)) {
            hitsPlacedLabel = true;
            break;
          }
        }
        if (hitsPlacedLabel) continue;

        chosen = { x: cx, y: cy };
        chosenBox = box;
        chosenTier = tier;
        break;
      }

      if (chosen) break;
    }

    if (chosen && chosenBox && chosenTier) {
      placedBoxes.push(chosenBox);
      results[index] = includeStyleMeta
        ? {
            id: req.id,
            x: chosen.x,
            y: chosen.y,
            visible: true,
            placedStyle: chosenTier.style,
            width: chosenTier.width,
            height: chosenTier.height,
          }
        : {
            id: req.id,
            x: chosen.x,
            y: chosen.y,
            visible: true,
          };
    } else {
      results[index] = includeStyleMeta
        ? {
            id: req.id,
            x: req.anchor.x,
            y: req.anchor.y,
            visible: false,
            placedStyle: req.style,
            width: req.width,
            height: req.height,
          }
        : {
            id: req.id,
            x: req.anchor.x,
            y: req.anchor.y,
            visible: false,
          };
    }
  }

  return results;
}
