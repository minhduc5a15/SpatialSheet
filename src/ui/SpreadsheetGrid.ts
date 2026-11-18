import type {
  CellCoord,
  ColumnStats,
  ColumnVirtualRange,
  SheetData,
  SortState,
  VirtualRange,
  VisibleRowsSource,
} from '../types';
import {
  columnIndexToLetter,
  computeColumnStats,
  formatDisplayNumber,
} from '../core/tabular';
import {
  computeColumnVirtualWindow,
  computeRowVirtualWindow,
  computeScrollTopForRow,
} from '../core/virtualWindow';
import {svgIcon} from './icons';

export const GRID_ROW_HEIGHT = 36;
const GRID_HEADER_HEIGHT = 38;
const ROW_NUM_COL_WIDTH = 76;
const DEFAULT_OVERSCAN_ROWS = 8;
const DEFAULT_OVERSCAN_COLS = 2;
const COLUMN_VIRTUALIZE_THRESHOLD = 14;
const MAX_DISPLAY_CELL_CHARS = 200;

export interface SpreadsheetCallbacks {
  onCellCommit: (rowIndex: number, colIndex: number, value: string) => void;
  onSelectCell: (coord: CellCoord | null) => void;
  onSortColumn: (colIndex: number) => void;
  onRenameColumn: (colIndex: number, newName: string) => void;
  onDeleteColumn: (colIndex: number) => void;
  onDeleteRow: (rowIndex: number) => void;
  onAddRow: () => void;
  onAddColumn: () => void;
  onClearSearch: () => void;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncateDisplayText(str: string, maxLen = MAX_DISPLAY_CELL_CHARS): string {
  return str.length > maxLen ? `${str.slice(0, maxLen)}…` : str;
}

export class SpreadsheetGrid {
  private container: HTMLElement;
  private callbacks: SpreadsheetCallbacks;
  private sheet: SheetData | null = null;
  private visibleRowIndices: VisibleRowsSource = [];
  private sort: SortState = {colIndex: null, direction: null};
  private selectedCell: CellCoord | null = null;
  private editingCell: CellCoord | null = null;
  private editingColumnIndex: number | null = null;
  private highlightedRowIndex: number | null = null;

  private formulaInputEl: HTMLInputElement | null = null;
  private cellRefEl: HTMLElement | null = null;
  private statsStripEl: HTMLElement | null = null;
  private tableContainerEl: HTMLElement | null = null;

  private tableEl: HTMLTableElement | null = null;
  private colGroupEl: HTMLElement | null = null;
  private theadEl: HTMLElement | null = null;
  private tbodyEl: HTMLElement | null = null;

  private colWidths: number[] = [];
  private totalColsWidth = 0;
  private lastRowRange: VirtualRange | null = null;
  private lastColRange: ColumnVirtualRange | null = null;
  private lastStructureKey = '';
  private scrollRafId = 0;
  private resizeObserver: ResizeObserver | null = null;

  // Caches to avoid re-scanning 100k rows on cell clicks
  private statsCache: {
    sheet: SheetData | null;
    visibleRows: VisibleRowsSource;
    colIndex: number;
    stats: ColumnStats;
  } | null = null;
  private lastStatsCol = -1;
  private lastStatsSheet: SheetData | null = null;
  private lastStatsVisible: VisibleRowsSource | null = null;

  // Track currently committed/escaped input to ignore duplicate focusout
  private activeCellInputCommitted = false;
  private activeColRenameCommitted = false;
  private replaceInitChar: string | undefined = undefined;

  constructor(container: HTMLElement, callbacks: SpreadsheetCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.renderShell();
  }

  private renderShell(): void {
    this.container.innerHTML = `
      <div class="flex flex-col h-full bg-white border border-slate-200 rounded-xl overflow-hidden">
        <!-- Formula & Cell Inspector Bar -->
        <div class="flex flex-wrap sm:flex-nowrap items-center gap-2 px-3 py-2 border-b border-slate-200 bg-slate-50/70">
          <div class="flex items-center gap-1.5 shrink-0">
            <span
              data-role="cell-ref"
              class="font-mono-tabular text-xs font-semibold text-slate-700 bg-white border border-slate-200 rounded px-2 py-1 min-w-[44px] text-center"
              aria-label="Selected cell"
            >--</span>
            <span class="font-mono-tabular text-xs font-semibold text-blue-600 select-none px-1" aria-hidden="true">fx</span>
          </div>
          <input
            type="text"
            data-role="formula-input"
            aria-label="Selected cell value"
            placeholder="Select a cell to view or edit directly..."
            class="order-last sm:order-none w-full sm:w-auto sm:flex-1 min-w-[140px] bg-white border border-slate-200 rounded-md px-2.5 py-1 text-sm text-slate-900 font-mono-tabular focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 disabled:bg-slate-100 disabled:text-slate-400"
            disabled
          />
          <div class="flex items-center gap-1.5 shrink-0 ml-auto sm:ml-0">
            <button
              type="button"
              data-action="add-row"
              class="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              aria-label="Add new row"
            >
              ${svgIcon('plus', 'w-3.5 h-3.5 text-blue-600')}
              <span>Add Row</span>
            </button>
            <button
              type="button"
              data-action="add-col"
              class="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              aria-label="Add new column"
            >
              ${svgIcon('plus', 'w-3.5 h-3.5 text-emerald-600')}
              <span>Add Column</span>
            </button>
          </div>
        </div>

        <!-- Scrollable Virtualized Spreadsheet Table -->
        <div data-role="table-container" class="flex-1 overflow-auto sheet-scroll relative bg-white"></div>

        <!-- Column Quick Stats Footer -->
        <div
          data-role="stats-strip"
          class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-1.5 border-t border-slate-200 bg-slate-50 text-xs text-slate-600 tabular-nums"
        ></div>
      </div>
    `;

    this.formulaInputEl = this.container.querySelector(
      '[data-role="formula-input"]'
    );
    this.cellRefEl = this.container.querySelector('[data-role="cell-ref"]');
    this.tableContainerEl = this.container.querySelector(
      '[data-role="table-container"]'
    );
    this.statsStripEl = this.container.querySelector(
      '[data-role="stats-strip"]'
    );

    const addRowBtn = this.container.querySelector('[data-action="add-row"]');
    const addColBtn = this.container.querySelector('[data-action="add-col"]');
    addRowBtn?.addEventListener('click', () => this.callbacks.onAddRow());
    addColBtn?.addEventListener('click', () => this.callbacks.onAddColumn());

    if (this.formulaInputEl) {
      this.formulaInputEl.addEventListener('keydown', (e) => {
        if (!this.selectedCell) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          this.commitFormulaBar();
          this.moveSelection(1, 0);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          this.syncFormulaBar();
          this.formulaInputEl?.blur();
        }
      });
      this.formulaInputEl.addEventListener('blur', () => {
        if (this.selectedCell) {
          this.commitFormulaBar();
        }
      });
    }

    this.bindDelegatedTableEvents();

    if (this.tableContainerEl && typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        this.scheduleVirtualSync(false);
      });
      this.resizeObserver.observe(this.tableContainerEl);
    }
  }

  private bindDelegatedTableEvents(): void {
    const root = this.tableContainerEl;
    if (!root) return;

    root.addEventListener(
      'scroll',
      () => {
        this.scheduleVirtualSync(false);
      },
      {passive: true}
    );

    root.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      const emptyAction = target.closest<HTMLElement>('[data-empty-action]');
      if (emptyAction) {
        if (emptyAction.dataset.emptyAction === 'add-row') {
          this.callbacks.onAddRow();
        } else if (emptyAction.dataset.emptyAction === 'clear-search') {
          this.callbacks.onClearSearch();
        }
        return;
      }

      const sortBtn = target.closest<HTMLElement>('[data-sort-col]');
      if (sortBtn) {
        this.callbacks.onSortColumn(Number(sortBtn.dataset.sortCol));
        return;
      }

      const delColBtn = target.closest<HTMLElement>('[data-delete-col]');
      if (delColBtn) {
        this.callbacks.onDeleteColumn(Number(delColBtn.dataset.deleteCol));
        return;
      }

      const delRowBtn = target.closest<HTMLElement>('[data-delete-row]');
      if (delRowBtn) {
        this.callbacks.onDeleteRow(Number(delRowBtn.dataset.deleteRow));
        return;
      }

      const cellBtn = target.closest<HTMLElement>('[data-cell]');
      if (cellBtn) {
        const [rStr, cStr] = (cellBtn.dataset.cell ?? '').split(':');
        this.editingCell = null;
        this.callbacks.onSelectCell({
          rowIndex: Number(rStr),
          colIndex: Number(cStr),
        });
      }
    });

    root.addEventListener('dblclick', (e) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      const colTitleBtn = target.closest<HTMLElement>('[data-col-title]');
      if (colTitleBtn) {
        this.editingColumnIndex = Number(colTitleBtn.dataset.colTitle);
        this.activeColRenameCommitted = false;
        this.renderHeader(true);
        const input = root.querySelector<HTMLInputElement>(
          `[data-col-rename="${this.editingColumnIndex}"]`
        );
        input?.focus();
        input?.select();
        return;
      }

      const cellBtn = target.closest<HTMLElement>('[data-cell]');
      if (cellBtn) {
        const [rStr, cStr] = (cellBtn.dataset.cell ?? '').split(':');
        this.startEditing(Number(rStr), Number(cStr));
      }
    });

    root.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      if (target instanceof HTMLInputElement && target.dataset.cellInput) {
        const [rStr, cStr] = target.dataset.cellInput.split(':');
        const rowIndex = Number(rStr);
        const colIndex = Number(cStr);
        if (e.key === 'Enter') {
          e.preventDefault();
          this.commitInlineCellInput(target, rowIndex, colIndex);
          this.moveSelection(1, 0);
        } else if (e.key === 'Tab') {
          e.preventDefault();
          this.commitInlineCellInput(target, rowIndex, colIndex);
          this.moveSelection(0, e.shiftKey ? -1 : 1);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          this.activeCellInputCommitted = true;
          this.editingCell = null;
          this.renderVirtualWindow(true);
          this.focusCellButton(rowIndex, colIndex);
        }
        return;
      }

      if (target instanceof HTMLInputElement && target.dataset.colRename) {
        const colIdx = Number(target.dataset.colRename);
        if (e.key === 'Enter') {
          e.preventDefault();
          this.commitColRenameInput(target, colIdx);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          this.activeColRenameCommitted = true;
          this.editingColumnIndex = null;
          this.renderHeader(true);
        }
        return;
      }

      const cellBtn = target.closest<HTMLElement>('[data-cell]');
      if (cellBtn) {
        const [rStr, cStr] = (cellBtn.dataset.cell ?? '').split(':');
        const rowIndex = Number(rStr);
        const colIndex = Number(cStr);

        if (e.key === 'Enter' || e.key === 'F2') {
          e.preventDefault();
          this.startEditing(rowIndex, colIndex);
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          this.moveSelection(1, 0);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          this.moveSelection(-1, 0);
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          this.moveSelection(0, 1);
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          this.moveSelection(0, -1);
        } else if (
          e.key.length === 1 &&
          !e.ctrlKey &&
          !e.metaKey &&
          !e.altKey
        ) {
          e.preventDefault();
          this.startEditing(rowIndex, colIndex, e.key);
        }
      }
    });

    root.addEventListener('focusout', (e) => {
      const target = e.target as HTMLElement | null;
      if (!(target instanceof HTMLInputElement)) return;

      if (target.dataset.cellInput && !this.activeCellInputCommitted) {
        const [rStr, cStr] = target.dataset.cellInput.split(':');
        this.commitInlineCellInput(target, Number(rStr), Number(cStr));
      } else if (target.dataset.colRename && !this.activeColRenameCommitted) {
        this.commitColRenameInput(target, Number(target.dataset.colRename));
      }
    });
  }

  private commitInlineCellInput(
    input: HTMLInputElement,
    rowIndex: number,
    colIndex: number
  ): void {
    if (this.activeCellInputCommitted) return;
    this.activeCellInputCommitted = true;
    const val = input.value;
    this.editingCell = null;
    this.callbacks.onCellCommit(rowIndex, colIndex, val);
  }

  private commitColRenameInput(input: HTMLInputElement, colIdx: number): void {
    if (this.activeColRenameCommitted) return;
    this.activeColRenameCommitted = true;
    const val = input.value;
    this.editingColumnIndex = null;
    this.callbacks.onRenameColumn(colIdx, val);
  }

  private commitFormulaBar(): void {
    if (!this.selectedCell || !this.formulaInputEl || !this.sheet) return;
    const {rowIndex, colIndex} = this.selectedCell;
    const currentVal = this.sheet.rows[rowIndex]?.[colIndex] ?? '';
    const nextVal = this.formulaInputEl.value;
    if (nextVal !== currentVal) {
      this.callbacks.onCellCommit(rowIndex, colIndex, nextVal);
    }
  }

  /**
   * Full data / filter / sort / structural update.
   * Recomputes column widths only when sheet structure changes; renders only the virtual window.
   */
  public setData(params: {
    sheet: SheetData;
    visibleRowIndices: VisibleRowsSource;
    sort: SortState;
    selectedCell: CellCoord | null;
    highlightedRowIndex: number | null;
  }): void {
    const sheetChanged = this.sheet !== params.sheet;
    const visibleChanged = this.visibleRowIndices !== params.visibleRowIndices;
    const sortChanged =
      this.sort.colIndex !== params.sort.colIndex ||
      this.sort.direction !== params.sort.direction;

    this.sheet = params.sheet;
    this.visibleRowIndices = params.visibleRowIndices;
    this.sort = params.sort;
    this.selectedCell = params.selectedCell;
    this.highlightedRowIndex = params.highlightedRowIndex;

    if (
      this.editingCell &&
      (this.editingCell.rowIndex >= params.sheet.rows.length ||
        this.editingCell.colIndex >= params.sheet.columns.length)
    ) {
      this.editingCell = null;
    }

    if (sheetChanged || visibleChanged) {
      this.statsCache = null;
    }

    const structKey = `${params.sheet.id}:${params.sheet.columns.length}:${params.sheet.columns.join('\x00')}`;
    if (structKey !== this.lastStructureKey) {
      this.lastStructureKey = structKey;
      this.computeColumnWidths();
      if (this.tableContainerEl && sheetChanged) {
        this.tableContainerEl.scrollTop = 0;
        this.tableContainerEl.scrollLeft = 0;
      }
    }

    this.renderTableStructureAndWindow(
      sheetChanged || visibleChanged || sortChanged || true
    );
    this.syncFormulaBar();
    this.renderStatsStrip();
  }

  /**
   * Fast-path for cell selection and row highlight changes (Phase 1 + Phase 2).
   * Toggles CSS classes directly on visible DOM nodes without rebuilding the table or header.
   */
  public setSelection(
    selectedCell: CellCoord | null,
    highlightedRowIndex: number | null
  ): void {
    const prevCol = this.selectedCell?.colIndex ?? -1;
    const nextCol = selectedCell?.colIndex ?? -1;

    this.selectedCell = selectedCell;
    this.highlightedRowIndex = highlightedRowIndex;

    this.updateSelectionDomClasses();
    this.syncFormulaBar();

    if (prevCol !== nextCol || this.statsCache === null) {
      this.renderStatsStrip();
    }
  }

  /**
   * Updates only a single visible cell's text & stats without discarding the DOM table.
   */
  public updateSingleCellInPlace(
    nextSheet: SheetData,
    rowIndex: number,
    colIndex: number
  ): void {
    const oldTypes = this.sheet?.types;
    this.sheet = nextSheet;
    this.statsCache = null;

    if (oldTypes && oldTypes[colIndex] !== nextSheet.types[colIndex]) {
      this.renderHeader(true);
    }

    if (this.tbodyEl) {
      const btn = this.tbodyEl.querySelector<HTMLButtonElement>(
        `[data-cell="${rowIndex}:${colIndex}"]`
      );
      const val = nextSheet.rows[rowIndex]?.[colIndex] ?? '';
      const colType = nextSheet.types[colIndex] ?? 'text';
      const isNum = colType === 'number' || colType === 'percent';

      if (btn) {
        btn.classList.toggle('text-right', isNum);
        btn.classList.toggle('font-mono-tabular', isNum);
        btn.classList.toggle('text-left', !isNum);
        btn.textContent = truncateDisplayText(val);
        btn.setAttribute(
          'aria-label',
          `Cell ${columnIndexToLetter(colIndex)}${rowIndex + 1}`
        );
      } else {
        const input = this.tbodyEl.querySelector<HTMLInputElement>(
          `[data-cell-input="${rowIndex}:${colIndex}"]`
        );
        const td = input?.closest('td');
        if (td) {
          const alignClass = isNum
            ? 'text-right font-mono-tabular'
            : 'text-left';
          const isSelected =
            this.selectedCell?.rowIndex === rowIndex &&
            this.selectedCell?.colIndex === colIndex;
          td.className = `border-b border-r border-slate-200 p-0 ${
            isSelected ? 'ring-2 ring-inset ring-blue-500 bg-blue-50/40' : ''
          }`;
          if (isSelected) td.setAttribute('data-selected', '1');
          else td.removeAttribute('data-selected');
          td.innerHTML = `<button type="button" data-cell="${rowIndex}:${colIndex}" aria-label="Cell ${columnIndexToLetter(colIndex)}${rowIndex + 1}" class="w-full h-full px-2 text-sm text-slate-800 hover:bg-slate-100/70 focus:outline-none truncate block cursor-cell ${alignClass}">${escapeHtml(truncateDisplayText(val))}</button>`;
        }
      }
    }

    this.syncFormulaBar();
    this.renderStatsStrip();
  }

  public scrollToRow(rowIndex: number): void {
    if (!this.tableContainerEl || !this.sheet) return;
    const displayIdx = this.findDisplayIndex(rowIndex);
    if (displayIdx < 0) return;

    const nextTop = computeScrollTopForRow({
      displayIndex: displayIdx,
      rowHeight: GRID_ROW_HEIGHT,
      currentScrollTop: this.tableContainerEl.scrollTop,
      viewportHeight: this.tableContainerEl.clientHeight || 420,
      headerHeight: GRID_HEADER_HEIGHT,
    });

    if (nextTop !== null) {
      this.tableContainerEl.scrollTop = nextTop;
    }
    this.renderVirtualWindow(true);
  }

  private findDisplayIndex(rowIndex: number): number {
    const vis = this.visibleRowIndices;
    if (
      rowIndex >= 0 &&
      rowIndex < vis.length &&
      vis[rowIndex] === rowIndex
    ) {
      return rowIndex;
    }
    for (let i = 0; i < vis.length; i++) {
      if (vis[i] === rowIndex) return i;
    }
    return -1;
  }

  private computeColumnWidths(): void {
    if (!this.sheet) {
      this.colWidths = [];
      this.totalColsWidth = 0;
      return;
    }
    const cols = this.sheet.columns;
    const rows = this.sheet.rows;
    const sampleLimit = Math.min(rows.length, 24);
    const widths = new Array<number>(cols.length);
    let sum = 0;

    for (let c = 0; c < cols.length; c++) {
      let maxLen = cols[c].length;
      for (let r = 0; r < sampleLimit; r++) {
        const len = Math.min(28, (rows[r]?.[c] ?? '').length);
        if (len > maxLen) maxLen = len;
      }
      const headerWidth = cols[c].length * 7.2 + 106;
      const w = Math.max(164, headerWidth, Math.min(250, maxLen * 7.5 + 68));
      widths[c] = Math.round(w);
      sum += widths[c];
    }

    this.colWidths = widths;
    this.totalColsWidth = sum;
  }

  private scheduleVirtualSync(force: boolean): void {
    if (this.scrollRafId) return;
    this.scrollRafId = requestAnimationFrame(() => {
      this.scrollRafId = 0;
      this.renderVirtualWindow(force);
    });
  }

  private updateSelectionDomClasses(): void {
    if (!this.tbodyEl) return;

    // Clear previous selection rings
    this.tbodyEl
      .querySelectorAll<HTMLElement>('td[data-selected="1"]')
      .forEach((td) => {
        td.removeAttribute('data-selected');
        td.classList.remove('ring-2', 'ring-inset', 'ring-blue-500', 'bg-blue-50/40');
      });

    // Clear previous row highlights
    this.tbodyEl
      .querySelectorAll<HTMLElement>('tr[data-highlighted="1"]')
      .forEach((tr) => {
        tr.removeAttribute('data-highlighted');
        tr.classList.remove('bg-blue-50/80');
        const disp = Number(tr.dataset.dispIdx ?? 0);
        tr.classList.add(disp % 2 === 1 ? 'bg-slate-50/40' : 'bg-white');
      });

    if (this.highlightedRowIndex !== null) {
      const tr = this.tbodyEl.querySelector<HTMLElement>(
        `tr[data-row-index="${this.highlightedRowIndex}"]`
      );
      if (tr) {
        tr.setAttribute('data-highlighted', '1');
        tr.classList.remove('bg-white', 'bg-slate-50/40');
        tr.classList.add('bg-blue-50/80');
      }
    }

    if (this.selectedCell) {
      const btn = this.tbodyEl.querySelector<HTMLElement>(
        `[data-cell="${this.selectedCell.rowIndex}:${this.selectedCell.colIndex}"]`
      );
      const td = btn?.closest('td');
      if (td) {
        td.setAttribute('data-selected', '1');
        td.classList.add('ring-2', 'ring-inset', 'ring-blue-500', 'bg-blue-50/40');
      }
    }
  }

  private syncFormulaBar(): void {
    if (!this.formulaInputEl || !this.cellRefEl || !this.sheet) return;

    if (!this.selectedCell) {
      this.cellRefEl.textContent = '--';
      this.formulaInputEl.value = '';
      this.formulaInputEl.disabled = true;
      return;
    }

    const {rowIndex, colIndex} = this.selectedCell;
    if (
      rowIndex < 0 ||
      rowIndex >= this.sheet.rows.length ||
      colIndex < 0 ||
      colIndex >= this.sheet.columns.length
    ) {
      this.cellRefEl.textContent = '--';
      this.formulaInputEl.value = '';
      this.formulaInputEl.disabled = true;
      return;
    }

    this.cellRefEl.textContent = `${columnIndexToLetter(colIndex)}${rowIndex + 1}`;
    this.formulaInputEl.disabled = false;
    this.formulaInputEl.value = this.sheet.rows[rowIndex][colIndex] ?? '';
  }

  private renderStatsStrip(): void {
    if (!this.statsStripEl || !this.sheet) return;
    const totalRows = this.sheet.rows.length;
    const visibleCount = this.visibleRowIndices.length;

    const activeCol = this.selectedCell?.colIndex ?? this.findFirstNumericCol();
    if (
      this.lastStatsSheet === this.sheet &&
      this.lastStatsVisible === this.visibleRowIndices &&
      this.lastStatsCol === activeCol &&
      this.statsCache
    ) {
      return;
    }

    const colName = this.sheet.columns[activeCol] ?? '';
    let stats: ColumnStats | null = null;
    if (activeCol >= 0 && activeCol < this.sheet.columns.length) {
      if (
        this.statsCache &&
        this.statsCache.sheet === this.sheet &&
        this.statsCache.visibleRows === this.visibleRowIndices &&
        this.statsCache.colIndex === activeCol
      ) {
        stats = this.statsCache.stats;
      } else {
        stats = computeColumnStats(
          this.sheet,
          activeCol,
          this.visibleRowIndices
        );
        this.statsCache = {
          sheet: this.sheet,
          visibleRows: this.visibleRowIndices,
          colIndex: activeCol,
          stats,
        };
      }
    }

    this.lastStatsSheet = this.sheet;
    this.lastStatsVisible = this.visibleRowIndices;
    this.lastStatsCol = activeCol;

    const leftText =
      visibleCount === totalRows
        ? `${totalRows.toLocaleString('en-US')} rows · ${this.sheet.columns.length} cols`
        : `Showing ${visibleCount.toLocaleString('en-US')} of ${totalRows.toLocaleString('en-US')} rows · ${this.sheet.columns.length} cols`;

    let rightHtml = '';
    if (stats && stats.numericCount > 0) {
      const colType = this.sheet.types[activeCol] ?? 'number';
      rightHtml = `
        <div class="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono-tabular text-slate-700">
          <span class="text-slate-500 font-sans">${escapeHtml(colName)}:</span>
          <span>Sum <strong class="font-semibold text-slate-900">${formatDisplayNumber(stats.sum, colType)}</strong></span>
          <span aria-hidden="true" class="text-slate-300">·</span>
          <span>Avg <strong class="font-semibold text-slate-900">${formatDisplayNumber(stats.avg, colType)}</strong></span>
          <span aria-hidden="true" class="text-slate-300">·</span>
          <span>Min ${formatDisplayNumber(stats.min, colType)}</span>
          <span aria-hidden="true" class="text-slate-300">·</span>
          <span>Max ${formatDisplayNumber(stats.max, colType)}</span>
        </div>
      `;
    } else if (stats) {
      rightHtml = `
        <div class="text-slate-500">
          <span>${escapeHtml(colName)}: ${stats.nonEmptyCount.toLocaleString('en-US')} values · ${stats.uniqueCount.toLocaleString('en-US')} unique</span>
        </div>
      `;
    }

    this.statsStripEl.innerHTML = `
      <span class="text-slate-500">${leftText}</span>
      ${rightHtml}
    `;
  }

  private findFirstNumericCol(): number {
    if (!this.sheet) return 0;
    const idx = this.sheet.types.findIndex(
      (t) => t === 'number' || t === 'percent'
    );
    return idx >= 0 ? idx : 0;
  }

  private renderTableStructureAndWindow(force: boolean): void {
    if (!this.tableContainerEl || !this.sheet) return;
    const sheet = this.sheet;

    if (sheet.rows.length === 0) {
      this.clearTableRefs();
      this.tableContainerEl.innerHTML = `
        <div class="flex flex-col items-center justify-center h-full min-h-[260px] p-8 text-center">
          <p class="text-sm font-medium text-slate-900">This sheet has no rows yet</p>
          <p class="text-xs text-slate-500 mt-1">Click below to add the first row or open a CSV / Excel file.</p>
          <button
            type="button"
            data-empty-action="add-row"
            class="mt-4 inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors cursor-pointer"
          >
            ${svgIcon('plus', 'w-3.5 h-3.5')}
            <span>Add first row</span>
          </button>
        </div>
      `;
      return;
    }

    if (this.visibleRowIndices.length === 0) {
      this.clearTableRefs();
      this.tableContainerEl.innerHTML = `
        <div class="flex flex-col items-center justify-center h-full min-h-[260px] p-8 text-center">
          <p class="text-sm font-medium text-slate-900">No rows match your search</p>
          <p class="text-xs text-slate-500 mt-1">Try a different keyword or clear the current filter.</p>
          <button
            type="button"
            data-empty-action="clear-search"
            class="mt-4 inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
          >
            <span>Clear filter</span>
          </button>
        </div>
      `;
      return;
    }

    this.ensureTableMounted();
    this.renderVirtualWindow(force);
  }

  private clearTableRefs(): void {
    this.tableEl = null;
    this.colGroupEl = null;
    this.theadEl = null;
    this.tbodyEl = null;
    this.lastRowRange = null;
    this.lastColRange = null;
  }

  private ensureTableMounted(): void {
    if (!this.tableContainerEl) return;
    if (this.tableEl && this.tableEl.parentElement === this.tableContainerEl) {
      return;
    }

    this.tableContainerEl.innerHTML = `
      <table class="border-collapse text-sm" style="table-layout:fixed;min-width:100%" role="grid" aria-label="Editable spreadsheet grid">
        <colgroup></colgroup>
        <thead></thead>
        <tbody></tbody>
      </table>
    `;
    this.tableEl = this.tableContainerEl.querySelector('table');
    this.colGroupEl = this.tableContainerEl.querySelector('colgroup');
    this.theadEl = this.tableContainerEl.querySelector('thead');
    this.tbodyEl = this.tableContainerEl.querySelector('tbody');
    this.lastRowRange = null;
    this.lastColRange = null;
  }

  private computeCurrentRanges(): {
    rowRange: VirtualRange;
    colRange: ColumnVirtualRange;
  } {
    const root = this.tableContainerEl;
    const totalRows = this.visibleRowIndices.length;
    const totalCols = this.sheet?.columns.length ?? 0;
    const scrollTop = root?.scrollTop ?? 0;
    const scrollLeft = root?.scrollLeft ?? 0;
    const viewportHeight = root?.clientHeight || 480;
    const viewportWidth = root?.clientWidth || 720;

    const rowRange = computeRowVirtualWindow({
      totalRows,
      scrollTop: Math.max(0, scrollTop - GRID_HEADER_HEIGHT),
      viewportHeight,
      rowHeight: GRID_ROW_HEIGHT,
      overscan: DEFAULT_OVERSCAN_ROWS,
    });

    const colRange = computeColumnVirtualWindow({
      totalCols,
      scrollLeft,
      viewportWidth,
      colWidths: this.colWidths,
      fixedLeftWidth: ROW_NUM_COL_WIDTH,
      overscan: DEFAULT_OVERSCAN_COLS,
      virtualizeThreshold: COLUMN_VIRTUALIZE_THRESHOLD,
    });

    return {rowRange, colRange};
  }

  private renderVirtualWindow(force: boolean): void {
    if (!this.sheet || !this.tableEl || !this.tbodyEl) return;

    const {rowRange, colRange} = this.computeCurrentRanges();

    const rowRangeSame =
      !force &&
      this.lastRowRange !== null &&
      this.lastRowRange.start === rowRange.start &&
      this.lastRowRange.end === rowRange.end &&
      this.lastRowRange.total === rowRange.total;

    const colRangeSame =
      !force &&
      this.lastColRange !== null &&
      this.lastColRange.start === colRange.start &&
      this.lastColRange.end === colRange.end &&
      this.lastColRange.virtualized === colRange.virtualized;

    if (rowRangeSame && colRangeSame) {
      return;
    }

    if (!colRangeSame || force) {
      this.lastColRange = colRange;
      this.renderColGroup(colRange);
      this.renderHeader(false, colRange);
    }

    this.lastRowRange = rowRange;
    this.renderBodySlice(rowRange, colRange);
  }

  private renderColGroup(colRange: ColumnVirtualRange): void {
    if (!this.colGroupEl || !this.tableEl) return;

    const totalW = ROW_NUM_COL_WIDTH + this.totalColsWidth;
    this.tableEl.style.width = `${totalW}px`;

    const parts: string[] = [`<col style="width:${ROW_NUM_COL_WIDTH}px" />`];
    if (colRange.leftWidth > 0) {
      parts.push(`<col style="width:${colRange.leftWidth}px" />`);
    }
    for (let c = colRange.start; c < colRange.end; c++) {
      parts.push(`<col style="width:${this.colWidths[c] ?? 150}px" />`);
    }
    if (colRange.rightWidth > 0) {
      parts.push(`<col style="width:${colRange.rightWidth}px" />`);
    }
    this.colGroupEl.innerHTML = parts.join('');
  }

  private renderHeader(forceFocus: boolean, colRange?: ColumnVirtualRange): void {
    if (!this.theadEl || !this.sheet) return;
    const sheet = this.sheet;
    const range = colRange ?? this.lastColRange ?? this.computeCurrentRanges().colRange;

    const headerCells: string[] = [];
    if (range.leftWidth > 0) {
      headerCells.push(
        `<th scope="col" aria-hidden="true" class="sticky top-0 z-10 bg-slate-100/95 border-b border-slate-200 p-0"></th>`
      );
    }

    for (let colIdx = range.start; colIdx < range.end; colIdx++) {
      const colName = sheet.columns[colIdx];
      const letter = columnIndexToLetter(colIdx);
      const type = sheet.types[colIdx] ?? 'text';
      const typeLabel =
        type === 'number' ? 'Num' : type === 'percent' ? '%' : 'Text';
      const isSorted = this.sort.colIndex === colIdx;
      const sortIconName =
        isSorted && this.sort.direction === 'asc'
          ? 'sortAsc'
          : isSorted && this.sort.direction === 'desc'
            ? 'sortDesc'
            : 'sortNone';
      const sortIconColor = isSorted ? 'text-blue-600' : 'text-slate-400';

      const isRenaming = this.editingColumnIndex === colIdx;
      const headerTitleHtml = isRenaming
        ? `<input
            type="text"
            data-col-rename="${colIdx}"
            value="${escapeHtml(colName)}"
            aria-label="Rename column ${escapeHtml(colName)}"
            class="w-full min-w-[70px] bg-white border border-blue-500 rounded px-1.5 py-0.5 text-xs font-semibold text-slate-900 focus:outline-none"
          />`
        : `<button
            type="button"
            data-col-title="${colIdx}"
            title="Double-click to rename column"
            class="text-left text-xs font-semibold text-slate-800 truncate hover:text-blue-700 cursor-text"
          >${escapeHtml(colName)}</button>`;

      headerCells.push(`
        <th
          scope="col"
          class="group/th sticky top-0 z-10 bg-slate-100/95 border-b border-r border-slate-200 px-1.5 py-2 text-left align-middle select-none"
          style="height:${GRID_HEADER_HEIGHT}px"
        >
          <div class="flex items-center justify-between gap-0.5">
            <div class="flex items-center gap-1 min-w-0">
              <span class="font-mono-tabular text-[10px] font-medium text-slate-400 shrink-0">${letter}</span>
              ${headerTitleHtml}
            </div>
            <div class="flex items-center gap-0.5 shrink-0">
              <span class="text-[10px] text-slate-400 font-mono-tabular px-0.5" title="Data type: ${typeLabel}">${typeLabel}</span>
              <button
                type="button"
                data-sort-col="${colIdx}"
                aria-label="Sort by column ${escapeHtml(colName)}"
                class="p-0.5 rounded hover:bg-slate-200/80 ${sortIconColor} transition-colors cursor-pointer"
              >
                ${svgIcon(sortIconName, 'w-3.5 h-3.5')}
              </button>
              ${
                sheet.columns.length > 1
                  ? `<button
                      type="button"
                      data-delete-col="${colIdx}"
                      aria-label="Delete column ${escapeHtml(colName)}"
                      class="p-0.5 rounded text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors cursor-pointer"
                    >${svgIcon('close', 'w-3 h-3')}</button>`
                  : ''
              }
            </div>
          </div>
        </th>
      `);
    }

    if (range.rightWidth > 0) {
      headerCells.push(
        `<th scope="col" aria-hidden="true" class="sticky top-0 z-10 bg-slate-100/95 border-b border-slate-200 p-0"></th>`
      );
    }

    this.theadEl.innerHTML = `
      <tr>
        <th scope="col" class="sticky top-0 left-0 z-20 bg-slate-100 border-b border-r border-slate-200 px-1.5 py-2 text-center text-[11px] font-mono-tabular font-medium text-slate-400" style="width:${ROW_NUM_COL_WIDTH}px">
          #
        </th>
        ${headerCells.join('')}
      </tr>
    `;

    if (forceFocus && this.editingColumnIndex !== null) {
      const input = this.theadEl.querySelector<HTMLInputElement>(
        `[data-col-rename="${this.editingColumnIndex}"]`
      );
      input?.focus();
      input?.select();
    }
  }

  private renderBodySlice(
    rowRange: VirtualRange,
    colRange: ColumnVirtualRange
  ): void {
    if (!this.tbodyEl || !this.sheet) return;
    const sheet = this.sheet;
    const vis = this.visibleRowIndices;

    const colSpanTotal =
      1 +
      (colRange.leftWidth > 0 ? 1 : 0) +
      (colRange.end - colRange.start) +
      (colRange.rightWidth > 0 ? 1 : 0);

    const rowsHtml: string[] = [];

    if (rowRange.offsetTop > 0) {
      rowsHtml.push(
        `<tr data-spacer="top" aria-hidden="true" style="height:${rowRange.offsetTop}px"><td colspan="${colSpanTotal}" style="padding:0;border:0;height:${rowRange.offsetTop}px"></td></tr>`
      );
    }

    for (let dispIdx = rowRange.start; dispIdx < rowRange.end; dispIdx++) {
      const rowIdx = vis[dispIdx];
      const row = sheet.rows[rowIdx] ?? [];
      const isRowHighlighted = this.highlightedRowIndex === rowIdx;
      const rowBg = isRowHighlighted
        ? 'bg-blue-50/80'
        : dispIdx % 2 === 1
          ? 'bg-slate-50/40'
          : 'bg-white';

      const cells: string[] = [];
      if (colRange.leftWidth > 0) {
        cells.push(`<td class="border-b border-slate-200 p-0"></td>`);
      }

      for (let colIdx = colRange.start; colIdx < colRange.end; colIdx++) {
        const val = row[colIdx] ?? '';
        const colType = sheet.types[colIdx] ?? 'text';
        const isSelected =
          this.selectedCell?.rowIndex === rowIdx &&
          this.selectedCell?.colIndex === colIdx;
        const isEditing =
          this.editingCell?.rowIndex === rowIdx &&
          this.editingCell?.colIndex === colIdx;

        const alignClass =
          colType === 'number' || colType === 'percent'
            ? 'text-right font-mono-tabular'
            : 'text-left';

        if (isEditing) {
          cells.push(`
            <td class="border-b border-r border-slate-200 p-0 bg-white ring-2 ring-inset ring-blue-600" style="height:${GRID_ROW_HEIGHT}px">
              <input
                type="text"
                data-cell-input="${rowIdx}:${colIdx}"
                value="${escapeHtml(val)}"
                aria-label="Edit cell ${columnIndexToLetter(colIdx)}${rowIdx + 1}"
                class="w-full h-full px-2 text-sm text-slate-900 bg-white focus:outline-none ${alignClass}"
              />
            </td>
          `);
        } else {
          const selectedRing = isSelected
            ? 'ring-2 ring-inset ring-blue-500 bg-blue-50/40'
            : '';
          const displayVal = truncateDisplayText(val);
          // Avoid duplicating long strings into aria-label attributes
          cells.push(`
            <td class="border-b border-r border-slate-200 p-0 ${selectedRing}" ${isSelected ? 'data-selected="1"' : ''} style="height:${GRID_ROW_HEIGHT}px">
              <button
                type="button"
                data-cell="${rowIdx}:${colIdx}"
                aria-label="Cell ${columnIndexToLetter(colIdx)}${rowIdx + 1}"
                class="w-full h-full px-2 text-sm text-slate-800 hover:bg-slate-100/70 focus:outline-none truncate block cursor-cell ${alignClass}"
              >${escapeHtml(displayVal)}</button>
            </td>
          `);
        }
      }

      if (colRange.rightWidth > 0) {
        cells.push(`<td class="border-b border-slate-200 p-0"></td>`);
      }

      rowsHtml.push(`
        <tr data-row-index="${rowIdx}" data-disp-idx="${dispIdx}" ${isRowHighlighted ? 'data-highlighted="1"' : ''} class="group ${rowBg} hover:bg-blue-50/40" style="height:${GRID_ROW_HEIGHT}px">
          <td class="sticky left-0 z-[5] bg-slate-50 border-b border-r border-slate-200 px-1.5 py-0 text-center select-none" style="height:${GRID_ROW_HEIGHT}px">
            <div class="flex items-center justify-between gap-1">
              <span class="font-mono-tabular text-[11px] text-slate-400 truncate text-right flex-1">${rowIdx + 1}</span>
              <button
                type="button"
                data-delete-row="${rowIdx}"
                aria-label="Delete row ${rowIdx + 1}"
                class="hidden group-hover:inline-flex focus:inline-flex p-0.5 rounded text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors cursor-pointer shrink-0"
              >
                ${svgIcon('trash', 'w-3 h-3')}
              </button>
            </div>
          </td>
          ${cells.join('')}
        </tr>
      `);
    }

    if (rowRange.offsetBottom > 0) {
      rowsHtml.push(
        `<tr data-spacer="bottom" aria-hidden="true" style="height:${rowRange.offsetBottom}px"><td colspan="${colSpanTotal}" style="padding:0;border:0;height:${rowRange.offsetBottom}px"></td></tr>`
      );
    }

    this.tbodyEl.innerHTML = rowsHtml.join('');

    // Focus active inline cell editor if open in this visible window
    if (this.editingCell) {
      const cellInput = this.tbodyEl.querySelector<HTMLInputElement>(
        `[data-cell-input="${this.editingCell.rowIndex}:${this.editingCell.colIndex}"]`
      );
      if (cellInput) {
        this.activeCellInputCommitted = false;
        cellInput.focus();
        if (this.replaceInitChar !== undefined) {
          cellInput.value = this.replaceInitChar;
          cellInput.setSelectionRange(1, 1);
          this.replaceInitChar = undefined;
        } else {
          cellInput.select();
        }
      }
    }
  }

  private startEditing(
    rowIndex: number,
    colIndex: number,
    initialChar?: string
  ): void {
    this.editingCell = {rowIndex, colIndex};
    this.activeCellInputCommitted = false;
    this.replaceInitChar = initialChar;
    this.callbacks.onSelectCell({rowIndex, colIndex});
    this.renderVirtualWindow(true);
  }

  private moveSelection(deltaVisibleRow: number, deltaCol: number): void {
    if (!this.sheet || this.visibleRowIndices.length === 0) return;

    const curRow = this.selectedCell?.rowIndex ?? this.visibleRowIndices[0];
    const curCol = this.selectedCell?.colIndex ?? 0;

    const visIdx = this.findDisplayIndex(curRow);
    const baseVisIdx = visIdx >= 0 ? visIdx : 0;
    const nextVisIdx = Math.max(
      0,
      Math.min(this.visibleRowIndices.length - 1, baseVisIdx + deltaVisibleRow)
    );
    const nextRow = this.visibleRowIndices[nextVisIdx];
    const nextCol = Math.max(
      0,
      Math.min(this.sheet.columns.length - 1, curCol + deltaCol)
    );

    this.callbacks.onSelectCell({rowIndex: nextRow, colIndex: nextCol});
    this.scrollToRow(nextRow);
    this.focusCellButton(nextRow, nextCol);
  }

  private focusCellButton(rowIndex: number, colIndex: number): void {
    requestAnimationFrame(() => {
      const btn = this.tableContainerEl?.querySelector<HTMLButtonElement>(
        `[data-cell="${rowIndex}:${colIndex}"]`
      );
      btn?.focus({preventScroll: false});
    });
  }

  public dispose(): void {
    if (this.scrollRafId) {
      cancelAnimationFrame(this.scrollRafId);
      this.scrollRafId = 0;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }
}
