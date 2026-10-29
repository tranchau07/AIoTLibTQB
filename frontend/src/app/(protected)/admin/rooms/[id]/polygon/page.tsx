'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  ChevronRight,
  MapPin,
  Pentagon,
  RotateCcw,
  Save,
  Square,
  Trash2,
} from 'lucide-react';
import {
  normalizedToPixel,
  pixelToNormalized,
} from '@/lib/floorplan/coords';
import {
  isPointInPolygon,
  validateBoundaryPolygon,
} from '@/lib/floorplan/polygon';
import {
  ConnectionBadge,
  ErrorBanner,
  ModalDialog,
  Skeleton,
  useToast,
} from '@/components/ui/primitives';
import { useAuthStore } from '@/features/auth/store';
import {
  useRoomDetailQuery,
  useUpdateRoomMutation,
} from '@/features/rooms/queries';
import {
  useDevicesQuery,
  useUpdateDeviceMutation,
} from '@/features/devices/queries';
import type { DeviceResponse, Point2D } from '@/types/api';

type EditorMode = 'polygon' | 'device';

export default function RoomPolygonEditorPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const roomId = typeof params?.id === 'string' ? params.id : '';

  const capabilities = useAuthStore((s) => s.capabilities);
  const { pushToast } = useToast();

  const roomQuery = useRoomDetailQuery(roomId);
  const devicesQuery = useDevicesQuery(
    { page: 0, size: 50, roomId },
    Boolean(roomId) && capabilities.canManageRooms
  );

  const updateRoomMutation = useUpdateRoomMutation();
  const updateDeviceMutation = useUpdateDeviceMutation();

  const [mode, setMode] = useState<EditorMode>('polygon');
  const [vertices, setVertices] = useState<Point2D[]>([]);
  const [initializedRoomId, setInitializedRoomId] = useState<string | null>(null);

  const [deviceDrafts, setDeviceDrafts] = useState<Record<string, Point2D>>({});
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [pendingNavUrl, setPendingNavUrl] = useState<string | null>(null);

  const workspaceRef = useRef<HTMLDivElement>(null);
  const [workspaceSize, setWorkspaceSize] = useState<{
    width: number;
    height: number;
  }>({ width: 880, height: 500 });
  const [draggingVertexIdx, setDraggingVertexIdx] = useState<number | null>(
    null
  );
  const [draggingDeviceId, setDraggingDeviceId] = useState<string | null>(null);

  const room = roomQuery.data;
  const roomDevices = useMemo(
    () => devicesQuery.data?.content ?? [],
    [devicesQuery.data]
  );

  useEffect(() => {
    if (room && room.id !== initializedRoomId) {
      setVertices(
        Array.isArray(room.boundaryPolygon) ? [...room.boundaryPolygon] : []
      );
      setInitializedRoomId(room.id);
    }
  }, [room, initializedRoomId]);

  useEffect(() => {
    if (roomDevices.length === 0) return;
    setDeviceDrafts((prev) => {
      const next = { ...prev };
      for (const d of roomDevices) {
        if (
          !next[d.id] &&
          typeof d.posX === 'number' &&
          typeof d.posY === 'number'
        ) {
          next[d.id] = { x: d.posX, y: d.posY };
        }
      }
      return next;
    });
    if (!selectedDeviceId && roomDevices.length > 0) {
      setSelectedDeviceId(roomDevices[0].id);
    }
  }, [roomDevices, selectedDeviceId]);

  useEffect(() => {
    const el = workspaceRef.current;
    if (!el) return;
    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      const width = Math.max(320, Math.floor(rect.width));
      const height = Math.max(360, Math.floor(width * 0.56));
      setWorkspaceSize((prev) =>
        prev.width === width && prev.height === height ? prev : { width, height }
      );
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(el);
    window.addEventListener('resize', updateSize);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateSize);
    };
  }, []);

  const polygonValidation = useMemo(
    () => validateBoundaryPolygon(vertices),
    [vertices]
  );

  const isPolygonDirty = useMemo(() => {
    const original = room?.boundaryPolygon ?? [];
    if (original.length !== vertices.length) return true;
    return vertices.some(
      (v, idx) => v.x !== original[idx]?.x || v.y !== original[idx]?.y
    );
  }, [room?.boundaryPolygon, vertices]);

  const isDeviceDirty = useMemo(() => {
    return roomDevices.some((d) => {
      const draft = deviceDrafts[d.id];
      if (!draft) return false;
      return draft.x !== d.posX || draft.y !== d.posY;
    });
  }, [roomDevices, deviceDrafts]);

  const isDirty = isPolygonDirty || isDeviceDirty;

  useEffect(() => {
    if (!isDirty) return;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirty]);

  const handleNavClick = (e: React.MouseEvent, url: string) => {
    if (isDirty) {
      e.preventDefault();
      setPendingNavUrl(url);
    }
  };

  if (!capabilities.canManageRooms) {
    return (
      <div className="page">
        <ErrorBanner message="Bạn không có quyền quản lý mặt bằng không gian (MANAGE_ROOMS)." />
      </div>
    );
  }

  if (roomQuery.isLoading) {
    return (
      <div className="page space-y-4">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (roomQuery.isError || !room) {
    return (
      <div className="page space-y-4">
        <Link href="/floorplan" className="text-xs text-slate-500 hover:text-slate-900">
          ← Quay lại bản đồ tầng
        </Link>
        <ErrorBanner message="Không thể tải thông tin phòng đọc để chỉnh sửa mặt bằng." />
      </div>
    );
  }

  const handlePointerDownWorkspace = (e: React.PointerEvent<HTMLDivElement>) => {
    if (draggingVertexIdx !== null || draggingDeviceId !== null) return;
    const target = e.target as HTMLElement;
    if (target.closest('[data-interactive-vertex]') || target.closest('[data-interactive-device]')) {
      return;
    }

    const rect = workspaceRef.current?.getBoundingClientRect();
    if (!rect) return;
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    const normalized = pixelToNormalized(
      { x: clickX, y: clickY },
      workspaceSize.width,
      workspaceSize.height
    );

    if (mode === 'polygon') {
      setVertices((prev) => [...prev, normalized]);
    } else if (mode === 'device' && selectedDeviceId) {
      setDeviceDrafts((prev) => ({
        ...prev,
        [selectedDeviceId]: normalized,
      }));
    }
  };

  const handlePointerMoveWorkspace = (e: React.PointerEvent<HTMLDivElement>) => {
    if (draggingVertexIdx === null && draggingDeviceId === null) return;
    const rect = workspaceRef.current?.getBoundingClientRect();
    if (!rect) return;

    const currentX = e.clientX - rect.left;
    const currentY = e.clientY - rect.top;
    const normalized = pixelToNormalized(
      { x: currentX, y: currentY },
      workspaceSize.width,
      workspaceSize.height
    );

    if (draggingVertexIdx !== null) {
      setVertices((prev) => {
        const next = [...prev];
        next[draggingVertexIdx] = normalized;
        return next;
      });
    } else if (draggingDeviceId !== null) {
      setDeviceDrafts((prev) => ({
        ...prev,
        [draggingDeviceId]: normalized,
      }));
    }
  };

  const handlePointerUp = () => {
    setDraggingVertexIdx(null);
    setDraggingDeviceId(null);
  };

  const handleRemoveVertex = (index: number) => {
    setVertices((prev) => prev.filter((_, idx) => idx !== index));
  };

  const handleResetPolygon = () => {
    setVertices([]);
  };

  const handleApplySampleRectangle = () => {
    setVertices([
      { x: 0.15, y: 0.18 },
      { x: 0.85, y: 0.18 },
      { x: 0.85, y: 0.82 },
      { x: 0.15, y: 0.82 },
    ]);
  };

  const handleSavePolygon = async () => {
    const check = validateBoundaryPolygon(vertices);
    if (!check.valid) {
      pushToast({
        title: 'Không thể lưu đa giác',
        message: check.reason ?? 'Đa giác không hợp lệ.',
        variant: 'danger',
      });
      return;
    }

    try {
      await updateRoomMutation.mutateAsync({
        id: room.id,
        body: {
          name: room.name,
          floor: room.floor,
          capacity: room.capacity,
          description: room.description,
          targetComfortScore: room.targetComfortScore,
          type: room.type,
          boundaryPolygon: vertices,
        },
      });
      pushToast({
        title: 'Đã lưu đa giác mặt bằng',
        message: `Cập nhật thành công ${vertices.length} đỉnh cho phòng ${room.code}.`,
        variant: 'success',
      });
    } catch (err) {
      pushToast({
        title: 'Lỗi lưu đa giác',
        message:
          err instanceof Error
            ? err.message
            : 'Không thể lưu đa giác phòng đọc.',
        variant: 'danger',
      });
    }
  };

  const handleSaveDevicePosition = async (device: DeviceResponse) => {
    const pos = deviceDrafts[device.id];
    if (!pos) {
      pushToast({
        title: 'Chưa chọn tọa độ',
        message: 'Vui lòng nhấp hoặc kéo thả thiết bị vào bên trong đa giác phòng.',
        variant: 'warning',
      });
      return;
    }

    const polyCheck = validateBoundaryPolygon(vertices);
    if (!polyCheck.valid) {
      pushToast({
        title: 'Đa giác phòng chưa hợp lệ',
        message:
          polyCheck.reason ??
          'Vui lòng tạo đa giác hợp lệ trước khi lưu vị trí thiết bị.',
        variant: 'danger',
      });
      return;
    }

    if (!isPointInPolygon(pos, vertices)) {
      pushToast({
        title: 'Thiết bị nằm ngoài phòng',
        message: `Tọa độ (${pos.x.toFixed(3)}, ${pos.y.toFixed(
          3
        )}) của "${device.name}" không nằm trong đa giác phòng ${room.code}.`,
        variant: 'danger',
      });
      return;
    }

    try {
      await updateDeviceMutation.mutateAsync({
        id: device.id,
        body: {
          name: device.name,
          zoneId: device.zoneId,
          roomId: room.id,
          posX: pos.x,
          posY: pos.y,
          deviceType: device.deviceType,
          location: device.location ?? undefined,
          firmwareVersion: device.firmwareVersion ?? undefined,
        },
      });
      pushToast({
        title: 'Đã lưu tọa độ thiết bị',
        message: `Thiết bị ${device.name} đã được ghim tại (${pos.x.toFixed(
          3
        )}, ${pos.y.toFixed(3)}).`,
        variant: 'success',
      });
    } catch (err) {
      pushToast({
        title: 'Lỗi cập nhật tọa độ thiết bị',
        message:
          err instanceof Error
            ? err.message
            : 'Không thể lưu vị trí thiết bị.',
        variant: 'danger',
      });
    }
  };

  const pixelVertices = vertices.map((pt) =>
    normalizedToPixel(pt, workspaceSize.width, workspaceSize.height)
  );
  const svgPointsString = pixelVertices.map((p) => `${p.x},${p.y}`).join(' ');

  return (
    <div className="page">
      {/* Header */}
      <div className="space-y-1">
        <div className="flex items-center gap-1.5 text-xs text-slate-500">
          <Link
            href="/floorplan"
            onClick={(e) => handleNavClick(e, '/floorplan')}
            className="text-slate-500 hover:text-slate-900"
          >
            Bản đồ không gian
          </Link>
          <ChevronRight className="h-3 w-3 text-slate-400" />
          <Link
            href="/admin/rooms"
            onClick={(e) => handleNavClick(e, '/admin/rooms')}
            className="text-slate-500 hover:text-slate-900"
          >
            Quản lý phòng
          </Link>
          <ChevronRight className="h-3 w-3 text-slate-400" />
          <span className="font-medium text-slate-900">Mặt bằng: {room.name}</span>
        </div>

        <div className="page-header pt-1">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="page-title">
                Mặt bằng: {room.name}
              </h1>
              <span className="rounded bg-slate-100 px-2 py-0.5 font-mono text-2xs font-medium text-slate-700">
                {room.code} · Tầng {room.floor}
              </span>
              {isDirty && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-2xs font-medium text-amber-800 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
                  Có thay đổi chưa lưu
                </span>
              )}
            </div>
            <p className="page-subtitle">
              Vẽ biên đa giác và định vị trạm cảm biến ESP32 trên mặt bằng chuẩn hóa [0.0 - 1.0]
            </p>
          </div>

          {/* Mode Selector */}
          <div className="segmented">
            <button
              type="button"
              onClick={() => setMode('polygon')}
              className={`segmented-item ${mode === 'polygon' ? 'segmented-item-active' : ''}`}
            >
              <span className="inline-flex items-center gap-1.5">
                <Pentagon className="h-3.5 w-3.5 text-brand-600" />
                Vẽ đa giác ({vertices.length} đỉnh)
              </span>
            </button>
            <button
              type="button"
              onClick={() => setMode('device')}
              className={`segmented-item ${mode === 'device' ? 'segmented-item-active' : ''}`}
            >
              <span className="inline-flex items-center gap-1.5">
                <MapPin className="h-3.5 w-3.5 text-emerald-600" />
                Định vị trạm đo ({roomDevices.length})
              </span>
            </button>
          </div>
        </div>
      </div>

      {/* Main Workspace Layout */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        {/* Canvas Area */}
        <div className="card p-4 lg:col-span-8 flex flex-col justify-between">
          <div>
            {/* Toolbar */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
              <div className="flex flex-wrap items-center gap-1.5">
                {mode === 'polygon' && (
                  <>
                    <button
                      type="button"
                      onClick={handleApplySampleRectangle}
                      className="btn-secondary btn-sm"
                    >
                      <Square className="h-3.5 w-3.5" aria-hidden="true" />
                      Mẫu chữ nhật
                    </button>
                    <button
                      type="button"
                      onClick={handleResetPolygon}
                      className="btn-secondary btn-sm"
                    >
                      <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                      Làm lại
                    </button>
                  </>
                )}
                {mode === 'device' && (
                  <span className="text-xs text-slate-500">
                    Nhấp vào mặt bằng để đặt vị trí cho trạm đang chọn.
                  </span>
                )}
              </div>

              {mode === 'polygon' && (
                <button
                  type="button"
                  disabled={!polygonValidation.valid || updateRoomMutation.isPending}
                  onClick={handleSavePolygon}
                  className="btn-primary btn-sm"
                >
                  <Save className="h-3.5 w-3.5" aria-hidden="true" />
                  {updateRoomMutation.isPending ? 'Đang lưu...' : 'Lưu đa giác'}
                </button>
              )}
            </div>

            {/* Validation Banner */}
            {mode === 'polygon' && !polygonValidation.valid && (
              <div
                role="status"
                className="mt-3 rounded-lg border border-amber-200 bg-amber-50/70 p-2.5 text-xs text-amber-900"
              >
                {polygonValidation.reason}
              </div>
            )}

            {/* SVG Interactive Workspace */}
            <div
              ref={workspaceRef}
              onPointerDown={handlePointerDownWorkspace}
              onPointerMove={handlePointerMoveWorkspace}
              onPointerUp={handlePointerUp}
              className="relative mt-3 cursor-crosshair overflow-hidden rounded-lg border border-slate-200 bg-slate-50 select-none touch-none"
              style={{
                width: '100%',
                height: `${workspaceSize.height}px`,
                backgroundImage:
                  'radial-gradient(circle, #CBD5E1 1px, transparent 1px)',
                backgroundSize: '20px 20px',
              }}
            >
              <svg
                width={workspaceSize.width}
                height={workspaceSize.height}
                className="absolute inset-0 pointer-events-none"
              >
                {/* Drawn polygon area */}
                {vertices.length >= 3 && (
                  <polygon
                    points={svgPointsString}
                    fill={polygonValidation.valid ? 'rgba(79, 70, 229, 0.08)' : 'rgba(239, 68, 68, 0.08)'}
                    stroke={polygonValidation.valid ? '#4F46E5' : '#EF4444'}
                    strokeWidth={2}
                    strokeLinejoin="round"
                  />
                )}

                {/* Incomplete boundary polyline */}
                {vertices.length > 0 && vertices.length < 3 && (
                  <polyline
                    points={svgPointsString}
                    fill="none"
                    stroke="#4F46E5"
                    strokeWidth={2}
                    strokeDasharray="4 4"
                  />
                )}
              </svg>

              {/* Interactive Vertices */}
              {mode === 'polygon' &&
                pixelVertices.map((p, idx) => (
                  <div
                    key={idx}
                    data-interactive-vertex="true"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setDraggingVertexIdx(idx);
                    }}
                    className="absolute flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white shadow border-2 border-brand-600 cursor-grab active:cursor-grabbing"
                    style={{ left: `${p.x}px`, top: `${p.y}px` }}
                  >
                    <span className="font-mono text-[9px] font-bold text-brand-700">
                      {idx + 1}
                    </span>
                  </div>
                ))}

              {/* Devices Markers */}
              {roomDevices.map((d) => {
                const pos = deviceDrafts[d.id];
                if (!pos) return null;
                const px = normalizedToPixel(
                  pos,
                  workspaceSize.width,
                  workspaceSize.height
                );
                const isSelected = selectedDeviceId === d.id;
                const inPoly =
                  vertices.length >= 3 && isPointInPolygon(pos, vertices);

                return (
                  <div
                    key={d.id}
                    data-interactive-device="true"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setSelectedDeviceId(d.id);
                      if (mode === 'device') {
                        setDraggingDeviceId(d.id);
                      }
                    }}
                    className={`absolute flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full shadow transition-transform ${
                      isSelected
                        ? 'ring-2 ring-brand-500 scale-110 z-20'
                        : 'z-10'
                    } ${
                      inPoly
                        ? 'bg-emerald-600 text-white'
                        : 'bg-red-600 text-white'
                    } ${mode === 'device' ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'}`}
                    style={{ left: `${px.x}px`, top: `${px.y}px` }}
                    title={`${d.name} (${pos.x.toFixed(2)}, ${pos.y.toFixed(2)})`}
                  >
                    <MapPin className="h-4 w-4" />
                  </div>
                );
              })}
            </div>
          </div>

          <p className="mt-3 text-2xs text-slate-400">
            * Nhấp vào bảng vẽ để thêm đỉnh; kéo thả đỉnh để nắn hình dạng. Trong chế độ định vị, nhấp hoặc kéo thả để ghim vị trí trạm ESP32 bên trong đường biên.
          </p>
        </div>

        {/* Sidebar Controls */}
        <div className="space-y-4 lg:col-span-4">
          {/* Vertices List */}
          {mode === 'polygon' && (
            <div className="card p-4">
              <h2 className="section-title border-b border-slate-100 pb-2">
                Tọa độ các đỉnh đa giác ({vertices.length})
              </h2>

              {vertices.length === 0 ? (
                <p className="mt-3 text-xs text-slate-400 italic">
                  Chưa có đỉnh nào. Nhấp vào bảng vẽ để bắt đầu vẽ phòng.
                </p>
              ) : (
                <div className="mt-3 max-h-72 overflow-y-auto space-y-1.5 pr-1">
                  {vertices.map((v, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between rounded-md bg-slate-50 px-2.5 py-1.5 text-xs"
                    >
                      <span className="font-mono text-slate-600">
                        #{i + 1}: ({v.x.toFixed(3)}, {v.y.toFixed(3)})
                      </span>
                      <button
                        type="button"
                        onClick={() => handleRemoveVertex(i)}
                        className="btn-icon h-6 w-6 text-slate-400 hover:text-red-600"
                        title="Xóa đỉnh này"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Devices List */}
          <div className="card p-4">
            <h2 className="section-title border-b border-slate-100 pb-2">
              Trạm đo trong phòng ({roomDevices.length})
            </h2>

            {roomDevices.length === 0 ? (
              <p className="mt-3 text-xs text-slate-400 italic">
                Chưa có thiết bị nào được gán vào phòng đọc này.
              </p>
            ) : (
              <div className="mt-3 max-h-96 overflow-y-auto space-y-2 pr-1">
                {roomDevices.map((d) => {
                  const pos = deviceDrafts[d.id];
                  const inPoly =
                    pos && vertices.length >= 3 && isPointInPolygon(pos, vertices);
                  const isSelected = selectedDeviceId === d.id;

                  return (
                    <div
                      key={d.id}
                      onClick={() => setSelectedDeviceId(d.id)}
                      className={`cursor-pointer rounded-lg border p-2.5 transition ${
                        isSelected
                          ? 'border-brand-500 bg-brand-50/50 shadow-xs'
                          : 'border-slate-200 bg-white hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="font-semibold text-xs text-slate-900">
                            {d.name}
                          </p>
                          <p className="font-mono text-2xs text-slate-400">
                            {d.hardwareId}
                          </p>
                        </div>
                        <ConnectionBadge online={d.online} />
                      </div>

                      <div className="mt-2 flex items-center justify-between border-t border-slate-100 pt-2 text-xs">
                        <span className="tabular text-2xs text-slate-500">
                          {pos
                            ? `(${pos.x.toFixed(2)}, ${pos.y.toFixed(2)})`
                            : 'Chưa có tọa độ'}
                        </span>

                        {capabilities.canManageRooms && (
                          <button
                            type="button"
                            disabled={!pos || !inPoly || updateDeviceMutation.isPending}
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleSaveDevicePosition(d);
                            }}
                            className="btn-primary btn-sm h-7 text-2xs px-2"
                          >
                            Lưu vị trí
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Unsaved Changes Confirmation Dialog */}
      <ModalDialog
        open={Boolean(pendingNavUrl)}
        title="Chưa lưu thay đổi mặt bằng"
        description="Bạn có một số chỉnh sửa đa giác hoặc vị trí thiết bị chưa được lưu lại. Bạn có chắc chắn muốn rời đi và hủy bỏ các thay đổi này?"
        onClose={() => setPendingNavUrl(null)}
      >
        <div className="flex justify-end gap-2 pt-3">
          <button
            type="button"
            onClick={() => setPendingNavUrl(null)}
            className="btn-secondary"
          >
            Ở lại tiếp tục sửa
          </button>
          <button
            type="button"
            onClick={() => {
              const dest = pendingNavUrl;
              setPendingNavUrl(null);
              if (dest) {
                router.push(dest);
              }
            }}
            className="btn-sm rounded-md bg-red-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-red-700"
          >
            Rời khỏi trang
          </button>
        </div>
      </ModalDialog>
    </div>
  );
}
