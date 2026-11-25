import { describe, expect, it, vi } from 'vitest';
import { createHttpClient, registerAuthTokenAccessor, unwrapEnvelope } from '@/lib/http/client';
import { ApiError, getFriendlyErrorMessage } from '@/lib/http/error-mapper';
import { SingleFlightRefreshCoordinator } from '@/lib/http/refresh-queue';
import { ERROR_MESSAGES_VI } from '@/messages/vi';
import { decodeJwtScope, parseScopeString } from '@/lib/rbac/scope-parser';
import { buildCapabilities } from '@/lib/rbac/capabilities';
import {
  computeBucketCount,
  escapeCsvCell,
  formatBottleneckReasonVi,
  formatMetrics,
  recommendIntervalForRange,
  validateBucketRange,
} from '@/lib/format/metrics';
import {
  formatRelativeTimeVi,
  isTelemetryStale,
} from '@/lib/format/datetime';
import { shouldAutoDismissToast } from '@/components/ui/primitives';
import {
  getGradeStyle,
  getMetricColorHex,
  resolveGradeFromScore,
  type HeatmapLayerMetric,
} from '@/config/thresholds';
import { computeIdwValue } from '@/lib/floorplan/idw';
import {
  computeVisualPolygonCenter,
  isPointInPolygon,
  validateBoundaryPolygon,
} from '@/lib/floorplan/polygon';
import {
  WEATHER_PALETTES,
  computeAdaptiveSigma,
  computeRoomBlindspotRatio,
  getContinuousMetricColor,
} from '@/lib/floorplan/weatherPalette';
import {
  TQB_BUILDING_ASPECT_RATIO,
  TQB_ROOM_PRESETS,
  buildPresetFallbackTelemetry,
  computeWayfindingPath,
  resolveRoomPreset,
  synthesizeAnonymousMicroZones,
} from '@/config/tqb-floorplan-presets';
import {
  extractLayerMetricValue,
  formatLayerMetricValue,
} from '@/features/floorplan/components/FloorplanCanvas';
import {
  resolveAlertFloorplanTarget,
  resolveAlertHeatmapLayer,
} from '@/features/alerts/navigation';
import { resolveAlertValueFormat } from '@/features/alerts/components/AlertBadges';
import {
  computeLabelPlacements,
  getLodConfig,
} from '@/lib/floorplan/labelLayout';
import {
  clampViewportTransform,
  computePinchScale,
  normalizedToPixel,
  pixelToNormalized,
} from '@/lib/floorplan/coords';
import {
  mergeRealtimeTelemetry,
  upsertRealtimeAlertList,
} from '@/lib/realtime/stomp-client';
import { useAuthStore } from '@/features/auth/store';
import type { AlertResponse, TelemetryResponse } from '@/types/api';

describe('1. HTTP Envelope & ErrorCode Mapper (FE-API-02, FE-API-03)', () => {
  it('unwraps result when code === 1000', () => {
    const res = unwrapEnvelope({ code: 1000, result: { ok: true } }, 200);
    expect(res).toEqual({ ok: true });
  });

  it('throws ApiError with Vietnamese message when code !== 1000', () => {
    expect(() =>
      unwrapEnvelope(
        { code: 5006, message: 'Cannot delete room with associated devices' },
        400
      )
    ).toThrowError(ApiError);

    try {
      unwrapEnvelope({ code: 5006 }, 400);
    } catch (e) {
      const err = e as ApiError;
      expect(err.code).toBe(5006);
      expect(err.message).toBe(ERROR_MESSAGES_VI[5006]);
    }
  });

  it('covers all registered ErrorCodes in ERROR_MESSAGES_VI', () => {
    const allCodes = [
      1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009, 1010,
      1011, 1012, 1013, 1014, 1015,
      2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008,
      3001, 3002, 3003, 3004, 3005, 3006, 3007, 3008,
      4029, 4031,
      5001, 5002, 5003, 5004, 5005, 5006, 5007, 5008,
      6001,
      7001, 7002, 7003,
      9001, 9002,
      9999,
    ];
    for (const c of allCodes) {
      expect(getFriendlyErrorMessage(c)).toBeTruthy();
      expect(getFriendlyErrorMessage(c)).not.toContain('Uncategorized');
    }
  });
});

describe('2. Single-Flight Refresh Queue (FE-AUTH-03)', () => {
  it('triggers /auth/refresh exactly ONCE when 5 concurrent requests receive 401', async () => {
    let accessToken = 'expired-token';
    let refreshToken = 'valid-refresh-token';
    let refreshCallCount = 0;

    registerAuthTokenAccessor({
      getAccessToken: () => accessToken,
      getRefreshToken: () => refreshToken,
      setTokens: (a, r) => {
        accessToken = a;
        refreshToken = r;
      },
      clearSession: () => {
        accessToken = '';
        refreshToken = '';
      },
    });

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/auth/refresh')) {
        refreshCallCount++;
        await new Promise((r) => setTimeout(r, 25));
        return new Response(
          JSON.stringify({
            code: 1000,
            result: { token: 'new-access-token', refreshToken: 'new-refresh-token' },
          }),
          { status: 200 }
        );
      }

      const authHeader = new Headers(init?.headers).get('Authorization');
      if (authHeader === 'Bearer expired-token') {
        return new Response(
          JSON.stringify({ code: 1006, message: 'Unauthenticated' }),
          { status: 401 }
        );
      }

      return new Response(
        JSON.stringify({ code: 1000, result: { data: url } }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const coordinator = new SingleFlightRefreshCoordinator();
    const client = createHttpClient(mockFetch, coordinator);

    const results = await Promise.all([
      client.get<{ data: string }>('/rooms'),
      client.get<{ data: string }>('/devices'),
      client.get<{ data: string }>('/alerts'),
      client.get<{ data: string }>('/telemetry/overview/summary'),
      client.get<{ data: string }>('/users/myInfo'),
    ]);

    expect(refreshCallCount).toBe(1);
    expect(results).toHaveLength(5);
    expect(accessToken).toBe('new-access-token');
  });

  it('calls clearSession and rejects all queued requests when refresh fails with 1006', async () => {
    let cleared = 0;
    registerAuthTokenAccessor({
      getAccessToken: () => 'expired-token',
      getRefreshToken: () => 'expired-refresh',
      setTokens: () => {},
      clearSession: () => {
        cleared++;
      },
    });

    const mockFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ code: 1006, message: 'Unauthenticated' }),
        { status: 401 }
      );
    }) as unknown as typeof fetch;

    const coordinator = new SingleFlightRefreshCoordinator();
    const client = createHttpClient(mockFetch, coordinator);

    const settled = await Promise.allSettled([
      client.get('/rooms'),
      client.get('/devices'),
      client.get('/alerts'),
    ]);

    expect(settled.every((s) => s.status === 'rejected')).toBe(true);
    expect(cleared).toBe(1);
  });
});

describe('3. RBAC Scope Parser & Capability Matrix (FE-RBAC-02, FE-RBAC-03)', () => {
  it('parses JWT scope and builds exact capabilities for LIBRARIAN, MAINTENANCE, ZONE_MANAGER, and USER', () => {
    const libScope = parseScopeString(
      'LIBRARIAN READ_SENSOR_DATA VIEW_ALERTS ACKNOWLEDGE_ALERT MANAGE_ALERT_CONFIG MANAGE_DEVICES',
      'lib01'
    );
    const libCap = buildCapabilities(libScope);
    expect(libCap.isLibrarian).toBe(true);
    expect(libCap.canManageRooms).toBe(true);
    expect(libCap.canEditFurniture).toBe(true);
    expect(libCap.canDeleteRoom).toBe(false);
    expect(libCap.canResolveAlert).toBe(true);
    expect(libCap.canManageUsers).toBe(false);

    const mntScope = parseScopeString(
      'MAINTENANCE READ_SENSOR_DATA VIEW_ALERTS ACKNOWLEDGE_ALERT VIEW_DEVICE_STATUS',
      'tech01'
    );
    const mntCap = buildCapabilities(mntScope);
    expect(mntCap.canViewDashboard).toBe(true);
    expect(mntCap.canViewDevices).toBe(true);
    expect(mntCap.canManageDevices).toBe(false);
    expect(mntCap.canEditFurniture).toBe(true);
    expect(mntCap.canAcknowledgeAlert).toBe(true);
    expect(mntCap.canResolveAlert).toBe(true);

    const zmScope = parseScopeString(
      'ZONE_MANAGER VIEW_ALERTS ACKNOWLEDGE_ALERT READ_SENSOR_DATA',
      'zm01'
    );
    const zmCap = buildCapabilities(zmScope);
    expect(zmCap.canEditFurniture).toBe(false);
    expect(zmCap.canAcknowledgeAlert).toBe(true);
    expect(zmCap.canResolveAlert).toBe(true);

    const viewerScope = parseScopeString('VIEWER VIEW_ALERTS READ_SENSOR_DATA', 'vw01');
    const viewerCap = buildCapabilities(viewerScope);
    expect(viewerCap.canViewAlerts).toBe(true);
    expect(viewerCap.canResolveAlert).toBe(false);

    const userScope = parseScopeString('USER', 'student01');
    const userCap = buildCapabilities(userScope);
    expect(userCap.canViewDashboard).toBe(true);
    expect(userCap.canEditFurniture).toBe(false);
    expect(userCap.canViewAlerts).toBe(false);
    expect(userCap.canViewDevices).toBe(false);
    expect(userCap.canResolveAlert).toBe(false);
  });

  it('decodes base64url JWT payload safely', () => {
    const payload = Buffer.from(
      JSON.stringify({ sub: 'admin', scope: 'ADMIN MANAGE_USERS VIEW_ALERTS' })
    ).toString('base64url');
    const token = `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
    const decoded = decodeJwtScope(token);
    expect(decoded.username).toBe('admin');
    expect(decoded.roles.has('ADMIN')).toBe(true);
    expect(decoded.permissions.has('MANAGE_USERS')).toBe(true);
  });
});

describe('4. Metrics, Grades, and Bucket Count Validation (FE-API-06, FE-API-09, FE-UI-04)', () => {
  it('formats nullable metrics with "--" placeholder', () => {
    expect(formatMetrics.temperature(24.56)).toBe('24.6 °C');
    expect(formatMetrics.temperature(null)).toBe('--');
    expect(formatMetrics.noise(43.2)).toBe('43.2 dBA');
  });

  it('maps ComfortScore to Platinum/Gold/Silver/Bronze/Poor/N/A', () => {
    expect(resolveGradeFromScore(92)).toBe('Platinum');
    expect(resolveGradeFromScore(80)).toBe('Gold');
    expect(resolveGradeFromScore(65)).toBe('Silver');
    expect(resolveGradeFromScore(50)).toBe('Bronze');
    expect(resolveGradeFromScore(30)).toBe('Poor');
    expect(resolveGradeFromScore(null)).toBe('N/A');
    expect(getGradeStyle('Platinum').hex).toBe('#10B981');
  });

  it('enforces max 1000 buckets and start < end', () => {
    const start = '2026-10-01T00:00:00Z';
    const end30Days = '2026-10-31T00:00:00Z';
    // 30 days at 15m = 2880 buckets > 1000
    const check15m = validateBucketRange(start, end30Days, '15m');
    expect(check15m.valid).toBe(false);
    expect(check15m.errorCode).toBe(7002);

    // 30 days at 1h = 720 buckets <= 1000
    const check1h = validateBucketRange(start, end30Days, '1h');
    expect(check1h.valid).toBe(true);
    expect(check1h.bucketCount).toBe(720);

    expect(recommendIntervalForRange(start, end30Days)).toBe('1d');
    expect(computeBucketCount(end30Days, start, '1h')).toBe(0);
    expect(formatRelativeTimeVi(null)).toBe('Chưa từng kết nối');
  });
});

describe('5. Spatial Floorplan IDW & Polygon Geometry (FE-VIZ-04, FE-VIZ-05, FE-VIZ-08)', () => {
  it('computes IDW interpolation accurately and ignores OFFLINE devices', () => {
    const samples = [
      { x: 0.2, y: 0.2, value: 40, online: true },
      { x: 0.8, y: 0.8, value: 80, online: true },
      { x: 0.2, y: 0.2, value: 999, online: false }, // offline ignored
    ];
    // Midpoint (0.5, 0.5) has equal distance to both online sensors -> average = 60
    const midVal = computeIdwValue(0.5, 0.5, samples);
    expect(midVal).toBeCloseTo(60, 3);

    // Exact sensor coordinate returns exact value
    expect(computeIdwValue(0.2, 0.2, samples)).toBeCloseTo(40, 4);
  });

  it('validates polygon vertices, self-intersection, and point-in-polygon', () => {
    const validRect = [
      { x: 0.1, y: 0.1 },
      { x: 0.5, y: 0.1 },
      { x: 0.5, y: 0.5 },
      { x: 0.1, y: 0.5 },
    ];
    expect(validateBoundaryPolygon(validRect).valid).toBe(true);
    expect(isPointInPolygon({ x: 0.3, y: 0.3 }, validRect)).toBe(true);
    expect(isPointInPolygon({ x: 0.8, y: 0.8 }, validRect)).toBe(false);

    // Bowtie self-intersecting polygon
    const selfIntersecting = [
      { x: 0.1, y: 0.1 },
      { x: 0.5, y: 0.5 },
      { x: 0.5, y: 0.1 },
      { x: 0.1, y: 0.5 },
    ];
    expect(validateBoundaryPolygon(selfIntersecting).valid).toBe(false);

    const px = normalizedToPixel({ x: 0.5, y: 0.25 }, 800, 600);
    expect(px).toEqual({ x: 400, y: 150 });
    expect(pixelToNormalized(px, 800, 600)).toEqual({ x: 0.5, y: 0.25 });
  });
});

describe('6. STOMP Realtime Reducers (FE-RT-05, FE-RT-06)', () => {
  it('ignores out-of-order telemetry frames with older timestamps', () => {
    const newer: TelemetryResponse = {
      id: '2',
      timestamp: '2026-10-22T10:00:05Z',
      metadata: { deviceId: 'd1', hardwareId: 'hw1', roomId: 'r1' },
      wifiRssi: -50,
    };
    const older: TelemetryResponse = {
      id: '1',
      timestamp: '2026-10-22T10:00:01Z',
      metadata: { deviceId: 'd1', hardwareId: 'hw1', roomId: 'r1' },
      wifiRssi: -70,
    };
    expect(mergeRealtimeTelemetry(newer, older)).toBe(newer);
    expect(mergeRealtimeTelemetry(older, newer)).toBe(newer);
  });

  it('upserts alert by id without duplicating entries', () => {
    const a1: AlertResponse = {
      id: 'alert-1',
      deviceId: 'd1',
      hardwareId: 'hw1',
      roomId: 'r1',
      type: 'NOISE_EXCEEDED',
      status: 'FIRING',
      currentValue: 68,
      threshold: 60,
      message: 'Noise high',
      startedAt: '2026-10-22T10:00:00Z',
      acknowledgedAt: null,
      resolvedAt: null,
      acknowledgedBy: null,
    };
    const a1Ack: AlertResponse = { ...a1, status: 'ACKNOWLEDGED', acknowledgedBy: 'lib01' };

    const list1 = upsertRealtimeAlertList([], a1);
    expect(list1).toHaveLength(1);

    const list2 = upsertRealtimeAlertList(list1, a1Ack);
    expect(list2).toHaveLength(1);
    expect(list2[0].status).toBe('ACKNOWLEDGED');
  });
});

describe('7. Remediation Verification: Kiosk Refresh, Custom RBAC, CSV Hygiene & Concave Geometry', () => {
  it('preserves isKioskSession across silent token rotations (FE-SEC-01)', () => {
    useAuthStore.getState().clearSession();
    useAuthStore.getState().setTokens('kiosk-access-1', 'kiosk-refresh-1', true);
    expect(useAuthStore.getState().isKioskSession).toBe(true);

    // Silent refresh calls setTokens(access, refresh) without 3rd argument
    useAuthStore.getState().setTokens('kiosk-access-2', 'kiosk-refresh-2');
    expect(useAuthStore.getState().isKioskSession).toBe(true);
    expect(useAuthStore.getState().refreshToken).toBe('kiosk-refresh-2');
    useAuthStore.getState().clearSession();
  });

  it('honors fine-grained permissions for custom roles and stripped permissions (FE-RBAC-01)', () => {
    const customScope = parseScopeString(
      'CUSTOM_OPERATOR READ_SENSOR_DATA READ_SENSOR_DETAIL MANAGE_ZONES VIEW_DEVICE_STATUS MANAGE_USERS',
      'custom01'
    );
    const customCap = buildCapabilities(customScope);
    expect(customCap.canViewDashboard).toBe(true);
    expect(customCap.canViewRawTelemetry).toBe(true);
    expect(customCap.canManageRooms).toBe(true);
    expect(customCap.canViewDevices).toBe(true);
    expect(customCap.canManageUsers).toBe(true);
    expect(customCap.canViewAlerts).toBe(false);

    // Role with VIEW_ALERTS stripped should not have canViewAlerts
    const strippedLib = parseScopeString('LIBRARIAN READ_SENSOR_DATA', 'lib02');
    expect(buildCapabilities(strippedLib).canViewAlerts).toBe(false);
  });

  it('neutralizes CSV formula injection and localizes English bottleneck strings (FE-SEC-04, FE-UI-05)', () => {
    expect(escapeCsvCell('=CMD|\' /C calc\'!A0')).toBe("'=CMD|' /C calc'!A0");
    expect(escapeCsvCell('+SUM(A1:A10)')).toBe("'+SUM(A1:A10)");
    expect(escapeCsvCell('@HYPERLINK("http://evil")')).toBe(
      '"\'@HYPERLINK(""http://evil"")"'
    );
    expect(escapeCsvCell(-24.5)).toBe('-24.5');

    expect(
      formatBottleneckReasonVi(
        'Average noise level (68.4 dBA) exceeded threshold (65.0 dBA)'
      )
    ).toBe('Độ ồn trung bình (68.4 dBA) vượt ngưỡng cho phép (65.0 dBA)');
  });

  it('rejects collinear zero-area or duplicate-vertex polygons and finds interior center for L-shapes (FE-GEO-01, FE-GEO-02)', () => {
    const collinear = [
      { x: 0.1, y: 0.1 },
      { x: 0.3, y: 0.3 },
      { x: 0.5, y: 0.5 },
    ];
    expect(validateBoundaryPolygon(collinear).valid).toBe(false);

    const duplicateVertex = [
      { x: 0.1, y: 0.1 },
      { x: 0.5, y: 0.1 },
      { x: 0.5, y: 0.1 },
      { x: 0.1, y: 0.5 },
    ];
    expect(validateBoundaryPolygon(duplicateVertex).valid).toBe(false);

    // Concave L-shaped polygon where bounding-box center lies outside
    const lShape = [
      { x: 0.1, y: 0.1 },
      { x: 0.2, y: 0.1 },
      { x: 0.2, y: 0.8 },
      { x: 0.9, y: 0.8 },
      { x: 0.9, y: 0.9 },
      { x: 0.1, y: 0.9 },
    ];
    expect(validateBoundaryPolygon(lShape).valid).toBe(true);
    const center = computeVisualPolygonCenter(lShape);
    expect(isPointInPolygon(center, lShape)).toBe(true);
  });
});

describe('8. TQB CAD 1:100 Floorplan Presets, 7-Layer Weather Palettes, Adaptive Sigma & Anonymous Micro-Zones', () => {
  it('validates 100% of TQB_ROOM_PRESETS boundary polygons and ensures readingBays sit inside room boundaries', () => {
    expect(TQB_BUILDING_ASPECT_RATIO).toBeCloseTo(57.2 / 76.0, 4);
    expect(TQB_ROOM_PRESETS.length).toBeGreaterThanOrEqual(24);

    for (const preset of TQB_ROOM_PRESETS) {
      const validation = validateBoundaryPolygon(preset.boundaryPolygon);
      expect(validation.valid, `Preset ${preset.code} failed polygon validation: ${validation.reason}`).toBe(true);

      const visualCenter = computeVisualPolygonCenter(preset.boundaryPolygon);
      expect(
        isPointInPolygon(visualCenter, preset.boundaryPolygon),
        `Preset ${preset.code} visual center lies outside polygon`
      ).toBe(true);

      for (const bay of preset.readingBays) {
        expect(
          isPointInPolygon({ x: bay.posX, y: bay.posY }, preset.boundaryPolygon),
          `Reading bay ${bay.id} in ${preset.code} lies outside room polygon`
        ).toBe(true);
      }
    }
  });

  it('supports all 7 HeatmapLayerMetric layers across WEATHER_PALETTES, thresholds, and FloorplanCanvas formatters', () => {
    const allMetrics: HeatmapLayerMetric[] = [
      'comfortScore',
      'noiseAvg',
      'pm2_5',
      'temperature',
      'humidity',
      'lux',
      'wifiRssi',
    ];

    const sampleTelemetry: TelemetryResponse = {
      id: 'tel-1',
      timestamp: '2026-11-04T00:00:00Z',
      metadata: {
        deviceId: 'dev-1',
        hardwareId: 'ESP32_TQB_301_A',
        roomId: 'room-301',
      },
      environment: {
        temperature: 24.5,
        humidity: 56.2,
        lux: 420,
      },
      acoustics: {
        noiseAvg: 44.8,
        noisePeak: 52.0,
      },
      airQuality: {
        pm1_0: 9.0,
        pm2_5: 14.3,
        pm4_0: 19.0,
        pm10: 25.0,
      },
      wifiRssi: -58,
      comfortScore: {
        overall: 86,
        grade: 'Gold',
        acousticScore: 85,
        airScore: 88,
        thermalScore: 84,
        lightScore: 90,
      },
    };

    for (const metric of allMetrics) {
      expect(WEATHER_PALETTES[metric].length).toBeGreaterThanOrEqual(5);
      const val = extractLayerMetricValue(sampleTelemetry, metric);
      expect(val).not.toBeNull();
      const [r, g, b] = getContinuousMetricColor(metric, val!);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(255);
      expect(g).toBeGreaterThanOrEqual(0);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(getMetricColorHex(metric, val!)).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(formatLayerMetricValue(val!, metric).length).toBeGreaterThan(0);
    }
  });

  it('computes smaller adaptiveSigma for small Floor 5 group study rooms than for large Multimedia halls', () => {
    const smallGroupRoom = resolveRoomPreset({
      code: 'TQB_508',
      name: 'Phòng Học Nhóm 508',
      floor: 5,
    })!;
    const largeMultimediaRoom = resolveRoomPreset({
      code: 'TQB_301',
      name: 'Phòng Multimedia Tầng 3',
      floor: 3,
    })!;

    expect(smallGroupRoom).not.toBeNull();
    expect(largeMultimediaRoom).not.toBeNull();

    const sigmaSmall = computeAdaptiveSigma(smallGroupRoom.boundaryPolygon, 1);
    const sigmaLarge = computeAdaptiveSigma(largeMultimediaRoom.boundaryPolygon, 3);

    expect(sigmaSmall).toBeGreaterThanOrEqual(0.042);
    expect(sigmaLarge).toBeGreaterThan(sigmaSmall);
    expect(sigmaLarge).toBeLessThanOrEqual(0.165);
  });

  it('synthesizes hardware-safe anonymous reading bay micro-zones (FE-VIZ-09) and computes blindspots & wayfinding', () => {
    const multimediaPreset = resolveRoomPreset({
      code: 'TQB_301',
      name: 'Phòng Multimedia Tầng 3',
      floor: 3,
    })!;
    const mockRoom = {
      id: 'room-301',
      code: multimediaPreset.code,
      name: multimediaPreset.name,
      floor: multimediaPreset.floor,
      roomType: multimediaPreset.roomType,
      capacity: multimediaPreset.capacity,
      zoneId: 'zone-3',
      boundaryPolygon: [...multimediaPreset.boundaryPolygon],
    };
    const baseTel: TelemetryResponse = {
      id: 'tel-301',
      timestamp: '2026-11-04T00:00:00Z',
      metadata: {
        deviceId: 'room-aggregate',
        hardwareId: 'ESP32_TQB_301_AGG',
        roomId: 'room-301',
      },
      environment: {
        temperature: 25.0,
        humidity: 55.0,
        lux: 410,
      },
      acoustics: {
        noiseAvg: 46.0,
        noisePeak: 55.0,
      },
      airQuality: {
        pm1_0: 10.0,
        pm2_5: 15.0,
        pm4_0: 21.0,
        pm10: 28.0,
      },
      wifiRssi: -60,
      comfortScore: {
        overall: 82,
        grade: 'Gold',
        acousticScore: 80,
        airScore: 86,
        thermalScore: 81,
        lightScore: 88,
      },
    };

    const microZones = synthesizeAnonymousMicroZones(mockRoom, baseTel);
    expect(microZones.length).toBeGreaterThanOrEqual(2);
    // Ensure distinct spatial values so Case C diffusion renders multi-bay thermal gradients
    const values = new Set(microZones.map((z) => z.metrics.comfortScore));
    expect(values.size).toBeGreaterThan(1);

    const blindspotFull = computeRoomBlindspotRatio(
      multimediaPreset.boundaryPolygon,
      microZones.map((z) => ({
        x: z.posX,
        y: z.posY,
        value: z.metrics.comfortScore,
        online: true,
      }))
    );
    const blindspotNoSensor = computeRoomBlindspotRatio(multimediaPreset.boundaryPolygon, []);
    expect(blindspotNoSensor.blindspotRatio).toBe(1);
    expect(blindspotNoSensor.isUnderCovered).toBe(true);
    expect(blindspotFull.blindspotRatio).toBeLessThan(1);

    const wayfinding = computeWayfindingPath(mockRoom, multimediaPreset.doorPosition);
    expect(wayfinding).not.toBeNull();
    expect(wayfinding!.waypoints.length).toBeGreaterThanOrEqual(2);
    expect(wayfinding!.distanceMeters).toBeGreaterThan(0);
  });
});

describe('9. Label declutter LOD & collision avoidance', () => {
  const viewport = { width: 960, height: 722 };
  const largeRoomPoly = [
    { x: 100, y: 100 },
    { x: 400, y: 100 },
    { x: 400, y: 340 },
    { x: 100, y: 340 },
  ];

  it('shifts room label away when a sensor obstacle sits directly at the room center', () => {
    const placements = computeLabelPlacements(
      [
        {
          id: 'room-301',
          anchor: { x: 250, y: 220 },
          width: 72,
          height: 20,
          polygon: largeRoomPoly,
          priority: 570,
        },
      ],
      [{ x: 250, y: 220, r: 12 }],
      viewport
    );

    expect(placements).toHaveLength(1);
    expect(placements[0].visible).toBe(true);
    expect(
      placements[0].x !== 250 || placements[0].y !== 220
    ).toBe(true);

    // Verify bounding box of placed label does not intersect obstacle circle (r=12 + 4px margin)
    const boxLeft = placements[0].x - 36;
    const boxRight = placements[0].x + 36;
    const boxTop = placements[0].y - 10;
    const boxBottom = placements[0].y + 10;
    const nearX = Math.max(boxLeft, Math.min(250, boxRight));
    const nearY = Math.max(boxTop, Math.min(220, boxBottom));
    const dist = Math.hypot(250 - nearX, 220 - nearY);
    expect(dist).toBeGreaterThanOrEqual(16);
  });

  it('prevents two adjacent labels from overlapping each other', () => {
    const placements = computeLabelPlacements(
      [
        {
          id: 'room-a',
          anchor: { x: 240, y: 220 },
          width: 84,
          height: 22,
          polygon: largeRoomPoly,
          priority: 300,
        },
        {
          id: 'room-b',
          anchor: { x: 255, y: 222 },
          width: 84,
          height: 22,
          polygon: largeRoomPoly,
          priority: 200,
        },
      ],
      [],
      viewport
    );

    expect(placements[0].visible).toBe(true);
    expect(placements[1].visible).toBe(true);

    const aLeft = placements[0].x - 42;
    const aRight = placements[0].x + 42;
    const aTop = placements[0].y - 11;
    const aBottom = placements[0].y + 11;

    const bLeft = placements[1].x - 42;
    const bRight = placements[1].x + 42;
    const bTop = placements[1].y - 11;
    const bBottom = placements[1].y + 11;

    const separated =
      aRight <= bLeft || aLeft >= bRight || aBottom <= bTop || aTop >= bBottom;
    expect(separated).toBe(true);
  });

  it('marks label visible: false when room polygon is too tiny to fit the label', () => {
    const tinyPoly = [
      { x: 200, y: 200 },
      { x: 225, y: 200 },
      { x: 225, y: 215 },
      { x: 200, y: 215 },
    ];
    const placements = computeLabelPlacements(
      [
        {
          id: 'room-tiny',
          anchor: { x: 212, y: 207 },
          width: 90,
          height: 28,
          polygon: tinyPoly,
          priority: 25,
        },
      ],
      [],
      viewport
    );

    expect(placements[0].visible).toBe(false);
  });

  it('places highest-priority selected room at exact center when center is unobstructed', () => {
    const placements = computeLabelPlacements(
      [
        {
          id: 'room-normal',
          anchor: { x: 250, y: 220 },
          width: 80,
          height: 22,
          polygon: largeRoomPoly,
          priority: 300,
        },
        {
          id: 'room-selected',
          anchor: { x: 250, y: 220 },
          width: 80,
          height: 22,
          polygon: largeRoomPoly,
          priority: 500_000,
        },
      ],
      [],
      viewport
    );

    // Selected room (index 1) gets exact anchor (250, 220), normal room (index 0) is shifted
    expect(placements[1]).toEqual({
      id: 'room-selected',
      x: 250,
      y: 220,
      visible: true,
    });
    expect(placements[0].visible).toBe(true);
    expect(placements[0].x !== 250 || placements[0].y !== 220).toBe(true);
  });

  it('resolves getLodConfig matrix across clean, balanced, detailed and Level-2 zoom', () => {
    const clean = getLodConfig('clean', false);
    expect(clean.roomLabel).toBe('code');
    expect(clean.hideSmallRoomsUnderM2).toBe(65);
    expect(clean.sensorStyle).toBe('dot');
    expect(clean.showSensorBadge).toBe(false);
    expect(clean.bayStyle).toBe('hidden');
    expect(clean.showLandmarkText).toBe(false);
    expect(clean.showAtriumText).toBe(false);

    const balanced = getLodConfig('balanced', false);
    expect(balanced.roomLabel).toBe('pill');
    expect(balanced.sensorStyle).toBe('dot');
    expect(balanced.showSensorBadge).toBe(false);
    expect(balanced.bayStyle).toBe('dot');

    const detailed = getLodConfig('detailed', false);
    expect(detailed.roomLabel).toBe('rich');
    expect(detailed.sensorStyle).toBe('pin');
    expect(detailed.showSensorBadge).toBe(true);
    expect(detailed.bayStyle).toBe('pill');
    expect(detailed.showLandmarkText).toBe(true);

    const zoomedFromClean = getLodConfig('clean', true);
    expect(zoomedFromClean.roomLabel).toBe('rich');
    expect(zoomedFromClean.sensorStyle).toBe('pin');
    expect(zoomedFromClean.showSensorBadge).toBe(true);
    expect(zoomedFromClean.bayStyle).toBe('pill');
  });
});

describe('10. Synthetic Data Transparency, Stale Telemetry, Sticky Toast & Touch Pinch/Pan', () => {
  it('marks preset fallback telemetry with isSynthetic: true', () => {
    const preset = TQB_ROOM_PRESETS[0];
    const mockRoom = {
      id: `PRESET_${preset.code}`,
      code: preset.code,
      name: preset.name,
      floor: preset.floor,
      capacity: preset.capacity,
      type: preset.roomType,
      boundaryPolygon: [...preset.boundaryPolygon],
    };
    const synthTel = buildPresetFallbackTelemetry(mockRoom, 0);
    expect(synthTel.isSynthetic).toBe(true);
    expect(synthTel.id).toContain('SYNTH_TEL_');
  });

  it('evaluates isTelemetryStale boundary cases (4m59s, 5m00s, 5m01s, and synthetic)', () => {
    const nowMs = Date.parse('2026-11-12T12:05:00.000Z');
    // 4m59s old -> false
    expect(isTelemetryStale('2026-11-12T12:00:01.000Z', nowMs)).toBe(false);
    // 5m00s old (exact 300,000ms) -> false (> 300_000 is stale)
    expect(isTelemetryStale('2026-11-12T12:00:00.000Z', nowMs)).toBe(false);
    // 5m01s old -> true
    expect(isTelemetryStale('2026-11-12T11:59:59.000Z', nowMs)).toBe(true);
    // Synthetic data is never flagged as stale sensor data
    expect(isTelemetryStale('2026-11-12T10:00:00.000Z', nowMs, true)).toBe(
      false
    );
  });

  it('prevents auto-dismiss for sticky HIGH/CRITICAL alert toasts', () => {
    expect(shouldAutoDismissToast({ sticky: true })).toBe(false);
    expect(shouldAutoDismissToast({ sticky: false })).toBe(true);
    expect(shouldAutoDismissToast({})).toBe(true);
  });

  it('clamps viewport transform and computes pinch scale within [1.0, 3.0]', () => {
    expect(computePinchScale(1, 100, 250)).toBeCloseTo(2.5, 3);
    expect(computePinchScale(1, 100, 600)).toBe(3.0);
    expect(computePinchScale(1.5, 200, 50)).toBe(1.0);

    const resetAtOne = clampViewportTransform(1, 120, -80, 960, 720);
    expect(resetAtOne).toEqual({ scale: 1, tx: 0, ty: 0 });

    const clamped = clampViewportTransform(2, 900, -900, 960, 720);
    expect(clamped.scale).toBe(2);
    expect(clamped.tx).toBeLessThanOrEqual(0);
    expect(clamped.ty).toBeGreaterThanOrEqual(-720);
  });
});

describe('11. Alert Acknowledge Deep-Link to Floorplan Room & Sensor Node', () => {
  it('maps alert types to the exact 2D heatmap layer metric', () => {
    expect(
      resolveAlertHeatmapLayer({
        type: 'NOISE_EXCEEDED',
        message: 'Độ ồn vượt ngưỡng 68 dBA',
      })
    ).toBe('noiseAvg');
    expect(
      resolveAlertHeatmapLayer({
        type: 'AIR_UNHEALTHY',
        message: 'Bụi mịn PM2.5 vượt ngưỡng',
      })
    ).toBe('pm2_5');
    expect(
      resolveAlertHeatmapLayer({
        type: 'DEVICE_OFFLINE',
        message: 'Trạm mất kết nối MQTT',
      })
    ).toBe('wifiRssi');
    expect(
      resolveAlertHeatmapLayer({
        type: 'SENSOR_MALFUNCTION',
        message: 'Độ ẩm kho sách vượt 62%RH',
      })
    ).toBe('humidity');
  });

  it('prioritizes metricType and falls back cleanly on AIR_UNHEALTHY legacy messages (Hạng mục 5 Test 2)', () => {
    expect(
      resolveAlertHeatmapLayer({
        type: 'AIR_UNHEALTHY',
        metricType: 'TEMPERATURE',
        message: 'Cảnh báo nhiệt độ',
      })
    ).toBe('temperature');
    expect(
      resolveAlertHeatmapLayer({
        type: 'AIR_UNHEALTHY',
        metricType: 'HUMIDITY_HIGH',
        message: 'Cảnh báo độ ẩm kho sách',
      })
    ).toBe('humidity');
    expect(
      resolveAlertHeatmapLayer({
        type: 'AIR_UNHEALTHY',
        metricType: 'HUMIDITY_LOW',
        message: 'Độ ẩm thấp',
      })
    ).toBe('humidity');
    expect(
      resolveAlertHeatmapLayer({
        type: 'AIR_UNHEALTHY',
        metricType: 'PM2_5',
        message: 'Bụi mịn vượt ngưỡng',
      })
    ).toBe('pm2_5');
    expect(
      resolveAlertHeatmapLayer({
        type: 'NOISE_EXCEEDED',
        metricType: 'NOISE_PEAK',
        message: 'Peak noise spike',
      })
    ).toBe('noiseAvg');
    expect(
      resolveAlertHeatmapLayer({
        type: 'DEVICE_OFFLINE',
        metricType: 'DEVICE_OFFLINE',
        message: 'Mất kết nối',
      })
    ).toBe('wifiRssi');

    // Bản ghi cũ không có metricType -> suy luận đúng từ message cho AIR_UNHEALTHY & SENSOR_MALFUNCTION
    expect(
      resolveAlertHeatmapLayer({
        type: 'AIR_UNHEALTHY',
        metricType: null,
        message: 'Temperature (33.5 °C) exceeded threshold (32.0 °C)',
      })
    ).toBe('temperature');
    expect(
      resolveAlertHeatmapLayer({
        type: 'AIR_UNHEALTHY',
        message: 'Book storage humidity (64.0 %RH) exceeded max threshold (60.0 %RH)',
      })
    ).toBe('humidity');
    // Kiểm tra không bị false-positive từ chữ 'rh' trong 'overheat'
    expect(
      resolveAlertHeatmapLayer({
        type: 'SENSOR_MALFUNCTION',
        message: 'Sensor overheat detected (48.0 °C)',
      })
    ).toBe('temperature');
    // Mặc định AIR_UNHEALTHY không gợi ý -> pm2_5; SENSOR_MALFUNCTION không gợi ý -> temperature
    expect(
      resolveAlertHeatmapLayer({
        type: 'AIR_UNHEALTHY',
        message: 'Air quality issue',
      })
    ).toBe('pm2_5');
    expect(
      resolveAlertHeatmapLayer({
        type: 'SENSOR_MALFUNCTION',
        message: 'Hardware probe fault',
      })
    ).toBe('temperature');
  });

  it('resolves exact unit & decimals for Temperature, Humidity, PM2.5, Noise and Offline alerts (Hạng mục 5 Test 3)', () => {
    expect(
      resolveAlertValueFormat({
        type: 'AIR_UNHEALTHY',
        metricType: 'TEMPERATURE',
        unit: '°C',
        message: 'Temperature (34.0 °C)',
      })
    ).toEqual({ unit: '°C', decimals: 1, isOffline: false });

    expect(
      resolveAlertValueFormat({
        type: 'AIR_UNHEALTHY',
        metricType: 'HUMIDITY_HIGH',
        unit: '%RH',
        message: 'Book storage humidity (65.0 %RH)',
      })
    ).toEqual({ unit: '%RH', decimals: 1, isOffline: false });

    expect(
      resolveAlertValueFormat({
        type: 'AIR_UNHEALTHY',
        metricType: 'PM2_5',
        unit: 'µg/m³',
        message: 'PM2.5 particulate level (60.0 µg/m³)',
      })
    ).toEqual({ unit: 'µg/m³', decimals: 1, isOffline: false });

    expect(
      resolveAlertValueFormat({
        type: 'NOISE_EXCEEDED',
        metricType: 'NOISE_PEAK',
        unit: 'dBA',
        message: 'Peak noise spike',
      })
    ).toEqual({ unit: 'dBA', decimals: 1, isOffline: false });

    expect(
      resolveAlertValueFormat({
        type: 'DEVICE_OFFLINE',
        metricType: 'DEVICE_OFFLINE',
        unit: null,
        message: 'Device is offline: hardwareId=ESP32-1',
      })
    ).toEqual({ unit: undefined, decimals: 0, isOffline: true });

    // Legacy record fallback (missing unit and metricType)
    expect(
      resolveAlertValueFormat({
        type: 'AIR_UNHEALTHY',
        message: 'Temperature (33.5 °C) exceeded threshold (32.0 °C)',
      })
    ).toEqual({ unit: '°C', decimals: 1, isOffline: false });
    expect(
      resolveAlertValueFormat({
        type: 'AIR_UNHEALTHY',
        message: 'Book storage humidity (64.0 %RH) exceeded max threshold',
      })
    ).toEqual({ unit: '%RH', decimals: 1, isOffline: false });
  });

  it('builds floorplan deep-link with floor, roomId, deviceId, hardwareId, layer, and alertId', () => {
    const rooms = [
      { id: 'room-402', code: 'P402', name: 'Kho sách Tự chọn T4', floor: 4 },
    ];
    const devices = [
      {
        id: 'dev-node-09',
        hardwareId: 'ESP32-NODE-09',
        name: 'Trạm Kho sách 402',
        roomId: 'room-402',
        online: true,
      },
    ];
    const alert: AlertResponse = {
      id: 'alert-999',
      deviceId: 'dev-node-09',
      hardwareId: 'ESP32-NODE-09',
      roomId: 'room-402',
      type: 'NOISE_EXCEEDED',
      metricType: 'NOISE_AVG',
      unit: 'dBA',
      severity: 'HIGH',
      status: 'FIRING',
      message: 'Độ ồn vượt ngưỡng 65 dBA',
      currentValue: 67.4,
      threshold: 55.0,
      startedAt: '2026-11-12T10:00:00Z',
      acknowledgedAt: null,
      resolvedAt: null,
      acknowledgedBy: null,
    };

    const target = resolveAlertFloorplanTarget(alert, rooms, devices);
    expect(target.floor).toBe(4);
    expect(target.roomId).toBe('room-402');
    expect(target.deviceId).toBe('dev-node-09');
    expect(target.hardwareId).toBe('ESP32-NODE-09');
    expect(target.layer).toBe('noiseAvg');
    expect(target.href).toBe(
      '/floorplan?floor=4&roomId=room-402&deviceId=dev-node-09&hardwareId=ESP32-NODE-09&layer=noiseAvg&alertId=alert-999'
    );

    const tempAlert: AlertResponse = {
      ...alert,
      type: 'AIR_UNHEALTHY',
      metricType: 'TEMPERATURE',
      unit: '°C',
    };
    const tempTarget = resolveAlertFloorplanTarget(tempAlert, rooms, devices);
    expect(tempTarget.layer).toBe('temperature');
  });
});
