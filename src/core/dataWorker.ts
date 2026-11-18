import type {
  ColumnStats,
  ColumnType,
  DatasetProfile,
  DerivedSpatialDataset,
  SheetData,
  SortState,
  SpatialChartMode,
  SpatialConfig,
  WorkbookState,
} from '../types';
import {importTabularFile} from './excelIO';
import {transformSpatialDataset} from './spatialTransform';
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
    }
  | {
      type: 'transform-spatial';
      requestId: number;
      sheetVersion: number;
      filterKey: string;
      useAllRows: boolean;
      visibleRowIndices?: Int32Array;
      sheet?: SheetData;
      profile: DatasetProfile;
      config: SpatialConfig;
      mode: SpatialChartMode;
      yColIndices?: number[];
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
    }
  | {
      type: 'spatial-result';
      requestId: number;
      sheetVersion: number;
      filterKey: string;
      derived: DerivedSpatialDataset;
    }
  | {
      type: 'worker-error';
      requestId: number;
      op: 'filter-sort' | 'compute-stats' | 'transform-spatial';
      error: string;
    };

let cachedSheet: SheetData | null = null;
let cachedVersion = -1;
let cachedIndices: Int32Array | null = null;
let cachedIndicesVersion = -1;
let cachedFilterKey = '';

function resolveRowSourceForCachedSheet(
  targetSheet: SheetData,
  msg: {
    sheetVersion: number;
    filterKey: string;
    useAllRows: boolean;
    visibleRowIndices?: Int32Array;
  }
): Int32Array {
  if (msg.useAllRows) {
    const seq = new Int32Array(targetSheet.rows.length);
    for (let i = 0; i < seq.length; i++) seq[i] = i;
    return seq;
  }
  if (msg.visibleRowIndices) {
    cachedIndices = msg.visibleRowIndices;
    cachedIndicesVersion = msg.sheetVersion;
    cachedFilterKey = msg.filterKey;
    return msg.visibleRowIndices;
  }
  if (
    cachedIndices &&
    cachedIndicesVersion === msg.sheetVersion &&
    cachedFilterKey === msg.filterKey
  ) {
    return cachedIndices;
  }
  const fallback = new Int32Array(targetSheet.rows.length);
  for (let i = 0; i < fallback.length; i++) fallback[i] = i;
  return fallback;
}

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
    if (!targetSheet) {
      const resp: WorkerResponse = {
        type: 'worker-error',
        requestId: msg.requestId,
        op: 'filter-sort',
        error: `Worker sheet cache miss for version ${msg.sheetVersion}.`,
      };
      self.postMessage(resp);
      return;
    }

    try {
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
    } catch (err) {
      const resp: WorkerResponse = {
        type: 'worker-error',
        requestId: msg.requestId,
        op: 'filter-sort',
        error: err instanceof Error ? err.message : 'Filter/sort failed.',
      };
      self.postMessage(resp);
    }
    return;
  }

  if (msg.type === 'compute-stats') {
    if (msg.sheet) {
      cachedSheet = msg.sheet;
      cachedVersion = msg.sheetVersion;
    }
    const targetSheet =
      cachedVersion === msg.sheetVersion ? cachedSheet : msg.sheet ?? null;
    if (!targetSheet) {
      const resp: WorkerResponse = {
        type: 'worker-error',
        requestId: msg.requestId,
        op: 'compute-stats',
        error: `Worker sheet cache miss for version ${msg.sheetVersion}.`,
      };
      self.postMessage(resp);
      return;
    }

    try {
      let rowSource: Int32Array | undefined;
      if (!msg.useAllRows) {
        rowSource = resolveRowSourceForCachedSheet(targetSheet, msg);
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
    } catch (err) {
      const resp: WorkerResponse = {
        type: 'worker-error',
        requestId: msg.requestId,
        op: 'compute-stats',
        error: err instanceof Error ? err.message : 'Stats computation failed.',
      };
      self.postMessage(resp);
    }
    return;
  }

  if (msg.type === 'transform-spatial') {
    if (msg.sheet) {
      cachedSheet = msg.sheet;
      cachedVersion = msg.sheetVersion;
    }
    const targetSheet =
      cachedVersion === msg.sheetVersion ? cachedSheet : msg.sheet ?? null;
    if (!targetSheet) {
      const resp: WorkerResponse = {
        type: 'worker-error',
        requestId: msg.requestId,
        op: 'transform-spatial',
        error: `Worker sheet cache miss for version ${msg.sheetVersion}.`,
      };
      self.postMessage(resp);
      return;
    }

    try {
      const rowSource = resolveRowSourceForCachedSheet(targetSheet, msg);
      const derived = transformSpatialDataset({
        sheet: targetSheet,
        visibleRowIndices: rowSource,
        profile: msg.profile,
        config: msg.config,
        mode: msg.mode,
        yColIndices: msg.yColIndices,
      });

      const resp: WorkerResponse = {
        type: 'spatial-result',
        requestId: msg.requestId,
        sheetVersion: msg.sheetVersion,
        filterKey: msg.filterKey,
        derived,
      };
      self.postMessage(resp);
    } catch (err) {
      const resp: WorkerResponse = {
        type: 'worker-error',
        requestId: msg.requestId,
        op: 'transform-spatial',
        error: err instanceof Error ? err.message : 'Spatial transform failed.',
      };
      self.postMessage(resp);
    }
  }
});
