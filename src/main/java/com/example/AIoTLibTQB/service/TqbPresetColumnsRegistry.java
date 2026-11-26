package com.example.AIoTLibTQB.service;

import com.example.AIoTLibTQB.document.Point2D;

import java.util.List;
import java.util.Map;

/**
 * Tọa độ chuẩn hóa của các cột chịu lực BTCT (0.60m × 0.60m) theo mã phòng chuẩn TQB,
 * đồng bộ 100% với TQB_ROOM_PRESETS trên Frontend.
 */
public final class TqbPresetColumnsRegistry {

    private static final List<Point2D> NORTH_HALL_COLUMNS = List.of(
            new Point2D(0.399, 0.032),
            new Point2D(0.5, 0.032),
            new Point2D(0.6, 0.032),
            new Point2D(0.399, 0.186),
            new Point2D(0.5, 0.186),
            new Point2D(0.6, 0.186)
    );

    private static final List<Point2D> WEST_HALL_COLUMNS = List.of(
            new Point2D(0.022, 0.536),
            new Point2D(0.123, 0.536)
    );

    private static final List<Point2D> EAST_HALL_COLUMNS = List.of(
            new Point2D(0.877, 0.536),
            new Point2D(0.978, 0.536)
    );

    private static final List<Point2D> TQB_101_COLUMNS = List.of(
            new Point2D(0.399, 0.422),
            new Point2D(0.5, 0.422),
            new Point2D(0.6, 0.422),
            new Point2D(0.399, 0.69),
            new Point2D(0.5, 0.69),
            new Point2D(0.6, 0.69)
    );

    private static final List<Point2D> TQB_102_COLUMNS = List.of(
            new Point2D(0.5, 0.205)
    );

    private static final Map<String, List<Point2D>> COLUMNS_BY_CODE = Map.ofEntries(
            Map.entry("TQB_101", TQB_101_COLUMNS),
            Map.entry("TQB_102", TQB_102_COLUMNS),
            Map.entry("TQB_103", WEST_HALL_COLUMNS),
            Map.entry("TQB_104", EAST_HALL_COLUMNS),
            Map.entry("TQB_201", NORTH_HALL_COLUMNS),
            Map.entry("TQB_202", WEST_HALL_COLUMNS),
            Map.entry("TQB_203", EAST_HALL_COLUMNS),
            Map.entry("TQB_301", NORTH_HALL_COLUMNS),
            Map.entry("TQB_302", WEST_HALL_COLUMNS),
            Map.entry("TQB_303", EAST_HALL_COLUMNS),
            Map.entry("TQB_401", NORTH_HALL_COLUMNS),
            Map.entry("TQB_501", NORTH_HALL_COLUMNS),
            Map.entry("TQB_502", WEST_HALL_COLUMNS),
            Map.entry("TQB_503", EAST_HALL_COLUMNS)
    );

    private TqbPresetColumnsRegistry() {
    }

    public static List<Point2D> getColumnsForRoomCode(String roomCode) {
        if (roomCode == null || roomCode.isBlank()) {
            return List.of();
        }
        return COLUMNS_BY_CODE.getOrDefault(roomCode.trim().toUpperCase(), List.of());
    }
}
