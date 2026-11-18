import type {
  ColumnStats,
  ColumnType,
  SheetData,
  SortState,
  VisibleRowsSource,
  WorkbookState,
} from '../types';
import {importTabularFile} from './excelIO';
import {computeColumnStats, filterAndSortRowsBuffer} from './tabular';
import type {WorkerRequest, WorkerResponse} from './dataWorker';

export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent<WorkerResponse>) => void): void;
  addEventListener(type: 'error', listener: (ev: ErrorEvent) => void): void;
  terminate(): void;
}

export interface DataWorkerClientOptions {
  createWorker?: () => WorkerLike | null;
}

interface PendingParse {
  requestId: number;
  resolve: (wb: WorkbookState | null) => void;
  reject: (err: Error) => void;
  onProgress?: (progress: number, message: string) => void;
}

interface PendingFilter {
  requestId: number;
  sheetVersion: number;
  resolve: (indices: Int32Array | null) => void;
}

interface PendingStats {
  requestId: number;
  sheetVersion: number;
  colIndex: number;
  resolve: (stats: ColumnStats | null) => void;
}

export function buildFilterKey(searchQuery: string, sort: SortState): string {
  return `${searchQuery.trim().toLowerCase()}\x00${sort.colIndex ?? ''}\x00${sort.direction ?? ''}`;
}

export class DataWorkerClient {
  private worker: WorkerLike | null = null;
  private nextRequestId = 1;
  private latestParseId = 0;
  private latestFilterId = 0;
  private latestStatsId = 0;
  private syncedSheetVersion = -1;
  private syncedFilterKey = '';
  private syncedFilterVersion = -1;
  private pendingParses = new Map<number, PendingParse>();
  private pendingFilters = new Map<number, PendingFilter>();
  private pendingStats = new Map<number, PendingStats>();

  constructor(options?: DataWorkerClientOptions) {
    if (options?.createWorker) {
      try {
        this.worker = options.createWorker();
      } catch {
        this.worker = null;
      }
    } else if (typeof Worker !== 'undefined') {
      try {
        this.worker = new Worker(
          new URL('./dataWorker.ts', import.meta.url),
          {type: 'module'}
        );
      } catch {
        this.worker = null;
      }
    }

    if (this.worker) {
      this.worker.addEventListener('message', (e) =>
        this.handleMessage(e.data)
      );
      this.worker.addEventListener('error', (err) => {
        const message = err?.message || 'Background worker failed.';
        for (const [id, pending] of this.pendingParses) {
          this.pendingParses.delete(id);
          if (id === this.latestParseId) {
            pending.reject(new Error(message));
          } else {
            pending.resolve(null);
          }
        }
        this.settlePendingFiltersAsNull();
        this.settlePendingStatsAsNull();
      });
    }
  }

  public get hasWorker(): boolean {
    return this.worker !== null;
  }

  private settlePendingParsesAsNull(): void {
    for (const [id, pending] of this.pendingParses) {
      this.pendingParses.delete(id);
      pending.resolve(null);
    }
  }

  private settlePendingFiltersAsNull(): void {
    for (const [id, pending] of this.pendingFilters) {
      this.pendingFilters.delete(id);
      pending.resolve(null);
    }
  }

  private settlePendingStatsAsNull(): void {
    for (const [id, pending] of this.pendingStats) {
      this.pendingStats.delete(id);
      pending.resolve(null);
    }
  }

  public async parseFile(
    file: File,
    initialSheetVersion: number,
    onProgress?: (progress: number, message: string) => void
  ): Promise<WorkbookState | null> {
    const requestId = this.nextRequestId++;
    this.latestParseId = requestId;

    // Immediately resolve any superseded parse promises so callers never hang
    this.settlePendingParsesAsNull();

    if (!this.worker) {
      const wb = await importTabularFile(file, onProgress);
      if (this.latestParseId !== requestId) return null;
      return wb;
    }

    return new Promise<WorkbookState | null>((resolve, reject) => {
      this.pendingParses.set(requestId, {
        requestId,
        resolve,
        reject,
        onProgress,
      });

      const msg: WorkerRequest = {
        type: 'parse-file',
        requestId,
        file,
        initialSheetVersion,
      };
      this.worker!.postMessage(msg);
    });
  }

  public notifyCellPatched(
    prevVersion: number,
    sheetVersion: number,
    rowIndex: number,
    colIndex: number,
    value: string,
    colType: ColumnType
  ): void {
    if (!this.worker || this.syncedSheetVersion !== prevVersion) return;
    this.syncedSheetVersion = sheetVersion;
    this.syncedFilterVersion = -1;
    this.syncedFilterKey = '';
    const msg: WorkerRequest = {
      type: 'patch-cell',
      prevVersion,
      sheetVersion,
      rowIndex,
      colIndex,
      value,
      colType,
    };
    this.worker.postMessage(msg);
  }

  public invalidateCache(): void {
    this.syncedSheetVersion = -1;
    this.syncedFilterVersion = -1;
    this.syncedFilterKey = '';
  }

  public async filterAndSort(params: {
    sheet: SheetData;
    sheetVersion: number;
    searchQuery: string;
    sort: SortState;
  }): Promise<Int32Array | null> {
    const requestId = this.nextRequestId++;
    this.latestFilterId = requestId;

    // Resolve all superseded in-flight filter/sort promises with null immediately
    this.settlePendingFiltersAsNull();

    const filterKey = buildFilterKey(params.searchQuery, params.sort);

    // Fast synchronous path for small sheets or plain unfiltered/unsorted loads
    const needsWorker =
      this.worker !== null &&
      params.sheet.rows.length >= 2500 &&
      (params.searchQuery.trim().length > 0 ||
        (params.sort.colIndex !== null && params.sort.direction !== null));

    if (!needsWorker) {
      const result = filterAndSortRowsBuffer(
        params.sheet,
        params.searchQuery,
        params.sort
      );
      if (this.latestFilterId !== requestId) return null;
      return result;
    }

    const needsSheetUpload = this.syncedSheetVersion !== params.sheetVersion;
    if (needsSheetUpload) {
      this.syncedSheetVersion = params.sheetVersion;
    }
    this.syncedFilterVersion = params.sheetVersion;
    this.syncedFilterKey = filterKey;

    return new Promise<Int32Array | null>((resolve) => {
      this.pendingFilters.set(requestId, {
        requestId,
        sheetVersion: params.sheetVersion,
        resolve,
      });

      const msg: WorkerRequest = {
        type: 'filter-sort',
        requestId,
        sheetVersion: params.sheetVersion,
        searchQuery: params.searchQuery,
        sort: params.sort,
        filterKey,
        ...(needsSheetUpload ? {sheet: params.sheet} : {}),
      };
      this.worker!.postMessage(msg);
    });
  }

  public async computeStats(params: {
    sheet: SheetData;
    sheetVersion: number;
    colIndex: number;
    visibleRowIndices: VisibleRowsSource;
    searchQuery: string;
    sort: SortState;
  }): Promise<ColumnStats | null> {
    const requestId = this.nextRequestId++;
    this.latestStatsId = requestId;

    // Resolve any superseded stats requests immediately
    this.settlePendingStatsAsNull();

    const needsWorker =
      this.worker !== null && params.visibleRowIndices.length >= 2500;

    if (!needsWorker) {
      const stats = computeColumnStats(
        params.sheet,
        params.colIndex,
        params.visibleRowIndices
      );
      if (this.latestStatsId !== requestId) return null;
      return stats;
    }

    const filterKey = buildFilterKey(params.searchQuery, params.sort);
    const useAllRows =
      params.searchQuery.trim().length === 0 &&
      (params.sort.colIndex === null || params.sort.direction === null) &&
      params.visibleRowIndices.length === params.sheet.rows.length;

    const needsSheetUpload = this.syncedSheetVersion !== params.sheetVersion;
    if (needsSheetUpload) {
      this.syncedSheetVersion = params.sheetVersion;
    }

    const workerHasMatchingIndices =
      !useAllRows &&
      this.syncedFilterVersion === params.sheetVersion &&
      this.syncedFilterKey === filterKey;

    let visibleCopy: Int32Array | undefined;
    if (!useAllRows && !workerHasMatchingIndices) {
      visibleCopy =
        params.visibleRowIndices instanceof Int32Array
          ? params.visibleRowIndices.slice()
          : Int32Array.from(params.visibleRowIndices);
    }

    return new Promise<ColumnStats | null>((resolve) => {
      this.pendingStats.set(requestId, {
        requestId,
        sheetVersion: params.sheetVersion,
        colIndex: params.colIndex,
        resolve,
      });

      const msg: WorkerRequest = {
        type: 'compute-stats',
        requestId,
        sheetVersion: params.sheetVersion,
        colIndex: params.colIndex,
        filterKey,
        useAllRows,
        ...(visibleCopy ? {visibleRowIndices: visibleCopy} : {}),
        ...(needsSheetUpload ? {sheet: params.sheet} : {}),
      };
      if (visibleCopy) {
        this.worker!.postMessage(msg, [visibleCopy.buffer as ArrayBuffer]);
      } else {
        this.worker!.postMessage(msg);
      }
    });
  }

  private handleMessage(msg: WorkerResponse): void {
    if (msg.type === 'progress') {
      const pending = this.pendingParses.get(msg.requestId);
      if (pending && this.latestParseId === msg.requestId) {
        pending.onProgress?.(msg.progress, msg.message);
      }
      return;
    }

    if (msg.type === 'parsed') {
      const pending = this.pendingParses.get(msg.requestId);
      if (pending) {
        this.pendingParses.delete(msg.requestId);
      }
      if (msg.requestId === this.latestParseId) {
        this.syncedSheetVersion = msg.cachedVersion;
        this.syncedFilterVersion = -1;
        this.syncedFilterKey = '';
        pending?.resolve(msg.workbook);
      } else {
        pending?.resolve(null);
      }
      return;
    }

    if (msg.type === 'parse-error') {
      const pending = this.pendingParses.get(msg.requestId);
      if (pending) {
        this.pendingParses.delete(msg.requestId);
        if (msg.requestId === this.latestParseId) {
          pending.reject(new Error(msg.error));
        } else {
          pending.resolve(null);
        }
      }
      return;
    }

    if (msg.type === 'filter-sort-result') {
      const pending = this.pendingFilters.get(msg.requestId);
      if (pending) {
        this.pendingFilters.delete(msg.requestId);
        if (msg.requestId === this.latestFilterId) {
          pending.resolve(new Int32Array(msg.indicesBuffer));
        } else {
          pending.resolve(null);
        }
      }
      return;
    }

    if (msg.type === 'stats-result') {
      const pending = this.pendingStats.get(msg.requestId);
      if (pending) {
        this.pendingStats.delete(msg.requestId);
        if (msg.requestId === this.latestStatsId) {
          pending.resolve(msg.stats);
        } else {
          pending.resolve(null);
        }
      }
    }
  }

  public dispose(): void {
    this.settlePendingParsesAsNull();
    this.settlePendingFiltersAsNull();
    this.settlePendingStatsAsNull();
    this.worker?.terminate();
    this.worker = null;
  }
}
