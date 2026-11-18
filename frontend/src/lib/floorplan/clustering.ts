import {
  FLOORPLAN_INTERACTION_CONFIG,
  ZOOM_CONFIG,
} from '@/config/floorplan-hmi.config';
import { getAlertSeverityWeight } from '@/lib/floorplan/labelLayout';
import type { AlertSeverity, DeviceResponse, Point2D } from '@/types/api';

export interface ClusterableDeviceInput<
  T extends Pick<
    DeviceResponse,
    'id' | 'roomId' | 'posX' | 'posY' | 'online' | 'connectionState'
  > = DeviceResponse,
> {
  device: T;
  screenPx?: Point2D;
  severity?: AlertSeverity | null;
  isAlerting?: boolean;
  isFocused?: boolean;
}

export interface DeviceCluster<
  T extends Pick<
    DeviceResponse,
    'id' | 'roomId' | 'posX' | 'posY' | 'online' | 'connectionState'
  > = DeviceResponse,
> {
  id: string;
  count: number;
  devices: T[];
  items: Array<ClusterableDeviceInput<T> & { screenPx: Point2D }>;
  centroidScreen: Point2D;
  centroidNorm: Point2D;
  highestSeverity: AlertSeverity | null;
  hasAlert: boolean;
  isCluster: boolean;
  onlineCount: number;
  targetZoomScale: number;
}

export interface ClusterDeviceNodesOptions {
  clusterRadiusPx?: number;
  maxClusterScale?: number;
  canvasWidth?: number;
  canvasHeight?: number;
}

function highestSeverityOf(
  items: ReadonlyArray<{ severity?: AlertSeverity | null }>
): AlertSeverity | null {
  let bestSeverity: AlertSeverity | null = null;
  let bestWeight = 0;

  for (const item of items) {
    if (!item.severity) continue;
    const w = getAlertSeverityWeight(item.severity, true);
    if (w > bestWeight) {
      bestWeight = w;
      bestSeverity = item.severity;
    }
  }

  return bestSeverity;
}

/**
 * Gom cụm không gian cho các node cảm biến đứng gần nhau (< clusterRadiusPx)
 * khi zoom thấp (< maxClusterScale), và tách hoàn toàn thành từng node khi phóng to vào.
 */
export function clusterDeviceNodes<
  T extends Pick<
    DeviceResponse,
    'id' | 'roomId' | 'posX' | 'posY' | 'online' | 'connectionState'
  >,
>(
  inputs: readonly ClusterableDeviceInput<T>[],
  scale: number,
  options: ClusterDeviceNodesOptions = {}
): Array<DeviceCluster<T>> {
  const clusterRadiusPx =
    options.clusterRadiusPx ?? FLOORPLAN_INTERACTION_CONFIG.clusterRadiusPx;
  const maxClusterScale =
    options.maxClusterScale ?? FLOORPLAN_INTERACTION_CONFIG.clusterMaxScale;
  const fallbackWidth = options.canvasWidth ?? 960;
  const fallbackHeight = options.canvasHeight ?? 722;
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1.0;

  const normalizedInputs = inputs.map((item) => {
    const nx = typeof item.device.posX === 'number' ? item.device.posX : 0.5;
    const ny = typeof item.device.posY === 'number' ? item.device.posY : 0.5;
    const screenPx: Point2D = item.screenPx ?? {
      x: nx * fallbackWidth * safeScale,
      y: ny * fallbackHeight * safeScale,
    };
    return {
      ...item,
      screenPx,
    };
  });

  const targetZoomScale = Math.min(
    ZOOM_CONFIG.maxScale,
    Math.max(
      ZOOM_CONFIG.clusterExpandScale,
      Number((safeScale + ZOOM_CONFIG.clusterScaleStep).toFixed(3))
    )
  );

  // Từ ngưỡng phóng đại >= maxClusterScale (1.55x): tách rời thành các node đơn lẻ
  if (safeScale >= maxClusterScale || normalizedInputs.length <= 1) {
    return normalizedInputs.map((item) => {
      const nx = typeof item.device.posX === 'number' ? item.device.posX : 0.5;
      const ny = typeof item.device.posY === 'number' ? item.device.posY : 0.5;
      const isOnline =
        Boolean(item.device.online) ||
        item.device.connectionState === 'ONLINE';
      return {
        id: item.device.id,
        count: 1,
        devices: [item.device],
        items: [item],
        centroidScreen: item.screenPx,
        centroidNorm: { x: nx, y: ny },
        highestSeverity: item.severity ?? null,
        hasAlert: Boolean(item.isAlerting || item.severity),
        isCluster: false,
        onlineCount: isOnline ? 1 : 0,
        targetZoomScale,
      };
    });
  }

  // Ưu tiên node có cảnh báo cao làm hạt nhân gom cụm trước (nhất quán & bảo toàn mức cảnh báo)
  const ordered = [...normalizedInputs].sort((a, b) => {
    const wa = getAlertSeverityWeight(a.severity, Boolean(a.isAlerting));
    const wb = getAlertSeverityWeight(b.severity, Boolean(b.isAlerting));
    if (wb !== wa) return wb - wa;
    return a.device.id.localeCompare(b.device.id);
  });

  const assigned = new Set<string>();
  const clusters: Array<DeviceCluster<T>> = [];

  for (const seed of ordered) {
    if (assigned.has(seed.device.id)) continue;
    assigned.add(seed.device.id);

    const group = [seed];
    for (const candidate of ordered) {
      if (assigned.has(candidate.device.id)) continue;

      const sameOrUnboundRoom =
        !seed.device.roomId ||
        !candidate.device.roomId ||
        seed.device.roomId === candidate.device.roomId;
      const dist = Math.hypot(
        candidate.screenPx.x - seed.screenPx.x,
        candidate.screenPx.y - seed.screenPx.y
      );

      // Gom các node cùng phòng hoặc kề sát nhau trong bán kính va chạm nút 44px
      if (dist < clusterRadiusPx && (sameOrUnboundRoom || dist < clusterRadiusPx * 0.75)) {
        assigned.add(candidate.device.id);
        group.push(candidate);
      }
    }

    const avgScreenX =
      group.reduce((sum, item) => sum + item.screenPx.x, 0) / group.length;
    const avgScreenY =
      group.reduce((sum, item) => sum + item.screenPx.y, 0) / group.length;
    const avgNormX =
      group.reduce(
        (sum, item) =>
          sum + (typeof item.device.posX === 'number' ? item.device.posX : 0.5),
        0
      ) / group.length;
    const avgNormY =
      group.reduce(
        (sum, item) =>
          sum + (typeof item.device.posY === 'number' ? item.device.posY : 0.5),
        0
      ) / group.length;

    const isCluster = group.length >= 2;
    const sortedIds = group.map((g) => g.device.id).sort();

    clusters.push({
      id: isCluster ? `cluster-${sortedIds.join('_')}` : group[0].device.id,
      count: group.length,
      devices: group.map((g) => g.device),
      items: group,
      centroidScreen: { x: avgScreenX, y: avgScreenY },
      centroidNorm: { x: avgNormX, y: avgNormY },
      highestSeverity: highestSeverityOf(group),
      hasAlert: group.some((g) => Boolean(g.isAlerting || g.severity)),
      isCluster,
      onlineCount: group.filter(
        (g) => Boolean(g.device.online) || g.device.connectionState === 'ONLINE'
      ).length,
      targetZoomScale,
    });
  }

  return clusters;
}
