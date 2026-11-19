import type {
  ChartAggregationMode,
  ChartSortOrder,
  ChartType,
  ColumnType,
  DatasetProfile,
  SemanticType,
  SheetData,
} from '../types';
import {CHART_PALETTE, columnIndexToLetter, suggestChartConfig} from '../core/tabular';
import {svgIcon} from './icons';

export const EXTENDED_CHART_PALETTE = [
  ...CHART_PALETTE,
  '#0284c7', // Sky
  '#9333ea', // Purple
  '#db2777', // Pink
  '#65a30d', // Lime
  '#ea580c', // Orange
  '#475569', // Slate
] as const;

export const SERIES_SHAPE_MARKERS = ['●', '■', '▲', '◆', '✦', '✚'] as const;

export const MAX_RECOMMENDED_CHART_SERIES = 8;

export type SeriesPreset =
  | 'first5'
  | 'first10'
  | 'allNumeric'
  | 'recommended'
  | 'clear';

export interface SeriesEligibility {
  colIndex: number;
  name: string;
  letter: string;
  baseType: ColumnType;
  semanticType: SemanticType;
  eligible: boolean;
  reason: string | null;
  isXAxis: boolean;
}

export interface SecondaryControlVisibility {
  showAggregation: boolean;
  showSort: boolean;
  showLimit: boolean;
}

export function getSeriesColor(sourceColIndex: number): string {
  const safe = Math.max(0, sourceColIndex);
  return EXTENDED_CHART_PALETTE[safe % EXTENDED_CHART_PALETTE.length];
}

export function getSeriesMarker(sourceColIndex: number): string {
  const safe = Math.max(0, sourceColIndex);
  return SERIES_SHAPE_MARKERS[safe % SERIES_SHAPE_MARKERS.length];
}

export function getSecondaryControlsForChartType(
  chartType: ChartType
): SecondaryControlVisibility {
  switch (chartType) {
    case 'bar':
      return {showAggregation: true, showSort: true, showLimit: true};
    case 'line':
      return {showAggregation: true, showSort: false, showLimit: true};
    case 'pie':
      return {showAggregation: true, showSort: true, showLimit: false};
    case 'scatter':
      return {showAggregation: false, showSort: false, showLimit: true};
    default:
      return {showAggregation: true, showSort: true, showLimit: true};
  }
}

export function evaluateSeriesEligibility(
  sheet: SheetData,
  profile: DatasetProfile | null,
  colIdx: number,
  xColIndex: number
): SeriesEligibility {
  const name = sheet.columns[colIdx] ?? `Column ${colIdx + 1}`;
  const letter = columnIndexToLetter(colIdx);
  const baseType: ColumnType = sheet.types[colIdx] ?? 'text';
  const profCol = profile?.columns[colIdx];
  const semanticType: SemanticType =
    profCol?.roleOverride ??
    profCol?.semanticType ??
    (baseType === 'number' || baseType === 'percent' ? 'quantitative' : 'text');
  const isXAxis = colIdx === xColIndex;

  if (semanticType === 'identifier') {
    return {
      colIndex: colIdx,
      name,
      letter,
      baseType,
      semanticType,
      eligible: false,
      reason: 'Identifier column (non-metric)',
      isXAxis,
    };
  }

  if (semanticType === 'temporal') {
    return {
      colIndex: colIdx,
      name,
      letter,
      baseType,
      semanticType,
      eligible: false,
      reason: 'Temporal / date column',
      isXAxis,
    };
  }

  const isQuantOrBool =
    semanticType === 'quantitative' ||
    semanticType === 'boolean' ||
    baseType === 'number' ||
    baseType === 'percent';

  if (!isQuantOrBool) {
    return {
      colIndex: colIdx,
      name,
      letter,
      baseType,
      semanticType,
      eligible: false,
      reason: 'Text / categorical column',
      isXAxis,
    };
  }

  return {
    colIndex: colIdx,
    name,
    letter,
    baseType,
    semanticType,
    eligible: true,
    reason: isXAxis ? 'Also used as X Axis' : null,
    isXAxis,
  };
}

export function getAllSeriesEligibilities(
  sheet: SheetData,
  profile: DatasetProfile | null,
  xColIndex: number
): SeriesEligibility[] {
  const result = new Array<SeriesEligibility>(sheet.columns.length);
  for (let i = 0; i < sheet.columns.length; i++) {
    result[i] = evaluateSeriesEligibility(sheet, profile, i, xColIndex);
  }
  return result;
}

export function applySeriesPreset(
  preset: SeriesPreset,
  sheet: SheetData,
  profile: DatasetProfile | null,
  xColIndex: number
): number[] {
  if (preset === 'clear') return [];

  const eligibilities = getAllSeriesEligibilities(sheet, profile, xColIndex);
  const eligibleNonX = eligibilities
    .filter((item) => item.eligible && !item.isXAxis)
    .map((item) => item.colIndex);
  const fallbackAllEligible = eligibilities
    .filter((item) => item.eligible)
    .map((item) => item.colIndex);
  const pool = eligibleNonX.length > 0 ? eligibleNonX : fallbackAllEligible;

  if (preset === 'first5') {
    return pool.slice(0, 5);
  }
  if (preset === 'first10') {
    return pool.slice(0, 10);
  }
  if (preset === 'allNumeric') {
    return pool;
  }

  // 'recommended'
  const quantNonId = eligibilities
    .filter(
      (item) =>
        item.eligible &&
        !item.isXAxis &&
        (item.semanticType === 'quantitative' ||
          item.baseType === 'number' ||
          item.baseType === 'percent')
    )
    .map((item) => item.colIndex);

  if (quantNonId.length > 0) {
    return quantNonId.slice(0, 2);
  }
  const suggested = suggestChartConfig(sheet).yColIndices.filter((c) =>
    eligibilities[c]?.eligible
  );
  if (suggested.length > 0) return suggested;
  return pool.slice(0, 2);
}

export function filterSeriesEligibilities(
  items: SeriesEligibility[],
  selectedSet: ReadonlySet<number>,
  searchQuery: string,
  selectedOnly: boolean
): SeriesEligibility[] {
  const q = searchQuery.trim().toLowerCase();
  return items.filter((item) => {
    if (selectedOnly && !selectedSet.has(item.colIndex)) {
      return false;
    }
    if (!q) return true;
    return (
      item.name.toLowerCase().includes(q) ||
      item.letter.toLowerCase().includes(q)
    );
  });
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface ChartSeriesManagerCallbacks {
  onChangeSeries: (nextYColIndices: number[]) => void;
}

export interface ChartSeriesSummary {
  chartType: ChartType;
  aggregation: ChartAggregationMode;
  sortOrder: ChartSortOrder;
  maxPoints: number;
}

export class ChartSeriesManager {
  private anchorHost: HTMLElement;
  private triggerBtn: HTMLButtonElement;
  private popoverEl: HTMLElement;
  private callbacks: ChartSeriesManagerCallbacks;

  private isOpen = false;
  private searchQuery = '';
  private selectedOnly = false;

  private sheet: SheetData | null = null;
  private profile: DatasetProfile | null = null;
  private xColIndex = 0;
  private yColIndices: number[] = [];
  private chartType: ChartType = 'bar';

  private readonly abortController = new AbortController();
  private readonly onDocMouseDownBound = (e: MouseEvent) => this.handleDocClick(e);
  private readonly onDocKeyDownBound = (e: KeyboardEvent) => this.handleDocKey(e);

  constructor(anchorHost: HTMLElement, callbacks: ChartSeriesManagerCallbacks) {
    this.anchorHost = anchorHost;
    this.callbacks = callbacks;
    this.anchorHost.classList.add('relative');

    this.anchorHost.innerHTML = `
      <button
        type="button"
        data-role="series-manager-trigger"
        aria-expanded="false"
        aria-haspopup="dialog"
        class="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
      >
        ${svgIcon('sliders', 'w-3.5 h-3.5 text-blue-600')}
        <span data-role="series-manager-label">Series (0)</span>
        ${svgIcon('chevronDown', 'w-3 h-3 text-slate-400')}
      </button>
      <div
        data-role="series-manager-popover"
        role="dialog"
        aria-label="Chart Series Manager"
        class="hidden absolute right-0 top-full mt-1.5 z-40 w-[336px] sm:w-[372px] max-w-[calc(100vw-2rem)] bg-white border border-slate-200 rounded-xl shadow-xl overflow-hidden flex-col"
      ></div>
    `;

    this.triggerBtn = this.anchorHost.querySelector(
      '[data-role="series-manager-trigger"]'
    )!;
    this.popoverEl = this.anchorHost.querySelector(
      '[data-role="series-manager-popover"]'
    )!;

    const {signal} = this.abortController;
    this.triggerBtn.addEventListener(
      'click',
      (e) => {
        e.stopPropagation();
        this.toggle();
      },
      {signal}
    );

    this.bindPopoverEvents();
    document.addEventListener('mousedown', this.onDocMouseDownBound, {signal});
    document.addEventListener('keydown', this.onDocKeyDownBound, {signal});
  }

  public update(params: {
    sheet: SheetData;
    profile: DatasetProfile | null;
    xColIndex: number;
    yColIndices: number[];
    chartType: ChartType;
  }): void {
    this.sheet = params.sheet;
    this.profile = params.profile;
    this.xColIndex = params.xColIndex;
    this.yColIndices = params.yColIndices;
    this.chartType = params.chartType;

    this.syncTriggerLabel();
    if (this.isOpen) {
      this.renderPopoverBody();
    }
  }

  public open(): void {
    this.toggle(true);
  }

  public toggle(forceOpen?: boolean): void {
    const next = forceOpen ?? !this.isOpen;
    if (next === this.isOpen) return;
    this.isOpen = next;
    this.triggerBtn.setAttribute('aria-expanded', String(this.isOpen));
    this.popoverEl.classList.toggle('hidden', !this.isOpen);
    this.popoverEl.classList.toggle('flex', this.isOpen);

    if (this.isOpen) {
      this.renderPopoverBody();
      const input = this.popoverEl.querySelector<HTMLInputElement>(
        '[data-role="series-search"]'
      );
      input?.focus();
    }
  }

  private syncTriggerLabel(): void {
    const labelEl = this.triggerBtn.querySelector(
      '[data-role="series-manager-label"]'
    );
    if (!labelEl) return;
    const count = this.yColIndices.length;
    labelEl.textContent = `Series (${count})`;

    const warn = count > MAX_RECOMMENDED_CHART_SERIES || count === 0;
    this.triggerBtn.classList.toggle('border-amber-300', count > MAX_RECOMMENDED_CHART_SERIES);
    this.triggerBtn.classList.toggle('bg-amber-50/60', count > MAX_RECOMMENDED_CHART_SERIES);
    this.triggerBtn.classList.toggle('border-slate-200', !warn);
  }

  private renderPopoverBody(): void {
    if (!this.sheet) return;
    const sheet = this.sheet;
    const selectedSet = new Set(this.yColIndices);
    const items = getAllSeriesEligibilities(sheet, this.profile, this.xColIndex);
    const eligibleCount = items.filter((it) => it.eligible).length;
    const filtered = filterSeriesEligibilities(
      items,
      selectedSet,
      this.searchQuery,
      this.selectedOnly
    );

    const singleSeriesMode =
      this.chartType === 'pie' || this.chartType === 'scatter';
    const clarityNotice =
      this.yColIndices.length > MAX_RECOMMENDED_CHART_SERIES
        ? `<div class="px-3 py-1.5 bg-amber-50 border-b border-amber-200 text-[11px] text-amber-800">
            ${this.yColIndices.length} series selected. Showing more than ${MAX_RECOMMENDED_CHART_SERIES} series at once can reduce chart readability.
          </div>`
        : singleSeriesMode && this.yColIndices.length > 1
          ? `<div class="px-3 py-1.5 bg-blue-50 border-b border-blue-100 text-[11px] text-blue-800">
              ${this.chartType === 'pie' ? 'Pie' : 'Scatter'} charts plot your first selected series (${escapeHtml(sheet.columns[this.yColIndices[0]] ?? '')}); other checked series remain saved.
            </div>`
          : '';

    const hasShell = Boolean(
      this.popoverEl.querySelector('[data-role="series-search"]')
    );
    const prevListEl = this.popoverEl.querySelector<HTMLElement>(
      '[data-role="series-list"]'
    );
    const prevScrollTop = prevListEl?.scrollTop ?? 0;

    if (!hasShell) {
      this.popoverEl.innerHTML = `
        <div class="px-3 py-2.5 border-b border-slate-200 bg-slate-50/80 flex items-center justify-between gap-2">
          <div>
            <div class="text-xs font-semibold text-slate-900">Series Manager</div>
            <div data-role="series-count-meta" class="text-[11px] text-slate-500"></div>
          </div>
          <label class="inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-700 cursor-pointer select-none">
            <input
              type="checkbox"
              data-role="series-selected-only"
              ${this.selectedOnly ? 'checked' : ''}
              class="rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
            />
            <span>Selected only</span>
          </label>
        </div>

        <div data-role="series-clarity-slot"></div>

        <div class="px-2.5 py-2 border-b border-slate-100 flex flex-wrap items-center gap-1 bg-slate-50/40">
          <button type="button" data-series-preset="recommended" class="px-2 py-0.5 text-[11px] font-medium rounded border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 cursor-pointer">Recommended</button>
          <button type="button" data-series-preset="first5" class="px-2 py-0.5 text-[11px] font-medium rounded border border-slate-200 bg-white text-slate-700 hover:bg-slate-100 cursor-pointer">First 5</button>
          <button type="button" data-series-preset="first10" class="px-2 py-0.5 text-[11px] font-medium rounded border border-slate-200 bg-white text-slate-700 hover:bg-slate-100 cursor-pointer">First 10</button>
          <button type="button" data-series-preset="allNumeric" class="px-2 py-0.5 text-[11px] font-medium rounded border border-slate-200 bg-white text-slate-700 hover:bg-slate-100 cursor-pointer">All Numeric</button>
          <button type="button" data-series-preset="clear" class="ml-auto px-2 py-0.5 text-[11px] font-medium rounded text-rose-600 hover:bg-rose-50 cursor-pointer">Clear</button>
        </div>

        <div class="p-2 border-b border-slate-100">
          <div class="relative">
            <span class="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none">
              ${svgIcon('search', 'w-3.5 h-3.5')}
            </span>
            <input
              type="search"
              data-role="series-search"
              aria-label="Search chart series"
              placeholder="Search series..."
              value="${escapeHtml(this.searchQuery)}"
              class="w-full pl-8 pr-2.5 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:bg-white focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
            />
          </div>
        </div>

        <div data-role="series-list" class="max-h-64 overflow-y-auto sheet-scroll p-2 space-y-1"></div>
      `;
    }

    const metaEl = this.popoverEl.querySelector('[data-role="series-count-meta"]');
    if (metaEl) {
      metaEl.textContent = `${this.yColIndices.length} selected · ${eligibleCount} numeric eligible`;
    }

    const claritySlot = this.popoverEl.querySelector(
      '[data-role="series-clarity-slot"]'
    );
    if (claritySlot) {
      claritySlot.innerHTML = clarityNotice;
    }

    const selOnlyCb = this.popoverEl.querySelector<HTMLInputElement>(
      '[data-role="series-selected-only"]'
    );
    if (selOnlyCb) {
      selOnlyCb.checked = this.selectedOnly;
    }

    const listEl = this.popoverEl.querySelector<HTMLElement>(
      '[data-role="series-list"]'
    );
    if (!listEl) return;

    if (filtered.length === 0) {
      listEl.innerHTML = `<div class="py-6 text-center text-xs text-slate-400">${
        this.selectedOnly && this.yColIndices.length === 0
          ? 'No series currently selected.'
          : 'No matching columns found.'
      }</div>`;
      return;
    }

    listEl.innerHTML = filtered
      .map((item) => {
        const checked = selectedSet.has(item.colIndex);
        const color = getSeriesColor(item.colIndex);
        const marker = getSeriesMarker(item.colIndex);
        const disabled = !item.eligible;
        const badgeText = item.isXAxis
          ? 'X Axis'
          : item.eligible
            ? item.semanticType === 'boolean'
              ? 'Bool'
              : item.baseType === 'percent'
                ? '%'
                : 'Num'
            : item.semanticType === 'identifier'
              ? 'ID'
              : item.semanticType === 'temporal'
                ? 'Time'
                : 'Text';

        return `
          <label
            title="${escapeHtml(item.name)}${item.reason ? ` — ${escapeHtml(item.reason)}` : ''}"
            class="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg border ${
              disabled
                ? 'border-transparent opacity-50 bg-slate-50/50 cursor-not-allowed'
                : checked
                  ? 'border-blue-200 bg-blue-50/60 cursor-pointer'
                  : 'border-transparent hover:bg-slate-50 cursor-pointer'
            }"
          >
            <div class="flex items-center gap-2 min-w-0 flex-1">
              <input
                type="checkbox"
                data-series-col="${item.colIndex}"
                ${checked ? 'checked' : ''}
                ${disabled ? 'disabled' : ''}
                class="rounded border-slate-300 text-blue-600 focus:ring-blue-500 shrink-0"
              />
              <span
                class="text-[11px] font-bold leading-none shrink-0"
                style="color:${disabled ? '#94a3b8' : color}"
                aria-hidden="true"
              >${marker}</span>
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-1.5 min-w-0">
                  <span class="font-mono-tabular text-[10px] text-slate-400 shrink-0">${item.letter}</span>
                  <span class="text-xs font-medium text-slate-800 truncate">${escapeHtml(item.name)}</span>
                </div>
                ${
                  item.reason
                    ? `<div class="text-[10px] text-slate-400 truncate">${escapeHtml(item.reason)}</div>`
                    : ''
                }
              </div>
            </div>
            <span class="text-[10px] font-mono-tabular px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 shrink-0">${badgeText}</span>
          </label>
        `;
      })
      .join('');

    listEl.scrollTop = prevScrollTop;
  }

  private bindPopoverEvents(): void {
    const {signal} = this.abortController;
    this.popoverEl.addEventListener(
      'input',
      (e) => {
        const target = e.target as HTMLElement | null;
        if (
          target instanceof HTMLInputElement &&
          target.dataset.role === 'series-search'
        ) {
          this.searchQuery = target.value;
          this.renderPopoverBody();
        }
      },
      {signal}
    );

    this.popoverEl.addEventListener(
      'change',
      (e) => {
        const target = e.target as HTMLElement | null;
        if (!(target instanceof HTMLInputElement)) return;

        if (target.dataset.role === 'series-selected-only') {
          this.selectedOnly = target.checked;
          this.renderPopoverBody();
          return;
        }

        if (target.dataset.seriesCol !== undefined) {
          const colIdx = Number(target.dataset.seriesCol);
          const exists = this.yColIndices.includes(colIdx);
          let nextY: number[];
          if (target.checked && !exists) {
            nextY = [...this.yColIndices, colIdx];
          } else if (!target.checked && exists) {
            nextY = this.yColIndices.filter((c) => c !== colIdx);
          } else {
            return;
          }
          this.yColIndices = nextY;
          this.callbacks.onChangeSeries(nextY);
          this.syncTriggerLabel();
          this.renderPopoverBody();
        }
      },
      {signal}
    );

    this.popoverEl.addEventListener(
      'click',
      (e) => {
        e.stopPropagation();
        const target = e.target as HTMLElement | null;
        const presetBtn = target?.closest<HTMLButtonElement>('[data-series-preset]');
        if (presetBtn && this.sheet) {
          const preset = presetBtn.dataset.seriesPreset as SeriesPreset;
          const nextY = applySeriesPreset(
            preset,
            this.sheet,
            this.profile,
            this.xColIndex
          );
          this.yColIndices = nextY;
          this.callbacks.onChangeSeries(nextY);
          this.syncTriggerLabel();
          this.renderPopoverBody();
        }
      },
      {signal}
    );
  }

  private handleDocClick(e: MouseEvent): void {
    if (!this.isOpen) return;
    const target = e.target as Node | null;
    if (target && !this.anchorHost.contains(target)) {
      this.toggle(false);
    }
  }

  private handleDocKey(e: KeyboardEvent): void {
    if (this.isOpen && e.key === 'Escape') {
      e.preventDefault();
      this.toggle(false);
      this.triggerBtn.focus();
    }
  }

  public dispose(): void {
    this.toggle(false);
    this.abortController.abort();
  }
}
