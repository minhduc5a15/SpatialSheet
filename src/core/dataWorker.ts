import type {ColumnType, SheetData, SortState, WorkbookState} from '../types';
import {importTabularFile} from './excelIO';
import {filterAndSortRowsBuffer} from './tabular';

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
    };

let cachedSheet: SheetData | null = null;
let cachedVersion = -1;

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
    return;
  }

  if (msg.type === 'patch-cell') {
    if (cachedSheet && cachedVersion === msg.prevVersion) {
      const row = cachedSheet.rows[msg.rowIndex];
      if (row) {
        row[msg.colIndex] = msg.value;
        cachedSheet.types[msg.colIndex] = msg.colType;
        cachedVersion = msg.sheetVersion;
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
    const buffer = indices.buffer as ArrayBuffer;
    const resp: WorkerResponse = {
      type: 'filter-sort-result',
      requestId: msg.requestId,
      sheetVersion: msg.sheetVersion,
      indicesBuffer: buffer,
    };
    (self as unknown as Worker).postMessage(resp, [buffer]);
  }
});
