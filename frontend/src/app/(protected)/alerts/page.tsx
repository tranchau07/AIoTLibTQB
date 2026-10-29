'use client';

import React, { useMemo, useState } from 'react';
import {
  RotateCw,
  ShieldAlert,
} from 'lucide-react';
import {
  EmptyState,
  ErrorBanner,
  PaginationBar,
  Skeleton,
  useToast,
} from '@/components/ui/primitives';
import {
  useAcknowledgeAlertMutation,
  useAlertsQuery,
  useResolveAlertMutation,
  useUnreadAlertsCountQuery,
} from '@/features/alerts/queries';
import {
  ALERT_STATUS_META,
  ALERT_TYPE_META,
  AlertStatusBadge,
  AlertTypeBadge,
} from '@/features/alerts/components/AlertBadges';
import { useAuthStore } from '@/features/auth/store';
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
  const capabilities = useAuthStore((s) => s.capabilities);
  const { pushToast } = useToast();

  const [selectedRoomId, setSelectedRoomId] = useState<string>('');
  const [selectedType, setSelectedType] = useState<AlertType | ''>('');
  const [selectedStatus, setSelectedStatus] = useState<AlertStatus | ''>('');
  const [page, setPage] = useState<number>(0);

  const stompConnected = useStompConnectionState();

  const unreadCountQuery = useUnreadAlertsCountQuery(capabilities.canViewAlerts);
  const roomsQuery = useRoomsQuery(
    { page: 0, size: 100 },
    capabilities.canViewAlerts
  );

  const filterParams = useMemo(
    () => ({
      roomId: selectedRoomId || undefined,
      type: selectedType || undefined,
      status: selectedStatus || undefined,
      page,
      size: PAGE_SIZE,
    }),
    [selectedRoomId, selectedType, selectedStatus, page]
  );

  const alertsQuery = useAlertsQuery(filterParams, capabilities.canViewAlerts);
  const acknowledgeMutation = useAcknowledgeAlertMutation();
  const resolveMutation = useResolveAlertMutation();

  const roomsMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of roomsQuery.data?.content ?? []) {
      map.set(r.id, `${r.name} (${r.code})`);
    }
    return map;
  }, [roomsQuery.data]);

  const resolveRoomLabel = (roomId?: string | null) => {
    if (!roomId) return 'Toàn cục';
    return roomsMap.get(roomId) ?? roomId;
  };

  const handleAcknowledge = async (alert: AlertResponse) => {
    try {
      await acknowledgeMutation.mutateAsync(alert.id);
      pushToast({
        title: 'Đã tiếp nhận sự cố',
        message: `Sự cố ${alert.id.slice(0, 8)} đã được chuyển sang trạng thái đã tiếp nhận.`,
        variant: 'success',
      });
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
        <div>
          <h1 className="page-title">Trung tâm Cảnh báo & Xử lý Sự cố</h1>
          <p className="page-subtitle">
            Theo dõi máy trạng thái FSM (Chờ xác nhận → Kích hoạt → Tiếp nhận → Đã đóng)
          </p>
        </div>

        <div className="flex items-center gap-2">
          <span className="badge-neutral">
            <span
              className={`dot ${
                stompConnected ? 'bg-emerald-500' : 'bg-amber-500 animate-pulse'
              }`}
              aria-hidden="true"
            />
            <span>
              {stompConnected
                ? 'Kênh thời gian thực trực tuyến'
                : 'Đang kết nối lại kênh realtime...'}
            </span>
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
                    <th>Trạng thái</th>
                    <th>Loại sự cố</th>
                    <th>Phòng đọc & Thiết bị</th>
                    <th>Giá trị / Ngưỡng</th>
                    <th>Nội dung cảnh báo</th>
                    <th>Thời gian</th>
                    <th className="text-right">Thao tác FSM</th>
                  </tr>
                </thead>
                <tbody>
                  {alerts.map((alert) => {
                    const typeMeta = ALERT_TYPE_META[alert.type];
                    const unit = typeMeta?.unit;
                    const decimals = typeMeta?.decimals ?? 1;

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
                          <AlertStatusBadge status={alert.status} />
                        </td>

                        <td className="whitespace-nowrap">
                          <AlertTypeBadge type={alert.type} />
                        </td>

                        <td>
                          <div className="font-medium text-slate-900">
                            {resolveRoomLabel(alert.roomId)}
                          </div>
                          <div className="font-mono text-2xs text-slate-400">
                            {alert.hardwareId || '--'}
                          </div>
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
                          {alert.message || '--'}
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
                              >
                                Tiếp nhận
                              </button>
                            )}
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
                            {!canShowAck && !canShowResolve && (
                              <span className="text-xs text-slate-400 italic">
                                {alert.status === 'RESOLVED'
                                  ? 'Đã hoàn tất'
                                  : '--'}
                              </span>
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
