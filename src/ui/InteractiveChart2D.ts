import type {ChartConfig, ChartType, SheetData} from '../types';
import {
  CHART_PALETTE,
  formatDisplayNumber,
  parseNumericValue,
} from '../core/tabular';
import {svgIcon} from './icons';

export interface Chart2DCallbacks {
  onConfigChange: (config: ChartConfig) => void;
  onRowSelect: (rowIndex: number) => void;
}

interface DataPointRow {
  rowIndex: number;
  label: string;
  values: number[];
  xNumeric: number | null;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncateLabel(label: string, maxLen = 14): string {
  return label.length > maxLen ? `${label.slice(0, maxLen - 1)}…` : label;
}

export class InteractiveChart2D {
  private container: HTMLElement;
  private callbacks: Chart2DCallbacks;
  private sheet: SheetData | null = null;
  private visibleRowIndices: number[] = [];
  private config: ChartConfig = {
    type: 'bar',
    xColIndex: 0,
    yColIndices: [1],
    spatialMode: 'bar3d',
  };
  private highlightedRowIndex: number | null = null;

  private chartControlsEl: HTMLElement | null = null;
  private chartCanvasWrapEl: HTMLElement | null = null;
  private legendEl: HTMLElement | null = null;
  private tooltipEl: HTMLElement | null = null;

  constructor(container: HTMLElement, callbacks: Chart2DCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.renderShell();
  }

  private renderShell(): void {
    this.container.innerHTML = `
      <div class="flex flex-col h-full bg-white border border-slate-200 rounded-xl overflow-hidden">
        <!-- Chart Toolbar -->
        <div
          data-role="chart-controls"
          class="flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-b border-slate-200 bg-slate-50/70"
        ></div>

        <!-- SVG Chart Stage -->
        <div class="relative flex-1 min-h-[260px] p-3 flex flex-col">
          <div data-role="chart-canvas-wrap" class="relative flex-1 w-full min-h-[220px]"></div>
          <div
            data-role="chart-tooltip"
            class="pointer-events-none hidden absolute z-20 bg-slate-900 text-white text-xs rounded-lg px-2.5 py-1.5 shadow-lg whitespace-nowrap"
          ></div>
        </div>

        <!-- Chart Legend -->
        <div
          data-role="chart-legend"
          class="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 border-t border-slate-200 bg-slate-50 text-xs text-slate-700"
        ></div>
      </div>
    `;

    this.chartControlsEl = this.container.querySelector(
      '[data-role="chart-controls"]'
    );
    this.chartCanvasWrapEl = this.container.querySelector(
      '[data-role="chart-canvas-wrap"]'
    );
    this.legendEl = this.container.querySelector('[data-role="chart-legend"]');
    this.tooltipEl = this.container.querySelector(
      '[data-role="chart-tooltip"]'
    );
  }

  public setData(params: {
    sheet: SheetData;
    visibleRowIndices: number[];
    config: ChartConfig;
    highlightedRowIndex: number | null;
  }): void {
    this.sheet = params.sheet;
    this.visibleRowIndices = params.visibleRowIndices;
    this.config = params.config;
    this.highlightedRowIndex = params.highlightedRowIndex;

    this.renderControls();
    this.renderChart();
  }

  private renderControls(): void {
    if (!this.chartControlsEl || !this.sheet) return;
    const sheet = this.sheet;

    const chartTypes: {type: ChartType; label: string; icon: 'barChart' | 'lineChart' | 'pieChart' | 'scatterChart'}[] = [
      {type: 'bar', label: 'Bar', icon: 'barChart'},
      {type: 'line', label: 'Line', icon: 'lineChart'},
      {type: 'pie', label: 'Pie', icon: 'pieChart'},
      {type: 'scatter', label: 'Scatter', icon: 'scatterChart'},
    ];

    const typeButtonsHtml = chartTypes
      .map((item) => {
        const active = this.config.type === item.type;
        const cls = active
          ? 'bg-white text-blue-700 shadow-xs font-semibold'
          : 'text-slate-600 hover:text-slate-900';
        return `
          <button
            type="button"
            data-chart-type="${item.type}"
            aria-pressed="${active}"
            class="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${cls}"
          >
            ${svgIcon(item.icon, 'w-3.5 h-3.5')}
            <span>${item.label}</span>
          </button>
        `;
      })
      .join('');

    const xOptionsHtml = sheet.columns
      .map(
        (col, idx) =>
          `<option value="${idx}" ${idx === this.config.xColIndex ? 'selected' : ''}>${escapeHtml(col)}</option>`
      )
      .join('');

    const numericCols = sheet.columns
      .map((name, idx) => ({name, idx, type: sheet.types[idx]}))
      .filter((c) => c.type === 'number' || c.type === 'percent');

    const yColButtonsSource =
      numericCols.length > 0
        ? numericCols
        : sheet.columns.map((name, idx) => ({
            name,
            idx,
            type: sheet.types[idx],
          }));

    const yTogglesHtml = yColButtonsSource
      .map((col, colorPos) => {
        const selectedIdx = this.config.yColIndices.indexOf(col.idx);
        const active = selectedIdx >= 0;
        const color =
          CHART_PALETTE[
            (active ? selectedIdx : colorPos) % CHART_PALETTE.length
          ];
        const cls = active
          ? 'bg-blue-50 text-blue-800 border-blue-200 font-medium'
          : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300';
        return `
          <button
            type="button"
            data-y-col="${col.idx}"
            aria-pressed="${active}"
            class="inline-flex items-center gap-1.5 px-2 py-1 text-xs rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${cls}"
          >
            <span class="w-2 h-2 rounded-full shrink-0" style="background-color:${color}"></span>
            <span class="truncate max-w-[110px]">${escapeHtml(col.name)}</span>
          </button>
        `;
      })
      .join('');

    this.chartControlsEl.innerHTML = `
      <div class="flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg" role="group" aria-label="Chart type">
        ${typeButtonsHtml}
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <label class="inline-flex items-center gap-1.5 text-xs text-slate-600">
          <span class="whitespace-nowrap">X Axis</span>
          <select
            data-role="x-axis-select"
            aria-label="Select X-axis column"
            class="bg-white border border-slate-200 rounded-md px-2 py-1 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
          >
            ${xOptionsHtml}
          </select>
        </label>
        <div class="flex flex-wrap items-center gap-1" role="group" aria-label="Select Y-axis series">
          ${yTogglesHtml}
        </div>
      </div>
    `;

    this.chartControlsEl
      .querySelectorAll<HTMLButtonElement>('[data-chart-type]')
      .forEach((btn) => {
        btn.addEventListener('click', () => {
          const nextType = btn.dataset.chartType as ChartType;
          this.callbacks.onConfigChange({
            ...this.config,
            type: nextType,
          });
        });
      });

    const xSelect = this.chartControlsEl.querySelector<HTMLSelectElement>(
      '[data-role="x-axis-select"]'
    );
    xSelect?.addEventListener('change', () => {
      this.callbacks.onConfigChange({
        ...this.config,
        xColIndex: Number(xSelect.value),
      });
    });

    this.chartControlsEl
      .querySelectorAll<HTMLButtonElement>('[data-y-col]')
      .forEach((btn) => {
        btn.addEventListener('click', () => {
          const colIdx = Number(btn.dataset.yCol);
          const exists = this.config.yColIndices.includes(colIdx);
          let nextY: number[];
          if (exists) {
            if (this.config.yColIndices.length === 1) return; // Keep at least 1 Y series
            nextY = this.config.yColIndices.filter((c) => c !== colIdx);
          } else {
            nextY = [...this.config.yColIndices, colIdx].slice(-4);
          }
          this.callbacks.onConfigChange({
            ...this.config,
            yColIndices: nextY,
          });
        });
      });
  }

  private extractPoints(): DataPointRow[] {
    if (!this.sheet) return [];
    const sheet = this.sheet;
    const {xColIndex, yColIndices} = this.config;

    return this.visibleRowIndices.slice(0, 32).map((rowIndex) => {
      const row = sheet.rows[rowIndex] ?? [];
      const rawLabel = (row[xColIndex] ?? '').trim() || `Row ${rowIndex + 1}`;
      const xParsed = parseNumericValue(rawLabel).value;
      const values = yColIndices.map((yIdx) => {
        const p = parseNumericValue(row[yIdx] ?? '');
        return p.value ?? 0;
      });
      return {
        rowIndex,
        label: rawLabel,
        values,
        xNumeric: xParsed,
      };
    });
  }

  private renderChart(): void {
    if (!this.chartCanvasWrapEl || !this.legendEl || !this.sheet) return;
    const points = this.extractPoints();
    const yCols = this.config.yColIndices;

    const hasAnyNumericData = this.visibleRowIndices.some((rIdx) =>
      yCols.some((cIdx) => parseNumericValue(this.sheet!.rows[rIdx]?.[cIdx] ?? '').value !== null)
    );

    if (points.length === 0 || yCols.length === 0 || !hasAnyNumericData) {
      this.chartCanvasWrapEl.innerHTML = `
        <div class="flex flex-col items-center justify-center h-full text-center px-6">
          <p class="text-sm font-medium text-slate-700">No chart data yet</p>
          <p class="text-xs text-slate-500 mt-1">Open a CSV or Excel file, or enter numeric values in the spreadsheet to visualize charts.</p>
        </div>
      `;
      this.legendEl.innerHTML = '';
      return;
    }

    // Legend
    this.legendEl.innerHTML = yCols
      .map((colIdx, sIdx) => {
        const name = this.sheet!.columns[colIdx] ?? `Series ${sIdx + 1}`;
        const color = CHART_PALETTE[sIdx % CHART_PALETTE.length];
        return `
          <span class="inline-flex items-center gap-1.5">
            <span class="w-2.5 h-2.5 rounded-xs shrink-0" style="background-color:${color}"></span>
            <span>${escapeHtml(name)}</span>
          </span>
        `;
      })
      .join('');

    if (this.config.type === 'pie') {
      this.renderPieChart(points);
    } else if (this.config.type === 'line') {
      this.renderLineChart(points);
    } else if (this.config.type === 'scatter') {
      this.renderScatterChart(points);
    } else {
      this.renderBarChart(points);
    }
  }

  private renderBarChart(points: DataPointRow[]): void {
    const wrap = this.chartCanvasWrapEl!;
    const W = 580;
    const H = 450;
    const pad = {top: 24, right: 16, bottom: 52, left: 54};
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;

    const allVals = points.flatMap((p) => p.values);
    const maxVal = Math.max(1, ...allVals, 0);
    const minVal = Math.min(0, ...allVals);
    const span = Math.max(1e-6, maxVal - minVal);
    const zeroY = pad.top + ((maxVal - 0) / span) * plotH;

    const yTicks = 4;
    const gridLines: string[] = [];
    for (let i = 0; i <= yTicks; i++) {
      const ratio = i / yTicks;
      const val = maxVal - ratio * span;
      const y = pad.top + ratio * plotH;
      gridLines.push(`
        <line x1="${pad.left}" y1="${y}" x2="${W - pad.right}" y2="${y}" stroke="#e2e8f0" stroke-dasharray="3 3" />
        <text x="${pad.left - 8}" y="${y + 4}" text-anchor="end" class="fill-slate-400 text-[11px] font-mono-tabular">${formatDisplayNumber(val)}</text>
      `);
    }

    const groupW = plotW / points.length;
    const seriesCount = this.config.yColIndices.length;
    const innerPad = Math.min(12, groupW * 0.16);
    const usableGroupW = Math.max(8, groupW - innerPad * 2);
    const barW = Math.max(4, (usableGroupW - (seriesCount - 1) * 4) / seriesCount);

    const barsHtml: string[] = [];
    const xLabelsHtml: string[] = [];

    points.forEach((pt, idx) => {
      const gx = pad.left + idx * groupW;
      const isRowSelected = this.highlightedRowIndex === pt.rowIndex;

      if (isRowSelected) {
        barsHtml.push(
          `<rect x="${gx + 2}" y="${pad.top}" width="${groupW - 4}" height="${plotH}" rx="4" fill="#eff6ff" />`
        );
      }

      pt.values.forEach((val, sIdx) => {
        const yColIdx = this.config.yColIndices[sIdx];
        const colName = this.sheet!.columns[yColIdx] ?? '';
        const colType = this.sheet!.types[yColIdx] ?? 'number';
        const color = CHART_PALETTE[sIdx % CHART_PALETTE.length];
        const bx = gx + innerPad + sIdx * (barW + 4);
        const valY = pad.top + ((maxVal - val) / span) * plotH;
        const barTop = Math.min(valY, zeroY);
        const barHeight = Math.max(2, Math.abs(zeroY - valY));

        barsHtml.push(`
          <rect
            x="${bx}"
            y="${barTop}"
            width="${barW}"
            height="${barHeight}"
            rx="3"
            fill="${color}"
            opacity="${this.highlightedRowIndex !== null && !isRowSelected ? '0.55' : '0.92'}"
            data-point-row="${pt.rowIndex}"
            data-tip-title="${escapeHtml(pt.label)}"
            data-tip-sub="${escapeHtml(colName)}: ${escapeHtml(formatDisplayNumber(val, colType))}"
            class="cursor-pointer transition-opacity hover:opacity-100"
          />
        `);
      });

      const labelX = gx + groupW / 2;
      const rotate = points.length > 7;
      xLabelsHtml.push(`
        <text
          x="${labelX}"
          y="${H - pad.bottom + 16}"
          text-anchor="${rotate ? 'end' : 'middle'}"
          transform="${rotate ? `rotate(-25 ${labelX} ${H - pad.bottom + 16})` : ''}"
          class="fill-slate-600 text-[11px] ${isRowSelected ? 'font-bold fill-blue-700' : ''}"
        >${escapeHtml(truncateLabel(pt.label, points.length > 10 ? 9 : 14))}</text>
      `);
    });

    wrap.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" class="w-full h-full select-none overflow-visible" role="img" aria-label="Interactive bar chart">
        ${gridLines.join('')}
        <line x1="${pad.left}" y1="${zeroY}" x2="${W - pad.right}" y2="${zeroY}" stroke="#94a3b8" stroke-width="1.2" />
        ${barsHtml.join('')}
        ${xLabelsHtml.join('')}
      </svg>
    `;

    this.bindSvgPointEvents();
  }

  private renderLineChart(points: DataPointRow[]): void {
    const wrap = this.chartCanvasWrapEl!;
    const W = 580;
    const H = 450;
    const pad = {top: 24, right: 20, bottom: 52, left: 54};
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;

    const allVals = points.flatMap((p) => p.values);
    const maxVal = Math.max(1, ...allVals);
    const minVal = Math.min(0, ...allVals);
    const span = Math.max(1e-6, maxVal - minVal);

    const gridLines: string[] = [];
    for (let i = 0; i <= 4; i++) {
      const ratio = i / 4;
      const val = maxVal - ratio * span;
      const y = pad.top + ratio * plotH;
      gridLines.push(`
        <line x1="${pad.left}" y1="${y}" x2="${W - pad.right}" y2="${y}" stroke="#e2e8f0" stroke-dasharray="3 3" />
        <text x="${pad.left - 8}" y="${y + 4}" text-anchor="end" class="fill-slate-400 text-[11px] font-mono-tabular">${formatDisplayNumber(val)}</text>
      `);
    }

    const xStep = points.length > 1 ? plotW / (points.length - 1) : 0;
    const getX = (idx: number) =>
      points.length > 1 ? pad.left + idx * xStep : pad.left + plotW / 2;
    const getY = (val: number) => pad.top + ((maxVal - val) / span) * plotH;

    const seriesHtml: string[] = [];
    const markersHtml: string[] = [];
    const xLabelsHtml: string[] = [];

    this.config.yColIndices.forEach((yColIdx, sIdx) => {
      const color = CHART_PALETTE[sIdx % CHART_PALETTE.length];
      const colName = this.sheet!.columns[yColIdx] ?? '';
      const colType = this.sheet!.types[yColIdx] ?? 'number';

      const coords = points.map((pt, idx) => ({
        x: getX(idx),
        y: getY(pt.values[sIdx] ?? 0),
        val: pt.values[sIdx] ?? 0,
        pt,
      }));

      const polyPoints = coords.map((c) => `${c.x},${c.y}`).join(' ');
      if (sIdx === 0 && coords.length > 1) {
        const baselineY = pad.top + plotH;
        const areaPath = `M ${coords[0].x},${baselineY} L ${coords.map((c) => `${c.x},${c.y}`).join(' L ')} L ${coords[coords.length - 1].x},${baselineY} Z`;
        seriesHtml.push(
          `<path d="${areaPath}" fill="${color}" opacity="0.10" />`
        );
      }

      seriesHtml.push(`
        <polyline fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" points="${polyPoints}" />
      `);

      coords.forEach((c) => {
        const isSel = this.highlightedRowIndex === c.pt.rowIndex;
        markersHtml.push(`
          <circle
            cx="${c.x}"
            cy="${c.y}"
            r="${isSel ? 6.5 : 4.5}"
            fill="#ffffff"
            stroke="${color}"
            stroke-width="${isSel ? 3 : 2.5}"
            data-point-row="${c.pt.rowIndex}"
            data-tip-title="${escapeHtml(c.pt.label)}"
            data-tip-sub="${escapeHtml(colName)}: ${escapeHtml(formatDisplayNumber(c.val, colType))}"
            class="cursor-pointer"
          />
        `);
      });
    });

    points.forEach((pt, idx) => {
      const x = getX(idx);
      const rotate = points.length > 7;
      xLabelsHtml.push(`
        <text
          x="${x}"
          y="${H - pad.bottom + 16}"
          text-anchor="${rotate ? 'end' : 'middle'}"
          transform="${rotate ? `rotate(-25 ${x} ${H - pad.bottom + 16})` : ''}"
          class="fill-slate-600 text-[11px]"
        >${escapeHtml(truncateLabel(pt.label, points.length > 10 ? 9 : 14))}</text>
      `);
    });

    wrap.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" class="w-full h-full select-none overflow-visible" role="img" aria-label="Interactive line chart">
        ${gridLines.join('')}
        ${seriesHtml.join('')}
        ${markersHtml.join('')}
        ${xLabelsHtml.join('')}
      </svg>
    `;

    this.bindSvgPointEvents();
  }

  private renderPieChart(points: DataPointRow[]): void {
    const wrap = this.chartCanvasWrapEl!;
    const yColIdx = this.config.yColIndices[0] ?? 1;
    const colName = this.sheet!.columns[yColIdx] ?? '';
    const colType = this.sheet!.types[yColIdx] ?? 'number';

    const slices = points
      .map((pt, idx) => ({
        rowIndex: pt.rowIndex,
        label: pt.label,
        value: Math.max(0, pt.values[0] ?? 0),
        color: CHART_PALETTE[idx % CHART_PALETTE.length],
      }))
      .filter((s) => s.value > 0);

    const total = slices.reduce((acc, s) => acc + s.value, 0);
    if (total <= 0) {
      wrap.innerHTML = `<div class="flex items-center justify-center h-full text-xs text-slate-500">Positive values are required to render a pie chart.</div>`;
      return;
    }

    const W = 580;
    const H = 450;
    const cx = 168;
    const cy = H / 2;
    const outerR = 124;
    const innerR = 64;

    let currentAngle = -Math.PI / 2;
    const pathsHtml: string[] = [];
    const sliceListHtml: string[] = [];

    slices.forEach((slice, idx) => {
      const fraction = slice.value / total;
      const angle = fraction * Math.PI * 2;
      const startAngle = currentAngle;
      const endAngle = currentAngle + angle;
      currentAngle = endAngle;

      const isSel = this.highlightedRowIndex === slice.rowIndex;
      const rOut = isSel ? outerR + 6 : outerR;
      const largeArc = angle > Math.PI ? 1 : 0;

      const x1 = cx + rOut * Math.cos(startAngle);
      const y1 = cy + rOut * Math.sin(startAngle);
      const x2 = cx + rOut * Math.cos(endAngle);
      const y2 = cy + rOut * Math.sin(endAngle);

      const x3 = cx + innerR * Math.cos(endAngle);
      const y3 = cy + innerR * Math.sin(endAngle);
      const x4 = cx + innerR * Math.cos(startAngle);
      const y4 = cy + innerR * Math.sin(startAngle);

      const d =
        slices.length === 1
          ? `M ${cx} ${cy - rOut} A ${rOut} ${rOut} 0 1 1 ${cx - 0.01} ${cy - rOut} Z M ${cx} ${cy - innerR} A ${innerR} ${innerR} 0 1 0 ${cx - 0.01} ${cy - innerR} Z`
          : `M ${x1} ${y1} A ${rOut} ${rOut} 0 ${largeArc} 1 ${x2} ${y2} L ${x3} ${y3} A ${innerR} ${innerR} 0 ${largeArc} 0 ${x4} ${y4} Z`;

      const pct = (fraction * 100).toFixed(1);
      pathsHtml.push(`
        <path
          d="${d}"
          fill="${slice.color}"
          stroke="#ffffff"
          stroke-width="2"
          opacity="${this.highlightedRowIndex !== null && !isSel ? '0.6' : '1'}"
          data-point-row="${slice.rowIndex}"
          data-tip-title="${escapeHtml(slice.label)}"
          data-tip-sub="${escapeHtml(colName)}: ${escapeHtml(formatDisplayNumber(slice.value, colType))} (${pct}%)"
          class="cursor-pointer transition-opacity hover:opacity-90"
        />
      `);

      if (idx < 9) {
        const ly = 96 + idx * 30;
        sliceListHtml.push(`
          <g data-point-row="${slice.rowIndex}" class="cursor-pointer">
            <rect x="328" y="${ly - 10}" width="10" height="10" rx="2" fill="${slice.color}" />
            <text x="346" y="${ly - 1}" class="fill-slate-700 text-xs ${isSel ? 'font-bold fill-blue-700' : ''}">${escapeHtml(truncateLabel(slice.label, 16))}</text>
            <text x="564" y="${ly - 1}" text-anchor="end" class="fill-slate-500 text-xs font-mono-tabular">${pct}%</text>
          </g>
        `);
      }
    });

    wrap.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" class="w-full h-full select-none" role="img" aria-label="Interactive pie chart">
        ${pathsHtml.join('')}
        <text x="${cx}" y="${cy - 4}" text-anchor="middle" class="fill-slate-400 text-[11px]">Total</text>
        <text x="${cx}" y="${cy + 16}" text-anchor="middle" class="fill-slate-900 text-base font-bold font-mono-tabular">${formatDisplayNumber(total, colType)}</text>
        ${sliceListHtml.join('')}
      </svg>
    `;

    this.bindSvgPointEvents();
  }

  private renderScatterChart(points: DataPointRow[]): void {
    const wrap = this.chartCanvasWrapEl!;
    const W = 580;
    const H = 450;
    const pad = {top: 24, right: 20, bottom: 48, left: 54};
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;

    const xCoords = points.map((p, i) => p.xNumeric ?? i + 1);
    const xMin = Math.min(...xCoords);
    const xMax = Math.max(...xCoords, xMin + 1);
    const yVals = points.map((p) => p.values[0] ?? 0);
    const yMin = Math.min(0, ...yVals);
    const yMax = Math.max(1, ...yVals);

    const gridLines: string[] = [];
    for (let i = 0; i <= 4; i++) {
      const r = i / 4;
      const y = pad.top + r * plotH;
      const yVal = yMax - r * (yMax - yMin);
      gridLines.push(`
        <line x1="${pad.left}" y1="${y}" x2="${W - pad.right}" y2="${y}" stroke="#e2e8f0" stroke-dasharray="3 3" />
        <text x="${pad.left - 8}" y="${y + 4}" text-anchor="end" class="fill-slate-400 text-[11px] font-mono-tabular">${formatDisplayNumber(yVal)}</text>
      `);
    }

    const yColIdx = this.config.yColIndices[0] ?? 1;
    const colName = this.sheet!.columns[yColIdx] ?? '';
    const colType = this.sheet!.types[yColIdx] ?? 'number';

    const dotsHtml = points
      .map((pt, idx) => {
        const xv = xCoords[idx];
        const yv = pt.values[0] ?? 0;
        const cx =
          pad.left + ((xv - xMin) / Math.max(1e-6, xMax - xMin)) * plotW;
        const cy =
          pad.top + ((yMax - yv) / Math.max(1e-6, yMax - yMin)) * plotH;
        const isSel = this.highlightedRowIndex === pt.rowIndex;
        const color = CHART_PALETTE[idx % CHART_PALETTE.length];

        return `
          <g>
            <circle
              cx="${cx}"
              cy="${cy}"
              r="${isSel ? 8.5 : 6}"
              fill="${color}"
              fill-opacity="0.85"
              stroke="#ffffff"
              stroke-width="2"
              data-point-row="${pt.rowIndex}"
              data-tip-title="${escapeHtml(pt.label)}"
              data-tip-sub="${escapeHtml(colName)}: ${escapeHtml(formatDisplayNumber(yv, colType))}"
              class="cursor-pointer"
            />
            <text x="${cx}" y="${cy - 10}" text-anchor="middle" class="fill-slate-600 text-[10px] pointer-events-none">${escapeHtml(truncateLabel(pt.label, 10))}</text>
          </g>
        `;
      })
      .join('');

    wrap.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" class="w-full h-full select-none overflow-visible" role="img" aria-label="Interactive scatter chart">
        ${gridLines.join('')}
        <line x1="${pad.left}" y1="${pad.top + plotH}" x2="${W - pad.right}" y2="${pad.top + plotH}" stroke="#94a3b8" />
        ${dotsHtml}
      </svg>
    `;

    this.bindSvgPointEvents();
  }

  private bindSvgPointEvents(): void {
    const wrap = this.chartCanvasWrapEl;
    const tip = this.tooltipEl;
    if (!wrap) return;

    wrap.querySelectorAll<SVGElement>('[data-point-row]').forEach((el) => {
      el.addEventListener('click', () => {
        const rowIndex = Number(el.dataset.pointRow);
        this.callbacks.onRowSelect(rowIndex);
      });

      el.addEventListener('mouseenter', (e) => {
        if (!tip) return;
        const title = el.dataset.tipTitle;
        const sub = el.dataset.tipSub;
        if (!title) return;
        tip.innerHTML = `<div class="font-semibold">${escapeHtml(title)}</div><div class="text-slate-300 font-mono-tabular">${escapeHtml(sub ?? '')}</div>`;
        tip.classList.remove('hidden');
        this.positionTooltip(e as MouseEvent);
      });

      el.addEventListener('mousemove', (e) => {
        this.positionTooltip(e as MouseEvent);
      });

      el.addEventListener('mouseleave', () => {
        tip?.classList.add('hidden');
      });
    });
  }

  private positionTooltip(e: MouseEvent): void {
    if (!this.tooltipEl || !this.chartCanvasWrapEl) return;
    const rect = this.chartCanvasWrapEl.getBoundingClientRect();
    const x = e.clientX - rect.left + 12;
    const y = e.clientY - rect.top - 12;
    const clampedX = Math.max(8, Math.min(rect.width - 170, x));
    const clampedY = Math.max(8, Math.min(rect.height - 48, y));
    this.tooltipEl.style.left = `${clampedX}px`;
    this.tooltipEl.style.top = `${clampedY}px`;
  }
}
