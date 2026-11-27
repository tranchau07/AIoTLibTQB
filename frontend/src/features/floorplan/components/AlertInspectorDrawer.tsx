'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  MapPin,
  ShieldAlert,
  Tag,
  UserCheck,
} from 'lucide-react';
import {
  TIMING_CONFIG,
  isAlertOverdue,
  resolveEffectiveWorkflowStatus,
} from '@/config/floorplan-hmi.config';
import {
  type QuickResolutionTagOption,
  resolveQuickTagsForAlert,
  resolveResolutionTagLabelVi,
} from '@/features/alerts/quickTags';
import {
  ALERT_SEVERITY_LABEL_VI,
  WORKFLOW_STEPS,
  WORKFLOW_STEP_INDEX,
  formatAlertAgeVi,
  groupAlertsByRoom,
  sortAlertsByOperationalPriority,
  summarizeAlertForManagerVi,
} from '@/lib/floorplan/alertWorkflow';
import { FLOORPLAN_I18N_VI } from '@/messages/vi';
import type {
  AlertResponse,
  AlertSeverity,
  AlertWorkflowStatus,
  AlertWorkflowUpdateRequest,
  RoomResponse,
} from '@/types/api';

function severityBadgeClass(sev: AlertSeverity | undefined): string {
  switch (sev) {
    case 'CRITICAL':
      return 'border-red-300 bg-red-700 text-white';
    case 'HIGH':
      return 'border-orange-300 bg-orange-600 text-white';
    case 'MEDIUM':
      return 'border-amber-300 bg-amber-100 text-amber-950';
    case 'LOW':
      return 'border-slate-300 bg-slate-100 text-slate-800';
    default:
      return 'border-slate-300 bg-slate-100 text-slate-800';
  }
}

export interface AlertWorkflowPayloadHandler {
  (alertId: string, body: AlertWorkflowUpdateRequest): void | Promise<unknown>;
}

export interface AlertWorkflowCardProps {
  alert: AlertResponse;
  room?: RoomResponse | null;
  nowMs?: number;
  overdueAlertMs?: number;
  canAcknowledge: boolean;
  canResolve: boolean;
  isSubmitting?: boolean;
  onUpdateWorkflow: AlertWorkflowPayloadHandler;
  onFlyToAlert: (alert: AlertResponse) => void;
}

export function AlertWorkflowCard({
  alert,
  room,
  nowMs = Date.now(),
  overdueAlertMs = TIMING_CONFIG.overdueAlertMs,
  canAcknowledge,
  canResolve,
  isSubmitting = false,
  onUpdateWorkflow,
  onFlyToAlert,
}: AlertWorkflowCardProps) {
  const txt = FLOORPLAN_I18N_VI.alerts;
  const effectiveStatus = resolveEffectiveWorkflowStatus(alert);
  const currentStepIdx = WORKFLOW_STEP_INDEX[effectiveStatus];
  const age = formatAlertAgeVi(alert.startedAt, nowMs);
  const overdue = isAlertOverdue(alert, nowMs, overdueAlertMs);
  const summary = useMemo(
    () => summarizeAlertForManagerVi(alert, room),
    [alert, room]
  );

  const [draftStatus, setDraftStatus] =
    useState<AlertWorkflowStatus>(effectiveStatus);
  const [assigneeInput, setAssigneeInput] = useState<string>(
    alert.assignedTo ?? ''
  );
  const [noteInput, setNoteInput] = useState<string>(
    alert.handlingNote ?? ''
  );
  const [showQuickTagDrawer, setShowQuickTagDrawer] = useState<boolean>(false);

  useEffect(() => {
    setDraftStatus(resolveEffectiveWorkflowStatus(alert));
  }, [alert.id, alert.status, alert.workflowStatus]);

  useEffect(() => {
    setAssigneeInput(alert.assignedTo ?? '');
  }, [alert.id, alert.assignedTo]);

  useEffect(() => {
    setNoteInput(alert.handlingNote ?? '');
  }, [alert.id, alert.handlingNote]);

  const canOperate = canAcknowledge || canResolve;
  const isClosed = effectiveStatus === 'RESOLVED';
  const quickTags = useMemo(() => resolveQuickTagsForAlert(alert), [alert]);
  const tagLabel = resolveResolutionTagLabelVi(alert.resolutionTag);
  const spreadNodes = useMemo(
    () =>
      (alert.affectedNodes ?? []).filter(
        (n) => n && n.hardwareId && n.hardwareId !== alert.hardwareId
      ),
    [alert.affectedNodes, alert.hardwareId]
  );

  const handleSaveWorkflow = () => {
    const trimmedAssignee = assigneeInput.trim();
    const trimmedNote = noteInput.trim();
    const targetStatus: AlertWorkflowStatus =
      draftStatus === 'NEW' && trimmedAssignee
        ? 'IN_PROGRESS'
        : draftStatus;

    void onUpdateWorkflow(alert.id, {
      workflowStatus: targetStatus,
      assignedTo: trimmedAssignee || undefined,
      handlingNote: trimmedNote || undefined,
    });
  };

  const handleSelectQuickTag = (tag: QuickResolutionTagOption) => {
    const customNote = noteInput.trim();
    void onUpdateWorkflow(alert.id, {
      workflowStatus: 'RESOLVED',
      resolutionTag: tag.code,
      assignedTo: isClosed ? undefined : assigneeInput.trim() || undefined,
      handlingNote: customNote || tag.defaultNoteVi,
    });
    setShowQuickTagDrawer(false);
  };

  const showQuickTags =
    canResolve &&
    (showQuickTagDrawer ||
      (!isClosed &&
        (Boolean(alert.sensorRecovered) || effectiveStatus === 'IN_PROGRESS')));

  return (
    <article
      data-testid={`alert-workflow-card-${alert.id}`}
      className={`rounded-lg border p-2.5 text-xs shadow-2xs transition-colors ${
        alert.sensorRecovered && !isClosed
          ? 'border-emerald-300 bg-emerald-50/50'
          : overdue
            ? 'border-red-400 bg-red-50/70 ring-1 ring-red-300'
            : 'border-rose-200 bg-white'
      }`}
    >
      {/* Top Meta Row: Severity + Status + Sensor Recovered + Overdue + Age */}
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className={`rounded border px-1.5 py-0.5 text-[10px] font-bold ${severityBadgeClass(
              alert.severity
            )}`}
          >
            {ALERT_SEVERITY_LABEL_VI[alert.severity ?? 'MEDIUM']}
          </span>
          <span
            data-testid={`alert-status-pill-${alert.id}`}
            className="rounded border border-slate-300 bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-800"
          >
            {txt.workflowLabels[effectiveStatus]}
          </span>
          {alert.sensorRecovered && !isClosed && (
            <span
              data-testid={`alert-recovered-pill-${alert.id}`}
              className="rounded border border-emerald-400 bg-emerald-600 px-1.5 py-0.5 text-[10px] font-bold text-white"
            >
              Đã êm — Chờ xác nhận
            </span>
          )}
          {overdue && (
            <span
              data-testid={`alert-overdue-badge-${alert.id}`}
              className="inline-flex items-center gap-1 rounded border border-red-700 bg-red-700 px-1.5 py-0.5 text-[10px] font-bold text-white motion-safe:animate-pulse"
            >
              <Clock className="h-3 w-3" aria-hidden="true" />
              <span>{txt.overdueBadge(age.minutes)}</span>
            </span>
          )}
        </div>
        <span
          data-testid={`alert-age-${alert.id}`}
          className="inline-flex items-center gap-1 font-mono text-[10px] font-medium text-slate-600"
          title="Thời gian tồn tại từ lúc cảnh báo phát sinh"
        >
          <Clock className="h-3 w-3 text-slate-400" aria-hidden="true" />
          <span>Tồn tại: {age.durationText}</span>
        </span>
      </div>

      {/* Plain-Vietnamese Summary */}
      <p className="mt-1.5 font-semibold leading-snug text-slate-900">
        {summary.headlineVi}
      </p>
      {(alert.hardwareId || spreadNodes.length > 0) && (
        <p className="mt-0.5 font-mono text-[10px] text-slate-600">
          {alert.hardwareId ? `Tâm điểm: ${alert.hardwareId}` : ''}
          {spreadNodes.length > 0
            ? ` · Lan sang ${spreadNodes.length} trạm khác (${spreadNodes
                .map((n) => n.hardwareId)
                .join(', ')})`
            : ''}
        </p>
      )}

      {/* Current Assignee & Resolution Tag Display */}
      {(alert.assignedTo || tagLabel) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {alert.assignedTo && (
            <span
              data-testid={`alert-assignee-badge-${alert.id}`}
              className="inline-flex items-center gap-1 rounded border border-sky-200 bg-sky-50 px-2 py-0.5 text-[11px] font-semibold text-sky-900"
            >
              <UserCheck className="h-3 w-3 text-sky-700" aria-hidden="true" />
              <span>Phụ trách: {alert.assignedTo}</span>
            </span>
          )}
          {tagLabel && (
            <span
              data-testid={`alert-resolution-tag-badge-${alert.id}`}
              className="inline-flex items-center gap-1 rounded border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-900"
            >
              <Tag className="h-3 w-3 text-emerald-700" aria-hidden="true" />
              <span>{tagLabel}</span>
            </span>
          )}
        </div>
      )}

      {/* 2-Tap Primary Action Row */}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {effectiveStatus === 'NEW' && canAcknowledge && (
          <button
            type="button"
            disabled={isSubmitting}
            data-testid={`alert-ack-btn-${alert.id}`}
            onClick={() => {
              void onUpdateWorkflow(alert.id, {
                workflowStatus: 'IN_PROGRESS',
                assignedTo: assigneeInput.trim() || undefined,
                handlingNote: noteInput.trim() || undefined,
              });
            }}
            className="inline-flex items-center gap-1 rounded bg-slate-900 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
          >
            <UserCheck className="h-3 w-3" aria-hidden="true" />
            <span>Nhận xử lý ({txt.acknowledge})</span>
          </button>
        )}

        {canResolve && (
          <button
            type="button"
            disabled={isSubmitting}
            data-testid={`alert-resolve-btn-${alert.id}`}
            onClick={() => setShowQuickTagDrawer((prev) => !prev)}
            className={`inline-flex items-center gap-1 rounded border px-2.5 py-1 text-[11px] font-semibold disabled:opacity-50 ${
              isClosed
                ? 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                : 'border-emerald-700 bg-emerald-700 text-white hover:bg-emerald-800'
            }`}
          >
            <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
            <span>{isClosed ? 'Sửa Tag ca trực' : `Đã nhắc xong · ${txt.resolve}`}</span>
          </button>
        )}

        <button
          type="button"
          data-testid={`alert-fly-to-btn-${alert.id}`}
          onClick={() => onFlyToAlert(alert)}
          className="inline-flex items-center gap-1 rounded border border-rose-300 bg-rose-50 px-2 py-1 text-[11px] font-semibold text-rose-900 hover:bg-rose-100"
        >
          <MapPin className="h-3 w-3" aria-hidden="true" />
          <span>{txt.flyTo}</span>
        </button>
      </div>

      {/* CHẠM 2: 1-Click Quick-Tag Preset Chips */}
      {showQuickTags && (
        <div
          data-testid={`alert-quick-tags-${alert.id}`}
          className="mt-2 space-y-1.5 rounded-lg border border-emerald-300 bg-emerald-50/80 p-2"
        >
          <p className="text-[10px] font-bold text-emerald-950">
            Chạm chọn kết quả để lưu nhật ký ca trực (0 gõ phím):
          </p>
          <div className="flex flex-wrap gap-1.5">
            {quickTags.map((tag) => (
              <button
                key={tag.code}
                type="button"
                disabled={isSubmitting}
                data-testid={`alert-quick-tag-${alert.id}-${tag.code}`}
                onClick={() => handleSelectQuickTag(tag)}
                className="rounded-full border border-emerald-400 bg-white px-2.5 py-1 text-[11px] font-semibold text-emerald-950 shadow-2xs transition-colors hover:bg-emerald-700 hover:text-white disabled:opacity-50"
              >
                {tag.labelVi}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Optional Detail Form (Assignee / Custom Note / Stepper) */}
      {canOperate && !isClosed && (
        <div className="mt-2.5 space-y-2 border-t border-slate-100 pt-2">
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            <div>
              <label
                htmlFor={`wf-status-${alert.id}`}
                className="mb-0.5 block text-[10px] font-semibold text-slate-700"
              >
                Trạng thái xử lý
              </label>
              <select
                id={`wf-status-${alert.id}`}
                aria-label="Chọn trạng thái xử lý"
                data-testid={`alert-workflow-select-${alert.id}`}
                value={draftStatus}
                onChange={(e) =>
                  setDraftStatus(e.target.value as AlertWorkflowStatus)
                }
                disabled={isSubmitting}
                className="select h-7 w-full py-0 text-[11px] font-medium"
              >
                {WORKFLOW_STEPS.map((step) => {
                  const idx = WORKFLOW_STEP_INDEX[step.status];
                  const disabled =
                    idx < currentStepIdx ||
                    (step.status === 'RESOLVED' && !canResolve);
                  return (
                    <option
                      key={step.status}
                      value={step.status}
                      disabled={disabled}
                    >
                      {step.labelVi}
                    </option>
                  );
                })}
              </select>
            </div>
            <div>
              <label
                htmlFor={`wf-assignee-${alert.id}`}
                className="mb-0.5 block text-[10px] font-semibold text-slate-700"
              >
                Giao việc · {txt.assignLabel}
              </label>
              <input
                id={`wf-assignee-${alert.id}`}
                type="text"
                data-testid={`alert-assignee-input-${alert.id}`}
                aria-label={txt.assignLabel}
                placeholder={txt.assignPlaceholder}
                value={assigneeInput}
                onChange={(e) => setAssigneeInput(e.target.value)}
                disabled={isSubmitting}
                className="input h-7 w-full px-2 text-[11px]"
              />
            </div>
          </div>

          <div>
            <label
              htmlFor={`wf-note-${alert.id}`}
              className="mb-0.5 block text-[10px] font-semibold text-slate-700"
            >
              {txt.noteLabel}
            </label>
            <textarea
              id={`wf-note-${alert.id}`}
              rows={2}
              data-testid={`alert-note-input-${alert.id}`}
              aria-label={txt.noteLabel}
              placeholder={txt.notePlaceholder}
              value={noteInput}
              onChange={(e) => setNoteInput(e.target.value)}
              disabled={isSubmitting}
              className="input min-h-[40px] w-full px-2 py-1 text-[11px]"
            />
          </div>

          <div className="flex justify-end">
            <button
              type="button"
              disabled={isSubmitting}
              data-testid={`alert-save-workflow-btn-${alert.id}`}
              onClick={handleSaveWorkflow}
              className="rounded border border-sky-700 bg-sky-700 px-2 py-1 text-[11px] font-semibold text-white hover:bg-sky-800 disabled:opacity-50"
            >
              {txt.saveWorkflow}
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

export interface AlertInspectorDrawerProps {
  alerts: readonly AlertResponse[];
  room?: RoomResponse | null;
  nowMs?: number;
  overdueAlertMs?: number;
  canAcknowledge: boolean;
  canResolve: boolean;
  isSubmitting?: boolean;
  onUpdateWorkflow: AlertWorkflowPayloadHandler;
  onAcknowledgeRoomAlerts?: (alerts: readonly AlertResponse[]) => void | Promise<void>;
  onFlyToAlert: (alert: AlertResponse) => void;
}

export function AlertInspectorDrawer({
  alerts,
  room,
  nowMs = Date.now(),
  overdueAlertMs = TIMING_CONFIG.overdueAlertMs,
  canAcknowledge,
  canResolve,
  isSubmitting = false,
  onUpdateWorkflow,
  onAcknowledgeRoomAlerts,
  onFlyToAlert,
}: AlertInspectorDrawerProps) {
  const txt = FLOORPLAN_I18N_VI.alerts;
  const sortedAlerts = useMemo(
    () => sortAlertsByOperationalPriority(alerts, nowMs, overdueAlertMs),
    [alerts, nowMs, overdueAlertMs]
  );
  const unacknowledged = useMemo(
    () =>
      sortedAlerts.filter((a) => resolveEffectiveWorkflowStatus(a) === 'NEW'),
    [sortedAlerts]
  );

  if (sortedAlerts.length === 0) return null;

  return (
    <section
      data-testid="alert-inspector-drawer"
      aria-label={txt.panelTitle}
      className="space-y-2 rounded-lg border border-rose-300 bg-rose-50/60 p-2.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-bold text-rose-950">
          <ShieldAlert className="h-4 w-4 text-rose-700" aria-hidden="true" />
          <span>
            {txt.panelTitle} ({sortedAlerts.length})
          </span>
        </div>

        {canAcknowledge && unacknowledged.length > 0 && (
          <button
            type="button"
            disabled={isSubmitting}
            data-testid="ack-all-room-alerts-btn"
            onClick={() => {
              if (onAcknowledgeRoomAlerts) {
                void onAcknowledgeRoomAlerts(unacknowledged);
              } else {
                for (const a of unacknowledged) {
                  void onUpdateWorkflow(a.id, {
                    workflowStatus: 'IN_PROGRESS',
                  });
                }
              }
            }}
            className="rounded border border-slate-800 bg-slate-900 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {txt.acknowledgeAllRoom}
          </button>
        )}
      </div>

      <div className="space-y-2">
        {sortedAlerts.map((alert) => (
          <AlertWorkflowCard
            key={alert.id}
            alert={alert}
            room={room}
            nowMs={nowMs}
            overdueAlertMs={overdueAlertMs}
            canAcknowledge={canAcknowledge}
            canResolve={canResolve}
            isSubmitting={isSubmitting}
            onUpdateWorkflow={onUpdateWorkflow}
            onFlyToAlert={onFlyToAlert}
          />
        ))}
      </div>
    </section>
  );
}

export interface MapAlertQueuePanelProps {
  alerts: readonly AlertResponse[];
  rooms: readonly RoomResponse[];
  nowMs?: number;
  overdueAlertMs?: number;
  canAcknowledge: boolean;
  isSubmitting?: boolean;
  onFlyToAlert: (alert: AlertResponse) => void;
  onAcknowledgeRoomAlerts?: (alerts: readonly AlertResponse[]) => void | Promise<void>;
}

export function MapAlertQueuePanel({
  alerts,
  rooms,
  nowMs = Date.now(),
  overdueAlertMs = TIMING_CONFIG.overdueAlertMs,
  canAcknowledge,
  isSubmitting = false,
  onFlyToAlert,
  onAcknowledgeRoomAlerts,
}: MapAlertQueuePanelProps) {
  const txt = FLOORPLAN_I18N_VI.alerts;
  const groups = useMemo(
    () => groupAlertsByRoom(alerts, rooms, nowMs, overdueAlertMs),
    [alerts, rooms, nowMs, overdueAlertMs]
  );

  const [isPanelOpen, setIsPanelOpen] = useState<boolean>(true);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(
    {}
  );

  if (groups.length === 0) return null;

  const totalAlerts = groups.reduce((sum, g) => sum + g.alerts.length, 0);
  const overdueGroups = groups.filter((g) => g.hasOverdue).length;

  return (
    <section
      data-testid="map-alert-queue-panel"
      aria-label="Hàng đợi cảnh báo gom theo phòng trên bản đồ"
      className="rounded-xl border border-rose-200 bg-white px-3 py-2 shadow-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          aria-expanded={isPanelOpen}
          data-testid="toggle-map-alert-queue-btn"
          onClick={() => setIsPanelOpen((v) => !v)}
          className="flex items-center gap-2 text-left text-xs font-bold text-rose-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 rounded"
        >
          {isPanelOpen ? (
            <ChevronDown className="h-4 w-4 text-rose-700" aria-hidden="true" />
          ) : (
            <ChevronRight
              className="h-4 w-4 text-rose-700"
              aria-hidden="true"
            />
          )}
          <ShieldAlert className="h-4 w-4 text-rose-700" aria-hidden="true" />
          <span>
            Cảnh báo đang mở theo phòng: {groups.length} khu vực ({totalAlerts}{' '}
            sự cố)
          </span>
          {overdueGroups > 0 && (
            <span className="rounded bg-red-700 px-1.5 py-0.5 text-[10px] font-bold text-white">
              {overdueGroups} khu vực tồn đọng lâu
            </span>
          )}
        </button>
      </div>

      {isPanelOpen && (
        <div className="mt-2 max-h-48 space-y-1.5 overflow-y-auto pr-1">
          {groups.map((group) => {
            const isExpanded = Boolean(expandedGroups[group.groupKey]);
            const topAlert = group.alerts[0];
            const unackList = group.alerts.filter(
              (a) => resolveEffectiveWorkflowStatus(a) === 'NEW'
            );

            return (
              <div
                key={group.groupKey}
                data-testid={`alert-group-${group.groupKey}`}
                className={`rounded-lg border px-2.5 py-1.5 text-xs ${
                  group.hasOverdue
                    ? 'border-red-400 bg-red-50/70'
                    : 'border-slate-200 bg-slate-50/60'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <span
                      className={`rounded border px-1.5 py-0.5 text-[10px] font-bold ${severityBadgeClass(
                        group.highestSeverity
                      )}`}
                    >
                      {ALERT_SEVERITY_LABEL_VI[group.highestSeverity]}
                    </span>
                    <span className="font-mono font-bold text-slate-900">
                      {group.shortRoomCode} ({txt.groupCount(group.alerts.length)})
                    </span>
                    <span className="truncate font-medium text-slate-700">
                      {group.roomName}
                      {group.floor ? ` · Tầng ${group.floor}` : ''}
                    </span>
                    {group.hasOverdue && (
                      <span
                        data-testid={`group-overdue-badge-${group.groupKey}`}
                        className="inline-flex items-center gap-1 rounded bg-red-700 px-1.5 py-0.5 text-[10px] font-bold text-white motion-safe:animate-pulse"
                      >
                        <Clock className="h-3 w-3" aria-hidden="true" />
                        <span>{txt.overdueBadge(group.maxOverdueMinutes)}</span>
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    {group.alerts.length > 1 && (
                      <button
                        type="button"
                        aria-expanded={isExpanded}
                        data-testid={`toggle-group-${group.groupKey}`}
                        onClick={() =>
                          setExpandedGroups((prev) => ({
                            ...prev,
                            [group.groupKey]: !prev[group.groupKey],
                          }))
                        }
                        className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-800 hover:bg-slate-100"
                      >
                        {isExpanded
                          ? 'Thu gọn'
                          : `Mở rộng (${group.alerts.length})`}
                      </button>
                    )}

                    {canAcknowledge &&
                      unackList.length > 0 &&
                      onAcknowledgeRoomAlerts && (
                        <button
                          type="button"
                          disabled={isSubmitting}
                          onClick={() => void onAcknowledgeRoomAlerts(unackList)}
                          className="rounded bg-slate-900 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
                        >
                          {txt.acknowledgeAllRoom}
                        </button>
                      )}

                    {topAlert && (
                      <button
                        type="button"
                        data-testid={`queue-fly-to-${topAlert.id}`}
                        onClick={() => onFlyToAlert(topAlert)}
                        className="inline-flex items-center gap-1 rounded border border-sky-700 bg-sky-700 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-sky-800"
                      >
                        <MapPin className="h-3 w-3" aria-hidden="true" />
                        <span>{txt.flyTo}</span>
                      </button>
                    )}
                  </div>
                </div>

                {/* Single alert inline preview OR Expanded Multi-Alert Children */}
                {(isExpanded || group.alerts.length === 1) && (
                  <div className="mt-1.5 space-y-1 border-t border-slate-200/70 pt-1.5">
                    {group.alerts.map((alert) => {
                      const summary = summarizeAlertForManagerVi(
                        alert,
                        group.room
                      );
                      const age = formatAlertAgeVi(alert.startedAt, nowMs);
                      const isItemOverdue = isAlertOverdue(
                        alert,
                        nowMs,
                        overdueAlertMs
                      );
                      const wf = resolveEffectiveWorkflowStatus(alert);
                      return (
                        <div
                          key={alert.id}
                          data-testid={`queue-alert-item-${alert.id}`}
                          className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 bg-white px-2 py-1 text-[11px]"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span
                                className={`rounded px-1 py-0.5 text-[10px] font-bold ${severityBadgeClass(
                                  alert.severity
                                )}`}
                              >
                                {ALERT_SEVERITY_LABEL_VI[alert.severity ?? 'MEDIUM']}
                              </span>
                              <span className="rounded bg-slate-100 px-1 py-0.5 text-[10px] font-semibold text-slate-800">
                                {txt.workflowLabels[wf]}
                              </span>
                              {alert.sensorRecovered && (
                                <span className="rounded bg-emerald-600 px-1 py-0.5 text-[10px] font-bold text-white">
                                  Đã êm — Chờ xác nhận
                                </span>
                              )}
                              {isItemOverdue && (
                                <span
                                  data-testid={`queue-item-overdue-${alert.id}`}
                                  className="rounded bg-red-700 px-1 py-0.5 text-[10px] font-bold text-white"
                                >
                                  {txt.overdueBadge(age.minutes)}
                                </span>
                              )}
                              {alert.assignedTo && (
                                <span className="text-[10px] font-semibold text-sky-800">
                                  Phụ trách: {alert.assignedTo}
                                </span>
                              )}
                              <span className="truncate font-medium text-slate-900">
                                {summary.headlineVi}
                              </span>
                            </div>
                          </div>
                          {group.alerts.length > 1 && (
                            <button
                              type="button"
                              data-testid={`queue-fly-to-child-${alert.id}`}
                              onClick={() => onFlyToAlert(alert)}
                              className="inline-flex shrink-0 items-center gap-1 rounded border border-slate-300 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold text-slate-800 hover:bg-slate-100"
                            >
                              <MapPin className="h-3 w-3" aria-hidden="true" />
                              <span>{txt.flyTo}</span>
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
