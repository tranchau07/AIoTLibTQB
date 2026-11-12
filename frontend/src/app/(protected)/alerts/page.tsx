'use client';

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  MapPin,
  RotateCw,
  ShieldAlert,
  Volume2,
  VolumeX,
} from 'lucide-react';
import {
  EmptyState,
  ErrorBanner,
  PaginationBar,
  Skeleton,
  useToast,
} from '@/components/ui/primitives';
import { resolveAlertFloorplanTarget } from '@/features/alerts/navigation';
import {
  useAcknowledgeAlertMutation,
  useAlertsQuery,
  useResolveAlertMutation,
  useUnreadAlertsCountQuery,
} from '@/features/alerts/queries';
import {
  ALERT_STATUS_META,
  ALERT_TYPE_META,
  AlertSeverityBadge,
  AlertStatusBadge,
  AlertTypeBadge,
} from '@/features/alerts/components/AlertBadges';
import { useAuthStore } from '@/features/auth/store';
import { useDevicesQuery } from '@/features/devices/queries';
import { useRoomsQuery } from '@/features/rooms/queries';
import {
  formatRelativeTimeVi,
  formatVietnamDateTime,
} from '@/lib/format/datetime';
import { formatNumber } from '@/lib/format/metrics';
import { ApiError } from '@/lib/http/error-mapper';
import { useStompConnectionState } from '@/lib/realtime/use-room-stream';
import { ERROR_MESSAGES_VI, UI_TEXT_VI } from '@/messages/vi';
import type { AlertResponse, AlertStatus, AlertType } from '@/types/api';

const PAGE_SIZE = 10;

const ALERT_TYPES: AlertType[] = [
  'NOISE_EXCEEDED',
  'AIR_UNHEALTHY',
  'DEVICE_OFFLINE',
  'SENSOR_MALFUNCTION',
];

const ALERT_STATUSES: AlertStatus[] = [
  'FIRING',
  'ACKNOWLEDGED',
  'RESOLVED',
  'PENDING',
];

export default function AlertsCenterPage() {
  const router = useRouter();
  const capabilities = useAuthStore((s) => s.capabilities);
  const { pushToast, audioMuted, setAudioMuted } = useToast();

  const [selectedRoomId, setSelectedRoomId] = useState<string>('');
  const [selectedType, setSelectedType] = useState<AlertType | ''>('');
  const [selectedStatus, setSelectedStatus] = useState<AlertStatus | ''>('');
  const [sortBy, setSortBy] = useState<'startedAt' | 'severity'>('startedAt');
  const [page, setPage] = useState<number>(0);

  const stompConnected = useStompConnectionState();

  const unreadCountQuery = useUnreadAlertsCountQuery(capabilities.canViewAlerts);
  const roomsQuery = useRoomsQuery(
    { page: 0, size: 100 },
    capabilities.canViewAlerts
  );
  const devicesQuery = useDevicesQuery(
    { page: 0, size: 100 },
    capabilities.canViewDevices
  );

  const filterParams = useMemo(
    () => ({
      roomId: selectedRoomId || undefined,
      type: selectedType || undefined,
      status: selectedStatus || undefined,
      sortBy,
      direction: 'DESC' as const,
      page,
      size: PAGE_SIZE,
    }),
    [selectedRoomId, selectedType, selectedStatus, sortBy, page]
  );

  const alertsQuery = useAlertsQuery(filterParams, capabilities.canViewAlerts);
  const acknowledgeMutation = useAcknowledgeAlertMutation();
  const resolveMutation = useResolveAlertMutation();

  const rooms = useMemo(
    () => roomsQuery.data?.content ?? [],
    [roomsQuery.data]
  );
  const devices = useMemo(
    () => devicesQuery.data?.content ?? [],
    [devicesQuery.data]
  );

  const roomsMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of rooms) {
      map.set(r.id, `${r.name} (${r.code})`);
    }
    return map;
  }, [rooms]);

  const resolveRoomLabel = (roomId?: string | null) => {
    if (!roomId) return 'Toàn cục';
    return roomsMap.get(roomId) ?? roomId;
  };

  const handleAcknowledge = async (alert: AlertResponse) => {
    try {
      await acknowledgeMutation.mutateAsync(alert.id);
      const target = resolveAlertFloorplanTarget(alert, rooms, devices);
      pushToast({
        title: 'Đã tiếp nhận & định vị bản đồ nhiệt',
        message: `Đang chuyển tới ${resolveRoomLabel(target.roomId)} · Node ${target.hardwareId ?? target.deviceId ?? alert.id.slice(0, 8)} trên bản đồ nhiệt.`,
        variant: 'success',
      });
      router.push(target.href);
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : 'Không thể tiếp nhận cảnh báo.';
      pushToast({
        title: 'Thao tác thất bại',
        message: msg,
        variant: 'danger',
      });
    }
  };

  const handleResolve = async (alert: AlertResponse) => {
    try {
      await resolveMutation.mutateAsync(alert.id);
      pushToast({
        title: 'Đã đóng sự cố',
        message: `Sự cố ${alert.id.slice(0, 8)} đã được đóng thành công.`,
        variant: 'success',
      });
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : 'Không thể đóng cảnh báo.';
      pushToast({
        title: 'Thao tác thất bại',
        message: msg,
        variant: 'danger',
      });
    }
  };

  const hasActiveFilters = Boolean(
    selectedRoomId || selectedType || selectedStatus
  );

  const handleResetFilters = () => {
    setSelectedRoomId('');
    setSelectedType('');
    setSelectedStatus('');
    setPage(0);
  };

  if (!capabilities.canViewAlerts) {
    return (
      <div className="page">
        <ErrorBanner message="Bạn không có quyền xem dữ liệu cảnh báo vận hành (VIEW_ALERTS)." />
      </div>
    );
  }

  const unreadCount = unreadCountQuery.data ?? 0;
  const alertsPage = alertsQuery.data;
  const alerts = alertsPage?.content ?? [];

  return (
    <div className="page">
      {/* Header */}
      <div className="page-header">
        <h1 className="page-title">Cảnh báo &amp; Sự cố</h1>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setAudioMuted(!audioMuted)}
            className="btn-secondary btn-sm"
            title={
              audioMuted
                ? 'Bật âm báo sự cố khẩn cấp'
                : 'Tắt âm báo sự cố khẩn cấp'
            }
          >
            {audioMuted ? (
              <VolumeX className="h-3.5 w-3.5 text-slate-400" />
            ) : (
              <Volume2 className="h-3.5 w-3.5 text-brand-600" />
            )}
            <span>{audioMuted ? 'Đã tắt chuông' : 'Chuông báo'}</span>
          </button>

          <button
            type="button"
            onClick={() =>
              setSortBy((prev) =>
                prev === 'startedAt' ? 'severity' : 'startedAt'
              )
            }
            className="btn-secondary btn-sm"
          >
            <span>
              Sắp xếp:{' '}
              {sortBy === 'severity' ? 'Mức độ ưu tiên' : 'Mới nhất'}
            </span>
          </button>

          <span className="badge-neutral">
            <span
              className={`dot ${
                stompConnected ? 'bg-emerald-500' : 'bg-amber-500 animate-pulse'
              }`}
              aria-hidden="true"
            />
            <span>{stompConnected ? 'Trực tiếp' : 'Đang kết nối lại...'}</span>
          </span>
        </div>
      </div>

      {/* Overview KPI Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="card p-4">
          <div className="flex items-center justify-between">
            <span className="metric-label">Cảnh báo đang kích hoạt</span>
            <span
              className={`dot ${
                unreadCount > 0 ? 'bg-red-500 animate-pulse' : 'bg-emerald-500'
              }`}
              aria-hidden="true"
            />
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            {unreadCountQuery.isLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <span
                className={`metric-value ${
                  unreadCount > 0 ? 'text-red-600' : 'text-emerald-600'
                }`}
              >
                {unreadCount}
              </span>
            )}
            <span className="metric-unit">sự cố cần xử lý</span>
          </div>
        </div>

        <div className="card p-4">
          <span className="metric-label">Tổng số bản ghi theo bộ lọc</span>
          <div className="mt-1 flex items-baseline gap-2">
            {alertsQuery.isLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <span className="metric-value">
                {alertsPage?.totalElements ?? 0}
              </span>
            )}
            <span className="metric-unit">bản ghi</span>
          </div>
        </div>

        <div className="card p-4">
          <span className="metric-label">Quyền vận hành FSM</span>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <span
              className={capabilities.canAcknowledgeAlert ? 'badge-brand' : 'badge-neutral'}
            >
              Tiếp nhận sự cố
            </span>
            <span
              className={capabilities.canResolveAlert ? 'badge-success' : 'badge-neutral'}
            >
              Đóng sự cố
            </span>
          </div>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="card p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label htmlFor="filter-room" className="label">
              Phòng đọc
            </label>
            <select
              id="filter-room"
              value={selectedRoomId}
              onChange={(e) => {
                setSelectedRoomId(e.target.value);
                setPage(0);
              }}
              className="select text-xs"
            >
              <option value="">Tất cả phòng đọc</option>
              {(roomsQuery.data?.content ?? []).map((room) => (
                <option key={room.id} value={room.id}>
                  Tầng {room.floor} — {room.name} ({room.code})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="filter-type" className="label">
              Loại sự cố
            </label>
            <select
              id="filter-type"
              value={selectedType}
              onChange={(e) => {
                setSelectedType(e.target.value as AlertType | '');
                setPage(0);
              }}
              className="select text-xs"
            >
              <option value="">Tất cả loại sự cố</option>
              {ALERT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {ALERT_TYPE_META[t].labelVi}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="filter-status" className="label">
              Trạng thái FSM
            </label>
            <select
              id="filter-status"
              value={selectedStatus}
              onChange={(e) => {
                setSelectedStatus(e.target.value as AlertStatus | '');
                setPage(0);
              }}
              className="select text-xs"
            >
              <option value="">Tất cả trạng thái</option>
              {ALERT_STATUSES.map((st) => (
                <option key={st} value={st}>
                  {ALERT_STATUS_META[st].labelVi}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-end gap-2">
            <button
              type="button"
              onClick={handleResetFilters}
              disabled={!hasActiveFilters}
              className="btn-secondary btn-sm flex-1"
            >
              Đặt lại
            </button>
            <button
              type="button"
              onClick={() => {
                void alertsQuery.refetch();
                void unreadCountQuery.refetch();
              }}
              className="btn-secondary btn-sm"
              aria-label="Làm mới"
            >
              <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="card">
        {alertsQuery.isLoading ? (
          <div className="p-5 space-y-3" aria-busy="true">
            {Array.from({ length: 5 }).map((_, idx) => (
              <Skeleton key={idx} className="h-12 w-full" />
            ))}
          </div>
        ) : alertsQuery.isError ? (
          <div className="p-5">
            <ErrorBanner
              message={
                alertsQuery.error instanceof ApiError
                  ? alertsQuery.error.message
                  : ERROR_MESSAGES_VI[9999]
              }
              onRetry={() => void alertsQuery.refetch()}
            />
          </div>
        ) : alerts.length === 0 ? (
          <div className="p-5">
            <EmptyState
              title="Không có cảnh báo nào"
              description={UI_TEXT_VI.emptyAlertsStable}
              actionLabel={hasActiveFilters ? 'Xóa bộ lọc tìm kiếm' : undefined}
              onAction={hasActiveFilters ? handleResetFilters : undefined}
            />
          </div>
        ) : (
          <>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Trạng thái &amp; Mức độ</th>
                    <th>Loại sự cố</th>
                    <th>Phòng đọc &amp; Thiết bị</th>
                    <th>Giá trị / Ngưỡng</th>
                    <th>Nội dung &amp; Quy trình xử lý (SOP)</th>
                    <th>Thời gian</th>
                    <th className="text-right">Thao tác FSM</th>
                  </tr>
                </thead>
                <tbody>
                  {alerts.map((alert) => {
                    const typeMeta = ALERT_TYPE_META[alert.type];
                    const unit = typeMeta?.unit;
                    const decimals = typeMeta?.decimals ?? 1;
                    const floorplanTarget = resolveAlertFloorplanTarget(
                      alert,
                      rooms,
                      devices
                    );

                    const canShowAck =
                      capabilities.canAcknowledgeAlert &&
                      alert.status === 'FIRING';
                    const canShowResolve =
                      capabilities.canResolveAlert &&
                      alert.status !== 'RESOLVED';

                    const isMutatingThis =
                      (acknowledgeMutation.isPending &&
                        acknowledgeMutation.variables === alert.id) ||
                      (resolveMutation.isPending &&
                        resolveMutation.variables === alert.id);

                    return (
                      <tr key={alert.id}>
                        <td className="whitespace-nowrap">
                          <div className="flex flex-col items-start gap-1">
                            <AlertStatusBadge status={alert.status} />
                            <AlertSeverityBadge severity={alert.severity} />
                          </div>
                        </td>

                        <td className="whitespace-nowrap">
                          <AlertTypeBadge type={alert.type} />
                        </td>

                        <td>
                          <Link
                            href={floorplanTarget.href}
                            className="group inline-flex flex-col rounded-md px-1 py-0.5 -mx-1 transition-colors hover:bg-slate-100"
                            title="Mở đúng phòng & node cảnh báo trên bản đồ nhiệt"
                          >
                            <span className="inline-flex items-center gap-1 font-medium text-slate-900 group-hover:text-brand-600">
                              <MapPin
                                className="h-3.5 w-3.5 text-rose-500 shrink-0"
                                aria-hidden="true"
                              />
                              <span>{resolveRoomLabel(floorplanTarget.roomId ?? alert.roomId)}</span>
                            </span>
                            <span className="font-mono text-2xs text-slate-500 group-hover:text-slate-700">
                              Node: {floorplanTarget.hardwareId || alert.hardwareId || '--'}
                            </span>
                          </Link>
                        </td>

                        <td className="whitespace-nowrap tabular">
                          <div className="font-semibold text-red-600">
                            Đo: {formatNumber(alert.currentValue, decimals, unit)}
                          </div>
                          <div className="text-2xs text-slate-400">
                            Ngưỡng: {formatNumber(alert.threshold, decimals, unit)}
                          </div>
                        </td>

                        <td className="max-w-xs text-xs text-slate-700">
                          <div>{alert.message || '--'}</div>
                          {alert.recommendedAction && (
                            <div className="mt-1 rounded border border-amber-200 bg-amber-50/70 px-2 py-1 text-2xs text-amber-900">
                              <strong className="font-semibold">SOP:</strong>{' '}
                              {alert.recommendedAction}
                            </div>
                          )}
                        </td>

                        <td className="whitespace-nowrap text-xs text-slate-500 tabular">
                          <div>
                            {formatVietnamDateTime(alert.startedAt)}
                          </div>
                          <div className="text-2xs text-slate-400">
                            {formatRelativeTimeVi(alert.startedAt)}
                          </div>
                        </td>

                        <td className="text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-1.5 justify-end">
                            {canShowAck && (
                              <button
                                type="button"
                                disabled={isMutatingThis}
                                onClick={() => void handleAcknowledge(alert)}
                                className="btn-primary btn-sm"
                                title="Tiếp nhận sự cố và định vị ngay tới phòng & node trên bản đồ nhiệt"
                              >
                                <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
                                <span>Tiếp nhận</span>
                              </button>
                            )}
                            <Link
                              href={floorplanTarget.href}
                              className="btn-secondary btn-sm"
                              title="Định vị phòng & node cảnh báo trên bản đồ nhiệt 2D"
                            >
                              <MapPin className="h-3.5 w-3.5 text-rose-600" aria-hidden="true" />
                              <span>Bản đồ nhiệt</span>
                            </Link>
                            {canShowResolve && (
                              <button
                                type="button"
                                disabled={isMutatingThis}
                                onClick={() => void handleResolve(alert)}
                                className="btn-secondary btn-sm"
                              >
                                Đóng sự cố
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <PaginationBar
              page={alertsPage?.page ?? page}
              totalPages={alertsPage?.totalPages ?? 1}
              totalElements={alertsPage?.totalElements ?? alerts.length}
              onPageChange={(nextPage) => setPage(nextPage)}
            />
          </>
        )}
      </div>
    </div>
  );
}
