'use client';

import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import type { RoomResponse } from '@/types/api';
import { useRoomLatestTelemetryQuery } from '@/features/telemetry/queries';
import { useRoomTelemetryStream } from '@/lib/realtime/use-room-stream';
import { formatMetrics } from '@/lib/format/metrics';
import {
  formatRelativeTimeVi,
  isTelemetryStale,
} from '@/lib/format/datetime';
import { GradeBadge, Skeleton } from '@/components/ui/primitives';

export interface RoomTelemetryCardProps {
  room: RoomResponse;
  stompConnected: boolean;
}

function RoomTelemetryCardComponent({
  room,
  stompConnected,
}: RoomTelemetryCardProps) {
  const [pulsing, setPulsing] = useState(false);
  const pulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const triggerPulse = useCallback(() => {
    setPulsing(true);
    if (pulseTimerRef.current) {
      clearTimeout(pulseTimerRef.current);
    }
    pulseTimerRef.current = setTimeout(() => {
      setPulsing(false);
    }, 300);
  }, []);

  useEffect(() => {
    return () => {
      if (pulseTimerRef.current) {
        clearTimeout(pulseTimerRef.current);
      }
    };
  }, []);

  const { data: latest, isLoading } = useRoomLatestTelemetryQuery(
    room.id,
    stompConnected
  );

  useRoomTelemetryStream(room.id, triggerPulse);

  const overallScore = latest?.comfortScore?.overall ?? null;
  const grade = latest?.comfortScore?.grade ?? 'N/A';

  return (
    <div
      className={`card-interactive flex flex-col justify-between p-4 ${
        pulsing ? 'realtime-pulse' : ''
      }`}
    >
      <div>
        {/* Card Header: Code, Floor, Name & Comfort Score + Grade Badge */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5 text-2xs text-slate-500">
              <span className="font-mono font-semibold text-slate-700">
                {room.code}
              </span>
              <span>·</span>
              <span>Tầng {room.floor}</span>
              {(room.id.startsWith('PRESET_') || latest?.isSynthetic) && (
                <span className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                  Mô phỏng
                </span>
              )}
              {latest &&
                isTelemetryStale(
                  latest.timestamp,
                  Date.now(),
                  latest.isSynthetic
                ) && (
                  <span
                    className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800"
                    title="Chưa nhận mẫu đo mới trong hơn 5 phút"
                  >
                    Dữ liệu cũ
                  </span>
                )}
            </div>
            <h3 className="mt-0.5 truncate text-sm font-semibold text-slate-900">
              {room.name}
            </h3>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {latest && (
              <span className="font-mono text-sm font-semibold tabular-nums text-slate-900">
                {formatMetrics.comfortScore(overallScore)}
                <span className="text-2xs font-normal text-slate-400">
                  /100
                </span>
              </span>
            )}
            <GradeBadge grade={grade} score={overallScore} />
          </div>
        </div>

        {/* Body Content */}
        {isLoading ? (
          <div className="mt-3 grid grid-cols-4 gap-2">
            <Skeleton className="h-11" />
            <Skeleton className="h-11" />
            <Skeleton className="h-11" />
            <Skeleton className="h-11" />
          </div>
        ) : latest === null || latest === undefined ? (
          <div className="mt-3 flex items-center justify-center rounded-lg border border-dashed border-slate-200 bg-slate-50/40 px-3 py-4 text-xs text-slate-400">
            Chờ dữ liệu cảm biến
          </div>
        ) : (
          <div className="mt-3 grid grid-cols-4 gap-1.5">
            <div className="rounded-lg border border-slate-100 bg-slate-50/40 px-2 py-1.5">
              <span className="block text-2xs text-slate-500">Nhiệt độ</span>
              <span className="mt-0.5 block text-xs font-semibold tabular-nums text-slate-800">
                {formatMetrics.temperature(latest.environment?.temperature)}
              </span>
            </div>
            <div className="rounded-lg border border-slate-100 bg-slate-50/40 px-2 py-1.5">
              <span className="block text-2xs text-slate-500">Độ ẩm</span>
              <span className="mt-0.5 block text-xs font-semibold tabular-nums text-slate-800">
                {formatMetrics.humidity(latest.environment?.humidity)}
              </span>
            </div>
            <div className="rounded-lg border border-slate-100 bg-slate-50/40 px-2 py-1.5">
              <span className="block text-2xs text-slate-500">Độ ồn</span>
              <span className="mt-0.5 block text-xs font-semibold tabular-nums text-slate-800">
                {formatMetrics.noise(latest.acoustics?.noiseAvg)}
              </span>
            </div>
            <div className="rounded-lg border border-slate-100 bg-slate-50/40 px-2 py-1.5">
              <span className="block text-2xs text-slate-500">PM2.5</span>
              <span className="mt-0.5 block text-xs font-semibold tabular-nums text-slate-800">
                {formatMetrics.pm(latest.airQuality?.pm2_5)}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Footer Link to M05 */}
      <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-2 text-2xs text-slate-400">
        <span className="truncate">
          {latest?.timestamp
            ? formatRelativeTimeVi(latest.timestamp)
            : 'Chưa có mẫu đo'}
        </span>
        <Link
          href={`/rooms/${room.id}`}
          className="inline-flex items-center gap-0.5 font-medium text-slate-700 hover:text-slate-900"
        >
          Chi tiết
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}

export const RoomTelemetryCard = memo(RoomTelemetryCardComponent);
