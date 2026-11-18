import type { HeatmapLayerMetric } from '@/config/thresholds';
import type { Point2D, RoomThresholdConfig, RoomType } from '@/types/api';
import { type IdwSamplePoint } from './idw';
import {
  computePolygonSignedArea,
  isPointInPolygon,
} from './polygon';

export interface ColorStop {
  val: number;
  r: number;
  g: number;
  b: number;
  a: number;
  label?: string;
}

/**
 * Thang màu chuẩn HMI ISA-101 & An toàn mù màu (Deuteranopia / Protanopia):
 * - Vùng đạt chuẩn sử dụng tông Teal/Sky-Blue dịu với độ mờ vừa phải (0.58–0.62) tránh mỏi mắt.
 * - Vùng Lưu ý / Vượt ngưỡng sử dụng chuyển bậc đơn điệu độ sáng & bão hòa cao:
 *   Vàng sáng (#FACC15, L≈0.64) -> Cam (#EA580C, L≈0.24) -> Đỏ (#DC2626) -> Đỏ thẫm (#991B1B, L≈0.08).
 */
export const WEATHER_PALETTES: Record<HeatmapLayerMetric, ColorStop[]> = {
  temperature: [
    { val: 18.5, r: 30, g: 64, b: 175, a: 0.86, label: '≤ 18.5°C Rất lạnh' },
    { val: 21.0, r: 12, g: 74, b: 130, a: 0.58, label: '21.0°C Mát (Chuẩn)' },
    { val: 23.5, r: 14, g: 116, b: 144, a: 0.56, label: '23.5°C Lý tưởng' },
    { val: 26.5, r: 250, g: 204, b: 21, a: 0.90, label: '26.5°C Ấm (Lưu ý)' },
    { val: 29.0, r: 249, g: 115, b: 22, a: 0.94, label: '29.0°C Nóng' },
    { val: 32.0, r: 244, g: 67, b: 54, a: 0.97, label: '≥ 32.0°C Quá nóng' },
  ],
  noiseAvg: [
    { val: 36.0, r: 29, g: 78, b: 216, a: 0.56, label: '≤ 36 dBA Rất yên tĩnh' },
    { val: 42.0, r: 12, g: 74, b: 130, a: 0.58, label: '42 dBA Thì thầm' },
    { val: 48.0, r: 14, g: 116, b: 144, a: 0.60, label: '48 dBA Chuẩn học' },
    { val: 55.0, r: 250, g: 204, b: 21, a: 0.90, label: '55 dBA Xao nhãng' },
    { val: 62.0, r: 249, g: 115, b: 22, a: 0.94, label: '62 dBA Ồn' },
    { val: 68.0, r: 239, g: 68, b: 68, a: 0.96, label: '68 dBA Vượt ngưỡng' },
    { val: 75.0, r: 244, g: 67, b: 54, a: 0.98, label: '≥ 75 dBA Khẩn cấp' },
  ],
  pm2_5: [
    { val: 8.0, r: 12, g: 74, b: 130, a: 0.56, label: '≤ 8 Trong lành' },
    { val: 15.0, r: 14, g: 116, b: 144, a: 0.58, label: '15 Đạt chuẩn sạch' },
    { val: 25.0, r: 250, g: 204, b: 21, a: 0.90, label: '25 Lưu ý' },
    { val: 40.0, r: 249, g: 115, b: 22, a: 0.94, label: '40 Hơi bí khí' },
    { val: 55.0, r: 244, g: 67, b: 54, a: 0.97, label: '≥ 55 Bụi cao' },
  ],
  comfortScore: [
    { val: 40.0, r: 244, g: 67, b: 54, a: 0.97, label: '< 45 Cảnh báo' },
    { val: 55.0, r: 249, g: 115, b: 22, a: 0.94, label: '55 Kém' },
    { val: 65.0, r: 250, g: 204, b: 21, a: 0.91, label: '65 Lưu ý' },
    { val: 76.0, r: 14, g: 116, b: 144, a: 0.60, label: '76 Khá tốt' },
    { val: 88.0, r: 12, g: 74, b: 130, a: 0.58, label: '88 Tốt' },
    { val: 98.0, r: 30, g: 64, b: 175, a: 0.56, label: '≥ 98 Tối ưu' },
  ],
  humidity: [
    { val: 32.0, r: 250, g: 204, b: 21, a: 0.90, label: '≤ 32% Khô hanh' },
    { val: 46.0, r: 12, g: 74, b: 130, a: 0.58, label: '46% Thoáng khô' },
    { val: 53.0, r: 14, g: 116, b: 144, a: 0.56, label: '53% Chuẩn bảo quản' },
    { val: 60.0, r: 250, g: 204, b: 21, a: 0.91, label: '60% Ngưỡng Kho sách' },
    { val: 68.0, r: 249, g: 115, b: 22, a: 0.95, label: '68% Ẩm cao' },
    { val: 75.0, r: 244, g: 67, b: 54, a: 0.97, label: '≥ 75% Nguy cơ mốc' },
  ],
  lux: [
    { val: 120.0, r: 249, g: 115, b: 22, a: 0.92, label: '≤ 120 lx Thiếu sáng' },
    { val: 240.0, r: 12, g: 74, b: 130, a: 0.58, label: '240 lx Dịu nhẹ' },
    { val: 400.0, r: 14, g: 116, b: 144, a: 0.56, label: '400 lx Chuẩn đọc' },
    { val: 650.0, r: 250, g: 204, b: 21, a: 0.90, label: '650 lx Nắng cửa sổ' },
    { val: 850.0, r: 244, g: 67, b: 54, a: 0.96, label: '≥ 850 lx Chói gắt' },
  ],
  wifiRssi: [
    { val: -84.0, r: 244, g: 67, b: 54, a: 0.96, label: '≤ -84 dBm Mất sóng' },
    { val: -75.0, r: 249, g: 115, b: 22, a: 0.93, label: '-75 dBm Yếu' },
    { val: -67.0, r: 250, g: 204, b: 21, a: 0.90, label: '-67 dBm Trung bình' },
    { val: -58.0, r: 14, g: 116, b: 144, a: 0.58, label: '-58 dBm Sóng tốt' },
    { val: -46.0, r: 12, g: 74, b: 130, a: 0.56, label: '≥ -46 dBm Rất mạnh' },
  ],
};

export type MetricStatusLevel = 'NORMAL' | 'WARNING' | 'CRITICAL' | 'NO_DATA';
export type MetricStatusGeometricSymbol = '●' | '▲' | '◆' | '○';

export interface MetricStatusEvaluation {
  readonly level: MetricStatusLevel;
  readonly symbol: MetricStatusGeometricSymbol;
  readonly labelVi: string;
  readonly isExceedingThreshold: boolean;
  readonly thresholdSummaryVi: string;
  readonly sopRecommendationVi: string;
}

export interface MetricLayerDisplayMeta {
  readonly key: HeatmapLayerMetric;
  readonly label: string;
  readonly shortLabel: string;
  readonly unitLabel: string;
  readonly normalRangeVi: string;
  readonly attentionThresholdVi: string;
  readonly criticalThresholdVi: string;
  readonly storageNoteVi?: string;
}

export const METRIC_LAYER_META: Record<HeatmapLayerMetric, MetricLayerDisplayMeta> = {
  comfortScore: {
    key: 'comfortScore',
    label: 'Điểm tiện nghi (LCS)',
    shortLabel: 'Tiện nghi (LCS)',
    unitLabel: '0–100',
    normalRangeVi: '≥ 75đ (Tốt)',
    attentionThresholdVi: '60–74đ (Lưu ý)',
    criticalThresholdVi: '< 60đ (Cảnh báo)',
  },
  noiseAvg: {
    key: 'noiseAvg',
    label: 'Độ ồn TB (LAeq)',
    shortLabel: 'Độ ồn',
    unitLabel: 'dBA',
    normalRangeVi: '< 50 dBA',
    attentionThresholdVi: '50–64 dBA',
    criticalThresholdVi: '≥ 65 dBA',
  },
  temperature: {
    key: 'temperature',
    label: 'Nhiệt độ phòng',
    shortLabel: 'Nhiệt độ',
    unitLabel: '°C',
    normalRangeVi: '20.0–25.9°C',
    attentionThresholdVi: '26.0–31.9°C / < 20°C',
    criticalThresholdVi: '≥ 32.0°C',
  },
  humidity: {
    key: 'humidity',
    label: 'Độ ẩm không khí',
    shortLabel: 'Độ ẩm',
    unitLabel: '%RH',
    normalRangeVi: '40–60%RH',
    attentionThresholdVi: 'Kho sách ≥ 58%RH',
    criticalThresholdVi: 'Kho sách > 60%RH / > 75%RH',
    storageNoteVi: 'Kho sách áp dụng ngưỡng bảo quản nghiêm ngặt ≤ 60%RH',
  },
  lux: {
    key: 'lux',
    label: 'Độ rọi sáng',
    shortLabel: 'Ánh sáng',
    unitLabel: 'lx',
    normalRangeVi: '240–650 lx',
    attentionThresholdVi: '< 200 hoặc > 650 lx',
    criticalThresholdVi: '< 120 hoặc ≥ 850 lx',
  },
  pm2_5: {
    key: 'pm2_5',
    label: 'Bụi mịn PM2.5',
    shortLabel: 'PM2.5',
    unitLabel: 'µg/m³',
    normalRangeVi: '< 25 µg/m³',
    attentionThresholdVi: '25–49 µg/m³',
    criticalThresholdVi: '≥ 50 µg/m³',
  },
  wifiRssi: {
    key: 'wifiRssi',
    label: 'Sóng Wi-Fi (RSSI)',
    shortLabel: 'Wi-Fi RSSI',
    unitLabel: 'dBm',
    normalRangeVi: '≥ -67 dBm',
    attentionThresholdVi: '-68 đến -75 dBm',
    criticalThresholdVi: '< -75 dBm',
  },
};

export function getMetricStatusSymbol(
  layer: HeatmapLayerMetric,
  value: number | null | undefined,
  roomType: RoomType = 'STUDY_ROOM',
  roomThresholds?: RoomThresholdConfig | null
): MetricStatusEvaluation {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return {
      level: 'NO_DATA',
      symbol: '○',
      labelVi: 'Chưa có dữ liệu',
      isExceedingThreshold: false,
      thresholdSummaryVi: METRIC_LAYER_META[layer].normalRangeVi,
      sopRecommendationVi: 'Kiểm tra trạng thái trạm cảm biến trong phòng.',
    };
  }

  let level: 'NORMAL' | 'WARNING' | 'CRITICAL' = 'NORMAL';
  let labelVi = 'Đạt chuẩn';
  let thresholdSummaryVi = METRIC_LAYER_META[layer].normalRangeVi;
  let sopRecommendationVi = 'Duy trì chế độ vận hành hiện tại.';

  switch (layer) {
    case 'comfortScore': {
      if (value < 60) {
        level = 'CRITICAL';
        labelVi = 'Vượt ngưỡng tiện nghi (< 60đ)';
        sopRecommendationVi =
          'Kiểm tra chỉ số gây giảm điểm (Độ ồn, Nhiệt độ, Độ ẩm hoặc Bụi PM2.5) và cử nhân sự hỗ trợ ngay.';
      } else if (value < 75) {
        level = 'WARNING';
        labelVi = 'Cần lưu ý (60–74đ)';
        sopRecommendationVi =
          'Theo dõi biến động môi trường trong phòng và kiểm tra hệ thống điều hòa/trật tự.';
      } else {
        labelVi = 'Tiện nghi tốt (≥ 75đ)';
      }
      thresholdSummaryVi = 'Mục tiêu: ≥ 75đ';
      break;
    }
    case 'noiseAvg': {
      const critMax =
        roomThresholds?.noiseAvgMax ??
        (roomType === 'CIRCULATION_HALL' ? 70 : 65);
      const warnMax = roomType === 'CIRCULATION_HALL' ? 60 : 50;
      thresholdSummaryVi = `Chuẩn ${roomType === 'CIRCULATION_HALL' ? 'Sảnh' : 'Phòng đọc'}: < ${warnMax} dBA`;
      if (value >= critMax) {
        level = 'CRITICAL';
        labelVi = `Quá ồn (≥ ${critMax} dBA)`;
        sopRecommendationVi =
          'Cử thủ thư nhắc nhở trật tự ngay hoặc mời nhóm trao đổi sang phòng thảo luận Tầng 5.';
      } else if (value >= warnMax) {
        level = 'WARNING';
        labelVi = `Ồn nhẹ (≥ ${warnMax} dBA)`;
        sopRecommendationVi =
          'Quan sát khu vực cửa ra vào / bàn nhóm để điều tiết âm lượng kịp thời.';
      } else {
        labelVi = 'Yên tĩnh đạt chuẩn';
      }
      break;
    }
    case 'temperature': {
      const tMaxCrit = roomThresholds?.tempMax ?? (roomType === 'BOOK_STORAGE' ? 28.0 : 30.0);
      const tMaxWarn = roomType === 'BOOK_STORAGE' ? 25.0 : 26.0;
      const tMin = roomThresholds?.tempMin ?? 19.0;
      thresholdSummaryVi = `Chuẩn: ${tMin}–${tMaxWarn}°C`;
      if (value >= tMaxCrit || value < 17.0) {
        level = 'CRITICAL';
        labelVi = value >= tMaxCrit ? `Quá nóng (≥ ${tMaxCrit}°C)` : 'Quá lạnh (< 17°C)';
        sopRecommendationVi =
          'Kiểm tra dàn lạnh AHU/chiller khu vực, hạ rèm chắn nắng hướng Tây ngay.';
      } else if (value >= tMaxWarn || value < tMin) {
        level = 'WARNING';
        labelVi = value >= tMaxWarn ? `Hơi ấm (≥ ${tMaxWarn}°C)` : `Hơi lạnh (< ${tMin}°C)`;
        sopRecommendationVi =
          'Điều chỉnh điểm đặt nhiệt độ điều hòa hoặc kéo mành che nắng vách kính.';
      } else {
        labelVi = 'Nhiệt độ lý tưởng';
      }
      break;
    }
    case 'humidity': {
      const hMaxStorage = roomThresholds?.humidityMax ?? 60.0;
      if (roomType === 'BOOK_STORAGE') {
        thresholdSummaryVi = `Kho sách: 40–${hMaxStorage}%RH`;
        if (value > hMaxStorage || value < 32) {
          level = 'CRITICAL';
          labelVi =
            value > hMaxStorage
              ? `Vượt ngưỡng bảo quản (> ${hMaxStorage}%RH)`
              : 'Quá khô cho bảo quản sách (< 32%RH)';
          sopRecommendationVi =
            value > hMaxStorage
              ? 'Bật ngay máy hút ẩm chuyên dụng Kho sách và kiểm tra đóng kín cửa chống nồm ẩm.'
              : 'Bù ẩm nhẹ cho kho lưu trữ tài liệu giấy tránh giòn gãy gáy sách.';
        } else if (value >= 57.5 || value < 38) {
          level = 'WARNING';
          labelVi = `Sát ngưỡng bảo quản (${value.toFixed(1)}%RH)`;
          sopRecommendationVi =
            'Chuẩn bị kích hoạt máy hút ẩm phòng Kho sách để giữ dưới 60%RH.';
        } else {
          labelVi = 'Đạt chuẩn bảo quản sách';
        }
      } else {
        const hMax = roomThresholds?.humidityMax ?? 75.0;
        thresholdSummaryVi = `Phòng đọc: 38–65%RH`;
        if (value > hMax || value < 30) {
          level = 'CRITICAL';
          labelVi = value > hMax ? `Ẩm quá cao (> ${hMax}%RH)` : 'Quá khô (< 30%RH)';
          sopRecommendationVi =
            'Điều chỉnh chế độ hút ẩm HVAC hoặc tăng thông gió cưỡng bức.';
        } else if (value > 65 || value < 35) {
          level = 'WARNING';
          labelVi = value > 65 ? 'Hơi ẩm (> 65%RH)' : 'Hơi khô (< 35%RH)';
          sopRecommendationVi = 'Theo dõi độ ẩm và cân bằng gió tươi điều hòa.';
        } else {
          labelVi = 'Độ ẩm dễ chịu';
        }
      }
      break;
    }
    case 'lux': {
      thresholdSummaryVi = 'Chuẩn đọc sách: 240–650 lx';
      if (value < 120 || value >= 850) {
        level = 'CRITICAL';
        labelVi = value < 120 ? 'Thiếu sáng nghiêm trọng' : 'Chói nắng gắt (≥ 850 lx)';
        sopRecommendationVi =
          value < 120
            ? 'Bật toàn bộ hệ thống đèn trần LED khu bàn đọc.'
            : 'Kéo rèm cuốn chống chói tại vách kính hướng nắng.';
      } else if (value < 220 || value > 650) {
        level = 'WARNING';
        labelVi = value < 220 ? 'Hơi tối (< 220 lx)' : 'Ánh sáng hơi gắt (> 650 lx)';
        sopRecommendationVi =
          value < 220 ? 'Bật thêm dãy đèn chiếu sáng bàn học.' : 'Hạ nhẹ mành chắn nắng cửa sổ.';
      } else {
        labelVi = 'Ánh sáng đạt chuẩn';
      }
      break;
    }
    case 'pm2_5': {
      const pmMaxCrit = roomThresholds?.pm25Max ?? 50.0;
      thresholdSummaryVi = `Chuẩn sạch: < 25 µg/m³`;
      if (value >= pmMaxCrit) {
        level = 'CRITICAL';
        labelVi = `Ô nhiễm bụi cao (≥ ${pmMaxCrit} µg/m³)`;
        sopRecommendationVi =
          'Bật cấp khí tươi lọc HEPA AHU mức cao và kiểm tra đóng cửa ngoài sảnh.';
      } else if (value >= 25.0) {
        level = 'WARNING';
        labelVi = 'Bụi mịn tăng (≥ 25 µg/m³)';
        sopRecommendationVi =
          'Tăng tốc độ quạt thông gió cấp khí sạch hành lang.';
      } else {
        labelVi = 'Không khí trong lành';
      }
      break;
    }
    case 'wifiRssi': {
      thresholdSummaryVi = 'Tín hiệu ổn định: ≥ -67 dBm';
      if (value < -75) {
        level = 'CRITICAL';
        labelVi = 'Sóng rất yếu / mất kết nối';
        sopRecommendationVi =
          'Báo Kỹ thuật viên kiểm tra Access Point hoặc nguồn PoE trạm ESP32.';
      } else if (value < -67) {
        level = 'WARNING';
        labelVi = 'Suy hao tín hiệu (-68..-75 dBm)';
        sopRecommendationVi =
          'Kiểm tra độ ổn định gói tin từ các trạm khu vực góc khuất tường BTCT.';
      } else {
        labelVi = 'Kết nối Wi-Fi mạnh';
      }
      break;
    }
  }

  const symbol: MetricStatusGeometricSymbol =
    level === 'CRITICAL' ? '◆' : level === 'WARNING' ? '▲' : '●';

  return {
    level,
    symbol,
    labelVi,
    isExceedingThreshold: level !== 'NORMAL',
    thresholdSummaryVi,
    sopRecommendationVi,
  };
}

/**
 * Độ sáng tương đối chuẩn WCAG 2.2 (Relative Luminance trong [0.0, 1.0]).
 */
export function getRelativeLuminance(rgb: readonly [number, number, number]): number {
  const [r, g, b] = rgb.map((c) => {
    const s = Math.max(0, Math.min(255, c)) / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Tỷ lệ tương phản WCAG 2.2 giữa 2 màu RGB (từ 1.0 đến 21.0).
 */
export function getWcagContrastRatio(
  fgRgb: readonly [number, number, number],
  bgRgb: readonly [number, number, number]
): number {
  const l1 = getRelativeLuminance(fgRgb);
  const l2 = getRelativeLuminance(bgRgb);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Chuyển đổi mã hex #RRGGBB sang tuple RGB.
 */
export function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((ch) => ch + ch)
          .join('')
      : clean;
  const num = Number.parseInt(full, 16);
  if (Number.isNaN(num)) return [0, 0, 0];
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

/**
 * Mô phỏng thị giác mù màu (Deuteranopia / Protanopia) theo ma trận Viénot (1999) để kiểm chứng bảng màu.
 */
export function simulateColorVisionDeficiency(
  rgb: readonly [number, number, number],
  type: 'deuteranopia' | 'protanopia'
): [number, number, number] {
  const [r, g, b] = rgb;
  if (type === 'deuteranopia') {
    return [
      Math.round(0.625 * r + 0.375 * g),
      Math.round(0.7 * r + 0.3 * g),
      Math.round(0.3 * g + 0.7 * b),
    ];
  }
  return [
    Math.round(0.567 * r + 0.433 * g),
    Math.round(0.558 * r + 0.442 * g),
    Math.round(0.242 * g + 0.758 * b),
  ];
}

/**
 * Linearly interpolates continuous RGBA components for any arbitrary floating value.
 */
export function getContinuousMetricColor(
  layer: HeatmapLayerMetric,
  value: number | null | undefined
): [number, number, number, number] {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return [100, 116, 139, 0.40]; // Slate neutral #64748B
  }

  const stops = WEATHER_PALETTES[layer] || WEATHER_PALETTES.temperature;
  if (value <= stops[0].val) {
    const s = stops[0];
    return [s.r, s.g, s.b, s.a];
  }
  if (value >= stops[stops.length - 1].val) {
    const s = stops[stops.length - 1];
    return [s.r, s.g, s.b, s.a];
  }

  for (let i = 0; i < stops.length - 1; i++) {
    const s1 = stops[i];
    const s2 = stops[i + 1];
    if (value >= s1.val && value <= s2.val) {
      const t = (value - s1.val) / (s2.val - s1.val);
      const r = Math.round(s1.r + (s2.r - s1.r) * t);
      const g = Math.round(s1.g + (s2.g - s1.g) * t);
      const b = Math.round(s1.b + (s2.b - s1.b) * t);
      const a = s1.a + (s2.a - s1.a) * t;
      return [r, g, b, a];
    }
  }

  return [100, 116, 139, 0.40];
}

export function getContinuousMetricColorCss(
  layer: HeatmapLayerMetric,
  value: number | null | undefined
): string {
  const [r, g, b, a] = getContinuousMetricColor(layer, value);
  return `rgba(${r}, ${g}, ${b}, ${a.toFixed(2)})`;
}

/**
 * Creates CSS linear-gradient string for building continuous weather radar legends.
 */
export function getPaletteCssGradient(layer: HeatmapLayerMetric): string {
  const stops = WEATHER_PALETTES[layer] || WEATHER_PALETTES.temperature;
  const gradientStops = stops
    .map((s, idx) => {
      const pct = Math.round((idx / (stops.length - 1)) * 100);
      return `rgb(${s.r}, ${s.g}, ${s.b}) ${pct}%`;
    })
    .join(', ');
  return `linear-gradient(to right, ${gradientStops})`;
}

/**
 * Tính bán kính khuếch tán Gaussian thích ứng theo diện tích đa giác phòng (`adaptiveSigma`).
 * - Phòng làm việc nhóm nhỏ (25.97 – 41.47 m² Tầng 5, diện tích chuẩn hóa ~0.006–0.009): sigma nhỏ (~0.055–0.075) giữ vùng nhiệt gọn trong phòng.
 * - Phòng đọc / Multimedia lớn (301.30 – 570.57 m², diện tích chuẩn hóa ~0.065–0.125): sigma lớn (~0.135–0.195) giúp các dãy bàn đọc giao thoa mượt mà.
 */
export function computeAdaptiveSigma(
  normalizedPolygon: readonly Point2D[] | undefined | null,
  sampleCount: number,
  baseCoverageRadius = 0.26
): number {
  if (!normalizedPolygon || normalizedPolygon.length < 3) {
    return Math.max(0.08, baseCoverageRadius * 0.60);
  }
  const polyArea = Math.abs(computePolygonSignedArea(normalizedPolygon));
  if (polyArea <= 0.0001) {
    return Math.max(0.08, baseCoverageRadius * 0.60);
  }

  const effectiveSamples = Math.max(1, sampleCount);
  const characteristicSpan = Math.sqrt(polyArea / effectiveSamples);
  const rawSigma = characteristicSpan * 0.78;

  // Co giãn mềm theo diện tích phòng thực tế: phòng nhóm nhỏ < 0.012 nhận cận dưới 0.052, phòng đọc lớn nhận tới 0.21
  const minSigma = polyArea < 0.015 ? 0.052 : 0.085;
  const maxSigma = polyArea < 0.02 ? 0.095 : 0.215;

  return Math.max(minSigma, Math.min(maxSigma, rawSigma));
}

export interface RoomBlindspotAnalysis {
  /** Tỷ lệ diện tích bên trong đa giác phòng có fieldPresence < 0.25 (0.0 -> 1.0) */
  readonly blindspotRatio: number;
  /** Cảnh báo phòng thiếu độ phủ cảm biến khi blindspotRatio >= 0.22 */
  readonly isUnderCovered: boolean;
  readonly effectiveSigma: number;
}

/**
 * Đánh giá tỷ lệ Vùng mù Cảm biến (`Coverage Blindspots`, `fieldPresence < 0.25`) bên trong đa giác phòng
 * phục vụ Role `MAINTENANCE` kiểm tra vị trí lắp đặt trạm ESP32.
 */
export function computeRoomBlindspotRatio(
  normalizedPolygon: readonly Point2D[],
  idwSamples: readonly IdwSamplePoint[],
  aspectFactor = 57.2 / 76.0,
  sigmaOverride?: number
): RoomBlindspotAnalysis {
  if (!normalizedPolygon || normalizedPolygon.length < 3) {
    return { blindspotRatio: 0, isUnderCovered: false, effectiveSigma: 0.156 };
  }
  const effectiveSigma =
    sigmaOverride ?? computeAdaptiveSigma(normalizedPolygon, idwSamples.length);

  if (idwSamples.length === 0) {
    return { blindspotRatio: 1, isUnderCovered: true, effectiveSigma };
  }

  let minX = 1;
  let maxX = 0;
  let minY = 1;
  let maxY = 0;
  for (const pt of normalizedPolygon) {
    if (pt.x < minX) minX = pt.x;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.y > maxY) maxY = pt.y;
  }

  const steps = 20;
  const dxStep = (maxX - minX) / steps;
  const dyStep = (maxY - minY) / steps;
  if (dxStep <= 0 || dyStep <= 0) {
    return { blindspotRatio: 0, isUnderCovered: false, effectiveSigma };
  }

  const twoSigmaSq = 2 * effectiveSigma * effectiveSigma;
  let insideCount = 0;
  let blindCount = 0;

  for (let iy = 0; iy <= steps; iy++) {
    const ny = minY + iy * dyStep;
    for (let ix = 0; ix <= steps; ix++) {
      const nx = minX + ix * dxStep;
      if (!isPointInPolygon({ x: nx, y: ny }, normalizedPolygon)) continue;
      insideCount++;

      let sumWeight = 0;
      for (let i = 0; i < idwSamples.length; i++) {
        const s = idwSamples[i];
        const dx = nx - s.x;
        const dy = (ny - s.y) * aspectFactor;
        const distSq = dx * dx + dy * dy;
        sumWeight += Math.exp(-distSq / twoSigmaSq);
      }
      const fieldPresence = 1 - Math.exp(-2.2 * sumWeight);
      if (fieldPresence < 0.25) {
        blindCount++;
      }
    }
  }

  const blindspotRatio = insideCount > 0 ? +(blindCount / insideCount).toFixed(3) : 0;
  return {
    blindspotRatio,
    isUnderCovered: blindspotRatio >= 0.22,
    effectiveSigma,
  };
}

export interface RenderHeatmapOptions {
  readonly normalizedPolygon?: readonly Point2D[];
  readonly showBlindspots?: boolean;
  readonly skipDarkBase?: boolean;
  readonly onlyExceedingThreshold?: boolean;
  readonly roomExceedsThreshold?: boolean;
}

let sharedOffscreenCanvas: HTMLCanvasElement | null = null;

function getSharedOffscreenCanvas(
  width: number,
  height: number
): HTMLCanvasElement {
  if (!sharedOffscreenCanvas) {
    sharedOffscreenCanvas = document.createElement('canvas');
  }
  if (sharedOffscreenCanvas.width !== width) {
    sharedOffscreenCanvas.width = width;
  }
  if (sharedOffscreenCanvas.height !== height) {
    sharedOffscreenCanvas.height = height;
  }
  return sharedOffscreenCanvas;
}

export function renderWeatherDiffusionHeatmap(
  ctx: CanvasRenderingContext2D,
  pixelVertices: readonly Point2D[],
  idwSamples: readonly IdwSamplePoint[],
  layer: HeatmapLayerMetric,
  canvasWidth: number,
  canvasHeight: number,
  fallbackValue: number | null,
  coverageRadius = 0.26,
  options?: RenderHeatmapOptions
): void {
  // 1. Calculate polygon bounding box
  let minX = canvasWidth;
  let maxX = 0;
  let minY = canvasHeight;
  let maxY = 0;
  for (const pv of pixelVertices) {
    if (pv.x < minX) minX = pv.x;
    if (pv.x > maxX) maxX = pv.x;
    if (pv.y < minY) minY = pv.y;
    if (pv.y > maxY) maxY = pv.y;
  }

  const roomW = Math.max(10, Math.ceil(maxX - minX));
  const roomH = Math.max(10, Math.ceil(maxY - minY));

  // 2. Setup Polygon Clipping (Strict barrier prevents leaking outside room walls)
  ctx.save();
  ctx.beginPath();
  pixelVertices.forEach((p, idx) => {
    if (idx === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.closePath();
  ctx.clip();

  if (!options?.skipDarkBase) {
    // Semi-translucent dark background within room so the CAD architectural underlay remains visible
    ctx.fillStyle = 'rgba(11, 17, 32, 0.72)';
    ctx.fillRect(minX, minY, roomW, roomH);

    // Subtle architectural desk tile grid inside room
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.035)';
    ctx.lineWidth = 1;
    const tileStep = 24;
    for (let tx = minX; tx <= maxX; tx += tileStep) {
      ctx.beginPath();
      ctx.moveTo(tx, minY);
      ctx.lineTo(tx, maxY);
      ctx.stroke();
    }
    for (let ty = minY; ty <= maxY; ty += tileStep) {
      ctx.beginPath();
      ctx.moveTo(minX, ty);
      ctx.lineTo(maxX, ty);
      ctx.stroke();
    }
  }

  // ISA-101 Deviation Mode: Muting rooms within normal limits so threshold breaches pop out immediately
  if (options?.onlyExceedingThreshold && !options?.roomExceedsThreshold) {
    ctx.fillStyle = 'rgba(30, 41, 59, 0.36)';
    ctx.fillRect(minX, minY, roomW, roomH);
    ctx.restore();
    return;
  }

  // Case A: No online devices and no telemetry -> neutral dark slate
  if (idwSamples.length === 0 && fallbackValue === null) {
    ctx.fillStyle = options?.showBlindspots ? 'rgba(245, 158, 11, 0.28)' : '#64748B';
    ctx.globalAlpha = options?.showBlindspots ? 0.55 : 0.22;
    ctx.fillRect(minX, minY, roomW, roomH);
    ctx.restore();
    return;
  }

  // Case B: No desk sensors, but room-level telemetry exists
  if (idwSamples.length === 0 && fallbackValue !== null) {
    const [r, g, b, a] = getContinuousMetricColor(layer, fallbackValue);
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a * 0.48})`;
    ctx.fillRect(minX, minY, roomW, roomH);
    ctx.restore();
    return;
  }

  // Case C: 1 or more desk sensors / reading bays -> Multi-source continuous Gaussian RBF diffusion field
  const gridW = Math.max(45, Math.min(130, Math.round(roomW / 3.0)));
  const gridH = Math.max(35, Math.min(95, Math.round(roomH / 3.0)));

  const offscreen = getSharedOffscreenCanvas(gridW, gridH);
  const offCtx = offscreen.getContext('2d');
  if (!offCtx) {
    ctx.restore();
    return;
  }

  const imgData = offCtx.createImageData(gridW, gridH);
  const data = imgData.data;

  const stepX = roomW / (gridW - 1);
  const stepY = roomH / (gridH - 1);
  const aspectFactor = canvasHeight / canvasWidth;

  // Area-adaptive Gaussian spread parameter (adaptiveSigma)
  const sigma = options?.normalizedPolygon
    ? computeAdaptiveSigma(options.normalizedPolygon, idwSamples.length, coverageRadius)
    : Math.max(0.08, coverageRadius * 0.60);
  const twoSigmaSq = 2 * sigma * sigma;
  const showBlindspots = Boolean(options?.showBlindspots);

  let ptr = 0;
  for (let gy = 0; gy < gridH; gy++) {
    const curPy = minY + gy * stepY;
    const curNy = curPy / canvasHeight;

    for (let gx = 0; gx < gridW; gx++) {
      const curPx = minX + gx * stepX;
      const curNx = curPx / canvasWidth;

      let sumWeight = 0;
      let sumVal = 0;

      for (let i = 0; i < idwSamples.length; i++) {
        const s = idwSamples[i];
        const dx = curNx - s.x;
        const dy = (curNy - s.y) * aspectFactor;
        const distSq = dx * dx + dy * dy;
        const w = Math.exp(-distSq / twoSigmaSq);
        sumWeight += w;
        sumVal += w * s.value;
      }

      // Infinitely smooth Gaussian field presence (naturally decays to 0 in unmonitored zones)
      const fieldPresence = 1 - Math.exp(-2.2 * sumWeight);

      if (showBlindspots && fieldPresence < 0.25) {
        // Highlight sensor coverage blindspot (< 0.25 fieldPresence) with diagnostic amber-crimson stipple
        const stripe = (gx + gy) % 3 === 0 ? 1.0 : 0.55;
        data[ptr] = 245;
        data[ptr + 1] = 158;
        data[ptr + 2] = 11;
        data[ptr + 3] = Math.round(145 * stripe);
      } else if (fieldPresence > 0.01 && sumWeight > 0.0001) {
        const val = sumVal / sumWeight;
        const [r, g, b, a] = getContinuousMetricColor(layer, val);

        data[ptr] = r;
        data[ptr + 1] = g;
        data[ptr + 2] = b;
        data[ptr + 3] = Math.round(a * fieldPresence * 240);
      } else {
        data[ptr] = 0;
        data[ptr + 1] = 0;
        data[ptr + 2] = 0;
        data[ptr + 3] = 0;
      }
      ptr += 4;
    }
  }

  offCtx.putImageData(imgData, 0, 0);

  // 3. Render smoothly into main canvas with bilinear scaling + fluid diffusion
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const hasFilter = typeof ctx.filter === 'string';
  const blurPx = sigma < 0.09 ? 10 : 16;
  if (hasFilter) {
    ctx.filter = `blur(${blurPx}px)`;
  }

  const pad = blurPx;
  ctx.drawImage(offscreen, minX - pad, minY - pad, roomW + pad * 2, roomH + pad * 2);

  if (hasFilter) {
    ctx.filter = 'none';
  }

  ctx.restore();
}
