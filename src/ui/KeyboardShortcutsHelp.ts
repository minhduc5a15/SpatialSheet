import {
  APP_SHORTCUTS,
  formatShortcutTokens,
  isMacPlatform,
  type ShortcutDefinition,
} from '../core/shortcuts';
import {svgIcon} from './icons';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export class KeyboardShortcutsHelp {
  private backdropEl: HTMLElement;
  private dialogEl: HTMLElement;
  private bodyEl: HTMLElement;
  private closeBtn: HTMLButtonElement;
  private openState = false;
  private previousFocus: HTMLElement | null = null;
  private readonly abortController = new AbortController();
  private disposed = false;

  constructor(parentHost: HTMLElement) {
    this.backdropEl = document.createElement('div');
    this.backdropEl.dataset.role = 'shortcuts-help-backdrop';
    this.backdropEl.className =
      'hidden fixed inset-0 z-[85] bg-slate-900/50 backdrop-blur-[1px] items-center justify-center p-4';

    this.dialogEl = document.createElement('div');
    this.dialogEl.dataset.role = 'shortcuts-help-dialog';
    this.dialogEl.setAttribute('role', 'dialog');
    this.dialogEl.setAttribute('aria-modal', 'true');
    this.dialogEl.setAttribute('aria-labelledby', 'sp-shortcuts-help-title');
    this.dialogEl.tabIndex = -1;
    this.dialogEl.className =
      'w-full max-w-[540px] max-h-[85vh] bg-white border border-slate-200 rounded-2xl shadow-2xl flex flex-col overflow-hidden focus:outline-none';

    this.dialogEl.innerHTML = `
      <header class="px-5 py-3.5 border-b border-slate-200 bg-slate-50/90 flex items-center justify-between gap-3 shrink-0">
        <div class="flex items-center gap-2.5 min-w-0">
          <span class="p-1.5 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-700 shrink-0">
            ${svgIcon('keyboard', 'w-4 h-4')}
          </span>
          <div class="min-w-0">
            <h2 id="sp-shortcuts-help-title" class="font-display text-sm font-bold text-slate-900 truncate">
              Keyboard Shortcuts
            </h2>
            <p class="text-[11px] text-slate-500">Keyboard-first navigation, editing, and workspace controls</p>
          </div>
        </div>
        <button
          type="button"
          data-action="shortcuts-close"
          aria-label="Close keyboard shortcuts help"
          class="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-200/70 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
        >
          ${svgIcon('close', 'w-4 h-4')}
        </button>
      </header>
      <div data-role="shortcuts-help-body" class="p-5 overflow-y-auto sheet-scroll space-y-5"></div>
      <footer class="px-5 py-2.5 border-t border-slate-200 bg-slate-50 text-[11px] text-slate-500 flex items-center justify-between gap-2 shrink-0">
        <span>Shortcuts respect active text inputs and inline cell editing.</span>
        <span class="inline-flex items-center gap-1 shrink-0">
          <kbd class="sp-kbd">Esc</kbd>
          <span>to close</span>
        </span>
      </footer>
    `;

    this.backdropEl.append(this.dialogEl);
    parentHost.append(this.backdropEl);

    this.bodyEl = this.dialogEl.querySelector('[data-role="shortcuts-help-body"]')!;
    this.closeBtn = this.dialogEl.querySelector('[data-action="shortcuts-close"]')!;

    this.renderShortcuts();
    this.bindEvents();
  }

  private renderShortcuts(): void {
    const isMac = isMacPlatform();
    const globalList = APP_SHORTCUTS.filter((s) => s.scope === 'global');
    const sheetList = APP_SHORTCUTS.filter((s) => s.scope === 'spreadsheet');

    const renderGroup = (title: string, items: ShortcutDefinition[]): string => {
      const rows = items
        .map((item) => {
          const badgesHtml = item.displayLabel
            ? `<kbd class="sp-kbd">${escapeHtml(item.displayLabel)}</kbd>`
            : formatShortcutTokens(item.combo, isMac)
                .map((t) => `<kbd class="sp-kbd">${escapeHtml(t)}</kbd>`)
                .join('<span class="text-slate-300 text-[10px]">+</span>');

          return `
            <div class="flex items-center justify-between gap-3 py-2 border-b border-slate-100 last:border-b-0">
              <div class="min-w-0">
                <div class="text-xs font-medium text-slate-900">${escapeHtml(item.title)}</div>
                <div class="text-[11px] text-slate-500">${escapeHtml(item.description)}</div>
              </div>
              <div class="flex items-center gap-1 shrink-0">${badgesHtml}</div>
            </div>
          `;
        })
        .join('');

      return `
        <section>
          <h3 class="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1.5">${escapeHtml(title)}</h3>
          <div class="rounded-xl border border-slate-200 bg-white px-3.5 divide-y divide-slate-100">
            ${rows}
          </div>
        </section>
      `;
    };

    this.bodyEl.innerHTML = `
      ${renderGroup('Global Workspace', globalList)}
      ${renderGroup('Spreadsheet Grid', sheetList)}
    `;
  }

  private bindEvents(): void {
    const {signal} = this.abortController;

    this.closeBtn.addEventListener('click', () => this.close(), {signal});
    this.backdropEl.addEventListener(
      'mousedown',
      (e) => {
        if (e.target === this.backdropEl) {
          this.close();
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
  }

  private trapFocus(e: KeyboardEvent): void {
    const focusables = [
      ...this.dialogEl.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ),
    ];
    if (focusables.length === 0) {
      e.preventDefault();
      this.dialogEl.focus();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first || document.activeElement === this.dialogEl) {
        e.preventDefault();
        last.focus();
      }
    } else if (document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  public isOpen(): boolean {
    return this.openState;
  }

  public open(): void {
    if (this.disposed || this.openState) return;
    this.previousFocus = document.activeElement as HTMLElement | null;
    this.renderShortcuts();
    this.openState = true;
    this.backdropEl.classList.remove('hidden');
    this.backdropEl.classList.add('flex');
    this.closeBtn.focus();
  }

  public close(): void {
    if (!this.openState) return;
    this.openState = false;
    this.backdropEl.classList.add('hidden');
    this.backdropEl.classList.remove('flex');
    if (this.previousFocus && this.previousFocus.isConnected) {
      this.previousFocus.focus();
    }
    this.previousFocus = null;
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
