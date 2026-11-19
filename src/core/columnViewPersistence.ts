import type {ColumnViewState, WorkbookState} from '../types';
import {normalizeColumnViewState} from './columnView';

export const COLUMN_VIEW_STORAGE_KEY = 'spatialsheet.columnView.v1';
export const MAX_PERSISTED_COLUMN_VIEWS = 24;

interface PersistedLayoutRecord {
  view: ColumnViewState;
  updatedAt: number;
}

interface PersistedLayoutStore {
  version: 1;
  entries: Record<string, PersistedLayoutRecord>;
}

/**
 * Computes a deterministic FNV-1a 32-bit hash over UTF-16 code units.
 *
 * Security & collision notes:
 * - Only hashes workbook filename, sheet name, column count, and normalized column headers.
 *   Cell contents are NEVER included or persisted in localStorage.
 * - Because FNV-1a is a 32-bit non-cryptographic digest, distinct schemas share an extremely low
 *   but non-zero collision probability (~1 in 2^32). To further isolate collisions across files,
 *   the identity string includes explicit fileName, sheetName, columnCount, and schema hash.
 */
export function hashColumnSchema(columns: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i].trim().toLowerCase();
    for (let j = 0; j < col.length; j++) {
      hash ^= col.charCodeAt(j);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= 0x1f;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Returns a deterministic storage identity key for a workbook sheet, or `null` when persistence
 * should be skipped (e.g., blank starter templates or empty column sets).
 */
export function computeSheetLayoutIdentity(params: {
  fileName: string;
  fileFormat: WorkbookState['fileFormat'];
  sheetName: string;
  columns: readonly string[];
}): string | null {
  const {fileName, fileFormat, sheetName, columns} = params;
  if (fileFormat === 'blank' || columns.length === 0) {
    return null;
  }
  const normFile = fileName.trim().toLowerCase() || 'untitled';
  const normSheet = sheetName.trim().toLowerCase() || 'sheet';
  const schemaHash = hashColumnSchema(columns);
  return `v1|${normFile}|${normSheet}|${columns.length}|${schemaHash}`;
}

function getSafeStorage(storage?: Storage | null): Storage | null {
  if (storage !== undefined) return storage;
  try {
    return typeof globalThis.localStorage !== 'undefined'
      ? globalThis.localStorage
      : null;
  } catch {
    return null;
  }
}

function readStore(storage: Storage | null): PersistedLayoutStore {
  const empty: PersistedLayoutStore = {version: 1, entries: {}};
  if (!storage) return empty;

  try {
    const raw = storage.getItem(COLUMN_VIEW_STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as unknown;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      (parsed as {version?: unknown}).version !== 1 ||
      typeof (parsed as {entries?: unknown}).entries !== 'object' ||
      (parsed as {entries?: unknown}).entries === null
    ) {
      return empty;
    }

    const rawEntries = (parsed as {entries: Record<string, unknown>}).entries;
    const sanitized: Record<string, PersistedLayoutRecord> = {};
    for (const [key, rec] of Object.entries(rawEntries)) {
      if (!rec || typeof rec !== 'object') continue;
      const candidate = rec as {view?: unknown; updatedAt?: unknown};
      if (!candidate.view || typeof candidate.view !== 'object') continue;
      const viewObj = candidate.view as Partial<ColumnViewState>;
      if (
        !Array.isArray(viewObj.order) ||
        !Array.isArray(viewObj.hidden) ||
        !Array.isArray(viewObj.pinned) ||
        typeof viewObj.widths !== 'object' ||
        viewObj.widths === null
      ) {
        continue;
      }
      sanitized[key] = {
        view: {
          order: viewObj.order,
          hidden: viewObj.hidden,
          pinned: viewObj.pinned,
          widths: viewObj.widths,
        },
        updatedAt:
          typeof candidate.updatedAt === 'number' &&
          Number.isFinite(candidate.updatedAt)
            ? candidate.updatedAt
            : 0,
      };
    }

    return {version: 1, entries: sanitized};
  } catch {
    return empty;
  }
}

function writeStore(
  storage: Storage | null,
  store: PersistedLayoutStore
): boolean {
  if (!storage) return false;
  try {
    const keys = Object.keys(store.entries);
    if (keys.length > MAX_PERSISTED_COLUMN_VIEWS) {
      keys.sort(
        (a, b) =>
          (store.entries[b]?.updatedAt ?? 0) -
          (store.entries[a]?.updatedAt ?? 0)
      );
      const trimmed: Record<string, PersistedLayoutRecord> = {};
      for (let i = 0; i < MAX_PERSISTED_COLUMN_VIEWS; i++) {
        const k = keys[i];
        trimmed[k] = store.entries[k];
      }
      store = {version: 1, entries: trimmed};
    }
    storage.setItem(COLUMN_VIEW_STORAGE_KEY, JSON.stringify(store));
    return true;
  } catch {
    return false;
  }
}

export function loadPersistedColumnView(
  identity: string | null,
  colCount: number,
  storage?: Storage | null
): ColumnViewState | null {
  if (!identity || colCount <= 0) return null;
  const safeStorage = getSafeStorage(storage);
  const store = readStore(safeStorage);
  const rec = store.entries[identity];
  if (!rec) return null;
  return normalizeColumnViewState(rec.view, colCount);
}

export function savePersistedColumnView(
  identity: string | null,
  view: ColumnViewState,
  colCount: number,
  storage?: Storage | null
): boolean {
  if (!identity || colCount <= 0) return false;
  const safeStorage = getSafeStorage(storage);
  if (!safeStorage) return false;

  const store = readStore(safeStorage);
  store.entries[identity] = {
    view: normalizeColumnViewState(view, colCount),
    updatedAt: Date.now(),
  };
  return writeStore(safeStorage, store);
}

export function clearPersistedColumnView(
  identity: string | null,
  storage?: Storage | null
): boolean {
  if (!identity) return false;
  const safeStorage = getSafeStorage(storage);
  if (!safeStorage) return false;

  try {
    // Verify read access before checking whether the identity is present
    safeStorage.getItem(COLUMN_VIEW_STORAGE_KEY);
  } catch {
    return false;
  }

  const store = readStore(safeStorage);
  if (!(identity in store.entries)) return true;
  delete store.entries[identity];
  return writeStore(safeStorage, store);
}
