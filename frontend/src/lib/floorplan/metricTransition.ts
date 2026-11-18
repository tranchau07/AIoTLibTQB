import { TIMING_CONFIG } from '@/config/floorplan-hmi.config';

export interface AnimatedMetricState {
  current: number;
  from: number;
  target: number;
  startTime: number;
  duration: number;
}

/**
 * Kiểm tra người dùng có bật chế độ giảm chuyển động (`prefers-reduced-motion: reduce`) hay không.
 */
export function isReducedMotionPreferred(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  try {
    return Boolean(window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch {
    return false;
  }
}

/**
 * Khởi tạo trạng thái chuyển màu mới cho một trạm/chỉ số.
 */
export function createAnimatedMetricState(
  initialValue: number,
  nowMs: number,
  prefersReducedMotion: boolean = isReducedMotionPreferred(),
  transitionDurationMs: number = TIMING_CONFIG.transitionDurationMs
): AnimatedMetricState {
  return {
    current: initialValue,
    from: initialValue,
    target: initialValue,
    startTime: nowMs,
    duration: prefersReducedMotion ? 0 : transitionDurationMs,
  };
}

/**
 * Cập nhật mục tiêu mới khi telemetry đổi; tôn trọng `prefers-reduced-motion` (`duration = 0`).
 */
export function updateAnimatedMetricState(
  existing: AnimatedMetricState | undefined,
  nextTarget: number,
  nowMs: number,
  prefersReducedMotion: boolean = isReducedMotionPreferred(),
  transitionDurationMs: number = TIMING_CONFIG.transitionDurationMs,
  resetImmediately = false
): AnimatedMetricState {
  if (!existing || resetImmediately || prefersReducedMotion || transitionDurationMs <= 0) {
    return {
      current: nextTarget,
      from: nextTarget,
      target: nextTarget,
      startTime: nowMs,
      duration: prefersReducedMotion ? 0 : transitionDurationMs,
    };
  }

  if (Math.abs(existing.target - nextTarget) <= 0.005) {
    return existing;
  }

  const currentVal = evaluateAnimatedMetricState(existing, nowMs).value;
  return {
    current: currentVal,
    from: currentVal,
    target: nextTarget,
    startTime: nowMs,
    duration: transitionDurationMs,
  };
}

/**
 * Tính giá trị nội suy Hermite Smoothstep $S(p) = 3p^2 - 2p^3$ tại thời điểm `nowMs`.
 * Nếu `duration <= 0` hoặc `elapsed >= duration`, trả về giá trị đích ngay và `transitioning = false`.
 */
export function evaluateAnimatedMetricState(
  state: AnimatedMetricState,
  nowMs: number
): { value: number; transitioning: boolean } {
  if (state.duration <= 0 || Math.abs(state.target - state.from) <= 1e-6) {
    state.current = state.target;
    return { value: state.target, transitioning: false };
  }

  const elapsed = nowMs - state.startTime;
  if (elapsed >= state.duration) {
    state.current = state.target;
    return { value: state.target, transitioning: false };
  }

  if (elapsed <= 0) {
    state.current = state.from;
    return { value: state.from, transitioning: true };
  }

  const p = Math.max(0, Math.min(1, elapsed / state.duration));
  const smoothstep = p * p * (3 - 2 * p);
  const interpolated = state.from + (state.target - state.from) * smoothstep;
  state.current = interpolated;
  return { value: interpolated, transitioning: true };
}
