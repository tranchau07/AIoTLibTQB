'use client';

import React from 'react';
import type { HeatmapLayerMetric } from '@/config/thresholds';
import {
  METRIC_LAYER_META,
  WEATHER_PALETTES,
  getPaletteCssGradient,
} from '@/lib/floorplan/weatherPalette';
import type { RoomType } from '@/types/api';

export interface FloorplanLegendProps {
  layer: HeatmapLayerMetric;
  onlyExceedingThreshold?: boolean;
  activeRoomTypes?: readonly RoomType[];
  showReliabilityKey?: boolean;
  className?: string;
}

export function FloorplanLegend({
  layer,
  onlyExceedingThreshold = false,
  activeRoomTypes = [],
  showReliabilityKey = false,
  className = '',
}: FloorplanLegendProps) {
  const meta = METRIC_LAYER_META[layer];
  const stops = WEATHER_PALETTES[layer] || WEATHER_PALETTES.temperature;
  const hasBookStorage = activeRoomTypes.includes('BOOK_STORAGE');

  return (
    <section
      data-testid="floorplan-legend"
      aria-label={`Chú giải thang màu chỉ số ${meta.label}`}
      className={`card space-y-2 px-3.5 py-2.5 text-xs ${className}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span
            data-testid="legend-metric-unit"
            className="font-semibold text-slate-900"
          >
            {meta.label} ({meta.unitLabel})
          </span>
          {onlyExceedingThreshold && (
            <span className="rounded-md border border-amber-700/30 bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-950">
              ISA-101: Chỉ hiện vùng vượt ngưỡng
            </span>
          )}
          {meta.storageNoteVi && (hasBookStorage || layer === 'humidity') && (
            <span className="rounded-md border border-sky-700/30 bg-sky-100 px-2 py-0.5 text-[11px] font-medium text-sky-950">
              {meta.storageNoteVi}
            </span>
          )}
        </div>

        {/* Non-colorblind dependent geometric status legend (WCAG 2.2 AA contrast) */}
        <div className="flex flex-wrap items-center gap-2 text-[11px] font-medium">
          <span className="inline-flex items-center gap-1 rounded border border-sky-700/30 bg-sky-50 px-1.5 py-0.5 text-sky-950">
            <span aria-hidden="true" className="text-sky-700">
              ●
            </span>
            <span>Đạt chuẩn: {meta.normalRangeVi}</span>
          </span>
          <span className="inline-flex items-center gap-1 rounded border border-amber-700/30 bg-amber-50 px-1.5 py-0.5 text-amber-950">
            <span aria-hidden="true" className="text-amber-700">
              ▲
            </span>
            <span>Lưu ý: {meta.attentionThresholdVi}</span>
          </span>
          <span className="inline-flex items-center gap-1 rounded border border-rose-800/30 bg-rose-50 px-1.5 py-0.5 text-rose-950">
            <span aria-hidden="true" className="text-rose-800">
              ◆
            </span>
            <span>Vượt ngưỡng: {meta.criticalThresholdVi}</span>
          </span>
        </div>
      </div>

      <div>
        <div
          data-testid="legend-gradient-bar"
          className="h-2.5 w-full rounded-full border border-slate-300"
          style={{ background: getPaletteCssGradient(layer) }}
          aria-hidden="true"
        />
        <div className="mt-1 flex flex-wrap justify-between gap-2 font-mono text-[11px] text-slate-700">
          {stops.map((stop, idx) => (
            <span key={idx}>{stop.label}</span>
          ))}
        </div>
      </div>

      {showReliabilityKey && (
        <div
          data-testid="legend-reliability-key"
          className="flex flex-wrap items-center gap-3 border-t border-slate-200 pt-1.5 text-[11px] text-slate-700"
        >
          <span className="font-semibold text-slate-900">Độ tin cậy:</span>
          <span>● Đo trực tiếp</span>
          <span>◐ Ước lượng nội suy</span>
          <span>▨ Vùng mù (chưa có cảm biến)</span>
          <span>⌛ Dữ liệu trễ (&gt; 5 phút)</span>
        </div>
      )}
    </section>
  );
}
