'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import {
  ArrowUpRight,
  ChevronRight,
  MapPin,
  X,
} from 'lucide-react';
import {
  TQB_ROOM_PRESETS,
  buildPresetFallbackTelemetry,
  getFloorRoomPresets,
  resolveRoomPolygon,
  resolveRoomPreset,
  synthesizeAnonymousMicroZones,
  type AnonymousMicroZone,
} from '@/config/tqb-floorplan-presets';
import {
  DEFAULT_FLOORPLAN_CONFIG,
  TIMING_CONFIG,
  isAlertOpen,
  isAlertOverdue,
  resolveRoomHealthMatchesFilter,
  type ManagerStatusFilter,
} from '@/config/floorplan-hmi.config';
import { type HeatmapLayerMetric } from '@/config/thresholds';
import { FLOORPLAN_I18N_VI, UI_TEXT_VI } from '@/messages/vi';
import { formatMetrics } from '@/lib/format/metrics';
import { isTelemetryStale } from '@/lib/format/datetime';
import {
  stompManager,
  upsertRealtimeAlertList,
} from '@/lib/realtime/stomp-client';
import {
  isAlertInUserZones,
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
  useAlertsQuery,
  useUpdateAlertWorkflowMutation,
} from '@/features/alerts/queries';
import { resolveAlertFloorplanTarget } from '@/features/alerts/navigation';
import { useAuthStore } from '@/features/auth/store';
import { roomsApi } from '@/features/rooms/api';
import {
  roomKeys,
  useRoomsQuery,
  useUpdateRoomFurnitureMutation,
} from '@/features/rooms/queries';
import { useDevicesQuery } from '@/features/devices/queries';
import { telemetryKeys } from '@/features/telemetry/queries';
import { telemetryApi } from '@/features/telemetry/api';
import {
  FloorplanCanvas,
  extractLayerMetricValue,
  formatLayerMetricValue,
} from '@/features/floorplan/components/FloorplanCanvas';
import {
  AlertInspectorDrawer,
  MapAlertQueuePanel,
} from '@/features/floorplan/components/AlertInspectorDrawer';
import { FloorRoomTree } from '@/features/floorplan/components/FloorRoomTree';
import { FloorplanLegend } from '@/features/floorplan/components/FloorplanLegend';
import { FurnitureLayerEditor } from '@/features/floorplan/components/FurnitureLayerEditor';
import {
  ManagerSummaryStrip,
  computeBuildingSummaryMetrics,
} from '@/features/floorplan/components/ManagerSummaryStrip';
import { TimeComparisonBar } from '@/features/floorplan/components/TimeComparisonBar';
import {
  FURNITURE_CATALOG,
  filterVisibleFurnitureItems,
} from '@/config/furniture-catalog';
import { formatRealtimeAlertAnnouncementVi } from '@/lib/floorplan/alertWorkflow';
import type { ViewportTransform } from '@/lib/floorplan/coords';
import {
  buildFloorplanShareUrl,
  parseFloorplanUrlState,
  serializeFloorplanUrlState,
} from '@/lib/floorplan/deepLink';
import {
  exportFloorplanReportPdf,
  exportFloorplanReportPng,
} from '@/lib/floorplan/exportReport';
import { buildBuildingFloorTree } from '@/lib/floorplan/floorTreeBuilder';
import {
  createFurnitureHistory,
  pushFurnitureHistory,
  redoFurnitureHistory,
  undoFurnitureHistory,
  validateFurnitureLayout,
  type FurnitureHistoryState,
} from '@/lib/floorplan/furnitureGeometry';
import { computeVisualPolygonCenter } from '@/lib/floorplan/polygon';
import {
  evaluateRoomReliability,
  type RoomReliabilitySummary,
} from '@/lib/floorplan/reliability';
import {
  buildEventPlaybackFrames,
  computeOneHourDelta,
  computeTypicalDayFloorSnapshot,
  type FloorplanTimeMode,
  type OneHourDeltaResult,
} from '@/lib/floorplan/timeAnalysis';
import { computeRoomBlindspotRatio } from '@/lib/floorplan/weatherPalette';
import { ApiError } from '@/lib/http/error-mapper';
import type {
  AlertResponse,
  AlertSeverity,
  AlertWorkflowUpdateRequest,
  BucketDataPoint,
  DeviceResponse,
  FurnitureItem,
  RoleName,
  RoomFurnitureResponse,
  RoomResponse,
  TelemetryResponse,
} from '@/types/api';

const DEFAULT_FLOOR_OPTIONS = [1, 2, 3, 4, 5];

const SEVERITY_RANK: Record<AlertSeverity, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
};

const LAYER_OPTIONS: Array<{
  key: HeatmapLayerMetric;
  label: string;
  shortLabel: string;
  unitLabel: string;
}> = [
  {
    key: 'comfortScore',
    label: 'Điểm tiện nghi (LCS)',
    shortLabel: 'Điểm tiện nghi (LCS)',
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
  const [selectedFloor, setSelectedFloor] = useState<number>(
    DEFAULT_FLOORPLAN_CONFIG.defaultFloor
  );
  const [selectedLayer, setSelectedLayer] = useState<HeatmapLayerMetric>(
    DEFAULT_FLOORPLAN_CONFIG.defaultLayer
  );
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [zoomedRoomId, setZoomedRoomId] = useState<string | null>(null);
  const [focusedDeviceId, setFocusedDeviceId] = useState<string | null>(null);
  const [selectedBayId, setSelectedBayId] = useState<string | null>(null);
  const [studyFilter, setStudyFilter] = useState<StudyFilterMode>('quiet');
  const [statusFilter, setStatusFilter] = useState<ManagerStatusFilter>('ALL');
  const [onlyExceedingThreshold, setOnlyExceedingThreshold] =
    useState<boolean>(false);
  const [telemetryHistoryState, setTelemetryHistoryState] = useState<
    Record<string, number[]>
  >({});
  const lastHistorySigRef = useRef<Map<string, string>>(new Map());
  const [showBlindspots, setShowBlindspots] = useState<boolean>(false);
  const [showReliabilityLayer, setShowReliabilityLayer] =
    useState<boolean>(false);
  const [onlyAssignedZones, setOnlyAssignedZones] = useState<boolean>(false);
  const [includeTqbArchitecturePresets, setIncludeTqbArchitecturePresets] =
    useState<boolean>(true);
  const [adminRoleOverride, setAdminRoleOverride] =
    useState<EffectiveRoleView | null>(null);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [isTreeCollapsed, setIsTreeCollapsed] = useState<boolean>(false);
  const [timeMode, setTimeMode] = useState<FloorplanTimeMode>('live');
  const [typicalHour, setTypicalHour] = useState<number>(15);
  const [playbackIndex, setPlaybackIndex] = useState<number>(0);
  const [isPlaybackPlaying, setIsPlaybackPlaying] = useState<boolean>(false);
  const [viewportState, setViewportState] = useState<ViewportTransform>({
    scale: 1,
    tx: 0,
    ty: 0,
  });
  const [restoredInitialViewport, setRestoredInitialViewport] =
    useState<ViewportTransform | null>(null);
  const [deepLinkCopied, setDeepLinkCopied] = useState<boolean>(false);
  const lastWrittenSearchRef = useRef<string | null>(null);
  const initialUrlHydratedRef = useRef<boolean>(false);
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [liveAlertAnnouncement, setLiveAlertAnnouncement] =
    useState<string>('');
  const [maxViewportHeightPx, setMaxViewportHeightPx] = useState<
    number | undefined
  >(undefined);
  const workspaceFullscreenRef = useRef<HTMLDivElement>(null);
  const [showFurnitureLayer, setShowFurnitureLayer] = useState<boolean>(true);
  const [furnitureOpacity, setFurnitureOpacity] = useState<number>(0.65);
  const [furnitureEditMode, setFurnitureEditMode] = useState<boolean>(false);
  const [snapFurnitureGrid, setSnapFurnitureGrid] = useState<boolean>(true);
  const [selectedFurnitureIds, setSelectedFurnitureIds] = useState<string[]>(
    []
  );
  const [furnitureHistoryByRoom, setFurnitureHistoryByRoom] = useState<
    Record<string, FurnitureHistoryState<FurnitureItem[]>>
  >({});
  const [furnitureDraftByRoom, setFurnitureDraftByRoom] = useState<
    Record<string, FurnitureItem[]>
  >({});
  const [furnitureConflictRoomId, setFurnitureConflictRoomId] = useState<
    string | null
  >(null);
  const [furnitureErrorMsg, setFurnitureErrorMsg] = useState<string | null>(
    null
  );

  const queryClient = useQueryClient();
  const capabilities = useAuthStore((s) => s.capabilities);
  const currentUser = useAuthStore((s) => s.user);
  const stompConnected = useStompConnectionState();

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => {
      clearInterval(id);
      if (copyFeedbackTimerRef.current) {
        clearTimeout(copyFeedbackTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFsChange);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const updateMaxH = () => {
      const vh = window.innerHeight;
      if (!vh || vh <= 0) return;
      setMaxViewportHeightPx(
        Math.max(360, vh - (isFullscreen ? 125 : 275))
      );
    };
    updateMaxH();
    window.addEventListener('resize', updateMaxH);
    return () => {
      window.removeEventListener('resize', updateMaxH);
    };
  }, [isFullscreen]);

  const handleToggleFullscreen = useCallback(async () => {
    try {
      if (typeof document === 'undefined') return;
      if (document.fullscreenElement) {
        await document.exitFullscreen?.();
        setIsFullscreen(false);
      } else if (workspaceFullscreenRef.current?.requestFullscreen) {
        await workspaceFullscreenRef.current.requestFullscreen();
        setIsFullscreen(true);
      }
    } catch {
      // Ignore fullscreen denial in restricted environments
    }
  }, []);

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
  const canEditFurnitureInCurrentView =
    capabilities.canEditFurniture && !isStudentView;
  const hideSensitiveFurniture =
    isStudentView || !capabilities.canViewDevices;

  useEffect(() => {
    if (!canEditFurnitureInCurrentView && furnitureEditMode) {
      setFurnitureEditMode(false);
      setSelectedFurnitureIds([]);
    }
  }, [canEditFurnitureInCurrentView, furnitureEditMode]);

  useEffect(() => {
    setSelectedFurnitureIds([]);
    setFurnitureConflictRoomId(null);
    setFurnitureErrorMsg(null);
  }, [selectedRoomId]);

  const roomsQuery = useRoomsQuery({
    page: 0,
    size: 50,
    floor: selectedFloor,
  });

  // Truy vấn danh sách toàn bộ phòng để dựng tổng quan 33 phòng & phân giải deep-link
  const allRoomsQuery = useRoomsQuery({
    page: 0,
    size: 100,
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
  const updateAlertWorkflowMutation = useUpdateAlertWorkflowMutation();
  const updateFurnitureMutation = useUpdateRoomFurnitureMutation();

  const allBackendRooms = useMemo(
    () => allRoomsQuery.data?.content ?? [],
    [allRoomsQuery.data]
  );

  const backendFloorRooms = useMemo(
    () => roomsQuery.data?.content ?? [],
    [roomsQuery.data]
  );

  const mergedBackendAllRooms = useMemo(() => {
    const byId = new Map<string, RoomResponse>();
    for (const r of allBackendRooms) {
      byId.set(r.id, r);
    }
    for (const r of backendFloorRooms) {
      byId.set(r.id, r);
    }
    return Array.from(byId.values());
  }, [allBackendRooms, backendFloorRooms]);

  const floorOptions = useMemo(() => {
    const set = new Set<number>(DEFAULT_FLOOR_OPTIONS);
    for (const p of TQB_ROOM_PRESETS) {
      set.add(p.floor);
    }
    for (const r of mergedBackendAllRooms) {
      set.add(r.floor === 0 ? 1 : r.floor);
    }
    return Array.from(set).sort((a, b) => a - b);
  }, [mergedBackendAllRooms]);

  // Hợp nhất phòng từ Backend DB và 33 preset kiến trúc TQB trên toàn bộ các tầng
  const allBuildingRooms: RoomResponse[] = useMemo(() => {
    const combined: RoomResponse[] = [];
    for (const floor of floorOptions) {
      const backendOnFloor = mergedBackendAllRooms.filter(
        (r) => (r.floor === 0 ? 1 : r.floor) === floor
      );
      const enrichedBackend = backendOnFloor.map((r, idx) => {
        const poly = resolveRoomPolygon(r, idx);
        const preset = resolveRoomPreset(r, idx);
        return {
          ...r,
          type: r.type ?? preset?.roomType ?? 'STUDY_ROOM',
          capacity: r.capacity ?? preset?.capacity ?? 60,
          boundaryPolygon: poly ? [...poly] : r.boundaryPolygon,
        };
      });
      combined.push(...enrichedBackend);

      if (includeTqbArchitecturePresets) {
        const matchedPresetCodes = new Set<string>();
        enrichedBackend.forEach((r, idx) => {
          const matched = resolveRoomPreset(r, idx);
          if (matched) matchedPresetCodes.add(matched.code);
        });

        const presetsOnFloor = getFloorRoomPresets(floor);
        const missingPresets: RoomResponse[] = presetsOnFloor
          .filter((p) => !matchedPresetCodes.has(p.code))
          .map((p) => ({
            id: `PRESET_${p.code}`,
            code: p.code,
            name: p.name,
            floor,
            capacity: p.capacity,
            type: p.roomType,
            targetComfortScore: p.roomType === 'BOOK_STORAGE' ? 90 : 85,
            description: `Không gian chuẩn kiến trúc TQB (${p.areaM2} m² · Phân khu ${p.zoneCode})`,
            boundaryPolygon: [...p.boundaryPolygon],
          }));
        combined.push(...missingPresets);
      }
    }
    return combined;
  }, [floorOptions, mergedBackendAllRooms, includeTqbArchitecturePresets]);

  const floorRooms: RoomResponse[] = useMemo(
    () =>
      allBuildingRooms.filter(
        (r) => (r.floor === 0 ? 1 : r.floor) === selectedFloor
      ),
    [allBuildingRooms, selectedFloor]
  );

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

  // Active Backend Alerts (NEW / ACKNOWLEDGED / IN_PROGRESS) across the building
  const activeAlerts = useMemo(() => {
    const all = alertsQuery.data?.content ?? [];
    return all.filter(isAlertOpen);
  }, [alertsQuery.data]);

  const realFloorDevices = useMemo(
    () => allDevices.filter((d) => d.roomId && floorRoomIds.has(d.roomId)),
    [allDevices, floorRoomIds]
  );

  // Đảm bảo mọi node phát sinh cảnh báo trên tầng luôn có chân pin hiển thị trên bản đồ nhiệt
  // ngay cả khi vai trò hiện tại là Thủ thư hoặc node chưa đồng bộ trong danh sách thiết bị
  const floorDevices = useMemo(() => {
    if (isStudentView) return [];
    const list = [...realFloorDevices];
    const seenIds = new Set<string>();
    for (const d of list) {
      seenIds.add(d.id);
      if (d.hardwareId) seenIds.add(d.hardwareId);
    }

    for (const alert of activeAlerts) {
      if (!alert.roomId || !floorRoomIds.has(alert.roomId)) continue;
      const nodeId = alert.deviceId ?? alert.hardwareId;
      const hwId = alert.hardwareId ?? alert.deviceId;
      if (!nodeId || !hwId) continue;
      if (seenIds.has(nodeId) || seenIds.has(hwId)) continue;

      seenIds.add(nodeId);
      seenIds.add(hwId);
      list.push({
        id: nodeId,
        hardwareId: hwId,
        name: `Trạm cảnh báo ${hwId}`,
        roomId: alert.roomId,
        zoneId: 'ZONE_A',
        deviceType: 'ESP32_NODE',
        active: true,
        online: alert.type !== 'DEVICE_OFFLINE',
        connectionState:
          alert.type === 'DEVICE_OFFLINE' ? 'OFFLINE' : 'ONLINE',
        lastSeenAt: null,
        lastOfflineAt: null,
      });
    }
    return list;
  }, [isStudentView, realFloorDevices, activeAlerts, floorRoomIds]);

  const realBuildingRooms = useMemo(
    () => allBuildingRooms.filter((r) => !r.id.startsWith('PRESET_')),
    [allBuildingRooms]
  );

  const realFloorRooms = useMemo(
    () => floorRooms.filter((r) => !r.id.startsWith('PRESET_')),
    [floorRooms]
  );

  const roomLatestQueries = useQueries({
    queries: realBuildingRooms.map((room) => ({
      queryKey: telemetryKeys.roomLatest(room.id),
      queryFn: () => telemetryApi.getRoomLatest(room.id),
      refetchInterval: stompConnected ? (false as const) : 15000,
    })),
  });

  const deviceLatestQueries = useQueries({
    queries: realFloorDevices.map((device) => ({
      queryKey: telemetryKeys.deviceLatest(device.id),
      queryFn: () => telemetryApi.getDeviceLatest(device.id),
      refetchInterval: stompConnected ? (false as const) : 15000,
    })),
  });

  const furnitureRoomQueries = useQueries({
    queries: realFloorRooms.map((room) => ({
      queryKey: roomKeys.furniture(room.id, false),
      queryFn: () => roomsApi.getFurniture(room.id),
      enabled: showFurnitureLayer || furnitureEditMode,
      retry: false,
    })),
  });

  const furnitureQueriesSig = realFloorRooms
    .map((room, idx) => {
      const q = furnitureRoomQueries[idx];
      return `${room.id}:${q?.data?.version ?? 'none'}:${q?.data?.items?.length ?? 0}:${q?.dataUpdatedAt ?? 0}`;
    })
    .join('|');

  const serverFurnitureByRoom = useMemo(() => {
    const map: Record<string, RoomFurnitureResponse | undefined> = {};
    realFloorRooms.forEach((room, idx) => {
      map[room.id] = furnitureRoomQueries[idx]?.data;
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [realFloorRooms, furnitureQueriesSig]);

  const realRoomTelemetrySignature = realBuildingRooms
    .map((room, index) => {
      const q = roomLatestQueries[index];
      const d = q?.data;
      return d
        ? `${room.id}:${q?.dataUpdatedAt ?? 0}:${d.id}:${d.timestamp}:${d.comfortScore?.overall ?? ''}:${d.environment?.temperature ?? ''}:${d.environment?.humidity ?? ''}:${d.acoustics?.noiseAvg ?? ''}:${d.airQuality?.pm2_5 ?? ''}:${d.environment?.lux ?? ''}:${d.wifiRssi ?? ''}`
        : `${room.id}:null`;
    })
    .join('|');

  const buildingTelemetryMap = useMemo(() => {
    const map: Record<string, TelemetryResponse | null | undefined> = {};
    const realMap = new Map<string, TelemetryResponse | null>();
    realBuildingRooms.forEach((room, index) => {
      realMap.set(room.id, roomLatestQueries[index]?.data ?? null);
    });

    const perFloorCounters = new Map<number, number>();
    allBuildingRooms.forEach((room) => {
      const f = room.floor === 0 ? 1 : room.floor;
      const idxOnFloor = perFloorCounters.get(f) ?? 0;
      perFloorCounters.set(f, idxOnFloor + 1);

      const realTel = realMap.get(room.id);
      if (realTel) {
        map[room.id] = realTel;
      } else if (room.id.startsWith('PRESET_')) {
        map[room.id] = buildPresetFallbackTelemetry(room, idxOnFloor);
      } else {
        map[room.id] = null;
      }
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allBuildingRooms, realBuildingRooms, realRoomTelemetrySignature]);

  const roomTelemetryMap = useMemo(() => {
    const map: Record<string, TelemetryResponse | null | undefined> = {};
    floorRooms.forEach((room, idx) => {
      if (buildingTelemetryMap[room.id] !== undefined) {
        map[room.id] = buildingTelemetryMap[room.id];
      } else if (room.id.startsWith('PRESET_')) {
        map[room.id] = buildPresetFallbackTelemetry(room, idx);
      } else {
        map[room.id] = null;
      }
    });
    return map;
  }, [floorRooms, buildingTelemetryMap]);

  useEffect(() => {
    const updates: Array<{ key: string; val: number }> = [];
    for (const room of floorRooms) {
      const tel = roomTelemetryMap[room.id];
      const val = extractLayerMetricValue(tel, selectedLayer);
      if (typeof val !== 'number' || !Number.isFinite(val)) continue;
      const key = `${room.id}:${selectedLayer}`;
      const isSynthetic =
        room.id.startsWith('PRESET_') || Boolean(tel?.isSynthetic);
      const sig = isSynthetic
        ? `SYNTH|${val.toFixed(2)}`
        : `${tel?.timestamp ?? ''}|${val.toFixed(2)}`;
      if (lastHistorySigRef.current.get(key) !== sig) {
        lastHistorySigRef.current.set(key, sig);
        updates.push({ key, val });
      }
    }
    if (updates.length === 0) return;

    setTelemetryHistoryState((prev) => {
      const next = { ...prev };
      for (const { key, val } of updates) {
        const series = next[key] ? [...next[key], val] : [val];
        next[key] = series.slice(-8);
      }
      return next;
    });
  }, [floorRooms, roomTelemetryMap, selectedLayer]);

  const roomTelemetryHistoryMap = useMemo(() => {
    const map: Record<string, readonly number[]> = {};
    for (const room of floorRooms) {
      const key = `${room.id}:${selectedLayer}`;
      const stored = telemetryHistoryState[key];
      const latestVal = extractLayerMetricValue(
        roomTelemetryMap[room.id],
        selectedLayer
      );
      if (stored && stored.length > 0) {
        map[room.id] = stored;
      } else if (typeof latestVal === 'number' && Number.isFinite(latestVal)) {
        map[room.id] = [latestVal];
      }
    }
    return map;
  }, [floorRooms, roomTelemetryMap, selectedLayer, telemetryHistoryState]);

  const buildingSummaryMetrics = useMemo(
    () =>
      computeBuildingSummaryMetrics(
        allBuildingRooms,
        buildingTelemetryMap,
        activeAlerts,
        nowMs,
        TIMING_CONFIG.overdueAlertMs
      ),
    [allBuildingRooms, buildingTelemetryMap, activeAlerts, nowMs]
  );

  const buildingFloorTree = useMemo(
    () =>
      buildBuildingFloorTree(
        allBuildingRooms,
        buildingTelemetryMap,
        isStudentView ? [] : activeAlerts
      ),
    [allBuildingRooms, buildingTelemetryMap, isStudentView, activeAlerts]
  );

  const {
    roomOpenAlertsMap,
    roomAlertCounts,
    roomAlertSeverities,
    overdueRoomIds,
  } = useMemo(() => {
    const grouped: Record<string, AlertResponse[]> = {};
    const counts: Record<string, number> = {};
    const severities: Record<string, AlertSeverity | undefined> = {};
    const overdueIds = new Set<string>();

    for (const alert of activeAlerts) {
      if (!alert.roomId) continue;
      if (!grouped[alert.roomId]) grouped[alert.roomId] = [];
      grouped[alert.roomId].push(alert);
      counts[alert.roomId] = (counts[alert.roomId] ?? 0) + 1;

      if (isAlertOverdue(alert, nowMs, TIMING_CONFIG.overdueAlertMs)) {
        overdueIds.add(alert.roomId);
      }

      const currSev = severities[alert.roomId];
      const nextSev = alert.severity;
      if (
        nextSev &&
        (!currSev || SEVERITY_RANK[nextSev] > SEVERITY_RANK[currSev])
      ) {
        severities[alert.roomId] = nextSev;
      }
    }
    return {
      roomOpenAlertsMap: grouped,
      roomAlertCounts: counts,
      roomAlertSeverities: severities,
      overdueRoomIds: overdueIds,
    };
  }, [activeAlerts, nowMs]);

  const roomMatchesFilterMap = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const room of visibleFloorRooms) {
      map[room.id] = resolveRoomHealthMatchesFilter(
        room,
        roomTelemetryMap[room.id],
        roomOpenAlertsMap[room.id] ?? [],
        statusFilter,
        nowMs,
        TIMING_CONFIG.overdueAlertMs
      );
    }
    return map;
  }, [
    visibleFloorRooms,
    roomTelemetryMap,
    roomOpenAlertsMap,
    statusFilter,
    nowMs,
  ]);

  const realDeviceTelemetrySignature = realFloorDevices
    .map((device, index) => {
      const q = deviceLatestQueries[index];
      const d = q?.data;
      return d
        ? `${device.id}:${q?.dataUpdatedAt ?? 0}:${d.id}:${d.timestamp}`
        : `${device.id}:null`;
    })
    .join('|');

  const deviceTelemetryMap = useMemo(() => {
    const map: Record<string, TelemetryResponse | null | undefined> = {};
    realFloorDevices.forEach((device, index) => {
      map[device.id] = deviceLatestQueries[index]?.data ?? null;
    });
    // Fallback sang dữ liệu đo của phòng cho các trạm chưa có bản ghi telemetry riêng
    floorDevices.forEach((device) => {
      if (!map[device.id] && device.roomId) {
        map[device.id] = roomTelemetryMap[device.roomId] ?? null;
      }
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [realFloorDevices, floorDevices, realDeviceTelemetrySignature, roomTelemetryMap]);

  // Chiều thời gian (-1h / Phát lại sự kiện / Ngày điển hình theo giờ)
  const bucketAnchorMs = useMemo(
    () => Math.floor(nowMs / (5 * 60_000)) * (5 * 60_000),
    [nowMs]
  );

  const activeBucketSpec = useMemo(() => {
    if (timeMode === 'compare_1h' || timeMode === 'playback') {
      return {
        interval: '15m' as const,
        start: new Date(bucketAnchorMs - 2.5 * 3600_000).toISOString(),
        end: new Date(bucketAnchorMs).toISOString(),
      };
    }
    if (timeMode === 'typical_day') {
      return {
        interval: '1h' as const,
        start: new Date(bucketAnchorMs - 7 * 86400_000).toISOString(),
        end: new Date(bucketAnchorMs).toISOString(),
      };
    }
    return null;
  }, [timeMode, bucketAnchorMs]);

  const timeBucketQueries = useQueries({
    queries: activeBucketSpec
      ? realFloorRooms.map((room) => ({
          queryKey: telemetryKeys.roomBuckets(
            room.id,
            activeBucketSpec.interval,
            activeBucketSpec.start,
            activeBucketSpec.end
          ),
          queryFn: () =>
            telemetryApi.getRoomBuckets({
              roomId: room.id,
              interval: activeBucketSpec.interval,
              start: activeBucketSpec.start,
              end: activeBucketSpec.end,
            }),
        }))
      : [],
  });

  const roomBucketsSignature = realFloorRooms
    .map((r, idx) => {
      const q = timeBucketQueries[idx];
      return `${r.id}:${q?.data?.dataPoints?.length ?? 0}:${q?.dataUpdatedAt ?? 0}`;
    })
    .join('|');

  const roomBucketsByRoomId = useMemo(() => {
    const map: Record<string, readonly BucketDataPoint[] | undefined> = {};
    realFloorRooms.forEach((r, idx) => {
      map[r.id] = timeBucketQueries[idx]?.data?.dataPoints;
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [realFloorRooms, roomBucketsSignature]);

  const roomDeltaMap = useMemo(() => {
    if (timeMode !== 'compare_1h') return undefined;
    const map: Record<string, OneHourDeltaResult> = {};
    for (const room of visibleFloorRooms) {
      const val = extractLayerMetricValue(
        roomTelemetryMap[room.id],
        selectedLayer
      );
      map[room.id] = computeOneHourDelta(
        val,
        roomBucketsByRoomId[room.id],
        selectedLayer,
        nowMs
      );
    }
    return map;
  }, [
    timeMode,
    visibleFloorRooms,
    roomTelemetryMap,
    roomBucketsByRoomId,
    selectedLayer,
    nowMs,
  ]);

  const playbackFrames = useMemo(() => {
    if (timeMode !== 'playback') return [];
    return buildEventPlaybackFrames(
      visibleFloorRooms,
      roomBucketsByRoomId,
      selectedLayer,
      roomTelemetryMap
    );
  }, [
    timeMode,
    visibleFloorRooms,
    roomBucketsByRoomId,
    selectedLayer,
    roomTelemetryMap,
  ]);

  const safePlaybackIndex =
    playbackFrames.length > 0
      ? Math.max(0, Math.min(playbackFrames.length - 1, playbackIndex))
      : 0;

  const activePlaybackFrame =
    timeMode === 'playback'
      ? (playbackFrames[safePlaybackIndex] ?? null)
      : null;

  useEffect(() => {
    if (
      timeMode !== 'playback' ||
      !isPlaybackPlaying ||
      playbackFrames.length <= 1
    ) {
      return;
    }
    const timer = setInterval(() => {
      setPlaybackIndex((prev) =>
        prev >= playbackFrames.length - 1 ? 0 : prev + 1
      );
    }, 900);
    return () => clearInterval(timer);
  }, [timeMode, isPlaybackPlaying, playbackFrames.length]);

  const typicalDaySnapshot = useMemo(() => {
    if (timeMode !== 'typical_day') return null;
    return computeTypicalDayFloorSnapshot(
      visibleFloorRooms,
      typicalHour,
      roomBucketsByRoomId,
      roomTelemetryMap
    );
  }, [
    timeMode,
    visibleFloorRooms,
    typicalHour,
    roomBucketsByRoomId,
    roomTelemetryMap,
  ]);

  const effectiveRoomTelemetryMap = useMemo(() => {
    if (timeMode === 'playback' && activePlaybackFrame) {
      return {
        ...roomTelemetryMap,
        ...activePlaybackFrame.telemetryByRoomId,
      };
    }
    if (timeMode === 'typical_day' && typicalDaySnapshot) {
      return {
        ...roomTelemetryMap,
        ...typicalDaySnapshot.telemetryByRoomId,
      };
    }
    return roomTelemetryMap;
  }, [
    timeMode,
    roomTelemetryMap,
    activePlaybackFrame,
    typicalDaySnapshot,
  ]);

  const effectiveDeviceTelemetryMap = useMemo(() => {
    if (timeMode === 'live' || timeMode === 'compare_1h') {
      return deviceTelemetryMap;
    }
    const map: Record<string, TelemetryResponse | null | undefined> = {};
    for (const d of floorDevices) {
      if (d.roomId) {
        map[d.id] = effectiveRoomTelemetryMap[d.roomId] ?? null;
      }
    }
    return map;
  }, [timeMode, deviceTelemetryMap, floorDevices, effectiveRoomTelemetryMap]);

  const unconfiguredRooms = useMemo(
    () =>
      backendFloorRooms.filter(
        (r) => !Array.isArray(r.boundaryPolygon) || r.boundaryPolygon.length < 3
      ),
    [backendFloorRooms]
  );

  const roomReliabilityMap = useMemo(() => {
    const nowMs = Date.now();
    const map: Record<string, RoomReliabilitySummary> = {};
    allBuildingRooms.forEach((room, idx) => {
      const tel = buildingTelemetryMap[room.id];
      const devsFromApi = allDevices.filter((d) => d.roomId === room.id);
      const roomDevs =
        devsFromApi.length > 0
          ? devsFromApi
          : floorDevices.filter((d) => d.roomId === room.id);
      const onlineDevs = roomDevs.filter(
        (d) => d.online || d.connectionState === 'ONLINE'
      );
      const polygon = resolveRoomPolygon(room, idx);
      let blindspotRatio: number | undefined;
      if (roomDevs.length > 0 && onlineDevs.length === 0) {
        blindspotRatio = 1;
      } else if (onlineDevs.length > 0 && polygon && polygon.length >= 3) {
        const centroid = computeVisualPolygonCenter(polygon);
        const samples = onlineDevs.map((d, dIdx) => ({
          x:
            typeof d.posX === 'number'
              ? d.posX
              : Math.max(
                  0.02,
                  Math.min(
                    0.98,
                    centroid.x +
                      (dIdx === 0 ? 0 : Math.cos(dIdx * 1.25) * 0.022)
                  )
                ),
          y:
            typeof d.posY === 'number'
              ? d.posY
              : Math.max(
                  0.02,
                  Math.min(
                    0.98,
                    centroid.y +
                      (dIdx === 0 ? 0 : Math.sin(dIdx * 1.25) * 0.022)
                  )
                ),
          value: 1,
          online: true,
        }));
        blindspotRatio = computeRoomBlindspotRatio(
          polygon,
          samples
        ).blindspotRatio;
      }
      map[room.id] = evaluateRoomReliability({
        room,
        telemetry: tel,
        devices: roomDevs,
        blindspotRatio,
        nowMs,
      });
    });
    return map;
  }, [allBuildingRooms, buildingTelemetryMap, allDevices, floorDevices]);

  const offlineFloorDevices = useMemo(
    () =>
      floorDevices.filter(
        (d) => !d.online && d.connectionState !== 'ONLINE'
      ),
    [floorDevices]
  );

  const staleFloorRooms = useMemo(
    () =>
      visibleFloorRooms.filter(
        (r) => roomReliabilityMap[r.id]?.state === 'STALE'
      ),
    [visibleFloorRooms, roomReliabilityMap]
  );

  const selectedRoom: RoomResponse | null = useMemo(
    () => floorRooms.find((r) => r.id === selectedRoomId) ?? null,
    [floorRooms, selectedRoomId]
  );

  useEffect(() => {
    if (
      furnitureEditMode &&
      canEditFurnitureInCurrentView &&
      !selectedRoomId &&
      !roomsQuery.isLoading
    ) {
      const fallbackRoom = realFloorRooms[0] ?? visibleFloorRooms[0] ?? null;
      if (fallbackRoom) {
        setSelectedRoomId(fallbackRoom.id);
      }
    }
  }, [
    furnitureEditMode,
    canEditFurnitureInCurrentView,
    selectedRoomId,
    roomsQuery.isLoading,
    realFloorRooms,
    visibleFloorRooms,
  ]);

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
    ? effectiveRoomTelemetryMap[selectedRoom.id]
    : null;

  const selectedRoomDelta =
    selectedRoom && roomDeltaMap ? (roomDeltaMap[selectedRoom.id] ?? null) : null;

  const selectedRoomPlaybackState =
    selectedRoom && activePlaybackFrame
      ? (activePlaybackFrame.roomStates[selectedRoom.id] ?? null)
      : null;

  const selectedRoomReliability = selectedRoom
    ? roomReliabilityMap[selectedRoom.id] ?? null
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

  const getRoomFurnitureItems = useCallback(
    (roomId: string): FurnitureItem[] => {
      if (furnitureDraftByRoom[roomId]) {
        return furnitureDraftByRoom[roomId];
      }
      const hist = furnitureHistoryByRoom[roomId];
      if (hist) {
        return hist.present;
      }
      const serverItems = serverFurnitureByRoom[roomId]?.items ?? [];
      return filterVisibleFurnitureItems(
        serverItems,
        FURNITURE_CATALOG,
        hideSensitiveFurniture
      );
    },
    [
      furnitureDraftByRoom,
      furnitureHistoryByRoom,
      serverFurnitureByRoom,
      hideSensitiveFurniture,
    ]
  );

  const floorFurnitureItems = useMemo(() => {
    const combined: FurnitureItem[] = [];
    for (const room of visibleFloorRooms) {
      if (room.id.startsWith('PRESET_')) continue;
      combined.push(...getRoomFurnitureItems(room.id));
    }
    return combined;
  }, [visibleFloorRooms, getRoomFurnitureItems]);

  const selectedRoomPolygon = useMemo(
    () =>
      selectedRoom
        ? resolveRoomPolygon(selectedRoom, selectedRoomIdx) ??
          selectedRoom.boundaryPolygon ??
          []
        : [],
    [selectedRoom, selectedRoomIdx]
  );

  const selectedRoomServerFurniture = selectedRoom
    ? serverFurnitureByRoom[selectedRoom.id]
    : undefined;

  const selectedRoomFurnitureItems = useMemo(
    () => (selectedRoom ? getRoomFurnitureItems(selectedRoom.id) : []),
    [selectedRoom, getRoomFurnitureItems]
  );

  const selectedRoomFurnitureHistory = selectedRoom
    ? furnitureHistoryByRoom[selectedRoom.id]
    : undefined;

  const selectedRoomFurnitureValidation = useMemo(
    () =>
      selectedRoom
        ? validateFurnitureLayout(
            selectedRoomFurnitureItems,
            selectedRoomPolygon,
            FURNITURE_CATALOG
          )
        : undefined,
    [selectedRoom, selectedRoomFurnitureItems, selectedRoomPolygon]
  );

  const invalidFurnitureIds = useMemo(
    () =>
      furnitureEditMode && selectedRoomFurnitureValidation
        ? selectedRoomFurnitureValidation.invalidIds
        : undefined,
    [furnitureEditMode, selectedRoomFurnitureValidation]
  );

  const commitRoomFurnitureItems = useCallback(
    (roomId: string, nextItems: FurnitureItem[]) => {
      setFurnitureDraftByRoom((prev) => {
        if (!(roomId in prev)) return prev;
        const copy = { ...prev };
        delete copy[roomId];
        return copy;
      });
      setFurnitureErrorMsg(null);
      setFurnitureHistoryByRoom((prev) => {
        const baseItems =
          prev[roomId]?.present ?? serverFurnitureByRoom[roomId]?.items ?? [];
        const currentState = prev[roomId] ?? createFurnitureHistory(baseItems);
        return {
          ...prev,
          [roomId]: pushFurnitureHistory(currentState, nextItems),
        };
      });
    },
    [serverFurnitureByRoom]
  );

  const handleUndoFurniture = useCallback((roomId: string) => {
    setFurnitureDraftByRoom((prev) => {
      if (!(roomId in prev)) return prev;
      const copy = { ...prev };
      delete copy[roomId];
      return copy;
    });
    setFurnitureHistoryByRoom((prev) => {
      const curr = prev[roomId];
      if (!curr) return prev;
      return {
        ...prev,
        [roomId]: undoFurnitureHistory(curr),
      };
    });
  }, []);

  const handleRedoFurniture = useCallback((roomId: string) => {
    setFurnitureDraftByRoom((prev) => {
      if (!(roomId in prev)) return prev;
      const copy = { ...prev };
      delete copy[roomId];
      return copy;
    });
    setFurnitureHistoryByRoom((prev) => {
      const curr = prev[roomId];
      if (!curr) return prev;
      return {
        ...prev,
        [roomId]: redoFurnitureHistory(curr),
      };
    });
  }, []);

  const handleReloadFurniture = useCallback(
    async (roomId: string) => {
      setFurnitureConflictRoomId(null);
      setFurnitureErrorMsg(null);
      setFurnitureDraftByRoom((prev) => {
        const copy = { ...prev };
        delete copy[roomId];
        return copy;
      });
      setFurnitureHistoryByRoom((prev) => {
        const copy = { ...prev };
        delete copy[roomId];
        return copy;
      });
      await queryClient.invalidateQueries({
        queryKey: roomKeys.furniture(roomId, false),
      });
      await queryClient.refetchQueries({
        queryKey: roomKeys.furniture(roomId, false),
      });
    },
    [queryClient]
  );

  const handleSaveFurniture = useCallback(
    async (roomId: string, changeNote?: string) => {
      if (roomId.startsWith('PRESET_')) return;
      const itemsToSave = getRoomFurnitureItems(roomId);
      const expectedVersion = serverFurnitureByRoom[roomId]?.version ?? null;
      setFurnitureErrorMsg(null);
      setFurnitureConflictRoomId(null);
      try {
        const saved = await updateFurnitureMutation.mutateAsync({
          id: roomId,
          body: {
            expectedVersion,
            changeNote,
            items: itemsToSave,
          },
        });
        setFurnitureHistoryByRoom((prev) => ({
          ...prev,
          [roomId]: createFurnitureHistory(saved.items ?? itemsToSave),
        }));
      } catch (err) {
        if (
          err instanceof ApiError &&
          (err.httpStatus === 409 || err.code === 5007)
        ) {
          setFurnitureConflictRoomId(roomId);
        } else {
          setFurnitureErrorMsg(
            err instanceof Error
              ? err.message
              : 'Không thể lưu bố cục nội thất.'
          );
        }
      }
    },
    [getRoomFurnitureItems, serverFurnitureByRoom, updateFurnitureMutation]
  );

  const selectedRoomAlerts: AlertResponse[] = useMemo(() => {
    if (!selectedRoom) return [];
    return activeAlerts.filter((a) => a.roomId === selectedRoom.id);
  }, [activeAlerts, selectedRoom]);

  const focusedDevice = useMemo(() => {
    if (!focusedDeviceId) return null;
    return (
      floorDevices.find(
        (d) => d.id === focusedDeviceId || d.hardwareId === focusedDeviceId
      ) ?? null
    );
  }, [floorDevices, focusedDeviceId]);

  const alertingDeviceIds = useMemo(
    () =>
      activeAlerts
        .flatMap((a) => [a.deviceId, a.hardwareId])
        .filter((id): id is string => Boolean(id)),
    [activeAlerts]
  );

  const firingRoomIds = useMemo(
    () =>
      activeAlerts
        .filter((a) => a.status === 'FIRING')
        .map((a) => a.roomId)
        .filter((id): id is string => Boolean(id)),
    [activeAlerts]
  );

  // Hàm định vị trực tiếp tới đúng tầng, đúng phòng, đúng lớp bản đồ nhiệt và đúng node cảnh báo
  const focusAlertOnMap = useCallback(
    (alert: AlertResponse) => {
      const candidateRooms =
        allBuildingRooms.length > 0
          ? allBuildingRooms
          : allBackendRooms.length > 0
            ? allBackendRooms
            : floorRooms;
      const target = resolveAlertFloorplanTarget(
        alert,
        candidateRooms,
        allDevices.length > 0 ? allDevices : floorDevices
      );
      if (target.floor && target.floor !== selectedFloor) {
        setSelectedFloor(target.floor);
      }
      setSelectedLayer(target.layer);
      if (target.roomId) {
        setSelectedRoomId(target.roomId);
        setZoomedRoomId(target.roomId);
      }
      const targetNode = target.deviceId ?? target.hardwareId;
      if (targetNode) {
        setFocusedDeviceId(targetNode);
      }
    },
    [
      allBuildingRooms,
      allBackendRooms,
      floorRooms,
      allDevices,
      floorDevices,
      selectedFloor,
    ]
  );

  const handleUpdateAlertWorkflow = useCallback(
    async (alertId: string, body: AlertWorkflowUpdateRequest) => {
      try {
        await updateAlertWorkflowMutation.mutateAsync({ id: alertId, body });
      } catch {
        // Error banner / mutation state surfaces failure without crashing view
      }
    },
    [updateAlertWorkflowMutation]
  );

  const handleAcknowledgeRoomAlerts = useCallback(
    async (alerts: readonly AlertResponse[]) => {
      for (const a of alerts) {
        try {
          await updateAlertWorkflowMutation.mutateAsync({
            id: a.id,
            body: { workflowStatus: 'ACKNOWLEDGED' },
          });
        } catch {
          // Continue remaining alerts in group gracefully
        }
      }
    },
    [updateAlertWorkflowMutation]
  );

  // STOMP /topic/alerts -> fail-closed zone filter + aria-live="assertive" announcement & instant cache sync
  const allBuildingRoomsRef = useRef(allBuildingRooms);
  useEffect(() => {
    allBuildingRoomsRef.current = allBuildingRooms;
  }, [allBuildingRooms]);

  const alertZoneContextRef = useRef({
    isAdmin: false,
    assignedZones: undefined as readonly string[] | undefined,
    allowedRoomIds: new Set<string>(),
    allowedDeviceIds: new Set<string>(),
  });

  useEffect(() => {
    const userZones = currentUser?.assignedZones;
    const assignedSet = new Set(userZones ?? []);
    const roomIds = new Set<string>();
    const devIds = new Set<string>();
    for (const d of allDevices) {
      if (d.zoneId && assignedSet.has(d.zoneId)) {
        devIds.add(d.id);
        if (d.hardwareId) devIds.add(d.hardwareId);
        if (d.roomId) roomIds.add(d.roomId);
      }
    }
    alertZoneContextRef.current = {
      isAdmin: capabilities.isAdmin,
      assignedZones: userZones,
      allowedRoomIds: roomIds,
      allowedDeviceIds: devIds,
    };
  }, [capabilities.isAdmin, currentUser?.assignedZones, allDevices]);

  useEffect(() => {
    if (isStudentView || !capabilities.canViewAlerts) return;
    return stompManager.onAlert((incoming) => {
      const ctx = alertZoneContextRef.current;
      if (
        !isAlertInUserZones(
          incoming,
          ctx.isAdmin,
          ctx.assignedZones,
          ctx.allowedRoomIds,
          ctx.allowedDeviceIds
        )
      ) {
        return;
      }

      const listQueries = queryClient.getQueriesData<
        import('@/types/api').PageResponse<AlertResponse>
      >({
        queryKey: ['alerts', 'list'],
      });
      for (const [queryKey, prev] of listQueries) {
        if (!prev) continue;
        queryClient.setQueryData(queryKey, {
          ...prev,
          content: upsertRealtimeAlertList(prev.content, incoming),
        });
      }

      if (incoming.status === 'FIRING') {
        setLiveAlertAnnouncement(
          formatRealtimeAlertAnnouncementVi(
            incoming,
            allBuildingRoomsRef.current
          )
        );
      }
    });
  }, [isStudentView, capabilities.canViewAlerts, queryClient]);

  // Khôi phục trạng thái đầy đủ từ URL (Deep Link + Alert Acknowledge navigation)
  const [urlHydrated, setUrlHydrated] = useState<boolean>(false);
  const pendingUrlFloorRef = useRef<number | null>(null);
  const pendingUrlAlertIdRef = useRef<string | null>(null);
  const appliedUrlDeviceSigRef = useRef<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const search = window.location.search;

    if (!search) {
      setUrlHydrated(true);
      return;
    }

    // Bỏ qua nếu URL hiện tại do chính state sync vừa ghi ra và không còn alertId/floor chờ phân giải
    if (
      lastWrittenSearchRef.current !== null &&
      search === lastWrittenSearchRef.current &&
      !pendingUrlAlertIdRef.current &&
      pendingUrlFloorRef.current === null
    ) {
      if (!urlHydrated) setUrlHydrated(true);
      return;
    }

    const params = new URLSearchParams(search);
    const rawFloorNum = Number(params.get('floor'));
    const parsed = parseFloorplanUrlState(search, floorOptions, {
      floor: DEFAULT_FLOORPLAN_CONFIG.defaultFloor,
      layer: DEFAULT_FLOORPLAN_CONFIG.defaultLayer,
    });

    if (!urlHydrated || (lastWrittenSearchRef.current !== null && search !== lastWrittenSearchRef.current)) {
      if (Number.isInteger(rawFloorNum) && rawFloorNum > 0 && !floorOptions.includes(rawFloorNum)) {
        pendingUrlFloorRef.current = rawFloorNum;
      } else {
        pendingUrlFloorRef.current = null;
      }

      if (parsed.alertId && !parsed.roomId && !parsed.deviceId && !parsed.hardwareId) {
        pendingUrlAlertIdRef.current = parsed.alertId;
      } else {
        pendingUrlAlertIdRef.current = null;
      }

      const matchedRoomAcrossBuilding = parsed.roomId
        ? allBackendRooms.find((r) => r.id === parsed.roomId)
        : undefined;
      const targetFloor = params.has('floor')
        ? parsed.floor
        : matchedRoomAcrossBuilding?.floor ?? selectedFloor;

      if (floorOptions.includes(targetFloor) && targetFloor !== selectedFloor) {
        setSelectedFloor(targetFloor);
      }

      if (params.has('layer') && parsed.layer !== selectedLayer) {
        setSelectedLayer(parsed.layer);
      }

      if (parsed.roomId) {
        setSelectedRoomId(parsed.roomId);
        setZoomedRoomId(parsed.roomId);
      }

      if (params.has('timeMode') && parsed.timeMode !== timeMode) {
        setTimeMode(parsed.timeMode);
      }
      if (params.has('hour') && typeof parsed.hour === 'number') {
        setTypicalHour(parsed.hour);
      }
      if (params.has('statusFilter') || params.has('alertFilter')) {
        setStatusFilter(parsed.statusFilter);
      }

      if (params.has('scale') || params.has('tx') || params.has('ty')) {
        const restoredVp: ViewportTransform = {
          scale: parsed.scale,
          tx: parsed.tx,
          ty: parsed.ty,
        };
        setViewportState(restoredVp);
        setRestoredInitialViewport(restoredVp);
      }

      lastWrittenSearchRef.current = search;
      setUrlHydrated(true);
    }

    // Giải quyết trễ khi tầng tùy chỉnh từ API vừa tải về
    if (
      pendingUrlFloorRef.current !== null &&
      floorOptions.includes(pendingUrlFloorRef.current)
    ) {
      setSelectedFloor(pendingUrlFloorRef.current);
      pendingUrlFloorRef.current = null;
    }

    // Giải quyết deep-link theo alertId sau khi dữ liệu cảnh báo tải xong
    if (pendingUrlAlertIdRef.current && alertsQuery.data) {
      const matchedAlert = alertsQuery.data.content.find(
        (a) => a.id === pendingUrlAlertIdRef.current
      );
      if (matchedAlert) {
        pendingUrlAlertIdRef.current = null;
        focusAlertOnMap(matchedAlert);
      }
    }

    // Ghim trạm cảm biến khi danh sách thiết bị tải xong
    const effectiveDevId = parsed.deviceId ?? null;
    const effectiveHwId = parsed.hardwareId ?? null;
    const devSig = `${search}|devs:${floorDevices.length}`;
    if (
      (effectiveDevId || effectiveHwId) &&
      appliedUrlDeviceSigRef.current !== devSig
    ) {
      appliedUrlDeviceSigRef.current = devSig;
      const matchedFloorDevice = floorDevices.find(
        (d) =>
          (effectiveDevId && d.id === effectiveDevId) ||
          (effectiveHwId &&
            (d.hardwareId === effectiveHwId || d.id === effectiveHwId))
      );
      setFocusedDeviceId(
        matchedFloorDevice?.id ?? effectiveDevId ?? effectiveHwId
      );
    }
  }, [
    urlHydrated,
    allBackendRooms,
    floorDevices,
    alertsQuery.data,
    focusAlertOnMap,
    floorOptions,
    selectedFloor,
    selectedLayer,
    timeMode,
  ]);

  const currentUrlState = useMemo(
    () => ({
      floor: selectedFloor,
      roomId: selectedRoomId,
      deviceId: focusedDeviceId,
      layer: selectedLayer,
      scale: viewportState.scale,
      tx: viewportState.tx,
      ty: viewportState.ty,
      timeMode,
      hour: typicalHour,
      statusFilter,
    }),
    [
      selectedFloor,
      selectedRoomId,
      focusedDeviceId,
      selectedLayer,
      viewportState.scale,
      viewportState.tx,
      viewportState.ty,
      timeMode,
      typicalHour,
      statusFilter,
    ]
  );

  // Đồng bộ 2 chiều trạng thái xem ra URL khi người dùng tương tác (sau khi đã khôi phục xong)
  useEffect(() => {
    if (typeof window === 'undefined' || !urlHydrated) return;
    if (pendingUrlAlertIdRef.current || pendingUrlFloorRef.current !== null) {
      return;
    }

    const isDefaultState =
      currentUrlState.floor === DEFAULT_FLOORPLAN_CONFIG.defaultFloor &&
      !currentUrlState.roomId &&
      !currentUrlState.deviceId &&
      currentUrlState.layer === DEFAULT_FLOORPLAN_CONFIG.defaultLayer &&
      currentUrlState.scale <= 1.001 &&
      Math.abs(currentUrlState.tx) < 0.5 &&
      Math.abs(currentUrlState.ty) < 0.5 &&
      currentUrlState.timeMode === 'live' &&
      currentUrlState.statusFilter === 'ALL';

    if (!window.location.search && isDefaultState) {
      return;
    }

    const nextQuery = serializeFloorplanUrlState(currentUrlState);
    const nextSearch = `?${nextQuery}`;
    if (window.location.search === nextSearch) {
      lastWrittenSearchRef.current = nextSearch;
      return;
    }
    lastWrittenSearchRef.current = nextSearch;
    window.history.replaceState(null, '', nextSearch);
  }, [urlHydrated, currentUrlState]);

  const activeTimeModeLabel = useMemo(() => {
    switch (timeMode) {
      case 'compare_1h':
        return FLOORPLAN_I18N_VI.timeAnalysis.modes.compare_1h;
      case 'playback':
        return activePlaybackFrame
          ? `${FLOORPLAN_I18N_VI.timeAnalysis.modes.playback} (${activePlaybackFrame.timestamp})`
          : FLOORPLAN_I18N_VI.timeAnalysis.modes.playback;
      case 'typical_day':
        return `${FLOORPLAN_I18N_VI.timeAnalysis.modes.typical_day} (${String(
          typicalHour
        ).padStart(2, '0')}:00)`;
      case 'live':
      default:
        return FLOORPLAN_I18N_VI.timeAnalysis.modes.live;
    }
  }, [timeMode, activePlaybackFrame, typicalHour]);

  const handleCopyDeepLink = useCallback(async () => {
    const shareUrl = buildFloorplanShareUrl(currentUrlState);
    if (typeof window !== 'undefined') {
      const nextSearch = `?${serializeFloorplanUrlState(currentUrlState)}`;
      lastWrittenSearchRef.current = nextSearch;
      window.history.replaceState(null, '', nextSearch);
    }
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(shareUrl);
      }
    } catch {
      // Ignore clipboard write rejection in restricted contexts
    }
    setDeepLinkCopied(true);
    if (copyFeedbackTimerRef.current) {
      clearTimeout(copyFeedbackTimerRef.current);
    }
    copyFeedbackTimerRef.current = setTimeout(() => {
      setDeepLinkCopied(false);
    }, 2200);
  }, [currentUrlState]);

  const floorOpenAlerts = useMemo(
    () => activeAlerts.filter((a) => !a.roomId || floorRoomIds.has(a.roomId)),
    [activeAlerts, floorRoomIds]
  );

  const handleExportPng = useCallback(() => {
    const root = workspaceFullscreenRef.current;
    const staticCanvas =
      root?.querySelector<HTMLCanvasElement>('canvas[data-testid="static-base-canvas"]') ??
      null;
    const dynamicCanvas =
      root?.querySelector<HTMLCanvasElement>('canvas[data-testid="dynamic-heatmap-canvas"]') ??
      null;
    exportFloorplanReportPng({
      floor: selectedFloor,
      layer: selectedLayer,
      staticCanvas,
      dynamicCanvas,
      rooms: visibleFloorRooms,
      roomTelemetryMap: effectiveRoomTelemetryMap,
      openAlerts: floorOpenAlerts,
      exportedBy: currentUser?.username ?? 'Quản lý thư viện',
      timeModeLabel: activeTimeModeLabel,
    });
  }, [
    selectedFloor,
    selectedLayer,
    visibleFloorRooms,
    effectiveRoomTelemetryMap,
    floorOpenAlerts,
    currentUser?.username,
    activeTimeModeLabel,
  ]);

  const handleExportPdf = useCallback(() => {
    const root = workspaceFullscreenRef.current;
    const staticCanvas =
      root?.querySelector<HTMLCanvasElement>('canvas[data-testid="static-base-canvas"]') ??
      null;
    const dynamicCanvas =
      root?.querySelector<HTMLCanvasElement>('canvas[data-testid="dynamic-heatmap-canvas"]') ??
      null;
    exportFloorplanReportPdf({
      floor: selectedFloor,
      layer: selectedLayer,
      staticCanvas,
      dynamicCanvas,
      rooms: visibleFloorRooms,
      roomTelemetryMap: effectiveRoomTelemetryMap,
      openAlerts: floorOpenAlerts,
      exportedBy: currentUser?.username ?? 'Quản lý thư viện',
      timeModeLabel: activeTimeModeLabel,
    });
  }, [
    selectedFloor,
    selectedLayer,
    visibleFloorRooms,
    effectiveRoomTelemetryMap,
    floorOpenAlerts,
    currentUser?.username,
    activeTimeModeLabel,
  ]);

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
    <div
      ref={workspaceFullscreenRef}
      data-testid="floorplan-workspace"
      className={
        isFullscreen
          ? 'flex h-screen w-full flex-col gap-2 overflow-y-auto bg-canvas p-3'
          : 'w-full max-w-none space-y-2'
      }
    >
      {/* Screen Reader live alert announcement region (aria-live="assertive") */}
      {!isStudentView && capabilities.canViewAlerts && (
        <div
          data-testid="alert-live-region"
          role="alert"
          aria-live="assertive"
          className="sr-only"
        >
          {liveAlertAnnouncement}
        </div>
      )}

      {/* Background STOMP Subscribers across all real building rooms */}
      {realBuildingRooms.map((r) => (
        <RoomStreamSubscriber key={r.id} roomId={r.id} />
      ))}

      {/* Top Manager Summary Strip (Hidden only in Student/Kiosk View) */}
      {!isStudentView && (
        <ManagerSummaryStrip
          metrics={buildingSummaryMetrics}
          activeFilter={statusFilter}
          onFilterChange={setStatusFilter}
          stompConnected={stompConnected}
        />
      )}

      {/* Unified Compact Header, Dynamic Floor Selector, 7-Layer Metric Bar & Controls */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200/80 bg-white px-3 py-2">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-base font-semibold tracking-tight text-slate-900">
            Bản đồ mặt bằng
          </h1>

          {/* Dynamic Floor Selector */}
          <div className="segmented" role="group" aria-label="Chọn tầng">
            {floorOptions.map((f) => (
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

        {/* 7-Layer Metric Bar + Architecture / Role Controls */}
        <div className="flex flex-wrap items-center gap-2">
          <div
            className="flex flex-wrap items-center gap-1"
            role="group"
            aria-label="Chọn lớp chỉ số"
          >
            {LAYER_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                type="button"
                data-testid={`layer-btn-${opt.key}`}
                aria-pressed={selectedLayer === opt.key}
                onClick={() => setSelectedLayer(opt.key)}
                className={`rounded-md px-2 py-1 text-xs font-medium transition-colors ${
                  selectedLayer === opt.key
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900'
                }`}
              >
                {opt.shortLabel}
              </button>
            ))}
          </div>

          <span className="hidden h-4 w-px bg-slate-200 sm:inline-block" aria-hidden="true" />

          {/* ISA-101 Deviation Mode: Only Exceeding Threshold */}
          {!isStudentView && (
            <button
              type="button"
              data-testid="only-exceeding-toggle"
              aria-pressed={onlyExceedingThreshold}
              onClick={() => setOnlyExceedingThreshold((v) => !v)}
              className={`rounded-lg border px-2 py-1 text-xs font-medium transition-colors ${
                onlyExceedingThreshold
                  ? 'border-amber-700 bg-amber-950 text-amber-50'
                  : 'border-slate-300 bg-white text-slate-800 hover:bg-slate-50'
              }`}
              title="Làm dịu các phòng đạt chuẩn (ISA-101), chỉ làm nổi bật vùng vượt ngưỡng"
            >
              {FLOORPLAN_I18N_VI.controls.onlyExceedingThreshold}
            </button>
          )}

          {/* Data Reliability Overlay Toggle (Measured / Interpolated / Blindspot / Stale) */}
          {!isStudentView && (
            <button
              type="button"
              data-testid="reliability-toggle-btn"
              aria-pressed={showReliabilityLayer}
              onClick={() => setShowReliabilityLayer((v) => !v)}
              className={`rounded-lg border px-2 py-1 text-xs font-medium transition-colors ${
                showReliabilityLayer
                  ? 'border-sky-700 bg-sky-900 text-sky-50'
                  : 'border-slate-300 bg-white text-slate-800 hover:bg-slate-50'
              }`}
              title="Phân biệt vùng đo trực tiếp, ước lượng nội suy, vùng mù và dữ liệu trễ"
            >
              {FLOORPLAN_I18N_VI.controls.reliabilityLayer}
            </button>
          )}

          {/* Furniture Layer Visibility Toggle (Architectural 1:100 Layer) */}
          <button
            type="button"
            data-testid="furniture-layer-toggle-btn"
            aria-pressed={showFurnitureLayer}
            onClick={() => setShowFurnitureLayer((v) => !v)}
            className={`rounded-lg border px-2 py-1 text-xs font-medium transition-colors ${
              showFurnitureLayer
                ? 'border-emerald-700 bg-emerald-950 text-emerald-50'
                : 'border-slate-300 bg-white text-slate-800 hover:bg-slate-50'
            }`}
            title="Bật/tắt lớp nội thất 1:100 (chỉ hiển thị, không làm sai lệch giá trị nhiệt)"
          >
            {FLOORPLAN_I18N_VI.furniture.layerToggle}
          </button>

          {/* Furniture Edit Mode Toggle (RBAC: ADMIN / LIBRARIAN / MAINTENANCE / MANAGE_ZONES) */}
          {canEditFurnitureInCurrentView && (
            <button
              type="button"
              data-testid="furniture-edit-toggle-btn"
              aria-pressed={furnitureEditMode}
              onClick={() => {
                const nextEdit = !furnitureEditMode;
                setFurnitureEditMode(nextEdit);
                if (nextEdit) {
                  setShowFurnitureLayer(true);
                  if (!selectedRoomId) {
                    const fallbackRoom =
                      realFloorRooms[0] ?? visibleFloorRooms[0] ?? null;
                    if (fallbackRoom) {
                      setSelectedRoomId(fallbackRoom.id);
                    }
                  }
                } else {
                  setSelectedFurnitureIds([]);
                }
              }}
              className={`rounded-lg border px-2 py-1 text-xs font-medium transition-colors ${
                furnitureEditMode
                  ? 'border-sky-600 bg-sky-700 text-white'
                  : 'border-slate-300 bg-white text-slate-800 hover:bg-slate-50'
              }`}
              title="Bật/tắt chế độ chỉnh sửa nội thất tỉ lệ 1:100"
            >
              {furnitureEditMode
                ? FLOORPLAN_I18N_VI.furniture.exitEdit
                : FLOORPLAN_I18N_VI.furniture.editButton}
            </button>
          )}

          {/* Toggle Full TQB Architectural Rooms */}
          <button
            type="button"
            onClick={() => setIncludeTqbArchitecturePresets((v) => !v)}
            className={`rounded-lg border px-2 py-1 text-xs font-medium transition-colors ${
              includeTqbArchitecturePresets
                ? 'border-slate-900 bg-slate-900 text-white'
                : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
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
                  if (nextRole === 'USER') {
                    setFurnitureEditMode(false);
                    setSelectedFurnitureIds([]);
                  }
                }}
                className="select h-7 py-0 text-xs font-medium"
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
          compact
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
          compact
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
          compact
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
          data-testid="ws-reconnecting-banner"
          className="rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-900"
        >
          {UI_TEXT_VI.wsReconnectingBanner}
        </div>
      )}

      {/* Silent Sensor & Stale Telemetry Banner */}
      {!isStudentView &&
        (offlineFloorDevices.length > 0 || staleFloorRooms.length > 0) && (
          <div
            role="status"
            data-testid="silent-sensor-banner"
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950"
          >
            <span>
              <strong>Lưu ý độ tin cậy:</strong>{' '}
              {offlineFloorDevices.length > 0 &&
                `${offlineFloorDevices.length} cảm biến đang im lặng/mất kết nối`}
              {offlineFloorDevices.length > 0 &&
                staleFloorRooms.length > 0 &&
                ' · '}
              {staleFloorRooms.length > 0 &&
                `${staleFloorRooms.length} phòng dữ liệu trễ > 5 phút`}
            </span>
            <button
              type="button"
              data-testid="silent-sensor-inspect-btn"
              onClick={() => {
                setShowReliabilityLayer(true);
                setShowBlindspots(true);
                const targetRoomId =
                  offlineFloorDevices[0]?.roomId ?? staleFloorRooms[0]?.id;
                if (targetRoomId) {
                  setSelectedRoomId(targetRoomId);
                  setZoomedRoomId(targetRoomId);
                }
              }}
              className="rounded-md border border-amber-700 bg-white px-2.5 py-1 text-[11px] font-semibold text-amber-950 hover:bg-amber-100"
            >
              Xem trên bản đồ
            </button>
          </div>
        )}

      {/* Error State */}
      {roomsQuery.isError && (
        <ErrorBanner
          message="Không thể tải danh sách phòng đọc của tầng này."
          onRetry={() => void roomsQuery.refetch()}
        />
      )}

      {/* Loading or Full-Width Canvas + Sliding Drawer */}
      {roomsQuery.isLoading ? (
        <Skeleton className="h-[520px] w-full" />
      ) : visibleFloorRooms.length === 0 ? (
        <EmptyState
          title={UI_TEXT_VI.emptyRoomsFloor}
          description="Tầng này chưa có phòng đọc nào thuộc phân khu đang lọc."
        />
      ) : (
        <div className="space-y-2">
          {/* Time Dimension Bar (-1h, Playback, Typical Day, Deep Link, PNG/PDF Export) */}
          {!isStudentView && (
            <TimeComparisonBar
              timeMode={timeMode}
              onTimeModeChange={(nextMode) => {
                setTimeMode(nextMode);
                setIsPlaybackPlaying(false);
                if (nextMode === 'playback') {
                  setPlaybackIndex(0);
                }
              }}
              frames={playbackFrames}
              playbackIndex={safePlaybackIndex}
              onPlaybackIndexChange={(idx) => {
                setIsPlaybackPlaying(false);
                setPlaybackIndex(idx);
              }}
              isPlaying={isPlaybackPlaying}
              onTogglePlay={() => setIsPlaybackPlaying((p) => !p)}
              typicalHour={typicalHour}
              onTypicalHourChange={setTypicalHour}
              typicalSummaryNote={typicalDaySnapshot?.summaryNoteVi}
              onCopyDeepLink={() => void handleCopyDeepLink()}
              deepLinkCopied={deepLinkCopied}
              onExportPng={handleExportPng}
              onExportPdf={handleExportPdf}
            />
          )}

          {/* Dynamic Navigation Breadcrumb: Tầng X › Phòng Y */}
          <nav
            aria-label="Đường dẫn vị trí bản đồ"
            data-testid="floorplan-breadcrumb"
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200/80 bg-white px-3 py-1.5 text-xs text-slate-600"
          >
            <div className="flex min-w-0 items-center gap-1.5">
              <button
                type="button"
                data-testid="breadcrumb-floor-btn"
                onClick={() => {
                  setSelectedRoomId(null);
                  setZoomedRoomId(null);
                  setFocusedDeviceId(null);
                  setSelectedBayId(null);
                }}
                className={`font-semibold transition-colors hover:text-sky-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 rounded ${
                  !selectedRoom
                    ? 'text-slate-900'
                    : 'text-sky-700 underline-offset-2 hover:underline'
                }`}
              >
                {FLOORPLAN_I18N_VI.tree.floorPrefix} {selectedFloor}
              </button>
              <span aria-hidden="true" className="text-slate-400">
                ›
              </span>
              {selectedRoom ? (
                <span
                  data-testid="breadcrumb-room-label"
                  className="truncate font-semibold text-slate-900"
                >
                  {selectedRoom.code} — {selectedRoom.name}
                </span>
              ) : (
                <span className="text-slate-600">
                  {FLOORPLAN_I18N_VI.tree.allFloorSummary} (
                  {visibleFloorRooms.length} phòng)
                </span>
              )}
            </div>
          </nav>

          <div className="flex flex-col gap-2.5 lg:flex-row lg:items-start">
            <FloorRoomTree
              treeNodes={buildingFloorTree}
              selectedFloor={selectedFloor}
              selectedRoomId={selectedRoomId}
              isCollapsed={isTreeCollapsed}
              onCollapsedChange={setIsTreeCollapsed}
              onSelectFloor={(floor) => {
                setSelectedFloor(floor);
                setSelectedRoomId(null);
                setZoomedRoomId(null);
                setFocusedDeviceId(null);
                setSelectedBayId(null);
              }}
              onSelectRoom={(room) => {
                const targetFloor = room.floor === 0 ? 1 : room.floor;
                if (targetFloor !== selectedFloor) {
                  setSelectedFloor(targetFloor);
                }
                setSelectedRoomId(room.id);
                setZoomedRoomId(room.id);
                setFocusedDeviceId(null);
                setSelectedBayId(null);
              }}
            />

            <div className="relative min-w-0 flex-1" data-testid="floorplan-main-stage">
              <div className="card overflow-hidden">
                <FloorplanCanvas
                  rooms={visibleFloorRooms}
                  devices={floorDevices}
                  roomTelemetryMap={effectiveRoomTelemetryMap}
                  deviceTelemetryMap={effectiveDeviceTelemetryMap}
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
                  focusedDeviceId={focusedDeviceId}
                  alertingDeviceIds={alertingDeviceIds}
                  zoomedRoomId={zoomedRoomId}
                  onZoomRoomChange={setZoomedRoomId}
                  selectedBayId={selectedBayId}
                  onSelectBay={(bay, room) => {
                    setSelectedRoomId(room.id);
                    setSelectedBayId(bay.bayId);
                  }}
                  showBlindspots={showBlindspots}
                  showReliabilityLayer={showReliabilityLayer}
                  roomReliabilityMap={roomReliabilityMap}
                  showTechOverlay={isMaintenanceView}
                  defaultLabelDensity={
                    isMaintenanceView ? 'detailed' : 'balanced'
                  }
                  highlightedZoneIds={
                    onlyAssignedZones ? assignedZones : undefined
                  }
                  firingRoomIds={firingRoomIds}
                  roomAlertCounts={roomAlertCounts}
                  roomAlertSeverities={roomAlertSeverities}
                  overdueRoomIds={overdueRoomIds}
                  activeStatusFilter={statusFilter}
                  roomMatchesFilterMap={roomMatchesFilterMap}
                  onlyExceedingThreshold={onlyExceedingThreshold}
                  roomTelemetryHistoryMap={roomTelemetryHistoryMap}
                  initialViewport={restoredInitialViewport}
                  onViewportChange={setViewportState}
                  roomDeltaMap={roomDeltaMap}
                  playbackRoomStateMap={activePlaybackFrame?.roomStates}
                  isFullscreen={isFullscreen}
                  onToggleFullscreen={handleToggleFullscreen}
                  maxViewportHeightPx={maxViewportHeightPx}
                  showFurnitureLayer={showFurnitureLayer}
                  furnitureItems={
                    furnitureEditMode && selectedRoom
                      ? selectedRoomFurnitureItems
                      : floorFurnitureItems
                  }
                  furnitureOpacity={furnitureOpacity}
                  furnitureEditMode={
                    furnitureEditMode && canEditFurnitureInCurrentView
                  }
                  selectedFurnitureIds={selectedFurnitureIds}
                  invalidFurnitureIds={invalidFurnitureIds}
                  hideSensitiveFurniture={hideSensitiveFurniture}
                  furnitureCatalog={FURNITURE_CATALOG}
                  snapFurnitureGrid={snapFurnitureGrid}
                  onSelectFurnitureIds={setSelectedFurnitureIds}
                  onUpdateFurnitureItems={(nextItems) => {
                    if (!selectedRoom) return;
                    setFurnitureDraftByRoom((prev) => ({
                      ...prev,
                      [selectedRoom.id]: nextItems,
                    }));
                  }}
                  onCommitFurnitureItems={(nextItems) => {
                    if (!selectedRoom) return;
                    commitRoomFurnitureItems(selectedRoom.id, nextItems);
                  }}
                />
              </div>

            {/* Streamlined Right Floating Drawer (Does not shrink canvas width) */}
            {selectedRoom && (
              <aside
                role="complementary"
                data-testid="room-detail-drawer"
                aria-label={`Chi tiết phòng ${selectedRoom.name}`}
                className="card absolute right-3 top-3 z-30 max-h-[calc(100%-1.5rem)] w-[min(390px,calc(100%-1.5rem))] space-y-3.5 overflow-y-auto border-slate-200 bg-white/95 p-4 shadow-2xl backdrop-blur"
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
                          title="Dữ liệu tham khảo kiến trúc khi chưa gắn cảm biến thật"
                        >
                          Tham khảo
                        </span>
                      )}
                      {isTelemetryStale(
                        selectedRoomTelemetry?.timestamp,
                        nowMs,
                        selectedRoomTelemetry?.isSynthetic ||
                          selectedRoom.id.startsWith('PRESET_')
                      ) && (
                        <span
                          className="rounded border border-slate-300 bg-slate-100 px-1.5 py-0.5 font-sans text-[10px] font-medium text-slate-600"
                          title="Dữ liệu đo đã quá 5 phút chưa cập nhật mới"
                        >
                          Dữ liệu trễ
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
                    {canEditFurnitureInCurrentView && (
                      <button
                        type="button"
                        data-testid="drawer-furniture-edit-btn"
                        aria-pressed={furnitureEditMode}
                        onClick={() => {
                          const next = !furnitureEditMode;
                          setFurnitureEditMode(next);
                          if (next) {
                            setShowFurnitureLayer(true);
                          } else {
                            setSelectedFurnitureIds([]);
                          }
                        }}
                        className={`btn-sm h-7 rounded-md border px-2 text-2xs font-medium transition-colors ${
                          furnitureEditMode
                            ? 'border-sky-600 bg-sky-700 text-white'
                            : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                        }`}
                      >
                        {furnitureEditMode ? 'Xong nội thất' : 'Nội thất'}
                      </button>
                    )}
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

                {/* Time Mode Readout (-1h Delta / Playback Propagation Role) */}
                {!isStudentView &&
                  (selectedRoomDelta || selectedRoomPlaybackState) && (
                    <div
                      data-testid="drawer-time-analysis-card"
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-sky-200 bg-sky-50/80 px-3 py-2 text-xs"
                    >
                      {selectedRoomDelta && (
                        <div className="flex items-center gap-1.5 font-semibold text-slate-800">
                          <span className="text-slate-600">Biến động -1h:</span>
                          <span data-testid="drawer-delta-1h" className="tabular-nums text-sky-900">
                            {selectedRoomDelta.textWithContext}
                          </span>
                        </div>
                      )}
                      {selectedRoomPlaybackState && (
                        <div className="flex items-center gap-1.5 font-semibold">
                          <span className="text-slate-600">Phát lại sự cố:</span>
                          <span
                            data-testid="drawer-playback-role"
                            className={`rounded px-1.5 py-0.5 ${
                              selectedRoomPlaybackState.propagationRole === 'ORIGIN'
                                ? 'bg-rose-100 text-rose-900'
                                : selectedRoomPlaybackState.propagationRole === 'SPREAD'
                                  ? 'bg-amber-100 text-amber-900'
                                  : 'bg-slate-200 text-slate-800'
                            }`}
                          >
                            {selectedRoomPlaybackState.propagationLabelVi}
                          </span>
                        </div>
                      )}
                    </div>
                  )}

                {/* Manager-Friendly Data Reliability Summary */}
                {!isStudentView && selectedRoomReliability && (
                  <div
                    data-testid="drawer-reliability-card"
                    title={selectedRoomReliability.tooltipText}
                    className="rounded-lg border border-slate-200 bg-slate-50/80 px-3 py-2 text-xs"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-slate-800">
                        Độ tin cậy số liệu
                      </span>
                      <div className="flex items-center gap-1.5">
                        <span className="rounded bg-slate-200/80 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-slate-800">
                          {selectedRoomReliability.qualityLabel}
                        </span>
                        <span className="font-semibold text-slate-900">
                          {selectedRoomReliability.badgeText}
                        </span>
                      </div>
                    </div>
                    <p className="mt-1 text-[11px] leading-snug text-slate-600">
                      {selectedRoomReliability.tooltipText}
                    </p>
                    <div className="mt-1 flex items-center justify-between text-[10px] text-slate-500">
                      <span>
                        Cập nhật: {selectedRoomReliability.relativeTimeText}
                      </span>
                      {selectedRoomReliability.totalDeviceCount > 0 && (
                        <span>
                          Trạm hoạt động:{' '}
                          {selectedRoomReliability.onlineDeviceCount}/
                          {selectedRoomReliability.totalDeviceCount}
                        </span>
                      )}
                    </div>
                  </div>
                )}

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

                {/* Focused Sensor Node Callout (when deep-linked from Alert Acknowledge or selected on map) */}
                {!isStudentView &&
                  focusedDevice &&
                  focusedDevice.roomId === selectedRoom.id && (
                    <div className="rounded-lg border border-rose-300 bg-rose-50/70 p-2.5 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="inline-flex items-center gap-1.5 font-semibold text-rose-900">
                          <MapPin className="h-3.5 w-3.5 text-rose-600" />
                          <span>Node cảm biến đang định vị</span>
                        </span>
                        <button
                          type="button"
                          onClick={() => setFocusedDeviceId(null)}
                          className="text-2xs font-medium text-rose-700 hover:underline"
                        >
                          Bỏ ghim
                        </button>
                      </div>
                      <div className="mt-1.5 flex items-center justify-between gap-2 rounded border border-rose-200 bg-white px-2.5 py-1.5">
                        <div className="min-w-0">
                          <p className="truncate font-semibold text-slate-900">
                            {focusedDevice.name}
                          </p>
                          <p className="font-mono text-2xs text-rose-700">
                            {focusedDevice.hardwareId}
                          </p>
                        </div>
                        <ConnectionBadge online={focusedDevice.online} />
                      </div>
                    </div>
                  )}

                {/* Active Room Alerts Workflow Inspector (4-state FSM, SOP, Assignee, Note, Overdue) */}
                {!isStudentView && selectedRoomAlerts.length > 0 && (
                  <AlertInspectorDrawer
                    alerts={selectedRoomAlerts}
                    room={selectedRoom}
                    nowMs={nowMs}
                    overdueAlertMs={TIMING_CONFIG.overdueAlertMs}
                    canAcknowledge={capabilities.canAcknowledgeAlert}
                    canResolve={capabilities.canResolveAlert}
                    isSubmitting={updateAlertWorkflowMutation.isPending}
                    onUpdateWorkflow={handleUpdateAlertWorkflow}
                    onAcknowledgeRoomAlerts={handleAcknowledgeRoomAlerts}
                    onFlyToAlert={focusAlertOnMap}
                  />
                )}

                {/* Interactive Furniture Layer Editor (1:100 Real-World Meters) */}
                {furnitureEditMode && canEditFurnitureInCurrentView && (
                  <FurnitureLayerEditor
                    room={selectedRoom}
                    roomPolygon={selectedRoomPolygon}
                    catalog={FURNITURE_CATALOG}
                    hideSensitive={hideSensitiveFurniture}
                    items={selectedRoomFurnitureItems}
                    canUndo={
                      (selectedRoomFurnitureHistory?.past.length ?? 0) > 0
                    }
                    canRedo={
                      (selectedRoomFurnitureHistory?.future.length ?? 0) > 0
                    }
                    selectedIds={selectedFurnitureIds}
                    onSelectIds={setSelectedFurnitureIds}
                    onCommitItems={(nextItems) =>
                      commitRoomFurnitureItems(selectedRoom.id, nextItems)
                    }
                    onUndo={() => handleUndoFurniture(selectedRoom.id)}
                    onRedo={() => handleRedoFurniture(selectedRoom.id)}
                    validation={selectedRoomFurnitureValidation}
                    snapEnabled={snapFurnitureGrid}
                    onSnapEnabledChange={setSnapFurnitureGrid}
                    showLayer={showFurnitureLayer}
                    onShowLayerChange={setShowFurnitureLayer}
                    opacity={furnitureOpacity}
                    onOpacityChange={setFurnitureOpacity}
                    version={selectedRoomServerFurniture?.version ?? null}
                    updatedBy={selectedRoomServerFurniture?.updatedBy}
                    updatedAt={selectedRoomServerFurniture?.updatedAt}
                    auditHistory={
                      selectedRoomServerFurniture?.auditHistory ?? []
                    }
                    isSaving={updateFurnitureMutation.isPending}
                    hasConflict={furnitureConflictRoomId === selectedRoom.id}
                    errorMessage={furnitureErrorMsg}
                    isReadOnlyPreset={selectedRoom.id.startsWith('PRESET_')}
                    onSave={(note) =>
                      void handleSaveFurniture(selectedRoom.id, note)
                    }
                    onReload={() => void handleReloadFurniture(selectedRoom.id)}
                    onExitEdit={() => {
                      setFurnitureEditMode(false);
                      setSelectedFurnitureIds([]);
                    }}
                  />
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
                {!isStudentView &&
                  (capabilities.canViewDevices ||
                    selectedRoomDevices.length > 0) && (
                    <CollapsibleSection
                      key={focusedDeviceId ? 'dev-open' : 'dev-closed'}
                      title="Thiết bị cảm biến"
                      badge={
                        <span className="badge-neutral">
                          {selectedRoomDevices.length} trạm
                        </span>
                      }
                      compact
                      defaultOpen={Boolean(focusedDeviceId)}
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
                            const isDevFocused =
                              focusedDeviceId === d.id ||
                              focusedDeviceId === d.hardwareId;
                            return (
                              <div
                                key={d.id}
                                onClick={() => setFocusedDeviceId(d.id)}
                                className={`flex cursor-pointer items-center justify-between rounded-md border p-2 text-xs transition-colors ${
                                  isDevFocused
                                    ? 'border-rose-500 bg-rose-50/60 ring-1 ring-rose-300'
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
          </div>

          {/* Grouped & Prioritized Map Alert Queue */}
          {!isStudentView && activeAlerts.length > 0 && (
            <MapAlertQueuePanel
              alerts={activeAlerts}
              rooms={allBuildingRooms}
              nowMs={nowMs}
              overdueAlertMs={TIMING_CONFIG.overdueAlertMs}
              canAcknowledge={capabilities.canAcknowledgeAlert}
              isSubmitting={updateAlertWorkflowMutation.isPending}
              onFlyToAlert={focusAlertOnMap}
              onAcknowledgeRoomAlerts={handleAcknowledgeRoomAlerts}
            />
          )}

          {/* ISA-101 Color Scale & Geometric Status Legend */}
          <FloorplanLegend
            layer={selectedLayer}
            onlyExceedingThreshold={onlyExceedingThreshold}
            activeRoomTypes={visibleFloorRooms.map((r) => r.type ?? 'STUDY_ROOM')}
            showReliabilityKey={showReliabilityLayer}
          />

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
                const tel = effectiveRoomTelemetryMap[room.id];
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
