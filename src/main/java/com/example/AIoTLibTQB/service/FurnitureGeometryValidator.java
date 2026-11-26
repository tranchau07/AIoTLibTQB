package com.example.AIoTLibTQB.service;

import com.example.AIoTLibTQB.document.FurnitureItemDoc;
import com.example.AIoTLibTQB.document.Point2D;

import java.util.List;
import java.util.Set;

/**
 * Hình học không gian thực 1:100 trên mặt bằng TQB (76.0m × 57.2m):
 * kiểm tra hộp xoay OBB nằm trọn trong đa giác phòng (kể cả đa giác lõm)
 * và kiểm tra chồng lấn bằng định lý trục tách (SAT).
 */
public final class FurnitureGeometryValidator {

    public static final double TQB_BUILDING_WIDTH_M = 76.0;
    public static final double TQB_BUILDING_DEPTH_M = 57.2;
    public static final double STRUCTURAL_COLUMN_SIZE_M = 0.60;

    private static final double EPS = 1e-4;
    private static final Set<String> NON_BLOCKING_TYPES = Set.of("DOOR", "IOT_NODE");

    private FurnitureGeometryValidator() {
    }

    public static boolean blocksWalkway(String typeId) {
        if (typeId == null) {
            return true;
        }
        return !NON_BLOCKING_TYPES.contains(typeId.trim().toUpperCase());
    }

    public static double[][] getObbCornersMeters(FurnitureItemDoc item) {
        double cx = item.getX() * TQB_BUILDING_WIDTH_M;
        double cy = item.getY() * TQB_BUILDING_DEPTH_M;
        double hw = item.getWidthM() / 2.0;
        double hd = item.getDepthM() / 2.0;
        double rad = Math.toRadians(item.getRotationDeg() != null ? item.getRotationDeg() : 0.0);

        double ux = Math.cos(rad);
        double uy = Math.sin(rad);
        double vx = -Math.sin(rad);
        double vy = Math.cos(rad);

        return new double[][]{
                {cx - hw * ux - hd * vx, cy - hw * uy - hd * vy},
                {cx + hw * ux - hd * vx, cy + hw * uy - hd * vy},
                {cx + hw * ux + hd * vx, cy + hw * uy + hd * vy},
                {cx - hw * ux + hd * vx, cy - hw * uy + hd * vy}
        };
    }

    public static boolean isFurnitureInsideRoom(FurnitureItemDoc item, List<Point2D> polygonNorm) {
        if (item == null || item.getX() == null || item.getY() == null
                || item.getWidthM() == null || item.getDepthM() == null) {
            return false;
        }
        if (polygonNorm == null || polygonNorm.size() < 3) {
            return item.getX() >= 0.0 && item.getX() <= 1.0 && item.getY() >= 0.0 && item.getY() <= 1.0;
        }

        double[][] polyMeters = new double[polygonNorm.size()][2];
        for (int i = 0; i < polygonNorm.size(); i++) {
            Point2D p = polygonNorm.get(i);
            if (p == null || p.getX() == null || p.getY() == null) {
                return false;
            }
            polyMeters[i][0] = p.getX() * TQB_BUILDING_WIDTH_M;
            polyMeters[i][1] = p.getY() * TQB_BUILDING_DEPTH_M;
        }

        double[][] corners = getObbCornersMeters(item);
        double cx = item.getX() * TQB_BUILDING_WIDTH_M;
        double cy = item.getY() * TQB_BUILDING_DEPTH_M;

        if (!isPointInOrOnPolygon(cx, cy, polyMeters)) {
            return false;
        }
        for (int i = 0; i < 4; i++) {
            double[] c = corners[i];
            if (c[0] < -EPS || c[0] > TQB_BUILDING_WIDTH_M + EPS
                    || c[1] < -EPS || c[1] > TQB_BUILDING_DEPTH_M + EPS) {
                return false;
            }
            if (!isPointInOrOnPolygon(c[0], c[1], polyMeters)) {
                return false;
            }
            double[] next = corners[(i + 1) % 4];
            double mx = (c[0] + next[0]) * 0.5;
            double my = (c[1] + next[1]) * 0.5;
            if (!isPointInOrOnPolygon(mx, my, polyMeters)) {
                return false;
            }
        }

        int n = polyMeters.length;
        for (int i = 0; i < 4; i++) {
            double[] a1 = corners[i];
            double[] a2 = corners[(i + 1) % 4];
            for (int j = 0; j < n; j++) {
                double[] b1 = polyMeters[j];
                double[] b2 = polyMeters[(j + 1) % n];
                if (segmentsStrictlyIntersect(a1[0], a1[1], a2[0], a2[1], b1[0], b1[1], b2[0], b2[1])) {
                    return false;
                }
            }
        }

        return true;
    }

    public static boolean doesFurnitureOverlapColumn(
            FurnitureItemDoc item,
            List<Point2D> columnsNorm) {
        return doesFurnitureOverlapColumn(item, columnsNorm, STRUCTURAL_COLUMN_SIZE_M);
    }

    public static boolean doesFurnitureOverlapColumn(
            FurnitureItemDoc item,
            List<Point2D> columnsNorm,
            double columnSizeM) {
        if (item == null || columnsNorm == null || columnsNorm.isEmpty()) {
            return false;
        }
        if (!blocksWalkway(item.getTypeId())) {
            return false;
        }
        for (Point2D colNorm : columnsNorm) {
            if (colNorm == null || colNorm.getX() == null || colNorm.getY() == null) {
                continue;
            }
            FurnitureItemDoc colBox = FurnitureItemDoc.builder()
                    .typeId("DESK")
                    .x(colNorm.getX())
                    .y(colNorm.getY())
                    .widthM(columnSizeM)
                    .depthM(columnSizeM)
                    .rotationDeg(0.0)
                    .build();
            if (doFurnitureItemsOverlap(item, colBox)) {
                return true;
            }
        }
        return false;
    }

    public static boolean doFurnitureItemsOverlap(FurnitureItemDoc a, FurnitureItemDoc b) {
        if (a == null || b == null) {
            return false;
        }
        if (!blocksWalkway(a.getTypeId()) || !blocksWalkway(b.getTypeId())) {
            return false;
        }

        double[][] cornersA = getObbCornersMeters(a);
        double[][] cornersB = getObbCornersMeters(b);

        double[][] axes = new double[][]{
                edgeNormal(cornersA[0], cornersA[1]),
                edgeNormal(cornersA[1], cornersA[2]),
                edgeNormal(cornersB[0], cornersB[1]),
                edgeNormal(cornersB[1], cornersB[2])
        };

        for (double[] axis : axes) {
            double[] projA = projectPolygon(cornersA, axis[0], axis[1]);
            double[] projB = projectPolygon(cornersB, axis[0], axis[1]);
            if (projA[1] <= projB[0] + EPS || projB[1] <= projA[0] + EPS) {
                return false;
            }
        }
        return true;
    }

    private static double[] edgeNormal(double[] p1, double[] p2) {
        double dx = p2[0] - p1[0];
        double dy = p2[1] - p1[1];
        double len = Math.hypot(dx, dy);
        if (len < 1e-9) {
            return new double[]{1.0, 0.0};
        }
        return new double[]{-dy / len, dx / len};
    }

    private static double[] projectPolygon(double[][] pts, double ax, double ay) {
        double min = Double.POSITIVE_INFINITY;
        double max = Double.NEGATIVE_INFINITY;
        for (double[] p : pts) {
            double proj = p[0] * ax + p[1] * ay;
            if (proj < min) min = proj;
            if (proj > max) max = proj;
        }
        return new double[]{min, max};
    }

    private static boolean isPointInOrOnPolygon(double px, double py, double[][] poly) {
        int n = poly.length;
        boolean inside = false;
        for (int i = 0, j = n - 1; i < n; j = i++) {
            double xi = poly[i][0], yi = poly[i][1];
            double xj = poly[j][0], yj = poly[j][1];
            if (pointOnSegment(px, py, xj, yj, xi, yi)) {
                return true;
            }
            boolean intersect = ((yi > py) != (yj > py))
                    && (px < ((xj - xi) * (py - yi)) / ((yj - yi) + 1e-12) + xi);
            if (intersect) {
                inside = !inside;
            }
        }
        return inside;
    }

    private static boolean pointOnSegment(double px, double py, double ax, double ay, double bx, double by) {
        double cross = Math.abs((px - ax) * (by - ay) - (py - ay) * (bx - ax));
        if (cross > 1e-3) {
            return false;
        }
        double dot = (px - ax) * (bx - ax) + (py - ay) * (by - ay);
        if (dot < -1e-6) {
            return false;
        }
        double sqLen = (bx - ax) * (bx - ax) + (by - ay) * (by - ay);
        return dot <= sqLen + 1e-6;
    }

    private static boolean segmentsStrictlyIntersect(
            double x1, double y1, double x2, double y2,
            double x3, double y3, double x4, double y4) {
        double d1 = cross(x3, y3, x4, y4, x1, y1);
        double d2 = cross(x3, y3, x4, y4, x2, y2);
        double d3 = cross(x1, y1, x2, y2, x3, y3);
        double d4 = cross(x1, y1, x2, y2, x4, y4);
        return ((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS))
                && ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS));
    }

    private static double cross(double ax, double ay, double bx, double by, double cx, double cy) {
        return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    }
}
