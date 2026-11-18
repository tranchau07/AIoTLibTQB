'use client';

import React from 'react';
import {
  AlertTriangle,
  Clock,
  CheckCircle2,
  Volume2,
  Wind,
  WifiOff,
  Cpu,
} from 'lucide-react';
import type {
  AlertResponse,
  AlertSeverity,
  AlertStatus,
  AlertType,
} from '@/types/api';

export interface SeverityMetaConfig {
  labelVi: string;
  badgeClass: string;
}

export const ALERT_SEVERITY_META: Record<AlertSeverity, SeverityMetaConfig> = {
  CRITICAL: {
    labelVi: 'Khẩn cấp',
    badgeClass: 'border-rose-300 bg-rose-100 text-rose-900 font-semibold',
  },
  HIGH: {
    labelVi: 'Cao',
    badgeClass: 'border-red-200 bg-red-50 text-red-700 font-semibold',
  },
  MEDIUM: {
    labelVi: 'Trung bình',
    badgeClass: 'border-amber-200 bg-amber-50 text-amber-800',
  },
  LOW: {
    labelVi: 'Thấp',
    badgeClass: 'border-slate-200 bg-slate-100 text-slate-700',
  },
};

export function AlertSeverityBadge({
  severity = 'MEDIUM',
}: {
  severity?: AlertSeverity;
}) {
  const meta = ALERT_SEVERITY_META[severity] ?? ALERT_SEVERITY_META.MEDIUM;
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] ${meta.badgeClass}`}
    >
      {meta.labelVi}
    </span>
  );
}

export interface BadgeStyleConfig {
  labelVi: string;
  shortCode: string;
  icon: React.ReactNode;
  dotClass: string;
  badgeClass: string;
}

export const ALERT_STATUS_META: Record<AlertStatus, BadgeStyleConfig> = {
  FIRING: {
    labelVi: 'Kích hoạt',
    shortCode: 'FIRING',
    icon: <AlertTriangle className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />,
    dotClass: 'bg-red-500 animate-pulse',
    badgeClass: 'badge-danger',
  },
  PENDING: {
    labelVi: 'Chờ xác nhận',
    shortCode: 'PENDING',
    icon: <Clock className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />,
    dotClass: 'bg-amber-500',
    badgeClass: 'badge-warning',
  },
  ACKNOWLEDGED: {
    labelVi: 'Đã tiếp nhận',
    shortCode: 'ACKNOWLEDGED',
    icon: <CheckCircle2 className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />,
    dotClass: 'bg-brand-500',
    badgeClass: 'badge-brand',
  },
  RESOLVED: {
    labelVi: 'Đã đóng',
    shortCode: 'RESOLVED',
    icon: <CheckCircle2 className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />,
    dotClass: 'bg-emerald-500',
    badgeClass: 'badge-success',
  },
};

export const ALERT_TYPE_META: Record<
  AlertType,
  BadgeStyleConfig & { unit?: string; decimals: number }
> = {
  NOISE_EXCEEDED: {
    labelVi: 'Vượt ngưỡng ồn',
    shortCode: 'NOISE_EXCEEDED',
    icon: <Volume2 className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />,
    dotClass: 'bg-rose-500',
    badgeClass: 'badge-danger',
    unit: 'dBA',
    decimals: 1,
  },
  AIR_UNHEALTHY: {
    labelVi: 'Không khí kém',
    shortCode: 'AIR_UNHEALTHY',
    icon: <Wind className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />,
    dotClass: 'bg-amber-500',
    badgeClass: 'badge-warning',
    unit: 'µg/m³',
    decimals: 1,
  },
  DEVICE_OFFLINE: {
    labelVi: 'Mất kết nối',
    shortCode: 'DEVICE_OFFLINE',
    icon: <WifiOff className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />,
    dotClass: 'bg-slate-400',
    badgeClass: 'badge-neutral',
    unit: undefined,
    decimals: 0,
  },
  SENSOR_MALFUNCTION: {
    labelVi: 'Lỗi cảm biến',
    shortCode: 'SENSOR_MALFUNCTION',
    icon: <Cpu className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />,
    dotClass: 'bg-purple-500',
    badgeClass: 'badge-neutral',
    unit: undefined,
    decimals: 1,
  },
};

export interface AlertValueFormat {
  unit?: string;
  decimals: number;
  isOffline: boolean;
}

function resolveUnitFromAlertMessage(message: string | null | undefined): string | undefined {
  const msg = (message ?? '').toLowerCase();
  if (
    msg.includes('humidity') ||
    msg.includes('%rh') ||
    /(\d|\b)rh\b/.test(msg) ||
    msg.includes('ẩm')
  ) {
    return '%RH';
  }
  if (msg.includes('temperature') || msg.includes('°c') || msg.includes('nhiệt')) {
    return '°C';
  }
  if (
    msg.includes('pm2.5') ||
    msg.includes('pm2_5') ||
    msg.includes('µg/m³') ||
    msg.includes('bụi')
  ) {
    return 'µg/m³';
  }
  if (msg.includes('dba') || msg.includes('noise') || msg.includes('ồn')) {
    return 'dBA';
  }
  return undefined;
}

export function resolveAlertValueFormat(
  alert: Pick<AlertResponse, 'type' | 'metricType' | 'unit' | 'message'>
): AlertValueFormat {
  const normalizedMetric = alert.metricType?.trim();
  if (alert.type === 'DEVICE_OFFLINE' || normalizedMetric === 'DEVICE_OFFLINE') {
    return { unit: undefined, decimals: 0, isOffline: true };
  }

  const explicitUnit = alert.unit?.trim();
  if (explicitUnit) {
    return { unit: explicitUnit, decimals: 1, isOffline: false };
  }

  switch (normalizedMetric) {
    case 'NOISE_AVG':
    case 'NOISE_PEAK':
      return { unit: 'dBA', decimals: 1, isOffline: false };
    case 'TEMPERATURE':
      return { unit: '°C', decimals: 1, isOffline: false };
    case 'HUMIDITY_HIGH':
    case 'HUMIDITY_LOW':
      return { unit: '%RH', decimals: 1, isOffline: false };
    case 'PM2_5':
      return { unit: 'µg/m³', decimals: 1, isOffline: false };
    default:
      break;
  }

  if (alert.type === 'NOISE_EXCEEDED') {
    return { unit: 'dBA', decimals: 1, isOffline: false };
  }
  if (alert.type === 'AIR_UNHEALTHY') {
    return {
      unit: resolveUnitFromAlertMessage(alert.message) ?? 'µg/m³',
      decimals: 1,
      isOffline: false,
    };
  }
  if (alert.type === 'SENSOR_MALFUNCTION') {
    return {
      unit: resolveUnitFromAlertMessage(alert.message),
      decimals: 1,
      isOffline: false,
    };
  }
  return { unit: undefined, decimals: 1, isOffline: false };
}

/**
 * FE-A11Y-01: Combines color dot + symbolic icon + explicit Vietnamese label
 */
export function AlertStatusBadge({ status }: { status: AlertStatus }) {
  const meta = ALERT_STATUS_META[status] ?? {
    labelVi: status,
    shortCode: status,
    icon: <span className="dot bg-slate-400" aria-hidden="true" />,
    dotClass: 'bg-slate-400',
    badgeClass: 'badge-neutral',
  };

  return (
    <span className={`badge ${meta.badgeClass}`}>
      <span className={`dot ${meta.dotClass}`} aria-hidden="true" />
      <span>{meta.labelVi}</span>
    </span>
  );
}

/**
 * FE-A11Y-01: Combines color dot + symbolic icon + explicit Vietnamese label
 */
export function AlertTypeBadge({ type }: { type: AlertType }) {
  const meta = ALERT_TYPE_META[type] ?? {
    labelVi: type,
    shortCode: type,
    icon: <span className="dot bg-slate-400" aria-hidden="true" />,
    dotClass: 'bg-slate-400',
    badgeClass: 'badge-neutral',
  };

  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-slate-700">
      {meta.icon}
      <span>{meta.labelVi}</span>
    </span>
  );
}
