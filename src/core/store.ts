import type {
  AppDomain,
  CellCoord,
  ChartConfig,
  ChartRecommendation,
  ColumnStats,
  DatasetProfile,
  DerivedSpatialDataset,
  LoadingState,
  SemanticType,
  SheetData,
  SortState,
  SpatialChartMode,
  SpatialConfig,
  SpatialDataItem,
  VisibleRowsSource,
  WorkbookState,
  WorkspaceLayout,
} from '../types';
import {recommendCharts} from './chartRecommender';
import {
  applyColumnRoleOverride,
  profileDataset,
  reprofileColumn,
} from './dataProfiler';
import {WorkbookHistoryManager} from './history';
import {
  createDefaultSpatialConfig,
  resolveModeSwitchConfig,
  transformSpatialDataset,
} from './spatialTransform';
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
  public datasetProfile!: DatasetProfile;
  public spatialConfig!: SpatialConfig;
  public chartRecommendations: ChartRecommendation[] = [];
  public derivedSpatialData!: DerivedSpatialDataset;
  public selectedSpatialItem: SpatialDataItem | null = null;
  public spatialTransformLoading = false;

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
  private spatialSeq = 0;
  private loadFileSeq = 0;
  private columnStatsCache = new Map<number, ColumnStats>();
  private columnStatsCacheFilterKey = '';
  private derivedSpatialCacheKey = '';
  private spatialStale = false;

  constructor(initialWorkbook?: WorkbookState, worker?: DataWorkerClient) {
    const initial = initialWorkbook ?? createBlankWorkbook();
    this.history = new WorkbookHistoryManager(initial, 50);
    this.worker = worker ?? new DataWorkerClient();

    const firstSheet = this.activeSheet;
    this.chartConfig = suggestChartConfig(firstSheet);
    this.visibleRowIndices = this.buildSequentialIndices(firstSheet.rows.length);
    this.selectedCell =
      firstSheet.rows.length > 0 ? {rowIndex: 0, colIndex: 0} : null;

    this.datasetProfile = profileDataset(firstSheet, this.sheetVersion);
    this.spatialConfig = createDefaultSpatialConfig(
      this.datasetProfile,
      this.chartConfig
    );
    this.chartRecommendations = recommendCharts(this.datasetProfile);
    this.derivedSpatialData = transformSpatialDataset({
      sheet: firstSheet,
      visibleRowIndices: this.visibleRowIndices,
      profile: this.datasetProfile,
      config: this.spatialConfig,
      mode: this.chartConfig.spatialMode,
      yColIndices: this.chartConfig.yColIndices,
    });
    this.derivedSpatialCacheKey = this.buildSpatialCacheKey();

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

  private isSpatialViewActive(): boolean {
    return (
      this.layout === 'spatial' ||
      this.chartPanelMode === '3d' ||
      this.isSimulatorFullscreen
    );
  }

  private buildSpatialCacheKey(): string {
    const cfg = this.spatialConfig;
    const visKey = `${this.visibleRowIndices.length}:${buildFilterKey(this.searchQuery, this.sort)}`;
    const overridesKey = this.datasetProfile.columns
      .map((c) => `${c.colIndex}:${c.roleOverride ?? ''}`)
      .join(',');
    return `${this.sheetVersion}|${visKey}|${overridesKey}|${this.chartConfig.spatialMode}|${this.chartConfig.yColIndices.join(',')}|${cfg.xColIndex}|${cfg.yColIndex}|${cfg.zColIndex ?? ''}|${cfg.groupByColIndex ?? ''}|${cfg.colorColIndex ?? ''}|${cfg.aggregation}|${cfg.sortOrder}|${cfg.topK}|${cfg.samplingStrategy}|${cfg.sampleLimit}|${cfg.scaleType}`;
  }

  private rebuildProfileFull(resetSpatialDefaults: boolean): void {
    const prevOverrides = resetSpatialDefaults
      ? undefined
      : new Map<number, SemanticType>(
          this.datasetProfile.columns
            .filter((c) => c.roleOverride !== undefined)
            .map((c) => [c.colIndex, c.roleOverride!])
        );
    this.datasetProfile = profileDataset(
      this.activeSheet,
      this.sheetVersion,
      prevOverrides
    );
    this.chartRecommendations = recommendCharts(this.datasetProfile);
    if (resetSpatialDefaults) {
      this.spatialConfig = createDefaultSpatialConfig(
        this.datasetProfile,
        this.chartConfig
      );
      this.selectedSpatialItem = null;
    } else {
      this.clampSpatialColumns();
    }
  }

  private clampSpatialColumns(): void {
    const maxCol = Math.max(0, this.activeSheet.columns.length - 1);
    const clampNullable = (v: number | null): number | null =>
      v !== null && v >= 0 && v <= maxCol ? v : null;
    this.spatialConfig = {
      ...this.spatialConfig,
      xColIndex: Math.min(this.spatialConfig.xColIndex, maxCol),
      yColIndex: Math.min(this.spatialConfig.yColIndex, maxCol),
      zColIndex: clampNullable(this.spatialConfig.zColIndex),
      groupByColIndex: clampNullable(this.spatialConfig.groupByColIndex),
      colorColIndex: clampNullable(this.spatialConfig.colorColIndex),
    };
  }

  private reconcileSelectedSpatialItem(): void {
    if (!this.selectedSpatialItem) return;
    const prev = this.selectedSpatialItem;
    const match =
      this.derivedSpatialData.items.find(
        (it) =>
          it.label === prev.label &&
          it.seriesLabel === prev.seriesLabel &&
          it.firstRowIndex === prev.firstRowIndex
      ) ??
      this.derivedSpatialData.items.find(
        (it) => it.label === prev.label && it.seriesLabel === prev.seriesLabel
      ) ??
      null;
    this.selectedSpatialItem = match;
  }

  private refreshDerivedSpatialData(emitOnAsyncComplete = true): boolean {
    const nextKey = this.buildSpatialCacheKey();
    if (nextKey === this.derivedSpatialCacheKey && !this.spatialStale) {
      return false;
    }

    // Defer heavy >=2,500-row spatial aggregation when 3D view is hidden
    if (
      this.visibleRowIndices.length >= 2500 &&
      !this.isSpatialViewActive()
    ) {
      this.spatialStale = true;
      return false;
    }

    if (this.visibleRowIndices.length < 2500) {
      this.spatialStale = false;
      this.spatialTransformLoading = false;
      this.derivedSpatialCacheKey = nextKey;
      this.derivedSpatialData = transformSpatialDataset({
        sheet: this.activeSheet,
        visibleRowIndices: this.visibleRowIndices,
        profile: this.datasetProfile,
        config: this.spatialConfig,
        mode: this.chartConfig.spatialMode,
        yColIndices: this.chartConfig.yColIndices,
      });
      this.reconcileSelectedSpatialItem();
      return true;
    }

    const seq = ++this.spatialSeq;
    const reqVersion = this.sheetVersion;
    const reqVisible = this.visibleRowIndices;
    this.spatialStale = false;
    this.spatialTransformLoading = true;

    void this.worker
      .transformSpatial({
        sheet: this.activeSheet,
        sheetVersion: reqVersion,
        visibleRowIndices: reqVisible,
        searchQuery: this.searchQuery,
        sort: this.sort,
        profile: this.datasetProfile,
        config: this.spatialConfig,
        mode: this.chartConfig.spatialMode,
        yColIndices: this.chartConfig.yColIndices,
      })
      .then((derived) => {
        if (
          !derived ||
          seq !== this.spatialSeq ||
          reqVersion !== this.sheetVersion ||
          reqVisible !== this.visibleRowIndices
        ) {
          return;
        }
        this.spatialTransformLoading = false;
        this.derivedSpatialCacheKey = nextKey;
        this.derivedSpatialData = derived;
        this.reconcileSelectedSpatialItem();
        if (emitOnAsyncComplete) {
          this.emit(['spatialData']);
        }
      });

    return true;
  }

  public ensureSpatialDataFresh(): void {
    if (this.spatialStale) {
      if (this.refreshDerivedSpatialData(true)) {
        this.emit(['spatialData']);
      }
    }
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
    const matchingItem =
      this.derivedSpatialData.items.find(
        (it) =>
          it.firstRowIndex === rowIndex || it.rowIndices.includes(rowIndex)
      ) ?? null;
    this.selectedSpatialItem = matchingItem;

    const statsChanged = this.refreshActiveColumnStats(true);
    this.emit(
      statsChanged
        ? ['selection', 'chartHighlight', 'spatialData', 'stats']
        : ['selection', 'chartHighlight', 'spatialData']
    );
  }

  public selectSpatialItem(item: SpatialDataItem | null): void {
    this.selectedSpatialItem = item;
    if (!item) {
      this.emit(['spatialData']);
      return;
    }

    const targetRow = item.firstRowIndex;
    const targetCol = this.spatialConfig.yColIndex ?? 0;
    this.selectedCell = {rowIndex: targetRow, colIndex: targetCol};
    this.highlightedRowIndex = targetRow;
    const statsChanged = this.refreshActiveColumnStats(true);
    this.emit(
      statsChanged
        ? ['selection', 'chartHighlight', 'spatialData', 'stats']
        : ['selection', 'chartHighlight', 'spatialData']
    );
  }

  public jumpToRow(rowIndex: number): void {
    if (rowIndex < 0 || rowIndex >= this.activeSheet.rows.length) return;
    const colIndex = this.spatialConfig.yColIndex ?? 0;
    this.selectedCell = {rowIndex, colIndex};
    this.highlightedRowIndex = rowIndex;
    const statsChanged = this.refreshActiveColumnStats(true);
    this.emit(
      statsChanged
        ? ['selection', 'chartHighlight', 'stats']
        : ['selection', 'chartHighlight']
    );
  }

  public setSpatialConfig(partial: Partial<SpatialConfig>): void {
    this.spatialConfig = {...this.spatialConfig, ...partial};
    this.clampSpatialColumns();
    this.refreshDerivedSpatialData(true);
    this.emit(['spatialData']);
  }

  public overrideColumnRole(colIndex: number, role: SemanticType | null): void {
    const nextProfile = applyColumnRoleOverride(
      this.datasetProfile,
      colIndex,
      role
    );
    if (nextProfile === this.datasetProfile) return;
    this.datasetProfile = nextProfile;
    this.chartRecommendations = recommendCharts(this.datasetProfile);
    this.refreshDerivedSpatialData(true);
    this.emit(['profile', 'spatialData']);
  }

  public applyRecommendation(rec: ChartRecommendation): void {
    if (rec.targetSurface === '2d') {
      this.chartConfig = {
        ...this.chartConfig,
        ...(rec.suggested2D ?? {}),
        ...(rec.chartType ? {type: rec.chartType} : {}),
      };
      if (rec.suggestedSpatial) {
        this.spatialConfig = {...this.spatialConfig, ...rec.suggestedSpatial};
        this.clampSpatialColumns();
        this.refreshDerivedSpatialData(true);
      }
      this.emit(['chartConfig', 'spatialData']);
      return;
    }

    const nextMode = rec.spatialMode ?? this.chartConfig.spatialMode;
    this.chartConfig = {...this.chartConfig, spatialMode: nextMode};
    this.spatialConfig = {
      ...this.spatialConfig,
      ...(rec.suggestedSpatial ?? {}),
    };
    this.clampSpatialColumns();
    this.selectedSpatialItem = null;
    this.refreshDerivedSpatialData(true);
    this.emit(['chartConfig', 'vizMode', 'spatialData']);
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
    this.datasetProfile = reprofileColumn(
      this.datasetProfile,
      nextSheet,
      colIndex,
      this.sheetVersion
    );
    this.chartRecommendations = recommendCharts(this.datasetProfile);
    this.refreshActiveColumnStats(true);
    if (!needsRequery) {
      this.refreshDerivedSpatialData(true);
    }

    this.lastCellPatch = {rowIndex, colIndex, needsRequery};
    this.emit(['sheetData', 'history', 'stats', 'profile', 'spatialData']);

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
    this.refreshDerivedSpatialData(true);
    this.emit(['visibleRows', 'stats', 'spatialData']);
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

    this.rebuildProfileFull(false);
    if (!this.hasActiveFilterOrSort()) {
      this.visibleRowIndices = this.buildSequentialIndices(nextSheet.rows.length);
      this.refreshActiveColumnStats(true);
      this.refreshDerivedSpatialData(true);
      this.emit([
        'workbook',
        'sheetData',
        'visibleRows',
        'selection',
        'history',
        'stats',
        'profile',
        'spatialData',
      ]);
    } else {
      this.refreshActiveColumnStats(true);
      this.emit([
        'workbook',
        'sheetData',
        'selection',
        'history',
        'stats',
        'profile',
      ]);
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

    this.rebuildProfileFull(false);
    if (!this.hasActiveFilterOrSort()) {
      this.visibleRowIndices = this.buildSequentialIndices(nextSheet.rows.length);
      this.refreshActiveColumnStats(true);
      this.refreshDerivedSpatialData(true);
      this.emit([
        'workbook',
        'sheetData',
        'visibleRows',
        'selection',
        'history',
        'stats',
        'profile',
        'spatialData',
      ]);
    } else {
      // Immediately keep visibleRowIndices valid and index-aligned while async requery confirms
      this.visibleRowIndices = this.adjustVisibleRowsAfterDelete(
        this.visibleRowIndices,
        rowIndex
      );
      this.refreshActiveColumnStats(true);
      this.refreshDerivedSpatialData(true);
      this.emit([
        'workbook',
        'sheetData',
        'visibleRows',
        'selection',
        'history',
        'stats',
        'profile',
        'spatialData',
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
    this.rebuildProfileFull(false);
    this.refreshActiveColumnStats(true);
    this.refreshDerivedSpatialData(true);
    this.emit([
      'workbook',
      'sheetData',
      'visibleRows',
      'history',
      'stats',
      'profile',
      'spatialData',
    ]);
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
      this.datasetProfile = reprofileColumn(
        this.datasetProfile,
        nextSheet,
        colIndex,
        this.sheetVersion
      );
      this.chartRecommendations = recommendCharts(this.datasetProfile);
      this.refreshDerivedSpatialData(true);
      this.emit([
        'workbook',
        'sheetData',
        'visibleRows',
        'chartConfig',
        'history',
        'stats',
        'profile',
        'spatialData',
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
    this.rebuildProfileFull(true);

    if (this.hasActiveFilterOrSort() || sortWasInvalidated) {
      if (!this.hasActiveFilterOrSort()) {
        this.visibleRowIndices = this.buildSequentialIndices(nextSheet.rows.length);
      }
      this.refreshActiveColumnStats(true);
      this.refreshDerivedSpatialData(true);
      this.emit([
        'workbook',
        'sheetData',
        'visibleRows',
        'selection',
        'chartConfig',
        'history',
        'stats',
        'profile',
        'spatialData',
      ]);
      if (this.hasActiveFilterOrSort()) {
        void this.recomputeVisibleRows();
      }
    } else {
      this.refreshActiveColumnStats(true);
      this.refreshDerivedSpatialData(true);
      this.emit([
        'workbook',
        'sheetData',
        'visibleRows',
        'selection',
        'chartConfig',
        'history',
        'stats',
        'profile',
        'spatialData',
      ]);
    }
  }

  public setChartConfig(nextConfig: ChartConfig): void {
    const prevX = this.chartConfig.xColIndex;
    const prevY = this.chartConfig.yColIndices[0];
    this.chartConfig = nextConfig;
    const updatedSpatial: Partial<SpatialConfig> = {};
    if (nextConfig.xColIndex !== prevX) {
      updatedSpatial.xColIndex = nextConfig.xColIndex;
    }
    if (nextConfig.yColIndices[0] !== undefined && nextConfig.yColIndices[0] !== prevY) {
      updatedSpatial.yColIndex = nextConfig.yColIndices[0];
    }
    if (Object.keys(updatedSpatial).length > 0) {
      this.spatialConfig = {...this.spatialConfig, ...updatedSpatial};
    }
    this.refreshDerivedSpatialData(true);
    this.emit(['chartConfig', 'spatialData']);
  }

  public setSpatialMode(mode: SpatialChartMode): void {
    if (this.chartConfig.spatialMode === mode) return;
    this.chartConfig = {...this.chartConfig, spatialMode: mode};
    this.spatialConfig = resolveModeSwitchConfig(
      this.datasetProfile,
      this.spatialConfig,
      mode
    );
    this.selectedSpatialItem = null;
    this.refreshDerivedSpatialData(true);
    this.emit(['chartConfig', 'vizMode', 'spatialData']);
  }

  public setLayout(layout: WorkspaceLayout): void {
    this.layout = layout;
    if (layout === 'spatial') {
      this.chartPanelMode = '3d';
    } else if (layout === 'charts') {
      this.chartPanelMode = '2d';
    }
    this.ensureSpatialDataFresh();
    this.emit(['layout', 'vizMode']);
  }

  public setChartPanelMode(mode: '2d' | '3d'): void {
    if (this.chartPanelMode === mode) return;
    this.chartPanelMode = mode;
    this.ensureSpatialDataFresh();
    this.emit(['vizMode']);
  }

  public setSimulatorFullscreen(active: boolean): void {
    this.isSimulatorFullscreen = active;
    this.ensureSpatialDataFresh();
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
    this.rebuildProfileFull(true);
    this.refreshActiveColumnStats(true);
    this.refreshDerivedSpatialData(true);

    this.emit([
      'workbook',
      'sheetData',
      'visibleRows',
      'selection',
      'chartConfig',
      'history',
      'stats',
      'profile',
      'spatialData',
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
    this.rebuildProfileFull(true);
    this.refreshActiveColumnStats(true);
    this.refreshDerivedSpatialData(true);

    this.emit([
      'workbook',
      'sheetData',
      'visibleRows',
      'selection',
      'chartConfig',
      'history',
      'stats',
      'profile',
      'spatialData',
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
    this.rebuildProfileFull(true);
    this.refreshActiveColumnStats(true);
    this.refreshDerivedSpatialData(true);

    this.emit([
      'workbook',
      'sheetData',
      'visibleRows',
      'selection',
      'chartConfig',
      'history',
      'stats',
      'profile',
      'spatialData',
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
      this.datasetProfile = reprofileColumn(
        this.datasetProfile,
        this.activeSheet,
        entry.colIndex,
        this.sheetVersion
      );
      this.chartRecommendations = recommendCharts(this.datasetProfile);
      this.refreshActiveColumnStats(true);
      if (!needsRequery) {
        this.refreshDerivedSpatialData(true);
      }
      this.emit([
        'sheetData',
        'selection',
        'history',
        'stats',
        'profile',
        'spatialData',
      ]);
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
    this.rebuildProfileFull(false);

    if (!this.hasActiveFilterOrSort()) {
      this.visibleRowIndices = this.buildSequentialIndices(
        this.activeSheet.rows.length
      );
      this.refreshActiveColumnStats(true);
      this.refreshDerivedSpatialData(true);
      this.emit([
        'workbook',
        'sheetData',
        'visibleRows',
        'selection',
        'chartConfig',
        'history',
        'stats',
        'profile',
        'spatialData',
      ]);
    } else {
      // Ensure visibleRowIndices never exceeds current sheet bounds while async requery runs
      this.visibleRowIndices = this.clampVisibleRowIndices(
        this.visibleRowIndices,
        this.activeSheet.rows.length
      );
      this.refreshActiveColumnStats(true);
      this.refreshDerivedSpatialData(true);
      this.emit([
        'workbook',
        'sheetData',
        'visibleRows',
        'selection',
        'chartConfig',
        'history',
        'stats',
        'profile',
        'spatialData',
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
