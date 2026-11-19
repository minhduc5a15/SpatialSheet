import type {
  CellCoord,
  ColumnStats,
  ColumnViewState,
  DatasetProfile,
  PinnedColumnVirtualRange,
  SheetData,
  SortState,
  VisibleColumnPlan,
  VirtualRange,
  VisibleRowsSource,
} from '../types';
import type {ActiveColumnStatsState} from '../core/store';
import {
  clampColumnWidth,
  computeDefaultColumnWidths,
  createColumnViewState,
  getVisibleColumnsPlan,
} from '../core/columnView';
import {
  columnIndexToLetter,
  computeColumnStats,
  formatDisplayNumber,
} from '../core/tabular';
import {
  computePinnedColumnVirtualWindow,
  computeRowVirtualWindow,
  computeScrollLeftForColumn,
  computeScrollTopForRow,
} from '../core/virtualWindow';
import {ColumnManager} from './ColumnManager';
import {svgIcon} from './icons';
import {renderBrandLogoHtml} from './branding';

export const GRID_ROW_HEIGHT = 36;
const GRID_HEADER_HEIGHT = 38;
const ROW_NUM_COL_WIDTH = 76;
const DEFAULT_OVERSCAN_ROWS = 8;
const DEFAULT_OVERSCAN_COLS = 2;
const COLUMN_VIRTUALIZE_THRESHOLD = 14;
const MAX_DISPLAY_CELL_CHARS = 200;
const LONG_TEXT_THRESHOLD = 90;

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
  onResizeColumn?: (colIndex: number, width: number) => void;
  onAutoFitColumn?: (colIndex: number) => void;
  onTogglePinColumn?: (colIndex: number) => void;
  onToggleHideColumn?: (colIndex: number) => void;
  onRestoreAllColumns?: () => void;
  onResetColumnView?: () => void;
  onMoveColumnVisual?: (colIndex: number, direction: -1 | 1) => void;
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
  private columnView: ColumnViewState | null = null;
  private datasetProfile: DatasetProfile | null = null;

  private formulaInputEl: HTMLInputElement | null = null;
  private cellRefEl: HTMLElement | null = null;
  private longTextTriggerBtn: HTMLButtonElement | null = null;
  private colManagerHostEl: HTMLElement | null = null;
  private columnManager: ColumnManager | null = null;
  private statsStripEl: HTMLElement | null = null;
  private tableContainerEl: HTMLElement | null = null;
  private resizeBadgeEl: HTMLElement | null = null;
  private longTextModalEl: HTMLElement | null = null;

  private tableEl: HTMLTableElement | null = null;
  private colGroupEl: HTMLElement | null = null;
  private theadEl: HTMLElement | null = null;
  private tbodyEl: HTMLElement | null = null;

  private colWidths: number[] = [];
  private totalColsWidth = 0;
  private lastRowRange: VirtualRange | null = null;
  private lastColRange: PinnedColumnVirtualRange | null = null;
  private lastColPlan: VisibleColumnPlan | null = null;
  private lastStructureKey = '';
  private lastColumnViewRef: ColumnViewState | null = null;
  private scrollRafId = 0;
  private resizeObserver: ResizeObserver | null = null;

  // Live column drag-resize state
  private resizeDrag: {
    pointerId: number;
    colIdx: number;
    startX: number;
    startWidth: number;
    currentWidth: number;
    rafId: number;
    prevUserSelect: string;
    prevCursor: string;
  } | null = null;

  // Multi-column stats cache + optional store-provided async stats state
  private externalStatsState: ActiveColumnStatsState | null = null;
  private statsCacheSheet: SheetData | null = null;
  private statsCacheVisible: VisibleRowsSource | null = null;
  private statsCacheMap = new Map<number, ColumnStats>();
  private lastStatsSignature = '';

  // Track currently committed/escaped input to ignore duplicate focusout
  private activeCellInputCommitted = false;
  private activeColRenameCommitted = false;
  private replaceInitChar: string | undefined = undefined;

  private readonly onWindowPointerMoveResizeBound = (e: PointerEvent) =>
    this.handleColumnResizeMove(e);
  private readonly onWindowPointerUpResizeBound = (e: PointerEvent) =>
    this.handleColumnResizeEnd(e);

  constructor(container: HTMLElement, callbacks: SpreadsheetCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.renderShell();
  }

  private renderShell(): void {
    this.container.innerHTML = `
      <div class="flex flex-col h-full bg-white border border-slate-200 rounded-xl overflow-hidden relative">
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
          <div class="order-last sm:order-none w-full sm:w-auto sm:flex-1 min-w-[140px] flex items-center gap-1.5">
            <input
              type="text"
              data-role="formula-input"
              aria-label="Selected cell value"
              placeholder="Select a cell to view or edit directly..."
              class="flex-1 min-w-0 bg-white border border-slate-200 rounded-md px-2.5 py-1 text-sm text-slate-900 font-mono-tabular focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 disabled:bg-slate-100 disabled:text-slate-400"
              disabled
            />
            <button
              type="button"
              data-action="open-long-text"
              class="hidden items-center gap-1 px-2 py-1 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-md hover:bg-blue-100 whitespace-nowrap shrink-0 cursor-pointer"
              aria-label="Inspect and edit full cell text"
              title="Open full text viewer & editor"
            >
              ${svgIcon('maximize', 'w-3 h-3')}
              <span>Full text</span>
            </button>
          </div>
          <div class="flex items-center gap-1.5 shrink-0 ml-auto sm:ml-0">
            <div data-role="col-manager-host"></div>
            <button
              type="button"
              data-action="add-row"
              class="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              aria-label="Add new row"
            >
              ${svgIcon('plus', 'w-3.5 h-3.5 text-blue-600')}
              <span>Row</span>
            </button>
            <button
              type="button"
              data-action="add-col"
              class="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              aria-label="Add new column"
            >
              ${svgIcon('plus', 'w-3.5 h-3.5 text-emerald-600')}
              <span>Column</span>
            </button>
          </div>
        </div>

        <!-- Scrollable Virtualized Spreadsheet Table -->
        <div data-role="table-container" class="flex-1 overflow-auto sheet-scroll relative bg-white"></div>

        <!-- Floating Column Resize Indicator -->
        <div
          data-role="col-resize-badge"
          class="hidden pointer-events-none fixed z-50 px-2 py-0.5 rounded bg-slate-900 text-white text-[11px] font-mono-tabular shadow-md whitespace-nowrap"
        ></div>

        <!-- Long-Text Cell Viewer & Editor Modal -->
        <div
          data-role="long-text-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Full cell text viewer and editor"
          class="hidden fixed inset-0 z-50 bg-slate-900/45 items-center justify-center p-4"
        ></div>

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
    this.longTextTriggerBtn = this.container.querySelector(
      '[data-action="open-long-text"]'
    );
    this.colManagerHostEl = this.container.querySelector(
      '[data-role="col-manager-host"]'
    );
    this.tableContainerEl = this.container.querySelector(
      '[data-role="table-container"]'
    );
    this.resizeBadgeEl = this.container.querySelector(
      '[data-role="col-resize-badge"]'
    );
    this.longTextModalEl = this.container.querySelector(
      '[data-role="long-text-modal"]'
    );
    this.statsStripEl = this.container.querySelector(
      '[data-role="stats-strip"]'
    );

    if (this.colManagerHostEl) {
      this.columnManager = new ColumnManager(this.colManagerHostEl, {
        onToggleVisibility: (colIdx) => this.callbacks.onToggleHideColumn?.(colIdx),
        onTogglePin: (colIdx) => this.callbacks.onTogglePinColumn?.(colIdx),
        onMoveVisual: (colIdx, dir) =>
          this.callbacks.onMoveColumnVisual?.(colIdx, dir),
        onAutoFit: (colIdx) => this.callbacks.onAutoFitColumn?.(colIdx),
        onDeleteColumn: (colIdx) => this.callbacks.onDeleteColumn(colIdx),
        onShowAll: () => this.callbacks.onRestoreAllColumns?.(),
        onResetLayout: () => this.callbacks.onResetColumnView?.(),
        onFocusColumn: (colIdx) => this.focusColumnFromManager(colIdx),
      });
    }

    const addRowBtn = this.container.querySelector('[data-action="add-row"]');
    const addColBtn = this.container.querySelector('[data-action="add-col"]');
    addRowBtn?.addEventListener('click', () => this.callbacks.onAddRow());
    addColBtn?.addEventListener('click', () => this.callbacks.onAddColumn());
    this.longTextTriggerBtn?.addEventListener('click', () =>
      this.openLongTextModal()
    );

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

    root.addEventListener('pointerdown', (e) => {
      const target = e.target as HTMLElement | null;
      const resizeHandle = target?.closest<HTMLElement>('[data-col-resize]');
      if (resizeHandle) {
        this.startColumnResize(e, Number(resizeHandle.dataset.colResize));
      }
    });

    root.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('[data-col-resize]')) return;

      const emptyAction = target.closest<HTMLElement>('[data-empty-action]');
      if (emptyAction) {
        if (emptyAction.dataset.emptyAction === 'add-row') {
          this.callbacks.onAddRow();
        } else if (emptyAction.dataset.emptyAction === 'clear-search') {
          this.callbacks.onClearSearch();
        }
        return;
      }

      const pinBtn = target.closest<HTMLElement>('[data-pin-col]');
      if (pinBtn) {
        this.callbacks.onTogglePinColumn?.(Number(pinBtn.dataset.pinCol));
        return;
      }

      const hideBtn = target.closest<HTMLElement>('[data-hide-col]');
      if (hideBtn) {
        this.callbacks.onToggleHideColumn?.(Number(hideBtn.dataset.hideCol));
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

      const resizeHandle = target.closest<HTMLElement>('[data-col-resize]');
      if (resizeHandle) {
        e.preventDefault();
        e.stopPropagation();
        this.callbacks.onAutoFitColumn?.(Number(resizeHandle.dataset.colResize));
        return;
      }

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
    columnStats?: ActiveColumnStatsState;
    columnView?: ColumnViewState;
    profile?: DatasetProfile;
  }): void {
    const sheetChanged = this.sheet !== params.sheet;
    const visibleChanged = this.visibleRowIndices !== params.visibleRowIndices;
    const sortChanged =
      this.sort.colIndex !== params.sort.colIndex ||
      this.sort.direction !== params.sort.direction;
    const selectionChanged =
      this.selectedCell?.rowIndex !== params.selectedCell?.rowIndex ||
      this.selectedCell?.colIndex !== params.selectedCell?.colIndex;
    const highlightChanged =
      this.highlightedRowIndex !== params.highlightedRowIndex;

    this.sheet = params.sheet;
    this.visibleRowIndices = params.visibleRowIndices;
    this.sort = params.sort;
    this.selectedCell = params.selectedCell;
    this.highlightedRowIndex = params.highlightedRowIndex;
    if (params.columnStats !== undefined) {
      this.externalStatsState = params.columnStats;
    }
    if (params.profile !== undefined) {
      this.datasetProfile = params.profile;
    }

    const nextView =
      params.columnView ?? this.columnView ?? createColumnViewState(params.sheet);
    const columnViewChanged = nextView !== this.lastColumnViewRef;
    this.columnView = nextView;
    this.lastColumnViewRef = nextView;

    if (sheetChanged || sortChanged) {
      this.editingCell = null;
    } else if (
      this.editingCell &&
      (this.editingCell.rowIndex >= params.sheet.rows.length ||
        this.editingCell.colIndex >= params.sheet.columns.length)
    ) {
      this.editingCell = null;
    }

    if (sheetChanged || visibleChanged) {
      this.statsCacheMap.clear();
      this.statsCacheSheet = params.sheet;
      this.statsCacheVisible = params.visibleRowIndices;
      this.lastStatsSignature = '';
    }

    const structKey = `${params.sheet.id}:${params.sheet.columns.length}:${params.sheet.columns.join('\x00')}`;
    const structChanged = structKey !== this.lastStructureKey;
    if (structChanged || columnViewChanged) {
      this.lastStructureKey = structKey;
      this.computeColumnWidths();
      if (this.tableContainerEl && sheetChanged) {
        this.tableContainerEl.scrollTop = 0;
        this.tableContainerEl.scrollLeft = 0;
      }
    }

    this.columnManager?.update({
      sheet: params.sheet,
      view: nextView,
      profile: this.datasetProfile,
    });

    const needsWindowRebuild =
      sheetChanged ||
      visibleChanged ||
      sortChanged ||
      structChanged ||
      columnViewChanged ||
      !this.tableEl;

    if (needsWindowRebuild) {
      this.renderTableStructureAndWindow(true);
    } else {
      this.renderTableStructureAndWindow(false);
      if (selectionChanged || highlightChanged) {
        this.updateSelectionDomClasses();
      }
    }

    this.syncFormulaBar();
    this.renderStatsStrip();
  }

  public setColumnView(columnView: ColumnViewState, profile?: DatasetProfile): void {
    if (!this.sheet) return;
    if (profile) this.datasetProfile = profile;
    if (columnView === this.lastColumnViewRef) return;
    this.columnView = columnView;
    this.lastColumnViewRef = columnView;
    this.computeColumnWidths();
    this.columnManager?.update({
      sheet: this.sheet,
      view: columnView,
      profile: this.datasetProfile,
    });
    this.renderTableStructureAndWindow(true);
    this.renderStatsStrip();
  }

  /**
   * Fast-path for cell selection and row highlight changes (Phase 1 + Phase 2).
   * Toggles CSS classes directly on visible DOM nodes without rebuilding the table or header.
   */
  public setSelection(
    selectedCell: CellCoord | null,
    highlightedRowIndex: number | null,
    columnStats?: ActiveColumnStatsState
  ): void {
    const sameCell =
      this.selectedCell?.rowIndex === selectedCell?.rowIndex &&
      this.selectedCell?.colIndex === selectedCell?.colIndex;
    const sameRow = this.highlightedRowIndex === highlightedRowIndex;
    const statsProvided = columnStats !== undefined;

    if (columnStats !== undefined) {
      this.externalStatsState = columnStats;
    }

    if (sameCell && sameRow && !statsProvided) {
      return;
    }

    const prevCol = this.selectedCell?.colIndex ?? -1;
    const nextCol = selectedCell?.colIndex ?? -1;

    this.selectedCell = selectedCell;
    this.highlightedRowIndex = highlightedRowIndex;

    if (!sameCell || !sameRow) {
      this.updateSelectionDomClasses();
      this.syncFormulaBar();
    }

    if (prevCol !== nextCol || statsProvided || this.statsCacheMap.size === 0) {
      this.renderStatsStrip();
    }
  }

  public setColumnStats(columnStats: ActiveColumnStatsState): void {
    this.externalStatsState = columnStats;
    this.renderStatsStrip();
  }

  /**
   * Updates only a single visible cell's text & stats without discarding the DOM table.
   */
  public updateSingleCellInPlace(
    nextSheet: SheetData,
    rowIndex: number,
    colIndex: number,
    columnStats?: ActiveColumnStatsState
  ): void {
    const oldTypes = this.sheet?.types;
    this.sheet = nextSheet;
    this.statsCacheMap.delete(colIndex);
    this.statsCacheSheet = nextSheet;
    this.lastStatsSignature = '';
    if (columnStats !== undefined) {
      this.externalStatsState = columnStats;
    }

    const typeChanged = Boolean(
      oldTypes && oldTypes[colIndex] !== nextSheet.types[colIndex]
    );
    if (typeChanged) {
      this.renderHeader(false);
      this.renderVirtualWindow(true);
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
          const isPinned = td.hasAttribute('data-sticky-col');
          const isLastPinned = isPinned && td.classList.contains('border-r-2');
          const stickyCls = isPinned
            ? `sticky z-[6] ${
                isLastPinned
                  ? 'border-r-2 border-r-slate-300 shadow-[2px_0_4px_-2px_rgba(15,23,42,0.08)]'
                  : ''
              }`
            : '';
          const tr = td.closest('tr');
          const dispIdx = Number(tr?.getAttribute('data-disp-idx') ?? 0);
          const isRowHighlighted = tr?.hasAttribute('data-highlighted') ?? false;
          const pinnedBg = isPinned
            ? isSelected || isRowHighlighted
              ? 'bg-blue-50'
              : dispIdx % 2 === 1
                ? 'bg-slate-50'
                : 'bg-white'
            : '';
          const selectedRing = isSelected
            ? `ring-2 ring-inset ring-blue-500 ${isPinned ? '' : 'bg-blue-50/40'}`
            : '';
          td.className = `${stickyCls} ${pinnedBg} border-b border-r border-slate-200 p-0 ${selectedRing}`.trim();
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
    const widths = computeDefaultColumnWidths(
      this.sheet,
      this.columnView?.widths
    );
    const hiddenSet = new Set(this.columnView?.hidden ?? []);
    let visibleSum = 0;
    for (let c = 0; c < widths.length; c++) {
      if (!hiddenSet.has(c)) visibleSum += widths[c];
    }

    this.colWidths = widths;
    this.totalColsWidth = visibleSum;
  }

  private recomputeTotalVisibleWidth(): void {
    const hiddenSet = new Set(this.columnView?.hidden ?? []);
    let visibleSum = 0;
    for (let c = 0; c < this.colWidths.length; c++) {
      if (!hiddenSet.has(c)) visibleSum += this.colWidths[c] ?? 156;
    }
    this.totalColsWidth = visibleSum;
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
        if (td.hasAttribute('data-sticky-col')) {
          const tr = td.closest('tr');
          const dispIdx = Number(tr?.getAttribute('data-disp-idx') ?? 0);
          const isRowHighlighted = tr?.hasAttribute('data-highlighted') ?? false;
          td.classList.remove('bg-blue-50', 'bg-slate-50', 'bg-white');
          td.classList.add(
            isRowHighlighted
              ? 'bg-blue-50'
              : dispIdx % 2 === 1
                ? 'bg-slate-50'
                : 'bg-white'
          );
        }
      });

    // Clear previous row highlights
    this.tbodyEl
      .querySelectorAll<HTMLElement>('tr[data-highlighted="1"]')
      .forEach((tr) => {
        tr.removeAttribute('data-highlighted');
        tr.classList.remove('bg-blue-50/80');
        const disp = Number(tr.dataset.dispIdx ?? 0);
        tr.classList.add(disp % 2 === 1 ? 'bg-slate-50/40' : 'bg-white');
        tr.querySelectorAll<HTMLElement>('td[data-sticky-col]').forEach((td) => {
          if (td.hasAttribute('data-selected')) return;
          td.classList.remove('bg-blue-50', 'bg-slate-50', 'bg-white');
          td.classList.add(disp % 2 === 1 ? 'bg-slate-50' : 'bg-white');
        });
      });

    if (this.highlightedRowIndex !== null) {
      const tr = this.tbodyEl.querySelector<HTMLElement>(
        `tr[data-row-index="${this.highlightedRowIndex}"]`
      );
      if (tr) {
        tr.setAttribute('data-highlighted', '1');
        tr.classList.remove('bg-white', 'bg-slate-50/40');
        tr.classList.add('bg-blue-50/80');
        tr.querySelectorAll<HTMLElement>('td[data-sticky-col]').forEach((td) => {
          td.classList.remove('bg-white', 'bg-slate-50');
          td.classList.add('bg-blue-50');
        });
      }
    }

    if (this.selectedCell) {
      const btn = this.tbodyEl.querySelector<HTMLElement>(
        `[data-cell="${this.selectedCell.rowIndex}:${this.selectedCell.colIndex}"]`
      );
      const td = btn?.closest('td');
      if (td) {
        td.setAttribute('data-selected', '1');
        td.classList.add('ring-2', 'ring-inset', 'ring-blue-500');
        if (td.hasAttribute('data-sticky-col')) {
          td.classList.remove('bg-white', 'bg-slate-50');
          td.classList.add('bg-blue-50');
        } else {
          td.classList.add('bg-blue-50/40');
        }
      }
    }
  }

  private syncFormulaBar(): void {
    if (!this.formulaInputEl || !this.cellRefEl || !this.sheet) return;

    if (!this.selectedCell) {
      this.cellRefEl.textContent = '--';
      this.formulaInputEl.value = '';
      this.formulaInputEl.disabled = true;
      this.toggleLongTextButton(false);
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
      this.toggleLongTextButton(false);
      return;
    }

    const val = this.sheet.rows[rowIndex][colIndex] ?? '';
    this.cellRefEl.textContent = `${columnIndexToLetter(colIndex)}${rowIndex + 1}`;
    this.formulaInputEl.disabled = false;
    this.formulaInputEl.value = val;
    this.toggleLongTextButton(val.length > LONG_TEXT_THRESHOLD || val.includes('\n'));
  }

  private toggleLongTextButton(visible: boolean): void {
    if (!this.longTextTriggerBtn) return;
    this.longTextTriggerBtn.classList.toggle('hidden', !visible);
    this.longTextTriggerBtn.classList.toggle('inline-flex', visible);
  }

  private openLongTextModal(): void {
    if (!this.longTextModalEl || !this.sheet || !this.selectedCell) return;
    const {rowIndex, colIndex} = this.selectedCell;
    const val = this.sheet.rows[rowIndex]?.[colIndex] ?? '';
    const colName = this.sheet.columns[colIndex] ?? '';
    const ref = `${columnIndexToLetter(colIndex)}${rowIndex + 1}`;

    this.longTextModalEl.innerHTML = `
      <div class="bg-white border border-slate-200 rounded-2xl shadow-2xl w-full max-w-2xl flex flex-col overflow-hidden">
        <div class="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between gap-3">
          <div class="min-w-0">
            <div class="text-sm font-semibold text-slate-900 truncate">Cell ${escapeHtml(ref)} · ${escapeHtml(colName)}</div>
            <div class="text-xs text-slate-500 font-mono-tabular">${val.length.toLocaleString('en-US')} chars</div>
          </div>
          <button
            type="button"
            data-lt-close
            aria-label="Close full text viewer"
            class="p-1.5 rounded-lg text-slate-500 hover:bg-slate-200/70 hover:text-slate-900 cursor-pointer"
          >${svgIcon('close', 'w-4 h-4')}</button>
        </div>
        <div class="p-4">
          <textarea
            data-role="long-text-area"
            rows="10"
            aria-label="Full cell text editor"
            class="w-full p-3 text-sm font-mono-tabular text-slate-900 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:bg-white focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 resize-y"
          >${escapeHtml(val)}</textarea>
        </div>
        <div class="px-4 py-3 border-t border-slate-200 bg-slate-50 flex items-center justify-between gap-2">
          <button
            type="button"
            data-lt-copy
            class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-100 cursor-pointer"
          >${svgIcon('copy', 'w-3.5 h-3.5')}<span>Copy text</span></button>
          <div class="flex items-center gap-2">
            <button
              type="button"
              data-lt-close
              class="px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-200/70 rounded-lg cursor-pointer"
            >Cancel</button>
            <button
              type="button"
              data-lt-save
              class="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg cursor-pointer"
            >${svgIcon('check', 'w-3.5 h-3.5')}<span>Save cell</span></button>
          </div>
        </div>
      </div>
    `;

    this.longTextModalEl.classList.remove('hidden');
    this.longTextModalEl.classList.add('flex');
    const area = this.longTextModalEl.querySelector<HTMLTextAreaElement>(
      '[data-role="long-text-area"]'
    );
    area?.focus();

    const closeModal = () => {
      if (!this.longTextModalEl) return;
      this.longTextModalEl.classList.add('hidden');
      this.longTextModalEl.classList.remove('flex');
      this.longTextModalEl.innerHTML = '';
      window.removeEventListener('keydown', onModalKey);
    };

    const onModalKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        closeModal();
      } else if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter' && area) {
        ev.preventDefault();
        this.callbacks.onCellCommit(rowIndex, colIndex, area.value);
        closeModal();
      }
    };
    window.addEventListener('keydown', onModalKey);

    this.longTextModalEl.onclick = (ev) => {
      const t = ev.target as HTMLElement | null;
      if (!t) return;
      if (t === this.longTextModalEl || t.closest('[data-lt-close]')) {
        closeModal();
        return;
      }
      if (t.closest('[data-lt-copy]') && area) {
        void navigator.clipboard?.writeText(area.value).catch(() => {});
        const copyBtn = t.closest<HTMLElement>('[data-lt-copy]');
        const span = copyBtn?.querySelector('span');
        if (span) span.textContent = 'Copied';
        return;
      }
      if (t.closest('[data-lt-save]') && area) {
        this.callbacks.onCellCommit(rowIndex, colIndex, area.value);
        closeModal();
      }
    };
  }

  private renderStatsStrip(): void {
    if (!this.statsStripEl || !this.sheet) return;
    const totalRows = this.sheet.rows.length;
    const visibleCount = this.visibleRowIndices.length;

    const activeCol = this.selectedCell?.colIndex ?? this.findFirstNumericCol();
    const colName = this.sheet.columns[activeCol] ?? '';

    let stats: ColumnStats | null = null;
    let isLoading = false;

    if (
      this.externalStatsState &&
      this.externalStatsState.colIndex === activeCol
    ) {
      stats = this.externalStatsState.stats;
      isLoading = this.externalStatsState.loading;
    } else if (activeCol >= 0 && activeCol < this.sheet.columns.length) {
      if (
        this.statsCacheSheet !== this.sheet ||
        this.statsCacheVisible !== this.visibleRowIndices
      ) {
        this.statsCacheMap.clear();
        this.statsCacheSheet = this.sheet;
        this.statsCacheVisible = this.visibleRowIndices;
      }
      const cached = this.statsCacheMap.get(activeCol);
      if (cached) {
        stats = cached;
      } else {
        stats = computeColumnStats(
          this.sheet,
          activeCol,
          this.visibleRowIndices
        );
        this.statsCacheMap.set(activeCol, stats);
      }
    }

    const plan = this.getActiveColumnPlan();
    const hiddenCount = Math.max(
      0,
      this.sheet.columns.length - plan.visibleCols.length
    );
    const sig = `${totalRows}:${visibleCount}:${this.sheet.columns.length}:${hiddenCount}:${plan.pinnedCols.length}:${plan.downgradedPinCount}:${activeCol}:${isLoading ? 'loading' : stats ? `${stats.numericCount}:${stats.sum}:${stats.nonEmptyCount}:${stats.uniqueCount}` : 'none'}`;
    if (sig === this.lastStatsSignature) {
      return;
    }
    this.lastStatsSignature = sig;

    const visColNote =
      hiddenCount > 0
        ? `${plan.visibleCols.length}/${this.sheet.columns.length} cols`
        : `${this.sheet.columns.length} cols`;
    const pinNote =
      plan.downgradedPinCount > 0
        ? ` · ${plan.pinnedCols.length} pinned (${plan.downgradedPinCount} unpinned on narrow view)`
        : plan.pinnedCols.length > 0
          ? ` · ${plan.pinnedCols.length} pinned`
          : '';
    const leftText =
      visibleCount === totalRows
        ? `${totalRows.toLocaleString('en-US')} rows · ${visColNote}${pinNote}`
        : `Showing ${visibleCount.toLocaleString('en-US')} of ${totalRows.toLocaleString('en-US')} rows · ${visColNote}${pinNote}`;

    let rightHtml = '';
    if (isLoading) {
      rightHtml = `
        <div class="text-slate-400">
          <span>${escapeHtml(colName)}: Calculating stats…</span>
        </div>
      `;
    } else if (stats && stats.numericCount > 0) {
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
          ${renderBrandLogoHtml({
            variant: 'empty',
            sizePx: 48,
            decorative: true,
            className: 'w-12 h-12 mb-3 opacity-90',
          })}
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
      <table class="border-separate border-spacing-0 text-sm" style="table-layout:fixed;min-width:100%" role="grid" aria-label="Editable spreadsheet grid">
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

  private getActiveColumnPlan(): VisibleColumnPlan {
    const view =
      this.columnView ??
      (this.sheet
        ? createColumnViewState(this.sheet)
        : {order: [], hidden: [], pinned: [], widths: {}});
    const viewportWidth = this.tableContainerEl?.clientWidth || 720;
    return getVisibleColumnsPlan({
      view,
      colWidths: this.colWidths,
      viewportWidth,
      rowNumWidth: ROW_NUM_COL_WIDTH,
    });
  }

  private computeCurrentRanges(): {
    rowRange: VirtualRange;
    colPlan: VisibleColumnPlan;
    colRange: PinnedColumnVirtualRange;
  } {
    const root = this.tableContainerEl;
    const totalRows = this.visibleRowIndices.length;
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

    const colPlan = this.getActiveColumnPlan();
    const colRange = computePinnedColumnVirtualWindow({
      unpinnedCols: colPlan.unpinnedCols,
      scrollLeft,
      viewportWidth,
      colWidths: this.colWidths,
      fixedLeftWidth: ROW_NUM_COL_WIDTH + colPlan.pinnedTotalWidth,
      overscan: DEFAULT_OVERSCAN_COLS,
      virtualizeThreshold: COLUMN_VIRTUALIZE_THRESHOLD,
    });

    return {rowRange, colPlan, colRange};
  }

  private renderVirtualWindow(force: boolean): void {
    if (!this.sheet || !this.tableEl || !this.tbodyEl) return;

    const {rowRange, colPlan, colRange} = this.computeCurrentRanges();

    const rowRangeSame =
      !force &&
      this.lastRowRange !== null &&
      this.lastRowRange.start === rowRange.start &&
      this.lastRowRange.end === rowRange.end &&
      this.lastRowRange.total === rowRange.total;

    const colPlanSame =
      !force &&
      this.lastColPlan !== null &&
      this.lastColPlan.pinnedCols.length === colPlan.pinnedCols.length &&
      this.lastColPlan.visibleCols.length === colPlan.visibleCols.length &&
      this.lastColPlan.pinnedTotalWidth === colPlan.pinnedTotalWidth;

    const colRangeSame =
      colPlanSame &&
      this.lastColRange !== null &&
      this.lastColRange.start === colRange.start &&
      this.lastColRange.end === colRange.end &&
      this.lastColRange.virtualized === colRange.virtualized;

    if (rowRangeSame && colRangeSame) {
      return;
    }

    if (!colRangeSame || force) {
      this.lastColPlan = colPlan;
      this.lastColRange = colRange;
      this.renderColGroup(colPlan, colRange);
      this.renderHeader(false, colPlan, colRange);
    }

    this.lastRowRange = rowRange;
    this.renderBodySlice(rowRange, colPlan, colRange);
  }

  private renderColGroup(
    colPlan: VisibleColumnPlan,
    colRange: PinnedColumnVirtualRange
  ): void {
    if (!this.colGroupEl || !this.tableEl) return;

    const totalW = ROW_NUM_COL_WIDTH + this.totalColsWidth;
    this.tableEl.style.width = `${totalW}px`;

    const parts: string[] = [`<col style="width:${ROW_NUM_COL_WIDTH}px" />`];
    for (const colIdx of colPlan.pinnedCols) {
      parts.push(
        `<col data-col-idx="${colIdx}" style="width:${this.colWidths[colIdx] ?? 156}px" />`
      );
    }
    if (colRange.leftWidth > 0) {
      parts.push(`<col style="width:${colRange.leftWidth}px" />`);
    }
    for (const colIdx of colRange.visibleUnpinnedCols) {
      parts.push(
        `<col data-col-idx="${colIdx}" style="width:${this.colWidths[colIdx] ?? 156}px" />`
      );
    }
    if (colRange.rightWidth > 0) {
      parts.push(`<col style="width:${colRange.rightWidth}px" />`);
    }
    this.colGroupEl.innerHTML = parts.join('');
  }

  private renderHeaderCellHtml(
    colIdx: number,
    colPlan: VisibleColumnPlan,
    isPinned: boolean,
    isLastPinned: boolean
  ): string {
    const sheet = this.sheet!;
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
          class="w-full min-w-[60px] bg-white border border-blue-500 rounded px-1.5 py-0.5 text-xs font-semibold text-slate-900 focus:outline-none"
        />`
      : `<button
          type="button"
          data-col-title="${colIdx}"
          title="${escapeHtml(colName)} · Double-click to rename"
          class="text-left text-xs font-semibold text-slate-800 truncate hover:text-blue-700 cursor-text"
        >${escapeHtml(colName)}</button>`;

    const stickyCls = isPinned
      ? `z-20 bg-slate-100 ${
          isLastPinned
            ? 'border-r-2 border-r-slate-300 shadow-[2px_0_4px_-2px_rgba(15,23,42,0.12)]'
            : 'border-r border-slate-200'
        }`
      : 'z-10 bg-slate-100 border-r border-slate-200';
    const stickyStyle = isPinned
      ? `left:${colPlan.pinnedLeftOffsets[colIdx]}px;`
      : '';
    const canHide = colPlan.visibleCols.length > 1;

    return `
      <th
        scope="col"
        ${isPinned ? `data-sticky-col="${colIdx}"` : ''}
        class="group/th sticky top-0 ${stickyCls} border-b border-slate-200 px-1.5 py-2 text-left align-middle select-none relative"
        style="${stickyStyle}height:${GRID_HEADER_HEIGHT}px"
      >
        <div class="flex items-center justify-between gap-0.5 pr-1">
          <div class="flex items-center gap-1 min-w-0">
            <span class="font-mono-tabular text-[10px] font-medium text-slate-400 shrink-0">${letter}</span>
            ${headerTitleHtml}
          </div>
          <div class="flex items-center gap-0.5 shrink-0">
            <span class="text-[10px] text-slate-400 font-mono-tabular px-0.5" title="Type: ${typeLabel}">${typeLabel}</span>
            <button
              type="button"
              data-pin-col="${colIdx}"
              aria-pressed="${isPinned}"
              aria-label="${isPinned ? `Unpin column ${escapeHtml(colName)}` : `Pin column ${escapeHtml(colName)}`}"
              title="${isPinned ? 'Unpin column' : 'Pin column left'}"
              class="${
                isPinned
                  ? 'inline-flex text-blue-600 bg-blue-100/80'
                  : 'hidden group-hover/th:inline-flex group-focus-within/th:inline-flex text-slate-400 hover:text-blue-600 hover:bg-slate-200/70'
              } p-0.5 rounded transition-colors cursor-pointer"
            >${svgIcon('pin', 'w-3 h-3')}</button>
            <button
              type="button"
              data-sort-col="${colIdx}"
              aria-label="Sort by column ${escapeHtml(colName)}"
              class="p-0.5 rounded hover:bg-slate-200/80 ${sortIconColor} transition-colors cursor-pointer"
            >${svgIcon(sortIconName, 'w-3.5 h-3.5')}</button>
            ${
              canHide
                ? `<button
                    type="button"
                    data-hide-col="${colIdx}"
                    aria-label="Hide column ${escapeHtml(colName)}"
                    title="Hide column"
                    class="hidden group-hover/th:inline-flex group-focus-within/th:inline-flex p-0.5 rounded text-slate-400 hover:text-amber-700 hover:bg-amber-50 transition-colors cursor-pointer"
                  >${svgIcon('eyeOff', 'w-3 h-3')}</button>`
                : ''
            }
            ${
              sheet.columns.length > 1
                ? `<button
                    type="button"
                    data-delete-col="${colIdx}"
                    aria-label="Delete column ${escapeHtml(colName)}"
                    title="Delete column"
                    class="hidden group-hover/th:inline-flex group-focus-within/th:inline-flex p-0.5 rounded text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors cursor-pointer"
                  >${svgIcon('close', 'w-3 h-3')}</button>`
                : ''
            }
          </div>
        </div>
        <div
          data-col-resize="${colIdx}"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize column ${escapeHtml(colName)}"
          title="Drag to resize · Double-click to auto-fit"
          style="touch-action:none"
          class="absolute top-0 right-0 bottom-0 w-2 cursor-col-resize hover:bg-blue-500/40 transition-colors z-30"
        ></div>
      </th>
    `;
  }

  private renderHeader(
    forceFocus: boolean,
    colPlan?: VisibleColumnPlan,
    colRange?: PinnedColumnVirtualRange
  ): void {
    if (!this.theadEl || !this.sheet) return;
    const activePlan =
      colPlan ?? this.lastColPlan ?? this.getActiveColumnPlan();
    const range =
      colRange ?? this.lastColRange ?? this.computeCurrentRanges().colRange;

    const headerCells: string[] = [];

    activePlan.pinnedCols.forEach((colIdx, pIdx) => {
      headerCells.push(
        this.renderHeaderCellHtml(
          colIdx,
          activePlan,
          true,
          pIdx === activePlan.pinnedCols.length - 1
        )
      );
    });

    if (range.leftWidth > 0) {
      headerCells.push(
        `<th scope="col" aria-hidden="true" class="sticky top-0 z-10 bg-slate-100 border-b border-slate-200 p-0"></th>`
      );
    }

    for (const colIdx of range.visibleUnpinnedCols) {
      headerCells.push(
        this.renderHeaderCellHtml(colIdx, activePlan, false, false)
      );
    }

    if (range.rightWidth > 0) {
      headerCells.push(
        `<th scope="col" aria-hidden="true" class="sticky top-0 z-10 bg-slate-100 border-b border-slate-200 p-0"></th>`
      );
    }

    this.theadEl.innerHTML = `
      <tr>
        <th scope="col" class="sticky top-0 left-0 z-30 bg-slate-100 border-b border-r border-slate-200 px-1.5 py-2 text-center text-[11px] font-mono-tabular font-medium text-slate-400 overflow-hidden" style="left:0;width:${ROW_NUM_COL_WIDTH}px">
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

  private renderCellHtml(params: {
    rowIdx: number;
    colIdx: number;
    dispIdx: number;
    val: string;
    isRowHighlighted: boolean;
    colPlan: VisibleColumnPlan;
    isPinned: boolean;
    isLastPinned: boolean;
  }): string {
    const {
      rowIdx,
      colIdx,
      dispIdx,
      val,
      isRowHighlighted,
      colPlan,
      isPinned,
      isLastPinned,
    } = params;
    const sheet = this.sheet!;
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

    const stickyCls = isPinned
      ? `sticky z-[6] ${
          isLastPinned
            ? 'border-r-2 border-r-slate-300 shadow-[2px_0_4px_-2px_rgba(15,23,42,0.08)]'
            : ''
        }`
      : '';
    const stickyStyle = isPinned
      ? `left:${colPlan.pinnedLeftOffsets[colIdx]}px;`
      : '';
    const opaqueStickyBg = isPinned
      ? isSelected
        ? 'bg-blue-50'
        : isRowHighlighted
          ? 'bg-blue-50'
          : dispIdx % 2 === 1
            ? 'bg-slate-50'
            : 'bg-white'
      : '';

    if (isEditing) {
      return `
        <td ${isPinned ? `data-sticky-col="${colIdx}"` : ''} class="${stickyCls} border-b border-r border-slate-200 p-0 bg-white ring-2 ring-inset ring-blue-600" style="${stickyStyle}height:${GRID_ROW_HEIGHT}px">
          <input
            type="text"
            data-cell-input="${rowIdx}:${colIdx}"
            value="${escapeHtml(val)}"
            aria-label="Edit cell ${columnIndexToLetter(colIdx)}${rowIdx + 1}"
            class="w-full h-full px-2 text-sm text-slate-900 bg-white focus:outline-none ${alignClass}"
          />
        </td>
      `;
    }

    const selectedRing = isSelected
      ? `ring-2 ring-inset ring-blue-500 ${isPinned ? '' : 'bg-blue-50/40'}`
      : '';
    const displayVal = truncateDisplayText(val);
    return `
      <td ${isPinned ? `data-sticky-col="${colIdx}"` : ''} class="${stickyCls} ${opaqueStickyBg} border-b border-r border-slate-200 p-0 ${selectedRing}" ${isSelected ? 'data-selected="1"' : ''} style="${stickyStyle}height:${GRID_ROW_HEIGHT}px">
        <button
          type="button"
          data-cell="${rowIdx}:${colIdx}"
          aria-label="Cell ${columnIndexToLetter(colIdx)}${rowIdx + 1}"
          class="w-full h-full px-2 text-sm text-slate-800 hover:bg-slate-100/70 focus:outline-none truncate block cursor-cell ${alignClass}"
        >${escapeHtml(displayVal)}</button>
      </td>
    `;
  }

  private renderBodySlice(
    rowRange: VirtualRange,
    colPlan: VisibleColumnPlan,
    colRange: PinnedColumnVirtualRange
  ): void {
    if (!this.tbodyEl || !this.sheet) return;
    const sheet = this.sheet;
    const vis = this.visibleRowIndices;

    const colSpanTotal =
      1 +
      colPlan.pinnedCols.length +
      (colRange.leftWidth > 0 ? 1 : 0) +
      colRange.visibleUnpinnedCols.length +
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

      colPlan.pinnedCols.forEach((colIdx, pIdx) => {
        cells.push(
          this.renderCellHtml({
            rowIdx,
            colIdx,
            dispIdx,
            val: row[colIdx] ?? '',
            isRowHighlighted,
            colPlan,
            isPinned: true,
            isLastPinned: pIdx === colPlan.pinnedCols.length - 1,
          })
        );
      });

      if (colRange.leftWidth > 0) {
        cells.push(`<td class="border-b border-slate-200 p-0"></td>`);
      }

      for (const colIdx of colRange.visibleUnpinnedCols) {
        cells.push(
          this.renderCellHtml({
            rowIdx,
            colIdx,
            dispIdx,
            val: row[colIdx] ?? '',
            isRowHighlighted,
            colPlan,
            isPinned: false,
            isLastPinned: false,
          })
        );
      }

      if (colRange.rightWidth > 0) {
        cells.push(`<td class="border-b border-slate-200 p-0"></td>`);
      }

      rowsHtml.push(`
        <tr data-row-index="${rowIdx}" data-disp-idx="${dispIdx}" ${isRowHighlighted ? 'data-highlighted="1"' : ''} class="group ${rowBg} hover:bg-blue-50/40" style="height:${GRID_ROW_HEIGHT}px">
          <td class="sticky left-0 z-[15] bg-slate-50 border-b border-r border-slate-200 px-1.5 py-0 text-center select-none overflow-hidden" style="left:0;height:${GRID_ROW_HEIGHT}px">
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

  private startColumnResize(e: PointerEvent, colIdx: number): void {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    e.stopPropagation();

    const startWidth = this.colWidths[colIdx] ?? 156;
    const prevUserSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    this.resizeDrag = {
      pointerId: e.pointerId,
      colIdx,
      startX: e.clientX,
      startWidth,
      currentWidth: startWidth,
      rafId: 0,
      prevUserSelect,
      prevCursor,
    };

    this.showResizeBadge(e.clientX, e.clientY, startWidth);
    window.addEventListener('pointermove', this.onWindowPointerMoveResizeBound);
    window.addEventListener('pointerup', this.onWindowPointerUpResizeBound);
    window.addEventListener('pointercancel', this.onWindowPointerUpResizeBound);
  }

  private handleColumnResizeMove(e: PointerEvent): void {
    if (!this.resizeDrag || this.resizeDrag.pointerId !== e.pointerId) return;
    const deltaX = e.clientX - this.resizeDrag.startX;
    const nextW = clampColumnWidth(this.resizeDrag.startWidth + deltaX);
    this.resizeDrag.currentWidth = nextW;
    this.showResizeBadge(e.clientX, e.clientY, nextW);

    if (!this.resizeDrag.rafId) {
      this.resizeDrag.rafId = requestAnimationFrame(() => {
        if (!this.resizeDrag) return;
        this.resizeDrag.rafId = 0;
        this.applyLiveColumnWidth(
          this.resizeDrag.colIdx,
          this.resizeDrag.currentWidth
        );
      });
    }
  }

  private handleColumnResizeEnd(e: PointerEvent): void {
    if (!this.resizeDrag || this.resizeDrag.pointerId !== e.pointerId) return;
    const {colIdx, currentWidth, rafId, prevUserSelect, prevCursor} =
      this.resizeDrag;
    if (rafId) cancelAnimationFrame(rafId);
    this.resizeDrag = null;

    window.removeEventListener('pointermove', this.onWindowPointerMoveResizeBound);
    window.removeEventListener('pointerup', this.onWindowPointerUpResizeBound);
    window.removeEventListener('pointercancel', this.onWindowPointerUpResizeBound);

    document.body.style.userSelect = prevUserSelect;
    document.body.style.cursor = prevCursor;
    this.resizeBadgeEl?.classList.add('hidden');

    this.applyLiveColumnWidth(colIdx, currentWidth);
    this.callbacks.onResizeColumn?.(colIdx, currentWidth);
  }

  private applyLiveColumnWidth(colIdx: number, nextWidth: number): void {
    this.colWidths[colIdx] = nextWidth;
    this.recomputeTotalVisibleWidth();

    if (this.tableEl) {
      this.tableEl.style.width = `${ROW_NUM_COL_WIDTH + this.totalColsWidth}px`;
    }
    const colEl = this.colGroupEl?.querySelector<HTMLElement>(
      `col[data-col-idx="${colIdx}"]`
    );
    if (colEl) {
      colEl.style.width = `${nextWidth}px`;
    }

    // Recompute sticky left offsets cleanly if a pinned column changed width
    const plan = this.getActiveColumnPlan();
    this.lastColPlan = plan;
    for (const pinnedCol of plan.pinnedCols) {
      const leftPx = `${plan.pinnedLeftOffsets[pinnedCol]}px`;
      this.tableEl
        ?.querySelectorAll<HTMLElement>(`[data-sticky-col="${pinnedCol}"]`)
        .forEach((cell) => {
          cell.style.left = leftPx;
        });
    }
  }

  private showResizeBadge(clientX: number, clientY: number, width: number): void {
    if (!this.resizeBadgeEl) return;
    this.resizeBadgeEl.textContent = `${width}px`;
    this.resizeBadgeEl.style.left = `${Math.round(clientX + 12)}px`;
    this.resizeBadgeEl.style.top = `${Math.round(Math.max(8, clientY - 28))}px`;
    this.resizeBadgeEl.classList.remove('hidden');
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

  public scrollToColumn(sourceColIndex: number): void {
    if (!this.tableContainerEl || !this.sheet) return;
    const plan = this.getActiveColumnPlan();
    if (plan.pinnedCols.includes(sourceColIndex)) {
      this.renderVirtualWindow(true);
      return;
    }
    const unpinnedPos = plan.unpinnedCols.indexOf(sourceColIndex);
    if (unpinnedPos < 0) return;

    const nextLeft = computeScrollLeftForColumn({
      unpinnedColPos: unpinnedPos,
      unpinnedCols: plan.unpinnedCols,
      colWidths: this.colWidths,
      currentScrollLeft: this.tableContainerEl.scrollLeft,
      viewportWidth: this.tableContainerEl.clientWidth || 720,
      fixedLeftWidth: ROW_NUM_COL_WIDTH + plan.pinnedTotalWidth,
    });
    if (nextLeft !== null) {
      this.tableContainerEl.scrollLeft = nextLeft;
    }
    this.renderVirtualWindow(true);
  }

  private focusColumnFromManager(colIdx: number): void {
    if (!this.sheet) return;
    if (this.columnView?.hidden.includes(colIdx)) {
      this.callbacks.onToggleHideColumn?.(colIdx);
    }
    const row = this.selectedCell?.rowIndex ?? this.visibleRowIndices[0] ?? 0;
    this.callbacks.onSelectCell({rowIndex: row, colIndex: colIdx});
    this.scrollToColumn(colIdx);
    this.focusCellButton(row, colIdx);
  }

  private moveSelection(deltaVisibleRow: number, deltaCol: number): void {
    if (!this.sheet || this.visibleRowIndices.length === 0) return;

    const plan = this.getActiveColumnPlan();
    const visibleCols = plan.visibleCols;
    if (visibleCols.length === 0) return;

    const curRow = this.selectedCell?.rowIndex ?? this.visibleRowIndices[0];
    const curCol = this.selectedCell?.colIndex ?? visibleCols[0];

    const visRowIdx = this.findDisplayIndex(curRow);
    const baseVisRowIdx = visRowIdx >= 0 ? visRowIdx : 0;
    const nextVisRowIdx = Math.max(
      0,
      Math.min(this.visibleRowIndices.length - 1, baseVisRowIdx + deltaVisibleRow)
    );
    const nextRow = this.visibleRowIndices[nextVisRowIdx];

    const curColPos = visibleCols.indexOf(curCol);
    const baseColPos = curColPos >= 0 ? curColPos : 0;
    const nextColPos = Math.max(
      0,
      Math.min(visibleCols.length - 1, baseColPos + deltaCol)
    );
    const nextCol = visibleCols[nextColPos];

    this.callbacks.onSelectCell({rowIndex: nextRow, colIndex: nextCol});
    this.scrollToRow(nextRow);
    if (deltaCol !== 0) {
      this.scrollToColumn(nextCol);
    }
    this.focusCellButton(nextRow, nextCol);
  }

  private focusCellButton(rowIndex: number, colIndex: number): void {
    requestAnimationFrame(() => {
      const btn = this.tableContainerEl?.querySelector<HTMLButtonElement>(
        `[data-cell="${rowIndex}:${colIndex}"]`
      );
      btn?.focus({preventScroll: true});
    });
  }

  public dispose(): void {
    if (this.scrollRafId) {
      cancelAnimationFrame(this.scrollRafId);
      this.scrollRafId = 0;
    }
    if (this.resizeDrag) {
      if (this.resizeDrag.rafId) cancelAnimationFrame(this.resizeDrag.rafId);
      document.body.style.userSelect = this.resizeDrag.prevUserSelect;
      document.body.style.cursor = this.resizeDrag.prevCursor;
      window.removeEventListener(
        'pointermove',
        this.onWindowPointerMoveResizeBound
      );
      window.removeEventListener('pointerup', this.onWindowPointerUpResizeBound);
      window.removeEventListener(
        'pointercancel',
        this.onWindowPointerUpResizeBound
      );
      this.resizeDrag = null;
    }
    this.columnManager?.dispose();
    this.columnManager = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }
}
