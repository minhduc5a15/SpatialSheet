import type {AppCommand, CommandExecutionResult} from '../core/commands';
import {
  groupRankedCommands,
  rankAndFilterCommands,
  type RankedCommand,
} from '../core/commandSearch';
import {formatShortcutTokens, isMacPlatform} from '../core/shortcuts';
import {svgIcon} from './icons';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface CommandPaletteCallbacks {
  getCommands: () => AppCommand[];
  getContextLabel: () => string;
  onNotify: (toast: {kind: 'success' | 'info' | 'error'; message: string}) => void;
  onOpenShortcutsHelp: () => void;
}

export class CommandPalette {
  private backdropEl: HTMLElement;
  private dialogEl: HTMLElement;
  private inputEl: HTMLInputElement;
  private clearBtnEl: HTMLButtonElement;
  private closeBtnEl: HTMLButtonElement;
  private contextLabelEl: HTMLElement;
  private listEl: HTMLElement;
  private statusEl: HTMLElement;
  private shortcutsHintBtn: HTMLButtonElement;

  private callbacks: CommandPaletteCallbacks;
  private openState = false;
  private query = '';
  private allCommands: AppCommand[] = [];
  private rankedCommands: RankedCommand[] = [];
  private activeIndex = 0;
  private previousFocus: HTMLElement | null = null;
  private readonly abortController = new AbortController();
  private disposed = false;

  constructor(parentHost: HTMLElement, callbacks: CommandPaletteCallbacks) {
    this.callbacks = callbacks;

    this.backdropEl = document.createElement('div');
    this.backdropEl.dataset.role = 'command-palette-backdrop';
    this.backdropEl.className =
      'hidden fixed inset-0 z-[80] bg-slate-900/50 backdrop-blur-[1px] items-start justify-center pt-[10vh] sm:pt-[12vh] px-3 sm:px-4 pb-6';

    this.dialogEl = document.createElement('div');
    this.dialogEl.dataset.role = 'command-palette-dialog';
    this.dialogEl.setAttribute('role', 'dialog');
    this.dialogEl.setAttribute('aria-modal', 'true');
    this.dialogEl.setAttribute('aria-label', 'Command Palette');
    this.dialogEl.className =
      'w-full max-w-[600px] max-h-[76vh] bg-white border border-slate-200 rounded-2xl shadow-2xl flex flex-col overflow-hidden';

    this.dialogEl.innerHTML = `
      <div class="px-3.5 py-2.5 border-b border-slate-200 bg-slate-50/70 flex items-center justify-between gap-2 shrink-0">
        <div class="flex items-center gap-2 min-w-0">
          <span class="inline-flex items-center justify-center w-6 h-6 rounded-md bg-emerald-50 border border-emerald-200 text-emerald-700 shrink-0">
            ${svgIcon('command', 'w-3.5 h-3.5')}
          </span>
          <span data-role="command-palette-context" class="text-[11px] font-medium text-slate-600 truncate"></span>
        </div>
        <button
          type="button"
          data-action="palette-close"
          aria-label="Close Command Palette"
          class="p-1 rounded-md text-slate-400 hover:text-slate-900 hover:bg-slate-200/70 cursor-pointer shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
        >
          ${svgIcon('close', 'w-4 h-4')}
        </button>
      </div>

      <div class="px-3.5 py-2.5 border-b border-slate-200 bg-white flex items-center gap-2.5 shrink-0">
        <span class="text-slate-400 pointer-events-none shrink-0" aria-hidden="true">
          ${svgIcon('search', 'w-4 h-4')}
        </span>
        <input
          type="text"
          data-role="command-palette-input"
          role="combobox"
          aria-label="Search commands, columns, sheets, and actions"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls="sp-command-palette-listbox"
          aria-activedescendant=""
          autocomplete="off"
          spellcheck="false"
          placeholder="Type a command, column, or sheet name..."
          class="flex-1 min-w-0 bg-transparent text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none"
        />
        <button
          type="button"
          data-action="palette-clear-query"
          aria-label="Clear command search"
          class="hidden px-2 py-0.5 text-[11px] font-medium text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-md cursor-pointer shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
        >Clear</button>
      </div>

      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-role="command-palette-status"
        class="sr-only"
      ></div>

      <div
        id="sp-command-palette-listbox"
        role="listbox"
        aria-label="Available commands"
        data-role="command-palette-list"
        class="flex-1 min-h-0 overflow-y-auto sheet-scroll p-2 space-y-2.5 bg-white"
      ></div>

      <footer class="px-3.5 py-2 border-t border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500 shrink-0">
        <div class="flex flex-wrap items-center gap-3">
          <span class="inline-flex items-center gap-1"><kbd class="sp-kbd">↑</kbd><kbd class="sp-kbd">↓</kbd> Navigate</span>
          <span class="inline-flex items-center gap-1"><kbd class="sp-kbd">Enter</kbd> Run</span>
          <span class="inline-flex items-center gap-1"><kbd class="sp-kbd">Esc</kbd> Close</span>
        </div>
        <button
          type="button"
          data-action="palette-open-shortcuts"
          class="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 hover:text-emerald-800 hover:underline cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40 rounded px-1"
        >
          ${svgIcon('keyboard', 'w-3.5 h-3.5')}
          <span>All shortcuts (?)</span>
        </button>
      </footer>
    `;

    this.backdropEl.append(this.dialogEl);
    parentHost.append(this.backdropEl);

    this.inputEl = this.dialogEl.querySelector('[data-role="command-palette-input"]')!;
    this.clearBtnEl = this.dialogEl.querySelector('[data-action="palette-clear-query"]')!;
    this.closeBtnEl = this.dialogEl.querySelector('[data-action="palette-close"]')!;
    this.contextLabelEl = this.dialogEl.querySelector('[data-role="command-palette-context"]')!;
    this.listEl = this.dialogEl.querySelector('[data-role="command-palette-list"]')!;
    this.statusEl = this.dialogEl.querySelector('[data-role="command-palette-status"]')!;
    this.shortcutsHintBtn = this.dialogEl.querySelector(
      '[data-action="palette-open-shortcuts"]'
    )!;

    this.bindEvents();
  }

  private bindEvents(): void {
    const {signal} = this.abortController;

    this.inputEl.addEventListener(
      'input',
      () => {
        this.query = this.inputEl.value;
        this.activeIndex = 0;
        this.refreshFilteredList(true);
      },
      {signal}
    );

    this.inputEl.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          this.moveActive(1);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          this.moveActive(-1);
        } else if (e.key === 'Home') {
          e.preventDefault();
          this.setActiveIndex(0);
        } else if (e.key === 'End') {
          e.preventDefault();
          this.setActiveIndex(Math.max(0, this.rankedCommands.length - 1));
        } else if (e.key === 'Enter') {
          e.preventDefault();
          void this.executeActive();
        }
      },
      {signal}
    );

    this.dialogEl.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Tab') {
          this.trapFocus(e);
        }
      },
      {signal}
    );

    this.clearBtnEl.addEventListener(
      'click',
      () => {
        this.query = '';
        this.inputEl.value = '';
        this.activeIndex = 0;
        this.refreshFilteredList(true);
        this.inputEl.focus();
      },
      {signal}
    );

    this.closeBtnEl.addEventListener('click', () => this.close(true), {signal});

    this.shortcutsHintBtn.addEventListener(
      'click',
      () => {
        this.close(true);
        this.callbacks.onOpenShortcutsHelp();
      },
      {signal}
    );

    this.backdropEl.addEventListener(
      'mousedown',
      (e) => {
        if (e.target === this.backdropEl) {
          this.close(true);
        }
      },
      {signal}
    );

    this.listEl.addEventListener(
      'mousemove',
      (e) => {
        const opt = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-cmd-index]');
        if (!opt) return;
        const idx = Number(opt.dataset.cmdIndex);
        if (!Number.isNaN(idx) && idx !== this.activeIndex) {
          this.activeIndex = idx;
          this.updateActiveOptionDom();
        }
      },
      {signal}
    );

    this.listEl.addEventListener(
      'click',
      (e) => {
        const target = e.target as HTMLElement | null;
        if (!target) return;

        if (target.closest('[data-palette-empty-clear]')) {
          this.query = '';
          this.inputEl.value = '';
          this.activeIndex = 0;
          this.refreshFilteredList(true);
          this.inputEl.focus();
          return;
        }

        if (target.closest('[data-palette-empty-help]')) {
          this.close(true);
          this.callbacks.onOpenShortcutsHelp();
          return;
        }

        const opt = target.closest<HTMLElement>('[data-cmd-index]');
        if (opt) {
          const idx = Number(opt.dataset.cmdIndex);
          if (!Number.isNaN(idx)) {
            this.activeIndex = idx;
            void this.executeActive();
          }
        }
      },
      {signal}
    );
  }

  private trapFocus(e: KeyboardEvent): void {
    const focusables = [
      ...this.dialogEl.querySelectorAll<HTMLElement>(
        'input:not([disabled]), button:not([disabled]):not(.hidden)'
      ),
    ].filter((el) => !el.classList.contains('hidden'));
    if (focusables.length === 0) return;

    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  public isOpen(): boolean {
    return this.openState;
  }

  public open(): void {
    if (this.disposed) return;
    if (this.openState) {
      this.inputEl.focus();
      this.inputEl.select();
      return;
    }

    this.previousFocus = document.activeElement as HTMLElement | null;
    this.openState = true;
    this.query = '';
    this.inputEl.value = '';
    this.activeIndex = 0;
    this.allCommands = this.callbacks.getCommands();
    this.contextLabelEl.textContent = this.callbacks.getContextLabel();

    this.refreshFilteredList(true);
    this.backdropEl.classList.remove('hidden');
    this.backdropEl.classList.add('flex');
    this.inputEl.setAttribute('aria-expanded', 'true');
    this.inputEl.focus();
  }

  public close(restoreFocus = true): void {
    if (!this.openState) return;
    this.openState = false;
    this.backdropEl.classList.add('hidden');
    this.backdropEl.classList.remove('flex');
    this.inputEl.setAttribute('aria-expanded', 'false');
    this.inputEl.setAttribute('aria-activedescendant', '');

    if (restoreFocus && this.previousFocus && this.previousFocus.isConnected) {
      this.previousFocus.focus();
    }
    this.previousFocus = null;
  }

  private moveActive(delta: number): void {
    const len = this.rankedCommands.length;
    if (len === 0) return;
    const next = (this.activeIndex + delta + len) % len;
    this.setActiveIndex(next);
  }

  private setActiveIndex(next: number): void {
    const len = this.rankedCommands.length;
    if (len === 0) {
      this.activeIndex = -1;
      this.inputEl.setAttribute('aria-activedescendant', '');
      return;
    }
    this.activeIndex = Math.max(0, Math.min(len - 1, next));
    this.updateActiveOptionDom();
  }

  private updateActiveOptionDom(): void {
    const options = this.listEl.querySelectorAll<HTMLElement>('[data-cmd-index]');
    options.forEach((el) => {
      const idx = Number(el.dataset.cmdIndex);
      const selected = idx === this.activeIndex;
      el.setAttribute('aria-selected', String(selected));
      el.classList.toggle('bg-emerald-50/90', selected);
      el.classList.toggle('border-emerald-200', selected);
      el.classList.toggle('border-transparent', !selected);
      if (selected) {
        this.inputEl.setAttribute('aria-activedescendant', el.id);
        el.scrollIntoView?.({block: 'nearest'});
      }
    });
  }

  private refreshFilteredList(announce: boolean): void {
    this.clearBtnEl.classList.toggle('hidden', this.query.trim().length === 0);

    const hasQuery = this.query.trim().length > 0;
    const limit = hasQuery ? 36 : 48;
    this.rankedCommands = rankAndFilterCommands(this.allCommands, this.query, {limit});

    if (this.rankedCommands.length === 0) {
      this.activeIndex = -1;
      this.inputEl.setAttribute('aria-activedescendant', '');
      this.listEl.innerHTML = `
        <div data-role="command-palette-empty" class="py-10 px-4 text-center flex flex-col items-center">
          <p class="text-xs font-semibold text-slate-800">No commands match "${escapeHtml(this.query)}"</p>
          <p class="text-[11px] text-slate-500 mt-1 max-w-xs">
            Try searching a view (Split, Table, Charts, Overview), a column name, or a sheet tab.
          </p>
          <div class="mt-3 flex items-center gap-2">
            <button
              type="button"
              data-palette-empty-clear
              class="px-3 py-1.5 text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg cursor-pointer"
            >Clear search</button>
            <button
              type="button"
              data-palette-empty-help
              class="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg cursor-pointer"
            >Keyboard shortcuts</button>
          </div>
        </div>
      `;
      if (announce) {
        this.statusEl.textContent = `No commands match ${this.query}`;
      }
      return;
    }

    if (this.activeIndex < 0 || this.activeIndex >= this.rankedCommands.length) {
      this.activeIndex = 0;
    }

    const sections = groupRankedCommands(this.rankedCommands);
    const isMac = isMacPlatform();
    const indexById = new Map<string, number>();
    this.rankedCommands.forEach((rc, i) => indexById.set(rc.command.id, i));

    const sectionsHtml: string[] = [];
    for (const {category, items} of sections) {
      if (items.length === 0) continue;

      const itemsHtml = items
        .map((rc) => {
          const cmd = rc.command;
          const flatIdx = indexById.get(cmd.id) ?? 0;
          const isSelected = flatIdx === this.activeIndex;
          const isDisabled = cmd.isEnabled === false;
          const optId = `sp-cmd-opt-${flatIdx}`;

          const shortcutHtml = cmd.shortcut
            ? `<div class="hidden sm:flex items-center gap-0.5 shrink-0">${formatShortcutTokens(
                cmd.shortcut,
                isMac
              )
                .map((t) => `<kbd class="sp-kbd">${escapeHtml(t)}</kbd>`)
                .join('')}</div>`
            : '';

          const badgeHtml = cmd.badge
            ? `<span class="px-1.5 py-0.5 text-[10px] font-medium rounded border ${
                cmd.badge === 'Current' || cmd.badge === 'Active' || cmd.badge === 'Filtered'
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                  : cmd.badge === 'Hidden'
                    ? 'bg-amber-50 text-amber-800 border-amber-200'
                    : 'bg-slate-100 text-slate-600 border-slate-200'
              } shrink-0">${escapeHtml(cmd.badge)}</span>`
            : '';

          const subText = isDisabled
            ? cmd.disabledReason ?? cmd.subtitle ?? 'Currently unavailable'
            : cmd.subtitle ?? '';

          return `
            <div
              id="${optId}"
              role="option"
              tabindex="-1"
              data-cmd-index="${flatIdx}"
              data-cmd-id="${escapeHtml(cmd.id)}"
              aria-selected="${isSelected}"
              aria-disabled="${isDisabled}"
              class="flex items-center justify-between gap-2.5 px-2.5 py-2 rounded-lg border transition-colors ${
                isDisabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer hover:bg-slate-50'
              } ${isSelected ? 'bg-emerald-50/90 border-emerald-200' : 'border-transparent'}"
            >
              <div class="flex items-center gap-2.5 min-w-0 flex-1">
                <span class="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
                  isSelected
                    ? 'bg-white text-emerald-700 border border-emerald-200 shadow-2xs'
                    : 'bg-slate-100 text-slate-600'
                }" aria-hidden="true">
                  ${svgIcon(cmd.icon, 'w-3.5 h-3.5')}
                </span>
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-1.5 min-w-0">
                    <span class="text-xs font-semibold text-slate-900 truncate">${escapeHtml(cmd.title)}</span>
                    ${badgeHtml}
                  </div>
                  ${
                    subText
                      ? `<div class="text-[11px] truncate ${
                          isDisabled ? 'text-amber-800 italic' : 'text-slate-500'
                        }">${escapeHtml(subText)}</div>`
                      : ''
                  }
                </div>
              </div>
              ${shortcutHtml}
            </div>
          `;
        })
        .join('');

      sectionsHtml.push(`
        <section aria-label="${escapeHtml(category)} commands">
          <div class="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            ${escapeHtml(category)}
          </div>
          <div class="space-y-0.5">${itemsHtml}</div>
        </section>
      `);
    }

    this.listEl.innerHTML = sectionsHtml.join('');
    this.updateActiveOptionDom();

    if (announce) {
      const count = this.rankedCommands.length;
      const firstTitle = this.rankedCommands[this.activeIndex]?.command.title ?? '';
      this.statusEl.textContent = `${count} command${count === 1 ? '' : 's'} available. Selected: ${firstTitle}`;
    }
  }

  private async executeActive(): Promise<void> {
    if (this.activeIndex < 0 || this.activeIndex >= this.rankedCommands.length) return;
    const cmd = this.rankedCommands[this.activeIndex].command;

    if (cmd.isEnabled === false) {
      const reason = cmd.disabledReason ?? 'This command is unavailable in the current context.';
      this.statusEl.textContent = reason;
      this.callbacks.onNotify({kind: 'info', message: reason});
      return;
    }

    let result: CommandExecutionResult;
    try {
      result = await cmd.execute();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.callbacks.onNotify({kind: 'error', message: `Action failed: ${msg}`});
      return;
    }

    if (result.toast) {
      this.callbacks.onNotify(result.toast);
    }

    if (!result.keepOpen) {
      // Focus-navigating commands intentionally move focus (e.g. search bar, cell, dialog).
      const managesFocus =
        COMMANDS_MANAGING_FOCUS.has(cmd.id) || cmd.id.startsWith('col.focus.');
      const shouldRestoreFocus = !managesFocus;
      this.close(shouldRestoreFocus);
    } else {
      // Refresh in case state changed while staying open
      this.allCommands = this.callbacks.getCommands();
      this.refreshFilteredList(true);
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.openState = false;
    this.previousFocus = null;
    this.abortController.abort();
    this.backdropEl.remove();
  }
}

const COMMANDS_MANAGING_FOCUS = new Set<string>([
  'context.col.focus',
  'col.manager',
  'chart.seriesManager',
  'nav.focusSearch',
  'help.shortcuts',
  'workbook.open',
  'nav.inspector',
  'context.inspector.contributors',
]);
