import type {
  ColumnType,
  SheetData,
  SortState,
  WorkbookState,
} from '../types';
import {importTabularFile} from './excelIO';
import {filterAndSortRowsBuffer} from './tabular';
import type {WorkerRequest, WorkerResponse} from './dataWorker';

interface PendingParse {
  requestId: number;
  resolve: (wb: WorkbookState) => void;
  reject: (err: Error) => void;
  onProgress?: (progress: number, message: string) => void;
}

interface PendingFilter {
  requestId: number;
  sheetVersion: number;
  resolve: (indices: Int32Array) => void;
}

export class DataWorkerClient {
  private worker: Worker | null = null;
  private nextRequestId = 1;
  private latestParseId = 0;
  private latestFilterId = 0;
  private syncedSheetVersion = -1;
  private pendingParse: PendingParse | null = null;
  private pendingFilter: PendingFilter | null = null;

  constructor() {
    if (typeof Worker !== 'undefined') {
      try {
        this.worker = new Worker(
          new URL('./dataWorker.ts', import.meta.url),
          {type: 'module'}
        );
        this.worker.addEventListener('message', (e: MessageEvent<WorkerResponse>) =>
          this.handleMessage(e.data)
        );
        this.worker.addEventListener('error', (err) => {
          if (this.pendingParse) {
            this.pendingParse.reject(
              new Error(err.message || 'Background worker failed.')
            );
            this.pendingParse = null;
          }
        });
      } catch {
        this.worker = null;
      }
    }
  }

  public get hasWorker(): boolean {
    return this.worker !== null;
  }

  public async parseFile(
    file: File,
    initialSheetVersion: number,
    onProgress?: (progress: number, message: string) => void
  ): Promise<WorkbookState | null> {
    const requestId = this.nextRequestId++;
    this.latestParseId = requestId;

    if (!this.worker) {
      const wb = await importTabularFile(file, onProgress);
      if (this.latestParseId !== requestId) return null;
      return wb;
    }

    if (this.pendingParse) {
      // Previous parse superseded — let caller know via null
      this.pendingParse.resolve = () => {};
    }

    return new Promise<WorkbookState | null>((resolve, reject) => {
      this.pendingParse = {
        requestId,
        resolve: (wb) => {
          if (this.latestParseId !== requestId) {
            resolve(null);
            return;
          }
          resolve(wb);
        },
        reject: (err) => {
          if (this.latestParseId !== requestId) {
            resolve(null);
            return;
          }
          reject(err);
        },
        onProgress,
      };

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
  }

  public async filterAndSort(params: {
    sheet: SheetData;
    sheetVersion: number;
    searchQuery: string;
    sort: SortState;
  }): Promise<Int32Array | null> {
    const requestId = this.nextRequestId++;
    this.latestFilterId = requestId;

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

    return new Promise<Int32Array | null>((resolve) => {
      this.pendingFilter = {
        requestId,
        sheetVersion: params.sheetVersion,
        resolve: (indices) => {
          if (this.latestFilterId !== requestId) {
            resolve(null);
            return;
          }
          resolve(indices);
        },
      };

      const msg: WorkerRequest = {
        type: 'filter-sort',
        requestId,
        sheetVersion: params.sheetVersion,
        searchQuery: params.searchQuery,
        sort: params.sort,
        ...(needsSheetUpload ? {sheet: params.sheet} : {}),
      };
      this.worker!.postMessage(msg);
    });
  }

  private handleMessage(msg: WorkerResponse): void {
    if (msg.type === 'progress') {
      if (
        this.pendingParse &&
        this.pendingParse.requestId === msg.requestId &&
        this.latestParseId === msg.requestId
      ) {
        this.pendingParse.onProgress?.(msg.progress, msg.message);
      }
      return;
    }

    if (msg.type === 'parsed') {
      this.syncedSheetVersion = msg.cachedVersion;
      if (this.pendingParse && this.pendingParse.requestId === msg.requestId) {
        const pending = this.pendingParse;
        this.pendingParse = null;
        pending.resolve(msg.workbook);
      }
      return;
    }

    if (msg.type === 'parse-error') {
      if (this.pendingParse && this.pendingParse.requestId === msg.requestId) {
        const pending = this.pendingParse;
        this.pendingParse = null;
        pending.reject(new Error(msg.error));
      }
      return;
    }

    if (msg.type === 'filter-sort-result') {
      if (this.pendingFilter && this.pendingFilter.requestId === msg.requestId) {
        const pending = this.pendingFilter;
        this.pendingFilter = null;
        pending.resolve(new Int32Array(msg.indicesBuffer));
      }
    }
  }

  public dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pendingParse = null;
    this.pendingFilter = null;
  }
}
