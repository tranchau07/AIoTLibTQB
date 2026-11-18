import { FLOORPLAN_INTERACTION_CONFIG } from '@/config/floorplan-hmi.config';
import type { Point2D } from '@/types/api';

export interface PopoverPlacementOptions {
  margin?: number;
  gap?: number;
  preferredPlacement?: 'top' | 'bottom';
}

export interface PopoverPlacementResult {
  placement: 'top' | 'bottom';
  align: 'start' | 'center' | 'end';
  left: number;
  top: number;
}

/**
 * Tính toán vị trí Tooltip / Popover không che khuất node đang xem và tự động lật hướng
 * khi điểm neo nằm sát 4 mép bản đồ (Bắc, Nam, Đông, Tây).
 */
export function computePopoverPlacement(
  anchorPx: Point2D,
  popoverSize: { width: number; height: number },
  viewportSize: { width: number; height: number },
  options: PopoverPlacementOptions = {}
): PopoverPlacementResult {
  const margin =
    options.margin ?? FLOORPLAN_INTERACTION_CONFIG.viewportMarginPx;
  const gap = options.gap ?? 16;
  const preferred = options.preferredPlacement ?? 'top';

  const maxLeft = Math.max(margin, viewportSize.width - margin - popoverSize.width);
  const maxTop = Math.max(margin, viewportSize.height - margin - popoverSize.height);

  // 1. Quyết định hướng dọc (Bắc <-> Nam)
  const topCandidate = anchorPx.y - popoverSize.height - gap;
  const bottomCandidate = anchorPx.y + gap;

  let placement: 'top' | 'bottom' = preferred;
  let rawTop: number;

  if (preferred === 'top') {
    if (
      topCandidate < margin &&
      bottomCandidate + popoverSize.height <= viewportSize.height - margin
    ) {
      placement = 'bottom';
      rawTop = bottomCandidate;
    } else if (
      topCandidate < margin &&
      viewportSize.height - margin - bottomCandidate > anchorPx.y - margin
    ) {
      placement = 'bottom';
      rawTop = bottomCandidate;
    } else {
      placement = 'top';
      rawTop = topCandidate;
    }
  } else {
    if (
      bottomCandidate + popoverSize.height > viewportSize.height - margin &&
      topCandidate >= margin
    ) {
      placement = 'top';
      rawTop = topCandidate;
    } else if (
      bottomCandidate + popoverSize.height > viewportSize.height - margin &&
      anchorPx.y - margin > viewportSize.height - margin - anchorPx.y
    ) {
      placement = 'top';
      rawTop = topCandidate;
    } else {
      placement = 'bottom';
      rawTop = bottomCandidate;
    }
  }

  // 2. Quyết định căn ngang (Tây -> start | Đông -> end | Trung tâm -> center)
  let align: 'start' | 'center' | 'end' = 'center';
  let rawLeft = anchorPx.x - popoverSize.width * 0.5;

  if (anchorPx.x - popoverSize.width * 0.5 < margin) {
    align = 'start';
    rawLeft = anchorPx.x;
  } else if (
    anchorPx.x + popoverSize.width * 0.5 >
    viewportSize.width - margin
  ) {
    align = 'end';
    rawLeft = anchorPx.x - popoverSize.width;
  }

  return {
    placement,
    align,
    left: Math.round(Math.max(margin, Math.min(maxLeft, rawLeft))),
    top: Math.round(Math.max(margin, Math.min(maxTop, rawTop))),
  };
}
