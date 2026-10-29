'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ChevronRight, Map, Radio } from 'lucide-react';
import type { BucketInterval } from '@/types/api';
import { useRoomDetailQuery } from '@/features/rooms/queries';
import {
  useRoomBucketsQuery,
  useRoomLatestTelemetryQuery,
} from '@/features/telemetry/queries';
import {
  useRoomTelemetryStream,
  useStompConnectionState,
} from '@/lib/realtime/use-room-stream';
import {
  formatMetrics,
  formatNumber,
  recommendIntervalForRange,
  validateBucketRange,
} from '@/lib/format/metrics';
import {
  formatRelativeTimeVi,
  formatVietnamDateTime,
} from '@/lib/format/datetime';
import { getGradeStyle } from '@/config/thresholds';
import { ERROR_MESSAGES_VI } from '@/messages/vi';
import {
  ErrorBanner,
  GradeBadge,
  Skeleton,
} from '@/components/ui/primitives';
import { MinMaxAvgChart } from '@/features/telemetry/components/MinMaxAvgChart';

function toLocalDateTimeInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate()
  )}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export default function RoomDetailPage() {
  const params = useParams<{ id: string }>();
  const roomId = typeof params?.id === 'string' ? params.id : '';
  const stompConnected = useStompConnectionState();

  const [pulsing, setPulsing] = useState(false);
  const pulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const triggerPulse = useCallback(() => {
    setPulsing(true);
    if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current);
    pulseTimerRef.current = setTimeout(() => setPulsing(false), 300);
  }, []);

  useEffect(() => {
    return () => {
      if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current);
    };
  }, []);

  const [startLocal, setStartLocal] = useState<string>(() => {
    const d = new Date(Date.now() - 24 * 3600 * 1000);
    return toLocalDateTimeInputValue(d);
  });
  const [endLocal, setEndLocal] = useState<string>(() =>
    toLocalDateTimeInputValue(new Date())
  );
  const [interval, setIntervalState] = useState<BucketInterval>('15m');

  const startIso = useMemo(() => {
    const d = new Date(startLocal);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString();
  }, [startLocal]);

  const endIso = useMemo(() => {
    const d = new Date(endLocal);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString();
  }, [endLocal]);

  const bucketValidation = useMemo(
    () => validateBucketRange(startIso, endIso, interval),
    [startIso, endIso, interval]
  );

  const applyQuickPreset = (hours: number, suggestedInterval: BucketInterval) => {
    const now = new Date();
    const past = new Date(now.getTime() - hours * 3600 * 1000);
    setStartLocal(toLocalDateTimeInputValue(past));
    setEndLocal(toLocalDateTimeInputValue(now));
    setIntervalState(suggestedInterval);
  };

  const handleAutoRecommendInterval = () => {
    if (!startIso || !endIso) return;
    const recommended = recommendIntervalForRange(startIso, endIso);
    setIntervalState(recommended);
  };

  const roomQuery = useRoomDetailQuery(roomId);
  const latestQuery = useRoomLatestTelemetryQuery(roomId, stompConnected);
  useRoomTelemetryStream(roomId, triggerPulse);

  const bucketsQuery = useRoomBucketsQuery({
    roomId,
    interval,
    start: startIso,
    end: endIso,
  });

  const room = roomQuery.data;
  const latest = latestQuery.data;
  const overallScore = latest?.comfortScore?.overall ?? null;
  const grade = latest?.comfortScore?.grade ?? 'N/A';
  const gradeStyle = getGradeStyle(grade, overallScore);

  const normalizedScore =
    overallScore !== null && !Number.isNaN(overallScore)
      ? Math.max(0, Math.min(100, overallScore))
      : 0;
  const gaugeRadius = 76;
  const gaugeCircumference = Math.PI * gaugeRadius;
  const gaugeStrokeDashoffset =
    gaugeCircumference * (1 - normalizedScore / 100);

  const subScores = [
    {
      key: 'acousticScore',
      label: 'Âm học (Độ yên tĩnh)',
      score: latest?.comfortScore?.acousticScore ?? null,
    },
    {
      key: 'airScore',
      label: 'Chất lượng không khí (PM2.5)',
      score: latest?.comfortScore?.airScore ?? null,
    },
    {
      key: 'thermalScore',
      label: 'Vi khí hậu (Nhiệt - Ẩm)',
      score: latest?.comfortScore?.thermalScore ?? null,
    },
    {
      key: 'lightScore',
      label: 'Chiếu sáng (Độ rọi)',
      score: latest?.comfortScore?.lightScore ?? null,
    },
  ];

  return (
    <div className="page">
      {/* Breadcrumb & Header */}
      <div className="space-y-1">
        <div className="flex items-center gap-1.5 text-xs text-slate-500">
          <Link href="/dashboard" className="text-slate-500 hover:text-slate-900">
            Tổng quan
          </Link>
          <ChevronRight className="h-3 w-3 text-slate-400" />
          <span className="font-medium text-slate-900">Chi tiết phòng đọc</span>
        </div>

        <div className="page-header pt-1">
          <div>
            {roomQuery.isLoading ? (
              <Skeleton className="h-7 w-48" />
            ) : room ? (
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="page-title">{room.name}</h1>
                <span className="rounded bg-slate-100 px-2 py-0.5 font-mono text-2xs font-medium text-slate-700">
                  {room.code} · Tầng {room.floor}
                </span>
                {room.capacity !== undefined && (
                  <span className="text-xs text-slate-500">
                    Sức chứa: {room.capacity} chỗ
                  </span>
                )}
              </div>
            ) : (
              <h1 className="page-title">Phòng #{roomId}</h1>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Link href="/floorplan" className="btn-secondary btn-sm">
              <Map className="h-4 w-4" aria-hidden="true" />
              Bản đồ tầng
            </Link>
          </div>
        </div>
      </div>

      {roomQuery.isError && (
        <ErrorBanner
          message="Không thể tải thông tin chi tiết phòng đọc."
          onRetry={() => void roomQuery.refetch()}
        />
      )}

      {/* Top Section: Semicircle Comfort Gauge + 4 Sub-scores & Live Sensor Readout */}
      <div
        className={`grid grid-cols-1 gap-4 lg:grid-cols-12 ${
          pulsing ? 'realtime-pulse' : ''
        }`}
      >
        {/* Semicircle Comfort Score Gauge + Component Progress Bars */}
        <div className="card flex flex-col justify-between p-5 lg:col-span-5">
          <div>
            <div className="flex items-center justify-between gap-2 border-b border-slate-100 pb-3">
              <h2 className="section-title">Chỉ số tiện nghi tổng hợp</h2>
              <GradeBadge grade={grade} score={overallScore} />
            </div>

            {/* Semicircle SVG Gauge */}
            <div className="mt-4 flex flex-col items-center">
              <svg
                viewBox="0 0 200 115"
                className="w-48 overflow-visible"
                role="img"
                aria-label={`Đồng hồ điểm tiện nghi ${formatMetrics.comfortScore(
                  overallScore
                )} trên 100`}
              >
                <path
                  d="M 24 96 A 76 76 0 0 1 176 96"
                  fill="none"
                  stroke="#F1F5F9"
                  strokeWidth={10}
                  strokeLinecap="round"
                />
                <path
                  d="M 24 96 A 76 76 0 0 1 176 96"
                  fill="none"
                  stroke={gradeStyle.hex}
                  strokeWidth={10}
                  strokeLinecap="round"
                  strokeDasharray={gaugeCircumference}
                  strokeDashoffset={gaugeStrokeDashoffset}
                  className="transition-all duration-500 ease-out"
                />
                <text
                  x="100"
                  y="74"
                  textAnchor="middle"
                  className="fill-slate-900 text-3xl font-semibold tabular-nums"
                >
                  {formatMetrics.comfortScore(overallScore)}
                </text>
                <text
                  x="100"
                  y="94"
                  textAnchor="middle"
                  className="fill-slate-400 text-xs"
                >
                  / 100 điểm
                  {room?.targetComfortScore
                    ? ` (Mục tiêu ≥ ${room.targetComfortScore})`
                    : ''}
                </text>
              </svg>
            </div>

            {/* 4 Sub-score Progress Bars */}
            <div className="mt-4 space-y-2.5">
              {subScores.map((sub) => {
                const pct =
                  sub.score !== null && !Number.isNaN(sub.score)
                    ? Math.max(0, Math.min(100, sub.score))
                    : 0;
                const subStyle = getGradeStyle(undefined, sub.score);
                return (
                  <div key={sub.key} className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-600">{sub.label}</span>
                      <span className="font-semibold tabular-nums text-slate-800">
                        {formatNumber(sub.score, 0)} / 100
                      </span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                      <div
                        className="h-full rounded-full transition-all duration-300"
                        style={{
                          width: `${pct}%`,
                          backgroundColor: subStyle.hex,
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="mt-4 border-t border-slate-100 pt-2.5 text-2xs text-slate-400">
            {latest?.timestamp ? (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>Trạm phát: <strong className="font-mono text-slate-600">{latest.metadata?.hardwareId}</strong></span>
                <span>{formatRelativeTimeVi(latest.timestamp)} ({formatVietnamDateTime(latest.timestamp)})</span>
              </div>
            ) : (
              <span>Đang chờ bản tin đầu tiên từ trạm đo...</span>
            )}
          </div>
        </div>

        {/* Live Telemetry Matrix */}
        <div className="card p-5 lg:col-span-7">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
            <div>
              <h2 className="section-title">Thông số cảm biến thời gian thực</h2>
              <p className="text-xs text-slate-500">
                Kênh luồng trực tiếp `/topic/rooms/{roomId}/telemetry`
              </p>
            </div>
            <span className="badge-neutral">
              <Radio className={`h-3 w-3 ${stompConnected ? 'text-emerald-500 animate-pulse' : 'text-slate-400'}`} />
              {stompConnected ? 'STOMP Trực tiếp' : 'Định kỳ 15s'}
            </span>
          </div>

          {latestQuery.isLoading ? (
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
            </div>
          ) : (
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
              <div className="rounded-lg border border-slate-100 bg-slate-50/50 p-3">
                <span className="metric-label">Nhiệt độ phòng</span>
                <span className="mt-1 block metric-value">
                  {formatMetrics.temperature(latest?.environment?.temperature)}
                </span>
                <span className="text-2xs text-slate-400">Khuyến nghị: 22 – 25 °C</span>
              </div>

              <div className="rounded-lg border border-slate-100 bg-slate-50/50 p-3">
                <span className="metric-label">Độ ẩm tương đối</span>
                <span className="mt-1 block metric-value">
                  {formatMetrics.humidity(latest?.environment?.humidity)}
                </span>
                <span className="text-2xs text-slate-400">Khuyến nghị: 45 – 65 %</span>
              </div>

              <div className="rounded-lg border border-slate-100 bg-slate-50/50 p-3">
                <span className="metric-label">Cường độ ánh sáng</span>
                <span className="mt-1 block metric-value">
                  {formatMetrics.lux(latest?.environment?.lux)}
                </span>
                <span className="text-2xs text-slate-400">Khuyến nghị: 300 – 500 lux</span>
              </div>

              <div className="rounded-lg border border-slate-100 bg-slate-50/50 p-3">
                <span className="metric-label">Độ ồn TB (LAeq)</span>
                <span className="mt-1 block metric-value">
                  {formatMetrics.noise(latest?.acoustics?.noiseAvg)}
                </span>
                <span className="text-2xs text-slate-400">
                  Đỉnh: {formatMetrics.noise(latest?.acoustics?.noisePeak)}
                </span>
              </div>

              <div className="rounded-lg border border-slate-100 bg-slate-50/50 p-3">
                <span className="metric-label">Bụi mịn PM2.5</span>
                <span className="mt-1 block metric-value">
                  {formatMetrics.pm(latest?.airQuality?.pm2_5)}
                </span>
                <span className="text-2xs text-slate-400">
                  PM1.0: {formatMetrics.pm(latest?.airQuality?.pm1_0)} · PM10: {formatMetrics.pm(latest?.airQuality?.pm10)}
                </span>
              </div>

              <div className="rounded-lg border border-slate-100 bg-slate-50/50 p-3">
                <span className="metric-label">Tín hiệu Wi-Fi</span>
                <span className="mt-1 block metric-value">
                  {formatMetrics.rssi(latest?.wifiRssi)}
                </span>
                <span className="text-2xs text-slate-400">
                  PM4.0: {formatMetrics.pm(latest?.airQuality?.pm4_0)}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Historical Downsampled Buckets Chart Section */}
      <section
        aria-label="Biểu đồ chuỗi thời gian nén Min-Max-Avg"
        className="card p-5 space-y-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
          <div>
            <h2 className="section-title">
              Biểu đồ lịch sử chuỗi thời gian nén (Min – Max – Avg)
            </h2>
            <p className="text-xs text-slate-500">
              Tổng hợp từ các bucket nén MongoDB Aggregation (tối đa 1000 điểm dữ liệu/truy vấn)
            </p>
          </div>

          {/* Quick Presets */}
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => applyQuickPreset(6, '15m')}
              className="btn-secondary btn-sm"
            >
              6 giờ (15m)
            </button>
            <button
              type="button"
              onClick={() => applyQuickPreset(24, '15m')}
              className="btn-secondary btn-sm"
            >
              24 giờ (15m)
            </button>
            <button
              type="button"
              onClick={() => applyQuickPreset(24 * 7, '1h')}
              className="btn-secondary btn-sm"
            >
              7 ngày (1h)
            </button>
            <button
              type="button"
              onClick={() => applyQuickPreset(24 * 30, '1d')}
              className="btn-secondary btn-sm"
            >
              30 ngày (1d)
            </button>
          </div>
        </div>

        {/* Date-Time Range & Interval Controls */}
        <div className="flex flex-wrap items-end gap-3 rounded-lg bg-slate-50 p-3 border border-slate-100">
          <div className="w-full sm:w-auto flex-1 min-w-[200px]">
            <label htmlFor="bucket-start" className="label">
              Bắt đầu
            </label>
            <input
              id="bucket-start"
              type="datetime-local"
              value={startLocal}
              onChange={(e) => setStartLocal(e.target.value)}
              className="input text-xs"
            />
          </div>

          <div className="w-full sm:w-auto flex-1 min-w-[200px]">
            <label htmlFor="bucket-end" className="label">
              Kết thúc
            </label>
            <input
              id="bucket-end"
              type="datetime-local"
              value={endLocal}
              onChange={(e) => setEndLocal(e.target.value)}
              className="input text-xs"
            />
          </div>

          <div className="w-full sm:w-auto">
            <span className="label">Độ mịn (Interval)</span>
            <div className="segmented">
              {(['15m', '1h', '1d'] as BucketInterval[]).map((iv) => (
                <button
                  key={iv}
                  type="button"
                  onClick={() => setIntervalState(iv)}
                  className={`segmented-item ${interval === iv ? 'segmented-item-active' : ''}`}
                >
                  {iv === '15m' ? '15m' : iv === '1h' ? '1h' : '1d'}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Client-side Bucket Range Guard Banner */}
        {!bucketValidation.valid && (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50/70 p-3 text-xs text-amber-900"
          >
            <div>
              <p className="font-semibold">
                {bucketValidation.errorCode
                  ? ERROR_MESSAGES_VI[bucketValidation.errorCode]
                  : ERROR_MESSAGES_VI[7002]}
              </p>
              {bucketValidation.errorCode === 7002 && (
                <p className="mt-0.5 text-amber-700">
                  Số điểm ước tính: <strong>{bucketValidation.bucketCount}</strong> buckets (vượt giới hạn 1000).
                </p>
              )}
            </div>
            {bucketValidation.errorCode === 7002 && (
              <button
                type="button"
                onClick={handleAutoRecommendInterval}
                className="btn-primary btn-sm bg-amber-600 hover:bg-amber-700"
              >
                Tự động chọn độ mịn
              </button>
            )}
          </div>
        )}

        {/* Chart Area */}
        <div className="pt-2">
          {bucketsQuery.isLoading ? (
            <Skeleton className="h-72 w-full" />
          ) : bucketsQuery.isError ? (
            <ErrorBanner
              message="Không thể tải dữ liệu biểu đồ chuỗi thời gian nén."
              onRetry={() => void bucketsQuery.refetch()}
            />
          ) : (
            <MinMaxAvgChart
              dataPoints={bucketsQuery.data?.dataPoints ?? []}
              interval={interval}
            />
          )}
        </div>
      </section>
    </div>
  );
}
