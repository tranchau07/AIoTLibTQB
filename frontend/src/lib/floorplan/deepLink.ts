import {
  DEFAULT_FLOORPLAN_CONFIG,
  ZOOM_CONFIG,
  type ManagerStatusFilter,
} from '@/config/floorplan-hmi.config';
import type { HeatmapLayerMetric } from '@/config/thresholds';
import type { FloorplanTimeMode } from '@/lib/floorplan/timeAnalysis';

export interface FloorplanUrlState {
  floor: number;
  roomId: string | null;
  deviceId?: string | null;
  hardwareId?: string | null;
  alertId?: string | null;
  layer: HeatmapLayerMetric;
  scale: number;
  tx: number;
  ty: number;
  timeMode: FloorplanTimeMode;
  hour?: number;
  statusFilter: ManagerStatusFilter;
}

const VALID_LAYERS = new Set<HeatmapLayerMetric>([
  'comfortScore',
  'noiseAvg',
  'pm2_5',
  'temperature',
  'humidity',
  'lux',
  'wifiRssi',
]);

const VALID_TIME_MODES = new Set<FloorplanTimeMode>([
  'live',
  'compare_1h',
  'playback',
  'typical_day',
]);

const VALID_STATUS_FILTERS = new Set<ManagerStatusFilter>([
  'ALL',
  'ALERTS',
  'OVERDUE',
  'GOOD',
  'ATTENTION',
  'POOR',
]);

export const DEFAULT_FLOORPLAN_URL_STATE: FloorplanUrlState = {
  floor: DEFAULT_FLOORPLAN_CONFIG.defaultFloor,
  roomId: null,
  deviceId: null,
  hardwareId: null,
  alertId: null,
  layer: DEFAULT_FLOORPLAN_CONFIG.defaultLayer,
  scale: 1,
  tx: 0,
  ty: 0,
  timeMode: 'live',
  hour: 15,
  statusFilter: 'ALL',
};

export function serializeFloorplanUrlState(
  state: FloorplanUrlState
): string {
  const params = new URLSearchParams();
  const safeScale =
    Number.isFinite(state.scale) && state.scale > ZOOM_CONFIG.minScale
      ? Math.min(ZOOM_CONFIG.maxScale, Number(state.scale.toFixed(3)))
      : 1;
  const safeTx = safeScale <= 1.001 || !Number.isFinite(state.tx) ? 0 : Math.min(0, Number(state.tx.toFixed(2)));
  const safeTy = safeScale <= 1.001 || !Number.isFinite(state.ty) ? 0 : Math.min(0, Number(state.ty.toFixed(2)));

  params.set('floor', String(state.floor));
  if (state.roomId) params.set('roomId', state.roomId);
  if (state.deviceId) params.set('deviceId', state.deviceId);
  if (state.hardwareId) params.set('hardwareId', state.hardwareId);
  if (state.alertId) params.set('alertId', state.alertId);
  params.set('layer', state.layer);
  params.set('scale', String(safeScale));
  params.set('tx', String(safeTx));
  params.set('ty', String(safeTy));
  params.set('timeMode', state.timeMode);
  if (state.timeMode === 'typical_day' && state.hour !== undefined) {
    params.set('hour', String(Math.max(7, Math.min(21, Math.round(state.hour)))));
  }
  params.set('statusFilter', state.statusFilter);
  return params.toString();
}

export function parseFloorplanUrlState(
  searchOrParams: string | URLSearchParams,
  validFloors: readonly number[] = [1, 2, 3, 4, 5],
  defaults: Partial<FloorplanUrlState> = {}
): FloorplanUrlState {
  const fallback: FloorplanUrlState = {
    ...DEFAULT_FLOORPLAN_URL_STATE,
    ...defaults,
  };
  const params =
    typeof searchOrParams === 'string'
      ? new URLSearchParams(
          searchOrParams.startsWith('?')
            ? searchOrParams.slice(1)
            : searchOrParams
        )
      : searchOrParams;

  const rawFloor = params.get('floor');
  const parsedFloor = rawFloor !== null ? Number(rawFloor) : NaN;
  const floor =
    Number.isInteger(parsedFloor) && validFloors.includes(parsedFloor)
      ? parsedFloor
      : fallback.floor;

  const rawLayer = params.get('layer');
  const layer =
    rawLayer && VALID_LAYERS.has(rawLayer as HeatmapLayerMetric)
      ? (rawLayer as HeatmapLayerMetric)
      : fallback.layer;

  const rawScale = params.get('scale');
  const parsedScale = rawScale !== null && rawScale.trim() !== '' ? Number(rawScale) : NaN;
  const scale = Number.isFinite(parsedScale)
    ? Number(
        Math.max(
          ZOOM_CONFIG.minScale,
          Math.min(ZOOM_CONFIG.maxScale, parsedScale)
        ).toFixed(3)
      )
    : fallback.scale;

  const rawTx = params.get('tx');
  const parsedTx = rawTx !== null && rawTx.trim() !== '' ? Number(rawTx) : NaN;
  const tx =
    scale <= 1.001 || !Number.isFinite(parsedTx)
      ? 0
      : Math.min(0, Number(parsedTx.toFixed(2)));

  const rawTy = params.get('ty');
  const parsedTy = rawTy !== null && rawTy.trim() !== '' ? Number(rawTy) : NaN;
  const ty =
    scale <= 1.001 || !Number.isFinite(parsedTy)
      ? 0
      : Math.min(0, Number(parsedTy.toFixed(2)));

  const rawTimeMode = params.get('timeMode');
  const timeMode =
    rawTimeMode && VALID_TIME_MODES.has(rawTimeMode as FloorplanTimeMode)
      ? (rawTimeMode as FloorplanTimeMode)
      : fallback.timeMode;

  const rawHour = params.get('hour');
  const parsedHour = rawHour !== null && rawHour.trim() !== '' ? Number(rawHour) : NaN;
  const hour = Number.isFinite(parsedHour)
    ? Math.max(7, Math.min(21, Math.round(parsedHour)))
    : fallback.hour;

  const rawStatusFilter = params.get('statusFilter') ?? params.get('alertFilter');
  const statusFilter =
    rawStatusFilter && VALID_STATUS_FILTERS.has(rawStatusFilter as ManagerStatusFilter)
      ? (rawStatusFilter as ManagerStatusFilter)
      : fallback.statusFilter;

  const cleanOpt = (key: string): string | null => {
    const val = params.get(key)?.trim();
    return val ? val : null;
  };

  return {
    floor,
    roomId: cleanOpt('roomId') ?? fallback.roomId ?? null,
    deviceId: cleanOpt('deviceId') ?? fallback.deviceId ?? null,
    hardwareId: cleanOpt('hardwareId') ?? fallback.hardwareId ?? null,
    alertId: cleanOpt('alertId') ?? fallback.alertId ?? null,
    layer,
    scale,
    tx,
    ty,
    timeMode,
    hour,
    statusFilter,
  };
}

export function buildFloorplanShareUrl(
  state: FloorplanUrlState,
  origin?: string,
  pathname = '/floorplan'
): string {
  const query = serializeFloorplanUrlState(state);
  const resolvedOrigin =
    origin ?? (typeof window !== 'undefined' ? window.location.origin : '');
  return resolvedOrigin ? `${resolvedOrigin}${pathname}?${query}` : `${pathname}?${query}`;
}
