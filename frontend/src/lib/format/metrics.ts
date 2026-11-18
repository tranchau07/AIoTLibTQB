import type { BucketInterval } from '@/types/api';

export const MISSING_METRIC_PLACEHOLDER = '--';

export function formatNumber(
  value: number | null | undefined,
  decimals: number,
  unit?: string
): string {
  if (
    value === null ||
    value === undefined ||
    Number.isNaN(value) ||
    !Number.isFinite(value)
  ) {
    return MISSING_METRIC_PLACEHOLDER;
  }
  const formatted = value.toFixed(decimals);
  return unit ? `${formatted} ${unit}` : formatted;
}

export const formatMetrics = {
  temperature: (v?: number | null) => formatNumber(v, 1, '°C'),
  humidity: (v?: number | null) => formatNumber(v, 0, '%RH'),
  lux: (v?: number | null) => formatNumber(v, 0, 'lux'),
  noise: (v?: number | null) => formatNumber(v, 1, 'dBA'),
  pm: (v?: number | null) => formatNumber(v, 1, 'µg/m³'),
  comfortScore: (v?: number | null) => formatNumber(v, 0),
  rssi: (v?: number | null) => formatNumber(v, 0, 'dBm'),
} as const;

const INTERVAL_SECONDS: Record<BucketInterval, number> = {
  '15m': 900,
  '1h': 3600,
  '1d': 86400,
};

/**
 * Exact integer ceiling bucket count matching TelemetryService.java:115 (FE-API-09, N3).
 */
export function computeBucketCount(
  startIso: string | Date,
  endIso: string | Date,
  interval: BucketInterval
): number {
  const startMs = new Date(startIso).getTime();
  const endMs = new Date(endIso).getTime();
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || startMs >= endMs) {
    return 0;
  }
  const durationSeconds = Math.floor((endMs - startMs) / 1000);
  const intervalSeconds = INTERVAL_SECONDS[interval];
  return Math.floor((durationSeconds + intervalSeconds - 1) / intervalSeconds);
}

export function validateBucketRange(
  startIso: string | Date,
  endIso: string | Date,
  interval: BucketInterval,
  maxBuckets = 1000
): { valid: boolean; errorCode?: 7001 | 7002; bucketCount: number } {
  const startMs = new Date(startIso).getTime();
  const endMs = new Date(endIso).getTime();
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || startMs >= endMs) {
    return { valid: false, errorCode: 7001, bucketCount: 0 };
  }
  const bucketCount = computeBucketCount(startIso, endIso, interval);
  if (bucketCount > maxBuckets) {
    return { valid: false, errorCode: 7002, bucketCount };
  }
  return { valid: true, bucketCount };
}

/**
 * Recommended interval selection based on duration (FE-API-10).
 */
export function recommendIntervalForRange(
  startIso: string | Date,
  endIso: string | Date
): BucketInterval {
  const startMs = new Date(startIso).getTime();
  const endMs = new Date(endIso).getTime();
  const hours = (endMs - startMs) / (1000 * 3600);
  if (hours <= 24) return '15m';
  if (hours <= 24 * 7) return '1h';
  return '1d';
}

/**
 * FE-SEC-04: Escape CSV cell and neutralize spreadsheet formula injection (=, +, -, @, \t, \r).
 */
export function escapeCsvCell(
  value: string | number | null | undefined
): string {
  if (value === null || value === undefined) return '';
  let str = String(value);
  const startsWithFormulaTrigger =
    /^[=+\-@\t\r]/.test(str) && !/^-\d+(\.\d+)?$/.test(str);
  if (startsWithFormulaTrigger) {
    str = `'${str}`;
  }
  if (
    str.includes(',') ||
    str.includes('"') ||
    str.includes('\n') ||
    str.includes('\r')
  ) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * FE-UI-05: Localize backend English bottleneckReason strings to Vietnamese.
 */
export function formatBottleneckReasonVi(
  reason: string | null | undefined
): string {
  if (!reason) return '';
  const trimmed = reason.trim();

  const noiseAvgMatch = trimmed.match(
    /^Average noise level \(([^)]+)\) exceeded threshold \(([^)]+)\)$/i
  );
  if (noiseAvgMatch) {
    return `Độ ồn trung bình (${noiseAvgMatch[1]}) vượt ngưỡng cho phép (${noiseAvgMatch[2]})`;
  }

  const noisePeakMatch = trimmed.match(
    /^Peak noise spike \(([^)]+)\) exceeded threshold \(([^)]+)\)$/i
  );
  if (noisePeakMatch) {
    return `Tiếng ồn đột biến (${noisePeakMatch[1]}) vượt ngưỡng cho phép (${noisePeakMatch[2]})`;
  }

  const pmFineMatch = trimmed.match(
    /^PM2\.5 fine dust \(([^)]+)\) exceeded threshold \(([^)]+)\)$/i
  );
  if (pmFineMatch) {
    return `Bụi mịn PM2.5 (${pmFineMatch[1]}) vượt ngưỡng an toàn (${pmFineMatch[2]})`;
  }

  const pmParticulateMatch = trimmed.match(
    /^PM2\.5 particulate level \(([^)]+)\) exceeded threshold \(([^)]+)\)$/i
  );
  if (pmParticulateMatch) {
    return `Nồng độ bụi mịn PM2.5 (${pmParticulateMatch[1]}) vượt ngưỡng cho phép (${pmParticulateMatch[2]})`;
  }

  const tempRangeMatch = trimmed.match(
    /^Temperature \(([^)]+)\) out of optimal range \(([^)]+)\)$/i
  );
  if (tempRangeMatch) {
    return `Nhiệt độ (${tempRangeMatch[1]}) nằm ngoài ngưỡng tối ưu (${tempRangeMatch[2]})`;
  }

  const tempExceedMatch = trimmed.match(
    /^Temperature \(([^)]+)\) exceeded threshold \(([^)]+)\)$/i
  );
  if (tempExceedMatch) {
    return `Nhiệt độ (${tempExceedMatch[1]}) vượt ngưỡng cho phép (${tempExceedMatch[2]})`;
  }

  const humidityHighMatch = trimmed.match(
    /^(?:Book storage )?humidity \(([^)]+)\) exceeded max threshold \(([^)]+)\)$/i
  );
  if (humidityHighMatch) {
    return `Độ ẩm kho sách (${humidityHighMatch[1]}) vượt ngưỡng tối đa (${humidityHighMatch[2]})`;
  }

  const humidityLowMatch = trimmed.match(
    /^(?:Book storage )?humidity \(([^)]+)\) dropped below min threshold \(([^)]+)\)$/i
  );
  if (humidityLowMatch) {
    return `Độ ẩm kho sách (${humidityLowMatch[1]}) xuống dưới ngưỡng tối thiểu (${humidityLowMatch[2]})`;
  }

  const offlineMatch = trimmed.match(
    /^Device is offline:\s*hardwareId=(.+)$/i
  );
  if (offlineMatch) {
    return `Thiết bị mất kết nối (mã phần cứng: ${offlineMatch[1].trim()})`;
  }

  if (/^Sub-optimal comfort index$/i.test(trimmed)) {
    return 'Chỉ số tiện nghi tổng hợp dưới mức tối ưu';
  }
  return trimmed;
}
