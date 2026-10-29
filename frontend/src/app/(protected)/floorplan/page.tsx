'use client';

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQueries } from '@tanstack/react-query';
import {
  ChevronRight,
  ExternalLink,
  Layers,
  MapPin,
  X,
} from 'lucide-react';
import {
  GRADE_STYLES,
  type HeatmapLayerMetric,
} from '@/config/thresholds';
import { UI_TEXT_VI } from '@/messages/vi';
import { formatMetrics } from '@/lib/format/metrics';
import {
  useRoomTelemetryStream,
  useStompConnectionState,
} from '@/lib/realtime/use-room-stream';
import {
  ConnectionBadge,
  EmptyState,
  ErrorBanner,
  GradeBadge,
  Skeleton,
} from '@/components/ui/primitives';
import { useAuthStore } from '@/features/auth/store';
import { useRoomsQuery } from '@/features/rooms/queries';
import { useDevicesQuery } from '@/features/devices/queries';
import { telemetryKeys } from '@/features/telemetry/queries';
import { telemetryApi } from '@/features/telemetry/api';
import {
  FloorplanCanvas,
  extractLayerMetricValue,
  formatLayerMetricValue,
} from '@/features/floorplan/components/FloorplanCanvas';
import {
  WEATHER_PALETTES,
  getPaletteCssGradient,
} from '@/lib/floorplan/weatherPalette';
import type {
  DeviceResponse,
  RoomResponse,
  TelemetryResponse,
} from '@/types/api';

const FLOOR_OPTIONS = [0, 1, 2, 3, 4, 5];

const LAYER_OPTIONS: Array<{
  key: HeatmapLayerMetric;
  label: string;
  unitLabel: string;
}> = [
  { key: 'comfortScore', label: 'Điểm tiện nghi', unitLabel: '0–100' },
  { key: 'noiseAvg', label: 'Độ ồn TB (LAeq)', unitLabel: 'dBA' },
  { key: 'pm2_5', label: 'Bụi mịn PM2.5', unitLabel: 'µg/m³' },
  { key: 'temperature', label: 'Nhiệt độ phòng', unitLabel: '°C' },
];

function RoomStreamSubscriber({ roomId }: { roomId: string }) {
  useRoomTelemetryStream(roomId);
  return null;
}

export default function FloorplanPage() {
  const [selectedFloor, setSelectedFloor] = useState<number>(1);
  const [selectedLayer, setSelectedLayer] =
    useState<HeatmapLayerMetric>('comfortScore');
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [focusedDeviceId, setFocusedDeviceId] = useState<string | null>(null);

  const capabilities = useAuthStore((s) => s.capabilities);
  const stompConnected = useStompConnectionState();

  const roomsQuery = useRoomsQuery({ page: 0, size: 50, floor: selectedFloor });
  const devicesQuery = useDevicesQuery(
    { page: 0, size: 100 },
    capabilities.canViewDevices
  );

  const floorRooms = useMemo(
    () => roomsQuery.data?.content ?? [],
    [roomsQuery.data]
  );

  const allDevices = useMemo(
    () => devicesQuery.data?.content ?? [],
    [devicesQuery.data]
  );

  const floorRoomIds = useMemo(
    () => new Set(floorRooms.map((r) => r.id)),
    [floorRooms]
  );

  const floorDevices = useMemo(
    () => allDevices.filter((d) => d.roomId && floorRoomIds.has(d.roomId)),
    [allDevices, floorRoomIds]
  );

  const roomLatestQueries = useQueries({
    queries: floorRooms.map((room) => ({
      queryKey: telemetryKeys.roomLatest(room.id),
      queryFn: () => telemetryApi.getRoomLatest(room.id),
      refetchInterval: stompConnected ? (false as const) : 15000,
    })),
  });

  const deviceLatestQueries = useQueries({
    queries: floorDevices.map((device) => ({
      queryKey: telemetryKeys.deviceLatest(device.id),
      queryFn: () => telemetryApi.getDeviceLatest(device.id),
      refetchInterval: stompConnected ? (false as const) : 15000,
    })),
  });

  const roomTelemetryMap = useMemo(() => {
    const map: Record<string, TelemetryResponse | null | undefined> = {};
    floorRooms.forEach((room, index) => {
      map[room.id] = roomLatestQueries[index]?.data ?? null;
    });
    return map;
  }, [floorRooms, roomLatestQueries]);

  const deviceTelemetryMap = useMemo(() => {
    const map: Record<string, TelemetryResponse | null | undefined> = {};
    floorDevices.forEach((device, index) => {
      map[device.id] = deviceLatestQueries[index]?.data ?? null;
    });
    return map;
  }, [floorDevices, deviceLatestQueries]);

  const unconfiguredRooms = useMemo(
    () =>
      floorRooms.filter(
        (r) => !Array.isArray(r.boundaryPolygon) || r.boundaryPolygon.length < 3
      ),
    [floorRooms]
  );

  const selectedRoom: RoomResponse | null = useMemo(
    () => floorRooms.find((r) => r.id === selectedRoomId) ?? null,
    [floorRooms, selectedRoomId]
  );

  const selectedRoomTelemetry = selectedRoom
    ? roomTelemetryMap[selectedRoom.id]
    : null;

  const selectedRoomDevices = useMemo(
    () => (selectedRoom ? floorDevices.filter((d) => d.roomId === selectedRoom.id) : []),
    [selectedRoom, floorDevices]
  );

  // Analyze floor devices for practical librarian operations (Hot desks, Noisy desks, Stuffy areas)
  const deskAlerts = useMemo(() => {
    const list: Array<{
      deviceId: string;
      roomId: string;
      roomCode: string;
      roomName: string;
      deviceName: string;
      location: string;
      type: 'noise' | 'heat' | 'air';
      badgeText: string;
      valueText: string;
      recommendation: string;
      actionText: string;
    }> = [];

    floorDevices.forEach((dev) => {
      if (!dev.online && dev.connectionState !== 'ONLINE') return;
      const tel = deviceTelemetryMap[dev.id];
      if (!tel) return;

      const room = floorRooms.find((r) => r.id === dev.roomId);
      const roomCode = room?.code || '';
      const roomName = room?.name || '';
      const location = dev.location || dev.name;

      // 1. Noise Check (Library rule: <= 50 dBA)
      const noise = tel.acoustics?.noiseAvg;
      if (typeof noise === 'number' && noise >= 50.0) {
        list.push({
          deviceId: dev.id,
          roomId: dev.roomId!,
          roomCode,
          roomName,
          deviceName: dev.name,
          location,
          type: 'noise',
          badgeText: '📢 Nhắc nhở trật tự',
          valueText: `${noise.toFixed(1)} dBA`,
          recommendation: `Bàn "${location}" đang ồn (${noise.toFixed(1)} dBA > 50 dBA). Cần nhắc độc giả nói khẽ hoặc đeo tai nghe.`,
          actionText: 'Tới bàn này',
        });
      }

      // 2. Heat Check (Library comfort: 21 - 24°C)
      const temp = tel.environment?.temperature;
      if (typeof temp === 'number' && temp >= 24.5) {
        list.push({
          deviceId: dev.id,
          roomId: dev.roomId!,
          roomCode,
          roomName,
          deviceName: dev.name,
          location,
          type: 'heat',
          badgeText: '❄️ Bật / Tăng máy lạnh',
          valueText: `${temp.toFixed(1)}°C`,
          recommendation: `Khu vực "${location}" đang bị hấp nhiệt (${temp.toFixed(1)}°C > 24°C). Cần bật điều hòa hướng này hoặc hạ rèm.`,
          actionText: 'Tới vị trí',
        });
      }

      // 3. Stuffy / Poor ventilation
      const pm25 = tel.airQuality?.pm2_5;
      if (typeof pm25 === 'number' && pm25 >= 22.0) {
        list.push({
          deviceId: dev.id,
          roomId: dev.roomId!,
          roomCode,
          roomName,
          deviceName: dev.name,
          location,
          type: 'air',
          badgeText: '💨 Bật quạt thông gió',
          valueText: `PM2.5: ${pm25.toFixed(1)}`,
          recommendation: `Khu vực "${location}" đang bí không khí (${pm25.toFixed(1)} µg/m³). Cần bật quạt thông gió hoặc mở khe gió.`,
          actionText: 'Tới vị trí',
        });
      }
    });

    return list;
  }, [floorDevices, deviceTelemetryMap, floorRooms]);

  return (
    <div className="page">
      {/* Background STOMP Subscribers */}
      {floorRooms.map((r) => (
        <RoomStreamSubscriber key={r.id} roomId={r.id} />
      ))}

      {/* Header & Controls */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Bản đồ Không gian & Heatmap 2D</h1>
          <p className="page-subtitle">
            Mặt bằng nhiệt động học nội suy IDW khóa vùng phòng đọc theo thời gian thực
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Floor Selector */}
          <div>
            <span className="sr-only">Chọn tầng</span>
            <div className="segmented">
              {FLOOR_OPTIONS.map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => {
                    setSelectedFloor(f);
                    setSelectedRoomId(null);
                    setFocusedDeviceId(null);
                  }}
                  className={`segmented-item ${selectedFloor === f ? 'segmented-item-active' : ''}`}
                >
                  {f === 0 ? 'Tầng Trệt' : `Tầng ${f}`}
                </button>
              ))}
            </div>
          </div>

          {/* Metric Layer Selector */}
          <div>
            <span className="sr-only">Lớp hiển thị</span>
            <div className="segmented">
              {LAYER_OPTIONS.map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => setSelectedLayer(opt.key)}
                  className={`segmented-item ${selectedLayer === opt.key ? 'segmented-item-active' : ''}`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Librarian Operations Dispatch Assistant */}
      <div className="card p-3.5 border-l-4 border-l-brand-600 bg-slate-900/60 shadow-md">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-700/60 pb-2">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-xs text-slate-100 flex items-center gap-1.5">
              <span>🎯</span>
              <span>Trợ lý Điều phối Vận hành cho Thủ thư</span>
            </span>
            <span className="badge badge-neutral text-2xs font-mono">
              {selectedFloor === 0 ? 'Tầng Trệt' : `Tầng ${selectedFloor}`}
            </span>
          </div>
          <span className="text-2xs text-slate-400">
            {deskAlerts.length > 0
              ? `Có ${deskAlerts.length} vị trí bàn đọc cần thủ thư lưu ý can thiệp`
              : 'Tất cả các bàn đọc đang đạt chuẩn vi khí hậu & yên tĩnh tối ưu'}
          </span>
        </div>

        {deskAlerts.length === 0 ? (
          <div className="mt-2.5 flex items-center gap-2 text-xs text-emerald-400 font-medium">
            <span>✅</span>
            <span>Không gian phòng đọc đang hoàn hảo (21.5°C – 23.5°C, tiếng ồn &lt; 50 dBA). Không có bàn nào cần can thiệp.</span>
          </div>
        ) : (
          <div className="mt-2.5 grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {deskAlerts.slice(0, 3).map((item, idx) => (
              <div
                key={idx}
                className={`flex flex-col justify-between rounded-lg border p-2.5 text-xs transition-all ${
                  item.type === 'noise'
                    ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                    : item.type === 'heat'
                    ? 'border-red-500/40 bg-red-500/10 text-red-200'
                    : 'border-sky-500/40 bg-sky-500/10 text-sky-200'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between gap-1 mb-1">
                    <span className="font-bold text-2xs uppercase tracking-wider px-1.5 py-0.5 rounded bg-black/40">
                      {item.badgeText}
                    </span>
                    <span className="font-mono font-bold">{item.valueText}</span>
                  </div>
                  <p className="text-2xs leading-relaxed opacity-90">
                    {item.recommendation}
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    setSelectedRoomId(item.roomId);
                    setFocusedDeviceId(item.deviceId);
                  }}
                  className="mt-2 inline-flex items-center justify-center rounded bg-white/10 hover:bg-white/20 px-2 py-1 text-2xs font-semibold text-white transition-colors"
                >
                  <span>📍 {item.actionText} ({item.roomCode})</span>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Reconnecting Alert */}
      {!stompConnected && (
        <div
          role="status"
          className="rounded-lg border border-amber-200 bg-amber-50/70 p-3 text-xs text-amber-900"
        >
          {UI_TEXT_VI.wsReconnectingBanner}
        </div>
      )}

      {/* Error State */}
      {roomsQuery.isError && (
        <ErrorBanner
          message="Không thể tải danh sách phòng đọc của tầng này."
          onRetry={() => void roomsQuery.refetch()}
        />
      )}

      {/* Loading or Canvas */}
      {roomsQuery.isLoading ? (
        <Skeleton className="h-[500px] w-full" />
      ) : floorRooms.length === 0 ? (
        <EmptyState
          title={UI_TEXT_VI.emptyRoomsFloor}
          description="Tầng này chưa có phòng đọc nào được khai báo trên hệ thống."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
          {/* Main Canvas Area */}
          <div
            className={
              selectedRoom ? 'space-y-3.5 xl:col-span-8' : 'space-y-3.5 xl:col-span-12'
            }
          >
            <div className="card overflow-hidden">
              <FloorplanCanvas
                rooms={floorRooms}
                devices={floorDevices}
                roomTelemetryMap={roomTelemetryMap}
                deviceTelemetryMap={deviceTelemetryMap}
                layer={selectedLayer}
                selectedRoomId={selectedRoomId}
                onSelectRoom={(room) => {
                  setSelectedRoomId(room.id);
                  setFocusedDeviceId(null);
                }}
                onSelectDevice={(device, room) => {
                  if (room) setSelectedRoomId(room.id);
                  setFocusedDeviceId(device.id);
                }}
              />
            </div>

            {/* Meteorological Radar Color Scale Legend */}
            <div className="card space-y-2 p-3.5 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-slate-800">
                    Thang nhiệt độ & trường sóng lan truyền ({LAYER_OPTIONS.find((l) => l.key === selectedLayer)?.label}):
                  </span>
                  <span className="badge badge-primary text-2xs font-normal">
                    Mô phỏng loang vi khí hậu (Atmospheric IDW Diffusion)
                  </span>
                </div>
                <span className="text-2xs text-slate-400">
                  Nhấp vào trạm đo hoặc phòng để xem chi tiết
                </span>
              </div>

              {/* Continuous Gradient Bar */}
              <div className="relative pt-1">
                <div
                  className="h-3.5 w-full rounded-full shadow-inner border border-slate-200 dark:border-slate-700"
                  style={{
                    background: getPaletteCssGradient(selectedLayer),
                  }}
                  aria-hidden="true"
                />

                {/* Legend Ticks & Descriptions */}
                <div className="mt-1.5 flex justify-between text-2xs font-medium text-slate-600">
                  {WEATHER_PALETTES[selectedLayer]?.map((stop, idx) => (
                    <span key={idx} className="flex flex-col items-center">
                      <span className="h-1 w-px bg-slate-300 mb-0.5" />
                      <span>{stop.label}</span>
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {/* Unconfigured Rooms Callout */}
            {unconfiguredRooms.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3.5">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-xs font-semibold text-amber-900">
                    Phòng chưa thiết lập đa giác mặt bằng ({unconfiguredRooms.length})
                  </h2>
                </div>
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {unconfiguredRooms.map((room) => (
                    <div
                      key={room.id}
                      className="flex items-center justify-between gap-2 rounded-md border border-amber-200 bg-white p-2 text-xs"
                    >
                      <div>
                        <p className="font-semibold text-slate-900">
                          {room.code} — {room.name}
                        </p>
                      </div>
                      {capabilities.canManageRooms ? (
                        <Link
                          href={`/admin/rooms/${room.id}/polygon`}
                          className="btn-primary btn-sm h-6 text-2xs px-2"
                        >
                          Vẽ đa giác
                        </Link>
                      ) : (
                        <Link
                          href={`/rooms/${room.id}`}
                          className="btn-secondary btn-sm h-6 text-2xs px-2"
                        >
                          Xem
                        </Link>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Right Slide-Over Panel */}
          {selectedRoom && (
            <aside
              aria-label={`Chi tiết phòng ${selectedRoom.name}`}
              className="card p-5 xl:col-span-4 space-y-4"
            >
              <div className="flex items-start justify-between gap-2 border-b border-slate-100 pb-3">
                <div>
                  <span className="font-mono text-2xs font-medium text-brand-600">
                    {selectedRoom.code} · Tầng {selectedRoom.floor}
                  </span>
                  <h2 className="text-base font-semibold text-slate-900">
                    {selectedRoom.name}
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedRoomId(null);
                    setFocusedDeviceId(null);
                  }}
                  aria-label="Đóng bảng chi tiết"
                  className="btn-icon"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="flex items-center justify-between">
                <GradeBadge
                  grade={selectedRoomTelemetry?.comfortScore?.grade}
                  score={selectedRoomTelemetry?.comfortScore?.overall}
                />
                <span className="font-semibold text-xl tabular text-slate-900">
                  {formatMetrics.comfortScore(
                    selectedRoomTelemetry?.comfortScore?.overall
                  )}{' '}
                  <span className="text-xs font-normal text-slate-400">/100</span>
                </span>
              </div>

              {/* 4 Key Metrics Grid */}
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-lg border border-slate-100 bg-slate-50/50 p-2.5">
                  <span className="text-2xs text-slate-500">Độ ồn (LAeq / Peak)</span>
                  <p className="mt-0.5 font-semibold text-slate-800 tabular">
                    {formatMetrics.noise(selectedRoomTelemetry?.acoustics?.noiseAvg)}
                  </p>
                </div>

                <div className="rounded-lg border border-slate-100 bg-slate-50/50 p-2.5">
                  <span className="text-2xs text-slate-500">Bụi mịn PM2.5</span>
                  <p className="mt-0.5 font-semibold text-slate-800 tabular">
                    {formatMetrics.pm(selectedRoomTelemetry?.airQuality?.pm2_5)}
                  </p>
                </div>

                <div className="rounded-lg border border-slate-100 bg-slate-50/50 p-2.5">
                  <span className="text-2xs text-slate-500">Nhiệt độ phòng</span>
                  <p className="mt-0.5 font-semibold text-slate-800 tabular">
                    {formatMetrics.temperature(
                      selectedRoomTelemetry?.environment?.temperature
                    )}
                  </p>
                </div>

                <div className="rounded-lg border border-slate-100 bg-slate-50/50 p-2.5">
                  <span className="text-2xs text-slate-500">Độ ẩm tương đối</span>
                  <p className="mt-0.5 font-semibold text-slate-800 tabular">
                    {formatMetrics.humidity(
                      selectedRoomTelemetry?.environment?.humidity
                    )}
                  </p>
                </div>
              </div>

              {/* Devices in this room */}
              <div className="border-t border-slate-100 pt-3">
                <h3 className="text-xs font-semibold text-slate-900 mb-2">
                  Trạm cảm biến gắn kèm ({selectedRoomDevices.length})
                </h3>
                {selectedRoomDevices.length === 0 ? (
                  <p className="text-2xs text-slate-400 italic">
                    Chưa có thiết bị nào gắn với phòng đọc này.
                  </p>
                ) : (
                  <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
                    {selectedRoomDevices.map((d) => {
                      const devTel = deviceTelemetryMap[d.id];
                      const devVal = extractLayerMetricValue(devTel, selectedLayer);
                      return (
                        <div
                          key={d.id}
                          onClick={() => setFocusedDeviceId(d.id)}
                          className={`flex items-center justify-between rounded-md border p-2 text-xs cursor-pointer transition-colors ${
                            focusedDeviceId === d.id
                              ? 'border-brand-500 bg-brand-50/50'
                              : 'border-slate-100 bg-slate-50/40 hover:bg-slate-100/60'
                          }`}
                        >
                          <div className="min-w-0 pr-2">
                            <p className="font-semibold text-slate-800 truncate">{d.name}</p>
                            <p className="font-mono text-2xs text-slate-400">{d.hardwareId}</p>
                            {d.location && (
                              <p className="text-2xs text-slate-500 truncate mt-0.5">📍 {d.location}</p>
                            )}
                          </div>
                          <div className="flex flex-col items-end gap-1 shrink-0">
                            <ConnectionBadge online={d.online} />
                            {devVal !== null && (
                              <span className="font-mono font-semibold text-2xs tabular text-slate-700">
                                {formatLayerMetricValue(devVal, selectedLayer)}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Action Buttons */}
              <div className="flex flex-col gap-2 border-t border-slate-100 pt-3">
                <Link
                  href={`/rooms/${selectedRoom.id}`}
                  className="btn-primary btn-sm w-full text-center"
                >
                  <span>Chi tiết & Biểu đồ nén</span>
                  <ChevronRight className="h-3.5 w-3.5" />
                </Link>

                {capabilities.canManageRooms && (
                  <Link
                    href={`/admin/rooms/${selectedRoom.id}/polygon`}
                    className="btn-secondary btn-sm w-full text-center"
                  >
                    <span>Chỉnh sửa mặt bằng phòng</span>
                  </Link>
                )}
              </div>
            </aside>
          )}
        </div>
      )}

      {/* Accessible Text Table for Screen Readers (FE-A11Y-05) */}
      <section aria-label="Bảng dữ liệu vi khí hậu các phòng đọc" className="card mt-4">
        <div className="card-header">
          <h2 className="section-title">
            Dữ liệu quan trắc {selectedFloor === 0 ? 'Tầng Trệt' : `tầng ${selectedFloor}`}
          </h2>
          <span className="text-2xs text-slate-400">
            {floorRooms.length} phòng đọc
          </span>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Phòng đọc</th>
                <th>Tầng</th>
                <th>Lớp {LAYER_OPTIONS.find((l) => l.key === selectedLayer)?.label}</th>
                <th>Độ ồn TB</th>
                <th>Bụi PM2.5</th>
                <th>Nhiệt độ</th>
                <th>Độ ẩm</th>
                <th>Trạng thái</th>
                <th className="text-right">Chi tiết</th>
              </tr>
            </thead>
            <tbody>
              {floorRooms.map((room) => {
                const tel = roomTelemetryMap[room.id];
                const layerVal = extractLayerMetricValue(tel, selectedLayer);

                return (
                  <tr key={room.id}>
                    <td>
                      <div className="font-semibold text-slate-900">{room.name}</div>
                      <div className="font-mono text-2xs text-slate-400">{room.code}</div>
                    </td>
                    <td className="tabular">Tầng {room.floor}</td>
                    <td className="font-medium tabular text-slate-800">
                      {formatLayerMetricValue(layerVal, selectedLayer)}
                    </td>
                    <td className="tabular text-xs">
                      {formatMetrics.noise(tel?.acoustics?.noiseAvg)}
                    </td>
                    <td className="tabular text-xs">
                      {formatMetrics.pm(tel?.airQuality?.pm2_5)}
                    </td>
                    <td className="tabular text-xs">
                      {formatMetrics.temperature(tel?.environment?.temperature)}
                    </td>
                    <td className="tabular text-xs">
                      {formatMetrics.humidity(tel?.environment?.humidity)}
                    </td>
                    <td>
                      <GradeBadge
                        grade={tel?.comfortScore?.grade}
                        score={tel?.comfortScore?.overall}
                      />
                    </td>
                    <td className="text-right">
                      <Link
                        href={`/rooms/${room.id}`}
                        className="btn-secondary btn-sm"
                      >
                        Xem
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
