import * as xb from 'xrblocks';
import type {SpatialChartMode, WorkspaceLayout} from './types';
import {createBlankWorkbook} from './core/tabular';
import {exportSheetAsCsv, exportWorkbookAsExcel} from './core/excelIO';
import {AppStore} from './core/store';
import {SpreadsheetGrid} from './ui/SpreadsheetGrid';
import {InteractiveChart2D} from './ui/InteractiveChart2D';
import {SpatialDataStage} from './xr/SpatialDataStage';
import {svgIcon} from './ui/icons';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

class SpatialSheetApp {
  private root: HTMLElement;
  private store: AppStore;

  private spreadsheet!: SpreadsheetGrid;
  private chart2d!: InteractiveChart2D;
  private spatialStage!: SpatialDataStage;

  // Layout containers
  private gridHostEl!: HTMLElement;
  private vizHostEl!: HTMLElement;
  private chart2dHostEl!: HTMLElement;
  private spatialHostEl!: HTMLElement;
  private xrCanvasMountEl!: HTMLElement;
  private xrCanvasEl!: HTMLCanvasElement;
  private sheetTabsEl!: HTMLElement;
  private fileMetaEl!: HTMLElement;
  private loadingBadgeEl!: HTMLElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private searchInput!: HTMLInputElement;
  private dropOverlayEl!: HTMLElement;
  private exitSimBtn!: HTMLButtonElement;
  private errorBannerEl!: HTMLElement;

  private lastTabsKey = '';

  constructor(root: HTMLElement) {
    this.root = root;
    this.store = new AppStore(createBlankWorkbook());

    const params = new URLSearchParams(window.location.search);
    if (params.get('mode') === 'spatial') {
      this.store.layout = 'spatial';
      this.store.chartPanelMode = '3d';
    }

    this.renderAppShell();
    this.initSubsystems();
    this.bindStoreSubscriptions();
    this.bindGlobalEvents();
    this.syncInitialViews();
  }

  private renderAppShell(): void {
    this.root.innerHTML = `
      <div class="flex flex-col min-h-screen lg:h-screen w-full lg:overflow-hidden bg-slate-50 text-slate-900">
        <!-- Top Bar (3-zone contract) -->
        <header class="h-14 shrink-0 bg-white border-b border-slate-200 px-3 sm:px-4 lg:px-6 flex items-center justify-between gap-2 sm:gap-4 lg:gap-6">
          <!-- Zone 1: Brand wordmark -->
          <a href="#top" class="font-display text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 no-underline">
            SpatialSheet
          </a>

          <!-- Zone 2: File Actions -->
          <nav class="flex items-center gap-2 sm:gap-3 overflow-x-auto" aria-label="File tools">
            <label class="inline-flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200/80 rounded-lg cursor-pointer transition-colors whitespace-nowrap shrink-0">
              ${svgIcon('upload', 'w-3.5 h-3.5 text-blue-600')}
              <span class="hidden sm:inline">Open CSV / Excel</span>
              <span class="sm:hidden">Open file</span>
              <input
                type="file"
                data-role="file-input"
                accept=".csv,.tsv,.txt,.xlsx,.xls,.ods,.json"
                class="sr-only"
              />
            </label>

            <button
              type="button"
              data-action="new-blank"
              class="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              ${svgIcon('plus', 'w-3.5 h-3.5 text-slate-500')}
              <span>New Sheet</span>
            </button>

            <button
              type="button"
              data-action="export-csv"
              class="hidden md:inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              ${svgIcon('download', 'w-3.5 h-3.5')}
              <span>Export CSV</span>
            </button>

            <button
              type="button"
              data-action="export-xlsx"
              class="hidden md:inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              ${svgIcon('download', 'w-3.5 h-3.5 text-emerald-600')}
              <span>Export Excel</span>
            </button>
          </nav>

          <!-- Zone 3: Primary CTA -->
          <div class="flex items-center gap-2 shrink-0">
            <button
              type="button"
              data-action="toggle-xr"
              class="inline-flex items-center gap-1.5 px-2.5 sm:px-3.5 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              ${svgIcon('xr', 'w-4 h-4')}
              <span>XR Space</span>
            </button>
          </div>
        </header>

        <!-- Error Banner (hidden unless parse fails) -->
        <div
          data-role="error-banner"
          role="alert"
          class="hidden px-4 py-2 bg-rose-50 border-b border-rose-200 text-xs text-rose-800 items-center justify-between gap-4"
        ></div>

        <!-- Secondary Workspace Toolbar -->
        <div class="shrink-0 bg-white border-b border-slate-200 px-4 lg:px-6 py-2 flex flex-wrap items-center justify-between gap-3">
          <div class="flex items-center gap-3 min-w-0">
            <div data-role="file-meta" class="text-xs text-slate-500 truncate"></div>
            <div
              data-role="loading-status"
              aria-live="polite"
              class="hidden items-center gap-1.5 px-2 py-0.5 rounded-md bg-blue-50 border border-blue-200 text-[11px] font-medium text-blue-700 whitespace-nowrap shrink-0"
            ></div>
            <div class="h-4 w-px bg-slate-200 hidden sm:block" aria-hidden="true"></div>
            <div data-role="sheet-tabs" class="flex items-center gap-1 overflow-x-auto" role="tablist" aria-label="Sheet tabs"></div>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <!-- Search -->
            <div class="relative">
              <span class="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none">
                ${svgIcon('search', 'w-3.5 h-3.5')}
              </span>
              <input
                type="search"
                data-role="search-input"
                aria-label="Search table"
                placeholder="Search data..."
                class="w-44 sm:w-56 pl-8 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:bg-white focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
              />
            </div>

            <!-- Undo / Redo -->
            <div class="flex items-center gap-1 border border-slate-200 rounded-lg bg-white p-0.5">
              <button
                type="button"
                data-action="undo"
                aria-label="Undo"
                title="Undo (Ctrl+Z)"
                class="p-1.5 rounded text-slate-600 hover:bg-slate-100 hover:text-slate-900 disabled:opacity-35 disabled:pointer-events-none cursor-pointer"
              >
                ${svgIcon('undo', 'w-3.5 h-3.5')}
              </button>
              <button
                type="button"
                data-action="redo"
                aria-label="Redo"
                title="Redo (Ctrl+Y)"
                class="p-1.5 rounded text-slate-600 hover:bg-slate-100 hover:text-slate-900 disabled:opacity-35 disabled:pointer-events-none cursor-pointer"
              >
                ${svgIcon('redo', 'w-3.5 h-3.5')}
              </button>
            </div>

            <!-- Workspace View Mode -->
            <div class="flex items-center gap-1 p-1 bg-slate-100 rounded-lg" role="group" aria-label="Workspace layout">
              <button type="button" data-layout="split" class="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-md whitespace-nowrap shrink-0 cursor-pointer">
                ${svgIcon('split', 'w-3.5 h-3.5')}
                <span>Split</span>
              </button>
              <button type="button" data-layout="table" class="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-md whitespace-nowrap shrink-0 cursor-pointer">
                ${svgIcon('table', 'w-3.5 h-3.5')}
                <span>Table</span>
              </button>
              <button type="button" data-layout="charts" class="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-md whitespace-nowrap shrink-0 cursor-pointer">
                ${svgIcon('barChart', 'w-3.5 h-3.5')}
                <span>Charts</span>
              </button>
              <button type="button" data-layout="spatial" class="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-md whitespace-nowrap shrink-0 cursor-pointer">
                ${svgIcon('cube3d', 'w-3.5 h-3.5')}
                <span>3D XR</span>
              </button>
            </div>
          </div>
        </div>

        <!-- Main Workspace Canvas -->
        <main class="flex-1 min-h-0 p-3 lg:p-4 grid grid-cols-1 lg:grid-cols-12 gap-4 overflow-y-auto lg:overflow-hidden">
          <!-- Spreadsheet Pane -->
          <section data-role="grid-host" class="lg:col-span-7 min-h-[340px] lg:min-h-0 lg:h-full flex flex-col"></section>

          <!-- Visualization Pane (2D Interactive Charts + 3D XR Blocks Stage) -->
          <section data-role="viz-host" class="lg:col-span-5 min-h-[340px] lg:min-h-0 lg:h-full flex flex-col gap-2">
            <!-- Sub-switcher between 2D Chart and 3D Spatial Stage inside Split Mode -->
            <div class="flex items-center justify-between gap-2 shrink-0">
              <div class="flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg" role="group" aria-label="Visualization mode">
                <button
                  type="button"
                  data-viz-tab="2d"
                  class="px-3 py-1 text-xs rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >2D Charts</button>
                <button
                  type="button"
                  data-viz-tab="3d"
                  class="px-3 py-1 text-xs rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >3D Stage</button>
              </div>
              <span class="text-xs text-slate-500 hidden sm:inline">Click chart to select row</span>
            </div>

            <!-- 2D Interactive Chart Container -->
            <div data-role="chart2d-host" class="flex-1 min-h-0"></div>

            <!-- 3D Spatial Stage Container -->
            <div data-role="spatial-host" class="hidden flex-1 min-h-0 flex-col bg-slate-900 border border-slate-800 rounded-xl overflow-hidden relative">
              <div class="flex flex-wrap items-center justify-between gap-2 px-3 py-2 bg-slate-900/95 border-b border-slate-800 text-xs text-slate-200 z-10">
                <div class="flex items-center gap-1" role="group" aria-label="3D chart style">
                  <button type="button" data-spatial-mode="bar3d" class="px-2.5 py-1 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer">3D Bars</button>
                  <button type="button" data-spatial-mode="scatter3d" class="px-2.5 py-1 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer">3D Scatter</button>
                  <button type="button" data-spatial-mode="ring3d" class="px-2.5 py-1 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer">3D Ring</button>
                </div>
                <span class="text-[11px] text-slate-400">Drag to orbit · Scroll to zoom</span>
              </div>
              <div data-role="xr-canvas-mount" class="relative flex-1 min-h-[260px] w-full">
                <canvas data-role="xr-canvas" class="block w-full h-full outline-none"></canvas>
              </div>
            </div>
          </section>
        </main>

        <!-- Drag & Drop File Overlay -->
        <div
          data-role="drop-overlay"
          class="hidden fixed inset-0 z-50 bg-slate-900/55 items-center justify-center p-6 pointer-events-none"
        >
          <div class="bg-white border-2 border-dashed border-blue-500 rounded-2xl px-10 py-8 text-center max-w-md shadow-xl">
            <p class="font-display text-lg font-semibold text-slate-900">Drop spreadsheet file here</p>
            <p class="text-xs text-slate-500 mt-1.5">Supports CSV, TSV, Excel (.xlsx, .xls), ODS, and JSON</p>
          </div>
        </div>

        <!-- Exit XR Simulator Floating Button -->
        <button
          type="button"
          data-action="exit-simulator"
          class="hidden fixed top-4 right-4 z-[100] items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-slate-900/90 border border-slate-700 hover:bg-slate-800 rounded-lg shadow-lg cursor-pointer"
        >
          ${svgIcon('close', 'w-3.5 h-3.5')}
          <span>Exit XR Simulator</span>
        </button>
      </div>
    `;

    this.gridHostEl = this.root.querySelector('[data-role="grid-host"]')!;
    this.vizHostEl = this.root.querySelector('[data-role="viz-host"]')!;
    this.chart2dHostEl = this.root.querySelector('[data-role="chart2d-host"]')!;
    this.spatialHostEl = this.root.querySelector('[data-role="spatial-host"]')!;
    this.xrCanvasMountEl = this.root.querySelector(
      '[data-role="xr-canvas-mount"]'
    )!;
    this.xrCanvasEl = this.root.querySelector('[data-role="xr-canvas"]')!;
    this.sheetTabsEl = this.root.querySelector('[data-role="sheet-tabs"]')!;
    this.fileMetaEl = this.root.querySelector('[data-role="file-meta"]')!;
    this.loadingBadgeEl = this.root.querySelector(
      '[data-role="loading-status"]'
    )!;
    this.undoBtn = this.root.querySelector('[data-action="undo"]')!;
    this.redoBtn = this.root.querySelector('[data-action="redo"]')!;
    this.searchInput = this.root.querySelector('[data-role="search-input"]')!;
    this.dropOverlayEl = this.root.querySelector('[data-role="drop-overlay"]')!;
    this.exitSimBtn = this.root.querySelector(
      '[data-action="exit-simulator"]'
    )!;
    this.errorBannerEl = this.root.querySelector('[data-role="error-banner"]')!;
  }

  private initSubsystems(): void {
    this.spreadsheet = new SpreadsheetGrid(this.gridHostEl, {
      onCellCommit: (rowIndex, colIndex, value) => {
        this.store.commitCellEdit(rowIndex, colIndex, value);
      },
      onSelectCell: (coord) => {
        this.store.selectCell(coord);
      },
      onSortColumn: (colIndex) => {
        this.store.toggleSortColumn(colIndex);
      },
      onRenameColumn: (colIndex, newName) => {
        this.store.renameColumn(colIndex, newName);
      },
      onDeleteColumn: (colIndex) => {
        this.store.deleteColumn(colIndex);
      },
      onDeleteRow: (rowIndex) => {
        this.store.deleteRow(rowIndex);
      },
      onAddRow: () => {
        const newRowIdx = this.store.addRow();
        this.spreadsheet.scrollToRow(newRowIdx);
      },
      onAddColumn: () => {
        this.store.addColumn();
      },
      onClearSearch: () => {
        this.searchInput.value = '';
        this.store.clearSearch();
      },
    });

    this.chart2d = new InteractiveChart2D(this.chart2dHostEl, {
      onConfigChange: (nextConfig) => {
        this.store.setChartConfig(nextConfig);
      },
      onRowSelect: (rowIndex) => {
        this.store.highlightRowFromChart(rowIndex);
        this.spreadsheet.scrollToRow(rowIndex);
      },
    });

    this.spatialStage = new SpatialDataStage({
      onRowSelect: (rowIndex) => {
        this.store.highlightRowFromChart(rowIndex);
        this.spreadsheet.scrollToRow(rowIndex);
      },
      onSpatialModeChange: (mode: SpatialChartMode) => {
        this.store.setSpatialMode(mode);
      },
    });

    const options = new xb.Options();
    options.canvas = this.xrCanvasEl;
    options.xrButton.enabled = false;
    options.enableSimulator = false;
    options.reticles.enabled = true;
    options.setAppTitle('SpatialSheet Studio');
    options.setAppDescription(
      'Interactive CSV and Excel spreadsheet viewer and editor in XR.'
    );
    xb.add(this.spatialStage);
    void xb.init(options).then(() => {
      this.syncSpatialSize();
    });

    const ro = new ResizeObserver(() => {
      this.syncSpatialSize();
    });
    ro.observe(this.xrCanvasMountEl);
    window.addEventListener('resize', () => {
      requestAnimationFrame(() => this.syncSpatialSize());
    });
  }

  private bindStoreSubscriptions(): void {
    // 1. Top metadata + Sheet tabs + Search input sync
    this.store.subscribe(['workbook', 'sheetData'], (changed) => {
      this.syncMetadataAndTabs();
      if (changed.has('workbook') && this.searchInput.value !== this.store.searchQuery) {
        this.searchInput.value = this.store.searchQuery;
      }
    });

    // 2. Undo / Redo buttons
    this.store.subscribe(['history'], () => {
      this.undoBtn.disabled = !this.store.history.canUndo;
      this.redoBtn.disabled = !this.store.history.canRedo;
    });

    // 3. Loading & error states
    this.store.subscribe(['loading'], () => this.syncLoadingBanner());
    this.store.subscribe(['error'], () => this.syncErrorBanner());

    // 4. Layout & 2D/3D visibility
    this.store.subscribe(['layout', 'vizMode'], () => {
      this.syncLayoutAndVizVisibility();
    });

    // 5. Spreadsheet Grid (fine-grained: cell patch vs full window vs selection only vs stats)
    this.store.subscribe(
      ['sheetData', 'visibleRows', 'selection', 'stats'],
      (changed) => {
        if (changed.has('visibleRows')) {
          this.spreadsheet.setData({
            sheet: this.store.activeSheet,
            visibleRowIndices: this.store.visibleRowIndices,
            sort: this.store.sort,
            selectedCell: this.store.selectedCell,
            highlightedRowIndex: this.store.highlightedRowIndex,
            columnStats: this.store.activeColumnStats,
          });
          return;
        }

        if (changed.has('sheetData') && this.store.lastCellPatch) {
          const patch = this.store.lastCellPatch;
          this.store.lastCellPatch = null;
          this.spreadsheet.updateSingleCellInPlace(
            this.store.activeSheet,
            patch.rowIndex,
            patch.colIndex,
            this.store.activeColumnStats
          );
          if (changed.has('selection')) {
            this.spreadsheet.setSelection(
              this.store.selectedCell,
              this.store.highlightedRowIndex,
              this.store.activeColumnStats
            );
          }
          return;
        }

        if (changed.has('sheetData')) {
          this.spreadsheet.setData({
            sheet: this.store.activeSheet,
            visibleRowIndices: this.store.visibleRowIndices,
            sort: this.store.sort,
            selectedCell: this.store.selectedCell,
            highlightedRowIndex: this.store.highlightedRowIndex,
            columnStats: this.store.activeColumnStats,
          });
          return;
        }

        if (changed.has('selection')) {
          this.spreadsheet.setSelection(
            this.store.selectedCell,
            this.store.highlightedRowIndex,
            this.store.activeColumnStats
          );
          return;
        }

        if (changed.has('stats')) {
          this.spreadsheet.setColumnStats(this.store.activeColumnStats);
        }
      }
    );

    // 6. 2D Chart updates (skip full rebuild on highlight-only changes)
    this.store.subscribe(
      ['sheetData', 'visibleRows', 'chartConfig', 'chartHighlight'],
      (changed) => {
        const dataOrConfigChanged =
          changed.has('sheetData') ||
          changed.has('visibleRows') ||
          changed.has('chartConfig');

        if (dataOrConfigChanged) {
          this.chart2d.setData({
            sheet: this.store.activeSheet,
            visibleRowIndices: this.store.visibleRowIndices,
            config: this.store.chartConfig,
            highlightedRowIndex: this.store.highlightedRowIndex,
          });
        } else if (changed.has('chartHighlight')) {
          this.chart2d.setHighlight(this.store.highlightedRowIndex);
        }
      }
    );

    // 7. 3D XR Stage updates (pooled & lazy-synced when hidden)
    this.store.subscribe(
      ['sheetData', 'visibleRows', 'chartConfig', 'chartHighlight'],
      (changed) => {
        const dataOrConfigChanged =
          changed.has('sheetData') ||
          changed.has('visibleRows') ||
          changed.has('chartConfig');

        if (dataOrConfigChanged) {
          this.spatialStage.setData({
            sheet: this.store.activeSheet,
            visibleRowIndices: this.store.visibleRowIndices,
            config: this.store.chartConfig,
            highlightedRowIndex: this.store.highlightedRowIndex,
          });
        } else if (changed.has('chartHighlight')) {
          this.spatialStage.setHighlight(this.store.highlightedRowIndex);
        }
      }
    );
  }

  private syncInitialViews(): void {
    this.syncMetadataAndTabs();
    this.undoBtn.disabled = !this.store.history.canUndo;
    this.redoBtn.disabled = !this.store.history.canRedo;
    this.syncLayoutAndVizVisibility();

    const params = {
      sheet: this.store.activeSheet,
      visibleRowIndices: this.store.visibleRowIndices,
      sort: this.store.sort,
      selectedCell: this.store.selectedCell,
      highlightedRowIndex: this.store.highlightedRowIndex,
      columnStats: this.store.activeColumnStats,
    };
    this.spreadsheet.setData(params);
    this.chart2d.setData({
      sheet: this.store.activeSheet,
      visibleRowIndices: this.store.visibleRowIndices,
      config: this.store.chartConfig,
      highlightedRowIndex: this.store.highlightedRowIndex,
    });
    this.spatialStage.setData({
      sheet: this.store.activeSheet,
      visibleRowIndices: this.store.visibleRowIndices,
      config: this.store.chartConfig,
      highlightedRowIndex: this.store.highlightedRowIndex,
    });
  }

  private syncMetadataAndTabs(): void {
    const wb = this.store.workbook;
    const sheet = this.store.activeSheet;
    this.fileMetaEl.textContent = `${wb.fileName} · ${sheet.rows.length.toLocaleString('en-US')} rows · ${sheet.columns.length} cols`;

    const tabsKey = `${wb.activeSheetIndex}|${wb.sheets.map((s) => `${s.id}:${s.name}`).join('\x00')}`;
    if (tabsKey === this.lastTabsKey) return;
    this.lastTabsKey = tabsKey;

    const tabsHtml = wb.sheets
      .map((s, idx) => {
        const active = idx === wb.activeSheetIndex;
        const cls = active
          ? 'bg-blue-50 text-blue-700 font-semibold border-blue-200'
          : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50';
        return `
          <button
            type="button"
            role="tab"
            aria-selected="${active}"
            data-sheet-tab="${idx}"
            class="px-2.5 py-1 text-xs rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${cls}"
          >${escapeHtml(s.name)}</button>
        `;
      })
      .join('');

    this.sheetTabsEl.innerHTML = `
      ${tabsHtml}
      <button
        type="button"
        data-action="add-sheet"
        aria-label="Add new sheet"
        title="Add new sheet"
        class="p-1 rounded-md text-slate-500 hover:text-slate-900 hover:bg-slate-100 cursor-pointer shrink-0"
      >${svgIcon('plus', 'w-3.5 h-3.5')}</button>
    `;
  }

  private syncLoadingBanner(): void {
    const {active, message, progress} = this.store.loading;
    if (!active) {
      this.loadingBadgeEl.classList.add('hidden');
      this.loadingBadgeEl.classList.remove('inline-flex');
      this.loadingBadgeEl.textContent = '';
      return;
    }
    const pct =
      progress !== null ? ` (${Math.round(progress * 100)}%)` : '';
    this.loadingBadgeEl.textContent = `${message}${pct}`;
    this.loadingBadgeEl.classList.remove('hidden');
    this.loadingBadgeEl.classList.add('inline-flex');
  }

  private syncErrorBanner(): void {
    const msg = this.store.errorMessage;
    if (!msg) {
      this.errorBannerEl.classList.add('hidden');
      this.errorBannerEl.classList.remove('flex');
      return;
    }
    this.errorBannerEl.innerHTML = `
      <span>${escapeHtml(msg)}</span>
      <button type="button" data-close-err class="text-rose-700 font-semibold hover:underline cursor-pointer">Dismiss</button>
    `;
    this.errorBannerEl.classList.remove('hidden');
    this.errorBannerEl.classList.add('flex');
  }

  private syncLayoutAndVizVisibility(): void {
    const {layout, chartPanelMode, chartConfig, isSimulatorFullscreen} =
      this.store;

    this.root
      .querySelectorAll<HTMLButtonElement>('[data-layout]')
      .forEach((btn) => {
        const active = btn.dataset.layout === layout;
        btn.className = active
          ? 'inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-md bg-white text-blue-700 font-semibold shadow-xs whitespace-nowrap shrink-0 cursor-pointer'
          : 'inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-md text-slate-600 hover:text-slate-900 whitespace-nowrap shrink-0 cursor-pointer';
      });

    this.root
      .querySelectorAll<HTMLButtonElement>('[data-viz-tab]')
      .forEach((btn) => {
        const active = btn.dataset.vizTab === chartPanelMode;
        btn.className = active
          ? 'px-3 py-1 text-xs rounded-md bg-white text-slate-900 font-semibold shadow-xs transition-colors whitespace-nowrap shrink-0 cursor-pointer'
          : 'px-3 py-1 text-xs rounded-md text-slate-600 hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 cursor-pointer';
      });

    this.root
      .querySelectorAll<HTMLButtonElement>('[data-spatial-mode]')
      .forEach((btn) => {
        const active = btn.dataset.spatialMode === chartConfig.spatialMode;
        btn.className = active
          ? 'px-2.5 py-1 rounded-md bg-blue-600 text-white font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer'
          : 'px-2.5 py-1 rounded-md text-slate-300 hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer';
      });

    if (layout === 'table') {
      this.gridHostEl.className =
        'lg:col-span-12 min-h-[340px] lg:min-h-0 lg:h-full flex flex-col';
      this.vizHostEl.classList.add('hidden');
    } else if (layout === 'charts' || layout === 'spatial') {
      this.gridHostEl.classList.add('hidden');
      this.vizHostEl.className =
        'lg:col-span-12 min-h-[340px] lg:min-h-0 lg:h-full flex flex-col gap-2';
    } else {
      this.gridHostEl.className =
        'lg:col-span-7 min-h-[340px] lg:min-h-0 lg:h-full flex flex-col';
      this.vizHostEl.className =
        'lg:col-span-5 min-h-[340px] lg:min-h-0 lg:h-full flex flex-col gap-2';
    }

    const show3D =
      layout === 'spatial' || (layout !== 'table' && chartPanelMode === '3d');
    const show2D = layout !== 'table' && !show3D;

    this.chart2dHostEl.classList.toggle('hidden', !show2D);
    if (!isSimulatorFullscreen) {
      this.spatialHostEl.classList.toggle('hidden', !show3D);
      this.spatialHostEl.classList.toggle('flex', show3D);
    }

    this.spatialStage.setEmbeddedVisible(show3D || isSimulatorFullscreen);
    if (show3D) {
      requestAnimationFrame(() => this.syncSpatialSize());
    }
  }

  private syncSpatialSize(): void {
    if (this.store.isSimulatorFullscreen) {
      this.spatialStage.resizeToContainer(
        window.innerWidth,
        window.innerHeight
      );
      return;
    }
    const rect = this.xrCanvasMountEl.getBoundingClientRect();
    if (rect.width > 10 && rect.height > 10) {
      this.spatialStage.resizeToContainer(rect.width, rect.height);
    }
  }

  private bindGlobalEvents(): void {
    // Delegated sheet tabs
    this.sheetTabsEl.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const tabBtn = target.closest<HTMLElement>('[data-sheet-tab]');
      if (tabBtn) {
        this.store.switchSheet(Number(tabBtn.dataset.sheetTab));
        return;
      }
      if (target.closest('[data-action="add-sheet"]')) {
        this.store.addNewSheet();
      }
    });

    // Delegated error dismiss
    this.errorBannerEl.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-close-err]')) {
        this.store.dismissError();
      }
    });

    // File input
    const fileInput = this.root.querySelector<HTMLInputElement>(
      '[data-role="file-input"]'
    );
    fileInput?.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      await this.store.loadFile(file);
      fileInput.value = '';
    });

    // New blank sheet button
    this.root
      .querySelector('[data-action="new-blank"]')
      ?.addEventListener('click', () => {
        this.store.resetWithWorkbook(createBlankWorkbook());
      });

    // Exports
    this.root
      .querySelector('[data-action="export-csv"]')
      ?.addEventListener('click', () => {
        exportSheetAsCsv(this.store.activeSheet, this.store.workbook.fileName);
      });
    this.root
      .querySelector('[data-action="export-xlsx"]')
      ?.addEventListener('click', () => {
        exportWorkbookAsExcel(this.store.workbook);
      });

    // Undo / Redo
    this.undoBtn.addEventListener('click', () => this.store.undo());
    this.redoBtn.addEventListener('click', () => this.store.redo());

    // Debounced Search
    this.searchInput.addEventListener('input', () => {
      this.store.setSearchQueryDebounced(this.searchInput.value);
    });

    // Layout mode switches
    this.root
      .querySelectorAll<HTMLButtonElement>('[data-layout]')
      .forEach((btn) => {
        btn.addEventListener('click', () => {
          this.store.setLayout(btn.dataset.layout as WorkspaceLayout);
        });
      });

    // Viz sub-tabs
    this.root
      .querySelectorAll<HTMLButtonElement>('[data-viz-tab]')
      .forEach((btn) => {
        btn.addEventListener('click', () => {
          this.store.setChartPanelMode(btn.dataset.vizTab as '2d' | '3d');
        });
      });

    // Spatial 3D mode buttons
    this.root
      .querySelectorAll<HTMLButtonElement>('[data-spatial-mode]')
      .forEach((btn) => {
        btn.addEventListener('click', () => {
          this.store.setSpatialMode(
            btn.dataset.spatialMode as SpatialChartMode
          );
        });
      });

    // XR / Simulator launcher
    this.root
      .querySelector('[data-action="toggle-xr"]')
      ?.addEventListener('click', () => {
        void this.launchXRorSimulator();
      });

    this.exitSimBtn.addEventListener('click', () => {
      this.exitSimulatorMode();
    });

    // Global keyboard shortcuts (Undo/Redo)
    window.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement | null;
      const isTextInput =
        target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA';
      if (isTextInput) return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) this.store.redo();
        else this.store.undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        this.store.redo();
      }
    });

    // Drag and Drop file upload
    let dragDepth = 0;
    window.addEventListener('dragenter', (e) => {
      if (e.dataTransfer?.types.includes('Files')) {
        dragDepth++;
        this.dropOverlayEl.classList.remove('hidden');
        this.dropOverlayEl.classList.add('flex');
      }
    });
    window.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) {
        this.dropOverlayEl.classList.add('hidden');
        this.dropOverlayEl.classList.remove('flex');
      }
    });
    window.addEventListener('dragover', (e) => {
      e.preventDefault();
    });
    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      dragDepth = 0;
      this.dropOverlayEl.classList.add('hidden');
      this.dropOverlayEl.classList.remove('flex');
      const file = e.dataTransfer?.files?.[0];
      if (file) {
        await this.store.loadFile(file);
      }
    });
  }

  private async launchXRorSimulator(): Promise<void> {
    const sessionManager = xb.core.webXRSessionManager;
    const isXRSupported =
      typeof navigator !== 'undefined' &&
      'xr' in navigator &&
      (await navigator.xr?.isSessionSupported('immersive-ar').catch(() => false));

    if (isXRSupported && sessionManager) {
      await sessionManager.startSession();
      return;
    }

    this.store.setSimulatorFullscreen(true);
    this.spatialHostEl.classList.remove('hidden');
    this.spatialHostEl.classList.add(
      'fixed',
      'inset-0',
      'z-50',
      'rounded-none',
      'flex'
    );
    this.exitSimBtn.classList.remove('hidden');
    this.exitSimBtn.classList.add('inline-flex');
    this.syncSpatialSize();
    xb.core.options.enableSimulator = true;
    await xb.core.startSimulator();
  }

  private exitSimulatorMode(): void {
    this.spatialHostEl.classList.remove(
      'fixed',
      'inset-0',
      'z-50',
      'rounded-none'
    );
    this.exitSimBtn.classList.add('hidden');
    this.exitSimBtn.classList.remove('inline-flex');
    this.spatialStage.onXRSessionEnded();
    this.store.setSimulatorFullscreen(false);
    requestAnimationFrame(() => this.syncSpatialSize());
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const root = document.getElementById('root');
  if (root) {
    new SpatialSheetApp(root);
  }
});
