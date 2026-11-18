import type {
  AppDomain,
  CellCoord,
  ChartConfig,
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
  createBlankWorkbook,
  deleteSheetColumn,
  deleteSheetRow,
  renameSheetColumn,
  suggestChartConfig,
} from './tabular';
import {DataWorkerClient} from './workerClient';

export type StoreListener = (changed: ReadonlySet<AppDomain>) => void;

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

  // Metadata about last cell patch for O(1) DOM updates
  public lastCellPatch: {
    rowIndex: number;
    colIndex: number;
    needsRequery: boolean;
  } | null = null;

  private subscriptions: Subscription[] = [];
  private searchTimer: number | null = null;
  private filterSeq = 0;

  constructor(initialWorkbook?: WorkbookState) {
    const initial = initialWorkbook ?? createBlankWorkbook();
    this.history = new WorkbookHistoryManager(initial, 50);
    this.worker = new DataWorkerClient();

    const firstSheet = this.activeSheet;
    this.chartConfig = suggestChartConfig(firstSheet);
    this.visibleRowIndices = this.buildSequentialIndices(firstSheet.rows.length);
    this.selectedCell =
      firstSheet.rows.length > 0 ? {rowIndex: 0, colIndex: 0} : null;
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

  private buildSequentialIndices(len: number): Int32Array {
    const arr = new Int32Array(len);
    for (let i = 0; i < len; i++) arr[i] = i;
    return arr;
  }

  private hasActiveFilterOrSort(): boolean {
    return (
      this.searchQuery.trim().length > 0 ||
      (this.sort.colIndex !== null && this.sort.direction !== null)
    );
  }

  public selectCell(coord: CellCoord | null): void {
    const nextRow = coord ? coord.rowIndex : null;
    const sameCell =
      this.selectedCell?.rowIndex === coord?.rowIndex &&
      this.selectedCell?.colIndex === coord?.colIndex;
    const sameRow = this.highlightedRowIndex === nextRow;
    if (sameCell && sameRow) return;

    this.selectedCell = coord;
    this.highlightedRowIndex = nextRow;
    this.emit(['selection', 'chartHighlight']);
  }

  public highlightRowFromChart(rowIndex: number): void {
    const nextCoord: CellCoord = {
      rowIndex,
      colIndex: this.chartConfig.yColIndices[0] ?? 0,
    };
    this.selectedCell = nextCoord;
    this.highlightedRowIndex = rowIndex;
    this.emit(['selection', 'chartHighlight']);
  }

  public commitCellEdit(
    rowIndex: number,
    colIndex: number,
    value: string
  ): void {
    const prevVersion = this.sheetVersion;
    const changed = this.history.commitCellEdit(rowIndex, colIndex, value);
    if (!changed) return;

    this.sheetVersion++;
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
    this.lastCellPatch = {rowIndex, colIndex, needsRequery};
    this.emit(['sheetData', 'history']);

    if (needsRequery) {
      void this.recomputeVisibleRows();
    }
  }

  public setSearchQueryDebounced(query: string, delayMs = 90): void {
    this.searchQuery = query;
    if (this.searchTimer !== null) {
      window.clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }

    if (this.activeSheet.rows.length < 1000) {
      void this.recomputeVisibleRows();
      return;
    }

    this.searchTimer = window.setTimeout(() => {
      this.searchTimer = null;
      void this.recomputeVisibleRows();
    }, delayMs);
  }

  public clearSearch(): void {
    if (this.searchTimer !== null) {
      window.clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    this.searchQuery = '';
    void this.recomputeVisibleRows();
  }

  public toggleSortColumn(colIndex: number): void {
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
    const seq = ++this.filterSeq;
    const sheet = this.activeSheet;
    const indices = await this.worker.filterAndSort({
      sheet,
      sheetVersion: this.sheetVersion,
      searchQuery: this.searchQuery,
      sort: this.sort,
    });
    if (!indices || seq !== this.filterSeq) return;
    this.visibleRowIndices = indices;
    this.emit(['visibleRows']);
  }

  public addRow(): number {
    const nextSheet = addSheetRow(this.activeSheet);
    this.history.commitSheetSnapshot(nextSheet);
    this.sheetVersion++;
    this.worker.invalidateCache();

    const newRowIdx = nextSheet.rows.length - 1;
    this.selectedCell = {rowIndex: newRowIdx, colIndex: 0};
    this.highlightedRowIndex = newRowIdx;

    if (!this.hasActiveFilterOrSort()) {
      this.visibleRowIndices = this.buildSequentialIndices(nextSheet.rows.length);
      this.emit(['workbook', 'sheetData', 'visibleRows', 'selection', 'history']);
    } else {
      this.emit(['workbook', 'sheetData', 'selection', 'history']);
      void this.recomputeVisibleRows();
    }
    return newRowIdx;
  }

  public deleteRow(rowIndex: number): void {
    const nextSheet = deleteSheetRow(this.activeSheet, rowIndex);
    this.history.commitSheetSnapshot(nextSheet);
    this.sheetVersion++;
    this.worker.invalidateCache();

    if (this.highlightedRowIndex === rowIndex) {
      this.highlightedRowIndex = null;
    }
    this.selectedCell = null;

    if (!this.hasActiveFilterOrSort()) {
      this.visibleRowIndices = this.buildSequentialIndices(nextSheet.rows.length);
      this.emit(['workbook', 'sheetData', 'visibleRows', 'selection', 'history']);
    } else {
      this.emit(['workbook', 'sheetData', 'selection', 'history']);
      void this.recomputeVisibleRows();
    }
  }

  public addColumn(): void {
    const nextSheet = addSheetColumn(this.activeSheet);
    this.history.commitSheetSnapshot(nextSheet);
    this.sheetVersion++;
    this.worker.invalidateCache();
    this.emit(['workbook', 'sheetData', 'visibleRows', 'history']);
  }

  public renameColumn(colIndex: number, newName: string): void {
    const cur = this.activeSheet;
    const nextSheet = renameSheetColumn(cur, colIndex, newName);
    if (nextSheet !== cur) {
      this.history.commitSheetSnapshot(nextSheet);
      this.sheetVersion++;
      this.worker.invalidateCache();
      this.emit(['workbook', 'sheetData', 'visibleRows', 'chartConfig', 'history']);
    } else {
      this.emit(['visibleRows']);
    }
  }

  public deleteColumn(colIndex: number): void {
    const nextSheet = deleteSheetColumn(this.activeSheet, colIndex);
    this.history.commitSheetSnapshot(nextSheet);
    this.sheetVersion++;
    this.worker.invalidateCache();
    this.selectedCell = null;
    this.chartConfig = suggestChartConfig(nextSheet);
    this.emit([
      'workbook',
      'sheetData',
      'visibleRows',
      'selection',
      'chartConfig',
      'history',
    ]);
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

    this.history.commitWorkbookSwitch(this.workbook.sheets, index);
    this.sheetVersion++;
    this.worker.invalidateCache();
    this.searchQuery = '';
    this.sort = {colIndex: null, direction: null};

    const sheet = this.activeSheet;
    this.selectedCell =
      sheet.rows.length > 0 ? {rowIndex: 0, colIndex: 0} : null;
    this.highlightedRowIndex = null;
    this.chartConfig = suggestChartConfig(sheet);
    this.visibleRowIndices = this.buildSequentialIndices(sheet.rows.length);

    this.emit([
      'workbook',
      'sheetData',
      'visibleRows',
      'selection',
      'chartConfig',
      'history',
    ]);
  }

  public addNewSheet(): void {
    const num = this.workbook.sheets.length + 1;
    const blank = createBlankWorkbook().sheets[0];
    blank.id = `sheet-${Date.now()}`;
    blank.name = `Sheet ${num}`;

    const nextSheets = [...this.workbook.sheets, blank];
    this.history.commitWorkbookSwitch(nextSheets, nextSheets.length - 1);
    this.sheetVersion++;
    this.worker.invalidateCache();
    this.searchQuery = '';
    this.sort = {colIndex: null, direction: null};
    this.chartConfig = suggestChartConfig(blank);
    this.selectedCell = {rowIndex: 0, colIndex: 0};
    this.highlightedRowIndex = null;
    this.visibleRowIndices = this.buildSequentialIndices(blank.rows.length);

    this.emit([
      'workbook',
      'sheetData',
      'visibleRows',
      'selection',
      'chartConfig',
      'history',
    ]);
  }

  public resetWithWorkbook(wb: WorkbookState): void {
    this.history.reset(wb);
    this.sheetVersion++;
    this.searchQuery = '';
    this.sort = {colIndex: null, direction: null};

    const sheet = this.activeSheet;
    this.selectedCell =
      sheet.rows.length > 0 ? {rowIndex: 0, colIndex: 0} : null;
    this.highlightedRowIndex = null;
    this.chartConfig = suggestChartConfig(sheet);
    this.clampChartColumns();
    this.visibleRowIndices = this.buildSequentialIndices(sheet.rows.length);

    this.emit([
      'workbook',
      'sheetData',
      'visibleRows',
      'selection',
      'chartConfig',
      'history',
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
    this.sheetVersion++;

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
      const needsRequery = this.hasActiveFilterOrSort();
      this.lastCellPatch = {
        rowIndex: entry.rowIndex,
        colIndex: entry.colIndex,
        needsRequery,
      };
      this.emit(['sheetData', 'selection', 'history']);
      if (needsRequery) {
        void this.recomputeVisibleRows();
      }
      return;
    }

    this.worker.invalidateCache();
    this.selectedCell = null;
    this.highlightedRowIndex = null;
    this.clampChartColumns();

    if (!this.hasActiveFilterOrSort()) {
      this.visibleRowIndices = this.buildSequentialIndices(
        this.activeSheet.rows.length
      );
      this.emit([
        'workbook',
        'sheetData',
        'visibleRows',
        'selection',
        'chartConfig',
        'history',
      ]);
    } else {
      this.emit([
        'workbook',
        'sheetData',
        'selection',
        'chartConfig',
        'history',
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
    this.errorMessage = null;
    this.loading = {active: true, message: `Loading ${file.name}…`, progress: 0.1};
    this.emit(['error', 'loading']);

    const nextVersion = this.sheetVersion + 1;
    try {
      const wb = await this.worker.parseFile(
        file,
        nextVersion,
        (progress, message) => {
          this.loading = {active: true, message, progress};
          this.emit(['loading']);
        }
      );
      if (!wb) return; // Superseded by newer file load

      this.loading = {active: false, message: '', progress: null};
      this.sheetVersion = nextVersion - 1; // resetWithWorkbook increments to nextVersion
      this.resetWithWorkbook(wb);
      this.emit(['loading']);
    } catch (err) {
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
    if (this.searchTimer !== null) {
      window.clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    this.worker.dispose();
  }
}
