import {
  classifyManagerRoomStatus,
  isAlertOpen,
  type ManagerRoomHealthStatus,
} from '@/config/floorplan-hmi.config';
import { FLOORPLAN_I18N_VI } from '@/messages/vi';
import type {
  AlertResponse,
  AlertSeverity,
  RoomResponse,
  TelemetryResponse,
} from '@/types/api';

const SEVERITY_RANK: Record<AlertSeverity, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
};

const HEALTH_WORST_RANK: Record<ManagerRoomHealthStatus, number> = {
  POOR: 3,
  ATTENTION: 2,
  GOOD: 1,
  NO_DATA: 0,
};

export interface FloorTreeRoomNode {
  readonly key: string;
  readonly id: string;
  readonly code: string;
  readonly shortCode: string;
  readonly name: string;
  readonly floor: number;
  readonly room: RoomResponse;
  readonly comfortScore: number | null;
  readonly statusLevel: ManagerRoomHealthStatus;
  readonly symbol: '●' | '▲' | '◆' | '○';
  readonly colorHex: string;
  readonly textColorClass: string;
  readonly openAlertsCount: number;
  readonly highestAlertSeverity: AlertSeverity | null;
  readonly isSynthetic: boolean;
}

export interface FloorTreeFloorNode {
  readonly key: string;
  readonly floor: number;
  readonly label: string;
  readonly rooms: FloorTreeRoomNode[];
  readonly totalRooms: number;
  readonly avgComfortScore: number | null;
  readonly worstStatusLevel: ManagerRoomHealthStatus;
  readonly symbol: '●' | '▲' | '◆' | '○';
  readonly colorHex: string;
  readonly textColorClass: string;
  readonly totalOpenAlerts: number;
  readonly highestAlertSeverity: AlertSeverity | null;
}

export function normalizeVietnameseForSearch(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .trim();
}

export function getRoomHealthBadgeStyle(status: ManagerRoomHealthStatus): {
  symbol: '●' | '▲' | '◆' | '○';
  colorHex: string;
  textColorClass: string;
  dotBgClass: string;
  labelVi: string;
} {
  switch (status) {
    case 'GOOD':
      return {
        symbol: '●',
        colorHex: '#10B981',
        textColorClass: 'text-emerald-700',
        dotBgClass: 'bg-emerald-600',
        labelVi: FLOORPLAN_I18N_VI.summary.good,
      };
    case 'ATTENTION':
      return {
        symbol: '▲',
        colorHex: '#F59E0B',
        textColorClass: 'text-amber-700',
        dotBgClass: 'bg-amber-500',
        labelVi: FLOORPLAN_I18N_VI.summary.attention,
      };
    case 'POOR':
      return {
        symbol: '◆',
        colorHex: '#EF4444',
        textColorClass: 'text-red-700',
        dotBgClass: 'bg-red-600',
        labelVi: FLOORPLAN_I18N_VI.summary.poor,
      };
    default:
      return {
        symbol: '○',
        colorHex: '#64748B',
        textColorClass: 'text-slate-600',
        dotBgClass: 'bg-slate-400',
        labelVi: 'Chưa có dữ liệu',
      };
  }
}

function resolveHighestSeverity(
  alerts: readonly AlertResponse[]
): AlertSeverity | null {
  let highest: AlertSeverity | null = null;
  for (const a of alerts) {
    if (!a.severity) continue;
    if (!highest || SEVERITY_RANK[a.severity] > SEVERITY_RANK[highest]) {
      highest = a.severity;
    }
  }
  return highest;
}

/**
 * Xây dựng cây điều hướng động Tầng -> Phòng từ dữ liệu API/cấu hình (không hard-code tầng/phòng).
 * Tự động tổng hợp điểm LCS trung bình, trạng thái xấu nhất và tổng số cảnh báo từ phòng con lên node tầng.
 */
export function buildBuildingFloorTree(
  rooms: readonly RoomResponse[],
  telemetryMap: Record<string, TelemetryResponse | null | undefined>,
  alerts: readonly AlertResponse[] = []
): FloorTreeFloorNode[] {
  const openAlertsByRoom = new Map<string, AlertResponse[]>();
  for (const alert of alerts) {
    if (!isAlertOpen(alert) || !alert.roomId) continue;
    const list = openAlertsByRoom.get(alert.roomId) ?? [];
    list.push(alert);
    openAlertsByRoom.set(alert.roomId, list);
  }

  const uniqueRooms = new Map<string, RoomResponse>();
  for (const r of rooms) {
    if (!uniqueRooms.has(r.id)) {
      uniqueRooms.set(r.id, r);
    }
  }

  const floorBuckets = new Map<number, FloorTreeRoomNode[]>();

  for (const room of uniqueRooms.values()) {
    const floorNum = room.floor === 0 ? 1 : room.floor;
    const tel = telemetryMap[room.id];
    const roomAlerts = openAlertsByRoom.get(room.id) ?? [];
    const statusLevel = classifyManagerRoomStatus(tel, roomAlerts);
    const badgeStyle = getRoomHealthBadgeStyle(statusLevel);
    const rawScore = tel?.comfortScore?.overall;
    const comfortScore =
      typeof rawScore === 'number' && Number.isFinite(rawScore)
        ? Math.round(rawScore)
        : null;
    const shortCode = room.code.replace(/^TQB_/, 'P.');

    const roomNode: FloorTreeRoomNode = {
      key: `room:${room.id}`,
      id: room.id,
      code: room.code,
      shortCode,
      name: room.name,
      floor: floorNum,
      room,
      comfortScore,
      statusLevel,
      symbol: badgeStyle.symbol,
      colorHex: badgeStyle.colorHex,
      textColorClass: badgeStyle.textColorClass,
      openAlertsCount: roomAlerts.length,
      highestAlertSeverity: resolveHighestSeverity(roomAlerts),
      isSynthetic: room.id.startsWith('PRESET_') || Boolean(tel?.isSynthetic),
    };

    const existingList = floorBuckets.get(floorNum) ?? [];
    existingList.push(roomNode);
    floorBuckets.set(floorNum, existingList);
  }

  const sortedFloors = Array.from(floorBuckets.keys()).sort((a, b) => a - b);

  return sortedFloors.map((floorNum) => {
    const childRooms = (floorBuckets.get(floorNum) ?? []).slice().sort((a, b) =>
      a.code.localeCompare(b.code, undefined, { numeric: true })
    );

    let totalOpenAlerts = 0;
    let highestAlertSeverity: AlertSeverity | null = null;
    let worstStatusLevel: ManagerRoomHealthStatus = 'NO_DATA';
    let scoreSum = 0;
    let scoreCount = 0;

    for (const r of childRooms) {
      totalOpenAlerts += r.openAlertsCount;
      if (
        r.highestAlertSeverity &&
        (!highestAlertSeverity ||
          SEVERITY_RANK[r.highestAlertSeverity] >
            SEVERITY_RANK[highestAlertSeverity])
      ) {
        highestAlertSeverity = r.highestAlertSeverity;
      }
      if (HEALTH_WORST_RANK[r.statusLevel] > HEALTH_WORST_RANK[worstStatusLevel]) {
        worstStatusLevel = r.statusLevel;
      }
      if (r.comfortScore !== null) {
        scoreSum += r.comfortScore;
        scoreCount += 1;
      }
    }

    const avgComfortScore =
      scoreCount > 0 ? Math.round(scoreSum / scoreCount) : null;
    const worstStyle = getRoomHealthBadgeStyle(worstStatusLevel);

    return {
      key: `floor:${floorNum}`,
      floor: floorNum,
      label: `${FLOORPLAN_I18N_VI.tree.floorPrefix} ${floorNum}`,
      rooms: childRooms,
      totalRooms: childRooms.length,
      avgComfortScore,
      worstStatusLevel,
      symbol: worstStyle.symbol,
      colorHex: worstStyle.colorHex,
      textColorClass: worstStyle.textColorClass,
      totalOpenAlerts,
      highestAlertSeverity,
    };
  });
}

export function filterBuildingFloorTree(
  treeNodes: readonly FloorTreeFloorNode[],
  searchQuery: string,
  onlyAlerts: boolean
): FloorTreeFloorNode[] {
  const normQuery = normalizeVietnameseForSearch(searchQuery);
  const queryTokens = normQuery ? normQuery.split(/\s+/).filter(Boolean) : [];
  if (queryTokens.length === 0 && !onlyAlerts) {
    return [...treeNodes];
  }

  const result: FloorTreeFloorNode[] = [];

  for (const floorNode of treeNodes) {
    const matchingRooms = floorNode.rooms.filter((room) => {
      if (onlyAlerts && room.openAlertsCount <= 0) {
        return false;
      }
      if (queryTokens.length === 0) return true;
      const haystack = normalizeVietnameseForSearch(
        `${room.code} ${room.shortCode} ${room.name} ${floorNode.label} tang ${floorNode.floor}`
      );
      return queryTokens.every((token) => haystack.includes(token));
    });

    if (matchingRooms.length > 0) {
      result.push({
        ...floorNode,
        rooms: matchingRooms,
      });
    }
  }

  return result;
}
