import type {
  ColumnStats,
  ColumnType,
  SheetData,
  SortState,
  WorkbookState,
} from '../types';
import {importTabularFile} from './excelIO';
import {computeColumnStats, filterAndSortRowsBuffer} from './tabular';

export type WorkerRequest =
  | {
      type: 'parse-file';
      requestId: number;
      file: File;
      initialSheetVersion: number;
    }
  | {
      type: 'cache-sheet';
      sheetVersion: number;
      sheet: SheetData;
    }
  | {
      type: 'patch-cell';
      prevVersion: number;
      sheetVersion: number;
      rowIndex: number;
      colIndex: number;
      value: string;
      colType: ColumnType;
    }
  | {
      type: 'filter-sort';
      requestId: number;
      sheetVersion: number;
      searchQuery: string;
      sort: SortState;
      filterKey: string;
      sheet?: SheetData;
    }
  | {
      type: 'compute-stats';
      requestId: number;
      sheetVersion: number;
      colIndex: number;
      filterKey: string;
      useAllRows: boolean;
      visibleRowIndices?: Int32Array;
      sheet?: SheetData;
    };

export type WorkerResponse =
  | {
      type: 'progress';
      requestId: number;
      progress: number;
      message: string;
    }
  | {
      type: 'parsed';
      requestId: number;
      workbook: WorkbookState;
      cachedVersion: number;
    }
  | {
      type: 'parse-error';
      requestId: number;
      error: string;
    }
  | {
      type: 'filter-sort-result';
      requestId: number;
      sheetVersion: number;
      indicesBuffer: ArrayBuffer;
    }
  | {
      type: 'stats-result';
      requestId: number;
      sheetVersion: number;
      colIndex: number;
      filterKey: string;
      stats: ColumnStats;
    };

let cachedSheet: SheetData | null = null;
let cachedVersion = -1;
let cachedIndices: Int32Array | null = null;
let cachedIndicesVersion = -1;
let cachedFilterKey = '';

self.addEventListener('message', async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;

  if (msg.type === 'parse-file') {
    try {
      const workbook = await importTabularFile(
        msg.file,
        (progress, message) => {
          const resp: WorkerResponse = {
            type: 'progress',
            requestId: msg.requestId,
            progress,
            message,
          };
          self.postMessage(resp);
        }
      );

      cachedSheet = workbook.sheets[workbook.activeSheetIndex] ?? null;
      cachedVersion = msg.initialSheetVersion;
      cachedIndices = null;
      cachedIndicesVersion = -1;
      cachedFilterKey = '';

      const resp: WorkerResponse = {
        type: 'parsed',
        requestId: msg.requestId,
        workbook,
        cachedVersion,
      };
      self.postMessage(resp);
    } catch (err) {
      const resp: WorkerResponse = {
        type: 'parse-error',
        requestId: msg.requestId,
        error: err instanceof Error ? err.message : 'Unable to parse file.',
      };
      self.postMessage(resp);
    }
    return;
  }

  if (msg.type === 'cache-sheet') {
    cachedSheet = msg.sheet;
    cachedVersion = msg.sheetVersion;
    cachedIndices = null;
    cachedIndicesVersion = -1;
    cachedFilterKey = '';
    return;
  }

  if (msg.type === 'patch-cell') {
    if (cachedSheet && cachedVersion === msg.prevVersion) {
      const row = cachedSheet.rows[msg.rowIndex];
      if (row) {
        row[msg.colIndex] = msg.value;
        cachedSheet.types[msg.colIndex] = msg.colType;
        cachedVersion = msg.sheetVersion;
        cachedIndices = null;
        cachedIndicesVersion = -1;
        cachedFilterKey = '';
      }
    }
    return;
  }

  if (msg.type === 'filter-sort') {
    if (msg.sheet) {
      cachedSheet = msg.sheet;
      cachedVersion = msg.sheetVersion;
    }
    const targetSheet =
      cachedVersion === msg.sheetVersion ? cachedSheet : msg.sheet ?? null;
    if (!targetSheet) return;

    const indices = filterAndSortRowsBuffer(
      targetSheet,
      msg.searchQuery,
      msg.sort
    );
    cachedIndices = indices;
    cachedIndicesVersion = msg.sheetVersion;
    cachedFilterKey = msg.filterKey;

    const transferCopy = indices.slice();
    const buffer = transferCopy.buffer as ArrayBuffer;
    const resp: WorkerResponse = {
      type: 'filter-sort-result',
      requestId: msg.requestId,
      sheetVersion: msg.sheetVersion,
      indicesBuffer: buffer,
    };
    (self as unknown as Worker).postMessage(resp, [buffer]);
    return;
  }

  if (msg.type === 'compute-stats') {
    if (msg.sheet) {
      cachedSheet = msg.sheet;
      cachedVersion = msg.sheetVersion;
    }
    const targetSheet =
      cachedVersion === msg.sheetVersion ? cachedSheet : msg.sheet ?? null;
    if (!targetSheet) return;

    let rowSource: Int32Array | undefined;
    if (!msg.useAllRows) {
      if (msg.visibleRowIndices) {
        rowSource = msg.visibleRowIndices;
        cachedIndices = msg.visibleRowIndices;
        cachedIndicesVersion = msg.sheetVersion;
        cachedFilterKey = msg.filterKey;
      } else if (
        cachedIndices &&
        cachedIndicesVersion === msg.sheetVersion &&
        cachedFilterKey === msg.filterKey
      ) {
        rowSource = cachedIndices;
      }
    }

    const stats = computeColumnStats(targetSheet, msg.colIndex, rowSource);
    const resp: WorkerResponse = {
      type: 'stats-result',
      requestId: msg.requestId,
      sheetVersion: msg.sheetVersion,
      colIndex: msg.colIndex,
      filterKey: msg.filterKey,
      stats,
    };
    self.postMessage(resp);
  }
});
