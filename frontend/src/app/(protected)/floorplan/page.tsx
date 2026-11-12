'use client';

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQueries } from '@tanstack/react-query';
import {
  ArrowUpRight,
  ChevronRight,
  ShieldAlert,
  X,
} from 'lucide-react';
import {
  buildPresetFallbackTelemetry,
  getFloorRoomPresets,
  resolveRoomPolygon,
  resolveRoomPreset,
  synthesizeAnonymousMicroZones,
  type AnonymousMicroZone,
} from '@/config/tqb-floorplan-presets';
import { type HeatmapLayerMetric } from '@/config/thresholds';
import { UI_TEXT_VI } from '@/messages/vi';
import { formatMetrics } from '@/lib/format/metrics';
import { isTelemetryStale } from '@/lib/format/datetime';
import {
  useRoomTelemetryStream,
  useStompConnectionState,
} from '@/lib/realtime/use-room-stream';
import {
  CollapsibleSection,
  ConnectionBadge,
  EmptyState,
  ErrorBanner,
  GradeBadge,
  Skeleton,
} from '@/components/ui/primitives';
import {
  useAcknowledgeAlertMutation,
  useAlertsQuery,
  useResolveAlertMutation,
} from '@/features/alerts/queries';
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
  computeRoomBlindspotRatio,
  getPaletteCssGradient,
} from '@/lib/floorplan/weatherPalette';
import type {
  AlertResponse,
  DeviceResponse,
  RoleName,
  RoomResponse,
  TelemetryResponse,
} from '@/types/api';

const FLOOR_OPTIONS = [1, 2, 3, 4, 5];

const LAYER_OPTIONS: Array<{
  key: HeatmapLayerMetric;
  label: string;
  shortLabel: string;
  unitLabel: string;
}> = [
  {
    key: 'comfortScore',
    label: 'Điểm tiện nghi',
    shortLabel: 'Tiện nghi',
    unitLabel: '0–100',
  },
  {
    key: 'noiseAvg',
    label: 'Độ ồn TB (LAeq)',
    shortLabel: 'Độ ồn',
    unitLabel: 'dBA',
  },
  {
    key: 'temperature',
    label: 'Nhiệt độ phòng',
    shortLabel: 'Nhiệt độ',
    unitLabel: '°C',
  },
  {
    key: 'humidity',
    label: 'Độ ẩm (Kho sách)',
    shortLabel: 'Độ ẩm',
    unitLabel: '%RH',
  },
  {
    key: 'lux',
    label: 'Độ rọi sáng',
    shortLabel: 'Ánh sáng',
    unitLabel: 'lux',
  },
  {
    key: 'pm2_5',
    label: 'Bụi mịn PM2.5',
    shortLabel: 'PM2.5',
    unitLabel: 'µg/m³',
  },
  {
    key: 'wifiRssi',
    label: 'Sóng Wi-Fi (RSSI)',
    shortLabel: 'Wi-Fi RSSI',
    unitLabel: 'dBm',
  },
];

type StudyFilterMode = 'quiet' | 'group' | 'bright_cool' | 'multimedia';

type EffectiveRoleView = 'ADMIN' | 'LIBRARIAN' | 'MAINTENANCE' | 'USER';

function RoomStreamSubscriber({ roomId }: { roomId: string }) {
  // Only subscribe to real backend MongoDB ObjectId rooms (not synthetic preset preview rooms)
  if (roomId.startsWith('PRESET_')) return null;
  return <RoomStreamInner roomId={roomId} />;
}

function RoomStreamInner({ roomId }: { roomId: string }) {
  useRoomTelemetryStream(roomId);
  return null;
}

export default function FloorplanPage() {
  const [selectedFloor, setSelectedFloor] = useState<number>(3);
  const [selectedLayer, setSelectedLayer] =
    useState<HeatmapLayerMetric>('comfortScore');
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [zoomedRoomId, setZoomedRoomId] = useState<string | null>(null);
  const [focusedDeviceId, setFocusedDeviceId] = useState<string | null>(null);
  const [selectedBayId, setSelectedBayId] = useState<string | null>(null);
  const [studyFilter, setStudyFilter] = useState<StudyFilterMode>('quiet');
  const [showBlindspots, setShowBlindspots] = useState<boolean>(false);
  const [onlyAssignedZones, setOnlyAssignedZones] = useState<boolean>(false);
  const [includeTqbArchitecturePresets, setIncludeTqbArchitecturePresets] =
    useState<boolean>(true);
  const [adminRoleOverride, setAdminRoleOverride] =
    useState<EffectiveRoleView | null>(null);

  const capabilities = useAuthStore((s) => s.capabilities);
  const currentUser = useAuthStore((s) => s.user);
  const stompConnected = useStompConnectionState();

  // Xác định góc nhìn Role đang kích hoạt (cho phép ADMIN chuyển đổi góc nhìn 4 Role ngay trên thanh công cụ)
  const defaultRoleView: EffectiveRoleView = useMemo(() => {
    if (capabilities.isAdmin) return 'ADMIN';
    if (capabilities.isMaintenance) return 'MAINTENANCE';
    if (capabilities.isLibrarian || capabilities.isZoneManager) {
      return 'LIBRARIAN';
    }
    return 'USER';
  }, [capabilities]);

  const effectiveRole: EffectiveRoleView = capabilities.isAdmin
    ? (adminRoleOverride ?? defaultRoleView)
    : defaultRoleView;

  const isStudentView = effectiveRole === 'USER';
  const isLibrarianView =
    effectiveRole === 'LIBRARIAN' || effectiveRole === 'ADMIN';
  const isMaintenanceView = effectiveRole === 'MAINTENANCE';

  const roomsQuery = useRoomsQuery({
    page: 0,
    size: 50,
    floor: selectedFloor,
  });

  // FE-VIZ-09: Khi ở góc nhìn USER/VIEWER, tuyệt đối không hiển thị danh sách thiết bị phần cứng
  const devicesQuery = useDevicesQuery(
    { page: 0, size: 100 },
    capabilities.canViewDevices && !isStudentView
  );

  // Tích hợp danh sách Cảnh báo thời gian thực (Alert FSM) cho LIBRARIAN / ZONE_MANAGER / MAINTENANCE / ADMIN
  const alertsQuery = useAlertsQuery(
    { page: 0, size: 50 },
    capabilities.canViewAlerts && !isStudentView
  );
  const ackAlertMutation = useAcknowledgeAlertMutation();
  const resolveAlertMutation = useResolveAlertMutation();

  const backendFloorRooms = useMemo(
    () => roomsQuery.data?.content ?? [],
    [roomsQuery.data]
  );

  // Kết hợp phòng từ Backend DB với mặt bằng kiến trúc chuẩn TQB (`Mat bang Thu vien TQB.pdf`)
  // để các tầng đại diện (Tầng 1, 2, 3, 4, 5) luôn hiển thị đầy đủ các phòng đọc, kho sách và cụm 8 phòng nhóm Tầng 5
  const floorRooms: RoomResponse[] = useMemo(() => {
    const presetsOnFloor = getFloorRoomPresets(selectedFloor);
    const enrichedBackend = backendFloorRooms.map((r, idx) => {
      const poly = resolveRoomPolygon(r, idx);
      const preset = resolveRoomPreset(r, idx);
      return {
        ...r,
        type: r.type ?? preset?.roomType ?? 'STUDY_ROOM',
        capacity: r.capacity ?? preset?.capacity ?? 60,
        boundaryPolygon: poly ? [...poly] : r.boundaryPolygon,
      };
    });

    if (!includeTqbArchitecturePresets) {
      return enrichedBackend;
    }

    const matchedPresetCodes = new Set<string>();
    enrichedBackend.forEach((r, idx) => {
      const matched = resolveRoomPreset(r, idx);
      if (matched) matchedPresetCodes.add(matched.code);
    });

    const missingPresets: RoomResponse[] = presetsOnFloor
      .filter((p) => !matchedPresetCodes.has(p.code))
      .map((p) => ({
        id: `PRESET_${p.code}`,
        code: p.code,
        name: p.name,
        floor: selectedFloor,
        capacity: p.capacity,
        type: p.roomType,
        targetComfortScore: p.roomType === 'BOOK_STORAGE' ? 90 : 85,
        description: `Không gian chuẩn kiến trúc TQB (${p.areaM2} m² · Phân khu ${p.zoneCode})`,
        boundaryPolygon: [...p.boundaryPolygon],
      }));

    return [...enrichedBackend, ...missingPresets];
  }, [backendFloorRooms, selectedFloor, includeTqbArchitecturePresets]);

  // Lọc theo assignedZones nếu là ZONE_MANAGER và đang bật chế độ lọc phân khu phụ trách
  const assignedZones = useMemo(
    () =>
      currentUser?.assignedZones && currentUser.assignedZones.length > 0
        ? currentUser.assignedZones
        : ['ZONE_A', 'ZONE_B'],
    [currentUser]
  );

  const visibleFloorRooms = useMemo(() => {
    if (!onlyAssignedZones) return floorRooms;
    return floorRooms.filter((r, idx) => {
      const preset = resolveRoomPreset(r, idx);
      return preset ? assignedZones.includes(preset.zoneCode) : true;
    });
  }, [floorRooms, onlyAssignedZones, assignedZones]);

  const allDevices = useMemo(
    () => (isStudentView ? [] : (devicesQuery.data?.content ?? [])),
    [devicesQuery.data, isStudentView]
  );

  const floorRoomIds = useMemo(
    () => new Set(floorRooms.map((r) => r.id)),
    [floorRooms]
  );

  const floorDevices = useMemo(
    () => allDevices.filter((d) => d.roomId && floorRoomIds.has(d.roomId)),
    [allDevices, floorRoomIds]
  );

  const realFloorRooms = useMemo(
    () => floorRooms.filter((r) => !r.id.startsWith('PRESET_')),
    [floorRooms]
  );

  const roomLatestQueries = useQueries({
    queries: realFloorRooms.map((room) => ({
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
    const realMap = new Map<string, TelemetryResponse | null>();
    realFloorRooms.forEach((room, index) => {
      realMap.set(room.id, roomLatestQueries[index]?.data ?? null);
    });

    floorRooms.forEach((room, idx) => {
      const realTel = realMap.get(room.id);
      if (realTel) {
        map[room.id] = realTel;
      } else if (room.id.startsWith('PRESET_')) {
        map[room.id] = buildPresetFallbackTelemetry(room, idx);
      } else {
        map[room.id] = null;
      }
    });
    return map;
  }, [floorRooms, realFloorRooms, roomLatestQueries]);

  const deviceTelemetryMap = useMemo(() => {
    const map: Record<string, TelemetryResponse | null | undefined> = {};
    floorDevices.forEach((device, index) => {
      map[device.id] = deviceLatestQueries[index]?.data ?? null;
    });
    return map;
  }, [floorDevices, deviceLatestQueries]);

  const unconfiguredRooms = useMemo(
    () =>
      backendFloorRooms.filter(
        (r) => !Array.isArray(r.boundaryPolygon) || r.boundaryPolygon.length < 3
      ),
    [backendFloorRooms]
  );

  const selectedRoom: RoomResponse | null = useMemo(
    () => floorRooms.find((r) => r.id === selectedRoomId) ?? null,
    [floorRooms, selectedRoomId]
  );

  const selectedRoomIdx = useMemo(
    () =>
      selectedRoom
        ? Math.max(
            0,
            floorRooms.findIndex((r) => r.id === selectedRoom.id)
          )
        : 0,
    [floorRooms, selectedRoom]
  );

  const selectedRoomPreset = useMemo(
    () =>
      selectedRoom ? resolveRoomPreset(selectedRoom, selectedRoomIdx) : null,
    [selectedRoom, selectedRoomIdx]
  );

  const selectedRoomTelemetry = selectedRoom
    ? roomTelemetryMap[selectedRoom.id]
    : null;

  const selectedRoomMicroZones = useMemo(
    () =>
      selectedRoom
        ? synthesizeAnonymousMicroZones(
            selectedRoom,
            selectedRoomTelemetry,
            selectedRoomIdx
          )
        : [],
    [selectedRoom, selectedRoomTelemetry, selectedRoomIdx]
  );

  const selectedRoomDevices = useMemo(
    () =>
      selectedRoom
        ? floorDevices.filter((d) => d.roomId === selectedRoom.id)
        : [],
    [selectedRoom, floorDevices]
  );

  // Active Backend Alerts (FIRING / ACKNOWLEDGED) on this floor and for the selected room
  const activeAlerts = useMemo(() => {
    const all = alertsQuery.data?.content ?? [];
    return all.filter(
      (a) => a.status === 'FIRING' || a.status === 'ACKNOWLEDGED'
    );
  }, [alertsQuery.data]);

  const selectedRoomAlerts: AlertResponse[] = useMemo(() => {
    if (!selectedRoom) return [];
    return activeAlerts.filter((a) => a.roomId === selectedRoom.id);
  }, [activeAlerts, selectedRoom]);

  // ============================================================================
  // ROLE 1 (USER / VIEWER): Smart Study Spot Finder ("Tìm Chỗ Ngồi Học Lý Tưởng")
  // ============================================================================
  const studyRecommendations = useMemo(() => {
    const candidates: Array<{
      room: RoomResponse;
      bay: AnonymousMicroZone;
      areaM2: number;
      score: number;
      reasonVi: string;
    }> = [];

    visibleFloorRooms.forEach((room, idx) => {
      const preset = resolveRoomPreset(room, idx);
      const roomType = preset?.roomType ?? room.type ?? 'STUDY_ROOM';
      // Không gợi ý kho sách đóng kín cho sinh viên tự học
      if (roomType === 'BOOK_STORAGE') return;

      const tel = roomTelemetryMap[room.id];
      if (!tel || tel.isSynthetic || room.id.startsWith('PRESET_')) return;
      const bays = synthesizeAnonymousMicroZones(room, tel, idx);
      const areaM2 = preset?.areaM2 ?? 120;

      for (const bay of bays) {
        let matchScore = bay.metrics.comfortScore;
        let reasonVi = `${bay.metrics.temperature}°C · ${bay.metrics.noiseAvg} dBA · ${bay.metrics.lux} lx`;

        if (studyFilter === 'quiet') {
          if (bay.metrics.noiseAvg <= 42) matchScore += 25;
          else if (bay.metrics.noiseAvg <= 46) matchScore += 10;
          else matchScore -= 20;
          if (bay.tags.includes('quiet')) matchScore += 15;
          reasonVi = `Yên tĩnh ${bay.metrics.noiseAvg} dBA (< 42 dBA) · ${bay.metrics.temperature}°C · ${bay.seatCapacity} chỗ`;
        } else if (studyFilter === 'group') {
          if (bay.tags.includes('group') || areaM2 <= 60) matchScore += 35;
          else matchScore -= 15;
          reasonVi = `Thảo luận nhóm (${bay.seatCapacity} chỗ) · Cách âm tốt · Wi-Fi ${bay.metrics.wifiRssi} dBm`;
        } else if (studyFilter === 'bright_cool') {
          if (
            bay.metrics.lux >= 300 &&
            bay.metrics.lux <= 580 &&
            bay.metrics.temperature <= 23.5
          ) {
            matchScore += 28;
          }
          if (bay.tags.includes('window') || bay.tags.includes('ac_cool')) {
            matchScore += 12;
          }
          reasonVi = `Sáng chuẩn ${bay.metrics.lux} lx · Mát ${bay.metrics.temperature}°C · Ẩm ${bay.metrics.humidity}%`;
        } else if (studyFilter === 'multimedia') {
          if (
            bay.tags.includes('multimedia') ||
            room.name.toLowerCase().includes('multimedia')
          ) {
            matchScore += 32;
          }
          reasonVi = `Tra cứu CSDL & PC · Wi-Fi ${bay.metrics.wifiRssi} dBm · ${bay.metrics.temperature}°C`;
        }

        candidates.push({
          room,
          bay,
          areaM2,
          score: matchScore,
          reasonVi,
        });
      }
    });

    return candidates.sort((a, b) => b.score - a.score).slice(0, 4);
  }, [visibleFloorRooms, roomTelemetryMap, studyFilter]);

  // ============================================================================
  // ROLE 2 (LIBRARIAN / ZONE_MANAGER): RoomType-Aware Operational Alerts (Book Storage Humidity, Study Room Noise/Heat)
  // ============================================================================
  const librarianAdvisories = useMemo(() => {
    const list: Array<{
      id: string;
      roomId: string;
      deviceId?: string;
      roomCode: string;
      roomName: string;
      roomType: string;
      zoneCode: string;
      category: 'mold_humidity' | 'noise' | 'heat' | 'air';
      badgeText: string;
      valueText: string;
      recommendation: string;
      targetLayer: HeatmapLayerMetric;
    }> = [];

    visibleFloorRooms.forEach((room, idx) => {
      const preset = resolveRoomPreset(room, idx);
      const roomType = preset?.roomType ?? room.type ?? 'STUDY_ROOM';
      const zoneCode = preset?.zoneCode ?? 'ZONE_A';
      const tel = roomTelemetryMap[room.id];
      if (!tel || tel.isSynthetic || room.id.startsWith('PRESET_')) return;

      const hum = tel.environment?.humidity;
      const noise = tel.acoustics?.noiseAvg;
      const temp = tel.environment?.temperature;
      const pm25 = tel.airQuality?.pm2_5;

      // 1. BOOK_STORAGE (Kho sách 264.7 m² & Phòng Truyền thống 225 m²): Cảnh báo ẩm mốc nghiêm ngặt (> 58%RH)
      if (
        roomType === 'BOOK_STORAGE' &&
        typeof hum === 'number' &&
        hum >= 57.5
      ) {
        list.push({
          id: `adv-hum-${room.id}`,
          roomId: room.id,
          roomCode: room.code,
          roomName: room.name,
          roomType,
          zoneCode,
          category: 'mold_humidity',
          badgeText: 'Bảo quản Kho sách (Độ ẩm)',
          valueText: `${hum.toFixed(1)}%RH`,
          recommendation: `Kho tài liệu "${room.name}" có độ ẩm tiến sát/vượt ngưỡng 60%RH. Kích hoạt máy hút ẩm để chống nấm mốc giấy.`,
          targetLayer: 'humidity',
        });
      }

      // 2. STUDY_ROOM: Kiểm tra tiếng ồn (> 48 dBA) và nhiệt độ (> 24.2°C)
      if (roomType === 'STUDY_ROOM' && typeof noise === 'number' && noise >= 48.0) {
        list.push({
          id: `adv-noise-${room.id}`,
          roomId: room.id,
          roomCode: room.code,
          roomName: room.name,
          roomType,
          zoneCode,
          category: 'noise',
          badgeText: 'Nhắc nhở trật tự phòng đọc',
          valueText: `${noise.toFixed(1)} dBA`,
          recommendation: `Phòng đọc "${room.name}" vượt ngưỡng yên tĩnh. Nhắc độc giả chuyển sang cụm phòng nhóm Tầng 5 nếu cần thảo luận.`,
          targetLayer: 'noiseAvg',
        });
      }

      if (typeof temp === 'number' && temp >= 24.3) {
        list.push({
          id: `adv-heat-${room.id}`,
          roomId: room.id,
          roomCode: room.code,
          roomName: room.name,
          roomType,
          zoneCode,
          category: 'heat',
          badgeText: 'Điều chỉnh làm mát bức xạ kính',
          valueText: `${temp.toFixed(1)}°C`,
          recommendation: `Khu vực bàn sát vách kính "${room.name}" ấm lên do bức xạ mặt trời. Hạ rèm chắn nắng hoặc tăng gió lạnh.`,
          targetLayer: 'temperature',
        });
      }

      if (typeof pm25 === 'number' && pm25 >= 21.0) {
        list.push({
          id: `adv-air-${room.id}`,
          roomId: room.id,
          roomCode: room.code,
          roomName: room.name,
          roomType,
          zoneCode,
          category: 'air',
          badgeText: 'Tăng cấp khí tươi AHU',
          valueText: `${pm25.toFixed(1)} µg/m³`,
          recommendation: `Mật độ bụi mịn PM2.5 tại "${room.name}" tăng cao. Bật quạt cấp khí tươi hành lang.`,
          targetLayer: 'pm2_5',
        });
      }
    });

    return list;
  }, [visibleFloorRooms, roomTelemetryMap]);

  // ============================================================================
  // ROLE 3 (MAINTENANCE): Infrastructure, Wi-Fi RSSI, Sensor Blindspots & HVAC Imbalance Diagnostics
  // ============================================================================
  const maintenanceDiagnostics = useMemo(() => {
    const onlineCount = floorDevices.filter(
      (d) => d.online || d.connectionState === 'ONLINE'
    ).length;
    const offlineDevices = floorDevices.filter(
      (d) => !d.online && d.connectionState !== 'ONLINE'
    );
    const weakWifiRooms: Array<{ room: RoomResponse; rssi: number }> = [];
    const hvacImbalanceRooms: Array<{
      room: RoomResponse;
      deltaT: number;
      minT: number;
      maxT: number;
    }> = [];
    const blindspotRooms: Array<{
      room: RoomResponse;
      blindspotPct: number;
    }> = [];

    visibleFloorRooms.forEach((room, idx) => {
      const tel = roomTelemetryMap[room.id];
      const polygon = resolveRoomPolygon(room, idx);
      const bays = synthesizeAnonymousMicroZones(room, tel, idx);

      const rssi = tel?.wifiRssi ?? -58;
      if (rssi <= -72) {
        weakWifiRooms.push({ room, rssi });
      }

      if (bays.length >= 2) {
        const temps = bays.map((b) => b.metrics.temperature);
        const minT = Math.min(...temps);
        const maxT = Math.max(...temps);
        const deltaT = +(maxT - minT).toFixed(1);
        if (deltaT >= 1.5) {
          hvacImbalanceRooms.push({ room, deltaT, minT, maxT });
        }
      }

      if (polygon && polygon.length >= 3) {
        const samples = bays.map((b) => ({
          x: b.posX,
          y: b.posY,
          value: b.metrics.temperature,
          online: true,
        }));
        const bs = computeRoomBlindspotRatio(polygon, samples);
        if (bs.blindspotRatio >= 0.15) {
          blindspotRooms.push({
            room,
            blindspotPct: Math.round(bs.blindspotRatio * 100),
          });
        }
      }
    });

    return {
      totalDevices: floorDevices.length,
      onlineCount,
      offlineDevices,
      weakWifiRooms,
      hvacImbalanceRooms,
      blindspotRooms,
    };
  }, [floorDevices, visibleFloorRooms, roomTelemetryMap]);

  return (
    <div className="page">
      {/* Background STOMP Subscribers */}
      {realFloorRooms.map((r) => (
        <RoomStreamSubscriber key={r.id} roomId={r.id} />
      ))}

      {/* Unified Header & Controls Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="page-title">Bản đồ mặt bằng</h1>

          {/* Floor Selector */}
          <div className="segmented" role="group" aria-label="Chọn tầng">
            {FLOOR_OPTIONS.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => {
                  setSelectedFloor(f);
                  setSelectedRoomId(null);
                  setZoomedRoomId(null);
                  setFocusedDeviceId(null);
                  setSelectedBayId(null);
                }}
                className={`segmented-item ${
                  selectedFloor === f ? 'segmented-item-active' : ''
                }`}
              >
                Tầng {f}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Toggle Full TQB Architectural Rooms */}
          <button
            type="button"
            onClick={() => setIncludeTqbArchitecturePresets((v) => !v)}
            className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
              includeTqbArchitecturePresets
                ? 'border-slate-900 bg-slate-900 text-white'
                : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
            }`}
            title="Hiển thị đầy đủ các phòng từ bản vẽ CAD Thư viện Tạ Quang Bửu"
          >
            Đủ phòng CAD ({visibleFloorRooms.length})
          </button>

          {/* Compact Admin Role Switcher */}
          {capabilities.isAdmin && (
            <div className="flex items-center gap-1.5">
              <label
                htmlFor="role-view-select"
                className="text-xs text-slate-500"
              >
                Góc nhìn:
              </label>
              <select
                id="role-view-select"
                value={effectiveRole}
                onChange={(e) => {
                  const nextRole = e.target.value as EffectiveRoleView;
                  setAdminRoleOverride(nextRole);
                  setShowBlindspots(nextRole === 'MAINTENANCE');
                }}
                className="select h-8 py-0 text-xs font-medium"
              >
                <option value="ADMIN">Quản trị viên</option>
                <option value="LIBRARIAN">Thủ thư & Quản lý khu</option>
                <option value="MAINTENANCE">Kỹ thuật bảo trì</option>
                <option value="USER">Độc giả / Sinh viên</option>
              </select>
            </div>
          )}
        </div>
      </div>

      {/* Compact 7-Layer Metric Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200/80 bg-white px-3 py-2">
        <span className="text-xs font-medium text-slate-500">Lớp hiển thị</span>
        <div
          className="flex flex-wrap items-center gap-1"
          role="group"
          aria-label="Chọn lớp chỉ số"
        >
          {LAYER_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              type="button"
              onClick={() => setSelectedLayer(opt.key)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                selectedLayer === opt.key
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              {opt.shortLabel}
            </button>
          ))}
        </div>
      </div>

      {/* Collapsible Role-Specific Operational Panel (Default collapsed so map stays front & center) */}
      {isStudentView ? (
        <CollapsibleSection
          title="Gợi ý chỗ ngồi học tối ưu"
          summary={
            studyRecommendations[0]
              ? `Đề xuất #1: ${studyRecommendations[0].bay.nameVi} (${studyRecommendations[0].room.code} · ${studyRecommendations[0].bay.metrics.comfortScore}đ)`
              : 'Chọn nhu cầu học tập để định vị dãy bàn'
          }
          badge={
            <span className="badge-neutral">
              {studyRecommendations.length} đề xuất
            </span>
          }
          defaultOpen={false}
        >
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-1.5">
              {(
                [
                  {
                    key: 'quiet',
                    label: 'Yên tĩnh (< 42 dBA)',
                    layer: 'noiseAvg' as HeatmapLayerMetric,
                  },
                  {
                    key: 'group',
                    label: 'Thảo luận nhóm (Tầng 5)',
                    layer: 'comfortScore' as HeatmapLayerMetric,
                  },
                  {
                    key: 'bright_cool',
                    label: 'Đủ sáng & Mát mẻ',
                    layer: 'lux' as HeatmapLayerMetric,
                  },
                  {
                    key: 'multimedia',
                    label: 'Multimedia / PC',
                    layer: 'comfortScore' as HeatmapLayerMetric,
                  },
                ] as const
              ).map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => {
                    setStudyFilter(item.key);
                    setSelectedLayer(item.layer);
                    if (item.key === 'group' && selectedFloor !== 5) {
                      setSelectedFloor(5);
                      setZoomedRoomId(null);
                    }
                  }}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                    studyFilter === item.key
                      ? 'bg-slate-900 text-white'
                      : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
              {studyRecommendations.map((rec, idx) => {
                const isChosen =
                  selectedRoomId === rec.room.id &&
                  selectedBayId === rec.bay.bayId;
                return (
                  <button
                    key={rec.bay.bayId}
                    type="button"
                    onClick={() => {
                      setSelectedRoomId(rec.room.id);
                      setSelectedBayId(rec.bay.bayId);
                      setZoomedRoomId(rec.room.id);
                    }}
                    className={`flex flex-col justify-between rounded-lg border p-3 text-left transition-colors ${
                      isChosen
                        ? 'border-slate-900 bg-slate-50'
                        : 'border-slate-200 bg-white hover:border-slate-300'
                    }`}
                  >
                    <div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-2xs font-medium text-slate-500">
                          #{idx + 1} · {rec.room.code}
                        </span>
                        <span className="font-mono text-xs font-semibold text-slate-900">
                          {rec.bay.metrics.comfortScore}đ
                        </span>
                      </div>
                      <h3 className="mt-1 truncate text-xs font-semibold text-slate-900">
                        {rec.bay.nameVi}
                      </h3>
                      <p className="mt-0.5 truncate text-2xs text-slate-500">
                        {rec.reasonVi}
                      </p>
                    </div>
                    <div className="mt-2 flex items-center justify-between border-t border-slate-100 pt-1.5 text-2xs text-slate-500">
                      <span>{rec.bay.seatCapacity} chỗ</span>
                      <span className="inline-flex items-center gap-0.5 font-medium text-slate-700">
                        <span>Định vị</span>
                        <ArrowUpRight className="h-3 w-3" />
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </CollapsibleSection>
      ) : isMaintenanceView ? (
        <CollapsibleSection
          title="Chẩn đoán kỹ thuật & Hạ tầng"
          summary={`${maintenanceDiagnostics.onlineCount}/${maintenanceDiagnostics.totalDevices} trạm trực tuyến · ${maintenanceDiagnostics.hvacImbalanceRooms.length} lệch nhiệt · ${maintenanceDiagnostics.blindspotRooms.length} vùng mù`}
          actions={
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setShowBlindspots((v) => !v)}
                className={`rounded-md border px-2 py-1 text-2xs font-medium transition-colors ${
                  showBlindspots
                    ? 'border-slate-900 bg-slate-900 text-white'
                    : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                Vùng mù: {showBlindspots ? 'Bật' : 'Tắt'}
              </button>
              <button
                type="button"
                onClick={() => setSelectedLayer('wifiRssi')}
                className="rounded-md border border-slate-200 bg-white px-2 py-1 text-2xs font-medium text-slate-600 hover:bg-slate-50"
              >
                Lớp Wi-Fi
              </button>
            </div>
          }
          defaultOpen={false}
        >
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border border-slate-200 bg-slate-50/50 p-3">
              <span className="text-2xs text-slate-500">Trạm ESP32</span>
              <p className="mt-0.5 text-sm font-semibold text-slate-900">
                {maintenanceDiagnostics.onlineCount} /{' '}
                {maintenanceDiagnostics.totalDevices} trực tuyến
              </p>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50/50 p-3">
              <span className="text-2xs text-slate-500">Lệch nhiệt (ΔT)</span>
              <p className="mt-0.5 text-sm font-semibold text-slate-900">
                {maintenanceDiagnostics.hvacImbalanceRooms.length} phòng
              </p>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50/50 p-3">
              <span className="text-2xs text-slate-500">Vùng mù cảm biến</span>
              <p className="mt-0.5 text-sm font-semibold text-slate-900">
                {maintenanceDiagnostics.blindspotRooms.length} phòng cần bổ sung
              </p>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50/50 p-3">
              <span className="text-2xs text-slate-500">Tín hiệu Wi-Fi</span>
              <p className="mt-0.5 text-sm font-semibold text-slate-900">
                {maintenanceDiagnostics.weakWifiRooms.length === 0
                  ? 'Ổn định (> -70 dBm)'
                  : `${maintenanceDiagnostics.weakWifiRooms.length} vùng sóng yếu`}
              </p>
            </div>
          </div>
        </CollapsibleSection>
      ) : (
        <CollapsibleSection
          title="Điều phối vận hành tầng"
          summary={
            librarianAdvisories.length > 0
              ? `${librarianAdvisories.length} khuyến nghị môi trường cần kiểm tra`
              : 'Mọi không gian trên tầng đang trong ngưỡng tiêu chuẩn'
          }
          badge={
            activeAlerts.length > 0 ? (
              <span className="badge-danger">
                {activeAlerts.length} cảnh báo
              </span>
            ) : (
              <span className="badge-neutral">Ổn định</span>
            )
          }
          actions={
            <button
              type="button"
              onClick={() => setOnlyAssignedZones((v) => !v)}
              className={`rounded-md border px-2 py-1 text-2xs font-medium transition-colors ${
                onlyAssignedZones
                  ? 'border-slate-900 bg-slate-900 text-white'
                  : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              Phân khu phụ trách ({assignedZones.join(', ')})
            </button>
          }
          defaultOpen={false}
        >
          {librarianAdvisories.length === 0 ? (
            <p className="text-xs text-slate-500">
              Tất cả kho sách, phòng đọc và sảnh lưu thông trên tầng đang duy trì chỉ số trong ngưỡng tiêu chuẩn.
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
              {librarianAdvisories.slice(0, 3).map((item) => {
                const isSelected = selectedRoomId === item.roomId;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setSelectedRoomId(item.roomId);
                      setZoomedRoomId(item.roomId);
                      setSelectedLayer(item.targetLayer);
                    }}
                    className={`flex flex-col justify-between rounded-lg border p-3 text-left transition-colors ${
                      isSelected
                        ? 'border-slate-900 bg-slate-50'
                        : 'border-slate-200 bg-white hover:border-slate-300'
                    }`}
                  >
                    <div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-xs font-semibold text-slate-900">
                          {item.roomCode} · {item.badgeText}
                        </span>
                        <span className="font-mono text-2xs font-semibold text-slate-700">
                          {item.valueText}
                        </span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-2xs text-slate-500">
                        {item.recommendation}
                      </p>
                    </div>
                    <div className="mt-2 flex items-center justify-between border-t border-slate-100 pt-1.5 text-2xs text-slate-500">
                      <span>{item.roomName}</span>
                      <span className="inline-flex items-center gap-0.5 font-medium text-slate-700">
                        <span>Định vị</span>
                        <ArrowUpRight className="h-3 w-3" />
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </CollapsibleSection>
      )}

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
        <Skeleton className="h-[540px] w-full" />
      ) : visibleFloorRooms.length === 0 ? (
        <EmptyState
          title={UI_TEXT_VI.emptyRoomsFloor}
          description="Tầng này chưa có phòng đọc nào thuộc phân khu đang lọc."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
          {/* Main Canvas Area */}
          <div
            className={
              selectedRoom
                ? 'space-y-2.5 xl:col-span-8'
                : 'space-y-2.5 xl:col-span-12'
            }
          >
            <div className="card overflow-hidden">
              <FloorplanCanvas
                rooms={visibleFloorRooms}
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
                zoomedRoomId={zoomedRoomId}
                onZoomRoomChange={setZoomedRoomId}
                selectedBayId={selectedBayId}
                onSelectBay={(bay, room) => {
                  setSelectedRoomId(room.id);
                  setSelectedBayId(bay.bayId);
                }}
                showBlindspots={showBlindspots}
                showTechOverlay={isMaintenanceView}
                defaultLabelDensity={
                  isMaintenanceView ? 'detailed' : 'balanced'
                }
                highlightedZoneIds={
                  onlyAssignedZones ? assignedZones : undefined
                }
                firingRoomIds={activeAlerts
                  .filter((a) => a.status === 'FIRING')
                  .map((a) => a.roomId)
                  .filter((id): id is string => Boolean(id))}
              />
            </div>

            {/* Compact Color Scale Legend */}
            <div className="card flex flex-wrap items-center gap-3 px-3.5 py-2 text-xs">
              <span className="shrink-0 font-medium text-slate-700">
                {LAYER_OPTIONS.find((l) => l.key === selectedLayer)?.shortLabel}{' '}
                ({LAYER_OPTIONS.find((l) => l.key === selectedLayer)?.unitLabel})
              </span>
              <div className="min-w-[200px] flex-1">
                <div
                  className="h-2.5 w-full rounded-full border border-slate-200"
                  style={{
                    background: getPaletteCssGradient(selectedLayer),
                  }}
                  aria-hidden="true"
                />
                <div className="mt-1 flex justify-between font-mono text-[10px] text-slate-500">
                  {WEATHER_PALETTES[selectedLayer]?.map((stop, idx) => (
                    <span key={idx}>{stop.label}</span>
                  ))}
                </div>
              </div>
            </div>

            {/* Unconfigured Rooms Callout (Collapsed by default) */}
            {unconfiguredRooms.length > 0 && !isStudentView && (
              <CollapsibleSection
                title="Phòng chưa lưu đa giác tùy chỉnh"
                summary="Đang áp dụng đa giác CAD mặc định"
                badge={
                  <span className="badge-warning">
                    {unconfiguredRooms.length}
                  </span>
                }
                compact
                defaultOpen={false}
              >
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {unconfiguredRooms.map((room) => (
                    <div
                      key={room.id}
                      className="flex items-center justify-between gap-2 rounded-md border border-slate-200 bg-slate-50/50 p-2 text-xs"
                    >
                      <span className="truncate font-medium text-slate-800">
                        {room.code} — {room.name}
                      </span>
                      {capabilities.canManageRooms && (
                        <Link
                          href={`/admin/rooms/${room.id}/polygon`}
                          className="btn-secondary btn-sm h-6 px-2 text-2xs"
                        >
                          Sửa CAD
                        </Link>
                      )}
                    </div>
                  ))}
                </div>
              </CollapsibleSection>
            )}
          </div>

          {/* Streamlined Right Inspector Panel */}
          {selectedRoom && (
            <aside
              aria-label={`Chi tiết phòng ${selectedRoom.name}`}
              className="card space-y-3.5 p-4 xl:col-span-4"
            >
              <div className="flex items-start justify-between gap-2 border-b border-slate-100 pb-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5 text-2xs text-slate-500">
                    <span className="font-mono font-semibold text-slate-700">
                      {selectedRoom.code}
                    </span>
                    {(selectedRoom.id.startsWith('PRESET_') ||
                      selectedRoomTelemetry?.isSynthetic) && (
                      <span
                        className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 font-sans text-[10px] font-semibold text-amber-800"
                        title="Dữ liệu mô phỏng kiến trúc khi chưa gắn cảm biến thật"
                      >
                        Mô phỏng
                      </span>
                    )}
                    {isTelemetryStale(
                      selectedRoomTelemetry?.timestamp,
                      Date.now(),
                      selectedRoomTelemetry?.isSynthetic ||
                        selectedRoom.id.startsWith('PRESET_')
                    ) && (
                      <span
                        className="rounded border border-slate-300 bg-slate-100 px-1.5 py-0.5 font-sans text-[10px] font-medium text-slate-600"
                        title="Dữ liệu đo đã quá 5 phút chưa cập nhật mới"
                      >
                        Dữ liệu cũ
                      </span>
                    )}
                    <span>·</span>
                    <span>Tầng {selectedRoom.floor}</span>
                    {selectedRoomPreset && (
                      <>
                        <span>·</span>
                        <span>{selectedRoomPreset.areaM2} m²</span>
                      </>
                    )}
                    <span>·</span>
                    <span>
                      {selectedRoom.capacity ??
                        selectedRoomPreset?.capacity ??
                        60}{' '}
                      chỗ
                    </span>
                  </div>
                  <h2 className="mt-0.5 truncate text-sm font-semibold text-slate-900">
                    {selectedRoom.name}
                  </h2>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() =>
                      setZoomedRoomId(
                        zoomedRoomId === selectedRoom.id
                          ? null
                          : selectedRoom.id
                      )
                    }
                    className="btn-secondary btn-sm h-7 px-2 text-2xs"
                  >
                    {zoomedRoomId === selectedRoom.id ? 'Thu nhỏ' : 'Phóng to'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedRoomId(null);
                      setZoomedRoomId(null);
                      setFocusedDeviceId(null);
                    }}
                    aria-label="Đóng bảng chi tiết"
                    className="btn-icon h-7 w-7"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {/* Comfort Score Header */}
              <div className="flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2">
                <GradeBadge
                  grade={selectedRoomTelemetry?.comfortScore?.grade}
                  score={selectedRoomTelemetry?.comfortScore?.overall}
                />
                <div className="flex items-baseline gap-0.5">
                  <span className="text-lg font-semibold tabular-nums text-slate-900">
                    {formatMetrics.comfortScore(
                      selectedRoomTelemetry?.comfortScore?.overall
                    )}
                  </span>
                  <span className="text-2xs text-slate-400">/100</span>
                </div>
              </div>

              {/* Compact 6 Metrics Grid */}
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div className="rounded-lg border border-slate-100 bg-slate-50/40 p-2">
                  <span className="block text-2xs text-slate-500">Độ ồn</span>
                  <span className="mt-0.5 block font-semibold tabular text-slate-800">
                    {formatMetrics.noise(
                      selectedRoomTelemetry?.acoustics?.noiseAvg
                    )}
                  </span>
                </div>
                <div className="rounded-lg border border-slate-100 bg-slate-50/40 p-2">
                  <span className="block text-2xs text-slate-500">Nhiệt độ</span>
                  <span className="mt-0.5 block font-semibold tabular text-slate-800">
                    {formatMetrics.temperature(
                      selectedRoomTelemetry?.environment?.temperature
                    )}
                  </span>
                </div>
                <div className="rounded-lg border border-slate-100 bg-slate-50/40 p-2">
                  <span className="block text-2xs text-slate-500">Độ ẩm</span>
                  <span className="mt-0.5 block font-semibold tabular text-slate-800">
                    {formatMetrics.humidity(
                      selectedRoomTelemetry?.environment?.humidity
                    )}
                  </span>
                </div>
                <div className="rounded-lg border border-slate-100 bg-slate-50/40 p-2">
                  <span className="block text-2xs text-slate-500">
                    Ánh sáng
                  </span>
                  <span className="mt-0.5 block font-semibold tabular text-slate-800">
                    {formatMetrics.lux(selectedRoomTelemetry?.environment?.lux)}
                  </span>
                </div>
                <div className="rounded-lg border border-slate-100 bg-slate-50/40 p-2">
                  <span className="block text-2xs text-slate-500">PM2.5</span>
                  <span className="mt-0.5 block font-semibold tabular text-slate-800">
                    {formatMetrics.pm(
                      selectedRoomTelemetry?.airQuality?.pm2_5
                    )}
                  </span>
                </div>
                <div className="rounded-lg border border-slate-100 bg-slate-50/40 p-2">
                  <span className="block text-2xs text-slate-500">Wi-Fi</span>
                  <span className="mt-0.5 block font-semibold tabular text-slate-800">
                    {formatMetrics.rssi(selectedRoomTelemetry?.wifiRssi)}
                  </span>
                </div>
              </div>

              {/* Active Room Alerts (only when present) */}
              {!isStudentView && selectedRoomAlerts.length > 0 && (
                <div className="space-y-2 rounded-lg border border-rose-200 bg-rose-50/50 p-2.5">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-rose-900">
                    <ShieldAlert className="h-3.5 w-3.5 text-rose-600" />
                    <span>Cảnh báo ({selectedRoomAlerts.length})</span>
                  </div>
                  {selectedRoomAlerts.map((alert) => (
                    <div
                      key={alert.id}
                      className="rounded border border-rose-200 bg-white p-2 text-xs"
                    >
                      <div className="flex items-center justify-between gap-2 font-mono text-2xs">
                        <span className="font-semibold text-rose-700">
                          {alert.type}
                        </span>
                        <span className="text-slate-400">
                          {alert.hardwareId}
                        </span>
                      </div>
                      <p className="mt-0.5 text-2xs text-slate-600">
                        {alert.message}
                      </p>
                      {alert.recommendedAction && (
                        <p className="mt-1 rounded bg-amber-50 px-1.5 py-1 text-[10px] font-medium text-amber-900">
                          SOP: {alert.recommendedAction}
                        </p>
                      )}
                      <div className="mt-1.5 flex items-center gap-1.5">
                        {alert.status === 'FIRING' &&
                          capabilities.canAcknowledgeAlert && (
                            <button
                              type="button"
                              disabled={ackAlertMutation.isPending}
                              onClick={() => ackAlertMutation.mutate(alert.id)}
                              className="rounded bg-slate-900 px-2 py-0.5 text-2xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                            >
                              Tiếp nhận
                            </button>
                          )}
                        {(alert.status === 'FIRING' ||
                          alert.status === 'ACKNOWLEDGED') &&
                          capabilities.canResolveAlert && (
                            <button
                              type="button"
                              disabled={resolveAlertMutation.isPending}
                              onClick={() =>
                                resolveAlertMutation.mutate(alert.id)
                              }
                              className="rounded border border-slate-200 bg-white px-2 py-0.5 text-2xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                            >
                              Đóng sự cố
                            </button>
                          )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Collapsible 1: Reading Bays Breakdown (Default collapsed) */}
              {selectedRoomMicroZones.length > 0 && (
                <CollapsibleSection
                  title="Phân khu bàn đọc"
                  badge={
                    <span className="badge-neutral">
                      {selectedRoomMicroZones.length} dãy
                    </span>
                  }
                  compact
                  defaultOpen={false}
                >
                  <div className="space-y-1.5">
                    {selectedRoomMicroZones.map((bay) => {
                      const isBayActive = bay.bayId === selectedBayId;
                      return (
                        <button
                          key={bay.bayId}
                          type="button"
                          onClick={() => {
                            setSelectedBayId(bay.bayId);
                            setZoomedRoomId(selectedRoom.id);
                          }}
                          className={`w-full rounded-md border p-2 text-left text-xs transition-colors ${
                            isBayActive
                              ? 'border-slate-900 bg-slate-50'
                              : 'border-slate-100 bg-slate-50/40 hover:bg-slate-100/60'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate font-medium text-slate-900">
                              {bay.nameVi}
                            </span>
                            <span className="font-mono text-2xs font-semibold text-slate-700">
                              {formatLayerMetricValue(
                                bay.metrics[selectedLayer],
                                selectedLayer
                              )}
                            </span>
                          </div>
                          <div className="mt-1 flex items-center gap-2 font-mono text-2xs text-slate-500">
                            <span>{bay.seatCapacity} chỗ</span>
                            <span>·</span>
                            <span>{bay.metrics.temperature}°C</span>
                            <span>·</span>
                            <span>{bay.metrics.noiseAvg} dBA</span>
                            <span>·</span>
                            <span>{bay.metrics.lux} lx</span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </CollapsibleSection>
              )}

              {/* Collapsible 2: Hardware Devices (Default collapsed, strict FE-VIZ-09) */}
              {!isStudentView && capabilities.canViewDevices && (
                <CollapsibleSection
                  title="Thiết bị cảm biến"
                  badge={
                    <span className="badge-neutral">
                      {selectedRoomDevices.length} trạm
                    </span>
                  }
                  compact
                  defaultOpen={false}
                >
                  {selectedRoomDevices.length === 0 ? (
                    <p className="text-2xs text-slate-400">
                      Chưa gắn trạm đo vật lý.
                    </p>
                  ) : (
                    <div className="max-h-44 space-y-1.5 overflow-y-auto pr-1">
                      {selectedRoomDevices.map((d) => {
                        const devTel = deviceTelemetryMap[d.id];
                        const devVal = extractLayerMetricValue(
                          devTel,
                          selectedLayer
                        );
                        return (
                          <div
                            key={d.id}
                            onClick={() => setFocusedDeviceId(d.id)}
                            className={`flex cursor-pointer items-center justify-between rounded-md border p-2 text-xs transition-colors ${
                              focusedDeviceId === d.id
                                ? 'border-slate-900 bg-slate-50'
                                : 'border-slate-100 bg-slate-50/40 hover:bg-slate-100/60'
                            }`}
                          >
                            <div className="min-w-0 pr-2">
                              <p className="truncate font-medium text-slate-800">
                                {d.name}
                              </p>
                              <p className="font-mono text-2xs text-slate-400">
                                {d.hardwareId}
                              </p>
                            </div>
                            <div className="flex shrink-0 flex-col items-end gap-1">
                              <ConnectionBadge online={d.online} />
                              {devVal !== null && (
                                <span className="font-mono text-2xs font-semibold tabular text-slate-700">
                                  {formatLayerMetricValue(
                                    devVal,
                                    selectedLayer
                                  )}
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </CollapsibleSection>
              )}

              {/* Action Buttons */}
              {!selectedRoom.id.startsWith('PRESET_') && (
                <div className="flex items-center gap-2 border-t border-slate-100 pt-3">
                  <Link
                    href={`/rooms/${selectedRoom.id}`}
                    className="btn-primary btn-sm flex-1 text-center"
                  >
                    <span>Chi tiết phòng</span>
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Link>

                  {capabilities.canManageRooms && !isStudentView && (
                    <Link
                      href={`/admin/rooms/${selectedRoom.id}/polygon`}
                      className="btn-secondary btn-sm text-center"
                    >
                      <span>Mặt bằng CAD</span>
                    </Link>
                  )}
                </div>
              )}
            </aside>
          )}
        </div>
      )}

      {/* Collapsible Data Table for Screen Readers & Detailed Audit (FE-A11Y-05) */}
      <CollapsibleSection
        title={`Bảng dữ liệu Tầng ${selectedFloor}`}
        badge={
          <span className="badge-neutral">
            {visibleFloorRooms.length} phòng
          </span>
        }
        defaultOpen={false}
      >
        <div className="table-wrap -mx-4 -my-3.5">
          <table className="data-table">
            <thead>
              <tr>
                <th>Phòng</th>
                <th>Diện tích</th>
                <th>
                  {
                    LAYER_OPTIONS.find((l) => l.key === selectedLayer)
                      ?.shortLabel
                  }
                </th>
                <th>Độ ồn</th>
                <th>Nhiệt độ</th>
                <th>Độ ẩm</th>
                <th>Ánh sáng</th>
                <th>Hạng</th>
                <th className="text-right">Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {visibleFloorRooms.map((room, idx) => {
                const tel = roomTelemetryMap[room.id];
                const preset = resolveRoomPreset(room, idx);
                const layerVal = extractLayerMetricValue(tel, selectedLayer);

                return (
                  <tr key={room.id}>
                    <td>
                      <div className="flex items-center gap-1.5 font-medium text-slate-900">
                        <span>{room.name}</span>
                        {(room.id.startsWith('PRESET_') || tel?.isSynthetic) && (
                          <span className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                            Mô phỏng
                          </span>
                        )}
                      </div>
                      <div className="font-mono text-2xs text-slate-400">
                        {room.code}
                      </div>
                    </td>
                    <td className="font-mono text-xs tabular">
                      {preset ? `${preset.areaM2} m²` : '—'}
                    </td>
                    <td className="font-medium tabular text-slate-800">
                      {formatLayerMetricValue(layerVal, selectedLayer)}
                    </td>
                    <td className="tabular text-xs">
                      {formatMetrics.noise(tel?.acoustics?.noiseAvg)}
                    </td>
                    <td className="tabular text-xs">
                      {formatMetrics.temperature(
                        tel?.environment?.temperature
                      )}
                    </td>
                    <td className="tabular text-xs">
                      {formatMetrics.humidity(tel?.environment?.humidity)}
                    </td>
                    <td className="tabular text-xs">
                      {formatMetrics.lux(tel?.environment?.lux)}
                    </td>
                    <td>
                      <GradeBadge
                        grade={tel?.comfortScore?.grade}
                        score={tel?.comfortScore?.overall}
                      />
                    </td>
                    <td className="text-right">
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedRoomId(room.id);
                          setZoomedRoomId(room.id);
                        }}
                        className="btn-secondary btn-sm"
                      >
                        Định vị
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CollapsibleSection>
    </div>
  );
}
