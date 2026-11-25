import type {
  ColumnType,
  ColumnViewState,
  SemanticType,
  SheetData,
  WorkbookState,
} from '../types';
import {inferSingleColumnType} from './tabular';
import {getWorkbookDisplayName} from './fileNaming';

export interface CellPatchEntry {
  kind: 'cell-patch';
  sheetIndex: number;
  rowIndex: number;
  colIndex: number;
  prevValue: string;
  nextValue: string;
  prevType: ColumnType;
  nextType: ColumnType;
}

export interface ColumnStructuralTransition {
  kind: 'add' | 'delete';
  colIndex: number;
  prevView: ColumnViewState;
  nextView: ColumnViewState;
  deletedRoleOverride?: SemanticType;
}

export interface SheetSnapshotEntry {
  kind: 'sheet-snapshot';
  sheetIndex: number;
  prevSheet: SheetData;
  nextSheet: SheetData;
  prevActiveSheetIndex: number;
  nextActiveSheetIndex: number;
  columnTransition?: ColumnStructuralTransition;
}

export interface WorkbookSwitchEntry {
  kind: 'workbook-switch';
  prevSheets: SheetData[];
  nextSheets: SheetData[];
  prevActiveSheetIndex: number;
  nextActiveSheetIndex: number;
}

export interface WorkbookRenameEntry {
  kind: 'workbook-rename';
  prevName: string;
  nextName: string;
}

export type HistoryEntry =
  | CellPatchEntry
  | SheetSnapshotEntry
  | WorkbookSwitchEntry
  | WorkbookRenameEntry;

/**
 * Patch- and Copy-on-Write-based Undo/Redo history for large workbooks.
 * Single-cell edits store ~80-byte CellPatchEntry objects instead of cloning 100k rows.
 */
export class WorkbookHistoryManager {
  private past: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];
  private present: WorkbookState;
  private maxDepth: number;

  constructor(initial: WorkbookState, maxDepth = 50) {
    this.present = initial;
    this.maxDepth = maxDepth;
  }

  get current(): WorkbookState {
    return this.present;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  get depth(): number {
    return this.past.length;
  }

  private pushEntry(entry: HistoryEntry): void {
    this.past.push(entry);
    if (this.past.length > this.maxDepth) {
      this.past.shift();
    }
    this.future = [];
  }

  /**
   * Commits a single-cell edit in O(1) memory with structural sharing on rows.
   * Returns true if the cell value changed, false if identical.
   */
  commitCellEdit(rowIndex: number, colIndex: number, nextValue: string): boolean {
    const sheetIdx = this.present.activeSheetIndex;
    const sheet = this.present.sheets[sheetIdx];
    if (!sheet) return false;
    if (rowIndex < 0 || rowIndex >= sheet.rows.length) return false;
    if (colIndex < 0 || colIndex >= sheet.columns.length) return false;

    const prevValue = sheet.rows[rowIndex][colIndex] ?? '';
    if (prevValue === nextValue) return false;

    const prevType = sheet.types[colIndex] ?? 'text';
    const nextRows = sheet.rows.slice();
    const nextRow = sheet.rows[rowIndex].slice();
    nextRow[colIndex] = nextValue;
    nextRows[rowIndex] = nextRow;

    const nextType = inferSingleColumnType(nextRows, colIndex);
    const nextTypes =
      nextType === prevType
        ? sheet.types
        : sheet.types.map((t, idx) => (idx === colIndex ? nextType : t));

    const nextSheet: SheetData = {
      ...sheet,
      rows: nextRows,
      types: nextTypes,
    };

    const nextSheets = this.present.sheets.slice();
    nextSheets[sheetIdx] = nextSheet;
    this.present = {
      ...this.present,
      sheets: nextSheets,
    };

    this.pushEntry({
      kind: 'cell-patch',
      sheetIndex: sheetIdx,
      rowIndex,
      colIndex,
      prevValue,
      nextValue,
      prevType,
      nextType,
    });
    return true;
  }

  /** Commits a structural mutation of the active sheet (row/col add/delete/rename) using CoW references. */
  commitSheetSnapshot(
    nextSheet: SheetData,
    options?: {columnTransition?: ColumnStructuralTransition}
  ): void {
    const sheetIdx = this.present.activeSheetIndex;
    const prevSheet = this.present.sheets[sheetIdx];
    if (!prevSheet || prevSheet === nextSheet) return;

    const nextSheets = this.present.sheets.slice();
    nextSheets[sheetIdx] = nextSheet;
    const prevIdx = this.present.activeSheetIndex;

    this.present = {
      ...this.present,
      sheets: nextSheets,
    };

    this.pushEntry({
      kind: 'sheet-snapshot',
      sheetIndex: sheetIdx,
      prevSheet,
      nextSheet,
      prevActiveSheetIndex: prevIdx,
      nextActiveSheetIndex: prevIdx,
      columnTransition: options?.columnTransition,
    });
  }

  /** Switches active sheet or adds a new sheet without cloning row arrays. */
  commitWorkbookSwitch(
    nextSheets: SheetData[],
    nextActiveSheetIndex: number
  ): void {
    const prevSheets = this.present.sheets;
    const prevActiveSheetIndex = this.present.activeSheetIndex;
    this.present = {
      ...this.present,
      sheets: nextSheets,
      activeSheetIndex: nextActiveSheetIndex,
    };
    this.pushEntry({
      kind: 'workbook-switch',
      prevSheets,
      nextSheets,
      prevActiveSheetIndex,
      nextActiveSheetIndex,
    });
  }

  /** Updates the logical workbook name with O(1) history entry. */
  commitWorkbookRename(nextName: string): boolean {
    const prevName = getWorkbookDisplayName(this.present);
    if (prevName === nextName) return false;
    this.present = {
      ...this.present,
      name: nextName,
    };
    this.pushEntry({
      kind: 'workbook-rename',
      prevName,
      nextName,
    });
    return true;
  }

  undo(): {wb: WorkbookState; entry: HistoryEntry} | null {
    if (this.past.length === 0) return null;
    const entry = this.past.pop()!;
    this.future.push(entry);
    this.present = this.applyEntry(this.present, entry, 'undo');
    return {wb: this.present, entry};
  }

  redo(): {wb: WorkbookState; entry: HistoryEntry} | null {
    if (this.future.length === 0) return null;
    const entry = this.future.pop()!;
    this.past.push(entry);
    this.present = this.applyEntry(this.present, entry, 'redo');
    return {wb: this.present, entry};
  }

  reset(initial: WorkbookState): void {
    this.past = [];
    this.future = [];
    this.present = initial;
  }

  private applyEntry(
    wb: WorkbookState,
    entry: HistoryEntry,
    direction: 'undo' | 'redo'
  ): WorkbookState {
    if (entry.kind === 'cell-patch') {
      const targetVal = direction === 'undo' ? entry.prevValue : entry.nextValue;
      const targetType = direction === 'undo' ? entry.prevType : entry.nextType;
      const sheet = wb.sheets[entry.sheetIndex];
      if (!sheet) return wb;

      const nextRows = sheet.rows.slice();
      const nextRow = sheet.rows[entry.rowIndex].slice();
      nextRow[entry.colIndex] = targetVal;
      nextRows[entry.rowIndex] = nextRow;

      const nextTypes =
        sheet.types[entry.colIndex] === targetType
          ? sheet.types
          : sheet.types.map((t, idx) =>
              idx === entry.colIndex ? targetType : t
            );

      const nextSheets = wb.sheets.slice();
      nextSheets[entry.sheetIndex] = {
        ...sheet,
        rows: nextRows,
        types: nextTypes,
      };
      return {
        ...wb,
        activeSheetIndex: entry.sheetIndex,
        sheets: nextSheets,
      };
    }

    if (entry.kind === 'sheet-snapshot') {
      const targetSheet =
        direction === 'undo' ? entry.prevSheet : entry.nextSheet;
      const targetActive =
        direction === 'undo'
          ? entry.prevActiveSheetIndex
          : entry.nextActiveSheetIndex;
      const nextSheets = wb.sheets.slice();
      nextSheets[entry.sheetIndex] = targetSheet;
      return {
        ...wb,
        sheets: nextSheets,
        activeSheetIndex: targetActive,
      };
    }

    if (entry.kind === 'workbook-rename') {
      return {
        ...wb,
        name: direction === 'undo' ? entry.prevName : entry.nextName,
      };
    }

    // workbook-switch
    return {
      ...wb,
      sheets: direction === 'undo' ? entry.prevSheets : entry.nextSheets,
      activeSheetIndex:
        direction === 'undo'
          ? entry.prevActiveSheetIndex
          : entry.nextActiveSheetIndex,
    };
  }
}
