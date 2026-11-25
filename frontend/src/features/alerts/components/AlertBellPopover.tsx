'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  Bell,
  CheckCircle2,
  Edit3,
  MapPin,
  RotateCw,
  ShieldCheck,
  Tag,
  UserCheck,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { useToast } from '@/components/ui/primitives';
import {
  AlertSeverityBadge,
  AlertStatusBadge,
  AlertTypeBadge,
  resolveAlertValueFormat,
} from '@/features/alerts/components/AlertBadges';
import { resolveAlertFloorplanTarget } from '@/features/alerts/navigation';
import {
  type QuickResolutionTagOption,
  resolveQuickTagsForAlert,
  resolveResolutionTagLabelVi,
} from '@/features/alerts/quickTags';
import {
  useAlertsQuery,
  useUpdateAlertWorkflowMutation,
} from '@/features/alerts/queries';
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
import { upsertRealtimeAlertList } from '@/lib/realtime/stomp-client';
import type { AlertResponse } from '@/types/api';

export interface AlertBellPopoverProps {
  unreadCount: number;
  realtimeAlerts: readonly AlertResponse[];
  onAlertUpdated?: (updated: AlertResponse) => void;
  canViewAlerts: boolean;
  canAcknowledgeAlert: boolean;
  canResolveAlert: boolean;
  canViewDevices: boolean;
}

type BellFilterTab = 'OPEN' | 'ALL';

export function AlertBellPopover({
  unreadCount,
  realtimeAlerts,
  onAlertUpdated,
  canViewAlerts,
  canAcknowledgeAlert,
  canResolveAlert,
  canViewDevices,
}: AlertBellPopoverProps) {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const { audioMuted, setAudioMuted } = useToast();

  const [open, setOpen] = useState(false);
  const [filterTab, setFilterTab] = useState<BellFilterTab>('OPEN');
  const [pickingTagAlertId, setPickingTagAlertId] = useState<string | null>(
    null
  );
  const [editingAlertId, setEditingAlertId] = useState<string | null>(null);
  const [assigneeDraft, setAssigneeDraft] = useState('');
  const [noteDraft, setNoteDraft] = useState('');
  const [pendingAlertId, setPendingAlertId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    variant: 'success' | 'danger';
    text: string;
  } | null>(null);

  const alertsQuery = useAlertsQuery(
    {
      page: 0,
      size: 30,
      sortBy: 'severity',
      direction: 'DESC',
    },
    open && canViewAlerts
  );
  const roomsQuery = useRoomsQuery(
    { page: 0, size: 100 },
    open && canViewAlerts
  );
  const devicesQuery = useDevicesQuery(
    { page: 0, size: 100 },
    open && canViewDevices
  );

  const updateWorkflowMutation = useUpdateAlertWorkflowMutation();

  // Đóng popover khi click ra ngoài hoặc nhấn Escape
  useEffect(() => {
    if (!open) return;

    const handleMouseDown = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  // Tự động ẩn thông báo phản hồi nội bộ sau 3.5 giây
  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(null), 3500);
    return () => clearTimeout(timer);
  }, [feedback]);

  const rooms = useMemo(
    () => roomsQuery.data?.content ?? [],
    [roomsQuery.data]
  );
  const devices = useMemo(
    () => devicesQuery.data?.content ?? [],
    [devicesQuery.data]
  );

  const roomLabelMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of rooms) {
      map.set(r.id, `${r.name} (${r.code})`);
    }
    return map;
  }, [rooms]);

  // Hợp nhất dữ liệu từ API và các cảnh báo realtime STOMP theo thứ tự ưu tiên mức độ
  const mergedAlerts = useMemo(() => {
    let list: AlertResponse[] = alertsQuery.data?.content
      ? [...alertsQuery.data.content]
      : [];
    for (const rt of realtimeAlerts) {
      list = upsertRealtimeAlertList(list, rt, {
        sortBy: 'severity',
        direction: 'DESC',
        maxSize: 50,
      });
    }
    return list;
  }, [alertsQuery.data, realtimeAlerts]);

  const openAlerts = useMemo(
    () => mergedAlerts.filter((a) => a.status !== 'RESOLVED'),
    [mergedAlerts]
  );

  const displayedAlerts = filterTab === 'OPEN' ? openAlerts : mergedAlerts;

  const resolveRoomLabel = (roomId?: string | null) => {
    if (!roomId) return 'Toàn hệ thống';
    return roomLabelMap.get(roomId) ?? roomId;
  };

  // CHẠM 1: Nhận xử lý (tự gán người nhận & chuyển IN_PROGRESS)
  const handleClaimAlert = async (alert: AlertResponse) => {
    setPendingAlertId(alert.id);
    setFeedback(null);
    try {
      const updated = await updateWorkflowMutation.mutateAsync({
        id: alert.id,
        body: { workflowStatus: 'IN_PROGRESS' },
      });
      if (updated) onAlertUpdated?.(updated);
      setFeedback({
        variant: 'success',
        text: `Đã nhận xử lý tại ${resolveRoomLabel(alert.roomId)}.`,
      });
    } catch (err) {
      setFeedback({
        variant: 'danger',
        text:
          err instanceof ApiError
            ? err.message
            : 'Không thể tiếp nhận cảnh báo.',
      });
    } finally {
      setPendingAlertId(null);
    }
  };

  // CHẠM 2: Chọn 1 Chip Tag chốt đóng hoặc cập nhật bổ sung Tag sau khi đã đóng
  const handleSelectQuickTag = async (
    alert: AlertResponse,
    tag: QuickResolutionTagOption
  ) => {
    setPendingAlertId(alert.id);
    setFeedback(null);
    try {
      const updated = await updateWorkflowMutation.mutateAsync({
        id: alert.id,
        body: {
          workflowStatus: 'RESOLVED',
          resolutionTag: tag.code,
          handlingNote: alert.handlingNote?.trim() || tag.defaultNoteVi,
        },
      });
      if (updated) onAlertUpdated?.(updated);
      setPickingTagAlertId(null);
      setEditingAlertId(null);
      setFeedback({
        variant: 'success',
        text: `Đã chốt nhật ký "${tag.labelVi}" tại ${resolveRoomLabel(alert.roomId)}.`,
      });
    } catch (err) {
      setFeedback({
        variant: 'danger',
        text:
          err instanceof ApiError ? err.message : 'Không thể đóng cảnh báo.',
      });
    } finally {
      setPendingAlertId(null);
    }
  };

  const handleOpenWorkflowEdit = (alert: AlertResponse) => {
    if (editingAlertId === alert.id) {
      setEditingAlertId(null);
      return;
    }
    setEditingAlertId(alert.id);
    setAssigneeDraft(alert.assignedTo ?? '');
    setNoteDraft(alert.handlingNote ?? '');
  };

  const handleSaveWorkflow = async (alert: AlertResponse) => {
    setPendingAlertId(alert.id);
    setFeedback(null);
    try {
      const updated = await updateWorkflowMutation.mutateAsync({
        id: alert.id,
        body: {
          workflowStatus:
            alert.status === 'RESOLVED' ? 'RESOLVED' : undefined,
          assignedTo:
            alert.status === 'RESOLVED'
              ? undefined
              : assigneeDraft.trim() || undefined,
          handlingNote: noteDraft.trim() || undefined,
        },
      });
      if (updated) onAlertUpdated?.(updated);
      setEditingAlertId(null);
      setFeedback({
        variant: 'success',
        text: 'Đã lưu ghi chú ca trực.',
      });
    } catch (err) {
      setFeedback({
        variant: 'danger',
        text:
          err instanceof ApiError
            ? err.message
            : 'Không thể lưu ghi chú xử lý.',
      });
    } finally {
      setPendingAlertId(null);
    }
  };

  const handleLocateOnMap = (alert: AlertResponse) => {
    const target = resolveAlertFloorplanTarget(alert, rooms, devices);
    setOpen(false);
    router.push(target.href);
  };

  if (!canViewAlerts) return null;

  const badgeCount = Math.max(
    unreadCount,
    realtimeAlerts.filter((a) => a.status === 'FIRING' && !a.sensorRecovered)
      .length
  );

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        data-testid="alert-bell-button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Cảnh báo chưa đọc: ${badgeCount}`}
        title="Xem và xử lý cảnh báo"
        className={`btn-icon relative ${
          open ? 'bg-slate-100 text-slate-900' : ''
        }`}
      >
        <Bell className="h-4 w-4" aria-hidden="true" />
        {badgeCount > 0 && (
          <span
            data-testid="alert-bell-badge"
            className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold tabular-nums text-white ring-2 ring-white"
          >
            {badgeCount > 99 ? '99+' : badgeCount}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Thông báo cảnh báo"
          data-testid="alert-bell-popover"
          className="absolute right-0 top-full z-50 mt-2 flex max-h-[min(82vh,640px)] w-[min(480px,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl"
        >
          {/* Header */}
          <div className="flex items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/70 px-4 py-3">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-slate-900">
                Cảnh báo &amp; Sự cố
              </h2>
              <span className="rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-red-700 ring-1 ring-inset ring-red-200">
                {openAlerts.length} đang mở
              </span>
            </div>

            <div className="flex items-center gap-1">
              <button
                type="button"
                data-testid="bell-audio-toggle"
                onClick={() => setAudioMuted(!audioMuted)}
                aria-label={
                  audioMuted ? 'Bật âm báo tại quầy' : 'Tắt âm báo tại quầy'
                }
                title={
                  audioMuted ? 'Đã tắt chuông (bấm để bật)' : 'Chuông nhẹ khi có sự cố mới'
                }
                className="btn-icon h-7 w-7"
              >
                {audioMuted ? (
                  <VolumeX className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
                ) : (
                  <Volume2 className="h-3.5 w-3.5 text-brand-600" aria-hidden="true" />
                )}
              </button>
              <button
                type="button"
                onClick={() => void alertsQuery.refetch()}
                aria-label="Làm mới danh sách cảnh báo"
                title="Làm mới"
                className="btn-icon h-7 w-7"
              >
                <RotateCw
                  className={`h-3.5 w-3.5 ${
                    alertsQuery.isFetching ? 'animate-spin' : ''
                  }`}
                  aria-hidden="true"
                />
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Đóng bảng cảnh báo"
                className="btn-icon h-7 w-7"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          </div>

          {/* Filter Tabs */}
          <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-2">
            <div className="segmented" role="group" aria-label="Lọc cảnh báo">
              <button
                type="button"
                data-testid="bell-filter-open"
                onClick={() => setFilterTab('OPEN')}
                className={`segmented-item px-2.5 py-0.5 text-xs ${
                  filterTab === 'OPEN' ? 'segmented-item-active' : ''
                }`}
              >
                Đang mở ({openAlerts.length})
              </button>
              <button
                type="button"
                data-testid="bell-filter-all"
                onClick={() => setFilterTab('ALL')}
                className={`segmented-item px-2.5 py-0.5 text-xs ${
                  filterTab === 'ALL' ? 'segmented-item-active' : ''
                }`}
              >
                Tất cả ({mergedAlerts.length})
              </button>
            </div>
          </div>

          {/* Inline Feedback Banner */}
          {feedback && (
            <div
              role="status"
              data-testid="bell-feedback-banner"
              className={`border-b px-4 py-2 text-xs font-medium ${
                feedback.variant === 'danger'
                  ? 'border-red-200 bg-red-50 text-red-800'
                  : 'border-emerald-200 bg-emerald-50 text-emerald-800'
              }`}
            >
              {feedback.text}
            </div>
          )}

          {/* Body List */}
          <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
            {alertsQuery.isLoading && displayedAlerts.length === 0 ? (
              <div className="space-y-3 p-4">
                <div className="h-20 animate-pulse rounded-lg bg-slate-100" />
                <div className="h-20 animate-pulse rounded-lg bg-slate-100" />
              </div>
            ) : displayedAlerts.length === 0 ? (
              <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
                <ShieldCheck
                  className="h-9 w-9 text-emerald-500"
                  aria-hidden="true"
                />
                <p className="mt-2 text-sm font-semibold text-slate-800">
                  {filterTab === 'OPEN'
                    ? 'Không có cảnh báo đang mở'
                    : 'Chưa có cảnh báo nào'}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  Mọi phòng đọc và cảm biến trong phạm vi quản lý đang hoạt động bình thường.
                </p>
              </div>
            ) : (
              displayedAlerts.map((alert) => {
                const valueFmt = resolveAlertValueFormat(alert);
                const formattedMessage = alert.message
                  ? formatBottleneckReasonVi(alert.message)
                  : `Thiết bị ${alert.hardwareId ?? alert.deviceId ?? ''} phát cảnh báo`;
                const isBusy = pendingAlertId === alert.id;
                const isEditing = editingAlertId === alert.id;
                const isResolved = alert.status === 'RESOLVED';
                const isClaimed =
                  !isResolved &&
                  (alert.workflowStatus === 'IN_PROGRESS' ||
                    Boolean(alert.assignedTo));
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
                  <article
                    key={alert.id}
                    data-testid={`bell-alert-item-${alert.id}`}
                    className={`space-y-2.5 p-3.5 transition-colors ${
                      alert.sensorRecovered && !isResolved
                        ? 'bg-emerald-50/40'
                        : alert.status === 'FIRING'
                          ? 'bg-rose-50/35'
                          : 'bg-white hover:bg-slate-50/50'
                    }`}
                  >
                    {/* Top Row: Severity, Status, Sensor Recovered, Time */}
                    <div className="flex flex-wrap items-center justify-between gap-1.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <AlertSeverityBadge severity={alert.severity} />
                        <AlertStatusBadge status={alert.status} />
                        {alert.sensorRecovered && !isResolved && (
                          <span
                            data-testid={`bell-recovered-badge-${alert.id}`}
                            className="inline-flex items-center rounded border border-emerald-300 bg-emerald-100 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-900"
                          >
                            Đã êm — Chờ xác nhận
                          </span>
                        )}
                        {isClaimed && !alert.sensorRecovered && (
                          <span className="inline-flex items-center rounded border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[11px] font-medium text-sky-800">
                            Đang đi nhắc
                          </span>
                        )}
                      </div>
                      <span
                        className="text-[11px] text-slate-400"
                        title={formatVietnamDateTime(alert.startedAt)}
                      >
                        {formatRelativeTimeVi(alert.startedAt)}
                      </span>
                    </div>

                    {/* Type + Room + Epicenter Hardware ID + Multi-node spread */}
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <AlertTypeBadge type={alert.type} />
                      <div className="flex flex-wrap items-center gap-1.5 text-slate-600">
                        <span className="font-semibold text-slate-900">
                          {resolveRoomLabel(alert.roomId)}
                        </span>
                        {alert.hardwareId && (
                          <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600">
                            Tâm điểm: {alert.hardwareId}
                          </span>
                        )}
                        {spreadCount > 0 && (
                          <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold text-rose-800">
                            +{spreadCount} trạm bị lan
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Message & Measured vs Threshold */}
                    <div className="space-y-1 text-xs">
                      <p className="font-medium leading-snug text-slate-800">
                        {formattedMessage}
                      </p>
                      {!valueFmt.isOffline &&
                        (alert.currentValue != null ||
                          alert.threshold != null) && (
                          <p className="font-mono text-[11px] text-slate-600">
                            {alert.currentValue != null && (
                              <span>
                                Giá trị đo:{' '}
                                <strong className="text-slate-900">
                                  {formatNumber(
                                    alert.currentValue,
                                    valueFmt.decimals
                                  )}
                                  {valueFmt.unit ? ` ${valueFmt.unit}` : ''}
                                </strong>
                              </span>
                            )}
                            {alert.currentValue != null &&
                              alert.threshold != null && <span> · </span>}
                            {alert.threshold != null && (
                              <span>
                                Ngưỡng:{' '}
                                {formatNumber(
                                  alert.threshold,
                                  valueFmt.decimals
                                )}
                                {valueFmt.unit ? ` ${valueFmt.unit}` : ''}
                              </span>
                            )}
                          </p>
                        )}
                    </div>

                    {/* SOP Recommended Action */}
                    {alert.recommendedAction && !isResolved && (
                      <div className="rounded-lg border border-amber-200/80 bg-amber-50/70 px-2.5 py-1.5 text-[11px] leading-snug text-amber-950">
                        <span className="font-semibold">Khuyến nghị: </span>
                        {alert.recommendedAction}
                      </div>
                    )}

                    {/* Assignee / Tag / Note metadata */}
                    {(alert.assignedTo ||
                      tagLabel ||
                      alert.handlingNote ||
                      alert.resolvedBy) && (
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
                        {alert.assignedTo && (
                          <span className="inline-flex items-center gap-1">
                            <UserCheck className="h-3 w-3 text-sky-600" />
                            <span>
                              Nhận việc:{' '}
                              <strong className="text-slate-700">
                                {alert.assignedTo}
                              </strong>
                            </span>
                          </span>
                        )}
                        {tagLabel && (
                          <span className="inline-flex items-center gap-1 rounded bg-emerald-50 px-1.5 py-0.5 font-medium text-emerald-800 ring-1 ring-inset ring-emerald-200">
                            <Tag className="h-2.5 w-2.5" />
                            <span>{tagLabel}</span>
                          </span>
                        )}
                        {alert.handlingNote && (
                          <span>Ghi chú: {alert.handlingNote}</span>
                        )}
                      </div>
                    )}

                    {/* 2-Tap Action Buttons */}
                    <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                      <button
                        type="button"
                        data-testid={`bell-locate-${alert.id}`}
                        onClick={() => handleLocateOnMap(alert)}
                        className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 transition-colors hover:bg-slate-50 hover:text-slate-900"
                      >
                        <MapPin className="h-3 w-3" aria-hidden="true" />
                        <span>Xem bản đồ</span>
                      </button>

                      {/* CHẠM 1: Nhận xử lý */}
                      {canAcknowledgeAlert && !isResolved && !isClaimed && (
                        <button
                          type="button"
                          data-testid={`bell-ack-${alert.id}`}
                          disabled={isBusy}
                          onClick={() => void handleClaimAlert(alert)}
                          className="inline-flex items-center gap-1 rounded-md border border-brand-200 bg-brand-600 px-2.5 py-1 text-[11px] font-semibold text-white transition-colors hover:bg-brand-700 disabled:opacity-50"
                        >
                          <UserCheck className="h-3 w-3" aria-hidden="true" />
                          <span>Nhận xử lý</span>
                        </button>
                      )}

                      {/* CHẠM 2: Đã nhắc xong (hoặc Gắn/Sửa Tag sau khi tự đóng) */}
                      {canResolveAlert && (
                        <button
                          type="button"
                          data-testid={`bell-resolve-${alert.id}`}
                          disabled={isBusy}
                          onClick={() =>
                            setPickingTagAlertId((prev) =>
                              prev === alert.id ? null : alert.id
                            )
                          }
                          className={`inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11px] font-semibold transition-colors disabled:opacity-50 ${
                            isResolved
                              ? 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                              : 'border-emerald-300 bg-emerald-600 text-white hover:bg-emerald-700'
                          }`}
                        >
                          <CheckCircle2
                            className="h-3 w-3"
                            aria-hidden="true"
                          />
                          <span>
                            {isResolved ? 'Sửa Tag ca trực' : 'Đã nhắc xong'}
                          </span>
                        </button>
                      )}

                      {canAcknowledgeAlert && (
                        <button
                          type="button"
                          data-testid={`bell-edit-workflow-${alert.id}`}
                          onClick={() => handleOpenWorkflowEdit(alert)}
                          className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900"
                        >
                          <Edit3 className="h-3 w-3" aria-hidden="true" />
                          <span>{isEditing ? 'Ẩn ghi chú' : 'Ghi chú thêm'}</span>
                        </button>
                      )}
                    </div>

                    {/* CHẠM 2: 1-Click Quick-Tag Chips */}
                    {canResolveAlert && showQuickTags && (
                      <div
                        data-testid={`bell-quick-tags-${alert.id}`}
                        className="space-y-1.5 rounded-lg border border-emerald-200 bg-emerald-50/70 p-2 text-xs"
                      >
                        <p className="text-[11px] font-semibold text-emerald-950">
                          Chọn nhanh kết quả xử lý (1 chạm lưu nhật ký ca trực):
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {quickTags.map((tag) => (
                            <button
                              key={tag.code}
                              type="button"
                              disabled={isBusy}
                              data-testid={`bell-tag-${alert.id}-${tag.code}`}
                              onClick={() =>
                                void handleSelectQuickTag(alert, tag)
                              }
                              className="rounded-full border border-emerald-300 bg-white px-2.5 py-1 text-[11px] font-medium text-emerald-900 shadow-2xs transition-colors hover:bg-emerald-600 hover:text-white disabled:opacity-50"
                            >
                              {tag.labelVi}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Optional Extra Note / Assignee Editor */}
                    {isEditing && (
                      <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50/80 p-2.5 text-xs">
                        {!isResolved && (
                          <div>
                            <label
                              htmlFor={`bell-assignee-${alert.id}`}
                              className="mb-1 block text-[11px] font-medium text-slate-600"
                            >
                              Người phụ trách
                            </label>
                            <input
                              id={`bell-assignee-${alert.id}`}
                              type="text"
                              value={assigneeDraft}
                              onChange={(e) => setAssigneeDraft(e.target.value)}
                              placeholder="Mặc định tự gán người bấm Nhận xử lý"
                              className="input h-7 text-xs"
                            />
                          </div>
                        )}
                        <div>
                          <label
                            htmlFor={`bell-note-${alert.id}`}
                            className="mb-1 block text-[11px] font-medium text-slate-600"
                          >
                            Ghi chú xử lý
                          </label>
                          <input
                            id={`bell-note-${alert.id}`}
                            type="text"
                            value={noteDraft}
                            onChange={(e) => setNoteDraft(e.target.value)}
                            placeholder="VD: Nhóm bàn số 4 gần cửa sổ Bắc"
                            className="input h-7 text-xs"
                          />
                        </div>
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => setEditingAlertId(null)}
                            className="btn-secondary btn-sm h-7 px-2 text-xs"
                          >
                            Hủy
                          </button>
                          <button
                            type="button"
                            data-testid={`bell-save-workflow-${alert.id}`}
                            disabled={isBusy}
                            onClick={() => void handleSaveWorkflow(alert)}
                            className="btn-primary btn-sm h-7 px-2.5 text-xs"
                          >
                            Lưu
                          </button>
                        </div>
                      </div>
                    )}
                  </article>
                );
              })
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between border-t border-slate-100 bg-slate-50/70 px-4 py-2.5">
            <span className="text-[11px] text-slate-500">
              Hiển thị {displayedAlerts.length} cảnh báo
            </span>
            <Link
              href="/alerts"
              onClick={() => setOpen(false)}
              className="inline-flex items-center gap-1 text-xs font-semibold text-brand-600 hover:text-brand-700"
            >
              <span>Xem tất cả cảnh báo</span>
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
