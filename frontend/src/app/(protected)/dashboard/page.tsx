'use client';

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { ChevronRight, MapPin } from 'lucide-react';
import { useAuthStore } from '@/features/auth/store';
import { resolveAlertFloorplanTarget } from '@/features/alerts/navigation';
import { useOverviewSummaryQuery } from '@/features/telemetry/queries';
import { useRoomsQuery } from '@/features/rooms/queries';
import {
  useAlertsQuery,
  useUnreadAlertsCountQuery,
} from '@/features/alerts/queries';
import { useStompConnectionState } from '@/lib/realtime/use-room-stream';
import {
  formatBottleneckReasonVi,
  formatMetrics,
} from '@/lib/format/metrics';
import { formatVietnamDateTime } from '@/lib/format/datetime';
import { UI_TEXT_VI } from '@/messages/vi';
import {
  CollapsibleSection,
  EmptyState,
  ErrorBanner,
  GradeBadge,
  Skeleton,
} from '@/components/ui/primitives';
import {
  AlertStatusBadge,
  AlertTypeBadge,
} from '@/features/alerts/components/AlertBadges';
import { RoomTelemetryCard } from '@/features/telemetry/components/RoomTelemetryCard';

export default function DashboardPage() {
  const capabilities = useAuthStore((s) => s.capabilities);
  const stompConnected = useStompConnectionState();
  const [selectedFloor, setSelectedFloor] = useState<number | 'ALL'>('ALL');

  const summaryQuery = useOverviewSummaryQuery(
    true,
    stompConnected ? 15000 : 10000
  );

  const roomsQuery = useRoomsQuery({ page: 0, size: 100 });

  const unreadAlertsQuery = useUnreadAlertsCountQuery(
    capabilities.canViewAlerts
  );

  const recentAlertsQuery = useAlertsQuery(
    { page: 0, size: 5 },
    capabilities.canViewAlerts
  );

  const rooms = useMemo(
    () => roomsQuery.data?.content ?? [],
    [roomsQuery.data]
  );

  // Map roomId -> actual room name & code from rooms query cache (FE-UI-06, D9)
  const roomLookupMap = useMemo(() => {
    const map = new Map<string, { name: string; code: string; floor: number }>();
    for (const r of rooms) {
      map.set(r.id, { name: r.name, code: r.code, floor: r.floor });
    }
    return map;
  }, [rooms]);

  const resolveDisplayRoomName = (roomId: string, fallbackName: string) => {
    const found = roomLookupMap.get(roomId);
    if (found) {
      return `${found.name} (${found.code} · Tầng ${found.floor})`;
    }
    return fallbackName;
  };

  const availableFloors = useMemo(() => {
    const set = new Set<number>();
    for (const r of rooms) {
      set.add(r.floor);
    }
    return Array.from(set).sort((a, b) => a - b);
  }, [rooms]);

  const filteredRooms = useMemo(() => {
    if (selectedFloor === 'ALL') return rooms;
    return rooms.filter((r) => r.floor === selectedFloor);
  }, [rooms, selectedFloor]);

  const summary = summaryQuery.data;
  const isSummaryEmpty =
    !summary || summary.totalRooms === 0 || summary.overallGrade === 'N/A';

  const bestRoom = summary?.bestRoom ?? null;
  const attentionRoom = summary?.attentionRoom ?? null;
  const showAttentionRoom =
    attentionRoom !== null &&
    (!bestRoom || attentionRoom.roomId !== bestRoom.roomId);

  return (
    <div className="page">
      {/* Page Header */}
      <div className="page-header">
        <h1 className="page-title">Tổng quan</h1>
        <div className="flex items-center gap-2">
          <Link href="/floorplan" className="btn-secondary btn-sm">
            Bản đồ mặt bằng
          </Link>
        </div>
      </div>

      {summaryQuery.isError && (
        <ErrorBanner
          message="Không thể tải dữ liệu tổng quan toàn thư viện."
          onRetry={() => void summaryQuery.refetch()}
        />
      )}

      {/* 4 KPI Summary Cards */}
      <section aria-label="Chỉ số KPI toàn thư viện">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {/* KPI 1: Total Streaming Rooms */}
          <div className="card p-4">
            <span className="metric-label">Phòng trực tuyến</span>
            {summaryQuery.isLoading ? (
              <Skeleton className="mt-2 h-8 w-24" />
            ) : (
              <div className="mt-1 flex items-baseline gap-1.5">
                <span className="metric-value">
                  {summary?.totalRooms ?? 0}
                </span>
                <span className="metric-unit">/ {rooms.length} phòng</span>
              </div>
            )}
          </div>

          {/* KPI 2: Optimal Rooms Count (>= 75) */}
          <div className="card p-4">
            <span className="metric-label">Phòng đạt chuẩn (≥ 75đ)</span>
            {summaryQuery.isLoading ? (
              <Skeleton className="mt-2 h-8 w-24" />
            ) : (
              <div className="mt-1 flex items-baseline gap-1.5">
                <span className="metric-value">
                  {summary?.optimalRoomsCount ?? 0}
                </span>
                <span className="metric-unit">phòng</span>
              </div>
            )}
          </div>

          {/* KPI 3: Average Comfort Score & Overall Grade */}
          <div className="card p-4">
            <span className="metric-label">Điểm tiện nghi TB</span>
            {summaryQuery.isLoading ? (
              <Skeleton className="mt-2 h-8 w-32" />
            ) : (
              <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-baseline gap-0.5">
                  <span className="metric-value">
                    {isSummaryEmpty
                      ? '--'
                      : formatMetrics.comfortScore(
                          summary?.averageComfortScore
                        )}
                  </span>
                  <span className="metric-unit">/100</span>
                </div>
                <GradeBadge
                  grade={summary?.overallGrade ?? 'N/A'}
                  score={summary?.averageComfortScore}
                />
              </div>
            )}
          </div>

          {/* KPI 4: Active / Unread Alerts */}
          <div className="card p-4">
            <span className="metric-label">Cảnh báo mở</span>
            {!capabilities.canViewAlerts ? (
              <div className="mt-2">
                <span className="badge-neutral">Nội bộ</span>
              </div>
            ) : unreadAlertsQuery.isLoading ? (
              <Skeleton className="mt-2 h-8 w-20" />
            ) : (
              <div className="mt-1 flex items-baseline justify-between gap-2">
                <span
                  className={`metric-value ${
                    (unreadAlertsQuery.data ?? 0) > 0
                      ? 'text-red-600'
                      : 'text-slate-900'
                  }`}
                >
                  {unreadAlertsQuery.data ?? 0}
                </span>
                <Link
                  href="/alerts"
                  className="inline-flex items-center gap-0.5 text-xs font-medium text-slate-600 hover:text-slate-900"
                >
                  Chi tiết
                  <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                </Link>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Compact Spotlight Section: Best Room & Attention Room */}
      <section aria-label="Điểm sáng & Cảnh báo phòng đọc">
        {summaryQuery.isLoading ? (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Skeleton className="h-20" />
            <Skeleton className="h-20" />
          </div>
        ) : isSummaryEmpty ? (
          <EmptyState
            title="Đang chờ dữ liệu tổng hợp"
            description={UI_TEXT_VI.emptySummaryWaiting}
          />
        ) : (
          <div
            className={`grid grid-cols-1 gap-3 ${
              showAttentionRoom ? 'lg:grid-cols-2' : 'lg:grid-cols-1'
            }`}
          >
            {bestRoom && (
              <div className="card flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="dot bg-emerald-500" aria-hidden="true" />
                    <span className="text-xs font-medium text-slate-500">
                      Phòng lý tưởng nhất
                    </span>
                  </div>
                  <h2 className="mt-0.5 truncate text-sm font-semibold text-slate-900">
                    {resolveDisplayRoomName(
                      bestRoom.roomId,
                      bestRoom.roomName
                    )}
                  </h2>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-mono text-xs text-slate-600">
                    {formatMetrics.comfortScore(bestRoom.comfortScore)}đ ·{' '}
                    {formatMetrics.temperature(bestRoom.temperature)} ·{' '}
                    {formatMetrics.noise(bestRoom.noiseAvg)}
                  </span>
                  <GradeBadge
                    grade={bestRoom.grade}
                    score={bestRoom.comfortScore}
                  />
                  <Link
                    href={`/rooms/${bestRoom.roomId}`}
                    className="btn-secondary btn-sm h-7 px-2.5 text-xs"
                  >
                    Xem
                  </Link>
                </div>
              </div>
            )}

            {showAttentionRoom && attentionRoom && (
              <div className="card flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="dot bg-amber-500" aria-hidden="true" />
                    <span className="text-xs font-medium text-slate-500">
                      Cần chú ý ·{' '}
                      {attentionRoom.bottleneckReason
                        ? formatBottleneckReasonVi(
                            attentionRoom.bottleneckReason
                          )
                        : UI_TEXT_VI.optimalStatus}
                    </span>
                  </div>
                  <h2 className="mt-0.5 truncate text-sm font-semibold text-slate-900">
                    {resolveDisplayRoomName(
                      attentionRoom.roomId,
                      attentionRoom.roomName
                    )}
                  </h2>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-mono text-xs text-slate-600">
                    {formatMetrics.comfortScore(attentionRoom.comfortScore)}đ ·{' '}
                    {formatMetrics.temperature(attentionRoom.temperature)} ·{' '}
                    {formatMetrics.noise(attentionRoom.noiseAvg)}
                  </span>
                  <GradeBadge
                    grade={attentionRoom.grade}
                    score={attentionRoom.comfortScore}
                  />
                  <Link
                    href={`/rooms/${attentionRoom.roomId}`}
                    className="btn-secondary btn-sm h-7 px-2.5 text-xs"
                  >
                    Kiểm tra
                  </Link>
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Room Telemetry Grid with Floor Filter */}
      <section
        aria-label="Danh sách trạng thái từng phòng đọc"
        className="space-y-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="section-title">Danh sách phòng đọc</h2>

          {/* Floor Filter */}
          <div className="segmented" role="group" aria-label="Lọc theo tầng">
            <button
              type="button"
              onClick={() => setSelectedFloor('ALL')}
              className={`segmented-item ${
                selectedFloor === 'ALL' ? 'segmented-item-active' : ''
              }`}
            >
              Tất cả ({rooms.length})
            </button>
            {availableFloors.map((fl) => (
              <button
                key={fl}
                type="button"
                onClick={() => setSelectedFloor(fl)}
                className={`segmented-item ${
                  selectedFloor === fl ? 'segmented-item-active' : ''
                }`}
              >
                Tầng {fl}
              </button>
            ))}
          </div>
        </div>

        {roomsQuery.isLoading ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            <Skeleton className="h-40" />
            <Skeleton className="h-40" />
            <Skeleton className="h-40" />
          </div>
        ) : filteredRooms.length === 0 ? (
          <EmptyState
            title={UI_TEXT_VI.emptyRoomsFloor}
            description="Hãy chọn tầng khác hoặc kiểm tra danh mục phòng đọc."
            actionLabel={
              selectedFloor !== 'ALL' ? 'Xem tất cả các tầng' : undefined
            }
            onAction={
              selectedFloor !== 'ALL'
                ? () => setSelectedFloor('ALL')
                : undefined
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {filteredRooms.map((room) => (
              <RoomTelemetryCard
                key={room.id}
                room={room}
                stompConnected={stompConnected}
              />
            ))}
          </div>
        )}
      </section>

      {/* Collapsible Latest Alerts Section */}
      {capabilities.canViewAlerts && (
        <CollapsibleSection
          title="Cảnh báo gần đây"
          badge={
            <span className="badge-neutral">
              {recentAlertsQuery.data?.content.length ?? 0} bản ghi
            </span>
          }
          actions={
            <Link
              href="/alerts"
              className="inline-flex items-center gap-0.5 text-xs font-medium text-slate-600 hover:text-slate-900"
            >
              Tất cả
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          }
          defaultOpen={(unreadAlertsQuery.data ?? 0) > 0}
        >
          {recentAlertsQuery.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </div>
          ) : (recentAlertsQuery.data?.content.length ?? 0) === 0 ? (
            <p className="text-xs text-slate-500">
              {UI_TEXT_VI.emptyAlertsStable}
            </p>
          ) : (
            <div className="table-wrap -mx-4 -my-3.5">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Trạng thái</th>
                    <th>Loại sự cố</th>
                    <th>Phòng / Thiết bị</th>
                    <th>Nội dung</th>
                    <th>Thời điểm</th>
                  </tr>
                </thead>
                <tbody>
                  {recentAlertsQuery.data?.content.map((alert) => {
                    const target = resolveAlertFloorplanTarget(alert, rooms);
                    return (
                      <tr key={alert.id}>
                        <td>
                          <AlertStatusBadge status={alert.status} />
                        </td>
                        <td>
                          <AlertTypeBadge type={alert.type} />
                        </td>
                        <td>
                          <Link
                            href={target.href}
                            className="inline-flex items-center gap-1 font-medium text-slate-900 hover:text-brand-600"
                            title="Mở đúng phòng & node cảnh báo trên bản đồ nhiệt"
                          >
                            <MapPin
                              className="h-3.5 w-3.5 text-rose-500 shrink-0"
                              aria-hidden="true"
                            />
                            <span>
                              {alert.roomId
                                ? resolveDisplayRoomName(
                                    alert.roomId,
                                    alert.roomId
                                  )
                                : alert.hardwareId}
                            </span>
                            {alert.roomId && alert.hardwareId && (
                              <span className="font-mono text-2xs text-slate-400">
                                ({alert.hardwareId})
                              </span>
                            )}
                          </Link>
                        </td>
                        <td>{alert.message}</td>
                        <td className="whitespace-nowrap tabular text-slate-500 text-xs">
                          {formatVietnamDateTime(alert.startedAt)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CollapsibleSection>
      )}
    </div>
  );
}
