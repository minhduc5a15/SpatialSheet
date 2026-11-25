import type {
  CatalogFilterState,
  CatalogSortBy,
  ColumnCatalogEntry,
  ColumnDetailSummary,
  QualityObservation,
  SemanticType,
  SuggestedAnalysisItem,
  WorkspaceLayout,
} from '../types';
import {
  analyzeDatasetOverview,
  filterAndSortColumnCatalog,
  formatMetricPreview,
  getValidatedSuggestedAnalyses,
} from '../core/dataQuality';
import type {AppStore} from '../core/store';
import {formatDisplayNumber} from '../core/tabular';
import {evaluateSeriesEligibility} from './ChartSeriesManager';
import {svgIcon} from './icons';

const ROLE_ORDER: SemanticType[] = [
  'quantitative',
  'categorical',
  'temporal',
  'boolean',
  'identifier',
  'text',
];

const ROLE_META: Record<
  SemanticType,
  {label: string; shortLabel: string; barClass: string; badgeClass: string; dotClass: string}
> = {
  quantitative: {
    label: 'Quantitative',
    shortLabel: 'Quant',
    barClass: 'bg-blue-500',
    badgeClass: 'bg-blue-50 text-blue-700 border-blue-200',
    dotClass: 'bg-blue-500',
  },
  categorical: {
    label: 'Categorical',
    shortLabel: 'Category',
    barClass: 'bg-emerald-500',
    badgeClass: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    dotClass: 'bg-emerald-500',
  },
  temporal: {
    label: 'Temporal',
    shortLabel: 'Time',
    barClass: 'bg-amber-500',
    badgeClass: 'bg-amber-50 text-amber-800 border-amber-200',
    dotClass: 'bg-amber-500',
  },
  boolean: {
    label: 'Boolean',
    shortLabel: 'Bool',
    barClass: 'bg-violet-500',
    badgeClass: 'bg-violet-50 text-violet-700 border-violet-200',
    dotClass: 'bg-violet-500',
  },
  identifier: {
    label: 'Identifier',
    shortLabel: 'ID',
    barClass: 'bg-slate-500',
    badgeClass: 'bg-slate-100 text-slate-700 border-slate-300',
    dotClass: 'bg-slate-500',
  },
  text: {
    label: 'Text',
    shortLabel: 'Text',
    barClass: 'bg-rose-400',
    badgeClass: 'bg-rose-50 text-rose-700 border-rose-200',
    dotClass: 'bg-rose-400',
  },
};

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface DatasetOverviewCallbacks {
  onNavigateLayout: (layout: WorkspaceLayout) => void;
  onFocusTableCell: (
    colIndex: number,
    rowIndex?: number,
    targetLayout?: WorkspaceLayout
  ) => void;
  onOpenSuggested: (item: SuggestedAnalysisItem, targetLayout?: WorkspaceLayout) => void;
}

export class DatasetOverview {
  private host: HTMLElement;
  private store: AppStore;
  private callbacks: DatasetOverviewCallbacks;
  private readonly abortController = new AbortController();
  private filter: CatalogFilterState = {
    search: '',
    role: 'all',
    issuesOnly: false,
    sortBy: 'source',
  };
  private selectedColIndex = 0;
  private lastSheetId = '';
  private seriesFeedback: string | null = null;
  private currentSuggestions: SuggestedAnalysisItem[] = [];
  private disposed = false;

  private headerEl!: HTMLElement;
  private summaryEl!: HTMLElement;
  private roleDistEl!: HTMLElement;
  private catalogMetaEl!: HTMLElement;
  private catalogListEl!: HTMLElement;
  private detailEl!: HTMLElement;
  private qualityEl!: HTMLElement;
  private suggestionsEl!: HTMLElement;
  private searchInputEl!: HTMLInputElement;
  private roleSelectEl!: HTMLSelectElement;
  private issuesOnlyEl!: HTMLInputElement;
  private sortSelectEl!: HTMLSelectElement;

  constructor(
    host: HTMLElement,
    store: AppStore,
    callbacks: DatasetOverviewCallbacks
  ) {
    this.host = host;
    this.store = store;
    this.callbacks = callbacks;
    this.renderShell();
    this.bindEvents();
    this.update();
  }

  private renderShell(): void {
    this.host.innerHTML = `
      <div class="max-w-7xl mx-auto w-full flex flex-col gap-4 pb-6" data-role="overview-container">
        <!-- Dataset Header + Quick Entry CTAs -->
        <section data-role="overview-header" class="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 shadow-xs"></section>

        <!-- Summary KPIs -->
        <section data-role="overview-summary" class="grid grid-cols-2 lg:grid-cols-4 gap-3" aria-label="Dataset summary metrics"></section>

        <!-- Semantic Type Breakdown -->
        <section data-role="overview-role-breakdown" class="bg-white border border-slate-200 rounded-xl p-4 shadow-xs" aria-label="Semantic column distribution"></section>

        <!-- Column Intelligence: Catalog + Detail -->
        <section class="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start" aria-label="Column intelligence">
          <div class="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-4 shadow-xs flex flex-col gap-3 min-w-0">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 class="text-sm font-semibold text-slate-900">Column Catalog</h2>
                <p data-role="catalog-meta" class="text-xs text-slate-500"></p>
              </div>
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-12 gap-2 items-center">
              <div class="relative sm:col-span-4">
                <span class="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none">
                  ${svgIcon('search', 'w-3.5 h-3.5')}
                </span>
                <input
                  type="search"
                  data-overview-filter="search"
                  aria-label="Search columns"
                  placeholder="Search column name or letter..."
                  class="w-full pl-8 pr-2.5 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:bg-white focus:ring-2 focus:ring-blue-500/30"
                />
              </div>
              <select
                data-overview-filter="role"
                aria-label="Filter by semantic role"
                class="sm:col-span-3 px-2.5 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
              >
                <option value="all">All roles</option>
                ${ROLE_ORDER.map((r) => `<option value="${r}">${ROLE_META[r].label}</option>`).join('')}
              </select>
              <select
                data-overview-filter="sort"
                aria-label="Sort columns"
                class="sm:col-span-3 px-2.5 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
              >
                <option value="source">Source order</option>
                <option value="name">Name (A–Z)</option>
                <option value="missing">Missing count</option>
                <option value="role">Semantic role</option>
                <option value="cardinality">Cardinality</option>
              </select>
              <label class="sm:col-span-2 inline-flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer select-none whitespace-nowrap">
                <input type="checkbox" data-overview-filter="issues" class="rounded border-slate-300 text-blue-600 focus:ring-blue-500" />
                <span>Issues only</span>
              </label>
            </div>

            <div data-role="overview-catalog-list" class="flex flex-col gap-1.5 max-h-[420px] overflow-y-auto sheet-scroll pr-0.5"></div>
          </div>

          <aside data-role="overview-column-detail" class="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-4 shadow-xs min-w-0" aria-label="Selected column detail"></aside>
        </section>

        <!-- Data Quality & Suggested Analyses -->
        <section class="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
          <div data-role="overview-quality" class="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-4 shadow-xs min-w-0" aria-label="Data quality observations"></div>
          <div data-role="overview-suggestions" class="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-4 shadow-xs min-w-0" aria-label="Suggested analyses"></div>
        </section>
      </div>
    `;

    this.headerEl = this.host.querySelector('[data-role="overview-header"]')!;
    this.summaryEl = this.host.querySelector('[data-role="overview-summary"]')!;
    this.roleDistEl = this.host.querySelector('[data-role="overview-role-breakdown"]')!;
    this.catalogMetaEl = this.host.querySelector('[data-role="catalog-meta"]')!;
    this.catalogListEl = this.host.querySelector('[data-role="overview-catalog-list"]')!;
    this.detailEl = this.host.querySelector('[data-role="overview-column-detail"]')!;
    this.qualityEl = this.host.querySelector('[data-role="overview-quality"]')!;
    this.suggestionsEl = this.host.querySelector('[data-role="overview-suggestions"]')!;

    this.searchInputEl = this.host.querySelector('[data-overview-filter="search"]')!;
    this.roleSelectEl = this.host.querySelector('[data-overview-filter="role"]')!;
    this.issuesOnlyEl = this.host.querySelector('[data-overview-filter="issues"]')!;
    this.sortSelectEl = this.host.querySelector('[data-overview-filter="sort"]')!;
  }

  private bindEvents(): void {
    const {signal} = this.abortController;

    this.searchInputEl.addEventListener(
      'input',
      () => {
        this.filter.search = this.searchInputEl.value;
        this.seriesFeedback = null;
        this.update();
      },
      {signal}
    );

    this.roleSelectEl.addEventListener(
      'change',
      () => {
        this.filter.role = this.roleSelectEl.value as SemanticType | 'all';
        this.update();
      },
      {signal}
    );

    this.sortSelectEl.addEventListener(
      'change',
      () => {
        this.filter.sortBy = this.sortSelectEl.value as CatalogSortBy;
        this.update();
      },
      {signal}
    );

    this.issuesOnlyEl.addEventListener(
      'change',
      () => {
        this.filter.issuesOnly = this.issuesOnlyEl.checked;
        this.update();
      },
      {signal}
    );

    this.host.addEventListener(
      'change',
      (e) => {
        const target = e.target as HTMLElement | null;
        if (target instanceof HTMLSelectElement && target.dataset.overviewRoleOverride !== undefined) {
          const colIndex = Number(target.dataset.overviewRoleOverride);
          const nextRole = target.value === 'auto' ? null : (target.value as SemanticType);
          this.seriesFeedback = null;
          this.store.overrideColumnRole(colIndex, nextRole);
        }
      },
      {signal}
    );

    this.host.addEventListener(
      'click',
      (e) => {
        const btn = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>('button');
        if (!btn) return;

        if (btn.dataset.overviewLayout) {
          this.callbacks.onNavigateLayout(btn.dataset.overviewLayout as WorkspaceLayout);
          return;
        }

        if (btn.dataset.roleChip) {
          const role = btn.dataset.roleChip as SemanticType | 'all';
          this.filter.role =
            role !== 'all' && this.filter.role === role ? 'all' : role;
          this.roleSelectEl.value = this.filter.role;
          this.update();
          return;
        }

        if (btn.dataset.overviewClearFilters !== undefined) {
          this.filter = {search: '', role: 'all', issuesOnly: false, sortBy: 'source'};
          this.searchInputEl.value = '';
          this.roleSelectEl.value = 'all';
          this.issuesOnlyEl.checked = false;
          this.sortSelectEl.value = 'source';
          this.update();
          return;
        }

        if (btn.dataset.overviewSelectCol !== undefined) {
          this.selectedColIndex = Number(btn.dataset.overviewSelectCol);
          this.seriesFeedback = null;
          this.update();
          return;
        }

        if (btn.dataset.overviewFocusCol !== undefined) {
          const colIndex = Number(btn.dataset.overviewFocusCol);
          const rowAttr = btn.dataset.overviewFocusRow;
          const rowIndex = rowAttr !== undefined ? Number(rowAttr) : undefined;
          const layout = (btn.dataset.overviewTargetLayout as WorkspaceLayout | undefined) ?? 'split';
          this.callbacks.onFocusTableCell(colIndex, rowIndex, layout);
          return;
        }

        if (btn.dataset.overviewUseX !== undefined) {
          const colIndex = Number(btn.dataset.overviewUseX);
          this.store.useColumnAsChartX(colIndex, 'charts');
          return;
        }

        if (btn.dataset.overviewUseY !== undefined) {
          const colIndex = Number(btn.dataset.overviewUseY);
          const res = this.store.addColumnAsChartY(colIndex, 'charts');
          if (!res.applied) {
            this.seriesFeedback = res.reason ?? 'Column cannot be used as a metric series.';
            this.update();
          }
          return;
        }

        if (btn.dataset.dismissQuality) {
          this.store.dismissQualityObservation(btn.dataset.dismissQuality);
          return;
        }

        if (btn.dataset.restoreQuality !== undefined) {
          this.store.restoreQualityObservations();
          return;
        }

        if (btn.dataset.applySuggestedId) {
          const id = btn.dataset.applySuggestedId;
          const item = this.currentSuggestions.find((s) => s.recommendation.id === id);
          if (item) {
            const layout = btn.dataset.applySuggestedLayout as WorkspaceLayout | undefined;
            this.callbacks.onOpenSuggested(item, layout);
          }
        }
      },
      {signal}
    );
  }

  public update(): void {
    if (this.disposed) return;

    const wb = this.store.workbook;
    const sheet = this.store.activeSheet;
    if (this.lastSheetId !== sheet.id) {
      this.lastSheetId = sheet.id;
      this.selectedColIndex = 0;
      this.seriesFeedback = null;
    }
    if (this.selectedColIndex < 0 || this.selectedColIndex >= sheet.columns.length) {
      this.selectedColIndex = 0;
    }

    const dismissedIds = this.store.getDismissedQualityIds(sheet.id);
    const analysis = analyzeDatasetOverview(
      wb,
      sheet,
      this.store.visibleRowIndices,
      this.store.datasetProfile,
      this.store.activeColumnView,
      dismissedIds
    );

    this.currentSuggestions = getValidatedSuggestedAnalyses(
      sheet,
      this.store.visibleRowIndices,
      this.store.datasetProfile,
      this.store.chartConfig,
      this.store.spatialConfig
    );

    this.renderHeader(analysis.summary);
    this.renderSummaryCards(analysis.summary);
    this.renderRoleBreakdown(analysis.summary);

    const filteredCatalog = filterAndSortColumnCatalog(analysis.catalog, this.filter);
    this.catalogMetaEl.textContent = `${filteredCatalog.length} of ${analysis.catalog.length} columns · Source indices preserved`;
    this.renderCatalogList(filteredCatalog, analysis.detailsByCol);

    const selectedDetail = analysis.detailsByCol.get(this.selectedColIndex) ?? null;
    const selectedCatalogEntry = analysis.catalog[this.selectedColIndex] ?? null;
    this.renderColumnDetail(selectedDetail, selectedCatalogEntry);

    this.renderQualityDashboard(analysis.observations, dismissedIds);
    this.renderSuggestions(this.currentSuggestions);
  }

  private renderHeader(summary: ReturnType<typeof analyzeDatasetOverview>['summary']): void {
    const formatLabel = summary.fileFormat.toUpperCase();
    const sourceBadge = summary.sourceFileName
      ? `<span class="text-xs text-slate-500">Source: <strong class="font-semibold text-slate-800">${esc(summary.sourceFileName)}</strong></span>`
      : '';
    this.headerEl.innerHTML = `
      <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <span class="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 uppercase tracking-wide">${esc(formatLabel)}</span>
            ${sourceBadge}
            <span class="text-xs text-slate-500">Sheet: <strong class="font-semibold text-slate-800">${esc(summary.sheetName)}</strong></span>
            ${
              summary.isFiltered
                ? `<span class="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium bg-blue-50 text-blue-700 border border-blue-200">Filtered view: ${summary.visibleRows.toLocaleString('en-US')} / ${summary.totalRows.toLocaleString('en-US')} rows</span>`
                : ''
            }
          </div>
          <h1 data-role="overview-workbook-name" class="mt-1.5 text-lg sm:text-xl font-bold text-slate-900 truncate" title="${esc(summary.workbookName)}">${esc(summary.workbookName)}</h1>
          <p class="text-xs text-slate-500 mt-0.5">Dataset overview, semantic profiling, quality observations, and validated starting views for the active sheet.</p>
        </div>

        <div class="flex flex-wrap items-center gap-2 shrink-0">
          <button type="button" data-overview-layout="split" class="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors cursor-pointer">
            ${svgIcon('split', 'w-3.5 h-3.5')}
            <span>Explore in Split</span>
          </button>
          <button type="button" data-overview-layout="table" class="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200/80 rounded-lg transition-colors cursor-pointer">
            ${svgIcon('table', 'w-3.5 h-3.5')}
            <span>Open Table</span>
          </button>
          <button type="button" data-overview-layout="charts" class="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200/80 rounded-lg transition-colors cursor-pointer">
            ${svgIcon('barChart', 'w-3.5 h-3.5')}
            <span>Open Charts</span>
          </button>
          <button type="button" data-overview-layout="spatial" class="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200/80 rounded-lg transition-colors cursor-pointer">
            ${svgIcon('cube3d', 'w-3.5 h-3.5')}
            <span>Open 3D Stage</span>
          </button>
        </div>
      </div>
    `;
  }

  private renderSummaryCards(summary: ReturnType<typeof analyzeDatasetOverview>['summary']): void {
    const missingPct = (summary.missingRate * 100).toFixed(1);
    const activeRoleParts = ROLE_ORDER.filter((r) => summary.roleCounts[r] > 0)
      .slice(0, 3)
      .map((r) => `${summary.roleCounts[r]} ${ROLE_META[r].shortLabel}`);

    this.summaryEl.innerHTML = `
      <div class="bg-white border border-slate-200 rounded-xl p-3.5 shadow-xs">
        <div class="text-[11px] font-medium text-slate-500 uppercase tracking-wide">Rows (Active Sheet)</div>
        <div class="mt-1 text-2xl font-bold text-slate-900 font-mono-tabular">${summary.totalRows.toLocaleString('en-US')}</div>
        <div class="mt-0.5 text-xs text-slate-500">${
          summary.isFiltered
            ? `${summary.visibleRows.toLocaleString('en-US')} visible after search/sort filter`
            : `${summary.visibleRows.toLocaleString('en-US')} visible rows`
        }</div>
      </div>

      <div class="bg-white border border-slate-200 rounded-xl p-3.5 shadow-xs">
        <div class="text-[11px] font-medium text-slate-500 uppercase tracking-wide">Columns</div>
        <div class="mt-1 text-2xl font-bold text-slate-900 font-mono-tabular">${summary.totalCols}</div>
        <div class="mt-0.5 text-xs text-slate-500">${summary.visibleCols} visible · ${summary.hiddenCols} hidden${
          summary.pinnedCols > 0 ? ` · ${summary.pinnedCols} pinned` : ''
        }</div>
      </div>

      <div class="bg-white border border-slate-200 rounded-xl p-3.5 shadow-xs">
        <div class="text-[11px] font-medium text-slate-500 uppercase tracking-wide">Missing Cells</div>
        <div class="mt-1 text-2xl font-bold text-slate-900 font-mono-tabular">${summary.missingCells.toLocaleString('en-US')}</div>
        <div class="mt-0.5 text-xs text-slate-500">${missingPct}% of ${summary.totalCells.toLocaleString('en-US')} sheet cells</div>
      </div>

      <div class="bg-white border border-slate-200 rounded-xl p-3.5 shadow-xs">
        <div class="text-[11px] font-medium text-slate-500 uppercase tracking-wide">Semantic Roles</div>
        <div class="mt-1 text-lg font-bold text-slate-900">${activeRoleParts.length > 0 ? esc(activeRoleParts.join(' · ')) : '0 columns'}</div>
        <div class="mt-0.5 text-xs text-slate-500">${summary.roleCounts.quantitative} quant · ${summary.roleCounts.categorical} cat · ${summary.roleCounts.temporal} time · ${summary.roleCounts.identifier} ID</div>
      </div>
    `;
  }

  private renderRoleBreakdown(summary: ReturnType<typeof analyzeDatasetOverview>['summary']): void {
    const total = Math.max(1, summary.totalCols);
    const barSegments = ROLE_ORDER.filter((r) => summary.roleCounts[r] > 0)
      .map((r) => {
        const count = summary.roleCounts[r];
        const pct = ((count / total) * 100).toFixed(2);
        return `<div class="${ROLE_META[r].barClass} h-full" style="width:${pct}%" title="${ROLE_META[r].label}: ${count} column${count === 1 ? '' : 's'}"></div>`;
      })
      .join('');

    const legendButtons = `
      <button
        type="button"
        data-role-chip="all"
        aria-pressed="${this.filter.role === 'all'}"
        class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs border transition-colors cursor-pointer ${
          this.filter.role === 'all'
            ? 'bg-slate-900 text-white border-slate-900 font-semibold'
            : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
        }"
      >
        <span>All (${summary.totalCols})</span>
      </button>
      ${ROLE_ORDER.map((r) => {
        const count = summary.roleCounts[r];
        const active = this.filter.role === r;
        return `
          <button
            type="button"
            data-role-chip="${r}"
            aria-pressed="${active}"
            class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs border transition-colors cursor-pointer ${
              active
                ? 'bg-blue-50 text-blue-800 border-blue-300 font-semibold'
                : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
            }"
          >
            <span class="w-2 h-2 rounded-full ${ROLE_META[r].dotClass}" aria-hidden="true"></span>
            <span>${ROLE_META[r].label} (${count})</span>
          </button>
        `;
      }).join('')}
    `;

    this.roleDistEl.innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-2 mb-2.5">
        <h2 class="text-xs font-semibold text-slate-700 uppercase tracking-wide">Semantic Column Distribution</h2>
        <span class="text-xs text-slate-500">Click any role below to filter the column catalog</span>
      </div>
      <div class="w-full h-2.5 rounded-full bg-slate-100 overflow-hidden flex" role="img" aria-label="Column semantic type distribution bar">
        ${barSegments}
      </div>
      <div class="mt-3 flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter catalog by semantic role">
        ${legendButtons}
      </div>
    `;
  }

  private renderCatalogList(
    entries: ColumnCatalogEntry[],
    detailsByCol: Map<number, ColumnDetailSummary>
  ): void {
    if (entries.length === 0) {
      this.catalogListEl.innerHTML = `
        <div class="py-8 px-4 text-center border border-dashed border-slate-200 rounded-lg bg-slate-50/70">
          <p class="text-xs font-medium text-slate-700">No columns match your current search or filters.</p>
          <button type="button" data-overview-clear-filters class="mt-2 px-3 py-1 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-md cursor-pointer">
            Reset catalog filters
          </button>
        </div>
      `;
      return;
    }

    this.catalogListEl.innerHTML = entries
      .map((entry) => {
        const selected = entry.colIndex === this.selectedColIndex;
        const meta = ROLE_META[entry.semanticType];
        const detail = detailsByCol.get(entry.colIndex);
        const metricPreview = detail ? formatMetricPreview(detail) : '';
        const missingPct = (entry.missingRate * 100).toFixed(1);

        return `
          <div
            data-overview-col="${entry.colIndex}"
            class="flex items-center justify-between gap-2 p-2.5 rounded-lg border transition-colors ${
              selected
                ? 'border-blue-400 bg-blue-50/60'
                : 'border-slate-200 bg-white hover:bg-slate-50'
            }"
          >
            <button
              type="button"
              data-overview-select-col="${entry.colIndex}"
              aria-pressed="${selected}"
              aria-label="Inspect column ${esc(entry.name)}"
              class="flex-1 min-w-0 text-left cursor-pointer"
            >
              <div class="flex flex-wrap items-center gap-1.5">
                <span class="font-mono-tabular text-[11px] font-semibold px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">${entry.letter}</span>
                <span class="text-xs font-semibold text-slate-900 truncate max-w-[200px]">${esc(entry.name)}</span>
                <span class="text-[11px] px-1.5 py-0.5 rounded border ${meta.badgeClass}">${meta.shortLabel}</span>
                ${entry.roleOverride ? '<span class="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200">Override</span>' : ''}
                ${entry.isPinned ? '<span class="text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200">Pinned</span>' : ''}
                ${entry.isHidden ? '<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-300">Hidden</span>' : ''}
                ${entry.hasIssues ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200">${entry.issueCount} ${entry.issueCount === 1 ? 'note' : 'notes'}</span>` : ''}
              </div>
              <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-slate-500">
                <span>Missing: <strong class="font-medium text-slate-700">${entry.missingCount}</strong> (${missingPct}%)</span>
                <span>Unique: <strong class="font-medium text-slate-700">${entry.cardinality.toLocaleString('en-US')}</strong></span>
                ${metricPreview ? `<span class="truncate max-w-[260px]">${esc(metricPreview)}</span>` : ''}
              </div>
            </button>
            <button
              type="button"
              data-overview-focus-col="${entry.colIndex}"
              data-overview-target-layout="split"
              aria-label="Focus ${esc(entry.name)} in Table"
              class="px-2.5 py-1 text-[11px] font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md whitespace-nowrap shrink-0 cursor-pointer"
            >Focus</button>
          </div>
        `;
      })
      .join('');
  }

  private renderColumnDetail(
    detail: ColumnDetailSummary | null,
    entry: ColumnCatalogEntry | null
  ): void {
    if (!detail || !entry) {
      this.detailEl.innerHTML = `<p class="text-xs text-slate-500">Select a column from the catalog to inspect metrics and actions.</p>`;
      return;
    }

    const meta = ROLE_META[detail.semanticType];
    const xColIndex = this.store.chartConfig.xColIndex;
    const yEligibility = evaluateSeriesEligibility(
      this.store.activeSheet,
      this.store.datasetProfile,
      detail.colIndex,
      xColIndex
    );

    const roleOptions = ROLE_ORDER.map(
      (r) =>
        `<option value="${r}" ${detail.roleOverride === r ? 'selected' : ''}>${ROLE_META[r].label}</option>`
    ).join('');

    const statsBlock = this.renderDetailStatsBlock(detail);

    this.detailEl.innerHTML = `
      <div class="flex flex-col gap-3">
        <div class="flex items-start justify-between gap-2 pb-2.5 border-b border-slate-100">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-1.5">
              <span class="font-mono-tabular text-[11px] font-semibold px-1.5 py-0.5 rounded bg-slate-100 text-slate-700">${detail.letter} (col #${detail.colIndex + 1})</span>
              <span class="text-[11px] px-1.5 py-0.5 rounded border ${meta.badgeClass}">${meta.label}</span>
              ${detail.unit ? `<span class="text-[11px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 border border-slate-200">Unit: ${esc(detail.unit)}</span>` : ''}
            </div>
            <h2 class="mt-1.5 text-base font-bold text-slate-900 break-words">${esc(detail.name)}</h2>
          </div>
        </div>

        <!-- Core counts -->
        <dl class="grid grid-cols-3 gap-2 text-xs">
          <div class="bg-slate-50 rounded-lg p-2 border border-slate-100">
            <dt class="text-[11px] text-slate-500">Non-empty</dt>
            <dd class="font-semibold text-slate-900 font-mono-tabular mt-0.5">${detail.nonEmptyCount.toLocaleString('en-US')}</dd>
          </div>
          <div class="bg-slate-50 rounded-lg p-2 border border-slate-100">
            <dt class="text-[11px] text-slate-500">Missing</dt>
            <dd class="font-semibold text-slate-900 font-mono-tabular mt-0.5">${detail.missingCount.toLocaleString('en-US')} (${(detail.missingRate * 100).toFixed(1)}%)</dd>
          </div>
          <div class="bg-slate-50 rounded-lg p-2 border border-slate-100">
            <dt class="text-[11px] text-slate-500">Unique</dt>
            <dd class="font-semibold text-slate-900 font-mono-tabular mt-0.5">${detail.uniqueCount.toLocaleString('en-US')}</dd>
          </div>
        </dl>

        <!-- Role Override -->
        <div class="flex flex-wrap items-center justify-between gap-2 bg-slate-50 p-2.5 rounded-lg border border-slate-200/80">
          <label for="overview-role-override" class="text-xs font-medium text-slate-700">Role Override</label>
          <select
            id="overview-role-override"
            data-overview-role-override="${detail.colIndex}"
            aria-label="Role Override"
            class="max-w-full min-w-0 px-2 py-1 text-xs bg-white border border-slate-300 rounded-md text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
          >
            <option value="auto" ${detail.roleOverride === null ? 'selected' : ''}>Auto (${ROLE_META[detail.inferredSemanticType].label})</option>
            ${roleOptions}
          </select>
        </div>

        <!-- Role-specific Exact Statistics -->
        ${statsBlock}

        <!-- Direct Actions -->
        <div class="pt-2 border-t border-slate-100 flex flex-col gap-2">
          <div class="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-overview-focus-col="${detail.colIndex}"
              data-overview-target-layout="split"
              class="px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
            >${entry.isHidden ? 'Unhide & Focus in Table' : 'Focus in Table'}</button>
            <button
              type="button"
              data-overview-use-x="${detail.colIndex}"
              class="px-2.5 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg cursor-pointer"
            >Use as X Axis</button>
            <button
              type="button"
              data-overview-use-y="${detail.colIndex}"
              ${yEligibility.eligible ? '' : 'disabled'}
              class="px-2.5 py-1.5 text-xs font-medium rounded-lg border ${
                yEligibility.eligible
                  ? 'text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border-emerald-200 cursor-pointer'
                  : 'text-slate-400 bg-slate-50 border-slate-200 cursor-not-allowed'
              }"
            >Use as Y Series</button>
          </div>
          ${
            !yEligibility.eligible && yEligibility.reason
              ? `<p class="text-[11px] text-slate-500">Y Series disabled: ${esc(yEligibility.reason)}</p>`
              : ''
          }
          ${
            this.seriesFeedback
              ? `<p class="text-[11px] text-rose-700" role="status">${esc(this.seriesFeedback)}</p>`
              : ''
          }
        </div>
      </div>
    `;
  }

  private renderDetailStatsBlock(detail: ColumnDetailSummary): string {
    if (detail.numericStats) {
      const s = detail.numericStats;
      if (s.validCount === 0) {
        return `<p class="text-xs text-slate-500 bg-slate-50 p-2.5 rounded-lg">No valid numeric values in this column (${s.nonNumericCount} non-numeric).</p>`;
      }
      return `
        <div class="flex flex-col gap-2">
          <h3 class="text-xs font-semibold text-slate-700">Numeric Distribution (${s.validCount.toLocaleString('en-US')} valid${s.nonNumericCount > 0 ? `, ${s.nonNumericCount} non-numeric` : ''})</h3>
          <dl class="grid grid-cols-3 gap-2 text-xs">
            <div class="border border-slate-200 rounded-lg p-2"><dt class="text-[10px] text-slate-500">Min</dt><dd class="font-mono-tabular font-semibold text-slate-900">${formatDisplayNumber(s.min, detail.baseType)}</dd></div>
            <div class="border border-slate-200 rounded-lg p-2"><dt class="text-[10px] text-slate-500">Q1</dt><dd class="font-mono-tabular font-semibold text-slate-900">${formatDisplayNumber(s.q1, detail.baseType)}</dd></div>
            <div class="border border-slate-200 rounded-lg p-2"><dt class="text-[10px] text-slate-500">Median</dt><dd class="font-mono-tabular font-semibold text-slate-900">${formatDisplayNumber(s.median, detail.baseType)}</dd></div>
            <div class="border border-slate-200 rounded-lg p-2"><dt class="text-[10px] text-slate-500">Mean</dt><dd class="font-mono-tabular font-semibold text-slate-900">${formatDisplayNumber(s.mean, detail.baseType)}</dd></div>
            <div class="border border-slate-200 rounded-lg p-2"><dt class="text-[10px] text-slate-500">Q3</dt><dd class="font-mono-tabular font-semibold text-slate-900">${formatDisplayNumber(s.q3, detail.baseType)}</dd></div>
            <div class="border border-slate-200 rounded-lg p-2"><dt class="text-[10px] text-slate-500">Max</dt><dd class="font-mono-tabular font-semibold text-slate-900">${formatDisplayNumber(s.max, detail.baseType)}</dd></div>
          </dl>
          <div class="text-[11px] text-slate-600">Sign mix: ${s.negativeCount} negative · ${s.zeroCount} zero · ${s.positiveCount} positive</div>
        </div>
      `;
    }

    if (detail.categoricalStats) {
      const rows = detail.categoricalStats.topValues
        .map((item) => {
          const pct = (item.share * 100).toFixed(1);
          return `
            <div class="flex flex-col gap-1">
              <div class="flex items-center justify-between gap-2 text-xs">
                <span class="font-medium text-slate-800 truncate">${esc(item.value)}</span>
                <span class="font-mono-tabular text-slate-600 shrink-0">${item.count} (${pct}%)</span>
              </div>
              <div class="h-1.5 rounded-full bg-slate-100 overflow-hidden">
                <div class="h-full bg-emerald-500 rounded-full" style="width:${pct}%"></div>
              </div>
            </div>
          `;
        })
        .join('');
      return `
        <div class="flex flex-col gap-2">
          <h3 class="text-xs font-semibold text-slate-700">Top Category Frequencies</h3>
          ${rows || '<p class="text-xs text-slate-500">No non-empty categories.</p>'}
          ${detail.categoricalStats.otherCount > 0 ? `<div class="text-[11px] text-slate-500">+ ${detail.categoricalStats.otherCount} rows across remaining values</div>` : ''}
        </div>
      `;
    }

    if (detail.booleanStats) {
      const b = detail.booleanStats;
      return `
        <div class="flex flex-col gap-2">
          <h3 class="text-xs font-semibold text-slate-700">Boolean Breakdown</h3>
          <dl class="grid grid-cols-3 gap-2 text-xs">
            <div class="border border-slate-200 rounded-lg p-2"><dt class="text-[10px] text-slate-500">True / Yes / 1</dt><dd class="font-mono-tabular font-semibold text-emerald-700">${b.trueCount}</dd></div>
            <div class="border border-slate-200 rounded-lg p-2"><dt class="text-[10px] text-slate-500">False / No / 0</dt><dd class="font-mono-tabular font-semibold text-slate-900">${b.falseCount}</dd></div>
            <div class="border border-slate-200 rounded-lg p-2"><dt class="text-[10px] text-slate-500">Unexpected</dt><dd class="font-mono-tabular font-semibold ${b.unexpectedCount > 0 ? 'text-amber-700' : 'text-slate-600'}">${b.unexpectedCount}</dd></div>
          </dl>
        </div>
      `;
    }

    if (detail.temporalStats) {
      const t = detail.temporalStats;
      return `
        <div class="flex flex-col gap-2">
          <h3 class="text-xs font-semibold text-slate-700">Temporal Range</h3>
          <dl class="grid grid-cols-2 gap-2 text-xs">
            <div class="border border-slate-200 rounded-lg p-2"><dt class="text-[10px] text-slate-500">Earliest</dt><dd class="font-mono-tabular font-semibold text-slate-900">${esc(t.earliestIso ?? '—')}</dd></div>
            <div class="border border-slate-200 rounded-lg p-2"><dt class="text-[10px] text-slate-500">Latest</dt><dd class="font-mono-tabular font-semibold text-slate-900">${esc(t.latestIso ?? '—')}</dd></div>
            <div class="border border-slate-200 rounded-lg p-2"><dt class="text-[10px] text-slate-500">Parsed dates</dt><dd class="font-mono-tabular font-semibold text-slate-900">${t.validCount}</dd></div>
            <div class="border border-slate-200 rounded-lg p-2"><dt class="text-[10px] text-slate-500">Unparsed tokens</dt><dd class="font-mono-tabular font-semibold ${t.invalidCount > 0 ? 'text-amber-700' : 'text-slate-600'}">${t.invalidCount}</dd></div>
          </dl>
        </div>
      `;
    }

    if (detail.identifierStats) {
      const idStats = detail.identifierStats;
      return `
        <div class="flex flex-col gap-2">
          <h3 class="text-xs font-semibold text-slate-700">Identifier Summary</h3>
          <dl class="grid grid-cols-2 gap-2 text-xs">
            <div class="border border-slate-200 rounded-lg p-2"><dt class="text-[10px] text-slate-500">Duplicate ID values</dt><dd class="font-mono-tabular font-semibold ${idStats.duplicateValueCount > 0 ? 'text-amber-700' : 'text-emerald-700'}">${idStats.duplicateValueCount}</dd></div>
            <div class="border border-slate-200 rounded-lg p-2"><dt class="text-[10px] text-slate-500">Rows in duplicates</dt><dd class="font-mono-tabular font-semibold text-slate-900">${idStats.duplicateRowCount}</dd></div>
          </dl>
          ${
            idStats.topDuplicates.length > 0
              ? `<div class="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-2">Repeated: ${idStats.topDuplicates.map((d) => `${esc(d.value)} (×${d.count})`).join(', ')}</div>`
              : `<div class="text-[11px] text-slate-600">Non-metric key column: excluded from Y-series aggregation by default.</div>`
          }
        </div>
      `;
    }

    const txt = detail.textStats;
    return `
      <div class="flex flex-col gap-2">
        <h3 class="text-xs font-semibold text-slate-700">Text Profile</h3>
        <div class="text-xs text-slate-600">Length: min ${txt?.minLength ?? 0} · avg ${txt ? txt.avgLength.toFixed(1) : '0.0'} · max ${txt?.maxLength ?? 0} chars</div>
        ${
          txt && txt.samples.length > 0
            ? `<div class="flex flex-col gap-1">${txt.samples.slice(0, 3).map((s) => `<div class="text-[11px] text-slate-700 bg-slate-50 border border-slate-100 rounded px-2 py-1 truncate">${esc(s)}</div>`).join('')}</div>`
            : ''
        }
      </div>
    `;
  }

  private renderQualityDashboard(
    allObservations: QualityObservation[],
    dismissedIds: ReadonlySet<string>
  ): void {
    const active = allObservations.filter((obs) => !dismissedIds.has(obs.id));
    const dismissedCount = allObservations.length - active.length;

    const categoryLabels: Record<QualityObservation['category'], string> = {
      missing: 'Missing values',
      'type-consistency': 'Potential type issue',
      constant: 'Constant / low variance',
      identifier: 'Identifier check',
    };

    const cardsHtml = active
      .map((obs) => {
        const badgeCls =
          obs.severity === 'attention'
            ? 'bg-amber-50 text-amber-800 border-amber-200'
            : 'bg-slate-100 text-slate-700 border-slate-200';
        const exampleChips = obs.examples
          .map(
            (ex) => `
              <button
                type="button"
                data-overview-focus-col="${ex.colIndex}"
                data-overview-focus-row="${ex.rowIndex}"
                data-overview-target-layout="split"
                class="px-2 py-0.5 text-[11px] font-mono-tabular bg-slate-50 hover:bg-blue-50 text-slate-700 hover:text-blue-700 border border-slate-200 rounded cursor-pointer truncate max-w-[200px]"
                title="Jump to Row ${ex.rowIndex + 1}, Column ${esc(obs.columnName ?? '')}"
              >Row ${ex.rowIndex + 1}: ${esc(ex.value.slice(0, 24))}${ex.value.length > 24 ? '…' : ''}</button>
            `
          )
          .join('');

        return `
          <article data-quality-id="${esc(obs.id)}" class="p-3 rounded-lg border border-slate-200 bg-white flex flex-col gap-2">
            <div class="flex items-start justify-between gap-2">
              <div class="flex-1 min-w-0">
                <div class="flex flex-wrap items-center gap-1.5">
                  <span class="text-[10px] font-semibold px-1.5 py-0.5 rounded border ${badgeCls}">${categoryLabels[obs.category]}</span>
                  <h3 class="text-xs font-semibold text-slate-900">${esc(obs.title)}</h3>
                </div>
                <p class="text-xs text-slate-600 mt-1">${esc(obs.explanation)}</p>
              </div>
              <button
                type="button"
                data-dismiss-quality="${esc(obs.id)}"
                aria-label="Dismiss ${esc(obs.title)}"
                class="px-2 py-1 text-[11px] font-medium text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded cursor-pointer shrink-0"
              >Dismiss</button>
            </div>
            ${exampleChips ? `<div class="flex flex-wrap items-center gap-1">${exampleChips}</div>` : ''}
            <div class="flex flex-wrap items-center gap-2 pt-1">
              ${
                obs.colIndex !== null
                  ? `<button type="button" data-overview-select-col="${obs.colIndex}" class="text-[11px] font-medium text-blue-700 hover:underline cursor-pointer">Inspect column</button>`
                  : ''
              }
              ${
                obs.firstCell
                  ? `<button type="button" data-overview-focus-col="${obs.firstCell.colIndex}" data-overview-focus-row="${obs.firstCell.rowIndex}" data-overview-target-layout="split" class="text-[11px] font-medium text-emerald-700 hover:underline cursor-pointer">Jump to first affected cell</button>`
                  : ''
              }
            </div>
          </article>
        `;
      })
      .join('');

    this.qualityEl.innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div>
          <h2 class="text-sm font-semibold text-slate-900">Data Quality Observations</h2>
          <p class="text-xs text-slate-500">Explainable checks across active sheet rows — no data is modified automatically.</p>
        </div>
        ${
          dismissedCount > 0
            ? `<button type="button" data-restore-quality class="px-2.5 py-1 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg cursor-pointer">Restore dismissed (${dismissedCount})</button>`
            : ''
        }
      </div>
      ${
        active.length > 0
          ? `<div class="flex flex-col gap-2.5">${cardsHtml}</div>`
          : `<div class="p-6 text-center border border-dashed border-slate-200 rounded-lg bg-slate-50/70">
              <p class="text-xs font-medium text-slate-700">${
                dismissedCount > 0
                  ? 'All quality observations are currently dismissed for this sheet session.'
                  : 'No quality observations flagged for this sheet.'
              }</p>
            </div>`
      }
    `;
  }

  private renderSuggestions(items: SuggestedAnalysisItem[]): void {
    const cardsHtml = items
      .map((item) => {
        const rec = item.recommendation;
        const badge =
          rec.targetSurface === '3d'
            ? 'bg-violet-50 text-violet-700 border-violet-200'
            : 'bg-blue-50 text-blue-700 border-blue-200';
        const openLabel = rec.targetSurface === '3d' ? 'Open in 3D Stage' : 'Open in Charts';

        return `
          <article class="p-3 rounded-lg border border-slate-200 bg-white flex flex-col gap-2">
            <div class="flex flex-wrap items-center gap-1.5">
              <span class="text-[10px] font-semibold px-1.5 py-0.5 rounded border ${badge}">${rec.targetSurface.toUpperCase()}</span>
              <h3 class="text-xs font-semibold text-slate-900">${esc(rec.title)}</h3>
            </div>
            <p class="text-xs text-slate-600">${esc(rec.reason)}</p>
            <div class="text-[11px] font-mono-tabular text-slate-500">${esc(item.summary)}</div>
            <div class="flex flex-wrap items-center gap-2 pt-1">
              <button
                type="button"
                data-apply-suggested-id="${esc(rec.id)}"
                data-apply-suggested-layout="${item.targetLayout}"
                class="px-2.5 py-1 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-md cursor-pointer"
              >${openLabel}</button>
              <button
                type="button"
                data-apply-suggested-id="${esc(rec.id)}"
                data-apply-suggested-layout="split"
                class="px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md cursor-pointer"
              >Open in Split</button>
            </div>
          </article>
        `;
      })
      .join('');

    this.suggestionsEl.innerHTML = `
      <div class="mb-3">
        <h2 class="text-sm font-semibold text-slate-900">Suggested Analyses</h2>
        <p class="text-xs text-slate-500">Validated views derived deterministically from your dataset schema.</p>
      </div>
      ${
        items.length > 0
          ? `<div class="flex flex-col gap-2.5">${cardsHtml}</div>`
          : `<div class="p-6 text-center border border-dashed border-slate-200 rounded-lg bg-slate-50/70">
              <p class="text-xs text-slate-600">No validated chart suggestions are available for the current column roles or empty data.</p>
            </div>`
      }
    `;
  }

  public dispose(): void {
    this.disposed = true;
    this.abortController.abort();
    this.host.replaceChildren();
  }
}
