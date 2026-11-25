import {validateWorkbookName} from '../core/fileNaming';
import {svgIcon} from './icons';

export interface WorkbookTitleCallbacks {
  onCommitName: (rawName: string) => {
    ok: boolean;
    changed: boolean;
    name?: string;
    error?: string;
  };
  onNotify?: (toast: {
    kind: 'success' | 'info' | 'error';
    message: string;
  }) => void;
}

function escapeAttr(val: string): string {
  return val
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtml(val: string): string {
  return escapeAttr(val);
}

export class WorkbookTitle {
  private host: HTMLElement;
  private callbacks: WorkbookTitleCallbacks;
  private currentName = 'Untitled';
  private editing = false;
  private disposed = false;
  private readonly abortController = new AbortController();

  constructor(host: HTMLElement, callbacks: WorkbookTitleCallbacks) {
    this.host = host;
    this.callbacks = callbacks;
    this.renderDisplay();
  }

  public setName(name: string): void {
    const clean = name.trim() || 'Untitled';
    this.currentName = clean;
    if (!this.editing && !this.disposed) {
      this.renderDisplay();
    }
  }

  public isEditing(): boolean {
    return this.editing;
  }

  public beginRename(): void {
    if (this.disposed || this.editing) {
      if (this.editing) {
        const input = this.host.querySelector<HTMLInputElement>(
          '[data-role="workbook-title-input"]'
        );
        input?.focus();
        input?.select();
      }
      return;
    }
    this.editing = true;
    this.renderEditor();
  }

  private renderDisplay(): void {
    const safeName = escapeHtml(this.currentName);
    this.host.innerHTML = `
      <button
        type="button"
        data-role="workbook-title-trigger"
        title="Rename workbook: ${safeName}"
        aria-label="Workbook name: ${safeName}. Activate to rename"
        class="group inline-flex items-center gap-1.5 min-w-0 max-w-full px-2 py-1 rounded-lg border border-slate-200/80 bg-slate-50/80 hover:bg-slate-100 hover:border-slate-300 text-left transition-colors cursor-pointer"
      >
        <span data-role="workbook-title-text" class="text-xs sm:text-sm font-semibold text-slate-800 truncate">${safeName}</span>
        <span class="shrink-0 text-slate-400 group-hover:text-emerald-700 transition-colors" aria-hidden="true">
          ${svgIcon('edit', 'w-3.5 h-3.5')}
        </span>
      </button>
    `;

    const trigger = this.host.querySelector<HTMLButtonElement>(
      '[data-role="workbook-title-trigger"]'
    );
    trigger?.addEventListener(
      'click',
      () => {
        this.beginRename();
      },
      {signal: this.abortController.signal}
    );
  }

  private renderEditor(): void {
    this.host.innerHTML = `
      <div class="relative flex items-center gap-1 min-w-0 max-w-full" data-role="workbook-title-editor">
        <input
          type="text"
          data-role="workbook-title-input"
          aria-label="Workbook name"
          aria-invalid="false"
          autocomplete="off"
          spellcheck="false"
          value="${escapeAttr(this.currentName)}"
          class="w-24 min-[430px]:w-32 sm:w-44 lg:w-48 min-w-0 px-2 py-1 text-xs sm:text-sm font-semibold text-slate-900 bg-white border border-emerald-500 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
        />
        <button
          type="button"
          data-action="workbook-rename-confirm"
          aria-label="Confirm workbook rename"
          title="Save workbook name (Enter)"
          class="inline-flex items-center justify-center w-6 h-6 rounded-md text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 shrink-0 cursor-pointer"
        >${svgIcon('check', 'w-3.5 h-3.5')}</button>
        <button
          type="button"
          data-action="workbook-rename-cancel"
          aria-label="Cancel workbook rename"
          title="Cancel rename (Esc)"
          class="inline-flex items-center justify-center w-6 h-6 rounded-md text-slate-600 bg-white hover:bg-slate-100 border border-slate-200 shrink-0 cursor-pointer"
        >${svgIcon('close', 'w-3.5 h-3.5')}</button>
        <div
          id="workbook-title-error"
          data-role="workbook-title-error"
          role="alert"
          class="hidden absolute left-0 top-full mt-1.5 z-50 w-max max-w-[calc(100vw-24px)] sm:max-w-[340px] px-2.5 py-1.5 rounded-lg bg-rose-50 border border-rose-300 shadow-lg text-[11px] font-medium text-rose-800 items-start gap-1.5"
        >
          <span class="shrink-0 mt-0.5 text-rose-600" aria-hidden="true">${svgIcon('alert', 'w-3.5 h-3.5')}</span>
          <span data-role="workbook-title-error-text"></span>
        </div>
      </div>
    `;

    const editorEl = this.host.querySelector<HTMLElement>(
      '[data-role="workbook-title-editor"]'
    )!;
    const input = this.host.querySelector<HTMLInputElement>(
      '[data-role="workbook-title-input"]'
    )!;
    const confirmBtn = this.host.querySelector<HTMLButtonElement>(
      '[data-action="workbook-rename-confirm"]'
    )!;
    const cancelBtn = this.host.querySelector<HTMLButtonElement>(
      '[data-action="workbook-rename-cancel"]'
    )!;
    const errorEl = this.host.querySelector<HTMLElement>(
      '[data-role="workbook-title-error"]'
    )!;
    const errorTextEl = this.host.querySelector<HTMLElement>(
      '[data-role="workbook-title-error-text"]'
    )!;

    const showValidationError = (message: string) => {
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', 'workbook-title-error');
      input.classList.remove('border-emerald-500', 'focus:ring-emerald-500/30');
      input.classList.add('border-rose-500', 'focus:ring-rose-500/30');
      errorTextEl.textContent = message;
      errorEl.classList.remove('hidden');
      errorEl.classList.add('flex');
    };

    const clearValidationError = () => {
      input.setAttribute('aria-invalid', 'false');
      input.removeAttribute('aria-describedby');
      input.classList.remove('border-rose-500', 'focus:ring-rose-500/30');
      input.classList.add('border-emerald-500', 'focus:ring-emerald-500/30');
      errorTextEl.textContent = '';
      errorEl.classList.add('hidden');
      errorEl.classList.remove('flex');
    };

    const commit = (restoreFocus: boolean) => {
      if (!this.editing) return;
      const validation = validateWorkbookName(input.value);
      if (!validation.ok) {
        if (restoreFocus) {
          showValidationError(validation.error);
          input.focus();
          return;
        }
        // On external blur with invalid name, revert cleanly without leaving broken header state
        this.editing = false;
        this.renderDisplay();
        this.callbacks.onNotify?.({
          kind: 'error',
          message: `${validation.error} Reverted to "${this.currentName}".`,
        });
        return;
      }

      this.editing = false;
      const result = this.callbacks.onCommitName(validation.name);
      if (!result.ok) {
        this.editing = true;
        showValidationError(result.error ?? 'Invalid workbook name.');
        if (restoreFocus) input.focus();
        return;
      }

      if (result.name) {
        this.currentName = result.name;
      }
      this.renderDisplay();
      if (result.changed) {
        this.callbacks.onNotify?.({
          kind: 'success',
          message: `Renamed workbook to "${this.currentName}"`,
        });
      }
      if (restoreFocus) {
        this.host
          .querySelector<HTMLButtonElement>('[data-role="workbook-title-trigger"]')
          ?.focus();
      }
    };

    const cancel = (restoreFocus: boolean) => {
      if (!this.editing) return;
      this.editing = false;
      this.renderDisplay();
      if (restoreFocus) {
        this.host
          .querySelector<HTMLButtonElement>('[data-role="workbook-title-trigger"]')
          ?.focus();
      }
    };

    // Prevent premature focusout when clicking Save / Cancel buttons inside editor
    const preventFocusSteal = (e: MouseEvent) => e.preventDefault();
    confirmBtn.addEventListener('mousedown', preventFocusSteal, {
      signal: this.abortController.signal,
    });
    cancelBtn.addEventListener('mousedown', preventFocusSteal, {
      signal: this.abortController.signal,
    });

    confirmBtn.addEventListener(
      'click',
      () => commit(true),
      {signal: this.abortController.signal}
    );
    cancelBtn.addEventListener(
      'click',
      () => cancel(true),
      {signal: this.abortController.signal}
    );

    input.addEventListener(
      'input',
      () => {
        const res = validateWorkbookName(input.value);
        if (res.ok) {
          clearValidationError();
        } else if (input.value.trim().length > 0 || input.getAttribute('aria-invalid') === 'true') {
          showValidationError(res.error);
        }
      },
      {signal: this.abortController.signal}
    );

    input.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          commit(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          cancel(true);
        }
      },
      {signal: this.abortController.signal}
    );

    editorEl.addEventListener(
      'focusout',
      (e) => {
        if (!this.editing) return;
        const nextTarget = e.relatedTarget as Node | null;
        if (nextTarget && editorEl.contains(nextTarget)) return;
        if (input.value.trim() === this.currentName) {
          cancel(false);
          return;
        }
        commit(false);
      },
      {signal: this.abortController.signal}
    );

    input.focus();
    input.select();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.editing = false;
    this.abortController.abort();
    this.host.replaceChildren();
  }
}
