import type { AlertResponse } from '@/types/api';

export interface QuickResolutionTagOption {
  readonly code: string;
  readonly labelVi: string;
  readonly defaultNoteVi: string;
}

export const NOISE_QUICK_TAGS: readonly QuickResolutionTagOption[] = [
  {
    code: 'REMINDED_QUIET',
    labelVi: 'Đã nhắc giữ trật tự',
    defaultNoteVi: 'Đã trực tiếp nhắc nhở nhóm bạn đọc giữ yên lặng tại cụm bàn.',
  },
  {
    code: 'MOVED_GROUP_F5',
    labelVi: 'Chuyển nhóm lên T5',
    defaultNoteVi: 'Đã hướng dẫn nhóm sinh viên có nhu cầu thảo luận chuyển lên phòng nhóm Tầng 5.',
  },
  {
    code: 'TRANSIENT_NOISE',
    labelVi: 'Tiếng động nhất thời',
    defaultNoteVi: 'Tiếng động ngắn (kéo ghế / di chuyển đồ đạc), phòng đọc đã ổn định.',
  },
];

export const AIR_QUICK_TAGS: readonly QuickResolutionTagOption[] = [
  {
    code: 'ADJUSTED_HVAC_BLINDS',
    labelVi: 'Chỉnh ĐHKK / Kéo rèm',
    defaultNoteVi: 'Đã điều chỉnh nhiệt độ điều hòa và kéo rèm chắn bức xạ nắng.',
  },
  {
    code: 'ENABLED_VENT_DEHUMIDIFIER',
    labelVi: 'Bật thông gió / Hút ẩm',
    defaultNoteVi: 'Đã tăng cấp khí tươi AHU / vận hành máy hút ẩm bảo quản.',
  },
  {
    code: 'HIGH_OCCUPANCY_LOCAL',
    labelVi: 'Đông bạn đọc cục bộ',
    defaultNoteVi: 'Mật độ bạn đọc tăng cao cục bộ giờ cao điểm, đã điều tiết thông thoáng.',
  },
];

export const DEVICE_QUICK_TAGS: readonly QuickResolutionTagOption[] = [
  {
    code: 'CHECKED_POWER_WIFI',
    labelVi: 'Đã kiểm tra nguồn / Wi-Fi',
    defaultNoteVi: 'Đã kiểm tra nguồn cấp 5V và kết nối Wi-Fi của trạm cảm biến.',
  },
  {
    code: 'ESCALATED_MAINTENANCE',
    labelVi: 'Báo Kỹ thuật bảo trì',
    defaultNoteVi: 'Đã bàn giao cho bộ phận Kỹ thuật kiểm tra phần cứng / hiệu chuẩn cảm biến.',
  },
  {
    code: 'TRANSIENT_NETWORK_RECOVERED',
    labelVi: 'Mạng tự hồi phục',
    defaultNoteVi: 'Kết nối mạng không dây chập chờn ngắn hạn và trạm đã hoạt động bình thường.',
  },
];

const ALL_TAGS_BY_CODE: ReadonlyMap<string, QuickResolutionTagOption> = new Map(
  [...NOISE_QUICK_TAGS, ...AIR_QUICK_TAGS, ...DEVICE_QUICK_TAGS].map((t) => [
    t.code,
    t,
  ])
);

export function resolveQuickTagsForAlert(
  alert: Pick<AlertResponse, 'type' | 'metricType'>
): readonly QuickResolutionTagOption[] {
  if (alert.type === 'NOISE_EXCEEDED') {
    return NOISE_QUICK_TAGS;
  }
  if (
    alert.type === 'DEVICE_OFFLINE' ||
    alert.type === 'SENSOR_MALFUNCTION' ||
    alert.metricType === 'DEVICE_OFFLINE' ||
    alert.metricType === 'SENSOR_MALFUNCTION'
  ) {
    return DEVICE_QUICK_TAGS;
  }
  return AIR_QUICK_TAGS;
}

export function resolveResolutionTagLabelVi(
  tagCode: string | null | undefined
): string | null {
  if (!tagCode) return null;
  if (tagCode === 'AUTO_STABILIZED') {
    return 'Tự ổn định sau tiếp nhận';
  }
  return ALL_TAGS_BY_CODE.get(tagCode)?.labelVi ?? tagCode;
}
