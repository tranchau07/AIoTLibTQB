'use client';

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  CheckCircle2,
  MapPin,
  RotateCw,
  Tag,
  UserCheck,
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
  type QuickResolutionTagOption,
  resolveQuickTagsForAlert,
  resolveResolutionTagLabelVi,
} from '@/features/alerts/quickTags';
import {
  useAlertsQuery,
  useUnreadAlertsCountQuery,
  useUpdateAlertWorkflowMutation,
} from '@/features/alerts/queries';
import {
  ALERT_STATUS_META,
  ALERT_TYPE_META,
  AlertSeverityBadge,
  AlertStatusBadge,
  AlertTypeBadge,
  resolveAlertValueFormat,
} from '@/features/alerts/components/AlertBadges';
import { useAuthStore } from '@/features/auth/store';
import { useDevicesQuery } from '@/features/devices/queries';
import { useRoomsQuery } from '@/features/rooms/queries';
import {
  formatRelativeTimeVi,
  formatVietnamDateTime,
} from '@/lib/format/datetime';
import {
  formatBottleneckReasonVi,
  formatNumber,
} from '@/lib/format/metrics';
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
  const { pushToast, audioMuted, setAudioMuted } = useToast();

  const [selectedRoomId, setSelectedRoomId] = useState<string>('');
  const [selectedType, setSelectedType] = useState<AlertType | ''>('');
  const [selectedStatus, setSelectedStatus] = useState<AlertStatus | ''>('');
  const [sortBy, setSortBy] = useState<'startedAt' | 'severity'>('startedAt');
  const [page, setPage] = useState<number>(0);
  const [pickingTagAlertId, setPickingTagAlertId] = useState<string | null>(
    null
  );

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
  const updateWorkflowMutation = useUpdateAlertWorkflowMutation();

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

  // CHẠM 1: Nhận xử lý ngay trên bảng, KHÔNG cưỡng bức chuyển trang sang /floorplan
  const handleClaimAlert = async (alert: AlertResponse) => {
    try {
      await updateWorkflowMutation.mutateAsync({
        id: alert.id,
        body: { workflowStatus: 'IN_PROGRESS' },
      });
      pushToast({
        title: 'Đã nhận xử lý sự cố',
        message: `Đã gán phụ trách tại ${resolveRoomLabel(alert.roomId)}. Bấm "Bản đồ nhiệt" nếu cần xem vị trí trạm.`,
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

  // CHẠM 2: Chọn 1 Chip Tag chốt ca trực
  const handleSelectQuickTag = async (
    alert: AlertResponse,
    tag: QuickResolutionTagOption
  ) => {
    try {
      await updateWorkflowMutation.mutateAsync({
        id: alert.id,
        body: {
          workflowStatus: 'RESOLVED',
          resolutionTag: tag.code,
          handlingNote: alert.handlingNote?.trim() || tag.defaultNoteVi,
        },
      });
      setPickingTagAlertId(null);
      pushToast({
        title: 'Đã lưu nhật ký & đóng sự cố',
        message: `Kết quả "${tag.labelVi}" tại ${resolveRoomLabel(alert.roomId)} đã được ghi nhận.`,
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
            onClick={() => {
              setSortBy((prev) =>
                prev === 'startedAt' ? 'severity' : 'startedAt'
              );
              setPage(0);
            }}
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
          <span className="metric-label">Quy trình 2 chạm ca trực</span>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <span
              className={capabilities.canAcknowledgeAlert ? 'badge-brand' : 'badge-neutral'}
            >
              1. Nhận xử lý
            </span>
            <span
              className={capabilities.canResolveAlert ? 'badge-success' : 'badge-neutral'}
            >
              2. Đã nhắc xong + Tag
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
                    <th>Phòng đọc &amp; Tâm điểm</th>
                    <th>Giá trị / Ngưỡng</th>
                    <th>Nội dung, SOP &amp; Nhật ký ca trực</th>
                    <th>Thời gian</th>
                    <th className="text-right">Thao tác 2 chạm</th>
                  </tr>
                </thead>
                <tbody>
                  {alerts.map((alert) => {
                    const valueFormat = resolveAlertValueFormat(alert);
                    const floorplanTarget = resolveAlertFloorplanTarget(
                      alert,
                      rooms,
                      devices
                    );
                    const isResolved = alert.status === 'RESOLVED';
                    const isClaimed =
                      !isResolved &&
                      (alert.workflowStatus === 'IN_PROGRESS' ||
                        Boolean(alert.assignedTo));
                    const canShowClaim =
                      capabilities.canAcknowledgeAlert &&
                      !isResolved &&
                      !isClaimed;
                    const canShowResolve = capabilities.canResolveAlert;
                    const isMutatingThis =
                      updateWorkflowMutation.isPending &&
                      updateWorkflowMutation.variables?.id === alert.id;
                    const showQuickTags =
                      pickingTagAlertId === alert.id ||
                      (!isResolved && Boolean(alert.sensorRecovered));
                    const quickTags = resolveQuickTagsForAlert(alert);
                    const tagLabel = resolveResolutionTagLabelVi(
                      alert.resolutionTag
                    );
                    const spreadCount =
                      (alert.affectedNodes?.length ?? 0) > 1
                        ? (alert.affectedNodes?.length ?? 1) - 1
                        : 0;

                    return (
                      <tr key={alert.id}>
                        <td className="whitespace-nowrap">
                          <div className="flex flex-col items-start gap-1">
                            <AlertStatusBadge status={alert.status} />
                            <AlertSeverityBadge severity={alert.severity} />
                            {alert.sensorRecovered && !isResolved && (
                              <span
                                data-testid={`alerts-row-recovered-${alert.id}`}
                                className="inline-flex items-center rounded border border-emerald-300 bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-900"
                              >
                                Đã êm — Chờ xác nhận
                              </span>
                            )}
                          </div>
                        </td>

                        <td className="whitespace-nowrap">
                          <AlertTypeBadge type={alert.type} />
                        </td>

                        <td>
                          <Link
                            href={floorplanTarget.href}
                            className="group inline-flex flex-col rounded-md px-1 py-0.5 -mx-1 transition-colors hover:bg-slate-100"
                            title="Mở đúng phòng & node tâm điểm trên bản đồ nhiệt"
                          >
                            <span className="inline-flex items-center gap-1 font-medium text-slate-900 group-hover:text-brand-600">
                              <MapPin
                                className="h-3.5 w-3.5 text-rose-500 shrink-0"
                                aria-hidden="true"
                              />
                              <span>
                                {resolveRoomLabel(
                                  floorplanTarget.roomId ?? alert.roomId
                                )}
                              </span>
                            </span>
                            <span className="font-mono text-2xs text-slate-500 group-hover:text-slate-700">
                              Tâm điểm:{' '}
                              {floorplanTarget.hardwareId ||
                                alert.hardwareId ||
                                '--'}
                              {spreadCount > 0
                                ? ` (+${spreadCount} trạm lan)`
                                : ''}
                            </span>
                          </Link>
                        </td>

                        <td className="whitespace-nowrap tabular">
                          {valueFormat.isOffline ? (
                            <>
                              <div className="font-semibold text-red-600">
                                Mất kết nối
                              </div>
                              <div className="text-2xs text-slate-400">
                                Ngưỡng: --
                              </div>
                            </>
                          ) : (
                            <>
                              <div className="font-semibold text-red-600">
                                Đo:{' '}
                                {formatNumber(
                                  alert.currentValue,
                                  valueFormat.decimals,
                                  valueFormat.unit
                                )}
                              </div>
                              <div className="text-2xs text-slate-400">
                                Ngưỡng:{' '}
                                {formatNumber(
                                  alert.threshold,
                                  valueFormat.decimals,
                                  valueFormat.unit
                                )}
                              </div>
                            </>
                          )}
                        </td>

                        <td className="max-w-xs text-xs text-slate-700">
                          <div>
                            {(alert.message &&
                              formatBottleneckReasonVi(alert.message)) ||
                              '--'}
                          </div>
                          {alert.recommendedAction && !isResolved && (
                            <div className="mt-1 rounded border border-amber-200 bg-amber-50/70 px-2 py-1 text-2xs text-amber-900">
                              <strong className="font-semibold">SOP:</strong>{' '}
                              {alert.recommendedAction}
                            </div>
                          )}
                          {(alert.assignedTo ||
                            tagLabel ||
                            alert.handlingNote) && (
                            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-2xs text-slate-600">
                              {alert.assignedTo && (
                                <span className="inline-flex items-center gap-1 rounded bg-sky-50 px-1.5 py-0.5 font-medium text-sky-900 ring-1 ring-inset ring-sky-200">
                                  <UserCheck className="h-2.5 w-2.5" />
                                  <span>{alert.assignedTo}</span>
                                </span>
                              )}
                              {tagLabel && (
                                <span className="inline-flex items-center gap-1 rounded bg-emerald-50 px-1.5 py-0.5 font-medium text-emerald-900 ring-1 ring-inset ring-emerald-200">
                                  <Tag className="h-2.5 w-2.5" />
                                  <span>{tagLabel}</span>
                                </span>
                              )}
                              {alert.handlingNote && (
                                <span className="text-slate-500">
                                  {alert.handlingNote}
                                </span>
                              )}
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

                        <td className="text-right">
                          <div className="flex flex-col items-end gap-1.5">
                            <div className="inline-flex flex-wrap items-center gap-1.5 justify-end whitespace-nowrap">
                              {canShowClaim && (
                                <button
                                  type="button"
                                  data-testid={`alerts-claim-${alert.id}`}
                                  disabled={isMutatingThis}
                                  onClick={() => void handleClaimAlert(alert)}
                                  className="btn-primary btn-sm"
                                  title="Nhận xử lý ngay tại bảng (không tự nhảy trang)"
                                >
                                  <UserCheck
                                    className="h-3.5 w-3.5"
                                    aria-hidden="true"
                                  />
                                  <span>Nhận xử lý</span>
                                </button>
                              )}
                              {canShowResolve && (
                                <button
                                  type="button"
                                  data-testid={`alerts-resolve-toggle-${alert.id}`}
                                  disabled={isMutatingThis}
                                  onClick={() =>
                                    setPickingTagAlertId((prev) =>
                                      prev === alert.id ? null : alert.id
                                    )
                                  }
                                  className={
                                    isResolved
                                      ? 'btn-secondary btn-sm'
                                      : 'inline-flex items-center gap-1 rounded-lg border border-emerald-300 bg-emerald-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50'
                                  }
                                >
                                  <CheckCircle2
                                    className="h-3.5 w-3.5"
                                    aria-hidden="true"
                                  />
                                  <span>
                                    {isResolved ? 'Sửa Tag' : 'Đã nhắc xong'}
                                  </span>
                                </button>
                              )}
                              <Link
                                href={floorplanTarget.href}
                                className="btn-secondary btn-sm"
                                title="Định vị phòng & node cảnh báo trên bản đồ nhiệt 2D"
                              >
                                <MapPin
                                  className="h-3.5 w-3.5 text-rose-600"
                                  aria-hidden="true"
                                />
                                <span>Bản đồ nhiệt</span>
                              </Link>
                            </div>

                            {canShowResolve && showQuickTags && (
                              <div
                                data-testid={`alerts-quick-tags-${alert.id}`}
                                className="flex max-w-xs flex-wrap justify-end gap-1 rounded-lg border border-emerald-200 bg-emerald-50/80 p-1.5"
                              >
                                {quickTags.map((tag) => (
                                  <button
                                    key={tag.code}
                                    type="button"
                                    disabled={isMutatingThis}
                                    data-testid={`alerts-tag-${alert.id}-${tag.code}`}
                                    onClick={() =>
                                      void handleSelectQuickTag(alert, tag)
                                    }
                                    className="rounded-full border border-emerald-300 bg-white px-2 py-0.5 text-[11px] font-medium text-emerald-900 hover:bg-emerald-600 hover:text-white disabled:opacity-50"
                                  >
                                    {tag.labelVi}
                                  </button>
                                ))}
                              </div>
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
