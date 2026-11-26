import type { HeatmapLayerMetric } from '@/config/thresholds';
import type { AlertResponse, RoomResponse, TelemetryResponse } from '@/types/api';

/**
 * Cấu hình trung tâm cho Giao diện Giám sát Bản đồ Nhiệt HMI (Quản lý Thư viện TQB).
 * Mọi ngưỡng thời gian, thông số zoom/pan, chuyển màu và phân loại sức khỏe phòng đọc
 * được quản lý tập trung tại đây để tránh hard-code rải rác trong UI component.
 */
export const ZOOM_CONFIG = {
  minScale: 1.0,
  maxScale: 8.0,
  wheelStep: 0.18,
  buttonStep: 0.35,
  minimapShowThreshold: 1.15,
  roomFitPaddingRatio: 1.14,
  /** Trần mật độ pixel/mét khi auto-fit phòng nhỏ để tránh phóng đại quá cỡ */
  maxAutoFitPxPerMeter: 48,
  clusterExpandScale: 2.0,
  clusterScaleStep: 0.65,
  overviewMaxScale: 1.25,
  intermediateMaxScale: 1.85,
} as const;

export const TIMING_CONFIG = {
  /** Thời gian chuyển màu mượt (ms), nằm trong chuẩn 300–600ms */
  transitionDurationMs: 450,
  /** Ngưỡng dữ liệu cũ (mặc định 5 phút = 300_000ms) */
  staleTelemetryMs: 5 * 60 * 1000,
  /** Ngưỡng cảnh báo tồn đọng lâu chưa xử lý (mặc định 15 phút = 900_000ms) */
  overdueAlertMs: 15 * 60 * 1000,
  /** Chu kỳ polling dự phòng khi mất kết nối STOMP (ms) */
  fallbackPollingMs: 15_000,
  /** Ngưỡng khung hình chậm (32ms ≈ <31 FPS) */
  lowFpsThresholdMs: 32,
  lowFpsConsecutiveFrames: 5,
  /** Chu kỳ nhịp sáng nhẹ cho vùng cảnh báo (ms) */
  alertPulsePeriodMs: 1800,
} as const;

export const SUMMARY_STATUS_THRESHOLDS = {
  goodMinScore: 75,
  attentionMinScore: 60,
} as const;

export const FLOORPLAN_INTERACTION_CONFIG = {
  minTouchTargetPx: 44,
  clusterRadiusPx: 28,
  clusterMaxScale: 1.55,
  viewportMarginPx: 8,
  dimmedRoomOpacity: 0.22,
} as const;

export const DEFAULT_FLOORPLAN_CONFIG = {
  defaultFloor: 3,
  defaultLayer: 'comfortScore' as HeatmapLayerMetric,
  defaultFurnitureOpacity: 0.65,
  gridSnapMeters: 0.25,
} as const;

export type ManagerRoomHealthStatus = 'GOOD' | 'ATTENTION' | 'POOR' | 'NO_DATA';

export type ManagerStatusFilter =
  | 'ALL'
  | 'ALERTS'
  | 'OVERDUE'
  | 'GOOD'
  | 'ATTENTION'
  | 'POOR';

export function resolveEffectiveWorkflowStatus(
  alert: Pick<AlertResponse, 'status' | 'workflowStatus'>
): 'NEW' | 'ACKNOWLEDGED' | 'IN_PROGRESS' | 'RESOLVED' {
  if (alert.workflowStatus) {
    return alert.workflowStatus;
  }
  if (alert.status === 'RESOLVED') return 'RESOLVED';
  if (alert.status === 'ACKNOWLEDGED') return 'ACKNOWLEDGED';
  return 'NEW';
}

export function isAlertOpen(
  alert: Pick<AlertResponse, 'status' | 'workflowStatus'>
): boolean {
  const wf = resolveEffectiveWorkflowStatus(alert);
  return alert.status !== 'RESOLVED' && wf !== 'RESOLVED';
}

export function isAlertActivelyBreaching(
  alert: Pick<AlertResponse, 'status' | 'workflowStatus' | 'sensorRecovered'>
): boolean {
  return isAlertOpen(alert) && alert.sensorRecovered !== true;
}

export function isAlertOverdue(
  alert: Pick<
    AlertResponse,
    'status' | 'workflowStatus' | 'startedAt' | 'assignedTo' | 'sensorRecovered'
  >,
  nowMs: number = Date.now(),
  overdueAlertMs: number = TIMING_CONFIG.overdueAlertMs
): boolean {
  if (!isAlertActivelyBreaching(alert)) return false;
  const wf = resolveEffectiveWorkflowStatus(alert);
  // Tồn đọng khi đang NEW (hoặc đã xác nhận nhưng chưa có người phụ trách và chưa IN_PROGRESS)
  const unhandled =
    wf === 'NEW' || (wf === 'ACKNOWLEDGED' && !alert.assignedTo);
  if (!unhandled) return false;
  const startedMs = Date.parse(alert.startedAt);
  if (!Number.isFinite(startedMs)) return false;
  return nowMs - startedMs >= overdueAlertMs;
}

export function classifyManagerRoomStatus(
  telemetry: TelemetryResponse | null | undefined,
  roomAlerts: readonly AlertResponse[] = [],
  thresholds: { goodMinScore: number; attentionMinScore: number } = SUMMARY_STATUS_THRESHOLDS
): ManagerRoomHealthStatus {
  const openAlerts = roomAlerts.filter(isAlertActivelyBreaching);
  const hasHighOrCritical = openAlerts.some(
    (a) => a.severity === 'HIGH' || a.severity === 'CRITICAL'
  );
  const hasLowOrMedium = openAlerts.some(
    (a) => a.severity === 'LOW' || a.severity === 'MEDIUM' || !a.severity
  );

  const score = telemetry?.comfortScore?.overall;
  const hasValidScore = typeof score === 'number' && Number.isFinite(score);

  if (
    hasHighOrCritical ||
    (hasValidScore && score < thresholds.attentionMinScore)
  ) {
    return 'POOR';
  }
  if (
    hasLowOrMedium ||
    (hasValidScore && score < thresholds.goodMinScore)
  ) {
    return 'ATTENTION';
  }
  if (hasValidScore && score >= thresholds.goodMinScore) {
    return 'GOOD';
  }
  return 'NO_DATA';
}

export function resolveRoomHealthMatchesFilter(
  room: Pick<RoomResponse, 'id'>,
  telemetry: TelemetryResponse | null | undefined,
  roomAlerts: readonly AlertResponse[],
  filter: ManagerStatusFilter,
  nowMs: number = Date.now(),
  overdueAlertMs: number = TIMING_CONFIG.overdueAlertMs
): boolean {
  if (filter === 'ALL') return true;
  const openAlerts = roomAlerts.filter(isAlertOpen);
  if (filter === 'ALERTS') {
    return openAlerts.length > 0;
  }
  if (filter === 'OVERDUE') {
    return openAlerts.some((a) => isAlertOverdue(a, nowMs, overdueAlertMs));
  }
  const health = classifyManagerRoomStatus(telemetry, openAlerts);
  return health === filter;
}
