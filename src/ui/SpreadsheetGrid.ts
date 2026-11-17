import type {CellCoord, SheetData, SortState} from '../types';
import {
  columnIndexToLetter,
  computeColumnStats,
  formatDisplayNumber,
} from '../core/tabular';
import {svgIcon} from './icons';

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

export class SpreadsheetGrid {
  private container: HTMLElement;
  private callbacks: SpreadsheetCallbacks;
  private sheet: SheetData | null = null;
  private visibleRowIndices: number[] = [];
  private sort: SortState = {colIndex: null, direction: null};
  private selectedCell: CellCoord | null = null;
  private editingCell: CellCoord | null = null;
  private editingColumnIndex: number | null = null;
  private highlightedRowIndex: number | null = null;
  private formulaInputEl: HTMLInputElement | null = null;
  private cellRefEl: HTMLElement | null = null;
  private statsStripEl: HTMLElement | null = null;
  private tableContainerEl: HTMLElement | null = null;

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

        <!-- Scrollable Spreadsheet Table -->
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

  public setData(params: {
    sheet: SheetData;
    visibleRowIndices: number[];
    sort: SortState;
    selectedCell: CellCoord | null;
    highlightedRowIndex: number | null;
  }): void {
    this.sheet = params.sheet;
    this.visibleRowIndices = params.visibleRowIndices;
    this.sort = params.sort;
    this.selectedCell = params.selectedCell;
    this.highlightedRowIndex = params.highlightedRowIndex;

    // Validate editing indices
    if (
      this.editingCell &&
      (this.editingCell.rowIndex >= params.sheet.rows.length ||
        this.editingCell.colIndex >= params.sheet.columns.length)
    ) {
      this.editingCell = null;
    }

    this.renderTable();
    this.syncFormulaBar();
    this.renderStatsStrip();
  }

  public scrollToRow(rowIndex: number): void {
    const tr = this.tableContainerEl?.querySelector<HTMLElement>(
      `tr[data-row-index="${rowIndex}"]`
    );
    tr?.scrollIntoView({block: 'nearest', behavior: 'smooth'});
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
    const colName = this.sheet.columns[activeCol] ?? '';
    const stats =
      activeCol >= 0 && activeCol < this.sheet.columns.length
        ? computeColumnStats(this.sheet, activeCol, this.visibleRowIndices)
        : null;

    const leftText =
      visibleCount === totalRows
        ? `${totalRows} rows · ${this.sheet.columns.length} cols`
        : `Showing ${visibleCount} of ${totalRows} rows · ${this.sheet.columns.length} cols`;

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
          <span>${escapeHtml(colName)}: ${stats.nonEmptyCount} values · ${stats.uniqueCount} unique</span>
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

  private renderTable(): void {
    if (!this.tableContainerEl || !this.sheet) return;
    const sheet = this.sheet;

    if (sheet.rows.length === 0) {
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
      this.tableContainerEl
        .querySelector('[data-empty-action="add-row"]')
        ?.addEventListener('click', () => this.callbacks.onAddRow());
      return;
    }

    if (this.visibleRowIndices.length === 0) {
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
      this.tableContainerEl
        .querySelector('[data-empty-action="clear-search"]')
        ?.addEventListener('click', () => this.callbacks.onClearSearch());
      return;
    }

    const headerCells = sheet.columns
      .map((colName, colIdx) => {
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
              class="w-full min-w-[78px] bg-white border border-blue-500 rounded px-1.5 py-0.5 text-xs font-semibold text-slate-900 focus:outline-none"
            />`
          : `<button
              type="button"
              data-col-title="${colIdx}"
              title="Double-click to rename column"
              class="text-left text-xs font-semibold text-slate-800 truncate max-w-[125px] hover:text-blue-700 cursor-text"
            >${escapeHtml(colName)}</button>`;

        return `
          <th
            scope="col"
            class="group/th sticky top-0 z-10 bg-slate-100/95 border-b border-r border-slate-200 px-1.5 py-2 text-left align-middle select-none min-w-[84px]"
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
        `;
      })
      .join('');

    const bodyRows = this.visibleRowIndices
      .map((rowIdx, displayIdx) => {
        const row = sheet.rows[rowIdx] ?? [];
        const isRowHighlighted = this.highlightedRowIndex === rowIdx;
        const rowBg = isRowHighlighted
          ? 'bg-blue-50/80'
          : displayIdx % 2 === 1
            ? 'bg-slate-50/40'
            : 'bg-white';

        const cellsHtml = sheet.columns
          .map((_, colIdx) => {
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
              return `
                <td class="border-b border-r border-slate-200 p-0 bg-white ring-2 ring-inset ring-blue-600">
                  <input
                    type="text"
                    data-cell-input="${rowIdx}:${colIdx}"
                    value="${escapeHtml(val)}"
                    aria-label="Edit cell ${columnIndexToLetter(colIdx)}${rowIdx + 1}"
                    class="w-full h-9 px-2 text-sm text-slate-900 bg-white focus:outline-none ${alignClass}"
                  />
                </td>
              `;
            }

            const selectedRing = isSelected
              ? 'ring-2 ring-inset ring-blue-500 bg-blue-50/40'
              : '';

            return `
              <td class="border-b border-r border-slate-200 p-0 ${selectedRing}">
                <button
                  type="button"
                  data-cell="${rowIdx}:${colIdx}"
                  aria-label="Cell ${columnIndexToLetter(colIdx)}${rowIdx + 1}: ${escapeHtml(val || 'empty')}"
                  class="w-full h-9 px-2 text-sm text-slate-800 hover:bg-slate-100/70 focus:outline-none truncate block cursor-cell ${alignClass}"
                >${escapeHtml(val)}</button>
              </td>
            `;
          })
          .join('');

        return `
          <tr data-row-index="${rowIdx}" class="group ${rowBg} hover:bg-blue-50/40 transition-colors">
            <td class="sticky left-0 z-[5] bg-slate-50 border-b border-r border-slate-200 px-1.5 py-0 text-center w-11 select-none">
              <div class="flex items-center justify-between gap-0.5">
                <span class="font-mono-tabular text-xs text-slate-400 w-4 text-right">${rowIdx + 1}</span>
                <button
                  type="button"
                  data-delete-row="${rowIdx}"
                  aria-label="Delete row ${rowIdx + 1}"
                  class="opacity-0 group-hover:opacity-100 focus:opacity-100 p-0.5 rounded text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-opacity cursor-pointer"
                >
                  ${svgIcon('trash', 'w-3 h-3')}
                </button>
              </div>
            </td>
            ${cellsHtml}
          </tr>
        `;
      })
      .join('');

    this.tableContainerEl.innerHTML = `
      <table class="w-full border-collapse text-sm" role="grid" aria-label="Editable spreadsheet grid">
        <thead>
          <tr>
            <th scope="col" class="sticky top-0 left-0 z-20 bg-slate-100 border-b border-r border-slate-200 px-1.5 py-2 text-center w-11 text-[11px] font-mono-tabular font-medium text-slate-400">
              #
            </th>
            ${headerCells}
          </tr>
        </thead>
        <tbody>
          ${bodyRows}
        </tbody>
      </table>
    `;

    this.bindTableEvents();
  }

  private bindTableEvents(): void {
    const root = this.tableContainerEl;
    if (!root) return;

    // Sort buttons
    root.querySelectorAll<HTMLButtonElement>('[data-sort-col]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const colIdx = Number(btn.dataset.sortCol);
        this.callbacks.onSortColumn(colIdx);
      });
    });

    // Delete column buttons
    root
      .querySelectorAll<HTMLButtonElement>('[data-delete-col]')
      .forEach((btn) => {
        btn.addEventListener('click', () => {
          const colIdx = Number(btn.dataset.deleteCol);
          this.callbacks.onDeleteColumn(colIdx);
        });
      });

    // Delete row buttons
    root
      .querySelectorAll<HTMLButtonElement>('[data-delete-row]')
      .forEach((btn) => {
        btn.addEventListener('click', () => {
          const rowIdx = Number(btn.dataset.deleteRow);
          this.callbacks.onDeleteRow(rowIdx);
        });
      });

    // Column rename trigger (double click)
    root
      .querySelectorAll<HTMLButtonElement>('[data-col-title]')
      .forEach((btn) => {
        btn.addEventListener('dblclick', () => {
          this.editingColumnIndex = Number(btn.dataset.colTitle);
          this.renderTable();
          const input = root.querySelector<HTMLInputElement>(
            `[data-col-rename="${this.editingColumnIndex}"]`
          );
          input?.focus();
          input?.select();
        });
      });

    // Active column rename input
    const colRenameInput = root.querySelector<HTMLInputElement>(
      '[data-col-rename]'
    );
    if (colRenameInput) {
      const commitRename = () => {
        const colIdx = Number(colRenameInput.dataset.colRename);
        const val = colRenameInput.value;
        this.editingColumnIndex = null;
        this.callbacks.onRenameColumn(colIdx, val);
      };
      colRenameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commitRename();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          this.editingColumnIndex = null;
          this.renderTable();
        }
      });
      colRenameInput.addEventListener('blur', commitRename);
    }

    // Cell buttons (click to select, dblclick or Enter/char to edit)
    root.querySelectorAll<HTMLButtonElement>('[data-cell]').forEach((btn) => {
      const [rStr, cStr] = (btn.dataset.cell ?? '').split(':');
      const rowIndex = Number(rStr);
      const colIndex = Number(cStr);

      btn.addEventListener('click', () => {
        this.editingCell = null;
        this.callbacks.onSelectCell({rowIndex, colIndex});
      });

      btn.addEventListener('dblclick', () => {
        this.startEditing(rowIndex, colIndex);
      });

      btn.addEventListener('keydown', (e) => {
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
      });
    });

    // Active cell inline input
    const cellInput =
      root.querySelector<HTMLInputElement>('[data-cell-input]');
    if (cellInput) {
      const [rStr, cStr] = (cellInput.dataset.cellInput ?? '').split(':');
      const rowIndex = Number(rStr);
      const colIndex = Number(cStr);
      let committed = false;

      const commit = () => {
        if (committed) return;
        committed = true;
        const val = cellInput.value;
        this.editingCell = null;
        this.callbacks.onCellCommit(rowIndex, colIndex, val);
      };

      cellInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
          this.moveSelection(1, 0);
        } else if (e.key === 'Tab') {
          e.preventDefault();
          commit();
          this.moveSelection(0, e.shiftKey ? -1 : 1);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          committed = true;
          this.editingCell = null;
          this.renderTable();
          this.focusCellButton(rowIndex, colIndex);
        }
      });

      cellInput.addEventListener('blur', commit);
      cellInput.focus();
      if (cellInput.dataset.replaceInit !== 'true') {
        cellInput.select();
      }
    }
  }

  private startEditing(
    rowIndex: number,
    colIndex: number,
    initialChar?: string
  ): void {
    this.editingCell = {rowIndex, colIndex};
    this.callbacks.onSelectCell({rowIndex, colIndex});
    const input = this.tableContainerEl?.querySelector<HTMLInputElement>(
      `[data-cell-input="${rowIndex}:${colIndex}"]`
    );
    if (input && initialChar !== undefined) {
      input.dataset.replaceInit = 'true';
      input.value = initialChar;
      input.setSelectionRange(1, 1);
    }
  }

  private moveSelection(deltaVisibleRow: number, deltaCol: number): void {
    if (!this.sheet || this.visibleRowIndices.length === 0) return;

    const curRow = this.selectedCell?.rowIndex ?? this.visibleRowIndices[0];
    const curCol = this.selectedCell?.colIndex ?? 0;

    const visIdx = this.visibleRowIndices.indexOf(curRow);
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
}
