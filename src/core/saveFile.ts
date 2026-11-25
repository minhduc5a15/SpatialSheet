import * as XLSX from 'xlsx';
import type {SheetData, WorkbookState} from '../types';
import {buildExcelWorkbookForExport} from './excelIO';
import {serializeCsv, serializeTsv} from './tabular';
import type {ExportFormat} from './fileNaming';

export interface SaveFileWritableLike {
  write(data: Blob | Uint8Array | string): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

export interface SaveFileHandleLike {
  name?: string;
  createWritable(): Promise<SaveFileWritableLike>;
}

export interface SaveFilePickerAcceptType {
  description?: string;
  accept: Record<string, string[]>;
}

export interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: SaveFilePickerAcceptType[];
  excludeAcceptAllOption?: boolean;
}

export type SaveFilePickerFn = (
  options?: SaveFilePickerOptions
) => Promise<SaveFileHandleLike>;

export interface SaveExportRequest {
  workbook: WorkbookState;
  activeSheet: SheetData;
  fileName: string;
  format: ExportFormat;
  preferNativePicker?: boolean;
  /** Optional runtime overrides for deterministic unit tests */
  runtime?: {
    picker?: SaveFilePickerFn | null;
    triggerDownload?: (blob: Blob, fileName: string) => void;
  };
}

export type SaveExportOutcome =
  | {
      status: 'saved';
      fileName: string;
      method: 'native-picker';
    }
  | {
      status: 'download-started';
      fileName: string;
      method: 'download';
    }
  | {
      status: 'cancelled';
      fileName: string;
      method: 'native-picker';
    }
  | {
      status: 'error';
      fileName: string;
      method: 'native-picker' | 'download';
      message: string;
      error?: unknown;
    };

export function getSavePickerFileType(
  format: ExportFormat
): SaveFilePickerAcceptType {
  if (format === 'xlsx') {
    return {
      description: 'Excel Workbook (.xlsx)',
      accept: {
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': [
          '.xlsx',
        ],
      },
    };
  }
  if (format === 'tsv') {
    return {
      description: 'Tab-Separated Values (.tsv)',
      accept: {
        'text/tab-separated-values': ['.tsv'],
      },
    };
  }
  return {
    description: 'Comma-Separated Values (.csv)',
    accept: {
      'text/csv': ['.csv'],
    },
  };
}

export function supportsNativeSaveFilePicker(
  win: Window | undefined = typeof window !== 'undefined' ? window : undefined
): boolean {
  if (!win) return false;
  if (win.isSecureContext === false) return false;
  const candidate = (win as unknown as {showSaveFilePicker?: unknown})
    .showSaveFilePicker;
  return typeof candidate === 'function';
}

function resolveNativeSaveFilePicker(): SaveFilePickerFn | null {
  if (!supportsNativeSaveFilePicker()) return null;
  const win = window as unknown as {showSaveFilePicker: SaveFilePickerFn};
  return (options?: SaveFilePickerOptions) => win.showSaveFilePicker(options);
}

export function createExportBlob(
  workbook: WorkbookState,
  activeSheet: SheetData,
  format: ExportFormat
): Blob {
  if (format === 'xlsx') {
    const wb = buildExcelWorkbookForExport(workbook);
    const data = XLSX.write(wb, {bookType: 'xlsx', type: 'array'}) as ArrayBuffer;
    return new Blob([data], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
  }
  if (format === 'tsv') {
    const tsvContent = '\uFEFF' + serializeTsv(activeSheet);
    return new Blob([tsvContent], {
      type: 'text/tab-separated-values;charset=utf-8;',
    });
  }
  const csvContent = '\uFEFF' + serializeCsv(activeSheet);
  return new Blob([csvContent], {type: 'text/csv;charset=utf-8;'});
}

export function triggerBrowserDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as {name?: unknown}).name;
  return name === 'AbortError';
}

/**
 * Exports workbook or active sheet through native File System Access API when supported,
 * or falls back cleanly to browser download.
 * Note: `picker` is invoked immediately before heavy serialization to preserve transient user activation.
 */
export async function saveExportFile(
  req: SaveExportRequest
): Promise<SaveExportOutcome> {
  const {workbook, activeSheet, fileName, format, preferNativePicker = true} = req;
  const picker =
    req.runtime?.picker !== undefined
      ? req.runtime.picker
      : preferNativePicker
        ? resolveNativeSaveFilePicker()
        : null;

  if (picker) {
    let handle: SaveFileHandleLike;
    try {
      handle = await picker({
        suggestedName: fileName,
        types: [getSavePickerFileType(format)],
        excludeAcceptAllOption: false,
      });
    } catch (err) {
      if (isAbortError(err)) {
        return {status: 'cancelled', fileName, method: 'native-picker'};
      }
      return {
        status: 'error',
        fileName,
        method: 'native-picker',
        message: 'Unable to export the workbook. Please try again.',
        error: err,
      };
    }

    try {
      const blob = createExportBlob(workbook, activeSheet, format);
      const writable = await handle.createWritable();
      let closed = false;
      try {
        await writable.write(blob);
        await writable.close();
        closed = true;
      } finally {
        if (!closed && typeof writable.abort === 'function') {
          await writable.abort().catch(() => {});
        }
      }
      const savedName = handle.name?.trim() || fileName;
      return {
        status: 'saved',
        fileName: savedName,
        method: 'native-picker',
      };
    } catch (err) {
      if (isAbortError(err)) {
        return {status: 'cancelled', fileName, method: 'native-picker'};
      }
      return {
        status: 'error',
        fileName,
        method: 'native-picker',
        message: 'Unable to export the workbook. Please try again.',
        error: err,
      };
    }
  }

  try {
    const blob = createExportBlob(workbook, activeSheet, format);
    const downloader = req.runtime?.triggerDownload ?? triggerBrowserDownload;
    downloader(blob, fileName);
    return {
      status: 'download-started',
      fileName,
      method: 'download',
    };
  } catch (err) {
    return {
      status: 'error',
      fileName,
      method: 'download',
      message: 'Unable to export the workbook. Please try again.',
      error: err,
    };
  }
}

export function getSaveExportOutcomeToast(outcome: SaveExportOutcome): {
  kind: 'success' | 'info' | 'error';
  message: string;
} | null {
  if (outcome.status === 'saved') {
    return {kind: 'success', message: `Saved ${outcome.fileName}`};
  }
  if (outcome.status === 'download-started') {
    return {kind: 'success', message: `Download started: ${outcome.fileName}`};
  }
  if (outcome.status === 'error') {
    return {kind: 'error', message: outcome.message};
  }
  return null;
}
