import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

afterEach(() => {
  cleanup();
});
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
import {
  TQB_BUILDING_DEPTH_M,
  TQB_BUILDING_WIDTH_M,
} from '@/config/tqb-floorplan-presets';
import { RoomSensorPositionPicker } from '@/features/devices/components/RoomSensorPositionPicker';
import type { Point2D, RoomResponse } from '@/types/api';

// T-shaped polygon similar to TQB 301 (wide top wing, narrow bottom stem)
const T_SHAPED_POLYGON: Point2D[] = [
  { x: 0.3, y: 0.05 },
  { x: 0.7, y: 0.05 },
  { x: 0.7, y: 0.25 },
  { x: 0.6, y: 0.25 },
  { x: 0.6, y: 0.45 },
  { x: 0.4, y: 0.45 },
  { x: 0.4, y: 0.25 },
  { x: 0.3, y: 0.25 },
];

const MOCK_T_ROOM: RoomResponse = {
  id: 'room-t301',
  code: 'TQB_301',
  name: 'Phòng Đa Phương Tiện 301',
  floor: 3,
  capacity: 200,
  type: 'STUDY_ROOM',
  boundaryPolygon: T_SHAPED_POLYGON,
};

describe('Real-world sensor meter coordinate helpers (coords.ts)', () => {
  it('round-trips normalized [0..1] <-> building floor meters accurately', () => {
    const original: Point2D = { x: 0.5, y: 0.805 };
    const floorM = normalizedToFloorMeters(original);
    expect(floorM.x).toBeCloseTo(TQB_BUILDING_WIDTH_M * 0.5, 1);
    expect(floorM.y).toBeCloseTo(TQB_BUILDING_DEPTH_M * 0.805, 1);

    const restored = floorMetersToNormalized(floorM);
    expect(restored.x).toBeCloseTo(original.x, 3);
    expect(restored.y).toBeCloseTo(original.y, 3);
  });

  it('clamps out-of-range floor meters cleanly into [0, 1]', () => {
    expect(floorMetersToNormalized({ x: -10, y: 999 })).toEqual({ x: 0, y: 1 });
  });

  it('computes room bounding box and round-trips room-local meters accurately', () => {
    const bounds = getRoomBoundsMeters(T_SHAPED_POLYGON);
    expect(bounds).not.toBeNull();
    expect(bounds!.widthM).toBeCloseTo(0.4 * TQB_BUILDING_WIDTH_M, 1);
    expect(bounds!.depthM).toBeCloseTo(0.4 * TQB_BUILDING_DEPTH_M, 1);

    const targetNorm: Point2D = { x: 0.5, y: 0.2 };
    const local = normalizedToRoomLocalMeters(targetNorm, T_SHAPED_POLYGON);
    expect(local).not.toBeNull();
    expect(local!.localXM).toBeCloseTo(0.2 * TQB_BUILDING_WIDTH_M, 1);
    expect(local!.localYM).toBeCloseTo(0.15 * TQB_BUILDING_DEPTH_M, 1);

    const restored = roomLocalMetersToNormalized(
      local!.localXM,
      local!.localYM,
      T_SHAPED_POLYGON
    );
    expect(restored.x).toBeCloseTo(targetNorm.x, 3);
    expect(restored.y).toBeCloseTo(targetNorm.y, 3);
  });

  it('places default device position strictly inside a T-shaped room polygon', () => {
    const defaultPos = getDefaultDevicePositionForRoom(MOCK_T_ROOM);
    expect(isPointInPolygon(defaultPos, T_SHAPED_POLYGON)).toBe(true);

    // Fallback when room is null
    expect(getDefaultDevicePositionForRoom(null)).toEqual({ x: 0.5, y: 0.5 });
  });

  it('formats Vietnamese real-world meters for both room-local and floor-wide modes', () => {
    const roomFormatted = formatDevicePositionMetersVi(
      { x: 0.5, y: 0.2 },
      T_SHAPED_POLYGON
    );
    expect(roomFormatted.isRoomLocal).toBe(true);
    expect(roomFormatted.primary).toContain('Tây');
    expect(roomFormatted.primary).toContain('Bắc');
    expect(roomFormatted.secondary).toContain('Sàn:');

    const floorFormatted = formatDevicePositionMetersVi({ x: 0.5, y: 0.5 }, null);
    expect(floorFormatted.isRoomLocal).toBe(false);
    expect(floorFormatted.primary).toBe('X: 38.0 m · Y: 28.6 m');
    expect(floorFormatted.secondary).toContain('76 × 57.2 m');
  });
});

describe('RoomSensorPositionPicker component', () => {
  it('renders room-local meter inputs when room has polygon and converts typed meters to normalized [0..1]', () => {
    const handleChange = vi.fn();
    render(
      <RoomSensorPositionPicker
        room={MOCK_T_ROOM}
        value={{ x: 0.5, y: 0.2 }}
        onChange={handleChange}
      />
    );

    expect(screen.getByText(/Cách tường trái \/ Tây/i)).toBeInTheDocument();
    expect(screen.getByText(/Cách tường trên \/ Bắc/i)).toBeInTheDocument();
    expect(
      screen.queryByTestId('sensor-pos-outside-warning')
    ).not.toBeInTheDocument();

    const xInput = screen.getByTestId('sensor-pos-x-input');
    fireEvent.change(xInput, { target: { value: '10.0' } });

    expect(handleChange).toHaveBeenCalledTimes(1);
    const nextPt = handleChange.mock.calls[0][0] as Point2D;
    const expectedNorm = roomLocalMetersToNormalized(
      10.0,
      normalizedToRoomLocalMeters({ x: 0.5, y: 0.2 }, T_SHAPED_POLYGON)!.localYM,
      T_SHAPED_POLYGON
    );
    expect(nextPt.x).toBeCloseTo(expectedNorm.x, 3);
    expect(nextPt.y).toBeCloseTo(expectedNorm.y, 3);
  });

  it('falls back to floor-wide meter inputs when no room is selected', () => {
    render(
      <RoomSensorPositionPicker
        room={null}
        value={{ x: 0.5, y: 0.5 }}
        onChange={vi.fn()}
      />
    );

    expect(screen.getByText(/Trục Đông–Tây X/i)).toBeInTheDocument();
    expect(screen.getByText(/Trục Bắc–Nam Y/i)).toBeInTheDocument();
    expect(screen.getByTestId('sensor-pos-x-input')).toHaveValue(38);
    expect(screen.getByTestId('sensor-pos-y-input')).toHaveValue(28.6);
  });

  it('shows out-of-polygon warning when sensor lands in recessed cutout of T-shaped room and centers on button click', () => {
    const handleChange = vi.fn();
    // Point (0.33, 0.40) is inside the bounding box [0.3..0.7, 0.05..0.45] but OUTSIDE the T-shape!
    render(
      <RoomSensorPositionPicker
        room={MOCK_T_ROOM}
        value={{ x: 0.33, y: 0.4 }}
        onChange={handleChange}
      />
    );

    expect(screen.getByTestId('sensor-pos-outside-warning')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('sensor-pos-center-btn'));
    expect(handleChange).toHaveBeenCalledTimes(1);
    const centered = handleChange.mock.calls[0][0] as Point2D;
    expect(isPointInPolygon(centered, T_SHAPED_POLYGON)).toBe(true);
  });

  it('disables inputs and hides action buttons when disabled=true', () => {
    render(
      <RoomSensorPositionPicker
        room={MOCK_T_ROOM}
        value={{ x: 0.5, y: 0.2 }}
        onChange={vi.fn()}
        disabled
      />
    );

    expect(screen.getByTestId('sensor-pos-x-input')).toBeDisabled();
    expect(screen.getByTestId('sensor-pos-y-input')).toBeDisabled();
    expect(screen.queryByTestId('sensor-pos-center-btn')).not.toBeInTheDocument();
  });
});
