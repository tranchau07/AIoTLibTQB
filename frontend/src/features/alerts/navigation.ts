import type { HeatmapLayerMetric } from '@/config/thresholds';
import type { AlertResponse, DeviceResponse, RoomResponse } from '@/types/api';

export interface AlertFloorplanTarget {
  alertId: string;
  roomId: string | null;
  deviceId: string | null;
  hardwareId: string | null;
  floor: number | null;
  layer: HeatmapLayerMetric;
  href: string;
}

function resolveAirOrSensorLayerFromMessage(
  message: string | null | undefined,
  fallback: HeatmapLayerMetric
): HeatmapLayerMetric {
  const msg = (message ?? '').toLowerCase();
  if (
    msg.includes('humidity') ||
    msg.includes('%rh') ||
    /(\d|\b)rh\b/.test(msg) ||
    msg.includes('ẩm')
  ) {
    return 'humidity';
  }
  if (
    msg.includes('temperature') ||
    msg.includes('°c') ||
    msg.includes('nhiệt')
  ) {
    return 'temperature';
  }
  if (
    msg.includes('pm2.5') ||
    msg.includes('pm2_5') ||
    msg.includes('µg/m³') ||
    msg.includes('bụi')
  ) {
    return 'pm2_5';
  }
  return fallback;
}

/**
 * Suy luận lớp bản đồ nhiệt (HeatmapLayerMetric) phù hợp nhất với loại cảnh báo sự cố.
 */
export function resolveAlertHeatmapLayer(
  alert: Pick<AlertResponse, 'type' | 'message'> & { metricType?: string | null }
): HeatmapLayerMetric {
  switch (alert.metricType?.trim()) {
    case 'NOISE_AVG':
    case 'NOISE_PEAK':
      return 'noiseAvg';
    case 'TEMPERATURE':
      return 'temperature';
    case 'HUMIDITY_HIGH':
    case 'HUMIDITY_LOW':
      return 'humidity';
    case 'PM2_5':
      return 'pm2_5';
    case 'DEVICE_OFFLINE':
      return 'wifiRssi';
    default:
      break;
  }

  switch (alert.type) {
    case 'NOISE_EXCEEDED':
      return 'noiseAvg';
    case 'AIR_UNHEALTHY':
      return resolveAirOrSensorLayerFromMessage(alert.message, 'pm2_5');
    case 'DEVICE_OFFLINE':
      return 'wifiRssi';
    case 'SENSOR_MALFUNCTION':
      return resolveAirOrSensorLayerFromMessage(alert.message, 'temperature');
    default:
      return 'comfortScore';
  }
}

/**
 * Phân giải tọa độ đích (Tầng, Phòng, Node cảm biến, Lớp Heatmap và URL deep-link)
 * từ một bản ghi cảnh báo để điều hướng trực tiếp tới đúng vị trí trên Bản đồ nhiệt 2D.
 */
export function resolveAlertFloorplanTarget(
  alert: Pick<AlertResponse, 'id' | 'type' | 'message'> & {
    metricType?: string | null;
    roomId?: string | null;
    deviceId?: string | null;
    hardwareId?: string | null;
  },
  rooms: ReadonlyArray<Pick<RoomResponse, 'id' | 'floor'>> = [],
  devices: ReadonlyArray<
    Pick<DeviceResponse, 'id' | 'hardwareId'> & { roomId?: string | null }
  > = []
): AlertFloorplanTarget {
  const matchedDevice =
    devices.find(
      (d) =>
        (alert.deviceId && d.id === alert.deviceId) ||
        (alert.hardwareId && d.hardwareId === alert.hardwareId)
    ) ?? null;

  const effectiveRoomId = alert.roomId ?? matchedDevice?.roomId ?? null;
  const matchedRoom =
    rooms.find((r) => r.id === effectiveRoomId) ?? null;

  const effectiveDeviceId = alert.deviceId ?? matchedDevice?.id ?? null;
  const effectiveHardwareId =
    alert.hardwareId ?? matchedDevice?.hardwareId ?? null;
  const effectiveFloor =
    matchedRoom?.floor != null
      ? matchedRoom.floor === 0
        ? 1
        : matchedRoom.floor
      : null;

  const layer = resolveAlertHeatmapLayer(alert);

  const params = new URLSearchParams();
  if (effectiveFloor !== null) {
    params.set('floor', String(effectiveFloor));
  }
  if (effectiveRoomId) {
    params.set('roomId', effectiveRoomId);
  }
  if (effectiveDeviceId) {
    params.set('deviceId', effectiveDeviceId);
  }
  if (effectiveHardwareId) {
    params.set('hardwareId', effectiveHardwareId);
  }
  params.set('layer', layer);
  params.set('alertId', alert.id);

  return {
    alertId: alert.id,
    roomId: effectiveRoomId,
    deviceId: effectiveDeviceId,
    hardwareId: effectiveHardwareId,
    floor: effectiveFloor,
    layer,
    href: `/floorplan?${params.toString()}`,
  };
}
