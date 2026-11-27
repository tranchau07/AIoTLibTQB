'use client';

import React, { useMemo, useRef, useState } from 'react';
import { AlertTriangle, Compass, Crosshair, MapPin } from 'lucide-react';
import {
  TQB_BUILDING_DEPTH_M,
  TQB_BUILDING_WIDTH_M,
  resolveRoomPolygon,
} from '@/config/tqb-floorplan-presets';
import {
  floorMetersToNormalized,
  formatDevicePositionMetersVi,
  getDefaultDevicePositionForRoom,
  getRoomBoundsMeters,
  normalizedToFloorMeters,
  normalizedToRoomLocalMeters,
  roomLocalMetersToNormalized,
} from '@/lib/floorplan/coords';
import { isPointInPolygon } from '@/lib/floorplan/polygon';
import type { DeviceResponse, Point2D, RoomResponse } from '@/types/api';

export interface RoomSensorPositionPickerProps {
  /** Phòng đọc đang chọn (nếu có); khi phòng có polygon, tự dùng hệ mét cục bộ từ mép tường phòng. */
  room?: RoomResponse | null;
  /** Tọa độ chuẩn hóa [0.0 – 1.0] nội bộ dùng để đồng bộ với API/DB. */
  value: Point2D | null;
  /** Callback trả tọa độ chuẩn hóa [0.0 – 1.0] mỗi khi người dùng nhập mét hoặc kéo pin trên mini-map. */
  onChange: (next: Point2D) => void;
  /** Danh sách cảm biến khác trong cùng phòng để hiển thị tham chiếu (tránh đặt trùng vị trí). */
  siblingDevices?: readonly DeviceResponse[];
  /** ID thiết bị đang sửa (để loại trừ khỏi danh sách chấm anh em). */
  currentDeviceId?: string;
  /** Vô hiệu hóa tương tác khi người dùng chỉ có quyền xem. */
  disabled?: boolean;
  /** Tiền tố id giúp đảm bảo duy nhất cho label/input khi mở nhiều form/modal. */
  idPrefix?: string;
}

const SVG_VIEW_W = 320;
const SVG_VIEW_H = 210;
const SVG_PAD_X = 34;
const SVG_PAD_TOP = 26;
const SVG_PAD_BOTTOM = 22;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function RoomSensorPositionPicker({
  room,
  value,
  onChange,
  siblingDevices = [],
  currentDeviceId,
  disabled = false,
  idPrefix = 'sensor-pos',
}: RoomSensorPositionPickerProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [showFloorRef, setShowFloorRef] = useState(false);

  const polygon = useMemo<Point2D[]>(() => {
    if (!room) return [];
    const resolved = resolveRoomPolygon(room, 0);
    return Array.isArray(resolved) && resolved.length >= 3 ? [...resolved] : [];
  }, [room]);

  const roomBounds = useMemo(() => getRoomBoundsMeters(polygon), [polygon]);
  const isRoomLocal = Boolean(roomBounds);

  const effectivePoint: Point2D = useMemo(() => {
    if (
      value &&
      Number.isFinite(value.x) &&
      Number.isFinite(value.y)
    ) {
      return value;
    }
    return getDefaultDevicePositionForRoom(room);
  }, [value, room]);

  const floorM = useMemo(
    () => normalizedToFloorMeters(effectivePoint),
    [effectivePoint]
  );

  const roomLocal = useMemo(
    () =>
      isRoomLocal
        ? normalizedToRoomLocalMeters(effectivePoint, polygon)
        : null,
    [isRoomLocal, effectivePoint, polygon]
  );

  const isInsideRoom = useMemo(() => {
    if (!isRoomLocal || polygon.length < 3) return true;
    return isPointInPolygon(effectivePoint, polygon);
  }, [isRoomLocal, polygon, effectivePoint]);

  // Tính hệ số chiếu mét → tọa độ SVG giữ đúng tỷ lệ hình học 1:1
  const projection = useMemo(() => {
    const viewMinX = roomBounds ? roomBounds.minXM : 0;
    const viewMinY = roomBounds ? roomBounds.minYM : 0;
    const viewW = roomBounds ? roomBounds.widthM : TQB_BUILDING_WIDTH_M;
    const viewH = roomBounds ? roomBounds.depthM : TQB_BUILDING_DEPTH_M;

    const innerW = SVG_VIEW_W - SVG_PAD_X * 2;
    const innerH = SVG_VIEW_H - SVG_PAD_TOP - SVG_PAD_BOTTOM;
    const scale = Math.min(innerW / Math.max(0.5, viewW), innerH / Math.max(0.5, viewH));

    const drawW = viewW * scale;
    const drawH = viewH * scale;
    const offsetX = SVG_PAD_X + (innerW - drawW) / 2;
    const offsetY = SVG_PAD_TOP + (innerH - drawH) / 2;

    const metersToSvg = (xm: number, ym: number) => ({
      sx: offsetX + (xm - viewMinX) * scale,
      sy: offsetY + (ym - viewMinY) * scale,
    });

    const svgToMeters = (sx: number, sy: number) => ({
      xm: viewMinX + (sx - offsetX) / scale,
      ym: viewMinY + (sy - offsetY) / scale,
    });

    // Bước lưới hợp lý theo kích thước không gian
    const maxDim = Math.max(viewW, viewH);
    const gridStepM = maxDim <= 12 ? 2 : maxDim <= 35 ? 5 : 10;

    return {
      viewMinX,
      viewMinY,
      viewW,
      viewH,
      drawW,
      drawH,
      offsetX,
      offsetY,
      scale,
      gridStepM,
      metersToSvg,
      svgToMeters,
    };
  }, [roomBounds]);

  const polygonSvgPoints = useMemo(() => {
    if (polygon.length < 3) return '';
    return polygon
      .map((pt) => {
        const m = normalizedToFloorMeters(pt);
        const { sx, sy } = projection.metersToSvg(m.x, m.y);
        return `${sx.toFixed(1)},${sy.toFixed(1)}`;
      })
      .join(' ');
  }, [polygon, projection]);

  const pinSvg = useMemo(
    () => projection.metersToSvg(floorM.x, floorM.y),
    [projection, floorM]
  );

  const clampedPinSvg = useMemo(
    () => ({
      sx: Math.max(8, Math.min(SVG_VIEW_W - 8, pinSvg.sx)),
      sy: Math.max(8, Math.min(SVG_VIEW_H - 8, pinSvg.sy)),
    }),
    [pinSvg]
  );

  const siblingPins = useMemo(() => {
    return siblingDevices
      .filter(
        (d) =>
          d.id !== currentDeviceId &&
          typeof d.posX === 'number' &&
          typeof d.posY === 'number' &&
          (!room || d.roomId === room.id)
      )
      .map((d) => {
        const m = normalizedToFloorMeters({ x: d.posX!, y: d.posY! });
        const { sx, sy } = projection.metersToSvg(m.x, m.y);
        return { device: d, sx, sy };
      });
  }, [siblingDevices, currentDeviceId, room, projection]);

  const gridLines = useMemo(() => {
    const vLines: Array<{ x: number; label: string }> = [];
    const hLines: Array<{ y: number; label: string }> = [];
    const step = projection.gridStepM;
    for (let dx = step; dx < projection.viewW - 0.01; dx += step) {
      const { sx } = projection.metersToSvg(projection.viewMinX + dx, projection.viewMinY);
      vLines.push({ x: sx, label: `${dx}m` });
    }
    for (let dy = step; dy < projection.viewH - 0.01; dy += step) {
      const { sy } = projection.metersToSvg(projection.viewMinX, projection.viewMinY + dy);
      hLines.push({ y: sy, label: `${dy}m` });
    }
    return { vLines, hLines };
  }, [projection]);

  const handleXMetersChange = (raw: string) => {
    if (disabled) return;
    const parsed = parseFloat(raw);
    if (!Number.isFinite(parsed)) return;

    if (roomBounds && roomLocal) {
      const clampedX = Math.max(0, Math.min(roomBounds.widthM, parsed));
      onChange(
        roomLocalMetersToNormalized(clampedX, roomLocal.localYM, polygon)
      );
    } else {
      const clampedX = Math.max(0, Math.min(TQB_BUILDING_WIDTH_M, parsed));
      onChange(floorMetersToNormalized({ x: clampedX, y: floorM.y }));
    }
  };

  const handleYMetersChange = (raw: string) => {
    if (disabled) return;
    const parsed = parseFloat(raw);
    if (!Number.isFinite(parsed)) return;

    if (roomBounds && roomLocal) {
      const clampedY = Math.max(0, Math.min(roomBounds.depthM, parsed));
      onChange(
        roomLocalMetersToNormalized(roomLocal.localXM, clampedY, polygon)
      );
    } else {
      const clampedY = Math.max(0, Math.min(TQB_BUILDING_DEPTH_M, parsed));
      onChange(floorMetersToNormalized({ x: floorM.x, y: clampedY }));
    }
  };

  const handleResetToCenter = () => {
    if (disabled) return;
    onChange(getDefaultDevicePositionForRoom(room));
  };

  const updateFromClientPointer = (clientX: number, clientY: number) => {
    if (disabled || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const sx = ((clientX - rect.left) / rect.width) * SVG_VIEW_W;
    const sy = ((clientY - rect.top) / rect.height) * SVG_VIEW_H;
    const { xm, ym } = projection.svgToMeters(sx, sy);

    if (roomBounds) {
      const localX = round1(
        Math.max(0, Math.min(roomBounds.widthM, xm - roomBounds.minXM))
      );
      const localY = round1(
        Math.max(0, Math.min(roomBounds.depthM, ym - roomBounds.minYM))
      );
      onChange(roomLocalMetersToNormalized(localX, localY, polygon));
    } else {
      const clampedX = round1(Math.max(0, Math.min(TQB_BUILDING_WIDTH_M, xm)));
      const clampedY = round1(Math.max(0, Math.min(TQB_BUILDING_DEPTH_M, ym)));
      onChange(floorMetersToNormalized({ x: clampedX, y: clampedY }));
    }
  };

  const handlePointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (disabled) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDragging(true);
    updateFromClientPointer(e.clientX, e.clientY);
  };

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragging || disabled) return;
    updateFromClientPointer(e.clientX, e.clientY);
  };

  const handlePointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragging) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    setDragging(false);
  };

  const formatted = useMemo(
    () => formatDevicePositionMetersVi(effectivePoint, isRoomLocal ? polygon : null),
    [effectivePoint, isRoomLocal, polygon]
  );

  const displayX = isRoomLocal && roomLocal ? round1(roomLocal.localXM) : round1(floorM.x);
  const displayY = isRoomLocal && roomLocal ? round1(roomLocal.localYM) : round1(floorM.y);
  const maxX = roomBounds ? round1(roomBounds.widthM) : TQB_BUILDING_WIDTH_M;
  const maxY = roomBounds ? round1(roomBounds.depthM) : TQB_BUILDING_DEPTH_M;

  return (
    <div
      data-testid="sensor-position-picker"
      className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/70 p-3"
    >
      {/* Header: Mode badge + quick actions */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-800">
          <MapPin className="h-3.5 w-3.5 text-brand-600" aria-hidden="true" />
          <span>Vị trí lắp đặt thực tế (mét)</span>
          {isRoomLocal && room ? (
            <span className="rounded bg-sky-50 px-1.5 py-0.5 font-mono text-[10px] font-medium text-sky-800 ring-1 ring-inset ring-sky-200">
              {room.code} · {roomBounds!.widthM.toFixed(1)}m × {roomBounds!.depthM.toFixed(1)}m
            </span>
          ) : (
            <span className="rounded bg-slate-200/70 px-1.5 py-0.5 font-mono text-[10px] font-medium text-slate-700">
              Toàn sàn · {TQB_BUILDING_WIDTH_M.toFixed(0)}m × {TQB_BUILDING_DEPTH_M.toFixed(1)}m
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          {!disabled && (
            <button
              type="button"
              data-testid="sensor-pos-center-btn"
              onClick={handleResetToCenter}
              className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100"
              title={
                isRoomLocal
                  ? 'Đặt cảm biến vào chính giữa phòng đọc'
                  : 'Đặt cảm biến vào giữa mặt bằng tầng'
              }
            >
              <Crosshair className="h-3 w-3 text-brand-600" aria-hidden="true" />
              <span>{isRoomLocal ? 'Đặt về tâm phòng' : 'Đặt giữa tầng'}</span>
            </button>
          )}
        </div>
      </div>

      {/* Two meter inputs */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor={`${idPrefix}-xm`} className="label">
            {isRoomLocal
              ? `Cách tường trái / Tây (0 – ${maxX} m)`
              : `Trục Đông–Tây X (0 – ${maxX} m)`}
          </label>
          <div className="relative">
            <input
              id={`${idPrefix}-xm`}
              data-testid="sensor-pos-x-input"
              type="number"
              step="0.1"
              min={0}
              max={maxX}
              disabled={disabled}
              value={displayX}
              onChange={(e) => handleXMetersChange(e.target.value)}
              className="input pr-8 text-xs font-mono tabular-nums"
            />
            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-slate-400">
              m
            </span>
          </div>
        </div>

        <div>
          <label htmlFor={`${idPrefix}-ym`} className="label">
            {isRoomLocal
              ? `Cách tường trên / Bắc (0 – ${maxY} m)`
              : `Trục Bắc–Nam Y (0 – ${maxY} m)`}
          </label>
          <div className="relative">
            <input
              id={`${idPrefix}-ym`}
              data-testid="sensor-pos-y-input"
              type="number"
              step="0.1"
              min={0}
              max={maxY}
              disabled={disabled}
              value={displayY}
              onChange={(e) => handleYMetersChange(e.target.value)}
              className="input pr-8 text-xs font-mono tabular-nums"
            />
            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-slate-400">
              m
            </span>
          </div>
        </div>
      </div>

      {/* Interactive Mini-Map SVG */}
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-slate-950">
        <svg
          ref={svgRef}
          data-testid="sensor-pos-minimap"
          viewBox={`0 0 ${SVG_VIEW_W} ${SVG_VIEW_H}`}
          role="img"
          aria-label={`Sơ đồ chọn vị trí cảm biến theo mét (${formatted.primary})`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          className={`block h-48 w-full select-none ${
            disabled
              ? 'cursor-default opacity-80'
              : dragging
              ? 'cursor-grabbing'
              : 'cursor-crosshair'
          }`}
        >
          {/* Room/Floor bounding box frame */}
          <rect
            x={projection.offsetX}
            y={projection.offsetY}
            width={projection.drawW}
            height={projection.drawH}
            fill="rgba(15, 23, 42, 0.8)"
            stroke="rgba(148, 163, 184, 0.3)"
            strokeDasharray="3 3"
            strokeWidth={1}
          />

          {/* Reference meter grid */}
          {gridLines.vLines.map((ln) => (
            <line
              key={`v-${ln.label}`}
              x1={ln.x}
              y1={projection.offsetY}
              x2={ln.x}
              y2={projection.offsetY + projection.drawH}
              stroke="rgba(148, 163, 184, 0.14)"
              strokeWidth={1}
            />
          ))}
          {gridLines.hLines.map((ln) => (
            <line
              key={`h-${ln.label}`}
              x1={projection.offsetX}
              y1={ln.y}
              x2={projection.offsetX + projection.drawW}
              y2={ln.y}
              stroke="rgba(148, 163, 184, 0.14)"
              strokeWidth={1}
            />
          ))}

          {/* Actual room polygon */}
          {polygonSvgPoints ? (
            <polygon
              points={polygonSvgPoints}
              fill={
                isInsideRoom
                  ? 'rgba(56, 189, 248, 0.18)'
                  : 'rgba(239, 68, 68, 0.16)'
              }
              stroke={isInsideRoom ? '#38BDF8' : '#F87171'}
              strokeWidth={1.8}
              strokeLinejoin="round"
            />
          ) : (
            <rect
              x={projection.offsetX}
              y={projection.offsetY}
              width={projection.drawW}
              height={projection.drawH}
              fill="rgba(56, 189, 248, 0.12)"
              stroke="#38BDF8"
              strokeWidth={1.5}
            />
          )}

          {/* Axis labels: North & West wall dimensions */}
          <text
            x={projection.offsetX + projection.drawW / 2}
            y={projection.offsetY - 8}
            textAnchor="middle"
            className="fill-slate-300 font-mono text-[9px]"
          >
            BẮC · {projection.viewW.toFixed(1)} m →
          </text>
          <text
            x={projection.offsetX - 8}
            y={projection.offsetY + projection.drawH / 2}
            textAnchor="middle"
            transform={`rotate(-90 ${projection.offsetX - 8} ${projection.offsetY + projection.drawH / 2})`}
            className="fill-slate-300 font-mono text-[9px]"
          >
            TÂY · {projection.viewH.toFixed(1)} m
          </text>

          {/* Origin (0m, 0m) dot */}
          <circle
            cx={projection.offsetX}
            cy={projection.offsetY}
            r={2.5}
            fill="#94A3B8"
          />
          <text
            x={projection.offsetX + 4}
            y={projection.offsetY - 4}
            className="fill-slate-400 font-mono text-[8px]"
          >
            0m
          </text>

          {/* Sibling sensors in the same room */}
          {siblingPins.map(({ device, sx, sy }) => (
            <g key={device.id} opacity={0.65}>
              <circle
                cx={sx}
                cy={sy}
                r={4}
                fill="#64748B"
                stroke="#E2E8F0"
                strokeWidth={1}
              />
              <title>{`${device.name} (${device.hardwareId})`}</title>
            </g>
          ))}

          {/* Live dashed dimension lines to West & North reference walls */}
          <line
            x1={projection.offsetX}
            y1={clampedPinSvg.sy}
            x2={clampedPinSvg.sx}
            y2={clampedPinSvg.sy}
            stroke={isInsideRoom ? '#34D399' : '#F87171'}
            strokeWidth={1.1}
            strokeDasharray="3 2"
          />
          <line
            x1={clampedPinSvg.sx}
            y1={projection.offsetY}
            x2={clampedPinSvg.sx}
            y2={clampedPinSvg.sy}
            stroke={isInsideRoom ? '#34D399' : '#F87171'}
            strokeWidth={1.1}
            strokeDasharray="3 2"
          />

          {/* Distance badges along dimension lines */}
          {Math.abs(clampedPinSvg.sx - projection.offsetX) > 26 && (
            <text
              x={(projection.offsetX + clampedPinSvg.sx) / 2}
              y={clampedPinSvg.sy - 4}
              textAnchor="middle"
              className="fill-emerald-300 font-mono text-[8.5px] font-semibold"
            >
              {displayX.toFixed(1)}m
            </text>
          )}
          {Math.abs(clampedPinSvg.sy - projection.offsetY) > 22 && (
            <text
              x={clampedPinSvg.sx + 5}
              y={(projection.offsetY + clampedPinSvg.sy) / 2 + 3}
              className="fill-emerald-300 font-mono text-[8.5px] font-semibold"
            >
              {displayY.toFixed(1)}m
            </text>
          )}

          {/* Active sensor pin */}
          <circle
            cx={clampedPinSvg.sx}
            cy={clampedPinSvg.sy}
            r={10}
            fill={isInsideRoom ? 'rgba(16, 185, 129, 0.25)' : 'rgba(239, 68, 68, 0.28)'}
          />
          <circle
            cx={clampedPinSvg.sx}
            cy={clampedPinSvg.sy}
            r={5.5}
            fill={isInsideRoom ? '#10B981' : '#EF4444'}
            stroke="#FFFFFF"
            strokeWidth={1.8}
          />
        </svg>
      </div>

      {/* Out-of-polygon warning */}
      {!isInsideRoom && (
        <div
          role="alert"
          data-testid="sensor-pos-outside-warning"
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-2 text-[11px] text-amber-900"
        >
          <div className="flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden="true" />
            <span>
              Vị trí ({displayX.toFixed(1)} m, {displayY.toFixed(1)} m) đang nằm ngoài
              ranh giới tường phòng {room?.code}.
            </span>
          </div>
          {!disabled && (
            <button
              type="button"
              onClick={handleResetToCenter}
              className="font-semibold text-amber-950 underline hover:text-amber-700"
            >
              Đặt về tâm phòng
            </button>
          )}
        </div>
      )}

      {/* Footer summary + optional building-level CAD coordinate reference */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
        <span>
          Nhấp hoặc kéo trực tiếp chấm xanh trên sơ đồ để chấm nhanh vị trí.
        </span>
        <button
          type="button"
          onClick={() => setShowFloorRef((v) => !v)}
          className="inline-flex items-center gap-1 font-medium text-slate-600 hover:text-slate-900"
        >
          <Compass className="h-3 w-3" aria-hidden="true" />
          <span>{showFloorRef ? 'Ẩn tọa độ toàn sàn' : 'Xem tọa độ toàn sàn'}</span>
        </button>
      </div>

      {showFloorRef && (
        <div
          data-testid="sensor-pos-floor-ref"
          className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 bg-white px-2.5 py-1.5 font-mono text-[11px] text-slate-600 tabular-nums"
        >
          <span>
            Sàn toàn tầng: X = {floorM.x.toFixed(1)} m · Y = {floorM.y.toFixed(1)} m
          </span>
          <span className="text-[10px] text-slate-400">
            Chuẩn hóa: ({effectivePoint.x.toFixed(4)}, {effectivePoint.y.toFixed(4)})
          </span>
        </div>
      )}
    </div>
  );
}
