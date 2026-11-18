import type {
  AppDomain,
  CellCoord,
  ChartConfig,
  ColumnStats,
  LoadingState,
  SheetData,
  SortState,
  SpatialChartMode,
  VisibleRowsSource,
  WorkbookState,
  WorkspaceLayout,
} from '../types';
import {WorkbookHistoryManager} from './history';
import {
  addSheetColumn,
  addSheetRow,
  computeColumnStats,
  createBlankWorkbook,
  deleteSheetColumn,
  deleteSheetRow,
  renameSheetColumn,
  suggestChartConfig,
} from './tabular';
import {DataWorkerClient, buildFilterKey} from './workerClient';

export type StoreListener = (changed: ReadonlySet<AppDomain>) => void;

export interface ActiveColumnStatsState {
  colIndex: number;
  stats: ColumnStats | null;
  loading: boolean;
}

interface Subscription {
  domains: Set<AppDomain>;
  listener: StoreListener;
}

export class AppStore {
  public readonly history: WorkbookHistoryManager;
  public readonly worker: DataWorkerClient;

  public sheetVersion = 1;
  public searchQuery = '';
  public sort: SortState = {colIndex: null, direction: null};
  public visibleRowIndices: VisibleRowsSource = [];
  public selectedCell: CellCoord | null = null;
  public highlightedRowIndex: number | null = null;
  public chartConfig: ChartConfig;
  public layout: WorkspaceLayout = 'split';
  public chartPanelMode: '2d' | '3d' = '2d';
  public isSimulatorFullscreen = false;
  public loading: LoadingState = {active: false, message: '', progress: null};
  public errorMessage: string | null = null;
  public activeColumnStats: ActiveColumnStatsState = {
    colIndex: 0,
    stats: null,
    loading: false,
  };

  // Metadata about last cell patch for O(1) DOM updates
  public lastCellPatch: {
    rowIndex: number;
    colIndex: number;
    needsRequery: boolean;
  } | null = null;

  private subscriptions: Subscription[] = [];
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private filterSeq = 0;
  private statsSeq = 0;
  private loadFileSeq = 0;
  private columnStatsCache = new Map<number, ColumnStats>();
  private columnStatsCacheFilterKey = '';

  constructor(initialWorkbook?: WorkbookState, worker?: DataWorkerClient) {
    const initial = initialWorkbook ?? createBlankWorkbook();
    this.history = new WorkbookHistoryManager(initial, 50);
    this.worker = worker ?? new DataWorkerClient();

    const firstSheet = this.activeSheet;
    this.chartConfig = suggestChartConfig(firstSheet);
    this.visibleRowIndices = this.buildSequentialIndices(firstSheet.rows.length);
    this.selectedCell =
      firstSheet.rows.length > 0 ? {rowIndex: 0, colIndex: 0} : null;
    this.refreshActiveColumnStats(false);
  }

  public get workbook(): WorkbookState {
    return this.history.current;
  }

  public get activeSheet(): SheetData {
    const wb = this.workbook;
    return wb.sheets[wb.activeSheetIndex] ?? wb.sheets[0];
  }

  public subscribe(domains: AppDomain[], listener: StoreListener): () => void {
    const sub: Subscription = {domains: new Set(domains), listener};
    this.subscriptions.push(sub);
    return () => {
      const idx = this.subscriptions.indexOf(sub);
      if (idx >= 0) this.subscriptions.splice(idx, 1);
    };
  }

  private emit(domains: AppDomain[]): void {
    const changed = new Set<AppDomain>(domains);
    for (const sub of this.subscriptions) {
      for (const d of changed) {
        if (sub.domains.has(d)) {
          sub.listener(changed);
          break;
        }
      }
    }
  }

  private nextSheetVersion(): number {
    this.sheetVersion += 1;
    return this.sheetVersion;
  }

  private cancelPendingSearchTimer(): void {
    if (this.searchTimer !== null) {
      globalThis.clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
  }

  private buildSequentialIndices(len: number): Int32Array {
    const arr = new Int32Array(len);
    for (let i = 0; i < len; i++) arr[i] = i;
    return arr;
  }

  private adjustVisibleRowsAfterDelete(
    vis: VisibleRowsSource,
    deletedRowIndex: number
  ): Int32Array {
    const kept: number[] = [];
    for (let i = 0; i < vis.length; i++) {
      const idx = vis[i];
      if (idx === deletedRowIndex) continue;
      kept.push(idx > deletedRowIndex ? idx - 1 : idx);
    }
    return Int32Array.from(kept);
  }

  private clampVisibleRowIndices(
    vis: VisibleRowsSource,
    maxRows: number
  ): Int32Array {
    const kept: number[] = [];
    for (let i = 0; i < vis.length; i++) {
      const idx = vis[i];
      if (idx >= 0 && idx < maxRows) kept.push(idx);
    }
    return Int32Array.from(kept);
  }

  private hasActiveFilterOrSort(): boolean {
    return (
      this.searchQuery.trim().length > 0 ||
      (this.sort.colIndex !== null && this.sort.direction !== null)
    );
  }

  private getActiveStatsCol(): number {
    if (
      this.selectedCell &&
      this.selectedCell.colIndex >= 0 &&
      this.selectedCell.colIndex < this.activeSheet.columns.length
    ) {
      return this.selectedCell.colIndex;
    }
    const idx = this.activeSheet.types.findIndex(
      (t) => t === 'number' || t === 'percent'
    );
    return idx >= 0 ? idx : 0;
  }

  private clearColumnStatsCache(): void {
    this.columnStatsCache.clear();
    this.columnStatsCacheFilterKey = buildFilterKey(this.searchQuery, this.sort);
  }

  /**
   * Resolves column statistics for the currently active column without blocking the main thread
   * on large (>= 2,500 visible row) datasets. Returns true if activeColumnStats changed.
   */
  private refreshActiveColumnStats(emitOnAsyncComplete = true): boolean {
    const sheet = this.activeSheet;
    const colIdx = this.getActiveStatsCol();
    const filterKey = buildFilterKey(this.searchQuery, this.sort);

    if (this.columnStatsCacheFilterKey !== filterKey) {
      this.columnStatsCache.clear();
      this.columnStatsCacheFilterKey = filterKey;
    }

    if (colIdx < 0 || colIdx >= sheet.columns.length) {
      const prev = this.activeColumnStats;
      this.activeColumnStats = {colIndex: 0, stats: null, loading: false};
      return (
        prev.colIndex !== 0 || prev.stats !== null || prev.loading !== false
      );
    }

    const cached = this.columnStatsCache.get(colIdx);
    if (cached) {
      const prev = this.activeColumnStats;
      this.activeColumnStats = {
        colIndex: colIdx,
        stats: cached,
        loading: false,
      };
      return (
        prev.colIndex !== colIdx ||
        prev.stats !== cached ||
        prev.loading !== false
      );
    }

    // Fast synchronous computation for small sheets (< 2,500 visible rows)
    if (this.visibleRowIndices.length < 2500) {
      const stats = computeColumnStats(sheet, colIdx, this.visibleRowIndices);
      this.columnStatsCache.set(colIdx, stats);
      this.activeColumnStats = {
        colIndex: colIdx,
        stats,
        loading: false,
      };
      return true;
    }

    // Off-thread computation for large datasets
    const seq = ++this.statsSeq;
    const reqVersion = this.sheetVersion;
    const reqVisible = this.visibleRowIndices;
    const reqSearch = this.searchQuery;
    const reqSort = this.sort;

    this.activeColumnStats = {
      colIndex: colIdx,
      stats: null,
      loading: true,
    };

    void this.worker
      .computeStats({
        sheet,
        sheetVersion: reqVersion,
        colIndex: colIdx,
        visibleRowIndices: reqVisible,
        searchQuery: reqSearch,
        sort: reqSort,
      })
      .then((stats) => {
        if (
          !stats ||
          seq !== this.statsSeq ||
          reqVersion !== this.sheetVersion ||
          reqVisible !== this.visibleRowIndices
        ) {
          return;
        }
        const currentFilterKey = buildFilterKey(this.searchQuery, this.sort);
        if (currentFilterKey !== filterKey) return;

        this.columnStatsCache.set(colIdx, stats);
        if (this.getActiveStatsCol() === colIdx) {
          this.activeColumnStats = {
            colIndex: colIdx,
            stats,
            loading: false,
          };
          if (emitOnAsyncComplete) {
            this.emit(['stats']);
          }
        }
      });

    return true;
  }

  public selectCell(coord: CellCoord | null): void {
    const nextRow = coord ? coord.rowIndex : null;
    const sameCell =
      this.selectedCell?.rowIndex === coord?.rowIndex &&
      this.selectedCell?.colIndex === coord?.colIndex;
    const sameRow = this.highlightedRowIndex === nextRow;
    if (sameCell && sameRow) return;

    const prevCol = this.selectedCell?.colIndex ?? -1;
    this.selectedCell = coord;
    this.highlightedRowIndex = nextRow;

    const nextCol = coord?.colIndex ?? -1;
    const colChanged = prevCol !== nextCol;
    const needsStatsRefresh =
      colChanged ||
      (this.activeColumnStats.stats === null &&
        !this.activeColumnStats.loading);
    const statsChanged = needsStatsRefresh
      ? this.refreshActiveColumnStats(true)
      : false;

    this.emit(
      statsChanged
        ? ['selection', 'chartHighlight', 'stats']
        : ['selection', 'chartHighlight']
    );
  }

  public highlightRowFromChart(rowIndex: number): void {
    const nextCoord: CellCoord = {
      rowIndex,
      colIndex: this.chartConfig.yColIndices[0] ?? 0,
    };
    const sameCell =
      this.selectedCell?.rowIndex === nextCoord.rowIndex &&
      this.selectedCell?.colIndex === nextCoord.colIndex;
    const sameRow = this.highlightedRowIndex === rowIndex;
    if (sameCell && sameRow) return;

    this.selectedCell = nextCoord;
    this.highlightedRowIndex = rowIndex;
    const statsChanged = this.refreshActiveColumnStats(true);
    this.emit(
      statsChanged
        ? ['selection', 'chartHighlight', 'stats']
        : ['selection', 'chartHighlight']
    );
  }

  public commitCellEdit(
    rowIndex: number,
    colIndex: number,
    value: string
  ): void {
    const prevVersion = this.sheetVersion;
    const changed = this.history.commitCellEdit(rowIndex, colIndex, value);
    if (!changed) return;

    this.nextSheetVersion();
    const nextSheet = this.activeSheet;
    this.worker.notifyCellPatched(
      prevVersion,
      this.sheetVersion,
      rowIndex,
      colIndex,
      value,
      nextSheet.types[colIndex] ?? 'text'
    );

    const needsRequery = this.hasActiveFilterOrSort();
    // Invalidate cached stats only for the edited column; untouched columns remain valid
    this.columnStatsCache.delete(colIndex);
    if (!needsRequery) {
      this.filterSeq++;
    }
    this.refreshActiveColumnStats(true);

    this.lastCellPatch = {rowIndex, colIndex, needsRequery};
    this.emit(['sheetData', 'history', 'stats']);

    if (needsRequery) {
      void this.recomputeVisibleRows();
    }
  }

  public setSearchQueryDebounced(query: string, delayMs = 90): void {
    this.searchQuery = query;
    this.cancelPendingSearchTimer();

    if (this.activeSheet.rows.length < 1000) {
      void this.recomputeVisibleRows();
      return;
    }

    this.searchTimer = globalThis.setTimeout(() => {
      this.searchTimer = null;
      void this.recomputeVisibleRows();
    }, delayMs);
  }

  public clearSearch(): void {
    this.cancelPendingSearchTimer();
    this.searchQuery = '';
    void this.recomputeVisibleRows();
  }

  public toggleSortColumn(colIndex: number): void {
    this.cancelPendingSearchTimer();
    if (this.sort.colIndex !== colIndex) {
      this.sort = {colIndex, direction: 'asc'};
    } else if (this.sort.direction === 'asc') {
      this.sort = {colIndex, direction: 'desc'};
    } else {
      this.sort = {colIndex: null, direction: null};
    }
    void this.recomputeVisibleRows();
  }

  public async recomputeVisibleRows(): Promise<void> {
    this.cancelPendingSearchTimer();
    const seq = ++this.filterSeq;
    const reqVersion = this.sheetVersion;
    const sheet = this.activeSheet;
    const indices = await this.worker.filterAndSort({
      sheet,
      sheetVersion: reqVersion,
      searchQuery: this.searchQuery,
      sort: this.sort,
    });
    // Discard stale results if superseded by another filter/sort or sheet mutation
    if (!indices || seq !== this.filterSeq || reqVersion !== this.sheetVersion) {
      return;
    }
    this.visibleRowIndices = indices;
    this.clearColumnStatsCache();
    this.refreshActiveColumnStats(true);
    this.emit(['visibleRows', 'stats']);
  }

  public addRow(): number {
    this.cancelPendingSearchTimer();
    const nextSheet = addSheetRow(this.activeSheet);
    this.history.commitSheetSnapshot(nextSheet);
    this.nextSheetVersion();
    this.filterSeq++;
    this.worker.invalidateCache();
    this.clearColumnStatsCache();

    const newRowIdx = nextSheet.rows.length - 1;
    this.selectedCell = {rowIndex: newRowIdx, colIndex: 0};
    this.highlightedRowIndex = newRowIdx;

    if (!this.hasActiveFilterOrSort()) {
      this.visibleRowIndices = this.buildSequentialIndices(nextSheet.rows.length);
      this.refreshActiveColumnStats(true);
      this.emit([
        'workbook',
        'sheetData',
        'visibleRows',
        'selection',
        'history',
        'stats',
      ]);
    } else {
      this.refreshActiveColumnStats(true);
      this.emit(['workbook', 'sheetData', 'selection', 'history', 'stats']);
      void this.recomputeVisibleRows();
    }
    return newRowIdx;
  }

  public deleteRow(rowIndex: number): void {
    this.cancelPendingSearchTimer();
    const nextSheet = deleteSheetRow(this.activeSheet, rowIndex);
    this.history.commitSheetSnapshot(nextSheet);
    this.nextSheetVersion();
    this.filterSeq++;
    this.worker.invalidateCache();
    this.clearColumnStatsCache();

    if (this.highlightedRowIndex === rowIndex) {
      this.highlightedRowIndex = null;
    } else if (
      this.highlightedRowIndex !== null &&
      this.highlightedRowIndex > rowIndex
    ) {
      this.highlightedRowIndex -= 1;
    }
    this.selectedCell = null;

    if (!this.hasActiveFilterOrSort()) {
      this.visibleRowIndices = this.buildSequentialIndices(nextSheet.rows.length);
      this.refreshActiveColumnStats(true);
      this.emit([
        'workbook',
        'sheetData',
        'visibleRows',
        'selection',
        'history',
        'stats',
      ]);
    } else {
      // Immediately keep visibleRowIndices valid and index-aligned while async requery confirms
      this.visibleRowIndices = this.adjustVisibleRowsAfterDelete(
        this.visibleRowIndices,
        rowIndex
      );
      this.refreshActiveColumnStats(true);
      this.emit([
        'workbook',
        'sheetData',
        'visibleRows',
        'selection',
        'history',
        'stats',
      ]);
      void this.recomputeVisibleRows();
    }
  }

  public addColumn(): void {
    this.cancelPendingSearchTimer();
    const nextSheet = addSheetColumn(this.activeSheet);
    this.history.commitSheetSnapshot(nextSheet);
    this.nextSheetVersion();
    this.filterSeq++;
    this.worker.invalidateCache();
    this.clearColumnStatsCache();
    this.refreshActiveColumnStats(true);
    this.emit(['workbook', 'sheetData', 'visibleRows', 'history', 'stats']);
    if (this.hasActiveFilterOrSort()) {
      void this.recomputeVisibleRows();
    }
  }

  public renameColumn(colIndex: number, newName: string): void {
    const cur = this.activeSheet;
    const nextSheet = renameSheetColumn(cur, colIndex, newName);
    if (nextSheet !== cur) {
      this.history.commitSheetSnapshot(nextSheet);
      this.nextSheetVersion();
      this.filterSeq++;
      this.worker.invalidateCache();
      this.emit([
        'workbook',
        'sheetData',
        'visibleRows',
        'chartConfig',
        'history',
        'stats',
      ]);
    } else {
      this.emit(['visibleRows']);
    }
  }

  public deleteColumn(colIndex: number): void {
    this.cancelPendingSearchTimer();
    const nextSheet = deleteSheetColumn(this.activeSheet, colIndex);
    this.history.commitSheetSnapshot(nextSheet);
    this.nextSheetVersion();
    this.filterSeq++;
    this.worker.invalidateCache();
    this.clearColumnStatsCache();
    this.selectedCell = null;

    let sortWasInvalidated = false;
    if (this.sort.colIndex !== null) {
      if (this.sort.colIndex === colIndex) {
        this.sort = {colIndex: null, direction: null};
        sortWasInvalidated = true;
      } else if (this.sort.colIndex > colIndex) {
        this.sort = {
          colIndex: this.sort.colIndex - 1,
          direction: this.sort.direction,
        };
      }
    }

    this.chartConfig = suggestChartConfig(nextSheet);

    if (this.hasActiveFilterOrSort() || sortWasInvalidated) {
      if (!this.hasActiveFilterOrSort()) {
        this.visibleRowIndices = this.buildSequentialIndices(nextSheet.rows.length);
      }
      this.refreshActiveColumnStats(true);
      this.emit([
        'workbook',
        'sheetData',
        'visibleRows',
        'selection',
        'chartConfig',
        'history',
        'stats',
      ]);
      if (this.hasActiveFilterOrSort()) {
        void this.recomputeVisibleRows();
      }
    } else {
      this.refreshActiveColumnStats(true);
      this.emit([
        'workbook',
        'sheetData',
        'visibleRows',
        'selection',
        'chartConfig',
        'history',
        'stats',
      ]);
    }
  }

  public setChartConfig(nextConfig: ChartConfig): void {
    this.chartConfig = nextConfig;
    this.emit(['chartConfig']);
  }

  public setSpatialMode(mode: SpatialChartMode): void {
    if (this.chartConfig.spatialMode === mode) return;
    this.chartConfig = {...this.chartConfig, spatialMode: mode};
    this.emit(['chartConfig', 'vizMode']);
  }

  public setLayout(layout: WorkspaceLayout): void {
    this.layout = layout;
    if (layout === 'spatial') {
      this.chartPanelMode = '3d';
    } else if (layout === 'charts') {
      this.chartPanelMode = '2d';
    }
    this.emit(['layout', 'vizMode']);
  }

  public setChartPanelMode(mode: '2d' | '3d'): void {
    if (this.chartPanelMode === mode) return;
    this.chartPanelMode = mode;
    this.emit(['vizMode']);
  }

  public setSimulatorFullscreen(active: boolean): void {
    this.isSimulatorFullscreen = active;
    this.emit(['layout', 'vizMode']);
  }

  public switchSheet(index: number): void {
    if (index < 0 || index >= this.workbook.sheets.length) return;
    if (index === this.workbook.activeSheetIndex) return;

    this.cancelPendingSearchTimer();
    this.history.commitWorkbookSwitch(this.workbook.sheets, index);
    this.nextSheetVersion();
    this.filterSeq++;
    this.worker.invalidateCache();
    this.searchQuery = '';
    this.sort = {colIndex: null, direction: null};
    this.clearColumnStatsCache();

    const sheet = this.activeSheet;
    this.selectedCell =
      sheet.rows.length > 0 ? {rowIndex: 0, colIndex: 0} : null;
    this.highlightedRowIndex = null;
    this.chartConfig = suggestChartConfig(sheet);
    this.visibleRowIndices = this.buildSequentialIndices(sheet.rows.length);
    this.refreshActiveColumnStats(true);

    this.emit([
      'workbook',
      'sheetData',
      'visibleRows',
      'selection',
      'chartConfig',
      'history',
      'stats',
    ]);
  }

  public addNewSheet(): void {
    this.cancelPendingSearchTimer();
    const num = this.workbook.sheets.length + 1;
    const blank = createBlankWorkbook().sheets[0];
    blank.id = `sheet-${Date.now()}`;
    blank.name = `Sheet ${num}`;

    const nextSheets = [...this.workbook.sheets, blank];
    this.history.commitWorkbookSwitch(nextSheets, nextSheets.length - 1);
    this.nextSheetVersion();
    this.filterSeq++;
    this.worker.invalidateCache();
    this.searchQuery = '';
    this.sort = {colIndex: null, direction: null};
    this.clearColumnStatsCache();
    this.chartConfig = suggestChartConfig(blank);
    this.selectedCell = {rowIndex: 0, colIndex: 0};
    this.highlightedRowIndex = null;
    this.visibleRowIndices = this.buildSequentialIndices(blank.rows.length);
    this.refreshActiveColumnStats(true);

    this.emit([
      'workbook',
      'sheetData',
      'visibleRows',
      'selection',
      'chartConfig',
      'history',
      'stats',
    ]);
  }

  public resetWithWorkbook(
    wb: WorkbookState,
    preserveWorkerCache = false
  ): void {
    this.cancelPendingSearchTimer();
    this.history.reset(wb);
    if (!preserveWorkerCache) {
      this.nextSheetVersion();
      this.worker.invalidateCache();
    }
    this.filterSeq++;
    this.searchQuery = '';
    this.sort = {colIndex: null, direction: null};
    this.clearColumnStatsCache();

    const sheet = this.activeSheet;
    this.selectedCell =
      sheet.rows.length > 0 ? {rowIndex: 0, colIndex: 0} : null;
    this.highlightedRowIndex = null;
    this.chartConfig = suggestChartConfig(sheet);
    this.clampChartColumns();
    this.visibleRowIndices = this.buildSequentialIndices(sheet.rows.length);
    this.refreshActiveColumnStats(true);

    this.emit([
      'workbook',
      'sheetData',
      'visibleRows',
      'selection',
      'chartConfig',
      'history',
      'stats',
    ]);
  }

  public undo(): void {
    const prevVersion = this.sheetVersion;
    const res = this.history.undo();
    if (!res) return;
    this.handleHistoryTransition(res.entry, prevVersion, 'undo');
  }

  public redo(): void {
    const prevVersion = this.sheetVersion;
    const res = this.history.redo();
    if (!res) return;
    this.handleHistoryTransition(res.entry, prevVersion, 'redo');
  }

  private handleHistoryTransition(
    entry: ReturnType<WorkbookHistoryManager['undo']> extends infer U
      ? U extends {entry: infer E}
        ? E
        : never
      : never,
    prevVersion: number,
    dir: 'undo' | 'redo'
  ): void {
    this.cancelPendingSearchTimer();
    this.nextSheetVersion();
    this.filterSeq++;

    if (entry.kind === 'cell-patch') {
      const value = dir === 'undo' ? entry.prevValue : entry.nextValue;
      const colType = dir === 'undo' ? entry.prevType : entry.nextType;
      this.worker.notifyCellPatched(
        prevVersion,
        this.sheetVersion,
        entry.rowIndex,
        entry.colIndex,
        value,
        colType
      );
      this.selectedCell = {rowIndex: entry.rowIndex, colIndex: entry.colIndex};
      this.highlightedRowIndex = entry.rowIndex;
      this.columnStatsCache.delete(entry.colIndex);

      const needsRequery = this.hasActiveFilterOrSort();
      this.lastCellPatch = {
        rowIndex: entry.rowIndex,
        colIndex: entry.colIndex,
        needsRequery,
      };
      this.refreshActiveColumnStats(true);
      this.emit(['sheetData', 'selection', 'history', 'stats']);
      if (needsRequery) {
        void this.recomputeVisibleRows();
      }
      return;
    }

    this.worker.invalidateCache();
    this.clearColumnStatsCache();
    this.selectedCell = null;
    this.highlightedRowIndex = null;
    this.clampChartColumns();

    if (!this.hasActiveFilterOrSort()) {
      this.visibleRowIndices = this.buildSequentialIndices(
        this.activeSheet.rows.length
      );
      this.refreshActiveColumnStats(true);
      this.emit([
        'workbook',
        'sheetData',
        'visibleRows',
        'selection',
        'chartConfig',
        'history',
        'stats',
      ]);
    } else {
      // Ensure visibleRowIndices never exceeds current sheet bounds while async requery runs
      this.visibleRowIndices = this.clampVisibleRowIndices(
        this.visibleRowIndices,
        this.activeSheet.rows.length
      );
      this.refreshActiveColumnStats(true);
      this.emit([
        'workbook',
        'sheetData',
        'visibleRows',
        'selection',
        'chartConfig',
        'history',
        'stats',
      ]);
      void this.recomputeVisibleRows();
    }
  }

  private clampChartColumns(): void {
    const maxCol = Math.max(0, this.activeSheet.columns.length - 1);
    const clampedX = Math.min(this.chartConfig.xColIndex, maxCol);
    const validY = this.chartConfig.yColIndices.filter((c) => c <= maxCol);
    if (
      clampedX !== this.chartConfig.xColIndex ||
      validY.length !== this.chartConfig.yColIndices.length
    ) {
      this.chartConfig = {
        ...this.chartConfig,
        xColIndex: clampedX,
        yColIndices: validY.length > 0 ? validY : [Math.min(1, maxCol)],
      };
    }
  }

  public async loadFile(file: File): Promise<void> {
    const loadSeq = ++this.loadFileSeq;
    this.errorMessage = null;
    this.loading = {active: true, message: `Loading ${file.name}…`, progress: 0.1};
    this.emit(['error', 'loading']);

    const reservedVersion = this.nextSheetVersion();
    try {
      const wb = await this.worker.parseFile(
        file,
        reservedVersion,
        (progress, message) => {
          if (loadSeq !== this.loadFileSeq) return;
          this.loading = {active: true, message, progress};
          this.emit(['loading']);
        }
      );
      if (!wb || loadSeq !== this.loadFileSeq) return; // Superseded by newer file load

      this.loading = {active: false, message: '', progress: null};
      const workerCacheMatches = this.sheetVersion === reservedVersion;
      this.resetWithWorkbook(wb, workerCacheMatches);
      this.emit(['loading']);
    } catch (err) {
      if (loadSeq !== this.loadFileSeq) return; // Ignore stale error from superseded load
      this.loading = {active: false, message: '', progress: null};
      this.errorMessage = `Error reading "${file.name}": ${
        err instanceof Error ? err.message : 'Unable to read the selected file.'
      }`;
      this.emit(['loading', 'error']);
    }
  }

  public dismissError(): void {
    this.errorMessage = null;
    this.emit(['error']);
  }

  public dispose(): void {
    this.cancelPendingSearchTimer();
    this.worker.dispose();
  }
}
