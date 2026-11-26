import type { FurnitureItem } from '@/types/api';

export type FurnitureShape =
  | 'rect'
  | 'rounded_rect'
  | 'circle'
  | 'desk_cluster'
  | 'long_desk'
  | 'single_chair'
  | 'long_bench'
  | 'bookshelf'
  | 'librarian_desk'
  | 'sensor_node'
  | 'door_swing'
  | 'custom_pod';

export interface FurnitureCatalogEntry {
  readonly typeId: string;
  readonly labelVi: string;
  readonly shortLabel: string;
  readonly category: 'SEATING' | 'STORAGE' | 'SERVICE' | 'EQUIPMENT' | 'STRUCTURE';
  readonly defaultWidthM: number;
  readonly defaultDepthM: number;
  readonly minWidthM: number;
  readonly maxWidthM: number;
  readonly minDepthM: number;
  readonly maxDepthM: number;
  readonly blocksWalkway: boolean;
  readonly sensitiveHardware: boolean;
  readonly fillColor: string;
  readonly strokeColor: string;
  readonly shape: FurnitureShape;
}

/**
 * Thư viện chuẩn 5 loại nội thất chính tỷ lệ thực 1:100 cho Thư viện TQB:
 * Bàn dài, Ghế đơn, Ghế dài, Giá sách, Bàn thủ thư.
 */
export const FURNITURE_CATALOG: readonly FurnitureCatalogEntry[] = [
  {
    typeId: 'DESK',
    labelVi: 'Bàn dài',
    shortLabel: 'Bàn dài',
    category: 'SEATING',
    defaultWidthM: 2.4,
    defaultDepthM: 1.0,
    minWidthM: 0.8,
    maxWidthM: 4.0,
    minDepthM: 0.6,
    maxDepthM: 2.0,
    blocksWalkway: true,
    sensitiveHardware: false,
    fillColor: '#1E293B',
    strokeColor: '#94A3B8',
    shape: 'long_desk',
  },
  {
    typeId: 'CHAIR',
    labelVi: 'Ghế đơn',
    shortLabel: 'Ghế đơn',
    category: 'SEATING',
    defaultWidthM: 0.55,
    defaultDepthM: 0.55,
    minWidthM: 0.4,
    maxWidthM: 1.2,
    minDepthM: 0.4,
    maxDepthM: 1.2,
    blocksWalkway: true,
    sensitiveHardware: false,
    fillColor: '#334155',
    strokeColor: '#CBD5E1',
    shape: 'single_chair',
  },
  {
    typeId: 'BENCH',
    labelVi: 'Ghế dài',
    shortLabel: 'Ghế dài',
    category: 'SEATING',
    defaultWidthM: 1.8,
    defaultDepthM: 0.5,
    minWidthM: 1.0,
    maxWidthM: 3.6,
    minDepthM: 0.4,
    maxDepthM: 1.0,
    blocksWalkway: true,
    sensitiveHardware: false,
    fillColor: '#1E3A5F',
    strokeColor: '#7DD3FC',
    shape: 'long_bench',
  },
  {
    typeId: 'BOOKSHELF',
    labelVi: 'Giá sách',
    shortLabel: 'Giá sách',
    category: 'STORAGE',
    defaultWidthM: 2.0,
    defaultDepthM: 0.6,
    minWidthM: 0.8,
    maxWidthM: 6.0,
    minDepthM: 0.35,
    maxDepthM: 1.5,
    blocksWalkway: true,
    sensitiveHardware: false,
    fillColor: '#3F2E21',
    strokeColor: '#F59E0B',
    shape: 'bookshelf',
  },
  {
    typeId: 'COUNTER',
    labelVi: 'Bàn thủ thư',
    shortLabel: 'Bàn thủ thư',
    category: 'SERVICE',
    defaultWidthM: 2.4,
    defaultDepthM: 0.85,
    minWidthM: 1.2,
    maxWidthM: 6.0,
    minDepthM: 0.6,
    maxDepthM: 2.2,
    blocksWalkway: true,
    sensitiveHardware: false,
    fillColor: '#0F3B57',
    strokeColor: '#38BDF8',
    shape: 'librarian_desk',
  },
];

/**
 * Các loại phần tử kế thừa (từ bản ghi cũ trong DB) vẫn được nhận dạng chính xác khi vẽ & kiểm tra va chạm.
 */
const LEGACY_FURNITURE_ENTRIES: readonly FurnitureCatalogEntry[] = [
  {
    typeId: 'PC_TERMINAL',
    labelVi: 'Cụm máy tính Multimedia',
    shortLabel: 'Máy tính',
    category: 'EQUIPMENT',
    defaultWidthM: 1.6,
    defaultDepthM: 0.9,
    minWidthM: 0.8,
    maxWidthM: 4.0,
    minDepthM: 0.6,
    maxDepthM: 2.0,
    blocksWalkway: true,
    sensitiveHardware: false,
    fillColor: '#1E1B4B',
    strokeColor: '#818CF8',
    shape: 'rect',
  },
  {
    typeId: 'IOT_NODE',
    labelVi: 'Trạm cảm biến IoT',
    shortLabel: 'Cảm biến',
    category: 'EQUIPMENT',
    defaultWidthM: 0.5,
    defaultDepthM: 0.5,
    minWidthM: 0.25,
    maxWidthM: 1.5,
    minDepthM: 0.25,
    maxDepthM: 1.5,
    blocksWalkway: false,
    sensitiveHardware: true,
    fillColor: '#064E3B',
    strokeColor: '#34D399',
    shape: 'sensor_node',
  },
  {
    typeId: 'DOOR',
    labelVi: 'Cửa đơn / Cửa đôi',
    shortLabel: 'Cửa',
    category: 'STRUCTURE',
    defaultWidthM: 1.4,
    defaultDepthM: 0.4,
    minWidthM: 0.8,
    maxWidthM: 3.2,
    minDepthM: 0.2,
    maxDepthM: 1.2,
    blocksWalkway: false,
    sensitiveHardware: false,
    fillColor: '#082F49',
    strokeColor: '#38BDF8',
    shape: 'door_swing',
  },
];

export function resolveFurnitureCatalogEntry(
  typeId: string,
  catalog: readonly FurnitureCatalogEntry[] = FURNITURE_CATALOG
): FurnitureCatalogEntry {
  const normalized = String(typeId ?? '').trim().toUpperCase();
  const found = catalog.find(
    (entry) => entry.typeId.trim().toUpperCase() === normalized
  );
  if (found) return found;

  const legacyFound = LEGACY_FURNITURE_ENTRIES.find(
    (entry) => entry.typeId.trim().toUpperCase() === normalized
  );
  if (legacyFound) return legacyFound;

  return {
    typeId: normalized || 'CUSTOM_ITEM',
    labelVi: typeId || 'Nội thất tùy chỉnh',
    shortLabel: (typeId || 'Mục').slice(0, 8),
    category: 'EQUIPMENT',
    defaultWidthM: 1.2,
    defaultDepthM: 0.8,
    minWidthM: 0.3,
    maxWidthM: 6.0,
    minDepthM: 0.3,
    maxDepthM: 4.0,
    blocksWalkway: normalized !== 'DOOR' && normalized !== 'IOT_NODE',
    sensitiveHardware: normalized === 'IOT_NODE',
    fillColor: '#334155',
    strokeColor: '#94A3B8',
    shape: 'rect',
  };
}

export function filterVisibleFurnitureCatalog(
  catalog: readonly FurnitureCatalogEntry[] = FURNITURE_CATALOG,
  hideSensitive = false
): FurnitureCatalogEntry[] {
  if (!hideSensitive) return [...catalog];
  return catalog.filter((entry) => !entry.sensitiveHardware);
}

export function filterVisibleFurnitureItems(
  items: readonly FurnitureItem[],
  catalog: readonly FurnitureCatalogEntry[] = FURNITURE_CATALOG,
  hideSensitive = false
): FurnitureItem[] {
  if (!hideSensitive) return [...items];
  return items.filter((item) => {
    const entry = resolveFurnitureCatalogEntry(item.typeId, catalog);
    return !entry.sensitiveHardware && item.typeId.trim().toUpperCase() !== 'IOT_NODE';
  });
}
