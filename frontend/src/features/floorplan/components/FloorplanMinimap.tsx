'use client';

import React, { useRef } from 'react';
import { TQB_BUILDING_ASPECT_RATIO } from '@/config/tqb-floorplan-presets';
import { ZOOM_CONFIG } from '@/config/floorplan-hmi.config';
import { minimapClickToViewport, type ViewportTransform } from '@/lib/floorplan/coords';
import { FLOORPLAN_I18N_VI } from '@/messages/vi';
import type { Point2D } from '@/types/api';

export interface MinimapRoomShape {
  id: string;
  code: string;
  polygon: readonly Point2D[];
  hasAlert: boolean;
  isSelected: boolean;
}

export interface FloorplanMinimapProps {
  viewport: ViewportTransform;
  canvasWidth: number;
  canvasHeight: number;
  rooms: readonly MinimapRoomShape[];
  activeFloor: number;
  onNavigate: (nextViewport: ViewportTransform) => void;
  positionCorner?: 'bottom-right' | 'bottom-left';
}

const SVG_W = 100;
const SVG_H = Number((100 * TQB_BUILDING_ASPECT_RATIO).toFixed(2));

export function FloorplanMinimap({
  viewport,
  canvasWidth,
  canvasHeight,
  rooms,
  activeFloor,
  onNavigate,
  positionCorner = 'bottom-right',
}: FloorplanMinimapProps) {
  const isDraggingRef = useRef(false);

  if (viewport.scale <= ZOOM_CONFIG.minimapShowThreshold) {
    return null;
  }

  const safeW = Math.max(1, canvasWidth);
  const safeH = Math.max(1, canvasHeight);
  const safeScale = Math.max(1, viewport.scale);

  const viewNormW = Math.min(1, 1 / safeScale);
  const viewNormH = Math.min(1, 1 / safeScale);
  const viewNormX = Math.max(
    0,
    Math.min(1 - viewNormW, -viewport.tx / (safeScale * safeW))
  );
  const viewNormY = Math.max(
    0,
    Math.min(1 - viewNormH, -viewport.ty / (safeScale * safeH))
  );

  const navigateFromClientPoint = (
    clientX: number,
    clientY: number,
    el: SVGSVGElement
  ) => {
    const rect = el.getBoundingClientRect();
    const clickNorm: Point2D =
      rect.width > 0 && rect.height > 0
        ? {
            x: (clientX - rect.left) / rect.width,
            y: (clientY - rect.top) / rect.height,
          }
        : { x: 0.5, y: 0.5 };
    onNavigate(
      minimapClickToViewport(
        clickNorm,
        safeScale,
        safeW,
        safeH,
        ZOOM_CONFIG.maxScale
      )
    );
  };

  return (
    <div
      data-testid="floorplan-minimap"
      role="region"
      aria-label={`${FLOORPLAN_I18N_VI.controls.minimapTitle} — Tầng ${activeFloor}`}
      className={`pointer-events-auto absolute bottom-3 z-20 rounded-lg border border-slate-700/90 bg-slate-950/92 p-1.5 shadow-xl backdrop-blur ${
        positionCorner === 'bottom-left' ? 'left-3' : 'right-3'
      }`}
    >
      <div className="mb-1 flex items-center justify-between px-0.5 text-[10px] font-semibold text-slate-200">
        <span>Tầng {activeFloor}</span>
        <span className="font-mono text-sky-300 tabular-nums">
          {viewport.scale.toFixed(1)}x
        </span>
      </div>

      <svg
        data-testid="floorplan-minimap-svg"
        viewBox={`0 0 ${SVG_W} ${SVG_H}`}
        width={148}
        height={Math.round(148 * TQB_BUILDING_ASPECT_RATIO)}
        className="block cursor-crosshair rounded border border-slate-800 bg-[#0B1120] touch-none select-none"
        onClick={(e) => {
          navigateFromClientPoint(e.clientX, e.clientY, e.currentTarget);
        }}
        onPointerDown={(e) => {
          isDraggingRef.current = true;
          navigateFromClientPoint(e.clientX, e.clientY, e.currentTarget);
        }}
        onPointerMove={(e) => {
          if (!isDraggingRef.current) return;
          navigateFromClientPoint(e.clientX, e.clientY, e.currentTarget);
        }}
        onPointerUp={() => {
          isDraggingRef.current = false;
        }}
        onPointerCancel={() => {
          isDraggingRef.current = false;
        }}
        onPointerLeave={() => {
          isDraggingRef.current = false;
        }}
      >
        {rooms.map((r) => {
          if (!r.polygon || r.polygon.length < 3) return null;
          const pts = r.polygon
            .map((p) => `${(p.x * SVG_W).toFixed(2)},${(p.y * SVG_H).toFixed(2)}`)
            .join(' ');
          const cx =
            (r.polygon.reduce((acc, p) => acc + p.x, 0) / r.polygon.length) * SVG_W;
          const cy =
            (r.polygon.reduce((acc, p) => acc + p.y, 0) / r.polygon.length) * SVG_H;

          return (
            <g key={r.id}>
              <polygon
                points={pts}
                fill={
                  r.hasAlert
                    ? 'rgba(239, 68, 68, 0.35)'
                    : r.isSelected
                      ? 'rgba(56, 189, 248, 0.30)'
                      : 'rgba(51, 65, 85, 0.45)'
                }
                stroke={
                  r.hasAlert
                    ? '#EF4444'
                    : r.isSelected
                      ? '#38BDF8'
                      : '#475569'
                }
                strokeWidth={r.hasAlert || r.isSelected ? 0.9 : 0.45}
              />
              {r.hasAlert && (
                <circle cx={cx} cy={cy} r={2.2} fill="#EF4444" stroke="#FFF" strokeWidth={0.5} />
              )}
            </g>
          );
        })}

        {/* Active Viewport Indicator */}
        <rect
          data-testid="floorplan-minimap-viewport"
          x={(viewNormX * SVG_W).toFixed(2)}
          y={(viewNormY * SVG_H).toFixed(2)}
          width={(viewNormW * SVG_W).toFixed(2)}
          height={(viewNormH * SVG_H).toFixed(2)}
          fill="rgba(56, 189, 248, 0.16)"
          stroke="#38BDF8"
          strokeWidth={1.1}
          rx={1}
        />
      </svg>
    </div>
  );
}
