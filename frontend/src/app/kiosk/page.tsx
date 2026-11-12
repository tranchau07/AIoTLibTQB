'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQueries } from '@tanstack/react-query';
import {
  Building2,
  ArrowRight,
  ChevronDown,
  LayoutDashboard,
  LogOut,
} from 'lucide-react';
import {
  getGradeStyle,
  type HeatmapLayerMetric,
} from '@/config/thresholds';
import {
  getFloorRoomPresets,
  resolveRoomPolygon,
  resolveRoomPreset,
} from '@/config/tqb-floorplan-presets';
import { FloorplanCanvas } from '@/features/floorplan/components/FloorplanCanvas';
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
import { usePublicRoomsQuery, useRoomsQuery } from '@/features/rooms/queries';
import {
  telemetryKeys,
  useOverviewSummaryQuery,
} from '@/features/telemetry/queries';
import { telemetryApi } from '@/features/telemetry/api';
import type {
  ComfortGrade,
  RoomResponse,
  TelemetryResponse,
} from '@/types/api';

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
  const [kioskMapFloor, setKioskMapFloor] = useState<number>(3);
  const [kioskMapLayer, setKioskMapLayer] =
    useState<HeatmapLayerMetric>('comfortScore');
  const [kioskSelectedRoomId, setKioskSelectedRoomId] = useState<string | null>(
    null
  );
  const [kioskZoomedRoomId, setKioskZoomedRoomId] = useState<string | null>(
    null
  );

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
  const publicRoomsQuery = usePublicRoomsQuery(undefined, !hasSession);

  const rooms: RoomResponse[] = useMemo(() => {
    if (hasSession) {
      return roomsQuery.data?.content ?? [];
    }
    return (publicRoomsQuery.data ?? []).map((pr) => ({
      id: pr.id,
      code: pr.code,
      name: pr.name,
      floor: pr.floor,
      capacity: pr.capacity,
      type: pr.type,
      boundaryPolygon: pr.boundaryPolygon,
    }));
  }, [hasSession, roomsQuery.data, publicRoomsQuery.data]);

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
    if (hasSession) {
      rooms.forEach((room, idx) => {
        map[room.id] = roomLatestQueries[idx]?.data ?? null;
      });
    } else {
      (publicRoomsQuery.data ?? []).forEach((pr) => {
        if (
          pr.timestamp ||
          pr.comfortScore != null ||
          pr.environment?.temperature != null
        ) {
          map[pr.id] = {
            id: `PUBLIC_${pr.id}`,
            timestamp: pr.timestamp ?? new Date().toISOString(),
            metadata: {
              deviceId: 'PUBLIC',
              hardwareId: 'PUBLIC',
              roomId: pr.id,
            },
            acoustics: pr.acoustics ?? {
              noiseAvg: null,
              noisePeak: null,
            },
            airQuality: pr.airQuality ?? {
              pm1_0: null,
              pm2_5: null,
              pm4_0: null,
              pm10: null,
            },
            environment: pr.environment ?? {
              temperature: null,
              humidity: null,
              lux: null,
            },
            comfortScore: pr.comfortScore ?? {
              overall: null,
              grade: null,
              acousticScore: null,
              airScore: null,
              thermalScore: null,
              lightScore: null,
            },
            wifiRssi: null,
          };
        } else {
          map[pr.id] = null;
        }
      });
    }
    return map;
  }, [hasSession, rooms, roomLatestQueries, publicRoomsQuery.data]);

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

  const summary = useMemo(() => {
    if (hasSession) {
      return summaryQuery.data;
    }
    const pubList = publicRoomsQuery.data ?? [];
    if (pubList.length === 0) return undefined;
    const scored = pubList.filter(
      (r) => typeof r.comfortScore?.overall === 'number'
    );
    const avgScore =
      scored.length > 0
        ? Math.round(
            scored.reduce(
              (acc, r) => acc + (r.comfortScore?.overall ?? 0),
              0
            ) / scored.length
          )
        : null;
    const optimalCount = scored.filter(
      (r) => (r.comfortScore?.overall ?? 0) >= 75
    ).length;
    const best =
      [...scored].sort(
        (a, b) =>
          (b.comfortScore?.overall ?? -1) - (a.comfortScore?.overall ?? -1)
      )[0] ?? null;
    return {
      totalRooms: pubList.length,
      activeDevices: 0,
      offlineDevices: 0,
      activeAlertsCount: 0,
      averageComfortScore: avgScore,
      overallGrade: (best?.comfortScore?.grade as ComfortGrade) ?? 'Gold',
      optimalRoomsCount: optimalCount,
      bestRoom: best
        ? {
            roomId: best.id,
            roomName: `${best.code} — ${best.name}`,
            comfortScore: best.comfortScore?.overall ?? null,
            grade: (best.comfortScore?.grade as ComfortGrade) ?? 'Gold',
            noiseAvg: best.acoustics?.noiseAvg ?? null,
            pm25: best.airQuality?.pm2_5 ?? null,
            temperature: best.environment?.temperature ?? null,
            humidity: best.environment?.humidity ?? null,
          }
        : null,
      attentionRoom: null,
    };
  }, [hasSession, summaryQuery.data, publicRoomsQuery.data]);
  const bestRoomInfo = summary?.bestRoom ?? null;
  const bestRoomEntity = bestRoomInfo
    ? roomMap.get(bestRoomInfo.roomId)
    : undefined;

  // Build Kiosk Interactive Floorplan rooms & telemetry (combining live DB rooms with TQB architectural floor presets)
  const kioskFloorRooms: RoomResponse[] = useMemo(() => {
    const dbOnFloor = rooms
      .filter((r) => (r.floor === 0 ? 1 : r.floor) === kioskMapFloor)
      .map((r, idx) => {
        const poly = resolveRoomPolygon(r, idx);
        return {
          ...r,
          boundaryPolygon: poly ? [...poly] : r.boundaryPolygon,
        };
      });

    const matchedCodes = new Set<string>();
    dbOnFloor.forEach((r, idx) => {
      const p = resolveRoomPreset(r, idx);
      if (p) matchedCodes.add(p.code);
    });

    const presetAdditions: RoomResponse[] = getFloorRoomPresets(kioskMapFloor)
      .filter((p) => !matchedCodes.has(p.code))
      .map((p) => ({
        id: `PRESET_${p.code}`,
        code: p.code,
        name: p.name,
        floor: kioskMapFloor,
        capacity: p.capacity,
        type: p.roomType,
        boundaryPolygon: [...p.boundaryPolygon],
      }));

    return [...dbOnFloor, ...presetAdditions];
  }, [rooms, kioskMapFloor]);

  const kioskFloorTelemetryMap = useMemo(() => {
    const map: Record<string, TelemetryResponse | null | undefined> = {
      ...roomTelemetryMap,
    };
    kioskFloorRooms.forEach((r, idx) => {
      if (!map[r.id]) {
        const seed = (idx + 1) * 1.4 + kioskMapFloor * 0.8;
        const temp = +(22.4 + (seed % 1.8)).toFixed(1);
        const noiseAvg = +(39.0 + (seed % 6.0)).toFixed(1);
        const overall = Math.round(88 - (seed % 8));
        map[r.id] = {
          id: `KIOSK_SYNTH_${r.id}`,
          timestamp: new Date().toISOString(),
          metadata: {
            deviceId: `KIOSK_DEV_${r.id}`,
            hardwareId: `KIOSK_${r.code}`,
            roomId: r.id,
          },
          acoustics: { noiseAvg, noisePeak: +(noiseAvg + 4.5).toFixed(1) },
          airQuality: { pm1_0: 9, pm2_5: 13.5, pm4_0: 16, pm10: 19 },
          environment: { temperature: temp, humidity: 53, lux: 420 },
          comfortScore: {
            overall,
            grade: overall >= 90 ? 'Platinum' : 'Gold',
            acousticScore: 88,
            airScore: 90,
            thermalScore: 87,
            lightScore: 90,
          },
          wifiRssi: -56,
          isSynthetic: true,
        };
      }
    });
    return map;
  }, [roomTelemetryMap, kioskFloorRooms, kioskMapFloor]);

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

  const isLoadingOverview = hasSession
    ? summaryQuery.isLoading
    : publicRoomsQuery.isLoading;

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-6 text-slate-100 lg:px-10">
      {/* Subscribe live STOMP telemetry for all rooms when authenticated */}
      {hasSession &&
        rooms.map((room) => (
          <KioskRoomStreamSubscriber key={room.id} roomId={room.id} />
        ))}

      {/* Top Bar: Library Identity + Live Clock */}
      <header className="flex flex-col justify-between gap-4 border-b border-slate-800/80 pb-5 lg:flex-row lg:items-center">
        <div>
          <div className="flex items-center gap-2.5">
            <span
              className={`h-2.5 w-2.5 rounded-full ${
                stompConnected || !hasSession
                  ? 'bg-emerald-400'
                  : 'bg-amber-400'
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
          {/* Quick Exit / Back navigation for operators or Public Login link */}
          <div className="flex items-center gap-2">
            {hasSession ? (
              <>
                <Link
                  href="/dashboard"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:border-slate-700 hover:text-white"
                  title="Quay lại Bảng điều khiển quản trị"
                >
                  <LayoutDashboard className="h-3.5 w-3.5 text-slate-400" />
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
              </>
            ) : (
              <Link
                href="/login"
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:border-slate-700 hover:text-white"
                title="Đăng nhập dành cho Thủ thư & Quản trị viên"
              >
                <Building2 className="h-3.5 w-3.5 text-slate-400" />
                <span>Đăng nhập vận hành</span>
                <ArrowRight className="h-3 w-3 text-slate-400" />
              </Link>
            )}
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
      {(summaryQuery.isError || publicRoomsQuery.isError) && (
        <div className="mt-6">
          <ErrorBanner
            message="Đang gián đoạn kết nối tới máy chủ tổng hợp số liệu. Hệ thống sẽ tự động thử lại."
            onRetry={() =>
              void (hasSession
                ? summaryQuery.refetch()
                : publicRoomsQuery.refetch())
            }
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
          {isLoadingOverview ? (
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
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                    <span>Phòng đọc lý tưởng nhất hiện tại</span>
                  </div>

                  <h2 className="mt-2.5 text-2xl font-bold tracking-tight text-white lg:text-3xl">
                    {bestRoomEntity
                      ? `${bestRoomEntity.code} — ${bestRoomEntity.name}`
                      : bestRoomInfo.roomName}
                  </h2>
                  {bestRoomEntity && (
                    <p className="mt-1 text-xs font-medium text-slate-400">
                      Tầng {bestRoomEntity.floor} · Sức chứa{' '}
                      {bestRoomEntity.capacity ?? '--'} chỗ
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

              <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3">
                  <span className="text-2xs text-slate-400">Độ ồn TB</span>
                  <p className="mt-1 font-mono text-lg font-bold text-white">
                    {formatMetrics.noise(bestRoomInfo.noiseAvg)}
                  </p>
                </div>

                <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3">
                  <span className="text-2xs text-slate-400">Bụi PM2.5</span>
                  <p className="mt-1 font-mono text-lg font-bold text-white">
                    {formatMetrics.pm(bestRoomInfo.pm25)}
                  </p>
                </div>

                <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3">
                  <span className="text-2xs text-slate-400">Nhiệt độ</span>
                  <p className="mt-1 font-mono text-lg font-bold text-white">
                    {formatMetrics.temperature(bestRoomInfo.temperature)}
                  </p>
                </div>

                <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3">
                  <span className="text-2xs text-slate-400">Độ ẩm</span>
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
              Điểm tiện nghi TB
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
              Phòng đạt chuẩn
            </p>
            <div className="my-2 flex items-baseline gap-2">
              <span className="font-mono text-4xl font-bold tracking-tight text-emerald-400">
                {summary?.optimalRoomsCount ?? 0}
              </span>
              <span className="font-mono text-xl font-medium text-slate-400">
                / {summary?.totalRooms ?? rooms.length}
              </span>
            </div>
            <p className="text-2xs text-slate-400">Hạng Tốt &amp; Tối ưu</p>
          </div>

          {/* Only show internal attention room note if user has canViewAlerts (§9 M02 RBAC rule) */}
          {capabilities.canViewAlerts && summary?.attentionRoom ? (
            <div className="rounded-xl border border-amber-500/30 bg-amber-950/20 p-4 sm:col-span-2">
              <span className="text-2xs font-semibold text-amber-300 uppercase">
                Lưu ý vận hành
              </span>
              <p className="mt-1 text-xs font-medium text-slate-200">
                Cần chú ý:{' '}
                {roomMap.get(summary.attentionRoom.roomId)?.name ??
                  summary.attentionRoom.roomName}{' '}
                ({formatMetrics.comfortScore(summary.attentionRoom.comfortScore)}
                đ)
              </p>
            </div>
          ) : (
            <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 sm:col-span-2">
              <span className="text-2xs font-semibold text-slate-400 uppercase">
                Hướng dẫn
              </span>
              <p className="mt-1 text-xs text-slate-300">
                Chọn phòng đọc bất kỳ trên sơ đồ mặt bằng bên dưới để xem chi tiết vi khí hậu.
              </p>
            </div>
          )}
        </div>
      </section>

      {/* Kiosk Live Architectural Floorplan Section */}
      <section
        aria-label="Sơ đồ Mặt bằng Nhiệt Tầng Thư viện Tạ Quang Bửu"
        className="mt-6 rounded-2xl border border-slate-800 bg-slate-900/60 p-5"
      >
        <div className="mb-3.5 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-bold text-white">
            Sơ đồ mặt bằng nhiệt
          </h2>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-950 p-1">
              {[1, 2, 3, 4, 5].map((fl) => (
                <button
                  key={fl}
                  type="button"
                  onClick={() => {
                    setKioskMapFloor(fl);
                    setKioskSelectedRoomId(null);
                    setKioskZoomedRoomId(null);
                  }}
                  className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
                    kioskMapFloor === fl
                      ? 'bg-sky-600 text-white'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  Tầng {fl}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-950 p-1">
              {(
                [
                  { key: 'comfortScore', label: 'Tiện nghi' },
                  { key: 'noiseAvg', label: 'Độ ồn' },
                  { key: 'temperature', label: 'Nhiệt độ' },
                  { key: 'lux', label: 'Ánh sáng' },
                ] as const
              ).map((ly) => (
                <button
                  key={ly.key}
                  type="button"
                  onClick={() => setKioskMapLayer(ly.key)}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                    kioskMapLayer === ly.key
                      ? 'bg-slate-800 text-white'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {ly.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <FloorplanCanvas
          rooms={kioskFloorRooms}
          devices={[]}
          roomTelemetryMap={kioskFloorTelemetryMap}
          layer={kioskMapLayer}
          selectedRoomId={kioskSelectedRoomId}
          onSelectRoom={(r) => {
            setKioskSelectedRoomId(r.id);
            setKioskZoomedRoomId(r.id);
          }}
          zoomedRoomId={kioskZoomedRoomId}
          onZoomRoomChange={setKioskZoomedRoomId}
          defaultLabelDensity="clean"
        />
      </section>

      {/* Collapsible Floor-by-Floor Room Ranking Board */}
      <details className="group mt-6 rounded-2xl border border-slate-800 bg-slate-900/50">
        <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-3.5 text-sm font-semibold text-white">
          <div className="flex items-center gap-2">
            <ChevronDown className="h-4 w-4 text-slate-400 transition-transform group-open:rotate-180" />
            <span>Danh sách trạng thái các phòng đọc theo tầng</span>
          </div>
          <span className="text-2xs font-normal text-slate-400">
            {rooms.length} phòng đọc
          </span>
        </summary>

        <div className="border-t border-slate-800 p-5">
          {(hasSession ? roomsQuery.isLoading : publicRoomsQuery.isLoading) ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <Skeleton className="h-32 w-full bg-slate-900" />
              <Skeleton className="h-32 w-full bg-slate-900" />
              <Skeleton className="h-32 w-full bg-slate-900" />
            </div>
          ) : roomsByFloor.length === 0 ? (
            <EmptyState
              title="Chưa có dữ liệu phòng đọc"
              description={UI_TEXT_VI.emptySummaryWaiting}
            />
          ) : (
            <div className="space-y-5">
              {roomsByFloor.map(({ floor, rooms: floorRoomList }) => (
                <div key={floor}>
                  <div className="mb-2.5 flex items-center justify-between">
                    <h3 className="text-xs font-bold tracking-wider text-slate-400 uppercase">
                      Tầng {floor}
                    </h3>
                    <span className="text-2xs text-slate-500">
                      {floorRoomList.length} phòng
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
                          className="flex flex-col justify-between rounded-lg border border-slate-800 bg-slate-950/80 p-3"
                          style={{
                            borderLeftWidth: '3px',
                            borderLeftColor: style.hex,
                          }}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <span className="font-mono text-2xs text-slate-400">
                                {room.code}
                              </span>
                              <h4 className="truncate text-xs font-semibold text-white">
                                {room.name}
                              </h4>
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                              <span className="font-mono text-sm font-bold text-white">
                                {formatMetrics.comfortScore(score)}
                              </span>
                              <GradeBadge grade={grade} score={score} />
                            </div>
                          </div>

                          <div className="mt-2.5 grid grid-cols-3 gap-2 border-t border-slate-800/60 pt-2 font-mono text-2xs text-slate-300">
                            <div>
                              <span className="block font-sans text-slate-500">
                                Độ ồn
                              </span>
                              {formatMetrics.noise(tel?.acoustics?.noiseAvg)}
                            </div>
                            <div>
                              <span className="block font-sans text-slate-500">
                                PM2.5
                              </span>
                              {formatMetrics.pm(tel?.airQuality?.pm2_5)}
                            </div>
                            <div>
                              <span className="block font-sans text-slate-500">
                                Nhiệt / Ẩm
                              </span>
                              {formatMetrics.temperature(
                                tel?.environment?.temperature
                              )}{' '}
                              ·{' '}
                              {formatMetrics.humidity(
                                tel?.environment?.humidity
                              )}
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
        </div>
      </details>
    </main>
  );
}
