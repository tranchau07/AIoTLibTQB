'use client';

import React from 'react';
import {
  Check,
  Clock,
  Download,
  FileText,
  History,
  Link2,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Sun,
} from 'lucide-react';
import type {
  EventPlaybackFrame,
  FloorplanTimeMode,
} from '@/lib/floorplan/timeAnalysis';
import { FLOORPLAN_I18N_VI } from '@/messages/vi';

export interface TimeComparisonBarProps {
  timeMode: FloorplanTimeMode;
  onTimeModeChange: (mode: FloorplanTimeMode) => void;
  frames?: readonly EventPlaybackFrame[];
  playbackIndex?: number;
  onPlaybackIndexChange?: (idx: number) => void;
  isPlaying?: boolean;
  onTogglePlay?: () => void;
  typicalHour?: number;
  onTypicalHourChange?: (hour: number) => void;
  typicalSummaryNote?: string;
  onCopyDeepLink?: () => void;
  deepLinkCopied?: boolean;
  onExportPng?: () => void;
  onExportPdf?: () => void;
  className?: string;
}

const TIME_MODES: ReadonlyArray<{
  key: FloorplanTimeMode;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { key: 'live', label: FLOORPLAN_I18N_VI.timeAnalysis.modes.live, icon: Clock },
  {
    key: 'compare_1h',
    label: FLOORPLAN_I18N_VI.timeAnalysis.modes.compare_1h,
    icon: History,
  },
  {
    key: 'playback',
    label: FLOORPLAN_I18N_VI.timeAnalysis.modes.playback,
    icon: Play,
  },
  {
    key: 'typical_day',
    label: FLOORPLAN_I18N_VI.timeAnalysis.modes.typical_day,
    icon: Sun,
  },
];

function formatClockHhMm(iso: string | null | undefined): string {
  if (!iso) return '--:--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--';
  return new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

export function TimeComparisonBar({
  timeMode,
  onTimeModeChange,
  frames = [],
  playbackIndex = 0,
  onPlaybackIndexChange,
  isPlaying = false,
  onTogglePlay,
  typicalHour = 15,
  onTypicalHourChange,
  typicalSummaryNote,
  onCopyDeepLink,
  deepLinkCopied = false,
  onExportPng,
  onExportPdf,
  className = '',
}: TimeComparisonBarProps) {
  const safeFrameIdx =
    frames.length > 0 ? Math.max(0, Math.min(frames.length - 1, playbackIndex)) : 0;
  const activeFrame = frames[safeFrameIdx] ?? null;
  const clampedHour = Math.max(7, Math.min(21, Math.round(typicalHour)));

  return (
    <section
      data-testid="time-comparison-bar"
      aria-label={FLOORPLAN_I18N_VI.timeAnalysis.groupAriaLabel}
      className={`rounded-xl border border-slate-200/85 bg-white px-3 py-1.5 shadow-2xs ${className}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* Time Mode Selector */}
        <div
          role="group"
          aria-label="Chế độ chiều thời gian"
          className="flex flex-wrap items-center gap-1"
        >
          {TIME_MODES.map(({ key, label, icon: Icon }) => {
            const active = timeMode === key;
            return (
              <button
                key={key}
                type="button"
                data-testid={`time-mode-${key}`}
                aria-pressed={active}
                onClick={() => onTimeModeChange(key)}
                className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold transition-colors ${
                  active
                    ? 'bg-sky-700 text-white shadow-2xs'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                }`}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{label}</span>
              </button>
            );
          })}
        </div>

        {/* Share & Report Exports */}
        <div className="flex flex-wrap items-center gap-1.5">
          {onCopyDeepLink && (
            <button
              type="button"
              data-testid="copy-deeplink-btn"
              onClick={onCopyDeepLink}
              className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs font-semibold transition-colors ${
                deepLinkCopied
                  ? 'border-emerald-700 bg-emerald-50 text-emerald-900'
                  : 'border-slate-300 bg-white text-slate-800 hover:bg-slate-50'
              }`}
              title="Sao chép liên kết giữ nguyên tầng, phòng, chỉ số, zoom và mốc thời gian"
            >
              {deepLinkCopied ? (
                <Check className="h-3.5 w-3.5 text-emerald-700" aria-hidden="true" />
              ) : (
                <Link2 className="h-3.5 w-3.5 text-slate-600" aria-hidden="true" />
              )}
              <span>
                {deepLinkCopied
                  ? FLOORPLAN_I18N_VI.controls.deepLinkCopied
                  : FLOORPLAN_I18N_VI.controls.copyDeepLink}
              </span>
            </button>
          )}

          {onExportPng && (
            <button
              type="button"
              data-testid="export-png-btn"
              onClick={onExportPng}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-800 transition-colors hover:bg-slate-50"
              title="Tải ảnh PNG chuẩn trình chiếu (bản đồ + chú giải + tóm tắt cảnh báo)"
            >
              <Download className="h-3.5 w-3.5 text-sky-700" aria-hidden="true" />
              <span>{FLOORPLAN_I18N_VI.controls.exportPng}</span>
            </button>
          )}

          {onExportPdf && (
            <button
              type="button"
              data-testid="export-pdf-btn"
              onClick={onExportPdf}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-800 transition-colors hover:bg-slate-50"
              title="Xuất báo cáo in / PDF khổ A4 ngang dùng ngay cho cuộc họp"
            >
              <FileText className="h-3.5 w-3.5 text-rose-700" aria-hidden="true" />
              <span>{FLOORPLAN_I18N_VI.controls.exportPdf}</span>
            </button>
          )}
        </div>
      </div>

      {/* Sub-bar 1: Event Playback Scrubber & Incident Propagation Readout */}
      {timeMode === 'playback' && (
        <div
          data-testid="playback-subbar"
          className="mt-1.5 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-1.5 text-xs"
        >
          <div className="flex flex-1 flex-wrap items-center gap-2 min-w-[260px]">
            <button
              type="button"
              data-testid="playback-prev-btn"
              disabled={safeFrameIdx <= 0}
              onClick={() => onPlaybackIndexChange?.(Math.max(0, safeFrameIdx - 1))}
              aria-label={FLOORPLAN_I18N_VI.timeAnalysis.playbackStepPrev}
              className="flex h-7 w-7 items-center justify-center rounded border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-40"
            >
              <SkipBack className="h-3.5 w-3.5" aria-hidden="true" />
            </button>

            <button
              type="button"
              data-testid="playback-toggle-btn"
              disabled={frames.length < 2}
              onClick={() => onTogglePlay?.()}
              className="inline-flex h-7 items-center gap-1 rounded border border-sky-700 bg-sky-700 px-2.5 text-xs font-semibold text-white hover:bg-sky-800 disabled:opacity-40"
            >
              {isPlaying ? (
                <>
                  <Pause className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{FLOORPLAN_I18N_VI.timeAnalysis.playbackPause}</span>
                </>
              ) : (
                <>
                  <Play className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{FLOORPLAN_I18N_VI.timeAnalysis.playbackPlay}</span>
                </>
              )}
            </button>

            <button
              type="button"
              data-testid="playback-next-btn"
              disabled={frames.length === 0 || safeFrameIdx >= frames.length - 1}
              onClick={() =>
                onPlaybackIndexChange?.(
                  Math.min(frames.length - 1, safeFrameIdx + 1)
                )
              }
              aria-label={FLOORPLAN_I18N_VI.timeAnalysis.playbackStepNext}
              className="flex h-7 w-7 items-center justify-center rounded border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-40"
            >
              <SkipForward className="h-3.5 w-3.5" aria-hidden="true" />
            </button>

            <input
              type="range"
              data-testid="playback-slider"
              aria-label="Thanh tua mốc phát lại sự kiện"
              min={0}
              max={Math.max(0, frames.length - 1)}
              step={1}
              value={safeFrameIdx}
              disabled={frames.length === 0}
              onChange={(e) =>
                onPlaybackIndexChange?.(Number(e.target.value) || 0)
              }
              className="h-1.5 min-w-[140px] flex-1 accent-sky-700"
            />

            <span
              data-testid="playback-timestamp"
              className="rounded bg-slate-100 px-2 py-0.5 font-mono text-[11px] font-semibold text-slate-800 tabular-nums"
            >
              {activeFrame
                ? `${formatClockHhMm(activeFrame.timestamp)} (${safeFrameIdx + 1}/${frames.length})`
                : 'Chưa có mốc lịch sử'}
            </span>
          </div>

          <div
            data-testid="playback-propagation-summary"
            className="flex flex-wrap items-center gap-1.5 text-[11px]"
          >
            {activeFrame && activeFrame.exceedingRooms.length > 0 ? (
              activeFrame.exceedingRooms.slice(0, 4).map((rm) => (
                <span
                  key={rm.roomId}
                  className={`rounded border px-2 py-0.5 font-semibold ${
                    rm.propagationRole === 'ORIGIN'
                      ? 'border-red-400 bg-red-50 text-red-900'
                      : 'border-amber-400 bg-amber-50 text-amber-950'
                  }`}
                >
                  {rm.shortCode}: {rm.propagationLabelVi}
                </span>
              ))
            ) : (
              <span className="text-slate-600">
                {FLOORPLAN_I18N_VI.timeAnalysis.playbackNoEvents}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Sub-bar 2: Typical Day Hourly Profile Slider (07:00 - 21:00) */}
      {timeMode === 'typical_day' && (
        <div
          data-testid="typical-day-subbar"
          className="mt-1.5 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-1.5 text-xs"
        >
          <div className="flex flex-1 flex-wrap items-center gap-2.5 min-w-[260px]">
            <span className="font-semibold text-slate-700">
              Khung giờ ({FLOORPLAN_I18N_VI.timeAnalysis.typicalDayHourRange}):
            </span>
            <input
              type="range"
              data-testid="typical-hour-slider"
              aria-label="Chọn giờ trong ngày điển hình từ 7 giờ đến 21 giờ"
              min={7}
              max={21}
              step={1}
              value={clampedHour}
              onChange={(e) =>
                onTypicalHourChange?.(Number(e.target.value) || 15)
              }
              className="h-1.5 min-w-[160px] flex-1 accent-sky-700"
            />
            <span
              data-testid="typical-hour-label"
              className="rounded bg-sky-900 px-2 py-0.5 font-mono text-[11px] font-bold text-white tabular-nums"
            >
              {String(clampedHour).padStart(2, '0')}:00
            </span>
          </div>
          {typicalSummaryNote && (
            <span
              data-testid="typical-day-summary"
              className="text-[11px] font-medium text-slate-700"
            >
              {typicalSummaryNote}
            </span>
          )}
        </div>
      )}
    </section>
  );
}
