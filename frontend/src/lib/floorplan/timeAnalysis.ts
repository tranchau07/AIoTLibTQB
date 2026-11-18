import {
  buildPresetFallbackTelemetry,
  resolveRoomPolygon,
  resolveRoomPreset,
} from '@/config/tqb-floorplan-presets';
import {
  resolveGradeFromScore,
  type HeatmapLayerMetric,
} from '@/config/thresholds';
import { computeVisualPolygonCenter } from '@/lib/floorplan/polygon';
import {
  getMetricStatusSymbol,
  type MetricStatusEvaluation,
} from '@/lib/floorplan/weatherPalette';
import { FLOORPLAN_I18N_VI } from '@/messages/vi';
import type {
  BucketDataPoint,
  RoomResponse,
  TelemetryResponse,
} from '@/types/api';

export type FloorplanTimeMode =
  | 'live'
  | 'compare_1h'
  | 'playback'
  | 'typical_day';

export type TrendDirection = 'UP' | 'DOWN' | 'STABLE';

export interface OneHourDeltaResult {
  readonly delta: number | null;
  readonly previousValue: number | null;
  readonly trend: TrendDirection;
  readonly arrow: '↑' | '↓' | '→';
  readonly text: string;
  readonly textWithContext: string;
  readonly hasBaseline: boolean;
  readonly baselineTime: string | null;
}

const ONE_HOUR_MS = 60 * 60 * 1000;

const STABLE_DEADBANDS: Record<HeatmapLayerMetric, number> = {
  comfortScore: 2.0,
  temperature: 0.3,
  noiseAvg: 1.5,
  humidity: 2.0,
  pm2_5: 2.0,
  lux: 20.0,
  wifiRssi: 3.0,
};

export function extractBucketMetricValue(
  dp: (BucketDataPoint & { wifiRssiAvg?: number }) | null | undefined,
  layer: HeatmapLayerMetric
): number | null {
  if (!dp) return null;
  let val: number | undefined;
  switch (layer) {
    case 'comfortScore':
      val = dp.comfortScoreAvg;
      break;
    case 'temperature':
      val = dp.tempAvg;
      break;
    case 'noiseAvg':
      val = dp.noiseAvg;
      break;
    case 'humidity':
      val = dp.humidityAvg;
      break;
    case 'pm2_5':
      val = dp.pm25Avg;
      break;
    case 'lux':
      val = dp.luxAvg;
      break;
    case 'wifiRssi':
      val = dp.wifiRssiAvg;
      break;
  }
  return typeof val === 'number' && Number.isFinite(val) ? val : null;
}

function formatMetricDeltaText(
  delta: number,
  metric: HeatmapLayerMetric
): string {
  const sign = delta > 0 ? '+' : '';
  switch (metric) {
    case 'comfortScore': {
      const decimals = Math.abs(delta - Math.round(delta)) < 0.05 ? 0 : 1;
      const formatted = decimals === 0 ? String(Math.round(delta)) : delta.toFixed(1);
      return `${sign}${formatted}đ`;
    }
    case 'temperature':
      return `${sign}${delta.toFixed(1)}°C`;
    case 'noiseAvg':
      return `${sign}${delta.toFixed(1)} dBA`;
    case 'humidity':
      return `${sign}${delta.toFixed(1)}%RH`;
    case 'pm2_5':
      return `${sign}${delta.toFixed(1)} µg/m³`;
    case 'lux': {
      const decimals = Math.abs(delta - Math.round(delta)) < 0.05 ? 0 : 1;
      const formatted = decimals === 0 ? String(Math.round(delta)) : delta.toFixed(1);
      return `${sign}${formatted} lx`;
    }
    case 'wifiRssi': {
      const decimals = Math.abs(delta - Math.round(delta)) < 0.05 ? 0 : 1;
      const formatted = decimals === 0 ? String(Math.round(delta)) : delta.toFixed(1);
      return `${sign}${formatted} dBm`;
    }
  }
}

export function computeOneHourDelta(
  currentValue: number | null | undefined,
  buckets: readonly BucketDataPoint[] | null | undefined,
  metric: HeatmapLayerMetric,
  nowMs?: number
): OneHourDeltaResult {
  if (
    typeof currentValue !== 'number' ||
    !Number.isFinite(currentValue) ||
    !buckets ||
    buckets.length === 0
  ) {
    return {
      delta: null,
      previousValue: null,
      trend: 'STABLE',
      arrow: '→',
      text: FLOORPLAN_I18N_VI.timeAnalysis.noOneHourData,
      textWithContext: FLOORPLAN_I18N_VI.timeAnalysis.noOneHourData,
      hasBaseline: false,
      baselineTime: null,
    };
  }

  const validEntries = buckets
    .map((dp) => ({
      dp,
      ms: Date.parse(dp.bucketTime),
      val: extractBucketMetricValue(dp, metric),
    }))
    .filter(
      (item): item is { dp: BucketDataPoint; ms: number; val: number } =>
        Number.isFinite(item.ms) &&
        item.val !== null &&
        Number.isFinite(item.val)
    )
    .sort((a, b) => a.ms - b.ms);

  if (validEntries.length === 0) {
    return {
      delta: null,
      previousValue: null,
      trend: 'STABLE',
      arrow: '→',
      text: FLOORPLAN_I18N_VI.timeAnalysis.noOneHourData,
      textWithContext: FLOORPLAN_I18N_VI.timeAnalysis.noOneHourData,
      hasBaseline: false,
      baselineTime: null,
    };
  }

  const latestMs = validEntries[validEntries.length - 1].ms;
  const runtimeNow = Date.now();
  const anchorNowMs =
    nowMs !== undefined && Number.isFinite(nowMs)
      ? nowMs
      : validEntries.length >= 2 &&
          (Math.abs(runtimeNow - latestMs) > 2 * ONE_HOUR_MS ||
            latestMs > runtimeNow + 60_000)
        ? latestMs
        : runtimeNow;

  const targetOneHourAgoMs = anchorNowMs - ONE_HOUR_MS;
  let best = validEntries[0];
  let bestDiff = Math.abs(best.ms - targetOneHourAgoMs);

  for (let i = 1; i < validEntries.length; i++) {
    const diff = Math.abs(validEntries[i].ms - targetOneHourAgoMs);
    if (diff < bestDiff) {
      best = validEntries[i];
      bestDiff = diff;
    }
  }

  const rawDelta = currentValue - best.val;
  const delta = Number(rawDelta.toFixed(2));
  const deadband = STABLE_DEADBANDS[metric];

  let trend: TrendDirection = 'STABLE';
  let arrow: '↑' | '↓' | '→' = '→';
  if (Math.abs(delta) >= deadband) {
    if (delta > 0) {
      trend = 'UP';
      arrow = '↑';
    } else if (delta < 0) {
      trend = 'DOWN';
      arrow = '↓';
    }
  }

  const formattedVal = formatMetricDeltaText(delta, metric);
  const text = `${arrow} ${formattedVal}`;

  return {
    delta,
    previousValue: Number(best.val.toFixed(2)),
    trend,
    arrow,
    text,
    textWithContext: `${text} ${FLOORPLAN_I18N_VI.timeAnalysis.comparedOneHourAgo}`,
    hasBaseline: true,
    baselineTime: best.dp.bucketTime,
  };
}

export function bucketPointToTelemetryResponse(
  room: Pick<RoomResponse, 'id' | 'code'>,
  dp: BucketDataPoint,
  fallbackTelemetry?: TelemetryResponse | null
): TelemetryResponse {
  const overall =
    typeof dp.comfortScoreAvg === 'number' && Number.isFinite(dp.comfortScoreAvg)
      ? Number(dp.comfortScoreAvg.toFixed(1))
      : fallbackTelemetry?.comfortScore?.overall ?? null;
  const grade = resolveGradeFromScore(overall);
  const noiseAvg =
    typeof dp.noiseAvg === 'number' && Number.isFinite(dp.noiseAvg)
      ? Number(dp.noiseAvg.toFixed(1))
      : fallbackTelemetry?.acoustics?.noiseAvg ?? null;
  const temperature =
    typeof dp.tempAvg === 'number' && Number.isFinite(dp.tempAvg)
      ? Number(dp.tempAvg.toFixed(1))
      : fallbackTelemetry?.environment?.temperature ?? null;
  const humidity =
    typeof dp.humidityAvg === 'number' && Number.isFinite(dp.humidityAvg)
      ? Number(dp.humidityAvg.toFixed(1))
      : fallbackTelemetry?.environment?.humidity ?? null;
  const lux =
    typeof dp.luxAvg === 'number' && Number.isFinite(dp.luxAvg)
      ? Math.round(dp.luxAvg)
      : fallbackTelemetry?.environment?.lux ?? null;
  const pm2_5 =
    typeof dp.pm25Avg === 'number' && Number.isFinite(dp.pm25Avg)
      ? Number(dp.pm25Avg.toFixed(1))
      : fallbackTelemetry?.airQuality?.pm2_5 ?? null;

  return {
    id: `HIST_${room.id}_${dp.bucketTime}`,
    timestamp: dp.bucketTime,
    metadata: fallbackTelemetry?.metadata ?? {
      deviceId: `HIST_DEV_${room.id}`,
      hardwareId: `HIST_${room.code}`,
      roomId: room.id,
    },
    acoustics: {
      noiseAvg,
      noisePeak:
        typeof dp.noiseMax === 'number' && Number.isFinite(dp.noiseMax)
          ? Number(dp.noiseMax.toFixed(1))
          : noiseAvg !== null
            ? Number((noiseAvg + 4.5).toFixed(1))
            : null,
    },
    airQuality: {
      pm1_0: pm2_5 !== null ? Number((pm2_5 * 0.65).toFixed(1)) : null,
      pm2_5,
      pm4_0: pm2_5 !== null ? Number((pm2_5 * 1.2).toFixed(1)) : null,
      pm10: pm2_5 !== null ? Number((pm2_5 * 1.5).toFixed(1)) : null,
    },
    environment: {
      temperature,
      humidity,
      lux,
    },
    comfortScore: {
      overall,
      grade: grade === 'N/A' ? null : grade,
      acousticScore: fallbackTelemetry?.comfortScore?.acousticScore ?? null,
      airScore: fallbackTelemetry?.comfortScore?.airScore ?? null,
      thermalScore: fallbackTelemetry?.comfortScore?.thermalScore ?? null,
      lightScore: fallbackTelemetry?.comfortScore?.lightScore ?? null,
    },
    wifiRssi: fallbackTelemetry?.wifiRssi ?? -58,
    isSynthetic: false,
  };
}

export type PlaybackPropagationRole =
  | 'ORIGIN'
  | 'SPREAD'
  | 'RECOVERED'
  | 'NORMAL';

export interface PlaybackRoomState {
  readonly roomId: string;
  readonly roomCode: string;
  readonly shortCode: string;
  readonly value: number | null;
  readonly evaluation: MetricStatusEvaluation;
  readonly isExceeding: boolean;
  readonly rank: number | null;
  readonly propagationRole: PlaybackPropagationRole;
  readonly propagationLabelVi: string | null;
}

export interface EventPlaybackFrame {
  readonly frameIndex: number;
  readonly timestamp: string;
  readonly timestampMs: number;
  readonly telemetryByRoomId: Record<string, TelemetryResponse>;
  readonly roomStates: Record<string, PlaybackRoomState>;
  readonly originRoomId: string | null;
  readonly originRoomCode: string | null;
  readonly exceedingRooms: ReadonlyArray<PlaybackRoomState>;
}

const CARRY_FORWARD_MAX_MS = 30 * 60 * 1000;

export function buildEventPlaybackFrames(
  rooms: readonly RoomResponse[],
  roomBucketsByRoomId: Record<string, readonly BucketDataPoint[] | undefined>,
  metric: HeatmapLayerMetric,
  fallbackTelemetryMap?: Record<string, TelemetryResponse | null | undefined>
): EventPlaybackFrame[] {
  const uniqueTimes = new Map<number, string>();
  const sortedBucketsByRoom = new Map<
    string,
    Array<{ ms: number; dp: BucketDataPoint }>
  >();

  for (const room of rooms) {
    const raw = roomBucketsByRoomId[room.id] ?? [];
    const parsed = raw
      .map((dp) => ({ ms: Date.parse(dp.bucketTime), dp }))
      .filter((item) => Number.isFinite(item.ms))
      .sort((a, b) => a.ms - b.ms);
    sortedBucketsByRoom.set(room.id, parsed);
    for (const item of parsed) {
      if (!uniqueTimes.has(item.ms)) {
        uniqueTimes.set(item.ms, item.dp.bucketTime);
      }
    }
  }

  const timeline = Array.from(uniqueTimes.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([ms, iso]) => ({ ms, iso }));

  if (timeline.length === 0) return [];

  const firstExceededRank = new Map<string, number>();
  let nextRank = 1;
  let globalOriginRoomId: string | null = null;
  let globalOriginRoomCode: string | null = null;

  return timeline.map((slot, frameIndex) => {
    const telemetryByRoomId: Record<string, TelemetryResponse> = {};
    const evaluations = new Map<
      string,
      {
        room: RoomResponse;
        value: number | null;
        evaluation: MetricStatusEvaluation;
      }
    >();
    const newlyExceedingInFrame: Array<{
      room: RoomResponse;
      value: number;
      evaluation: MetricStatusEvaluation;
    }> = [];

    for (const room of rooms) {
      const roomPoints = sortedBucketsByRoom.get(room.id) ?? [];
      let matched: { ms: number; dp: BucketDataPoint } | null = null;
      for (const item of roomPoints) {
        if (item.ms === slot.ms) {
          matched = item;
          break;
        }
        if (item.ms < slot.ms && slot.ms - item.ms <= CARRY_FORWARD_MAX_MS) {
          matched = item;
        }
      }

      const value = matched ? extractBucketMetricValue(matched.dp, metric) : null;
      const roomType = room.type ?? 'STUDY_ROOM';
      const evaluation = getMetricStatusSymbol(
        metric,
        value,
        roomType,
        room.thresholds
      );

      if (matched) {
        telemetryByRoomId[room.id] = bucketPointToTelemetryResponse(
          room,
          matched.dp,
          fallbackTelemetryMap?.[room.id]
        );
      }

      evaluations.set(room.id, { room, value, evaluation });
      if (
        evaluation.isExceedingThreshold &&
        value !== null &&
        !firstExceededRank.has(room.id)
      ) {
        newlyExceedingInFrame.push({ room, value, evaluation });
      }
    }

    // Break same-frame ties by severity (CRITICAL > WARNING), then higher deviation
    newlyExceedingInFrame.sort((a, b) => {
      const aSev = a.evaluation.level === 'CRITICAL' ? 2 : 1;
      const bSev = b.evaluation.level === 'CRITICAL' ? 2 : 1;
      if (aSev !== bSev) return bSev - aSev;
      if (metric === 'comfortScore' || metric === 'wifiRssi') {
        return a.value - b.value;
      }
      return b.value - a.value;
    });

    for (const item of newlyExceedingInFrame) {
      const rank = nextRank++;
      firstExceededRank.set(item.room.id, rank);
      if (rank === 1) {
        globalOriginRoomId = item.room.id;
        globalOriginRoomCode = item.room.code;
      }
    }

    const roomStates: Record<string, PlaybackRoomState> = {};
    const exceedingRooms: PlaybackRoomState[] = [];

    for (const room of rooms) {
      const item = evaluations.get(room.id)!;
      const rank = firstExceededRank.get(room.id) ?? null;
      let propagationRole: PlaybackPropagationRole = 'NORMAL';
      let propagationLabelVi: string | null = null;

      if (item.evaluation.isExceedingThreshold && rank !== null) {
        if (rank === 1) {
          propagationRole = 'ORIGIN';
          propagationLabelVi = FLOORPLAN_I18N_VI.timeAnalysis.playbackOrigin(1);
        } else {
          propagationRole = 'SPREAD';
          propagationLabelVi = FLOORPLAN_I18N_VI.timeAnalysis.playbackSpread(rank);
        }
      } else if (rank !== null) {
        propagationRole = 'RECOVERED';
        propagationLabelVi = FLOORPLAN_I18N_VI.timeAnalysis.playbackRecovered;
      }

      const state: PlaybackRoomState = {
        roomId: room.id,
        roomCode: room.code,
        shortCode: room.code.replace(/^TQB_/, 'P.'),
        value: item.value,
        evaluation: item.evaluation,
        isExceeding: item.evaluation.isExceedingThreshold,
        rank,
        propagationRole,
        propagationLabelVi,
      };
      roomStates[room.id] = state;
      if (state.isExceeding) {
        exceedingRooms.push(state);
      }
    }

    exceedingRooms.sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));

    return {
      frameIndex,
      timestamp: slot.iso,
      timestampMs: slot.ms,
      telemetryByRoomId,
      roomStates,
      originRoomId: globalOriginRoomId,
      originRoomCode: globalOriginRoomCode,
      exceedingRooms,
    };
  });
}

export interface TypicalDaySnapshotResult {
  readonly hour: number;
  readonly hourLabel: string;
  readonly telemetryByRoomId: Record<string, TelemetryResponse>;
  readonly isHistoricalObserved: boolean;
  readonly westWingTempAvg: number | null;
  readonly nonWestWingTempAvg: number | null;
  readonly summaryNoteVi: string;
}

function clampTypicalHour(hour: number): number {
  if (!Number.isFinite(hour)) return 15;
  return Math.max(7, Math.min(21, Math.round(hour)));
}

function formatHourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

export function computeTypicalDayFloorSnapshot(
  rooms: readonly RoomResponse[],
  selectedHour: number,
  roomBucketsByRoomId?: Record<string, readonly BucketDataPoint[] | undefined>,
  baseTelemetryMap?: Record<string, TelemetryResponse | null | undefined>
): TypicalDaySnapshotResult {
  const hour = clampTypicalHour(selectedHour);
  const hourLabel = formatHourLabel(hour);

  // Morning occupancy bump (09-11h) & afternoon rush (14-16:30h)
  const morningRush = Math.exp(-Math.pow(hour - 10.0, 2) / (2 * 1.45 * 1.45));
  const afternoonRush = Math.exp(-Math.pow(hour - 15.0, 2) / (2 * 1.65 * 1.65));
  const crowdFactor = Math.max(0.12, Math.min(1.0, 0.2 + 0.65 * morningRush + 0.78 * afternoonRush));

  // Afternoon solar gain on West-facing curtain walls (peaking 14:30-16:30)
  const afternoonSolarCurve = Math.exp(-Math.pow(hour - 15.2, 2) / (2 * 2.1 * 2.1));
  const middayWarmth = Math.max(0, Math.sin(((hour - 7) / 14) * Math.PI)) * 0.9;

  const telemetryByRoomId: Record<string, TelemetryResponse> = {};
  let observedRoomsCount = 0;
  let westTempSum = 0;
  let westCount = 0;
  let eastCenterTempSum = 0;
  let eastCenterCount = 0;

  rooms.forEach((room, idx) => {
    const preset = resolveRoomPreset(room, idx);
    const poly = resolveRoomPolygon(room, idx);
    const centroid =
      poly && poly.length >= 3
        ? computeVisualPolygonCenter(poly)
        : { x: 0.5, y: 0.5 };
    const westExposure =
      centroid.x < 0.35
        ? 1.0
        : centroid.x < 0.5
          ? Math.max(0, (0.5 - centroid.x) / 0.15)
          : 0.0;

    const roomType = room.type ?? preset?.roomType ?? 'STUDY_ROOM';
    const baseTel =
      baseTelemetryMap?.[room.id] ?? buildPresetFallbackTelemetry(room, idx);

    const baseTemp = baseTel.environment?.temperature ?? 22.8;
    const baseHum = baseTel.environment?.humidity ?? 52.0;
    const baseNoise = baseTel.acoustics?.noiseAvg ?? (roomType === 'CIRCULATION_HALL' ? 49 : 41);
    const baseLux = baseTel.environment?.lux ?? 400;
    const basePm = baseTel.airQuality?.pm2_5 ?? 12.5;

    // Architectural diurnal model
    const modelTemp =
      roomType === 'BOOK_STORAGE'
        ? baseTemp + middayWarmth * 0.4 + afternoonSolarCurve * westExposure * 0.8
        : baseTemp + middayWarmth + afternoonSolarCurve * westExposure * 2.7;
    const modelNoise =
      roomType === 'BOOK_STORAGE'
        ? baseNoise + crowdFactor * 1.8
        : roomType === 'CIRCULATION_HALL'
          ? baseNoise + crowdFactor * 7.5
          : baseNoise + crowdFactor * 6.2;
    const modelLux =
      roomType === 'BOOK_STORAGE'
        ? baseLux
        : baseLux + afternoonSolarCurve * westExposure * 210 + (hour >= 18 ? -40 : 30);
    const modelPm = basePm + crowdFactor * 5.2;
    const modelHum =
      roomType === 'BOOK_STORAGE'
        ? Math.max(42, Math.min(62, baseHum - afternoonSolarCurve * 1.5))
        : Math.max(38, Math.min(72, baseHum - afternoonSolarCurve * westExposure * 3.5));

    // Blend with observed historical buckets matching `hour` when provided
    const matchingBuckets = (roomBucketsByRoomId?.[room.id] ?? []).filter((dp) => {
      const d = new Date(dp.bucketTime);
      return !Number.isNaN(d.getTime()) && d.getHours() === hour;
    });
    const distinctDays = new Set(
      matchingBuckets.map((dp) => dp.bucketTime.slice(0, 10))
    ).size;

    let temp = modelTemp;
    let noiseAvg = modelNoise;
    let humidity = modelHum;
    let lux = modelLux;
    let pm25 = modelPm;
    let obsWeight = 0;

    if (matchingBuckets.length > 0) {
      const avgOf = (getter: (dp: BucketDataPoint) => number | undefined): number | null => {
        const vals = matchingBuckets
          .map(getter)
          .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
        return vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
      };
      obsWeight = distinctDays >= 7 ? 1.0 : Math.min(0.85, distinctDays / 7);
      if (obsWeight > 0) {
        if (distinctDays >= 7) observedRoomsCount += 1;
        const oTemp = avgOf((d) => d.tempAvg);
        const oNoise = avgOf((d) => d.noiseAvg);
        const oHum = avgOf((d) => d.humidityAvg);
        const oLux = avgOf((d) => d.luxAvg);
        const oPm = avgOf((d) => d.pm25Avg);
        if (oTemp !== null) temp = oTemp * obsWeight + modelTemp * (1 - obsWeight);
        if (oNoise !== null) noiseAvg = oNoise * obsWeight + modelNoise * (1 - obsWeight);
        if (oHum !== null) humidity = oHum * obsWeight + modelHum * (1 - obsWeight);
        if (oLux !== null) lux = oLux * obsWeight + modelLux * (1 - obsWeight);
        if (oPm !== null) pm25 = oPm * obsWeight + modelPm * (1 - obsWeight);
      }
    }

    const overall = Math.round(
      Math.max(
        35,
        Math.min(
          98,
          94 -
            Math.max(0, noiseAvg - 40) * 0.7 -
            Math.abs(temp - 22.8) * 3.8 -
            Math.max(0, pm25 - 15) * 0.45
        )
      )
    );
    const grade = resolveGradeFromScore(overall);

    const roundedTemp = Number(temp.toFixed(1));
    if (westExposure >= 0.6) {
      westTempSum += roundedTemp;
      westCount += 1;
    } else {
      eastCenterTempSum += roundedTemp;
      eastCenterCount += 1;
    }

    telemetryByRoomId[room.id] = {
      id: `TYPICAL_${room.id}_${hour}`,
      timestamp: new Date(2026, 0, 1, hour, 0, 0).toISOString(),
      metadata: baseTel.metadata,
      acoustics: {
        noiseAvg: Number(noiseAvg.toFixed(1)),
        noisePeak: Number((noiseAvg + 5.0).toFixed(1)),
      },
      airQuality: {
        pm1_0: Number((pm25 * 0.65).toFixed(1)),
        pm2_5: Number(pm25.toFixed(1)),
        pm4_0: Number((pm25 * 1.2).toFixed(1)),
        pm10: Number((pm25 * 1.5).toFixed(1)),
      },
      environment: {
        temperature: roundedTemp,
        humidity: Number(humidity.toFixed(1)),
        lux: Math.round(lux),
      },
      comfortScore: {
        overall,
        grade: grade === 'N/A' ? null : grade,
        acousticScore: Math.round(Math.max(40, 100 - Math.max(0, noiseAvg - 36) * 1.4)),
        airScore: Math.round(Math.max(45, 100 - pm25 * 0.85)),
        thermalScore: Math.round(Math.max(40, 100 - Math.abs(roundedTemp - 22.8) * 7.5)),
        lightScore: 88,
      },
      wifiRssi: baseTel.wifiRssi ?? -58,
      isSynthetic: obsWeight < 1,
    };
  });

  const isHistoricalObserved = observedRoomsCount > 0;
  const westWingTempAvg =
    westCount > 0 ? Number((westTempSum / westCount).toFixed(1)) : null;
  const nonWestWingTempAvg =
    eastCenterCount > 0 ? Number((eastCenterTempSum / eastCenterCount).toFixed(1)) : null;

  const summaryNoteVi =
    hour >= 14 && hour <= 17
      ? `${hourLabel} · ${FLOORPLAN_I18N_VI.timeAnalysis.typicalDayWestSunNote}${westWingTempAvg !== null ? ` (TB cánh Tây ${westWingTempAvg}°C)` : ''}`
      : isHistoricalObserved
        ? `${hourLabel} · ${FLOORPLAN_I18N_VI.timeAnalysis.typicalDayObservedNote}`
        : `${hourLabel} · ${FLOORPLAN_I18N_VI.timeAnalysis.typicalDayBaselineNote}`;

  return {
    hour,
    hourLabel,
    telemetryByRoomId,
    isHistoricalObserved,
    westWingTempAvg,
    nonWestWingTempAvg,
    summaryNoteVi,
  };
}
