import type { HeatmapLayerMetric } from '@/config/thresholds';
import type { Point2D } from '@/types/api';
import { pixelToNormalized } from './coords';
import { computeIdwValue, type IdwSamplePoint } from './idw';

export interface ColorStop {
  val: number;
  r: number;
  g: number;
  b: number;
  a: number;
  label?: string;
}

/**
 * High-contrast, indoor-calibrated continuous meteorological thermal palettes.
 * Calibrated specifically to indoor room micro-climates so temperature differences
 * of even 1-1.5°C produce stark, vivid, unmistakable color shifts (Blue -> Cyan -> Green -> Yellow -> Orange -> Red).
 */
export const WEATHER_PALETTES: Record<HeatmapLayerMetric, ColorStop[]> = {
  temperature: [
    { val: 20.8, r: 30, g: 64, b: 175, a: 0.94, label: '≤ 21°C Lạnh (AC)' },        // Deep Blue
    { val: 21.8, r: 6, g: 182, b: 212, a: 0.92, label: '21.8°C Mát mẻ' },         // Bright Cyan
    { val: 22.8, r: 34, g: 197, b: 94, a: 0.90, label: '22.8°C Chuẩn lý tưởng' }, // Emerald Green (Ideal)
    { val: 23.6, r: 132, g: 204, b: 22, a: 0.92, label: '23.6°C Hơi ấm' },        // Lime
    { val: 24.2, r: 234, g: 179, b: 8, a: 0.94, label: '24.2°C Ấm' },             // Radiant Yellow
    { val: 24.8, r: 249, g: 115, b: 22, a: 0.95, label: '24.8°C Khá nóng' },       // Vibrant Orange
    { val: 25.5, r: 239, g: 68, b: 68, a: 0.96, label: '≥ 25.5°C Nóng (Cửa sổ)' },// Hot Red
  ],
  noiseAvg: [
    { val: 36.0, r: 67, g: 56, b: 202, a: 0.94, label: '≤ 36 dBA Rất yên tĩnh' },  // Deep Indigo
    { val: 42.0, r: 2, g: 132, b: 199, a: 0.92, label: '42 dBA Thì thầm khẽ' },   // Sky Blue
    { val: 48.0, r: 22, g: 163, b: 74, a: 0.90, label: '48 dBA Tiêu chuẩn học' }, // Emerald Green
    { val: 53.0, r: 202, g: 138, b: 4, a: 0.92, label: '53 dBA Xao nhãng nhẹ' },  // Amber Yellow
    { val: 58.0, r: 234, g: 88, b: 12, a: 0.94, label: '58 dBA Thảo luận' },      // Bright Orange
    { val: 64.0, r: 220, g: 38, b: 38, a: 0.96, label: '64 dBA Ồn' },             // Coral Red
    { val: 70.0, r: 153, g: 27, b: 27, a: 0.98, label: '≥ 70 dBA Cần nhắc nhở' },  // Deep Crimson
  ],
  pm2_5: [
    { val: 8.0, r: 2, g: 132, b: 199, a: 0.92, label: '≤ 8 Rất trong lành' },     // Sky Blue
    { val: 14.0, r: 22, g: 163, b: 74, a: 0.90, label: '14 Đạt chuẩn sạch' },     // Emerald Green
    { val: 20.0, r: 202, g: 138, b: 4, a: 0.92, label: '20 Trung bình' },         // Yellow
    { val: 26.0, r: 234, g: 88, b: 12, a: 0.94, label: '26 Hơi bí khí' },         // Orange
    { val: 32.0, r: 220, g: 38, b: 38, a: 0.96, label: '≥ 32 Bụi cao' },          // Red
  ],
  comfortScore: [
    { val: 65.0, r: 220, g: 38, b: 38, a: 0.96, label: '< 65 Kém' },              // Red
    { val: 73.0, r: 234, g: 88, b: 12, a: 0.94, label: '73 Trung bình' },         // Orange
    { val: 80.0, r: 202, g: 138, b: 4, a: 0.92, label: '80 Khá' },                // Yellow
    { val: 87.0, r: 101, g: 163, b: 13, a: 0.90, label: '87 Tốt' },               // Lime
    { val: 93.0, r: 22, g: 163, b: 74, a: 0.92, label: '93 Rất tốt' },            // Emerald Green
    { val: 98.0, r: 13, g: 148, b: 136, a: 0.95, label: '≥ 98 Tối ưu' },          // Teal
  ],
};

/**
 * Linearly interpolates continuous RGBA components for any arbitrary floating value.
 */
export function getContinuousMetricColor(
  layer: HeatmapLayerMetric,
  value: number | null | undefined
): [number, number, number, number] {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return [100, 116, 139, 0.40]; // Slate neutral #64748B
  }

  const stops = WEATHER_PALETTES[layer] || WEATHER_PALETTES.temperature;
  if (value <= stops[0].val) {
    const s = stops[0];
    return [s.r, s.g, s.b, s.a];
  }
  if (value >= stops[stops.length - 1].val) {
    const s = stops[stops.length - 1];
    return [s.r, s.g, s.b, s.a];
  }

  for (let i = 0; i < stops.length - 1; i++) {
    const s1 = stops[i];
    const s2 = stops[i + 1];
    if (value >= s1.val && value <= s2.val) {
      const t = (value - s1.val) / (s2.val - s1.val);
      const r = Math.round(s1.r + (s2.r - s1.r) * t);
      const g = Math.round(s1.g + (s2.g - s1.g) * t);
      const b = Math.round(s1.b + (s2.b - s1.b) * t);
      const a = s1.a + (s2.a - s1.a) * t;
      return [r, g, b, a];
    }
  }

  return [100, 116, 139, 0.40];
}

export function getContinuousMetricColorCss(
  layer: HeatmapLayerMetric,
  value: number | null | undefined
): string {
  const [r, g, b, a] = getContinuousMetricColor(layer, value);
  return `rgba(${r}, ${g}, ${b}, ${a.toFixed(2)})`;
}

/**
 * Creates CSS linear-gradient string for building continuous weather radar legends.
 */
export function getPaletteCssGradient(layer: HeatmapLayerMetric): string {
  const stops = WEATHER_PALETTES[layer] || WEATHER_PALETTES.temperature;
  const gradientStops = stops
    .map((s, idx) => {
      const pct = Math.round((idx / (stops.length - 1)) * 100);
      return `rgb(${s.r}, ${s.g}, ${s.b}) ${pct}%`;
    })
    .join(', ');
  return `linear-gradient(to right, ${gradientStops})`;
}

/**
 * Renders atmospheric thermal / sound Gaussian RBF diffusion field with natural decay.
 * Micro-climates blend organically between sensor nodes like fluid convection,
 * while unmonitored zones smoothly and asymptotically attenuate to 0.
 */
let sharedOffscreenCanvas: HTMLCanvasElement | null = null;

function getSharedOffscreenCanvas(
  width: number,
  height: number
): HTMLCanvasElement {
  if (!sharedOffscreenCanvas) {
    sharedOffscreenCanvas = document.createElement('canvas');
  }
  if (sharedOffscreenCanvas.width !== width) {
    sharedOffscreenCanvas.width = width;
  }
  if (sharedOffscreenCanvas.height !== height) {
    sharedOffscreenCanvas.height = height;
  }
  return sharedOffscreenCanvas;
}

export function renderWeatherDiffusionHeatmap(
  ctx: CanvasRenderingContext2D,
  pixelVertices: readonly Point2D[],
  idwSamples: readonly IdwSamplePoint[],
  layer: HeatmapLayerMetric,
  canvasWidth: number,
  canvasHeight: number,
  fallbackValue: number | null,
  coverageRadius = 0.26 // Natural dispersion envelope
): void {
  // 1. Calculate polygon bounding box
  let minX = canvasWidth;
  let maxX = 0;
  let minY = canvasHeight;
  let maxY = 0;
  for (const pv of pixelVertices) {
    if (pv.x < minX) minX = pv.x;
    if (pv.x > maxX) maxX = pv.x;
    if (pv.y < minY) minY = pv.y;
    if (pv.y > maxY) maxY = pv.y;
  }

  const roomW = Math.max(10, Math.ceil(maxX - minX));
  const roomH = Math.max(10, Math.ceil(maxY - minY));

  // 2. Setup Polygon Clipping (Strict barrier prevents leaking outside room walls)
  ctx.save();
  ctx.beginPath();
  pixelVertices.forEach((p, idx) => {
    if (idx === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.closePath();
  ctx.clip();

  // Solid dark background within room for architectural floor
  ctx.fillStyle = '#0B1120';
  ctx.fillRect(minX, minY, roomW, roomH);

  // Subtle architectural desk tile grid inside room
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
  ctx.lineWidth = 1;
  const tileStep = 24;
  for (let tx = minX; tx <= maxX; tx += tileStep) {
    ctx.beginPath();
    ctx.moveTo(tx, minY);
    ctx.lineTo(tx, maxY);
    ctx.stroke();
  }
  for (let ty = minY; ty <= maxY; ty += tileStep) {
    ctx.beginPath();
    ctx.moveTo(minX, ty);
    ctx.lineTo(maxX, ty);
    ctx.stroke();
  }

  // Case A: No online devices and no telemetry -> neutral dark slate
  if (idwSamples.length === 0 && fallbackValue === null) {
    ctx.fillStyle = '#64748B';
    ctx.globalAlpha = 0.25;
    ctx.fillRect(minX, minY, roomW, roomH);
    ctx.restore();
    return;
  }

  // Case B: No desk sensors, but room-level telemetry exists
  if (idwSamples.length === 0 && fallbackValue !== null) {
    const [r, g, b, a] = getContinuousMetricColor(layer, fallbackValue);
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a * 0.45})`;
    ctx.fillRect(minX, minY, roomW, roomH);
    ctx.restore();
    return;
  }

  // Case C: 1 or more desk sensors -> Multi-source continuous Gaussian RBF diffusion field
  const gridW = Math.max(45, Math.min(130, Math.round(roomW / 3.0)));
  const gridH = Math.max(35, Math.min(95, Math.round(roomH / 3.0)));

  const offscreen = getSharedOffscreenCanvas(gridW, gridH);
  const offCtx = offscreen.getContext('2d');
  if (!offCtx) {
    ctx.restore();
    return;
  }

  const imgData = offCtx.createImageData(gridW, gridH);
  const data = imgData.data;

  const stepX = roomW / (gridW - 1);
  const stepY = roomH / (gridH - 1);
  const aspectFactor = canvasHeight / canvasWidth;

  // Gaussian spread parameter: sigma corresponds to physical desk thermal dispersion
  const sigma = Math.max(0.08, coverageRadius * 0.60);
  const twoSigmaSq = 2 * sigma * sigma;

  let ptr = 0;
  for (let gy = 0; gy < gridH; gy++) {
    const curPy = minY + gy * stepY;
    const curNy = curPy / canvasHeight;

    for (let gx = 0; gx < gridW; gx++) {
      const curPx = minX + gx * stepX;
      const curNx = curPx / canvasWidth;

      let sumWeight = 0;
      let sumVal = 0;

      for (let i = 0; i < idwSamples.length; i++) {
        const s = idwSamples[i];
        const dx = curNx - s.x;
        const dy = (curNy - s.y) * aspectFactor;
        const distSq = dx * dx + dy * dy;
        const w = Math.exp(-distSq / twoSigmaSq);
        sumWeight += w;
        sumVal += w * s.value;
      }

      // Infinitely smooth Gaussian field presence (naturally decays to 0 in unmonitored zones)
      const fieldPresence = 1 - Math.exp(-2.2 * sumWeight);

      if (fieldPresence > 0.01 && sumWeight > 0.0001) {
        const val = sumVal / sumWeight;
        const [r, g, b, a] = getContinuousMetricColor(layer, val);

        data[ptr] = r;
        data[ptr + 1] = g;
        data[ptr + 2] = b;
        data[ptr + 3] = Math.round(a * fieldPresence * 255);
      } else {
        data[ptr] = 0;
        data[ptr + 1] = 0;
        data[ptr + 2] = 0;
        data[ptr + 3] = 0; // Pure transparent! Leaves dark blueprint floor
      }
      ptr += 4;
    }
  }

  offCtx.putImageData(imgData, 0, 0);

  // 3. Render smoothly into main canvas with bilinear scaling + wide 16px fluid diffusion
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const hasFilter = typeof ctx.filter === 'string';
  if (hasFilter) {
    ctx.filter = 'blur(16px)';
  }

  const pad = 16;
  ctx.drawImage(offscreen, minX - pad, minY - pad, roomW + pad * 2, roomH + pad * 2);

  if (hasFilter) {
    ctx.filter = 'none';
  }

  ctx.restore();
}
