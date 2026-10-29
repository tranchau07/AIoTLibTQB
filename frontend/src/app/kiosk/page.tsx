'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQueries } from '@tanstack/react-query';
import {
  Sparkles,
  Clock,
  Building2,
  Volume2,
  Wind,
  Thermometer,
  Droplets,
  Layers,
  Award,
  ArrowRight,
  ShieldAlert,
  Info,
  LayoutDashboard,
  LogOut,
} from 'lucide-react';
import { getGradeStyle } from '@/config/thresholds';
import { UI_TEXT_VI } from '@/messages/vi';
import { formatMetrics } from '@/lib/format/metrics';
import {
  useRoomTelemetryStream,
  useStompConnectionState,
} from '@/lib/realtime/use-room-stream';
import {
  EmptyState,
  ErrorBanner,
  GradeBadge,
  Skeleton,
} from '@/components/ui/primitives';
import { useAuthStore } from '@/features/auth/store';
import { useRoomsQuery } from '@/features/rooms/queries';
import {
  telemetryKeys,
  useOverviewSummaryQuery,
} from '@/features/telemetry/queries';
import { telemetryApi } from '@/features/telemetry/api';
import type { RoomResponse, TelemetryResponse } from '@/types/api';

function KioskRoomStreamSubscriber({ roomId }: { roomId: string }) {
  useRoomTelemetryStream(roomId);
  return null;
}

export default function KioskLobbyPage() {
  const router = useRouter();
  const accessToken = useAuthStore((s) => s.accessToken);
  const refreshToken = useAuthStore((s) => s.refreshToken);
  const hydrated = useAuthStore((s) => s.hydrated);
  const capabilities = useAuthStore((s) => s.capabilities);
  const hydrateFromStorage = useAuthStore((s) => s.hydrateFromStorage);
  const clearSession = useAuthStore((s) => s.clearSession);

  const stompConnected = useStompConnectionState();
  const [now, setNow] = useState<Date | null>(null);

  const handleExitKiosk = () => {
    clearSession();
    router.push('/login');
  };

  // Restore Kiosk session from localStorage (hydrateFromStorage(true))
  useEffect(() => {
    hydrateFromStorage(true);
  }, [hydrateFromStorage]);

  // Real-time lobby clock
  useEffect(() => {
    setNow(new Date());
    const timer = window.setInterval(() => {
      setNow(new Date());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const hasSession = Boolean(accessToken || refreshToken);

  const summaryQuery = useOverviewSummaryQuery(hasSession, 10000);
  const roomsQuery = useRoomsQuery({ page: 0, size: 50 }, hasSession);

  const rooms: RoomResponse[] = useMemo(
    () => (hasSession ? roomsQuery.data?.content ?? [] : []),
    [hasSession, roomsQuery.data]
  );

  const roomMap = useMemo(() => {
    const map = new Map<string, RoomResponse>();
    for (const r of rooms) {
      map.set(r.id, r);
    }
    return map;
  }, [rooms]);

  // Subscribe and query latest telemetry for each room so floor ranking cards stay live
  const roomLatestQueries = useQueries({
    queries: rooms.map((room) => ({
      queryKey: telemetryKeys.roomLatest(room.id),
      queryFn: () => telemetryApi.getRoomLatest(room.id),
      enabled: hasSession,
      refetchInterval: stompConnected ? (false as const) : 15000,
    })),
  });

  const roomTelemetryMap = useMemo(() => {
    const map: Record<string, TelemetryResponse | null | undefined> = {};
    rooms.forEach((room, idx) => {
      map[room.id] = roomLatestQueries[idx]?.data ?? null;
    });
    return map;
  }, [rooms, roomLatestQueries]);

  // Group and rank rooms by floor (sorted by comfortScore descending)
  const roomsByFloor = useMemo(() => {
    const grouped = new Map<number, RoomResponse[]>();
    for (const r of rooms) {
      const list = grouped.get(r.floor) ?? [];
      list.push(r);
      grouped.set(r.floor, list);
    }
    const entries = Array.from(grouped.entries()).sort((a, b) => a[0] - b[0]);
    return entries.map(([floor, list]) => {
      const sorted = [...list].sort((ra, rb) => {
        const sa = roomTelemetryMap[ra.id]?.comfortScore?.overall ?? -1;
        const sb = roomTelemetryMap[rb.id]?.comfortScore?.overall ?? -1;
        return sb - sa;
      });
      return { floor, rooms: sorted };
    });
  }, [rooms, roomTelemetryMap]);

  const summary = summaryQuery.data;
  const bestRoomInfo = summary?.bestRoom ?? null;
  const bestRoomEntity = bestRoomInfo
    ? roomMap.get(bestRoomInfo.roomId)
    : undefined;

  const formattedTime = now
    ? now.toLocaleTimeString('vi-VN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : '--:--:--';

  const formattedDate = now
    ? now.toLocaleDateString('vi-VN', {
        weekday: 'long',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      })
    : '';

  if (!hydrated || (!accessToken && Boolean(refreshToken))) {
    return (
      <main className="min-h-screen bg-slate-950 p-8 text-slate-100">
        <Skeleton className="h-24 w-full bg-slate-900" />
      </main>
    );
  }

  // Unauthenticated Kiosk setup screen
  if (!hasSession) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-slate-950 p-6 text-slate-100">
        <div className="max-w-md rounded-xl border border-slate-800 bg-slate-900/80 p-8 text-center shadow-xl">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg border border-slate-700 bg-slate-800 text-brand-400">
            <Building2 className="h-6 w-6" />
          </div>

          <div className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-slate-700 bg-slate-800 px-3 py-1 text-2xs font-medium text-slate-300">
            <span>M02</span>
            <span>·</span>
            <span>Màn hình TV Sảnh Thư viện</span>
          </div>

          <h1 className="mt-3 text-lg font-bold text-white">
            {UI_TEXT_VI.appName} — Kiosk Môi trường
          </h1>
          <p className="mt-2 text-xs leading-relaxed text-slate-400">
            Màn hình Kiosk yêu cầu khởi tạo phiên đăng nhập bằng tài khoản{' '}
            <strong className="text-slate-200">VIEWER</strong> hoặc{' '}
            <strong className="text-slate-200">USER</strong> với tùy chọn{' '}
            <em>Duy trì chế độ Kiosk</em> để hiển thị liên tục 24/7.
          </p>
          <div className="mt-6 flex justify-center">
            <Link
              href="/login"
              className="btn-primary inline-flex items-center gap-2"
            >
              <span>Đăng nhập kích hoạt Kiosk</span>
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-6 text-slate-100 lg:px-10">
      {/* Subscribe live STOMP telemetry for all rooms */}
      {rooms.map((room) => (
        <KioskRoomStreamSubscriber key={room.id} roomId={room.id} />
      ))}

      {/* Top Bar: Library Identity + Live Clock */}
      <header className="flex flex-col justify-between gap-4 border-b border-slate-800/80 pb-5 lg:flex-row lg:items-center">
        <div>
          <div className="flex items-center gap-2.5">
            <span
              className={`h-2.5 w-2.5 rounded-full ${
                stompConnected ? 'bg-emerald-400' : 'bg-amber-400'
              }`}
            />
            <span className="text-2xs font-semibold tracking-wider text-slate-400 uppercase">
              Thư viện Tạ Quang Bửu · Bảng điều hành không gian đọc sách
            </span>
          </div>
          <h1 className="mt-1 text-xl font-bold tracking-tight text-white lg:text-2xl">
            {UI_TEXT_VI.appSubtitle}
          </h1>
        </div>

        <div className="flex items-center gap-4 lg:gap-6">
          {/* Quick Exit / Back navigation for operators */}
          <div className="flex items-center gap-2">
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:border-slate-700 hover:text-white"
              title="Quay lại Bảng điều khiển quản trị"
            >
              <LayoutDashboard className="h-3.5 w-3.5 text-brand-400" />
              <span>Bảng điều khiển</span>
            </Link>
            <button
              type="button"
              onClick={handleExitKiosk}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-900/70 p-1.5 text-xs text-slate-400 transition-colors hover:border-red-900/50 hover:bg-red-950/40 hover:text-red-300"
              title="Thoát chế độ Kiosk"
            >
              <LogOut className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="text-right">
            <p
              aria-live="off"
              className="font-mono text-3xl font-bold tracking-tight text-white lg:text-4xl"
            >
              {formattedTime}
            </p>
            <p className="text-xs font-normal text-slate-400 capitalize">
              {formattedDate}
            </p>
          </div>
        </div>
      </header>

      {/* Error Banner if summary fails */}
      {summaryQuery.isError && (
        <div className="mt-6">
          <ErrorBanner
            message="Đang gián đoạn kết nối tới máy chủ tổng hợp số liệu. Hệ thống sẽ tự động thử lại."
            onRetry={() => void summaryQuery.refetch()}
          />
        </div>
      )}

      {/* Hero Section: Best Reading Room Recommendation + Library Overview KPIs */}
      <section
        aria-label="Gợi ý phòng đọc lý tưởng nhất hiện tại"
        className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-12"
      >
        {/* Best Room Spotlight Card (7 cols) */}
        <div className="flex flex-col justify-between rounded-xl border border-border-strong bg-slate-900/70 p-6 backdrop-blur-sm lg:col-span-7">
          {summaryQuery.isLoading ? (
            <Skeleton className="h-48 w-full bg-slate-900" />
          ) : !bestRoomInfo ? (
            <div className="py-8">
              <EmptyState
                title="Đang tổng hợp gợi ý phòng đọc tối ưu"
                description={UI_TEXT_VI.emptySummaryWaiting}
              />
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-2xs font-medium text-emerald-300">
                    <Sparkles className="h-3 w-3 text-emerald-400" />
                    <span>Gợi ý phòng đọc lý tưởng nhất hiện tại</span>
                  </div>

                  <h2 className="mt-2.5 text-2xl font-bold tracking-tight text-white lg:text-3xl">
                    {bestRoomEntity
                      ? `${bestRoomEntity.code} — ${bestRoomEntity.name}`
                      : bestRoomInfo.roomName}
                  </h2>
                  {bestRoomEntity && (
                    <p className="mt-1 text-xs font-medium text-slate-400">
                      Vị trí: Tầng {bestRoomEntity.floor} · Sức chứa:{' '}
                      {bestRoomEntity.capacity ?? '--'} chỗ ngồi
                    </p>
                  )}
                </div>

                <div className="text-right">
                  <div className="font-mono text-4xl font-bold tracking-tight text-emerald-400 lg:text-5xl">
                    {formatMetrics.comfortScore(bestRoomInfo.comfortScore)}
                    <span className="text-base font-normal text-slate-400">
                      /100
                    </span>
                  </div>
                  <div className="mt-1.5 flex justify-end">
                    <GradeBadge
                      grade={bestRoomInfo.grade}
                      score={bestRoomInfo.comfortScore}
                    />
                  </div>
                </div>
              </div>

              <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3">
                  <div className="flex items-center gap-1.5 text-2xs text-slate-400">
                    <Volume2 className="h-3.5 w-3.5 text-slate-500" />
                    <span>Độ ồn TB</span>
                  </div>
                  <p className="mt-1 font-mono text-lg font-bold text-white">
                    {formatMetrics.noise(bestRoomInfo.noiseAvg)}
                  </p>
                </div>

                <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3">
                  <div className="flex items-center gap-1.5 text-2xs text-slate-400">
                    <Wind className="h-3.5 w-3.5 text-slate-500" />
                    <span>Bụi PM2.5</span>
                  </div>
                  <p className="mt-1 font-mono text-lg font-bold text-white">
                    {formatMetrics.pm(bestRoomInfo.pm25)}
                  </p>
                </div>

                <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3">
                  <div className="flex items-center gap-1.5 text-2xs text-slate-400">
                    <Thermometer className="h-3.5 w-3.5 text-slate-500" />
                    <span>Nhiệt độ</span>
                  </div>
                  <p className="mt-1 font-mono text-lg font-bold text-white">
                    {formatMetrics.temperature(bestRoomInfo.temperature)}
                  </p>
                </div>

                <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3">
                  <div className="flex items-center gap-1.5 text-2xs text-slate-400">
                    <Droplets className="h-3.5 w-3.5 text-slate-500" />
                    <span>Độ ẩm</span>
                  </div>
                  <p className="mt-1 font-mono text-lg font-bold text-white">
                    {formatMetrics.humidity(bestRoomInfo.humidity)}
                  </p>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Library Aggregate KPIs (5 cols) */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:col-span-5">
          <div className="flex flex-col justify-between rounded-xl border border-slate-800 bg-slate-900/60 p-5">
            <p className="text-2xs font-semibold tracking-wider text-slate-400 uppercase">
              Điểm tiện nghi trung bình
            </p>
            <div className="my-2 flex items-baseline gap-2">
              <span className="font-mono text-4xl font-bold tracking-tight text-white">
                {summary
                  ? formatMetrics.comfortScore(summary.averageComfortScore)
                  : '--'}
              </span>
              <span className="text-xs text-slate-400">/ 100</span>
            </div>
            <div>
              <GradeBadge
                grade={summary?.overallGrade}
                score={summary?.averageComfortScore}
              />
            </div>
          </div>

          <div className="flex flex-col justify-between rounded-xl border border-slate-800 bg-slate-900/60 p-5">
            <p className="text-2xs font-semibold tracking-wider text-slate-400 uppercase">
              Phòng đạt chuẩn tối ưu
            </p>
            <div className="my-2 flex items-baseline gap-2">
              <span className="font-mono text-4xl font-bold tracking-tight text-emerald-400">
                {summary?.optimalRoomsCount ?? 0}
              </span>
              <span className="font-mono text-xl font-medium text-slate-400">
                / {summary?.totalRooms ?? rooms.length}
              </span>
            </div>
            <p className="text-2xs text-slate-400">
              Hạng Tốt (Gold) &amp; Tối ưu (Platinum)
            </p>
          </div>

          {/* Only show internal attention room note if user has canViewAlerts (§9 M02 RBAC rule) */}
          {capabilities.canViewAlerts && summary?.attentionRoom ? (
            <div className="rounded-xl border border-amber-500/30 bg-amber-950/20 p-4 sm:col-span-2">
              <div className="flex items-center gap-1.5 text-2xs font-semibold text-amber-300 uppercase">
                <ShieldAlert className="h-3.5 w-3.5" />
                <span>Lưu ý vận hành nội bộ</span>
              </div>
              <p className="mt-1 text-xs font-medium text-slate-200">
                Phòng cần chú ý:{' '}
                {roomMap.get(summary.attentionRoom.roomId)?.name ??
                  summary.attentionRoom.roomName}{' '}
                ({formatMetrics.comfortScore(summary.attentionRoom.comfortScore)}{' '}
                điểm)
              </p>
            </div>
          ) : (
            <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 sm:col-span-2">
              <div className="flex items-center gap-1.5 text-2xs font-semibold text-emerald-400 uppercase">
                <Info className="h-3.5 w-3.5" />
                <span>Hướng dẫn tra cứu</span>
              </div>
              <p className="mt-1 text-xs text-slate-300">
                Ưu tiên chọn các phòng có nhãn{' '}
                <strong className="text-emerald-300">Tối ưu</strong> hoặc{' '}
                <strong className="text-green-300">Tốt</strong> bên dưới để có
                không gian đọc sách yên tĩnh và trong lành nhất.
              </p>
            </div>
          )}
        </div>
      </section>

      {/* Floor-by-Floor Visual Room Ranking Board */}
      <section
        aria-label="Bảng xếp hạng chất lượng môi trường các phòng đọc theo tầng"
        className="mt-8 space-y-6"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Layers className="h-4 w-4 text-brand-400" />
            <h2 className="text-base font-bold text-white">
              Trạng thái Không gian Đọc sách theo Tầng
            </h2>
          </div>
          <span className="text-2xs font-medium text-slate-400">
            Cập nhật thời gian thực ({rooms.length} phòng đọc)
          </span>
        </div>

        {roomsQuery.isLoading ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <Skeleton className="h-36 w-full bg-slate-900" />
            <Skeleton className="h-36 w-full bg-slate-900" />
            <Skeleton className="h-36 w-full bg-slate-900" />
          </div>
        ) : roomsByFloor.length === 0 ? (
          <EmptyState
            title="Chưa có dữ liệu phòng đọc"
            description={UI_TEXT_VI.emptySummaryWaiting}
          />
        ) : (
          <div className="space-y-6">
            {roomsByFloor.map(({ floor, rooms: floorRoomList }) => (
              <div
                key={floor}
                className="rounded-xl border border-slate-800/90 bg-slate-900/50 p-4 md:p-5"
              >
                <div className="mb-3.5 flex items-center justify-between border-b border-slate-800 pb-2.5">
                  <h3 className="text-sm font-bold text-brand-400">
                    TẦNG {floor}
                  </h3>
                  <span className="text-2xs font-medium text-slate-400">
                    {floorRoomList.length} phòng đọc
                  </span>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {floorRoomList.map((room) => {
                    const tel = roomTelemetryMap[room.id];
                    const score = tel?.comfortScore?.overall ?? null;
                    const grade = tel?.comfortScore?.grade ?? null;
                    const style = getGradeStyle(grade, score);

                    return (
                      <article
                        key={room.id}
                        className="flex flex-col justify-between rounded-lg border border-slate-800 bg-slate-950/80 p-3.5 transition-colors hover:border-slate-700"
                        style={{
                          borderLeftWidth: '3px',
                          borderLeftColor: style.hex,
                        }}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <span className="font-mono text-2xs text-slate-400">
                              {room.code}
                            </span>
                            <h4 className="text-xs font-semibold text-white">
                              {room.name}
                            </h4>
                          </div>
                          <div className="text-right">
                            <span className="font-mono text-lg font-bold text-white">
                              {formatMetrics.comfortScore(score)}
                            </span>
                            <div className="mt-0.5">
                              <GradeBadge grade={grade} score={score} />
                            </div>
                          </div>
                        </div>

                        <div className="mt-3 grid grid-cols-3 gap-2 border-t border-slate-800/60 pt-2.5 font-mono text-2xs">
                          <div>
                            <span className="block font-sans text-slate-400">
                              Độ ồn
                            </span>
                            <strong className="text-slate-200">
                              {formatMetrics.noise(tel?.acoustics?.noiseAvg)}
                            </strong>
                          </div>
                          <div>
                            <span className="block font-sans text-slate-400">
                              Bụi PM2.5
                            </span>
                            <strong className="text-slate-200">
                              {formatMetrics.pm(tel?.airQuality?.pm2_5)}
                            </strong>
                          </div>
                          <div>
                            <span className="block font-sans text-slate-400">
                              Nhiệt / Ẩm
                            </span>
                            <strong className="text-slate-200">
                              {formatMetrics.temperature(
                                tel?.environment?.temperature
                              )}{' '}
                              ·{' '}
                              {formatMetrics.humidity(tel?.environment?.humidity)}
                            </strong>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
