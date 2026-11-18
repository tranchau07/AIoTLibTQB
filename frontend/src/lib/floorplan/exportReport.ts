import {
  classifyManagerRoomStatus,
  isAlertOpen,
  isAlertOverdue,
  TIMING_CONFIG,
} from '@/config/floorplan-hmi.config';
import type { HeatmapLayerMetric } from '@/config/thresholds';
import { ALERT_SEVERITY_LABEL_VI, summarizeAlertForManagerVi } from '@/lib/floorplan/alertWorkflow';
import {
  METRIC_LAYER_META,
  WEATHER_PALETTES,
} from '@/lib/floorplan/weatherPalette';
import { FLOORPLAN_I18N_VI } from '@/messages/vi';
import type {
  AlertResponse,
  RoomResponse,
  TelemetryResponse,
} from '@/types/api';

export interface FloorplanExportReportParams {
  readonly floor: number;
  readonly layer: HeatmapLayerMetric;
  readonly staticCanvas?: HTMLCanvasElement | null;
  readonly dynamicCanvas?: HTMLCanvasElement | null;
  readonly rooms: readonly RoomResponse[];
  readonly roomTelemetryMap: Record<string, TelemetryResponse | null | undefined>;
  readonly openAlerts: readonly AlertResponse[];
  readonly exportedAt?: Date | string;
  readonly exportedBy?: string;
  readonly timeModeLabel?: string;
  readonly createCanvas?: (width: number, height: number) => HTMLCanvasElement;
  readonly triggerDownload?: (dataUrl: string, filename: string) => void;
  readonly openPrintWindow?: (html: string) => boolean;
}

export interface PngReportResult {
  readonly filename: string;
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
  readonly title: string;
  readonly timestampStr: string;
}

export interface PdfReportResult {
  readonly filename: string;
  readonly html: string;
  readonly title: string;
  readonly timestampStr: string;
  readonly printed: boolean;
}

function formatReportTimestamp(exportedAt?: Date | string): {
  dateObj: Date;
  timestampStr: string;
  dateStamp: string;
} {
  const dateObj =
    exportedAt instanceof Date
      ? exportedAt
      : exportedAt
        ? new Date(exportedAt)
        : new Date();
  const safeDate = Number.isNaN(dateObj.getTime()) ? new Date() : dateObj;
  const timestampStr = new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(safeDate);
  const y = safeDate.getFullYear();
  const m = String(safeDate.getMonth() + 1).padStart(2, '0');
  const d = String(safeDate.getDate()).padStart(2, '0');
  return { dateObj: safeDate, timestampStr, dateStamp: `${y}${m}${d}` };
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function summarizeRoomHealthCounts(
  rooms: readonly RoomResponse[],
  roomTelemetryMap: Record<string, TelemetryResponse | null | undefined>,
  openAlerts: readonly AlertResponse[]
) {
  const counts = { GOOD: 0, ATTENTION: 0, POOR: 0, NO_DATA: 0 };
  const alertsByRoom = new Map<string, AlertResponse[]>();
  for (const a of openAlerts) {
    if (!a.roomId) continue;
    const arr = alertsByRoom.get(a.roomId) ?? [];
    arr.push(a);
    alertsByRoom.set(a.roomId, arr);
  }
  for (const room of rooms) {
    const status = classifyManagerRoomStatus(
      roomTelemetryMap[room.id],
      alertsByRoom.get(room.id) ?? []
    );
    counts[status] += 1;
  }
  return counts;
}

function buildCompositeMapSnapshotDataUrl(
  staticCanvas?: HTMLCanvasElement | null,
  dynamicCanvas?: HTMLCanvasElement | null,
  createCanvas?: (w: number, h: number) => HTMLCanvasElement
): string | null {
  try {
    const base = staticCanvas ?? dynamicCanvas;
    if (!base || base.width <= 0 || base.height <= 0) return null;
    const canvas = createCanvas
      ? createCanvas(base.width, base.height)
      : document.createElement('canvas');
    canvas.width = base.width;
    canvas.height = base.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    if (staticCanvas && staticCanvas.width > 0 && staticCanvas.height > 0) {
      ctx.drawImage(staticCanvas, 0, 0, canvas.width, canvas.height);
    }
    if (dynamicCanvas && dynamicCanvas.width > 0 && dynamicCanvas.height > 0) {
      ctx.drawImage(dynamicCanvas, 0, 0, canvas.width, canvas.height);
    }
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

export function exportFloorplanReportPng(
  params: FloorplanExportReportParams
): PngReportResult {
  const width = 1920;
  const height = 1080;
  const { timestampStr, dateStamp } = formatReportTimestamp(params.exportedAt);
  const filename = `aiot-tqb-tang-${params.floor}-${dateStamp}.png`;
  const title = `${FLOORPLAN_I18N_VI.report.pngTitlePrefix} — TẦNG ${params.floor}`;
  const meta = METRIC_LAYER_META[params.layer];
  const stops = WEATHER_PALETTES[params.layer] ?? WEATHER_PALETTES.comfortScore;
  const activeAlerts = params.openAlerts.filter(isAlertOpen);
  const nowMs = Date.now();
  const overdueCount = activeAlerts.filter((a) =>
    isAlertOverdue(a, nowMs, TIMING_CONFIG.overdueAlertMs)
  ).length;
  const roomCounts = summarizeRoomHealthCounts(
    params.rooms,
    params.roomTelemetryMap,
    activeAlerts
  );
  const roomById = new Map(params.rooms.map((r) => [r.id, r]));

  const canvas = params.createCanvas
    ? params.createCanvas(width, height)
    : document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (ctx) {
    // 1. Report Canvas Backdrop
    ctx.fillStyle = '#0B1120';
    ctx.fillRect(0, 0, width, height);

    // Header Band
    ctx.fillStyle = '#0F172A';
    ctx.fillRect(0, 0, width, 92);
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 92);
    ctx.lineTo(width, 92);
    ctx.stroke();

    ctx.fillStyle = '#F8FAFC';
    ctx.font = 'bold 26px Inter, system-ui, sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(title, 28, 18);

    const subText = `Chỉ số: ${meta.label} (${meta.unitLabel}) · Chế độ: ${
      params.timeModeLabel ?? FLOORPLAN_I18N_VI.timeAnalysis.modes.live
    } · Mốc thời gian: ${timestampStr} · Người xuất: ${params.exportedBy ?? 'Quản lý thư viện'}`;
    ctx.fillStyle = '#94A3B8';
    ctx.font = '500 15px Inter, system-ui, sans-serif';
    ctx.fillText(subText, 28, 56);

    // 2. Map Compositing Box (keeps 76.0 : 57.2 aspect cleanly)
    const mapBoxX = 28;
    const mapBoxY = 112;
    const mapBoxMaxW = 1340;
    const mapBoxMaxH = 820;
    const targetAspect = 57.2 / 76.0;
    let drawW = mapBoxMaxW;
    let drawH = Math.round(drawW * targetAspect);
    if (drawH > mapBoxMaxH) {
      drawH = mapBoxMaxH;
      drawW = Math.round(drawH / targetAspect);
    }

    ctx.fillStyle = '#090E1A';
    ctx.fillRect(mapBoxX, mapBoxY, drawW, drawH);
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(mapBoxX, mapBoxY, drawW, drawH);

    if (
      params.staticCanvas &&
      params.staticCanvas.width > 0 &&
      params.staticCanvas.height > 0
    ) {
      ctx.drawImage(params.staticCanvas, mapBoxX, mapBoxY, drawW, drawH);
    }
    if (
      params.dynamicCanvas &&
      params.dynamicCanvas.width > 0 &&
      params.dynamicCanvas.height > 0
    ) {
      ctx.drawImage(params.dynamicCanvas, mapBoxX, mapBoxY, drawW, drawH);
    }

    // 3. Right Summary Panel (Alerts + Health)
    const sideX = mapBoxX + drawW + 24;
    const sideW = width - sideX - 28;
    ctx.fillStyle = '#111827';
    ctx.fillRect(sideX, mapBoxY, sideW, drawH);
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
    ctx.strokeRect(sideX, mapBoxY, sideW, drawH);

    ctx.fillStyle = '#F8FAFC';
    ctx.font = 'bold 18px Inter, system-ui, sans-serif';
    ctx.fillText(FLOORPLAN_I18N_VI.report.summaryHeading, sideX + 20, mapBoxY + 20);

    ctx.font = '600 15px Inter, system-ui, sans-serif';
    ctx.fillStyle = activeAlerts.length > 0 ? '#FCA5A5' : '#6EE7B7';
    ctx.fillText(
      `Tổng cảnh báo mở: ${activeAlerts.length} (Tồn đọng: ${overdueCount})`,
      sideX + 20,
      mapBoxY + 54
    );

    ctx.fillStyle = '#CBD5E1';
    ctx.font = '500 14px Inter, system-ui, sans-serif';
    ctx.fillText(
      `Sức khỏe tầng: ● ${roomCounts.GOOD} Tốt · ▲ ${roomCounts.ATTENTION} Lưu ý · ◆ ${roomCounts.POOR} Xấu`,
      sideX + 20,
      mapBoxY + 82
    );

    let alertY = mapBoxY + 124;
    if (activeAlerts.length === 0) {
      ctx.fillStyle = '#94A3B8';
      ctx.fillText(FLOORPLAN_I18N_VI.report.openAlertsEmpty, sideX + 20, alertY);
    } else {
      for (const alert of activeAlerts.slice(0, 8)) {
        const room = alert.roomId ? roomById.get(alert.roomId) : undefined;
        const summary = summarizeAlertForManagerVi(alert, room);
        const sevLabel = ALERT_SEVERITY_LABEL_VI[alert.severity ?? 'MEDIUM'];
        ctx.fillStyle = '#1E293B';
        ctx.fillRect(sideX + 18, alertY, sideW - 36, 74);

        ctx.fillStyle =
          alert.severity === 'CRITICAL' || alert.severity === 'HIGH'
            ? '#F87171'
            : '#FBBF24';
        ctx.font = 'bold 13px Inter, system-ui, sans-serif';
        ctx.fillText(
          `[${sevLabel}] ${room?.code ?? alert.roomId ?? 'Khu vực'}${
            alert.assignedTo ? ` · Phụ trách: ${alert.assignedTo}` : ''
          }`,
          sideX + 28,
          alertY + 12
        );

        ctx.fillStyle = '#E2E8F0';
        ctx.font = '400 13px Inter, system-ui, sans-serif';
        ctx.fillText(summary.headlineVi.slice(0, 68), sideX + 28, alertY + 36);
        alertY += 84;
      }
    }

    // 4. Bottom Legend & Thresholds Strip
    const legY = mapBoxY + drawH + 22;
    const legH = height - legY - 22;
    ctx.fillStyle = '#0F172A';
    ctx.fillRect(28, legY, width - 56, legH);
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
    ctx.strokeRect(28, legY, width - 56, legH);

    ctx.fillStyle = '#F8FAFC';
    ctx.font = 'bold 14px Inter, system-ui, sans-serif';
    ctx.fillText(
      `Chú giải thang màu: ${meta.label} (${meta.unitLabel})  |  ● Đạt chuẩn: ${meta.normalRangeVi}  ·  ▲ Lưu ý: ${meta.attentionThresholdVi}  ·  ◆ Vượt ngưỡng: ${meta.criticalThresholdVi}`,
      48,
      legY + 16
    );

    const barX = 48;
    const barY = legY + 46;
    const barW = width - 96;
    const barH = 18;
    if (typeof ctx.createLinearGradient === 'function') {
      const grad = ctx.createLinearGradient(barX, barY, barX + barW, barY);
      stops.forEach((s, idx) => {
        grad.addColorStop(
          stops.length > 1 ? idx / (stops.length - 1) : 0,
          `rgb(${s.r}, ${s.g}, ${s.b})`
        );
      });
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = '#0284C7';
    }
    ctx.fillRect(barX, barY, barW, barH);

    ctx.fillStyle = '#CBD5E1';
    ctx.font = '500 12px JetBrains Mono, monospace';
    const stopStep = stops.length > 1 ? barW / (stops.length - 1) : barW;
    stops.forEach((s, idx) => {
      ctx.fillText(s.label ?? String(s.val), barX + idx * stopStep * 0.88, legY + 72);
    });
  }

  const dataUrl = canvas.toDataURL('image/png');
  if (params.triggerDownload) {
    params.triggerDownload(dataUrl, filename);
  } else if (typeof document !== 'undefined') {
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  return {
    filename,
    dataUrl,
    width,
    height,
    title,
    timestampStr,
  };
}

export function exportFloorplanReportPdf(
  params: FloorplanExportReportParams
): PdfReportResult {
  const { timestampStr, dateStamp } = formatReportTimestamp(params.exportedAt);
  const filename = `aiot-tqb-bao-cao-tang-${params.floor}-${dateStamp}.pdf`;
  const title = `${FLOORPLAN_I18N_VI.report.pdfTitlePrefix} — TẦNG ${params.floor}`;
  const meta = METRIC_LAYER_META[params.layer];
  const stops = WEATHER_PALETTES[params.layer] ?? WEATHER_PALETTES.comfortScore;
  const activeAlerts = params.openAlerts.filter(isAlertOpen);
  const nowMs = Date.now();
  const roomCounts = summarizeRoomHealthCounts(
    params.rooms,
    params.roomTelemetryMap,
    activeAlerts
  );
  const roomById = new Map(params.rooms.map((r) => [r.id, r]));

  const snapshotUrl = buildCompositeMapSnapshotDataUrl(
    params.staticCanvas,
    params.dynamicCanvas,
    params.createCanvas
  );

  const gradientCss = `linear-gradient(to right, ${stops
    .map((s, idx) => `rgb(${s.r}, ${s.g}, ${s.b}) ${Math.round((idx / Math.max(1, stops.length - 1)) * 100)}%`)
    .join(', ')})`;

  const alertsRows =
    activeAlerts.length === 0
      ? `<tr><td colspan="5">${escapeHtml(FLOORPLAN_I18N_VI.report.openAlertsEmpty)}</td></tr>`
      : activeAlerts
          .map((alert) => {
            const room = alert.roomId ? roomById.get(alert.roomId) : undefined;
            const summary = summarizeAlertForManagerVi(alert, room);
            const sevLabel = ALERT_SEVERITY_LABEL_VI[alert.severity ?? 'MEDIUM'];
            const wf = alert.workflowStatus ?? alert.status;
            const overdue = isAlertOverdue(alert, nowMs, TIMING_CONFIG.overdueAlertMs)
              ? ' (Tồn đọng)'
              : '';
            return `<tr>
              <td>${escapeHtml(room ? `${room.code} — ${room.name}` : alert.roomId ?? '—')}</td>
              <td>${escapeHtml(sevLabel)}${escapeHtml(overdue)}</td>
              <td>${escapeHtml(wf)}</td>
              <td>${escapeHtml(summary.headlineVi)}</td>
              <td>${escapeHtml(alert.assignedTo ?? 'Chưa phân công')}</td>
            </tr>`;
          })
          .join('\n');

  const html = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    @page { size: A4 landscape; margin: 12mm; }
    body { font-family: Inter, system-ui, sans-serif; color: #0f172a; margin: 0; font-size: 11px; }
    .header { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 2px solid #0284c7; padding-bottom: 8px; margin-bottom: 10px; }
    .header h1 { margin: 0; font-size: 16px; }
    .meta { color: #475569; font-size: 11px; }
    .grid { display: grid; grid-template-columns: 1.45fr 1fr; gap: 14px; align-items: start; }
    .map-frame { border: 1px solid #cbd5e1; border-radius: 6px; padding: 6px; background: #0b1120; }
    .map-frame img { width: 100%; height: auto; display: block; border-radius: 4px; }
    .legend { margin-top: 8px; border: 1px solid #cbd5e1; border-radius: 6px; padding: 8px; background: #f8fafc; }
    .legend-bar { height: 10px; border-radius: 999px; background: ${gradientCss}; margin: 4px 0; }
    .stops { display: flex; justify-content: space-between; font-size: 10px; color: #334155; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th, td { border: 1px solid #cbd5e1; padding: 5px 6px; text-align: left; font-size: 10px; vertical-align: top; }
    th { background: #e2e8f0; font-weight: 600; }
    .kpis { display: flex; gap: 10px; margin-bottom: 8px; }
    .kpi { border: 1px solid #cbd5e1; border-radius: 6px; padding: 6px 10px; background: #f8fafc; font-weight: 600; }
  </style>
</head>
<body>
  <header class="header">
    <div>
      <h1>${escapeHtml(title)}</h1>
      <div class="meta">Chỉ số: ${escapeHtml(meta.label)} (${escapeHtml(meta.unitLabel)}) · Chế độ: ${escapeHtml(
        params.timeModeLabel ?? FLOORPLAN_I18N_VI.timeAnalysis.modes.live
      )}</div>
    </div>
    <div class="meta">Mốc thời gian: ${escapeHtml(timestampStr)} · Người xuất: ${escapeHtml(
      params.exportedBy ?? 'Quản lý thư viện'
    )}</div>
  </header>
  <div class="kpis">
    <div class="kpi">Cảnh báo mở: ${activeAlerts.length}</div>
    <div class="kpi">Tốt (●): ${roomCounts.GOOD}</div>
    <div class="kpi">Lưu ý (▲): ${roomCounts.ATTENTION}</div>
    <div class="kpi">Xấu (◆): ${roomCounts.POOR}</div>
  </div>
  <div class="grid">
    <div>
      <div class="map-frame">
        ${
          snapshotUrl
            ? `<img src="${snapshotUrl}" alt="Bản đồ nhiệt Tầng ${params.floor}" />`
            : `<div style="color:#cbd5e1;padding:24px;text-align:center;">Bản đồ Tầng ${params.floor} — ${escapeHtml(meta.label)}</div>`
        }
      </div>
      <div class="legend">
        <div><strong>Thang màu ${escapeHtml(meta.label)} (${escapeHtml(meta.unitLabel)})</strong> — ● ${escapeHtml(meta.normalRangeVi)} | ▲ ${escapeHtml(meta.attentionThresholdVi)} | ◆ ${escapeHtml(meta.criticalThresholdVi)}</div>
        <div class="legend-bar"></div>
        <div class="stops">${stops.map((s) => `<span>${escapeHtml(s.label ?? String(s.val))}</span>`).join('')}</div>
      </div>
    </div>
    <div>
      <h2 style="margin:0 0 6px;font-size:13px;">${escapeHtml(FLOORPLAN_I18N_VI.report.summaryHeading)}</h2>
      <table>
        <thead>
          <tr>
            <th>Phòng</th>
            <th>Mức độ</th>
            <th>Trạng thái</th>
            <th>Tóm tắt sự cố</th>
            <th>Phụ trách</th>
          </tr>
        </thead>
        <tbody>
          ${alertsRows}
        </tbody>
      </table>
    </div>
  </div>
</body>
</html>`;

  let printed = false;
  if (params.openPrintWindow) {
    printed = params.openPrintWindow(html);
  } else if (typeof window !== 'undefined' && typeof window.open === 'function') {
    const win = window.open('', '_blank', 'width=1280,height=840');
    if (win && win.document) {
      win.document.open();
      win.document.write(html);
      win.document.close();
      win.focus?.();
      win.print?.();
      printed = true;
    }
  }

  return {
    filename,
    html,
    title,
    timestampStr,
    printed,
  };
}
