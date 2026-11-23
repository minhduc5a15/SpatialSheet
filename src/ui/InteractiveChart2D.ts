import {ChartBuilder} from './ChartBuilder';
import {chartDisplaySummary} from '../core/chartValidation';
import type {AnalyticalSelection} from '../types';
import type {
  ChartAggregationMode,
  ChartConfig,
  ChartRecommendation,
  ChartSortOrder,
  ChartType,
  DatasetProfile,
  SheetData,
  VisibleRowsSource,
} from '../types';
import {
  CHART_PALETTE,
  formatDisplayNumber,
} from '../core/tabular';
import {
  applySeriesPreset,
  getSecondaryControlsForChartType,
  getSeriesColor,
  getSeriesMarker,
} from './ChartSeriesManager';
import {svgIcon} from './icons';
import {renderBrandLogoHtml} from './branding';

const DEFAULT_MAX_CHART_POINTS = 32;

export interface Chart2DCallbacks {
  onConfigChange: (config: ChartConfig) => void;
  onRowSelect: (rowIndex: number) => void;
  onPointSelect?: (point: DataPointRow, colIndex: number, aggregation: ChartAggregationMode) => void;
  onApplyRecommendation?: (rec: ChartRecommendation) => void;
}

export {extractChart2DPoints} from '../core/chartData';
import {extractChart2DPoints, type DataPointRow} from '../core/chartData';

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
  private builder: ChartBuilder | null = null;
  private analyticalSelection: AnalyticalSelection | null = null;
  private callbacks: Chart2DCallbacks;
  private sheet: SheetData | null = null;
  private profile: DatasetProfile | null = null;
  private visibleRowIndices: VisibleRowsSource = [];
  private config: ChartConfig = {
    type: 'bar',
    xColIndex: 0,
    yColIndices: [1],
    spatialMode: 'bar3d',
    aggregation: 'none',
    sortOrder: 'source',
    maxPoints: DEFAULT_MAX_CHART_POINTS,
  };
  private highlightedRowIndex: number | null = null;

  private chartControlsEl: HTMLElement | null = null;
  private chartCanvasWrapEl: HTMLElement | null = null;
  private legendEl: HTMLElement | null = null;
  private tooltipEl: HTMLElement | null = null;

  // Memoization keys & caches
  private lastPointsKey: {
    sheet: SheetData | null;
    profile: DatasetProfile | null;
    visibleRowIndices: VisibleRowsSource | null;
    xColIndex: number;
    yKey: string;
    aggregation: ChartAggregationMode;
    sortOrder: ChartSortOrder;
    maxPoints: number;
  } | null = null;
  private cachedPoints: DataPointRow[] = [];
  private cachedHasNumeric = false;
  private activeTooltipTarget: Element | null = null;
  private recommendations: ChartRecommendation[] = [];
  private legendExpanded = false;
  private readonly abortController = new AbortController();

  constructor(container: HTMLElement, callbacks: Chart2DCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.renderShell();
  }

  private renderShell(): void {
    this.container.innerHTML = `
      <div class="flex flex-col h-full bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div data-role="chart-controls"></div>

        <!-- SVG Chart Stage -->
        <div class="relative flex-1 min-h-[240px] p-3 flex flex-col">
          <div data-role="chart-canvas-wrap" class="relative flex-1 w-full min-h-[200px]"></div>
          <div
            data-role="chart-tooltip"
            class="pointer-events-none hidden absolute z-20 bg-slate-900 text-white text-xs rounded-lg px-2.5 py-1.5 shadow-lg whitespace-nowrap"
          ></div>
        </div>

        <!-- Chart Legend -->
        <div
          data-role="chart-legend"
          class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 px-3 py-2 border-t border-slate-200 bg-slate-50 text-xs text-slate-700"
        ></div>
      </div>
    `;

    this.chartControlsEl = this.container.querySelector('[data-role="chart-controls"]');
    this.builder = new ChartBuilder(this.chartControlsEl!, config => this.callbacks.onConfigChange(config));

    this.chartCanvasWrapEl = this.container.querySelector('[data-role="chart-canvas-wrap"]');
    this.legendEl = this.container.querySelector('[data-role="chart-legend"]');
    this.tooltipEl = this.container.querySelector('[data-role="chart-tooltip"]');

    this.bindDelegatedEvents();
  }

  private bindDelegatedEvents(): void {
    const {signal} = this.abortController;
    if (this.chartCanvasWrapEl) {
      this.chartCanvasWrapEl.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          const point = (event.target as Element).closest<SVGElement>('[data-point-row]');
          if (point) {event.preventDefault(); point.dispatchEvent(new MouseEvent('click', {bubbles: true}));}
        }
      }, {signal});
      this.chartCanvasWrapEl.addEventListener(
        'click',
        (e) => {
          const target = e.target as Element | null;
          const emptyActionBtn = target?.closest<HTMLButtonElement>('[data-empty-chart]');
          if (emptyActionBtn && this.sheet) {
            const action = emptyActionBtn.dataset.emptyChart;
            if (action === 'restore') {
              const recCols = applySeriesPreset(
                'recommended',
                this.sheet,
                this.profile,
                this.config.xColIndex
              );
              this.callbacks.onConfigChange({
                ...this.config,
                yColIndices: recCols,
              });
            } else if (action === 'open-series') {
              this.builder?.openSeries();
            }
            return;
          }

          const pointEl = target?.closest<SVGElement>('[data-point-row]');
          if (pointEl) {
            const rowIndex = Number(pointEl.dataset.pointRow);
            const point = this.cachedPoints.find(p => p.rowIndex === rowIndex);
            const colIndex = Number(pointEl.dataset.pointCol ?? this.config.yColIndices[0]);
            if (point && this.callbacks.onPointSelect) {
              const agg = getSecondaryControlsForChartType(this.config.type).showAggregation ? this.config.aggregation ?? 'none' : 'none';
              this.callbacks.onPointSelect(point, colIndex, agg);
            } else this.callbacks.onRowSelect(rowIndex);
          }
        },
        {signal}
      );

      this.chartCanvasWrapEl.addEventListener(
        'mouseover',
        (e) => {
          const target = e.target as Element | null;
          const pointEl = target?.closest<SVGElement>('[data-point-row]');
          if (!pointEl) {
            if (this.activeTooltipTarget) {
              this.activeTooltipTarget = null;
              this.tooltipEl?.classList.add('hidden');
            }
            return;
          }
          if (pointEl !== this.activeTooltipTarget && this.tooltipEl) {
            this.activeTooltipTarget = pointEl;
            const title = pointEl.dataset.tipTitle;
            const sub = pointEl.dataset.tipSub;
            if (title) {
              this.tooltipEl.innerHTML = `<div class="font-semibold">${escapeHtml(title)}</div><div class="text-slate-300 font-mono-tabular">${escapeHtml(sub ?? '')}</div>`;
              this.tooltipEl.classList.remove('hidden');
            }
          }
          this.positionTooltip(e as MouseEvent);
        },
        {signal}
      );

      this.chartCanvasWrapEl.addEventListener(
        'mousemove',
        (e) => {
          if (this.activeTooltipTarget) {
            this.positionTooltip(e as MouseEvent);
          }
        },
        {signal}
      );

      this.chartCanvasWrapEl.addEventListener(
        'mouseleave',
        () => {
          this.activeTooltipTarget = null;
          this.tooltipEl?.classList.add('hidden');
        },
        {signal}
      );
    }

    if (this.legendEl) {
      this.legendEl.addEventListener(
        'click',
        (e) => {
          const target = e.target as HTMLElement | null;
          const toggleLegendBtn = target?.closest<HTMLButtonElement>('[data-legend-toggle]');
          if (toggleLegendBtn) {
            this.legendExpanded = !this.legendExpanded;
            this.renderLegend();
            return;
          }
          const btn = target?.closest<HTMLButtonElement>('[data-apply-2d-rec]');
          if (btn) {
            const rec = this.recommendations.find(
              (r) => r.id === btn.dataset.apply2dRec
            );
            if (rec) this.callbacks.onApplyRecommendation?.(rec);
          }
        },
        {signal}
      );
    }
  }

  public setData(params: {
    sheet: SheetData;
    visibleRowIndices: VisibleRowsSource;
    config: ChartConfig;
    highlightedRowIndex: number | null;
    recommendations?: ChartRecommendation[];
    profile?: DatasetProfile | null;
    analyticalSelection?: AnalyticalSelection | null;
  }): void {
    this.analyticalSelection = params.analyticalSelection ?? null;
    this.sheet = params.sheet;
    this.visibleRowIndices = params.visibleRowIndices;
    this.config = {
      ...params.config,
      aggregation: params.config.aggregation ?? 'none',
      sortOrder: params.config.sortOrder ?? 'source',
      maxPoints: params.config.maxPoints ?? DEFAULT_MAX_CHART_POINTS,
    };
    this.highlightedRowIndex = params.highlightedRowIndex;
    if (params.recommendations) {
      this.recommendations = params.recommendations;
    }
    if (params.profile !== undefined) {
      this.profile = params.profile;
    }

    this.renderControlsIfNeeded();
    this.renderChart();
  }

  /** Fast highlight update without touching controls or re-sampling dataset. */
  public setHighlight(highlightedRowIndex: number | null, selection?: AnalyticalSelection | null): void {
    if (this.highlightedRowIndex === highlightedRowIndex && this.analyticalSelection === selection) return;
    this.analyticalSelection = selection ?? null;
    this.highlightedRowIndex = highlightedRowIndex;
    if (this.sheet && this.cachedHasNumeric) {
      this.renderChart();
    }
  }

  public openSeriesManager(): void {
    this.builder?.openSeries();
  }

  public isSeriesManagerOpen(): boolean {
    return this.builder?.isSeriesOpen() ?? false;
  }

  public closeSeriesManager(): void {
    this.builder?.closeSeries();
  }

  private renderControlsIfNeeded(): void {
    if (this.sheet) this.builder?.update(this.sheet, this.profile, this.config, this.recommendations);
  }

  private getMemoizedPoints(): {points: DataPointRow[]; hasAnyNumeric: boolean} {
    if (!this.sheet) return {points: [], hasAnyNumeric: false};

    const yKey = this.config.yColIndices.join(',');
    const agg: ChartAggregationMode = this.config.aggregation ?? 'none';
    const sortOrder: ChartSortOrder = this.config.sortOrder ?? 'source';
    const maxPoints = this.config.maxPoints ?? DEFAULT_MAX_CHART_POINTS;
    const vis = getSecondaryControlsForChartType(this.config.type);
    const effAgg = vis.showAggregation ? agg : 'none';
    const effSort = vis.showSort ? sortOrder : 'source';
    const effMax = vis.showLimit ? maxPoints : DEFAULT_MAX_CHART_POINTS;

    if (
      this.lastPointsKey &&
      this.lastPointsKey.sheet === this.sheet &&
      this.lastPointsKey.profile === this.profile &&
      this.lastPointsKey.visibleRowIndices === this.visibleRowIndices &&
      this.lastPointsKey.xColIndex === this.config.xColIndex &&
      this.lastPointsKey.yKey === yKey &&
      this.lastPointsKey.aggregation === effAgg &&
      this.lastPointsKey.sortOrder === effSort &&
      this.lastPointsKey.maxPoints === effMax
    ) {
      return {points: this.cachedPoints, hasAnyNumeric: this.cachedHasNumeric};
    }

    const {xColIndex, yColIndices} = this.config;
    const {points, hasAnyNumeric} = extractChart2DPoints(
      this.sheet,
      this.visibleRowIndices,
      xColIndex,
      yColIndices,
      {
        maxPoints: effMax,
        aggregation: effAgg,
        sortOrder: effSort,
        profile: this.profile,
      }
    );

    this.lastPointsKey = {
      sheet: this.sheet,
      profile: this.profile,
      visibleRowIndices: this.visibleRowIndices,
      xColIndex,
      yKey,
      aggregation: effAgg,
      sortOrder: effSort,
      maxPoints: effMax,
    };
    this.cachedPoints = points;
    this.cachedHasNumeric = hasAnyNumeric;

    return {points, hasAnyNumeric};
  }

  private renderLegend(): void {
    if (!this.legendEl || !this.sheet) return;
    const yCols = this.config.yColIndices;
    if (yCols.length === 0) {
      this.legendEl.innerHTML = '';
      return;
    }

    const activeCols =
      this.config.type === 'pie' || this.config.type === 'scatter'
        ? yCols.slice(0, 1)
        : yCols;

    const collapseCap = 5;
    const canCollapse = activeCols.length > collapseCap;
    const shownCols =
      canCollapse && !this.legendExpanded
        ? activeCols.slice(0, collapseCap)
        : activeCols;

    const legendItemsHtml = shownCols
      .map((colIdx, sIdx) => {
        const name = this.sheet!.columns[colIdx] ?? `Series ${sIdx + 1}`;
        const color = getSeriesColor(colIdx);
        const marker = getSeriesMarker(colIdx);
        return `
          <span class="inline-flex items-center gap-1 min-w-0" title="${escapeHtml(name)}">
            <span class="text-[11px] font-bold leading-none shrink-0" style="color:${color}" aria-hidden="true">${marker}</span>
            <span class="w-2 h-2 rounded-xs shrink-0" style="background-color:${color}"></span>
            <span class="truncate max-w-[130px]">${escapeHtml(name)}</span>
          </span>
        `;
      })
      .join('');

    const toggleHtml = canCollapse
      ? `<button type="button" data-legend-toggle class="text-[11px] font-medium text-blue-600 hover:text-blue-800 hover:underline whitespace-nowrap shrink-0 cursor-pointer">${
          this.legendExpanded
            ? 'Show fewer'
            : `+${activeCols.length - collapseCap} more`
        }</button>`
      : '';

    const points = this.cachedPoints;
    const totalVisible = this.visibleRowIndices.length;
    const agg = this.config.aggregation ?? 'none';
    const vis = getSecondaryControlsForChartType(this.config.type);
    const effAgg = vis.showAggregation ? agg : 'none';
    const effMax = vis.showLimit
      ? this.config.maxPoints ?? DEFAULT_MAX_CHART_POINTS
      : DEFAULT_MAX_CHART_POINTS;

    const displayNote = this.config.type === 'pie'
      ? `Pie: ${Math.min(12, points.filter(p => p.values[0] !== null && p.values[0] > 0).length)} positive slices from ${points.length} candidates · proportions of displayed slices · ${totalVisible} filtered records`
      : this.config.type === 'scatter'
        ? `${chartDisplaySummary(this.config, totalVisible, points.length)} · ${points.filter(p => p.xNumeric !== null && p.values[0] !== null).length} valid numeric pairs plotted`
        : chartDisplaySummary(this.config, totalVisible, points.length);
    const sampleNoteHtml = `<span data-role="chart-display-summary" class="text-xs text-slate-500">${escapeHtml(displayNote)}</span>`;

    const suggested2D = this.recommendations.find(
      (r) =>
        r.targetSurface === '2d' &&
        r.chartType &&
        r.chartType !== this.config.type
    );
    const recChipHtml = suggested2D
      ? `<button type="button" data-apply-2d-rec="${escapeHtml(suggested2D.id)}" title="${escapeHtml(suggested2D.reason)}" class="text-[11px] font-medium text-blue-600 hover:text-blue-800 hover:underline cursor-pointer">Try ${escapeHtml(suggested2D.title)}</button>`
      : '';

    this.legendEl.innerHTML = `
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 max-h-16 overflow-y-auto sheet-scroll min-w-0">
        ${legendItemsHtml}
        ${toggleHtml}
      </div>
      <div class="flex items-center gap-3 ml-auto shrink-0">${recChipHtml}${sampleNoteHtml}</div>
    `;
  }

  private renderChart(): void {
    if (!this.chartCanvasWrapEl || !this.legendEl || !this.sheet) return;
    const active = document.activeElement as SVGElement | null;
    const focusedRow = active && this.chartCanvasWrapEl.contains(active) ? active.dataset.pointRow : undefined;
    const focusedCol = active?.dataset.pointCol;
    this.activeTooltipTarget = null;
    this.tooltipEl?.classList.add('hidden');

    const yCols = this.config.yColIndices;

    // Dedicated empty-selection state
    if (yCols.length === 0) {
      this.lastPointsKey = null;
      this.cachedPoints = [];
      this.cachedHasNumeric = false;
      this.chartCanvasWrapEl.innerHTML = `
        <div data-role="chart-empty-selection" class="flex flex-col items-center justify-center h-full text-center px-6">
          ${renderBrandLogoHtml({
            variant: 'empty',
            sizePx: 48,
            decorative: true,
            className: 'w-12 h-12 mb-3 opacity-90',
          })}
          <p class="text-sm font-semibold text-slate-800">No Y series selected</p>
          <p class="text-xs text-slate-500 mt-1 max-w-xs">Select one or more numeric columns from the Series Manager to plot a chart.</p>
          <div class="mt-3 flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              data-empty-chart="restore"
              class="px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg cursor-pointer"
            >Restore recommended</button>
            <button
              type="button"
              data-empty-chart="open-series"
              class="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg cursor-pointer"
            >Choose series</button>
          </div>
        </div>
      `;
      this.legendEl.innerHTML = '';
      return;
    }

    const {points, hasAnyNumeric} = this.getMemoizedPoints();

    if (points.length === 0 || !hasAnyNumeric) {
      this.chartCanvasWrapEl.innerHTML = `
        <div class="flex flex-col items-center justify-center h-full text-center px-6">
          ${renderBrandLogoHtml({
            variant: 'empty',
            sizePx: 48,
            decorative: true,
            className: 'w-12 h-12 mb-3 opacity-90',
          })}
          <p class="text-sm font-semibold text-slate-800">No chartable numeric values in current selection</p>
          <p class="text-xs text-slate-500 mt-1 max-w-xs">The selected series or filtered rows have no numeric values. Choose numeric columns in Series Manager or clear active filters.</p>
          <div class="mt-3 flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              data-empty-chart="open-series"
              class="px-3 py-1.5 text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg cursor-pointer"
            >Choose series</button>
          </div>
        </div>
      `;
      this.legendEl.innerHTML = '';
      return;
    }

    this.renderLegend();

    if (this.config.type === 'pie') {
      this.renderPieChart(points);
    } else if (this.config.type === 'line') {
      this.renderLineChart(points);
    } else if (this.config.type === 'scatter') {
      this.renderScatterChart(points);
    } else {
      this.renderBarChart(points);
    }
    this.decoratePoints();
    if (focusedRow !== undefined) {
      const selector = `[data-point-row="${Number(focusedRow)}"]${focusedCol !== undefined ? `[data-point-col="${Number(focusedCol)}"]` : ''}`;
      this.chartCanvasWrapEl.querySelector<SVGElement>(selector)?.focus({preventScroll: true});
    }
  }

  private decoratePoints(): void {
    this.chartCanvasWrapEl?.querySelectorAll<SVGElement>('[data-point-row]').forEach(el => {
      const row = Number(el.dataset.pointRow);
      const col = Number(el.dataset.pointCol ?? this.config.yColIndices[0]);
      const selection = this.analyticalSelection;
      const selected = selection?.kind === 'aggregate'
        ? selection.origin === '2d' && selection.chartRowKey === row && selection.colIndex === col
        : this.highlightedRowIndex === row;
      el.setAttribute('role', 'button'); el.setAttribute('tabindex', '0');
      el.setAttribute('aria-label', `${el.dataset.tipTitle ?? 'Chart point'} · ${el.dataset.tipSub ?? this.sheet?.columns[col] ?? ''}`);
      el.setAttribute('aria-pressed', String(selected));
      el.classList.toggle('analytical-point-selected', selected);
    });
  }

  private getMinMaxValues(points: DataPointRow[]): {minVal: number; maxVal: number} {
    let minVal = Infinity;
    let maxVal = -Infinity;
    for (let i = 0; i < points.length; i++) {
      const vals = points[i].values;
      for (let j = 0; j < vals.length; j++) {
        const v = vals[j];
        if (v === null) continue;
        if (v < minVal) minVal = v;
        if (v > maxVal) maxVal = v;
      }
    }
    if (!Number.isFinite(minVal) || !Number.isFinite(maxVal)) {
      return {minVal: 0, maxVal: 1};
    }
    if (minVal > 0) minVal = 0;
    if (maxVal < 0) maxVal = 0;
    return {minVal, maxVal};
  }

  private renderBarChart(points: DataPointRow[]): void {
    const wrap = this.chartCanvasWrapEl!;
    const W = 580;
    const H = 450;
    const pad = {top: 24, right: 16, bottom: 52, left: 54};
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;

    const {minVal, maxVal} = this.getMinMaxValues(points);
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
    const seriesCount = Math.max(1, this.config.yColIndices.length);
    const innerPad = Math.min(10, groupW * 0.14);
    const usableGroupW = Math.max(6, groupW - innerPad * 2);
    const barGap = seriesCount > 4 ? 1.5 : 3;
    const barW = Math.max(
      2,
      (usableGroupW - Math.max(0, seriesCount - 1) * barGap) / seriesCount
    );

    const barsHtml: string[] = [];
    const xLabelsHtml: string[] = [];

    points.forEach((pt, idx) => {
      const gx = pad.left + idx * groupW;
      const isRowSelected = this.highlightedRowIndex === pt.rowIndex;

      if (isRowSelected) {
        barsHtml.push(
          `<rect x="${gx + 2}" y="${pad.top}" width="${Math.max(4, groupW - 4)}" height="${plotH}" rx="4" fill="#eff6ff" />`
        );
      }

      pt.values.forEach((val, sIdx) => {
        if (val === null) return;
        const yColIdx = this.config.yColIndices[sIdx];
        const colName = this.sheet!.columns[yColIdx] ?? '';
        const colType = this.sheet!.types[yColIdx] ?? 'number';
        const color = getSeriesColor(yColIdx);
        const bx = gx + innerPad + sIdx * (barW + barGap);
        const valY = pad.top + ((maxVal - val) / span) * plotH;
        const barTop = Math.min(valY, zeroY);
        const barHeight = Math.max(2, Math.abs(zeroY - valY));
        const countSuffix =
          pt.groupCount && pt.groupCount > 1 ? ` (${pt.groupCount} rows)` : '';

        barsHtml.push(`
          <rect
            x="${bx}"
            y="${barTop}"
            width="${barW}"
            height="${barHeight}"
            rx="${barW >= 6 ? 3 : 1}"
            fill="${color}"
            opacity="${this.highlightedRowIndex !== null && !isRowSelected ? '0.55' : '0.92'}"
            data-point-row="${pt.rowIndex}" data-point-col="${yColIdx}"
            data-tip-title="${escapeHtml(pt.label)}${escapeHtml(countSuffix)}"
            data-tip-sub="${escapeHtml(colName)}: ${escapeHtml(formatDisplayNumber(val, colType))}"
            class="cursor-pointer transition-opacity hover:opacity-100"
          />
        `);
      });

      const labelX = gx + groupW / 2;
      const rotate = points.length > 7;
      if (points.length <= 16 || idx % Math.ceil(points.length / 12) === 0 || isRowSelected) {
        xLabelsHtml.push(`
          <text
            x="${labelX}"
            y="${H - pad.bottom + 16}"
            text-anchor="${rotate ? 'end' : 'middle'}"
            transform="${rotate ? `rotate(-25 ${labelX} ${H - pad.bottom + 16})` : ''}"
            class="fill-slate-600 text-[11px] ${isRowSelected ? 'font-bold fill-blue-700' : ''}"
          >${escapeHtml(truncateLabel(pt.label, points.length > 10 ? 9 : 14))}</text>
        `);
      }
    });

    wrap.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" class="w-full h-full select-none overflow-visible" role="img" aria-label="Interactive bar chart">
        ${gridLines.join('')}
        <line x1="${pad.left}" y1="${zeroY}" x2="${W - pad.right}" y2="${zeroY}" stroke="#94a3b8" stroke-width="1.2" />
        ${barsHtml.join('')}
        ${xLabelsHtml.join('')}
      </svg>
    `;
  }

  private renderLineChart(points: DataPointRow[]): void {
    const wrap = this.chartCanvasWrapEl!;
    const W = 580;
    const H = 450;
    const pad = {top: 24, right: 20, bottom: 52, left: 54};
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;

    const {minVal, maxVal} = this.getMinMaxValues(points);
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
      const color = getSeriesColor(yColIdx);
      const colName = this.sheet!.columns[yColIdx] ?? '';
      const colType = this.sheet!.types[yColIdx] ?? 'number';

      const segments: Array<
        Array<{x: number; y: number; val: number; pt: DataPointRow}>
      > = [];
      let currentSeg: Array<{x: number; y: number; val: number; pt: DataPointRow}> =
        [];

      points.forEach((pt, idx) => {
        const rawVal = pt.values[sIdx];
        if (rawVal === null || rawVal === undefined) {
          if (currentSeg.length > 0) {
            segments.push(currentSeg);
            currentSeg = [];
          }
          return;
        }
        currentSeg.push({
          x: getX(idx),
          y: getY(rawVal),
          val: rawVal,
          pt,
        });
      });
      if (currentSeg.length > 0) {
        segments.push(currentSeg);
      }

      const baselineY = pad.top + plotH;
      for (const seg of segments) {
        if (seg.length > 1) {
          if (sIdx === 0 && this.config.yColIndices.length <= 4) {
            const areaPath = `M ${seg[0].x},${baselineY} L ${seg.map((c) => `${c.x},${c.y}`).join(' L ')} L ${seg[seg.length - 1].x},${baselineY} Z`;
            seriesHtml.push(
              `<path d="${areaPath}" fill="${color}" opacity="0.09" />`
            );
          }
          const polyPoints = seg.map((c) => `${c.x},${c.y}`).join(' ');
          seriesHtml.push(`
            <polyline fill="none" stroke="${color}" stroke-width="${this.config.yColIndices.length > 5 ? 2 : 2.5}" stroke-linejoin="round" stroke-linecap="round" points="${polyPoints}" />
          `);
        }

        for (const c of seg) {
          const isSel = this.highlightedRowIndex === c.pt.rowIndex;
          markersHtml.push(`
            <circle
              cx="${c.x}"
              cy="${c.y}"
              r="${isSel ? 6.5 : this.config.yColIndices.length > 5 ? 3.5 : 4.5}"
              fill="#ffffff"
              stroke="${color}"
              stroke-width="${isSel ? 3 : 2.2}"
              data-point-row="${c.pt.rowIndex}"
              data-tip-title="${escapeHtml(c.pt.label)}"
              data-tip-sub="${escapeHtml(colName)}: ${escapeHtml(formatDisplayNumber(c.val, colType))}"
              class="cursor-pointer"
            />
          `);
        }
      }
    });

    points.forEach((pt, idx) => {
      const x = getX(idx);
      const rotate = points.length > 7;
      if (points.length <= 16 || idx % Math.ceil(points.length / 12) === 0) {
        xLabelsHtml.push(`
          <text
            x="${x}"
            y="${H - pad.bottom + 16}"
            text-anchor="${rotate ? 'end' : 'middle'}"
            transform="${rotate ? `rotate(-25 ${x} ${H - pad.bottom + 16})` : ''}"
            class="fill-slate-600 text-[11px]"
          >${escapeHtml(truncateLabel(pt.label, points.length > 10 ? 9 : 14))}</text>
        `);
      }
    });

    wrap.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" class="w-full h-full select-none overflow-visible" role="img" aria-label="Interactive line chart">
        ${gridLines.join('')}
        ${seriesHtml.join('')}
        ${markersHtml.join('')}
        ${xLabelsHtml.join('')}
      </svg>
    `;
  }

  private renderPieChart(points: DataPointRow[]): void {
    const wrap = this.chartCanvasWrapEl!;
    const yColIdx = this.config.yColIndices[0] ?? 1;
    const colName = this.sheet!.columns[yColIdx] ?? '';
    const colType = this.sheet!.types[yColIdx] ?? 'number';

    const slices = points
      .filter((pt) => pt.values[0] !== null && pt.values[0] > 0)
      .slice(0, 12)
      .map((pt, idx) => ({
        rowIndex: pt.rowIndex,
        label: pt.label,
        value: pt.values[0] as number,
        color: CHART_PALETTE[idx % CHART_PALETTE.length],
      }));

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
  }

  private renderScatterChart(points: DataPointRow[]): void {
    const wrap = this.chartCanvasWrapEl!;
    const W = 580;
    const H = 450;
    const pad = {top: 24, right: 20, bottom: 48, left: 54};
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;

    const validYPoints = points.filter((pt) => pt.values[0] !== null);
    const hasNumericX = validYPoints.some((pt) => pt.xNumeric !== null);
    const scatterPoints = validYPoints.filter((pt) => pt.xNumeric !== null);

    if (scatterPoints.length === 0) {
      wrap.innerHTML = `<div class="flex items-center justify-center h-full text-xs text-slate-500">Valid numeric values are required to render a scatter chart.</div>`;
      return;
    }

    let xMin = Infinity;
    let xMax = -Infinity;
    let yMin = Infinity;
    let yMax = -Infinity;
    const xCoords = new Array<number>(scatterPoints.length);

    for (let i = 0; i < scatterPoints.length; i++) {
      const xv = hasNumericX ? (scatterPoints[i].xNumeric as number) : i + 1;
      const yv = scatterPoints[i].values[0] as number;
      xCoords[i] = xv;
      if (xv < xMin) xMin = xv;
      if (xv > xMax) xMax = xv;
      if (yv < yMin) yMin = yv;
      if (yv > yMax) yMax = yv;
    }
    if (!Number.isFinite(xMin)) xMin = 0;
    if (xMax <= xMin) xMax = xMin + 1;
    if (!Number.isFinite(yMin)) yMin = 0;
    if (yMax <= yMin) yMax = yMin + 1;

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
    const seriesColor = getSeriesColor(yColIdx);

    const dotsHtml = scatterPoints
      .map((pt, idx) => {
        const xv = xCoords[idx];
        const yv = pt.values[0] as number;
        const cx =
          pad.left + ((xv - xMin) / Math.max(1e-6, xMax - xMin)) * plotW;
        const cy =
          pad.top + ((yMax - yv) / Math.max(1e-6, yMax - yMin)) * plotH;
        const isSel = this.highlightedRowIndex === pt.rowIndex;

        return `
          <g>
            <circle
              cx="${cx}"
              cy="${cy}"
              r="${isSel ? 8.5 : 6}"
              fill="${seriesColor}"
              fill-opacity="0.85"
              stroke="#ffffff"
              stroke-width="2"
              data-point-row="${pt.rowIndex}" data-point-col="${yColIdx}"
              data-tip-title="${escapeHtml(pt.label)}"
              data-tip-sub="${escapeHtml(colName)}: ${escapeHtml(formatDisplayNumber(yv, colType))}"
              class="cursor-pointer"
            />
            ${scatterPoints.length <= 18 || isSel ? `<text x="${cx}" y="${cy - 10}" text-anchor="middle" class="fill-slate-600 text-[10px] pointer-events-none">${escapeHtml(truncateLabel(pt.label, 10))}</text>` : ''}
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

  public dispose(): void {
    this.abortController.abort();
    this.activeTooltipTarget = null;
    this.tooltipEl?.classList.add('hidden');
    this.builder?.dispose();
  }
}
