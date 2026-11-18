import { TIMING_CONFIG } from '@/config/floorplan-hmi.config';
import { formatRelativeTimeVi, isTelemetryStale } from '@/lib/format/datetime';
import { FLOORPLAN_I18N_VI } from '@/messages/vi';
import type {
  DeviceResponse,
  RoomResponse,
  TelemetryResponse,
} from '@/types/api';

export type DataReliabilityState =
  | 'MEASURED'
  | 'INTERPOLATED'
  | 'BLINDSPOT'
  | 'STALE';

export type ReliabilitySubKind =
  | 'MEASURED'
  | 'INTERPOLATED'
  | 'BLINDSPOT'
  | 'BLINDSPOT_OFFLINE'
  | 'REFERENCE_PRESET'
  | 'STALE';

export interface RoomReliabilityConfig {
  staleTelemetryMs?: number;
}

export interface RoomReliabilityEvaluationInput {
  room: Pick<RoomResponse, 'id' | 'code' | 'name'>;
  telemetry?: TelemetryResponse | null;
  devices?: readonly Pick<DeviceResponse, 'id' | 'online' | 'connectionState'>[];
  blindspotRatio?: number;
  nowMs?: number;
  config?: RoomReliabilityConfig;
}

export interface RoomReliabilitySummary {
  readonly state: DataReliabilityState;
  readonly subKind: ReliabilitySubKind;
  readonly badgeText: string;
  readonly qualityLabel: string;
  readonly tooltipText: string;
  readonly onlineDeviceCount: number;
  readonly totalDeviceCount: number;
  readonly blindspotRatio: number;
  readonly blindspotPercent: number;
  readonly isStale: boolean;
  readonly ageMinutes: number | null;
  readonly relativeTimeText: string;
  readonly isReferencePreset: boolean;
}

/**
 * Phân loại độ tin cậy cho từng điểm lưới không gian theo mức độ phủ cảm biến (`fieldPresence`):
 * - `>= 0.55`: Đo trực tiếp (`MEASURED`)
 * - `0.25 .. < 0.55`: Ước lượng từ cảm biến lân cận (`INTERPOLATED`)
 * - `< 0.25`: Vùng mù chưa có cảm biến (`BLINDSPOT`)
 */
export function classifyPixelReliability(
  fieldPresence: number,
  isStale: boolean,
  hasSensors: boolean
): DataReliabilityState {
  if (isStale) return 'STALE';
  if (!hasSensors || fieldPresence < 0.25) return 'BLINDSPOT';
  if (fieldPresence < 0.55) return 'INTERPOLATED';
  return 'MEASURED';
}

/**
 * Đánh giá độ tin cậy dữ liệu cấp phòng bằng ngôn ngữ nghiệp vụ cho Quản lý thư viện
 * (không sử dụng thuật ngữ kỹ thuật như Gaussian RBF / IDW / isSynthetic).
 */
export function evaluateRoomReliability({
  room,
  telemetry,
  devices = [],
  blindspotRatio,
  nowMs = Date.now(),
  config,
}: RoomReliabilityEvaluationInput): RoomReliabilitySummary {
  const staleMs = config?.staleTelemetryMs ?? TIMING_CONFIG.staleTelemetryMs;
  const totalDeviceCount = devices.length;
  const onlineDeviceCount = devices.filter(
    (d) => d.online || d.connectionState === 'ONLINE'
  ).length;
  const isReferencePreset =
    room.id.startsWith('PRESET_') || Boolean(telemetry?.isSynthetic);

  // 1. Phòng mẫu kiến trúc (Preset) chưa lắp cảm biến vật lý
  if (isReferencePreset && totalDeviceCount === 0) {
    const ratio =
      typeof blindspotRatio === 'number'
        ? Math.max(0, Math.min(1, blindspotRatio))
        : 1;
    return {
      state: 'BLINDSPOT',
      subKind: 'REFERENCE_PRESET',
      badgeText: FLOORPLAN_I18N_VI.reliability.REFERENCE_PRESET.badge,
      qualityLabel: FLOORPLAN_I18N_VI.reliability.REFERENCE_PRESET.quality,
      tooltipText: FLOORPLAN_I18N_VI.reliability.REFERENCE_PRESET.tooltip,
      onlineDeviceCount: 0,
      totalDeviceCount: 0,
      blindspotRatio: ratio,
      blindspotPercent: Math.round(ratio * 100),
      isStale: false,
      ageMinutes: null,
      relativeTimeText: 'Dữ liệu tham khảo',
      isReferencePreset: true,
    };
  }

  // 2. Phòng có gắn thiết bị nhưng toàn bộ đều OFFLINE
  if (totalDeviceCount > 0 && onlineDeviceCount === 0) {
    return {
      state: 'BLINDSPOT',
      subKind: 'BLINDSPOT_OFFLINE',
      badgeText: FLOORPLAN_I18N_VI.reliability.BLINDSPOT_OFFLINE.badge,
      qualityLabel: FLOORPLAN_I18N_VI.reliability.BLINDSPOT_OFFLINE.quality,
      tooltipText: FLOORPLAN_I18N_VI.reliability.BLINDSPOT_OFFLINE.tooltip,
      onlineDeviceCount: 0,
      totalDeviceCount,
      blindspotRatio: 1,
      blindspotPercent: 100,
      isStale: Boolean(
        telemetry?.timestamp &&
          isTelemetryStale(telemetry.timestamp, nowMs, false, staleMs)
      ),
      ageMinutes: null,
      relativeTimeText: telemetry?.timestamp
        ? formatRelativeTimeVi(telemetry.timestamp, nowMs)
        : FLOORPLAN_I18N_VI.reliability.BLINDSPOT_OFFLINE.badge,
      isReferencePreset: false,
    };
  }

  // 3. Không có cả bản tin telemetry lẫn trạm online
  if (!telemetry && onlineDeviceCount === 0) {
    return {
      state: 'BLINDSPOT',
      subKind: 'BLINDSPOT',
      badgeText: FLOORPLAN_I18N_VI.reliability.BLINDSPOT.badge,
      qualityLabel: FLOORPLAN_I18N_VI.reliability.BLINDSPOT.quality,
      tooltipText: FLOORPLAN_I18N_VI.reliability.BLINDSPOT.tooltip,
      onlineDeviceCount: 0,
      totalDeviceCount,
      blindspotRatio: 1,
      blindspotPercent: 100,
      isStale: false,
      ageMinutes: null,
      relativeTimeText: 'Chưa có dữ liệu',
      isReferencePreset: false,
    };
  }

  const relativeTimeText = telemetry?.timestamp
    ? formatRelativeTimeVi(telemetry.timestamp, nowMs)
    : 'Vừa xong';

  const parsedTs = telemetry?.timestamp ? Date.parse(telemetry.timestamp) : NaN;
  const ageMinutes = Number.isFinite(parsedTs)
    ? Math.max(0, Math.floor((nowMs - parsedTs) / 60_000))
    : null;

  const ratio =
    typeof blindspotRatio === 'number'
      ? Math.max(0, Math.min(1, blindspotRatio))
      : onlineDeviceCount > 0
        ? 0
        : 0.45;

  // 4. Dữ liệu cũ vượt quá ngưỡng thời gian cấu hình
  const stale = Boolean(
    telemetry?.timestamp &&
      isTelemetryStale(telemetry.timestamp, nowMs, false, staleMs)
  );
  if (stale) {
    const staleMinutesText =
      ageMinutes !== null && ageMinutes >= 1
        ? `${ageMinutes} phút trước`
        : relativeTimeText;
    return {
      state: 'STALE',
      subKind: 'STALE',
      badgeText: FLOORPLAN_I18N_VI.reliability.STALE.badge,
      qualityLabel: FLOORPLAN_I18N_VI.reliability.STALE.quality,
      tooltipText: `Cảm biến tại khu vực này chưa gửi số liệu mới (${staleMinutesText}). Đang hiển thị số đo gần nhất.`,
      onlineDeviceCount,
      totalDeviceCount,
      blindspotRatio: ratio,
      blindspotPercent: Math.round(ratio * 100),
      isStale: true,
      ageMinutes,
      relativeTimeText,
      isReferencePreset: false,
    };
  }

  // 5. Vùng mù lớn (>= 65% không gian phòng không có độ phủ trực tiếp)
  if (ratio >= 0.65) {
    return {
      state: 'BLINDSPOT',
      subKind: 'BLINDSPOT',
      badgeText: FLOORPLAN_I18N_VI.reliability.BLINDSPOT.badge,
      qualityLabel: FLOORPLAN_I18N_VI.reliability.BLINDSPOT.quality,
      tooltipText: FLOORPLAN_I18N_VI.reliability.BLINDSPOT.tooltip,
      onlineDeviceCount,
      totalDeviceCount,
      blindspotRatio: ratio,
      blindspotPercent: Math.round(ratio * 100),
      isStale: false,
      ageMinutes,
      relativeTimeText,
      isReferencePreset: false,
    };
  }

  // 6. Đo trực tiếp (>= 1 trạm ONLINE, bản tin mới, vùng phủ tốt)
  if (onlineDeviceCount > 0 && ratio < 0.35) {
    return {
      state: 'MEASURED',
      subKind: 'MEASURED',
      badgeText: FLOORPLAN_I18N_VI.reliability.MEASURED.badge,
      qualityLabel: FLOORPLAN_I18N_VI.reliability.MEASURED.quality,
      tooltipText: `Số liệu đo trực tiếp từ ${onlineDeviceCount}/${Math.max(1, totalDeviceCount)} cảm biến đang hoạt động trong phòng (cập nhật ${relativeTimeText}).`,
      onlineDeviceCount,
      totalDeviceCount,
      blindspotRatio: ratio,
      blindspotPercent: Math.round(ratio * 100),
      isStale: false,
      ageMinutes,
      relativeTimeText,
      isReferencePreset: false,
    };
  }

  // 7. Ước lượng từ cảm biến lân cận hoặc chỉ có số liệu tổng hợp phòng
  return {
    state: 'INTERPOLATED',
    subKind: 'INTERPOLATED',
    badgeText: FLOORPLAN_I18N_VI.reliability.INTERPOLATED.badge,
    qualityLabel: FLOORPLAN_I18N_VI.reliability.INTERPOLATED.quality,
    tooltipText: `${FLOORPLAN_I18N_VI.reliability.INTERPOLATED.tooltip} (Cập nhật ${relativeTimeText}).`,
    onlineDeviceCount,
    totalDeviceCount,
    blindspotRatio: ratio,
    blindspotPercent: Math.round(ratio * 100),
    isStale: false,
    ageMinutes,
    relativeTimeText,
    isReferencePreset: false,
  };
}
