import { isPointInPolygon } from '@/lib/floorplan/polygon';
import type { Point2D } from '@/types/api';

export type LabelDensity = 'clean' | 'balanced' | 'detailed';

export type RoomLabelStyle = 'code' | 'pill' | 'rich';
export type SensorPinStyle = 'dot' | 'pin';
export type BayMarkerStyle = 'hidden' | 'dot' | 'pill';

export interface LodConfig {
  roomLabel: RoomLabelStyle;
  hideSmallRoomsUnderM2: number;
  sensorStyle: SensorPinStyle;
  sensorDotSizePx: number;
  showSensorBadge: boolean;
  bayStyle: BayMarkerStyle;
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
}

const OBSTACLE_PADDING_PX = 4;
const LABEL_PADDING_PX = 4;
const VIEWPORT_MARGIN_PX = 4;

/**
 * Resolves Level-of-Detail (LOD) visibility rules across Canvas and DOM layers
 * based on user-selected density and 2-level zoom state.
 */
export function getLodConfig(
  density: LabelDensity,
  isZoomed: boolean
): LodConfig {
  if (isZoomed) {
    return {
      roomLabel: 'rich',
      hideSmallRoomsUnderM2: 0,
      sensorStyle: 'pin',
      sensorDotSizePx: 28,
      showSensorBadge: true,
      bayStyle: 'pill',
      showLandmarkText: true,
      showAtriumText: true,
      showTechWarning: true,
    };
  }

  switch (density) {
    case 'clean':
      return {
        roomLabel: 'code',
        hideSmallRoomsUnderM2: 65,
        sensorStyle: 'dot',
        sensorDotSizePx: 10,
        showSensorBadge: false,
        bayStyle: 'hidden',
        showLandmarkText: false,
        showAtriumText: false,
        showTechWarning: false,
      };
    case 'balanced':
      return {
        roomLabel: 'pill',
        hideSmallRoomsUnderM2: 0,
        sensorStyle: 'dot',
        sensorDotSizePx: 12,
        showSensorBadge: false,
        bayStyle: 'dot',
        showLandmarkText: false,
        showAtriumText: true,
        showTechWarning: false,
      };
    case 'detailed':
      return {
        roomLabel: 'rich',
        hideSmallRoomsUnderM2: 0,
        sensorStyle: 'pin',
        sensorDotSizePx: 28,
        showSensorBadge: true,
        bayStyle: 'pill',
        showLandmarkText: true,
        showAtriumText: true,
        showTechWarning: true,
      };
  }
}

interface Box2D {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function makeBox(cx: number, cy: number, width: number, height: number): Box2D {
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

function boxesOverlap(a: Box2D, b: Box2D, padding: number): boolean {
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

/**
 * Greedy screen-space collision avoidance for room labels.
 * Places highest-priority labels first (selected/zoomed room -> largest area rooms)
 * and shifts labels away from sensor pins, reading bays, and landmarks.
 */
export function computeLabelPlacements(
  requests: readonly LabelRequest[],
  obstacles: readonly Obstacle[],
  viewport: { width: number; height: number }
): LabelPlacement[] {
  const indexed = requests.map((req, index) => ({ req, index }));
  indexed.sort((a, b) => b.req.priority - a.req.priority);

  const results: LabelPlacement[] = new Array(requests.length);
  const placedBoxes: Box2D[] = [];

  for (const { req, index } of indexed) {
    if (
      req.width <= 0 ||
      req.height <= 0 ||
      !req.polygon ||
      req.polygon.length < 3
    ) {
      results[index] = {
        id: req.id,
        x: req.anchor.x,
        y: req.anchor.y,
        visible: false,
      };
      continue;
    }

    const dx1 = Math.round(req.width * 0.6 + 8);
    const dy1 = Math.round(req.height * 0.6 + 8);
    const dx2 = Math.round(req.width * 0.65 + 22);
    const dy2 = Math.round(req.height * 0.65 + 22);

    const candidateOffsets: readonly Point2D[] = [
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
    ];

    let chosen: Point2D | null = null;
    let chosenBox: Box2D | null = null;

    for (const offset of candidateOffsets) {
      const cx = req.anchor.x + offset.x;
      const cy = req.anchor.y + offset.y;
      const box = makeBox(cx, cy, req.width, req.height);

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
        !isCandidateInsidePolygon(cx, cy, req.width, req.height, req.polygon)
      ) {
        continue;
      }

      // 3. Must not intersect any obstacle (sensor pin, reading bay, landmark)
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
      break;
    }

    if (chosen && chosenBox) {
      placedBoxes.push(chosenBox);
      results[index] = {
        id: req.id,
        x: chosen.x,
        y: chosen.y,
        visible: true,
      };
    } else {
      results[index] = {
        id: req.id,
        x: req.anchor.x,
        y: req.anchor.y,
        visible: false,
      };
    }
  }

  return results;
}
