'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  getMetricColorHex,
  type HeatmapLayerMetric,
} from '@/config/thresholds';
import {
  normalizedToPixel,
  pixelToNormalized,
} from '@/lib/floorplan/coords';
import { computeIdwValue, type IdwSamplePoint } from '@/lib/floorplan/idw';
import {
  getContinuousMetricColorCss,
  renderWeatherDiffusionHeatmap,
} from '@/lib/floorplan/weatherPalette';
import {
  computeVisualPolygonCenter,
  isPointInPolygon,
} from '@/lib/floorplan/polygon';
import { formatMetrics } from '@/lib/format/metrics';
import type {
  DeviceResponse,
  Point2D,
  RoomResponse,
  TelemetryResponse,
} from '@/types/api';

export function extractLayerMetricValue(
  telemetry: TelemetryResponse | null | undefined,
  layer: HeatmapLayerMetric
): number | null {
  if (!telemetry) return null;
  switch (layer) {
    case 'comfortScore':
      return telemetry.comfortScore?.overall ?? null;
    case 'noiseAvg':
      return telemetry.acoustics?.noiseAvg ?? null;
    case 'pm2_5':
      return telemetry.airQuality?.pm2_5 ?? null;
    case 'temperature':
      return telemetry.environment?.temperature ?? null;
  }
}

export function formatLayerMetricValue(
  value: number | null | undefined,
  layer: HeatmapLayerMetric
): string {
  switch (layer) {
    case 'comfortScore':
      return formatMetrics.comfortScore(value);
    case 'noiseAvg':
      return formatMetrics.noise(value);
    case 'pm2_5':
      return formatMetrics.pm(value);
    case 'temperature':
      return formatMetrics.temperature(value);
  }
}

function resolveDeviceTelemetry(
  dev: DeviceResponse,
  deviceTelemetryMap: Record<string, TelemetryResponse | null | undefined>,
  roomTelemetryMap: Record<string, TelemetryResponse | null | undefined>,
  roomDeviceCount: number
): TelemetryResponse | null | undefined {
  const direct = deviceTelemetryMap[dev.id];
  if (direct) return direct;
  if (!dev.roomId) return undefined;
  const roomLatest = roomTelemetryMap[dev.roomId];
  if (!roomLatest) return undefined;
  if (roomLatest.metadata?.deviceId === dev.id || roomDeviceCount <= 1) {
    return roomLatest;
  }
  return undefined;
}

function computePolygonCentroid(vertices: readonly Point2D[]): Point2D {
  return computeVisualPolygonCenter(vertices);
}

export interface FloorplanCanvasProps {
  rooms: RoomResponse[];
  devices: DeviceResponse[];
  roomTelemetryMap: Record<string, TelemetryResponse | null | undefined>;
  deviceTelemetryMap?: Record<string, TelemetryResponse | null | undefined>;
  layer: HeatmapLayerMetric;
  selectedRoomId: string | null;
  onSelectRoom: (room: RoomResponse) => void;
  onSelectDevice?: (device: DeviceResponse, room?: RoomResponse) => void;
}

export function FloorplanCanvas({
  rooms,
  devices,
  roomTelemetryMap,
  deviceTelemetryMap = {},
  layer,
  selectedRoomId,
  onSelectRoom,
  onSelectDevice,
}: FloorplanCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [canvasSize, setCanvasSize] = useState<{ width: number; height: number }>({
    width: 960,
    height: 560,
  });
  const [hoveredDeviceId, setHoveredDeviceId] = useState<string | null>(null);
  const [displayValues, setDisplayValues] = useState<Record<string, number>>({});

  // Animated smooth values map for gliding transitions (FE-VIZ-04: Anti-flicker temporal smoothstep)
  interface AnimDeviceState {
    current: number;
    from: number;
    target: number;
    startTime: number;
    duration: number;
  }
  const animValuesRef = useRef<Map<string, AnimDeviceState>>(new Map());
  const prevLayerRef = useRef(layer);
  const lastDisplayUpdateRef = useRef<number>(0);

  // Sync new incoming telemetry targets into animated values map
  useEffect(() => {
    const layerChanged = prevLayerRef.current !== layer;
    prevLayerRef.current = layer;

    const now = performance.now();
    const roomCounts = new Map<string, number>();
    for (const d of devices) {
      if (d.roomId) {
        roomCounts.set(d.roomId, (roomCounts.get(d.roomId) ?? 0) + 1);
      }
    }
    for (const dev of devices) {
      const devTel = resolveDeviceTelemetry(
        dev,
        deviceTelemetryMap,
        roomTelemetryMap,
        dev.roomId ? (roomCounts.get(dev.roomId) ?? 1) : 1
      );
      const targetVal = extractLayerMetricValue(devTel, layer);
      if (targetVal !== null && Number.isFinite(targetVal)) {
        const existing = animValuesRef.current.get(dev.id);
        if (!existing || layerChanged) {
          animValuesRef.current.set(dev.id, {
            current: targetVal,
            from: targetVal,
            target: targetVal,
            startTime: now,
            duration: 2600,
          });
        } else if (Math.abs(existing.target - targetVal) > 0.005) {
          existing.from = existing.current;
          existing.target = targetVal;
          existing.startTime = now;
          existing.duration = 2600; // Tranquil 2.6s smoothstep glide
        }
      }
    }
  }, [devices, deviceTelemetryMap, roomTelemetryMap, layer]);

  const roomsWithPolygon = useMemo(
    () =>
      rooms.filter(
        (r) => Array.isArray(r.boundaryPolygon) && r.boundaryPolygon.length >= 3
      ),
    [rooms]
  );

  const roomById = useMemo(() => {
    const map = new Map<string, RoomResponse>();
    for (const r of rooms) {
      map.set(r.id, r);
    }
    return map;
  }, [rooms]);

  // Observe container resize for responsive HiDPI rendering (FE-VIZ-06)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      const width = Math.max(320, Math.floor(rect.width));
      const height = Math.max(360, Math.floor(width * 0.56));
      setCanvasSize((prev) =>
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

  // Dual-Layer Canvas Rendering with continuous temporal lerping & Polygon Clipping (FE-VIZ-03, FE-VIZ-04, FE-VIZ-06, FE-RT-08)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let rafId = 0;
    let isCancelled = false;

    const render = () => {
      if (isCancelled) return;

      // Smooth temporal interpolation: Hermite smoothstep easing over 2.6s (no sudden jumps or flickers)
      const now = performance.now();
      let isTransitioning = false;
      for (const state of animValuesRef.current.values()) {
        const elapsed = now - state.startTime;
        if (elapsed < state.duration) {
          const p = Math.max(0, Math.min(1, elapsed / state.duration));
          // S(p) = 3p^2 - 2p^3 (zero derivative at both start and end, guaranteeing gentle acceleration/deceleration)
          const s = p * p * (3 - 2 * p);
          state.current = state.from + (state.target - state.from) * s;
          isTransitioning = true;
        } else {
          state.current = state.target;
        }
      }

      // Synchronize animated values to React state for HTML station pins & pills (~12fps throttle)
      if (isTransitioning) {
        if (now - lastDisplayUpdateRef.current >= 80) {
          lastDisplayUpdateRef.current = now;
          const newDisplays: Record<string, number> = {};
          for (const [id, state] of animValuesRef.current.entries()) {
            newDisplays[id] = Math.round(state.current * 10) / 10;
          }
          setDisplayValues(newDisplays);
        }
      } else if (lastDisplayUpdateRef.current !== 0) {
        lastDisplayUpdateRef.current = 0;
        const newDisplays: Record<string, number> = {};
        for (const [id, state] of animValuesRef.current.entries()) {
          newDisplays[id] = Math.round(state.target * 10) / 10;
        }
        setDisplayValues(newDisplays);
      }

      const dpr =
        typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
      const { width, height } = canvasSize;

      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.save();
      ctx.scale(dpr, dpr);

      // 1. Architectural Blueprint Background
      ctx.fillStyle = '#0F172A';
      ctx.fillRect(0, 0, width, height);

      // Subtle architectural coordinate grid
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.1)';
      ctx.lineWidth = 1;
      const gridStep = 40;
      for (let gx = gridStep; gx < width; gx += gridStep) {
        ctx.beginPath();
        ctx.moveTo(gx, 0);
        ctx.lineTo(gx, height);
        ctx.stroke();
      }
      for (let gy = gridStep; gy < height; gy += gridStep) {
        ctx.beginPath();
        ctx.moveTo(0, gy);
        ctx.lineTo(width, gy);
        ctx.stroke();
      }

      // 2. Render each room polygon with strict ctx.clip()
      for (const room of roomsWithPolygon) {
        const polygon = room.boundaryPolygon!;
        const pixelVertices = polygon.map((pt) =>
          normalizedToPixel(pt, width, height)
        );

        const roomDevices = devices.filter((d) => d.roomId === room.id);
        const onlineDevices = roomDevices.filter(
          (d) => d.online || d.connectionState === 'ONLINE'
        );
        const roomLatest = roomTelemetryMap[room.id];
        const roomMetricValue = extractLayerMetricValue(roomLatest, layer);

        // Build sample points from ONLINE devices using smooth animated values
        const idwSamples: IdwSamplePoint[] = [];
        for (const dev of onlineDevices) {
          if (typeof dev.posX === 'number' && typeof dev.posY === 'number') {
            const devTel = resolveDeviceTelemetry(
              dev,
              deviceTelemetryMap,
              roomTelemetryMap,
              roomDevices.length
            );
            const val = extractLayerMetricValue(devTel, layer);
            // Use smooth animated value to prevent flickers on new incoming packets
            const animEntry = animValuesRef.current.get(dev.id);
            const smoothVal = animEntry ? animEntry.current : val;

            if (smoothVal !== null && Number.isFinite(smoothVal)) {
              idwSamples.push({
                x: dev.posX,
                y: dev.posY,
                value: smoothVal,
                online: true,
              });
            }
          }
        }

        const hasOnlineTelemetry =
          (roomDevices.length === 0 && roomMetricValue !== null) ||
          (onlineDevices.length > 0 &&
            (idwSamples.length > 0 || roomMetricValue !== null)) ||
          roomMetricValue !== null;

        // 2. Render Meteorological Continuous Gaussian RBF Diffusion Heatmap
        renderWeatherDiffusionHeatmap(
          ctx,
          pixelVertices,
          idwSamples,
          layer,
          width,
          height,
          roomMetricValue,
          0.26 // Natural desk dispersion envelope
        );

        // 3. Draw Architectural Wall Stroke & Room Code Label
        const isSelected = room.id === selectedRoomId;
        const primaryValue =
          idwSamples.length > 0
            ? idwSamples.reduce((sum, s) => sum + s.value, 0) / idwSamples.length
            : roomMetricValue;
        const wallColor = !hasOnlineTelemetry
          ? '#64748B'
          : getContinuousMetricColorCss(layer, primaryValue);

        ctx.save();
        ctx.beginPath();
        pixelVertices.forEach((p, idx) => {
          if (idx === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        });
        ctx.closePath();
        ctx.lineWidth = isSelected ? 3.5 : 2;
        ctx.strokeStyle = isSelected ? '#38BDF8' : wallColor;
        ctx.stroke();

        // Centroid room code & metric label
        const centroidNorm = computePolygonCentroid(polygon);
        const centroidPx = normalizedToPixel(centroidNorm, width, height);

        ctx.font = 'bold 13px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        const codeLabel = room.code;
        const metricLabel = hasOnlineTelemetry
          ? formatLayerMetricValue(primaryValue, layer)
          : 'N/A (Offline)';

        // Label pill background for legibility (semi-transparent so thermal flow shines through)
        const pillWidth = Math.max(
          ctx.measureText(codeLabel).width,
          ctx.measureText(metricLabel).width
        ) + 16;
        const pillHeight = 34;

        ctx.fillStyle = 'rgba(15, 23, 42, 0.72)';
        ctx.strokeStyle = isSelected ? '#38BDF8' : 'rgba(255, 255, 255, 0.25)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.roundRect(
          centroidPx.x - pillWidth / 2,
          centroidPx.y - pillHeight / 2,
          pillWidth,
          pillHeight,
          6
        );
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#F8FAFC';
        ctx.fillText(codeLabel, centroidPx.x, centroidPx.y - 7);

        ctx.font = '600 11px JetBrains Mono, monospace';
        ctx.fillStyle = hasOnlineTelemetry ? '#E2E8F0' : '#94A3B8';
        ctx.fillText(metricLabel, centroidPx.x, centroidPx.y + 9);
        ctx.restore();
      }

      ctx.restore();

      // If animated values are still smoothly gliding to target, continue loop
      if (isTransitioning) {
        rafId = window.requestAnimationFrame(render);
      }
    };

    // Trigger frame
    rafId = window.requestAnimationFrame(render);

    return () => {
      isCancelled = true;
      if (rafId) window.cancelAnimationFrame(rafId);
    };
  }, [
    canvasSize,
    roomsWithPolygon,
    devices,
    roomTelemetryMap,
    deviceTelemetryMap,
    layer,
    selectedRoomId,
  ]);

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const clickPx: Point2D = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
    const normPt = pixelToNormalized(clickPx, canvasSize.width, canvasSize.height);

    for (const room of roomsWithPolygon) {
      if (
        room.boundaryPolygon &&
        isPointInPolygon(normPt, room.boundaryPolygon)
      ) {
        onSelectRoom(room);
        return;
      }
    }
  };

  // Devices that have normalized coordinates on this floor
  const positionedDevices = useMemo(
    () =>
      devices.filter(
        (d) =>
          d.roomId &&
          roomById.has(d.roomId) &&
          typeof d.posX === 'number' &&
          typeof d.posY === 'number'
      ),
    [devices, roomById]
  );

  return (
    <div
      ref={containerRef}
      className="relative w-full overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 shadow-inner"
    >
      <canvas
        ref={canvasRef}
        onClick={handleCanvasClick}
        className="block cursor-pointer select-none"
        aria-label="Bản đồ không gian mặt bằng và Heatmap 2D"
      />

      {/* Layer 2: Interactive Device Pins Overlay */}
      <div className="pointer-events-none absolute inset-0">
        {positionedDevices.map((device) => {
          const px = normalizedToPixel(
            { x: device.posX!, y: device.posY! },
            canvasSize.width,
            canvasSize.height
          );
          const room = device.roomId ? roomById.get(device.roomId) : undefined;
          const roomDeviceCount = device.roomId
            ? devices.filter((d) => d.roomId === device.roomId).length
            : 1;
          const devTel = resolveDeviceTelemetry(
            device,
            deviceTelemetryMap,
            roomTelemetryMap,
            roomDeviceCount
          );
          const rawMetricVal = extractLayerMetricValue(devTel, layer);
          const activeVal = displayValues[device.id] ?? rawMetricVal;
          const colorHex = device.online
            ? getContinuousMetricColorCss(layer, activeVal)
            : '#64748B';
          const isHovered = hoveredDeviceId === device.id;

          const isAbnormal =
            device.online &&
            ((layer === 'temperature' && typeof activeVal === 'number' && activeVal >= 24.5) ||
              (layer === 'noiseAvg' && typeof activeVal === 'number' && activeVal >= 50.0) ||
              (layer === 'pm2_5' && typeof activeVal === 'number' && activeVal >= 22.0));

          return (
            <div
              key={device.id}
              style={{
                left: `${px.x}px`,
                top: `${px.y}px`,
              }}
              className="pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2"
            >
              {isAbnormal && (
                <span
                  className="pointer-events-none absolute -inset-2 animate-ping rounded-full opacity-60"
                  style={{ backgroundColor: colorHex }}
                />
              )}
              <button
                type="button"
                onMouseEnter={() => setHoveredDeviceId(device.id)}
                onMouseLeave={() => setHoveredDeviceId(null)}
                onFocus={() => setHoveredDeviceId(device.id)}
                onBlur={() => setHoveredDeviceId(null)}
                onClick={(ev) => {
                  ev.stopPropagation();
                  if (room) onSelectRoom(room);
                  onSelectDevice?.(device, room);
                }}
                aria-label={`Trạm cảm biến ${device.name} (${device.hardwareId}) - ${
                  device.online ? 'Trực tuyến' : 'Mất kết nối'
                }`}
                className={`relative group flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold transition-all hover:scale-125 focus:scale-125 focus:outline-none focus:ring-2 focus:ring-sky-400 ${
                  device.online
                    ? 'border-2 border-white shadow-lg'
                    : 'border-2 border-dashed border-slate-400 bg-slate-800/90 text-slate-300 opacity-85'
                }`}
                style={
                  device.online
                    ? {
                        backgroundColor: colorHex,
                        color: '#0F172A',
                        boxShadow: `0 0 14px ${colorHex}, 0 2px 4px rgba(0,0,0,0.6)`,
                        transition: 'background-color 0.4s ease-out, box-shadow 0.4s ease-out',
                      }
                    : undefined
                }
              >
                <span aria-hidden="true">{device.online ? '●' : '✕'}</span>
              </button>

              {/* Station Metric Value Pill (Directly visible at a glance like weather map) */}
              {activeVal !== null && (
                <div
                  className="pointer-events-none mt-1 -translate-x-0 rounded px-1.5 py-0.5 text-center font-mono font-bold text-2xs shadow-md border"
                  style={{
                    backgroundColor: 'rgba(15, 23, 42, 0.92)',
                    borderColor: device.online ? colorHex : '#64748B',
                    color: '#F8FAFC',
                    whiteSpace: 'nowrap',
                    transition: 'border-color 0.4s ease-out',
                  }}
                >
                  {formatLayerMetricValue(activeVal, layer)}
                </div>
              )}

              {/* Quick Hover Tooltip */}
              {isHovered && (
                <div
                  role="tooltip"
                  className="pointer-events-none absolute bottom-9 left-1/2 z-30 w-52 -translate-x-1/2 rounded-lg border border-slate-200 bg-white p-2.5 text-xs text-slate-800 shadow-lg"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-semibold text-slate-900">
                      {device.name}
                    </span>
                    <span
                      className={`badge ${
                        device.online
                          ? 'badge-success'
                          : 'badge-neutral'
                      }`}
                    >
                      {device.online ? 'Trực tuyến' : 'Mất kết nối'}
                    </span>
                  </div>
                  <p className="mt-0.5 font-mono text-2xs text-slate-400">
                    {device.hardwareId}
                  </p>
                  {room && (
                    <p className="mt-0.5 text-2xs text-slate-500 truncate">
                      {room.code} — {room.name}
                    </p>
                  )}
                  <div className="mt-2 grid grid-cols-2 gap-1 border-t border-slate-100 pt-1.5 font-mono text-2xs text-slate-600">
                    <span>
                      Điểm: {formatMetrics.comfortScore(devTel?.comfortScore?.overall)}
                    </span>
                    <span>
                      Ồn: {formatMetrics.noise(devTel?.acoustics?.noiseAvg)}
                    </span>
                    <span>
                      PM2.5: {formatMetrics.pm(devTel?.airQuality?.pm2_5)}
                    </span>
                    <span>
                      Nhiệt: {formatMetrics.temperature(devTel?.environment?.temperature)}
                    </span>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
