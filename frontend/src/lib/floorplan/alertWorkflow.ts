import {
  TIMING_CONFIG,
  isAlertOpen,
  isAlertOverdue,
  resolveEffectiveWorkflowStatus,
} from '@/config/floorplan-hmi.config';
import { TQB_ROOM_PRESETS } from '@/config/tqb-floorplan-presets';
import { formatBottleneckReasonVi } from '@/lib/format/metrics';
import { FLOORPLAN_I18N_VI } from '@/messages/vi';
import type {
  AlertResponse,
  AlertSeverity,
  AlertWorkflowStatus,
  RoomResponse,
} from '@/types/api';

export const ALERT_SEVERITY_RANK: Record<AlertSeverity, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
};

export const ALERT_SEVERITY_LABEL_VI: Record<AlertSeverity, string> = {
  CRITICAL: FLOORPLAN_I18N_VI.summary.severityLabels.CRITICAL,
  HIGH: FLOORPLAN_I18N_VI.summary.severityLabels.HIGH,
  MEDIUM: FLOORPLAN_I18N_VI.summary.severityLabels.MEDIUM,
  LOW: FLOORPLAN_I18N_VI.summary.severityLabels.LOW,
};

export const WORKFLOW_STEPS: ReadonlyArray<{
  status: AlertWorkflowStatus;
  labelVi: string;
}> = [
  { status: 'NEW', labelVi: FLOORPLAN_I18N_VI.alerts.workflowLabels.NEW },
  {
    status: 'ACKNOWLEDGED',
    labelVi: FLOORPLAN_I18N_VI.alerts.workflowLabels.ACKNOWLEDGED,
  },
  {
    status: 'IN_PROGRESS',
    labelVi: FLOORPLAN_I18N_VI.alerts.workflowLabels.IN_PROGRESS,
  },
  {
    status: 'RESOLVED',
    labelVi: FLOORPLAN_I18N_VI.alerts.workflowLabels.RESOLVED,
  },
];

export const WORKFLOW_STEP_INDEX: Record<AlertWorkflowStatus, number> = {
  NEW: 0,
  ACKNOWLEDGED: 1,
  IN_PROGRESS: 2,
  RESOLVED: 3,
};

export interface AlertAgeInfo {
  elapsedMs: number;
  minutes: number;
  durationText: string;
}

export function formatAlertAgeVi(
  startedAt: string | null | undefined,
  nowMs: number = Date.now()
): AlertAgeInfo {
  const startedMs = startedAt ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(startedMs)) {
    return {
      elapsedMs: 0,
      minutes: 0,
      durationText: 'Vừa phát sinh',
    };
  }
  const elapsedMs = Math.max(0, nowMs - startedMs);
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) {
    return { elapsedMs, minutes: 0, durationText: 'Vừa phát sinh' };
  }
  if (minutes < 60) {
    return { elapsedMs, minutes, durationText: `${minutes} phút` };
  }
  const hours = Math.floor(minutes / 60);
  const remMins = minutes % 60;
  return {
    elapsedMs,
    minutes,
    durationText: remMins > 0 ? `${hours} giờ ${remMins} phút` : `${hours} giờ`,
  };
}

export interface ManagerAlertSummary {
  headlineVi: string;
  detailVi: string;
}

export function summarizeAlertForManagerVi(
  alert: AlertResponse,
  room?: Pick<RoomResponse, 'code' | 'name' | 'floor' | 'type'> | null
): ManagerAlertSummary {
  const localizedRaw = formatBottleneckReasonVi(alert.message);
  const msg = alert.message ?? '';
  const lower = msg.toLowerCase();
  const roomDisplay = room
    ? `${room.code} — ${room.name}${room.floor ? ` (Tầng ${room.floor})` : ''}`
    : alert.roomId
      ? `Phòng ${alert.roomId}`
      : 'Khu vực giám sát';

  const valMatch = msg.match(/(-?\d+(?:\.\d+)?)\s*(dBA|°C|%RH|µg\/m³|ug\/m3|lux|dBm)/i);
  const measuredSnippet = valMatch ? ` (${valMatch[1]} ${valMatch[2]})` : '';

  let headlineVi = localizedRaw || 'Phát sinh cảnh báo vận hành tại phòng đọc';
  if (alert.type === 'DEVICE_OFFLINE') {
    headlineVi = `Trạm cảm biến ${alert.hardwareId ?? ''} tại ${roomDisplay} mất kết nối — Cần kiểm tra nguồn/mạng`;
  } else if (alert.type === 'SENSOR_MALFUNCTION') {
    headlineVi = `Cảm biến ${alert.hardwareId ?? ''} tại ${roomDisplay} gửi số liệu bất thường — Cần kiểm tra thiết bị`;
  } else if (alert.type === 'NOISE_EXCEEDED' || lower.includes('noise') || lower.includes('ồn')) {
    headlineVi = `Độ ồn tại ${roomDisplay} đang vượt ngưỡng cho phép${measuredSnippet} — Cần nhắc nhở độc giả giữ trật tự`;
  } else if (alert.type === 'AIR_UNHEALTHY') {
    if (lower.includes('humidity') || lower.includes('%rh') || lower.includes('ẩm')) {
      headlineVi = `Độ ẩm tại ${roomDisplay} vượt ngưỡng bảo quản${measuredSnippet} — Nguy cơ ảnh hưởng tài liệu/tiện nghi`;
    } else if (lower.includes('temperature') || lower.includes('°c') || lower.includes('nhiệt')) {
      headlineVi = `Nhiệt độ tại ${roomDisplay} vượt mức thoải mái${measuredSnippet} — Cần điều chỉnh làm mát`;
    } else {
      headlineVi = `Chất lượng không khí / bụi mịn tại ${roomDisplay} tăng cao${measuredSnippet} — Cần tăng thông gió`;
    }
  }

  return {
    headlineVi,
    detailVi: localizedRaw || msg || headlineVi,
  };
}

export function sortAlertsByOperationalPriority(
  alerts: readonly AlertResponse[],
  nowMs: number = Date.now(),
  overdueAlertMs: number = TIMING_CONFIG.overdueAlertMs
): AlertResponse[] {
  return [...alerts].sort((a, b) => {
    const aOverdue = isAlertOverdue(a, nowMs, overdueAlertMs) ? 1 : 0;
    const bOverdue = isAlertOverdue(b, nowMs, overdueAlertMs) ? 1 : 0;
    if (aOverdue !== bOverdue) return bOverdue - aOverdue;

    const aSev = a.severity ? (ALERT_SEVERITY_RANK[a.severity] ?? 0) : 0;
    const bSev = b.severity ? (ALERT_SEVERITY_RANK[b.severity] ?? 0) : 0;
    if (aSev !== bSev) return bSev - aSev;

    const aMs = Date.parse(a.startedAt);
    const bMs = Date.parse(b.startedAt);
    return (Number.isFinite(bMs) ? bMs : 0) - (Number.isFinite(aMs) ? aMs : 0);
  });
}

export interface RoomAlertGroup {
  groupKey: string;
  roomId: string | null;
  roomCode: string;
  shortRoomCode: string;
  roomName: string;
  floor: number | null;
  room: RoomResponse | null;
  alerts: AlertResponse[];
  highestSeverity: AlertSeverity;
  hasOverdue: boolean;
  maxOverdueMinutes: number;
  unacknowledgedCount: number;
  newestStartedAtMs: number;
}

export function groupAlertsByRoom(
  alerts: readonly AlertResponse[],
  rooms: readonly RoomResponse[],
  nowMs: number = Date.now(),
  overdueAlertMs: number = TIMING_CONFIG.overdueAlertMs
): RoomAlertGroup[] {
  const roomById = new Map<string, RoomResponse>();
  for (const r of rooms) {
    roomById.set(r.id, r);
  }

  const buckets = new Map<string, AlertResponse[]>();
  for (const alert of alerts) {
    if (!isAlertOpen(alert)) continue;
    const key = alert.roomId ?? '__UNASSIGNED__';
    const arr = buckets.get(key) ?? [];
    arr.push(alert);
    buckets.set(key, arr);
  }

  const groups: RoomAlertGroup[] = [];
  for (const [groupKey, list] of buckets.entries()) {
    const roomId = groupKey === '__UNASSIGNED__' ? null : groupKey;
    const room = roomId ? roomById.get(roomId) ?? null : null;
    const presetFallback =
      !room && roomId
        ? TQB_ROOM_PRESETS.find((p) => `PRESET_${p.code}` === roomId) ?? null
        : null;

    const sorted = sortAlertsByOperationalPriority(list, nowMs, overdueAlertMs);
    let highestSeverity: AlertSeverity = 'LOW';
    let highestRank = 0;
    let hasOverdue = false;
    let maxOverdueMinutes = 0;
    let unacknowledgedCount = 0;
    let newestStartedAtMs = 0;

    for (const alert of sorted) {
      const sev = alert.severity ?? 'MEDIUM';
      const rank = ALERT_SEVERITY_RANK[sev] ?? 0;
      if (rank > highestRank) {
        highestRank = rank;
        highestSeverity = sev;
      }
      if (isAlertOverdue(alert, nowMs, overdueAlertMs)) {
        hasOverdue = true;
        const age = formatAlertAgeVi(alert.startedAt, nowMs);
        if (age.minutes > maxOverdueMinutes) {
          maxOverdueMinutes = age.minutes;
        }
      }
      if (resolveEffectiveWorkflowStatus(alert) === 'NEW') {
        unacknowledgedCount += 1;
      }
      const startedMs = Date.parse(alert.startedAt);
      if (Number.isFinite(startedMs) && startedMs > newestStartedAtMs) {
        newestStartedAtMs = startedMs;
      }
    }

    const rawCode = room?.code ?? presetFallback?.code ?? roomId ?? 'CHƯA RÕ';
    groups.push({
      groupKey,
      roomId,
      roomCode: rawCode,
      shortRoomCode: rawCode.replace(/^TQB_/, 'P.'),
      roomName:
        room?.name ??
        presetFallback?.name ??
        (roomId ? `Phòng ${roomId}` : 'Khu vực chung'),
      floor:
        room?.floor != null
          ? room.floor === 0
            ? 1
            : room.floor
          : presetFallback?.floor ?? null,
      room,
      alerts: sorted,
      highestSeverity,
      hasOverdue,
      maxOverdueMinutes,
      unacknowledgedCount,
      newestStartedAtMs,
    });
  }

  return groups.sort((a, b) => {
    if (a.hasOverdue !== b.hasOverdue) return b.hasOverdue ? 1 : -1;
    const sevDiff =
      (ALERT_SEVERITY_RANK[b.highestSeverity] ?? 0) -
      (ALERT_SEVERITY_RANK[a.highestSeverity] ?? 0);
    if (sevDiff !== 0) return sevDiff;
    return b.newestStartedAtMs - a.newestStartedAtMs;
  });
}

export function formatRealtimeAlertAnnouncementVi(
  alert: AlertResponse,
  rooms: readonly RoomResponse[]
): string {
  const room = alert.roomId
    ? rooms.find((r) => r.id === alert.roomId) ?? null
    : null;
  const sevLabel = alert.severity
    ? ALERT_SEVERITY_LABEL_VI[alert.severity]
    : 'Lưu ý';
  const summary = summarizeAlertForManagerVi(alert, room);
  const location = room
    ? `${room.code} ${room.name}${room.floor ? `, Tầng ${room.floor}` : ''}`
    : alert.roomId ?? 'Thư viện Tạ Quang Bửu';
  return `Cảnh báo mới mức ${sevLabel} tại ${location}: ${summary.headlineVi}`;
}
