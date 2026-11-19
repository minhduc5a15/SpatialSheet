import type {
  ColumnViewState,
  DatasetProfile,
  SheetData,
} from '../types';
import {getOrderedDisplayColumns} from '../core/columnView';
import {columnIndexToLetter} from '../core/tabular';
import {svgIcon} from './icons';

export interface ColumnManagerCallbacks {
  onToggleVisibility: (sourceColIndex: number) => void;
  onTogglePin: (sourceColIndex: number) => void;
  onMoveVisual: (sourceColIndex: number, direction: -1 | 1) => void;
  onAutoFit: (sourceColIndex: number) => void;
  onDeleteColumn: (sourceColIndex: number) => void;
  onShowAll: () => void;
  onResetLayout: () => void;
  onFocusColumn?: (sourceColIndex: number) => void;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export class ColumnManager {
  private anchorHost: HTMLElement;
  private triggerBtn: HTMLButtonElement;
  private popoverEl: HTMLElement;
  private callbacks: ColumnManagerCallbacks;

  private isOpen = false;
  private searchQuery = '';
  private sheet: SheetData | null = null;
  private view: ColumnViewState | null = null;
  private profile: DatasetProfile | null = null;

  private readonly abortController = new AbortController();
  private readonly onDocPointerDownBound = (e: MouseEvent) => this.handleDocClick(e);
  private readonly onDocKeyDownBound = (e: KeyboardEvent) => this.handleDocKey(e);

  constructor(anchorHost: HTMLElement, callbacks: ColumnManagerCallbacks) {
    this.anchorHost = anchorHost;
    this.callbacks = callbacks;
    this.anchorHost.classList.add('relative');

    this.anchorHost.innerHTML = `
      <button
        type="button"
        data-role="col-manager-trigger"
        aria-expanded="false"
        aria-haspopup="dialog"
        class="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
      >
        ${svgIcon('columns', 'w-3.5 h-3.5 text-slate-600')}
        <span data-role="col-manager-summary">Columns</span>
      </button>
      <div
        data-role="col-manager-popover"
        role="dialog"
        aria-label="Manage spreadsheet columns"
        class="hidden absolute right-0 top-full mt-1.5 z-40 w-[340px] sm:w-[376px] max-w-[calc(100vw-2rem)] bg-white border border-slate-200 rounded-xl shadow-xl overflow-hidden flex-col"
      ></div>
    `;

    this.triggerBtn = this.anchorHost.querySelector(
      '[data-role="col-manager-trigger"]'
    )!;
    this.popoverEl = this.anchorHost.querySelector(
      '[data-role="col-manager-popover"]'
    )!;

    const {signal} = this.abortController;
    this.triggerBtn.addEventListener(
      'click',
      (e) => {
        e.stopPropagation();
        this.toggle();
      },
      {signal}
    );

    this.bindPopoverEvents();
    document.addEventListener('mousedown', this.onDocPointerDownBound, {signal});
    document.addEventListener('keydown', this.onDocKeyDownBound, {signal});
  }

  public update(params: {
    sheet: SheetData;
    view: ColumnViewState;
    profile?: DatasetProfile | null;
  }): void {
    this.sheet = params.sheet;
    this.view = params.view;
    this.profile = params.profile ?? null;
    this.syncTriggerSummary();
    if (this.isOpen) {
      this.renderPopoverBody();
    }
  }

  private syncTriggerSummary(): void {
    const summaryEl = this.triggerBtn.querySelector(
      '[data-role="col-manager-summary"]'
    );
    if (!summaryEl || !this.sheet || !this.view) return;
    const total = this.sheet.columns.length;
    const hiddenCount = this.view.hidden.length;
    const visible = Math.max(0, total - hiddenCount);
    const pinCount = this.view.pinned.length;
    const pinSuffix = pinCount > 0 ? ` · ${pinCount} pinned` : '';
    summaryEl.textContent =
      hiddenCount > 0
        ? `Columns (${visible}/${total})${pinSuffix}`
        : `Columns (${total})${pinSuffix}`;
  }

  public toggle(forceOpen?: boolean): void {
    const next = forceOpen ?? !this.isOpen;
    if (next === this.isOpen) return;
    this.isOpen = next;
    this.triggerBtn.setAttribute('aria-expanded', String(this.isOpen));
    this.popoverEl.classList.toggle('hidden', !this.isOpen);
    this.popoverEl.classList.toggle('flex', this.isOpen);

    if (this.isOpen) {
      this.renderPopoverBody();
      const input = this.popoverEl.querySelector<HTMLInputElement>(
        '[data-role="col-manager-search"]'
      );
      input?.focus();
    }
  }

  private renderPopoverBody(): void {
    if (!this.sheet || !this.view) return;
    const sheet = this.sheet;
    const view = this.view;
    const total = sheet.columns.length;
    const hiddenSet = new Set(view.hidden);
    const pinnedSet = new Set(view.pinned);
    const visibleCount = Math.max(0, total - hiddenSet.size);

    const {pinnedOrdered, unpinnedOrdered} = getOrderedDisplayColumns(view);
    const hiddenOrdered = view.order.filter((c) => hiddenSet.has(c));
    const displayList = [...pinnedOrdered, ...unpinnedOrdered, ...hiddenOrdered];

    const q = this.searchQuery.trim().toLowerCase();
    const filteredCols = q
      ? displayList.filter((colIdx) => {
          const name = (sheet.columns[colIdx] ?? '').toLowerCase();
          const letter = columnIndexToLetter(colIdx).toLowerCase();
          return name.includes(q) || letter.includes(q);
        })
      : displayList;

    const rowsHtml =
      filteredCols.length === 0
        ? `<div class="py-8 text-center text-xs text-slate-400">No columns match "${escapeHtml(this.searchQuery)}"</div>`
        : filteredCols
            .map((colIdx) => {
              const name = sheet.columns[colIdx] ?? `Col ${colIdx + 1}`;
              const letter = columnIndexToLetter(colIdx);
              const isHidden = hiddenSet.has(colIdx);
              const isPinned = pinnedSet.has(colIdx);
              const semType =
                this.profile?.columns[colIdx]?.semanticType ?? sheet.types[colIdx] ?? 'text';
              const badgeLabel =
                semType === 'quantitative' || semType === 'number'
                  ? 'Num'
                  : semType === 'percent'
                    ? '%'
                    : semType === 'temporal'
                      ? 'Time'
                      : semType === 'identifier'
                        ? 'ID'
                        : 'Text';

              const seg = isPinned ? pinnedOrdered : unpinnedOrdered;
              const segPos = isHidden ? -1 : seg.indexOf(colIdx);
              const canMoveLeft = !isHidden && segPos > 0;
              const canMoveRight = !isHidden && segPos >= 0 && segPos < seg.length - 1;
              const canHide = isHidden || visibleCount > 1;
              const canDelete = total > 1;

              return `
                <div
                  data-col-manager-row="${colIdx}"
                  class="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg border ${
                    isHidden
                      ? 'border-slate-100 bg-slate-50/70 opacity-65'
                      : isPinned
                        ? 'border-blue-100 bg-blue-50/40'
                        : 'border-transparent hover:bg-slate-50'
                  }"
                >
                  <button
                    type="button"
                    data-cm-focus="${colIdx}"
                    title="${escapeHtml(name)} (Source ${letter})"
                    class="flex items-center gap-1.5 min-w-0 flex-1 text-left cursor-pointer"
                  >
                    <span class="font-mono-tabular text-[10px] font-medium px-1 py-0.5 rounded bg-slate-100 text-slate-500 shrink-0">${letter}</span>
                    <span class="text-xs font-medium text-slate-800 truncate">${escapeHtml(name)}</span>
                    ${
                      isPinned && !isHidden
                        ? '<span class="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 shrink-0">Pinned</span>'
                        : ''
                    }
                    <span class="text-[10px] text-slate-400 font-mono-tabular shrink-0 ml-auto">${badgeLabel}</span>
                  </button>

                  <div class="flex items-center gap-0.5 shrink-0">
                    <button
                      type="button"
                      data-cm-move-left="${colIdx}"
                      ${canMoveLeft ? '' : 'disabled'}
                      aria-label="Move column ${escapeHtml(name)} left"
                      title="Move left"
                      class="p-1 rounded text-slate-500 hover:bg-slate-200/70 hover:text-slate-900 disabled:opacity-30 disabled:pointer-events-none cursor-pointer"
                    >${svgIcon('chevronLeft', 'w-3.5 h-3.5')}</button>

                    <button
                      type="button"
                      data-cm-move-right="${colIdx}"
                      ${canMoveRight ? '' : 'disabled'}
                      aria-label="Move column ${escapeHtml(name)} right"
                      title="Move right"
                      class="p-1 rounded text-slate-500 hover:bg-slate-200/70 hover:text-slate-900 disabled:opacity-30 disabled:pointer-events-none cursor-pointer"
                    >${svgIcon('chevronRight', 'w-3.5 h-3.5')}</button>

                    <button
                      type="button"
                      data-cm-pin="${colIdx}"
                      aria-pressed="${isPinned}"
                      aria-label="${isPinned ? `Unpin column ${escapeHtml(name)}` : `Pin column ${escapeHtml(name)} to left`}"
                      title="${isPinned ? 'Unpin column' : 'Pin column to left'}"
                      class="p-1 rounded transition-colors cursor-pointer ${
                        isPinned
                          ? 'text-blue-600 bg-blue-100/80 hover:bg-blue-200/70'
                          : 'text-slate-400 hover:bg-slate-200/70 hover:text-slate-800'
                      }"
                    >${svgIcon('pin', 'w-3.5 h-3.5')}</button>

                    <button
                      type="button"
                      data-cm-autofit="${colIdx}"
                      aria-label="Auto-fit column ${escapeHtml(name)}"
                      title="Auto-fit width"
                      class="p-1 rounded text-slate-400 hover:bg-slate-200/70 hover:text-slate-800 cursor-pointer"
                    >${svgIcon('maximize', 'w-3.5 h-3.5')}</button>

                    <button
                      type="button"
                      data-cm-vis="${colIdx}"
                      ${canHide ? '' : 'disabled'}
                      aria-pressed="${!isHidden}"
                      aria-label="${isHidden ? `Show column ${escapeHtml(name)}` : `Hide column ${escapeHtml(name)}`}"
                      title="${isHidden ? 'Show column' : 'Hide column (does not delete data)'}"
                      class="p-1 rounded transition-colors disabled:opacity-30 disabled:pointer-events-none cursor-pointer ${
                        isHidden
                          ? 'text-amber-600 bg-amber-50 hover:bg-amber-100'
                          : 'text-slate-500 hover:bg-slate-200/70 hover:text-slate-900'
                      }"
                    >${svgIcon(isHidden ? 'eyeOff' : 'eye', 'w-3.5 h-3.5')}</button>

                    <button
                      type="button"
                      data-cm-delete="${colIdx}"
                      ${canDelete ? '' : 'disabled'}
                      aria-label="Delete column ${escapeHtml(name)}"
                      title="Delete column permanently from sheet"
                      class="p-1 rounded text-slate-400 hover:text-rose-600 hover:bg-rose-50 disabled:opacity-30 disabled:pointer-events-none cursor-pointer"
                    >${svgIcon('trash', 'w-3.5 h-3.5')}</button>
                  </div>
                </div>
              `;
            })
            .join('');

    const existingListEl = this.popoverEl.querySelector<HTMLElement>(
      '[data-role="col-manager-list"]'
    );
    const prevScrollTop = existingListEl?.scrollTop ?? 0;

    // Preserve search input focus if already mounted
    const hasSearchInput = Boolean(
      this.popoverEl.querySelector('[data-role="col-manager-search"]')
    );

    if (!hasSearchInput) {
      this.popoverEl.innerHTML = `
        <div class="px-3 py-2.5 border-b border-slate-200 bg-slate-50/80 flex items-center justify-between gap-2">
          <div>
            <div class="text-xs font-semibold text-slate-900">Column Manager</div>
            <div data-role="col-manager-count" class="text-[11px] text-slate-500"></div>
          </div>
          <div class="flex items-center gap-1">
            <button
              type="button"
              data-cm-action="show-all"
              class="px-2 py-1 text-[11px] font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded disabled:opacity-40 disabled:pointer-events-none cursor-pointer"
            >Show All</button>
            <button
              type="button"
              data-cm-action="reset-layout"
              class="px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-200/70 rounded cursor-pointer"
            >Reset</button>
          </div>
        </div>
        <div class="p-2 border-b border-slate-100">
          <div class="relative">
            <span class="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none">
              ${svgIcon('search', 'w-3.5 h-3.5')}
            </span>
            <input
              type="search"
              data-role="col-manager-search"
              aria-label="Filter columns by name or letter"
              placeholder="Search columns..."
              value="${escapeHtml(this.searchQuery)}"
              class="w-full pl-8 pr-2.5 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:bg-white focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
            />
          </div>
        </div>
        <div data-role="col-manager-list" class="max-h-72 overflow-y-auto sheet-scroll p-2 space-y-1"></div>
      `;
    }

    const countEl = this.popoverEl.querySelector('[data-role="col-manager-count"]');
    if (countEl) {
      countEl.textContent = `${visibleCount} of ${total} visible${
        pinnedSet.size > 0 ? ` · ${pinnedSet.size} pinned` : ''
      }`;
    }

    const showAllBtn = this.popoverEl.querySelector<HTMLButtonElement>(
      '[data-cm-action="show-all"]'
    );
    if (showAllBtn) {
      showAllBtn.disabled = hiddenSet.size === 0;
    }

    const listEl = this.popoverEl.querySelector<HTMLElement>(
      '[data-role="col-manager-list"]'
    );
    if (listEl) {
      listEl.innerHTML = rowsHtml;
      listEl.scrollTop = prevScrollTop;
    }
  }

  private bindPopoverEvents(): void {
    const {signal} = this.abortController;
    this.popoverEl.addEventListener(
      'input',
      (e) => {
        const target = e.target as HTMLElement | null;
        if (
          target instanceof HTMLInputElement &&
          target.dataset.role === 'col-manager-search'
        ) {
          this.searchQuery = target.value;
          this.renderPopoverBody();
        }
      },
      {signal}
    );

    this.popoverEl.addEventListener(
      'click',
      (e) => {
      e.stopPropagation();
      const target = e.target as HTMLElement | null;
      if (!target) return;

      const actionBtn = target.closest<HTMLElement>('[data-cm-action]');
      if (actionBtn) {
        if (actionBtn.dataset.cmAction === 'show-all') {
          this.callbacks.onShowAll();
        } else if (actionBtn.dataset.cmAction === 'reset-layout') {
          this.callbacks.onResetLayout();
        }
        return;
      }

      const moveLeft = target.closest<HTMLElement>('[data-cm-move-left]');
      if (moveLeft) {
        this.callbacks.onMoveVisual(Number(moveLeft.dataset.cmMoveLeft), -1);
        return;
      }

      const moveRight = target.closest<HTMLElement>('[data-cm-move-right]');
      if (moveRight) {
        this.callbacks.onMoveVisual(Number(moveRight.dataset.cmMoveRight), 1);
        return;
      }

      const pinBtn = target.closest<HTMLElement>('[data-cm-pin]');
      if (pinBtn) {
        this.callbacks.onTogglePin(Number(pinBtn.dataset.cmPin));
        return;
      }

      const autoFitBtn = target.closest<HTMLElement>('[data-cm-autofit]');
      if (autoFitBtn) {
        this.callbacks.onAutoFit(Number(autoFitBtn.dataset.cmAutofit));
        return;
      }

      const visBtn = target.closest<HTMLElement>('[data-cm-vis]');
      if (visBtn) {
        this.callbacks.onToggleVisibility(Number(visBtn.dataset.cmVis));
        return;
      }

      const delBtn = target.closest<HTMLElement>('[data-cm-delete]');
      if (delBtn) {
        this.callbacks.onDeleteColumn(Number(delBtn.dataset.cmDelete));
        return;
      }

      const focusBtn = target.closest<HTMLElement>('[data-cm-focus]');
      if (focusBtn) {
        this.callbacks.onFocusColumn?.(Number(focusBtn.dataset.cmFocus));
      }
      },
      {signal}
    );
  }

  private handleDocClick(e: MouseEvent): void {
    if (!this.isOpen) return;
    const target = e.target as Node | null;
    if (target && !this.anchorHost.contains(target)) {
      this.toggle(false);
    }
  }

  private handleDocKey(e: KeyboardEvent): void {
    if (this.isOpen && e.key === 'Escape') {
      e.preventDefault();
      this.toggle(false);
      this.triggerBtn.focus();
    }
  }

  public dispose(): void {
    this.toggle(false);
    this.abortController.abort();
  }
}
