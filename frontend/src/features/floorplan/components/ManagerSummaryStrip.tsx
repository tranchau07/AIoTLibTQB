'use client';

import React, { useMemo } from 'react';
import {
  AlertTriangle,
  Clock,
  FilterX,
  Radio,
  ShieldAlert,
} from 'lucide-react';
import {
  classifyManagerRoomStatus,
  isAlertOpen,
  isAlertOverdue,
  SUMMARY_STATUS_THRESHOLDS,
  TIMING_CONFIG,
  type ManagerStatusFilter,
} from '@/config/floorplan-hmi.config';
import { formatRelativeTimeVi } from '@/lib/format/datetime';
import { FLOORPLAN_I18N_VI } from '@/messages/vi';
import type { AlertResponse, RoomResponse, TelemetryResponse } from '@/types/api';

export interface ManagerSummaryMetrics {
  totalOpenAlerts: number;
  bySeverity: Record<'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW', number>;
  overdueCount: number;
  roomCounts: {
    GOOD: number;
    ATTENTION: number;
    POOR: number;
    NO_DATA: number;
    total: number;
  };
  lastUpdatedAt: string | null;
}

export function computeBuildingSummaryMetrics(
  rooms: readonly RoomResponse[],
  roomTelemetryMap: Record<string, TelemetryResponse | null | undefined>,
  alerts: readonly AlertResponse[],
  nowMs: number = Date.now(),
  overdueAlertMs: number = TIMING_CONFIG.overdueAlertMs,
  thresholds: { goodMinScore: number; attentionMinScore: number } = SUMMARY_STATUS_THRESHOLDS
): ManagerSummaryMetrics {
  const uniqueAlerts = new Map<string, AlertResponse>();
  for (const alert of alerts) {
    if (!uniqueAlerts.has(alert.id)) {
      uniqueAlerts.set(alert.id, alert);
    }
  }
  const openAlerts = Array.from(uniqueAlerts.values()).filter(isAlertOpen);

  const bySeverity: ManagerSummaryMetrics['bySeverity'] = {
    CRITICAL: 0,
    HIGH: 0,
    MEDIUM: 0,
    LOW: 0,
  };
  const alertsByRoom = new Map<string, AlertResponse[]>();
  let overdueCount = 0;

  for (const alert of openAlerts) {
    const sev = alert.severity ?? 'MEDIUM';
    bySeverity[sev] = (bySeverity[sev] ?? 0) + 1;
    if (isAlertOverdue(alert, nowMs, overdueAlertMs)) {
      overdueCount += 1;
    }
    if (alert.roomId) {
      const list = alertsByRoom.get(alert.roomId) ?? [];
      list.push(alert);
      alertsByRoom.set(alert.roomId, list);
    }
  }

  const roomCounts: ManagerSummaryMetrics['roomCounts'] = {
    GOOD: 0,
    ATTENTION: 0,
    POOR: 0,
    NO_DATA: 0,
    total: rooms.length,
  };

  let latestMs = -Infinity;
  let lastUpdatedAt: string | null = null;

  for (const room of rooms) {
    const tel = roomTelemetryMap[room.id];
    const roomAlerts = alertsByRoom.get(room.id) ?? [];
    const health = classifyManagerRoomStatus(tel, roomAlerts, thresholds);
    roomCounts[health] += 1;

    if (tel?.timestamp && !tel.isSynthetic) {
      const parsed = Date.parse(tel.timestamp);
      if (Number.isFinite(parsed) && parsed > latestMs) {
        latestMs = parsed;
        lastUpdatedAt = tel.timestamp;
      }
    }
  }

  // Fallback to newest telemetry timestamp across map if some entries lacked matched rooms
  if (!lastUpdatedAt) {
    for (const tel of Object.values(roomTelemetryMap)) {
      if (tel?.timestamp && !tel.isSynthetic) {
        const parsed = Date.parse(tel.timestamp);
        if (Number.isFinite(parsed) && parsed > latestMs) {
          latestMs = parsed;
          lastUpdatedAt = tel.timestamp;
        }
      }
    }
  }

  return {
    totalOpenAlerts: openAlerts.length,
    bySeverity,
    overdueCount,
    roomCounts,
    lastUpdatedAt,
  };
}

function formatClockTimeVi(isoString: string | null): string {
  if (!isoString) return '--:--:--';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

export interface ManagerSummaryStripProps {
  metrics: ManagerSummaryMetrics;
  activeFilter: ManagerStatusFilter;
  onFilterChange: (nextFilter: ManagerStatusFilter) => void;
  stompConnected: boolean;
  nowMs?: number;
}

export function ManagerSummaryStrip({
  metrics,
  activeFilter,
  onFilterChange,
  stompConnected,
  nowMs = Date.now(),
}: ManagerSummaryStripProps) {
  const txt = FLOORPLAN_I18N_VI.summary;

  const severityBreakdown = useMemo(() => {
    const parts: string[] = [];
    (['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const).forEach((sev) => {
      const count = metrics.bySeverity[sev] ?? 0;
      if (count > 0) {
        parts.push(`${count} ${txt.severityLabels[sev]}`);
      }
    });
    return parts.join(' · ');
  }, [metrics.bySeverity, txt.severityLabels]);

  const toggleFilter = (key: ManagerStatusFilter) => {
    onFilterChange(activeFilter === key ? 'ALL' : key);
  };

  return (
    <section
      aria-label="Tóm tắt vận hành tòa nhà cho Quản lý"
      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200/90 bg-white px-3 py-2 shadow-xs"
    >
      {/* Cụm 1 & Cụm 2: Các ô trạng thái lọc 1 chạm */}
      <div
        role="group"
        aria-label="Bộ lọc trạng thái phòng theo dải tóm tắt"
        className="flex flex-wrap items-center gap-1.5"
      >
        {/* 1. Tổng số cảnh báo mở */}
        <button
          type="button"
          onClick={() => toggleFilter('ALERTS')}
          aria-pressed={activeFilter === 'ALERTS'}
          data-testid="summary-filter-alerts"
          className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors ${
            activeFilter === 'ALERTS'
              ? 'border-red-700 bg-red-700 text-white shadow-xs'
              : metrics.totalOpenAlerts > 0
                ? 'border-red-200 bg-red-50 text-red-900 hover:bg-red-100'
                : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
          }`}
        >
          <ShieldAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="tabular-nums">
            {metrics.totalOpenAlerts} {txt.openAlerts}
          </span>
          {severityBreakdown && (
            <span
              className={`hidden font-normal sm:inline ${
                activeFilter === 'ALERTS' ? 'text-red-100' : 'text-red-800'
              }`}
            >
              ({severityBreakdown})
            </span>
          )}
        </button>

        {/* 2. Cảnh báo tồn đọng lâu */}
        <button
          type="button"
          onClick={() => toggleFilter('OVERDUE')}
          aria-pressed={activeFilter === 'OVERDUE'}
          data-testid="summary-filter-overdue"
          className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors ${
            activeFilter === 'OVERDUE'
              ? 'border-amber-700 bg-amber-700 text-white shadow-xs'
              : metrics.overdueCount > 0
                ? 'border-amber-300 bg-amber-50 text-amber-950 hover:bg-amber-100'
                : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
          }`}
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="tabular-nums">
            {metrics.overdueCount} {txt.overdue}
          </span>
        </button>

        <span
          className="mx-0.5 hidden h-5 w-px bg-slate-200 sm:inline-block"
          aria-hidden="true"
        />

        {/* 3. Số phòng Tốt / Lưu ý / Xấu */}
        <button
          type="button"
          onClick={() => toggleFilter('GOOD')}
          aria-pressed={activeFilter === 'GOOD'}
          data-testid="summary-filter-good"
          className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors ${
            activeFilter === 'GOOD'
              ? 'border-emerald-700 bg-emerald-700 text-white shadow-xs'
              : 'border-emerald-200 bg-emerald-50/80 text-emerald-900 hover:bg-emerald-100'
          }`}
        >
          <span aria-hidden="true">●</span>
          <span className="tabular-nums">
            {metrics.roomCounts.GOOD} {txt.good}
          </span>
        </button>

        <button
          type="button"
          onClick={() => toggleFilter('ATTENTION')}
          aria-pressed={activeFilter === 'ATTENTION'}
          data-testid="summary-filter-attention"
          className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors ${
            activeFilter === 'ATTENTION'
              ? 'border-amber-700 bg-amber-700 text-white shadow-xs'
              : 'border-amber-200 bg-amber-50/80 text-amber-950 hover:bg-amber-100'
          }`}
        >
          <span aria-hidden="true">▲</span>
          <span className="tabular-nums">
            {metrics.roomCounts.ATTENTION} {txt.attention}
          </span>
        </button>

        <button
          type="button"
          onClick={() => toggleFilter('POOR')}
          aria-pressed={activeFilter === 'POOR'}
          data-testid="summary-filter-poor"
          className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors ${
            activeFilter === 'POOR'
              ? 'border-red-700 bg-red-700 text-white shadow-xs'
              : 'border-red-200 bg-red-50/80 text-red-900 hover:bg-red-100'
          }`}
        >
          <span aria-hidden="true">◆</span>
          <span className="tabular-nums">
            {metrics.roomCounts.POOR} {txt.poor}
          </span>
        </button>

        {activeFilter !== 'ALL' && (
          <button
            type="button"
            onClick={() => onFilterChange('ALL')}
            data-testid="summary-filter-reset"
            className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-100"
          >
            <FilterX className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{txt.allFilter}</span>
          </button>
        )}
      </div>

      {/* Cụm 3: Thời điểm cập nhật & trạng thái kênh thời gian thực */}
      <div className="flex items-center gap-3 text-xs text-slate-700">
        <span className="inline-flex items-center gap-1.5 font-medium tabular-nums">
          <Clock className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />
          <span>
            {txt.lastUpdated}: {formatRelativeTimeVi(metrics.lastUpdatedAt, nowMs)}
          </span>
          <span className="hidden font-mono text-[11px] text-slate-600 md:inline">
            ({formatClockTimeVi(metrics.lastUpdatedAt)})
          </span>
        </span>

        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
            stompConnected
              ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
              : 'border-amber-300 bg-amber-50 text-amber-950'
          }`}
        >
          <Radio className="h-3 w-3" aria-hidden="true" />
          <span>{stompConnected ? txt.realtimeOnline : txt.realtimeFallback}</span>
        </span>
      </div>
    </section>
  );
}
