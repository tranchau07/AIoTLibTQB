'use client';

import React from 'react';
import { ArrowUpRight } from 'lucide-react';
import type { HeatmapLayerMetric } from '@/config/thresholds';
import { formatLayerMetricValue } from '@/features/floorplan/components/FloorplanCanvas';
import type { RoomReliabilitySummary } from '@/lib/floorplan/reliability';
import type {
  OneHourDeltaResult,
  PlaybackRoomState,
} from '@/lib/floorplan/timeAnalysis';
import {
  METRIC_LAYER_META,
  getMetricStatusSymbol,
} from '@/lib/floorplan/weatherPalette';
import type { RoomResponse, RoomType } from '@/types/api';

export interface RoomHoverPopoverProps {
  room: RoomResponse;
  layer: HeatmapLayerMetric;
  value: number | null | undefined;
  historyValues?: readonly number[];
  oneHourDelta?: OneHourDeltaResult | null;
  playbackState?: PlaybackRoomState | null;
  openAlertsCount?: number;
  preset?: { areaM2?: number; roomType?: RoomType } | null;
  reliability?: RoomReliabilitySummary | null;
  onInspectRoom?: (room: RoomResponse) => void;
  className?: string;
}

const ROOM_TYPE_LABEL_VI: Record<RoomType, string> = {
  STUDY_ROOM: 'Phòng đọc',
  BOOK_STORAGE: 'Kho sách / Bảo quản',
  CIRCULATION_HALL: 'Sảnh lưu thông',
};

function buildSparklinePoints(
  values: readonly number[],
  width = 148,
  height = 30
): { polyline: string; lastX: number; lastY: number } {
  const safe = values.length > 0 ? values : [0];
  const minVal = Math.min(...safe);
  const maxVal = Math.max(...safe);
  const span = Math.max(0.01, maxVal - minVal);
  const padX = 4;
  const padY = 4;
  const usableW = Math.max(1, width - padX * 2);
  const usableH = Math.max(1, height - padY * 2);

  if (safe.length === 1) {
    const midY = height / 2;
    return {
      polyline: `${padX},${midY.toFixed(1)} ${(width - padX).toFixed(1)},${midY.toFixed(1)}`,
      lastX: width - padX,
      lastY: midY,
    };
  }

  const pts = safe.map((v, idx) => {
    const x = padX + (idx / (safe.length - 1)) * usableW;
    const normY = (v - minVal) / span;
    const y = padY + (1 - normY) * usableH;
    return { x, y };
  });

  const last = pts[pts.length - 1];
  return {
    polyline: pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '),
    lastX: last.x,
    lastY: last.y,
  };
}

export function RoomHoverPopover({
  room,
  layer,
  value,
  historyValues,
  oneHourDelta,
  playbackState,
  openAlertsCount = 0,
  preset,
  reliability,
  onInspectRoom,
  className = '',
}: RoomHoverPopoverProps) {
  const effectiveRoomType = room.type ?? preset?.roomType ?? 'STUDY_ROOM';
  const status = getMetricStatusSymbol(
    layer,
    value,
    effectiveRoomType,
    room.thresholds
  );
  const meta = METRIC_LAYER_META[layer];

  const series =
    historyValues && historyValues.length > 0
      ? historyValues
      : typeof value === 'number' && Number.isFinite(value)
        ? [value]
        : [];
  const spark = buildSparklinePoints(series);

  const badgeClass =
    status.level === 'CRITICAL'
      ? 'border-rose-400/50 bg-rose-950/90 text-rose-100'
      : status.level === 'WARNING'
        ? 'border-amber-400/50 bg-amber-950/90 text-amber-100'
        : status.level === 'NO_DATA'
          ? 'border-slate-500/50 bg-slate-800 text-slate-200'
          : 'border-sky-400/40 bg-sky-950/85 text-sky-100';

  const strokeColor =
    status.level === 'CRITICAL'
      ? '#FCA5A5'
      : status.level === 'WARNING'
        ? '#FDE047'
        : '#38BDF8';

  return (
    <div
      data-testid="room-hover-popover"
      role="dialog"
      aria-label={`Thông tin nhanh ${room.code} ${room.name}`}
      className={`w-72 rounded-xl border border-slate-700 bg-slate-950/95 p-3 text-xs text-slate-50 shadow-2xl backdrop-blur ${className}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-300">
            <span className="font-mono font-bold text-slate-100">
              {room.code}
            </span>
            <span>·</span>
            <span>{ROOM_TYPE_LABEL_VI[effectiveRoomType]}</span>
            {openAlertsCount > 0 && (
              <span className="rounded bg-rose-700 px-1.5 py-0.5 font-mono text-[10px] font-bold text-white">
                !{openAlertsCount}
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate text-xs font-semibold text-slate-50">
            {room.name}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="font-mono text-sm font-bold text-sky-300 tabular-nums">
            {formatLayerMetricValue(value, layer)}
          </p>
          <p className="text-[10px] text-slate-300">{meta.shortLabel}</p>
        </div>
      </div>

      {oneHourDelta && (
        <div
          data-testid="popover-delta-1h"
          className="mt-1.5 flex items-center justify-between gap-2 rounded border border-slate-800 bg-slate-900/90 px-2 py-1 text-[11px]"
        >
          <span className="text-slate-300">So với 1 giờ trước</span>
          <span
            className={`font-mono font-semibold tabular-nums ${
              !oneHourDelta.hasBaseline
                ? 'text-slate-400'
                : oneHourDelta.trend === 'STABLE'
                  ? 'text-slate-200'
                  : (layer === 'comfortScore' || layer === 'wifiRssi')
                    ? oneHourDelta.trend === 'DOWN'
                      ? 'text-rose-300'
                      : 'text-emerald-300'
                    : oneHourDelta.trend === 'UP'
                      ? 'text-amber-300'
                      : 'text-emerald-300'
            }`}
          >
            {oneHourDelta.text}
          </span>
        </div>
      )}

      {playbackState?.propagationLabelVi && (
        <div
          data-testid="popover-playback-role"
          className={`mt-1.5 rounded border px-2 py-1 text-[11px] font-semibold ${
            playbackState.propagationRole === 'ORIGIN'
              ? 'border-rose-400/60 bg-rose-950/90 text-rose-100'
              : playbackState.propagationRole === 'SPREAD'
                ? 'border-amber-400/60 bg-amber-950/90 text-amber-100'
                : 'border-emerald-400/50 bg-emerald-950/80 text-emerald-100'
          }`}
        >
          Diễn biến: {playbackState.propagationLabelVi}
        </div>
      )}

      {/* Status + Threshold Comparison */}
      <div
        className={`mt-2 flex items-center justify-between gap-2 rounded-lg border px-2 py-1 text-[11px] font-semibold ${badgeClass}`}
      >
        <span className="flex items-center gap-1">
          <span aria-hidden="true">{status.symbol}</span>
          <span>{status.labelVi}</span>
        </span>
        <span className="shrink-0 font-mono text-[10px] opacity-90">
          {status.thresholdSummaryVi}
        </span>
      </div>

      {/* Short Trend Sparkline */}
      <div className="mt-2 rounded-lg border border-slate-800 bg-slate-900/90 px-2 py-1.5">
        <div className="mb-1 flex items-center justify-between text-[10px] text-slate-300">
          <span>Xu hướng gần đây ({series.length} mẫu)</span>
          {series.length >= 2 && (
            <span className="font-mono">
              {series[0].toFixed(1)} → {series[series.length - 1].toFixed(1)}
            </span>
          )}
        </div>
        <svg
          data-testid="popover-sparkline"
          viewBox="0 0 148 30"
          className="h-7 w-full overflow-visible"
          aria-hidden="true"
        >
          <polyline
            fill="none"
            stroke={strokeColor}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            points={spark.polyline}
          />
          {series.length > 0 && (
            <circle cx={spark.lastX} cy={spark.lastY} r="2.8" fill={strokeColor} />
          )}
        </svg>
      </div>

      {/* Data Reliability Summary (Manager-friendly wording) */}
      {reliability && (
        <div
          data-testid="popover-reliability"
          className="mt-2 rounded-lg border border-slate-800 bg-slate-900/80 px-2 py-1.5 text-[11px]"
          title={reliability.tooltipText}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold text-slate-200">
              Độ tin cậy: {reliability.badgeText}
            </span>
            <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-sky-200">
              {reliability.qualityLabel}
            </span>
          </div>
          <p className="mt-0.5 text-[10px] leading-snug text-slate-300">
            {reliability.tooltipText}
          </p>
        </div>
      )}

      {onInspectRoom && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onInspectRoom(room);
          }}
          className="mt-2 flex w-full items-center justify-center gap-1 rounded-lg bg-sky-500 px-2.5 py-1.5 text-xs font-semibold text-slate-950 transition-colors hover:bg-sky-400"
        >
          <span>
            {status.isExceedingThreshold || openAlertsCount > 0
              ? 'Xử lý & Xem chi tiết'
              : 'Mở chi tiết phòng'}
          </span>
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
