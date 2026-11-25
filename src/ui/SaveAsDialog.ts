import type {SheetData, WorkbookState} from '../types';
import {
  getDefaultExportFormat,
  getWorkbookDisplayName,
  validateExportFilename,
  type ExportFormat,
} from '../core/fileNaming';
import {
  getSaveExportOutcomeToast,
  saveExportFile,
  supportsNativeSaveFilePicker,
} from '../core/saveFile';
import {svgIcon} from './icons';

export interface SaveAsDialogCallbacks {
  getWorkbookState: () => {
    workbook: WorkbookState;
    activeSheet: SheetData;
  };
  onNotify: (toast: {
    kind: 'success' | 'info' | 'error';
    message: string;
  }) => void;
}

export class SaveAsDialog {
  private host: HTMLElement;
  private callbacks: SaveAsDialogCallbacks;
  private openState = false;
  private submitting = false;
  private disposed = false;
  private previousFocus: HTMLElement | null = null;
  private readonly abortController = new AbortController();

  private backdropEl!: HTMLElement;
  private dialogEl!: HTMLElement;
  private formEl!: HTMLFormElement;
  private filenameInput!: HTMLInputElement;
  private formatSelect!: HTMLSelectElement;
  private sheetSuffixWrapEl!: HTMLElement;
  private sheetSuffixCheckbox!: HTMLInputElement;
  private sheetSuffixLabelEl!: HTMLElement;
  private scopeTextEl!: HTMLElement;
  private destinationHintEl!: HTMLElement;
  private previewEl!: HTMLElement;
  private errorBoxEl!: HTMLElement;
  private errorTextEl!: HTMLElement;
  private cancelNoticeEl!: HTMLElement;
  private submitBtn!: HTMLButtonElement;
  private cancelBtn!: HTMLButtonElement;
  private closeBtn!: HTMLButtonElement;

  constructor(host: HTMLElement, callbacks: SaveAsDialogCallbacks) {
    this.host = host;
    this.callbacks = callbacks;
    this.buildDom();
    this.bindEvents();
  }

  private buildDom(): void {
    this.backdropEl = document.createElement('div');
    this.backdropEl.dataset.role = 'save-as-backdrop';
    this.backdropEl.className =
      'hidden fixed inset-0 z-50 bg-slate-900/45 backdrop-blur-[1px] items-center justify-center p-3 sm:p-6';

    this.backdropEl.innerHTML = `
      <div
        data-role="save-as-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="save-as-title"
        class="w-full max-w-[480px] max-h-[92vh] bg-white border border-slate-200 rounded-2xl shadow-2xl overflow-y-auto flex flex-col text-slate-900"
      >
        <div class="flex items-start justify-between gap-3 px-4 sm:px-5 py-3.5 border-b border-slate-200">
          <div class="min-w-0">
            <h2 id="save-as-title" class="font-display text-base font-bold text-slate-900">Save As</h2>
            <p class="text-xs text-slate-500 mt-0.5">Choose filename, export format, and scope.</p>
          </div>
          <button
            type="button"
            data-action="save-as-close"
            aria-label="Close Save As dialog"
            class="inline-flex items-center justify-center w-8 h-8 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors cursor-pointer shrink-0"
          >${svgIcon('close', 'w-4 h-4')}</button>
        </div>

        <form data-role="save-as-form" novalidate class="p-4 sm:p-5 flex flex-col gap-4">
          <!-- Filename -->
          <div class="flex flex-col gap-1.5">
            <label for="save-as-filename" class="text-xs font-semibold text-slate-700">Filename</label>
            <input
              id="save-as-filename"
              data-role="save-as-filename"
              type="text"
              autocomplete="off"
              spellcheck="false"
              placeholder="Enter export filename"
              class="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-600"
            />
            <div
              id="save-as-error"
              data-role="save-as-error"
              role="alert"
              class="hidden items-start gap-1.5 px-2.5 py-1.5 rounded-lg bg-rose-50 border border-rose-200 text-xs font-medium text-rose-800"
            >
              <span class="shrink-0 mt-0.5 text-rose-600" aria-hidden="true">${svgIcon('alert', 'w-3.5 h-3.5')}</span>
              <span data-role="save-as-error-text"></span>
            </div>
          </div>

          <!-- Format -->
          <div class="flex flex-col gap-1.5">
            <label for="save-as-format" class="text-xs font-semibold text-slate-700">Format</label>
            <select
              id="save-as-format"
              data-role="save-as-format"
              aria-label="Export format"
              class="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-600 cursor-pointer"
            >
              <option value="xlsx">Excel Workbook (.xlsx)</option>
              <option value="csv">CSV — Comma-separated (.csv)</option>
              <option value="tsv">TSV — Tab-separated (.tsv)</option>
            </select>
          </div>

          <!-- Scope & Optional Sheet Suffix -->
          <div class="p-3 rounded-xl bg-slate-50 border border-slate-200/80 flex flex-col gap-2">
            <div class="flex items-start gap-2 text-xs text-slate-700">
              <span class="shrink-0 mt-0.5 text-slate-500" aria-hidden="true">${svgIcon('layers', 'w-3.5 h-3.5')}</span>
              <span data-role="save-as-scope"></span>
            </div>
            <label
              data-role="save-as-sheet-suffix-wrap"
              class="hidden items-center gap-2 text-xs text-slate-700 cursor-pointer select-none pt-1 border-t border-slate-200/70"
            >
              <input
                type="checkbox"
                data-role="save-as-sheet-suffix"
                class="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500 cursor-pointer"
              />
              <span data-role="save-as-sheet-suffix-label">Append active sheet name</span>
            </label>
          </div>

          <!-- Output Filename Preview -->
          <div class="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl bg-emerald-50/70 border border-emerald-200/80">
            <span class="text-xs font-medium text-emerald-900 shrink-0">Output filename</span>
            <span
              data-role="save-as-preview"
              class="font-mono-tabular text-xs font-semibold text-emerald-800 truncate min-w-0"
            ></span>
          </div>

          <!-- Cancellation notice (shown only if user cancels native picker) -->
          <div
            data-role="save-as-cancel-note"
            role="status"
            class="hidden items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-100 border border-slate-200 text-xs text-slate-700"
          >
            <span class="shrink-0 text-slate-500" aria-hidden="true">${svgIcon('info', 'w-3.5 h-3.5')}</span>
            <span>Export cancelled. You can edit the filename or format and try again.</span>
          </div>

          <!-- Footer -->
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2 border-t border-slate-200">
            <span data-role="save-as-destination-hint" class="text-[11px] text-slate-500"></span>
            <div class="flex items-center justify-end gap-2 shrink-0">
              <button
                type="button"
                data-action="save-as-cancel"
                class="px-3.5 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200/80 rounded-lg transition-colors cursor-pointer"
              >Cancel</button>
              <button
                type="submit"
                data-action="save-as-submit"
                class="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors cursor-pointer"
              >
                ${svgIcon('download', 'w-3.5 h-3.5')}
                <span>Save</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    `;

    this.host.appendChild(this.backdropEl);
    this.dialogEl = this.backdropEl.querySelector('[data-role="save-as-dialog"]')!;
    this.formEl = this.backdropEl.querySelector('[data-role="save-as-form"]')!;
    this.filenameInput = this.backdropEl.querySelector('[data-role="save-as-filename"]')!;
    this.formatSelect = this.backdropEl.querySelector('[data-role="save-as-format"]')!;
    this.sheetSuffixWrapEl = this.backdropEl.querySelector('[data-role="save-as-sheet-suffix-wrap"]')!;
    this.sheetSuffixCheckbox = this.backdropEl.querySelector('[data-role="save-as-sheet-suffix"]')!;
    this.sheetSuffixLabelEl = this.backdropEl.querySelector('[data-role="save-as-sheet-suffix-label"]')!;
    this.scopeTextEl = this.backdropEl.querySelector('[data-role="save-as-scope"]')!;
    this.destinationHintEl = this.backdropEl.querySelector('[data-role="save-as-destination-hint"]')!;
    this.previewEl = this.backdropEl.querySelector('[data-role="save-as-preview"]')!;
    this.errorBoxEl = this.backdropEl.querySelector('[data-role="save-as-error"]')!;
    this.errorTextEl = this.backdropEl.querySelector('[data-role="save-as-error-text"]')!;
    this.cancelNoticeEl = this.backdropEl.querySelector('[data-role="save-as-cancel-note"]')!;
    this.submitBtn = this.backdropEl.querySelector('[data-action="save-as-submit"]')!;
    this.cancelBtn = this.backdropEl.querySelector('[data-action="save-as-cancel"]')!;
    this.closeBtn = this.backdropEl.querySelector('[data-action="save-as-close"]')!;
  }

  private bindEvents(): void {
    const {signal} = this.abortController;

    this.backdropEl.addEventListener(
      'click',
      (e) => {
        if (e.target === this.backdropEl && !this.submitting) {
          this.close(true);
        }
      },
      {signal}
    );

    this.closeBtn.addEventListener(
      'click',
      () => {
        if (!this.submitting) this.close(true);
      },
      {signal}
    );

    this.cancelBtn.addEventListener(
      'click',
      () => {
        if (!this.submitting) this.close(true);
      },
      {signal}
    );

    this.filenameInput.addEventListener(
      'input',
      () => {
        this.hideCancelNotice();
        this.syncPreviewAndValidation(false);
      },
      {signal}
    );

    this.formatSelect.addEventListener(
      'change',
      () => {
        this.hideCancelNotice();
        this.syncScopeControls();
        this.syncPreviewAndValidation(false);
      },
      {signal}
    );

    this.sheetSuffixCheckbox.addEventListener(
      'change',
      () => {
        this.hideCancelNotice();
        this.syncPreviewAndValidation(false);
      },
      {signal}
    );

    this.formEl.addEventListener(
      'submit',
      (e) => {
        e.preventDefault();
        void this.handleSubmit();
      },
      {signal}
    );

    this.dialogEl.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          if (!this.submitting) this.close(true);
          return;
        }
        if (e.key === 'Tab') {
          this.trapTab(e);
        }
      },
      {signal}
    );
  }

  private trapTab(e: KeyboardEvent): void {
    const focusables = Array.from(
      this.dialogEl.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    ).filter((el) => el.offsetParent !== null);
    if (focusables.length === 0) return;

    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement as HTMLElement | null;

    if (e.shiftKey) {
      if (!active || active === first || !this.dialogEl.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (!active || active === last || !this.dialogEl.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  }

  public isOpen(): boolean {
    return this.openState;
  }

  public open(options?: {
    initialFormat?: ExportFormat;
    restoreFocusTo?: HTMLElement | null;
  }): void {
    if (this.disposed) return;
    if (!this.openState) {
      this.previousFocus =
        options?.restoreFocusTo !== undefined
          ? options.restoreFocusTo
          : (document.activeElement as HTMLElement | null);
    }

    const {workbook} = this.callbacks.getWorkbookState();
    const format = options?.initialFormat ?? getDefaultExportFormat(workbook);

    this.submitting = false;
    this.submitBtn.disabled = false;
    this.filenameInput.value = getWorkbookDisplayName(workbook);
    this.formatSelect.value = format;
    this.sheetSuffixCheckbox.checked = false;

    this.clearValidationError();
    this.hideCancelNotice();
    this.syncScopeControls();
    this.syncPreviewAndValidation(false);

    this.destinationHintEl.textContent = supportsNativeSaveFilePicker()
      ? 'Your browser will ask where to save this file.'
      : 'Your browser will start a local file download.';

    this.openState = true;
    this.backdropEl.classList.remove('hidden');
    this.backdropEl.classList.add('flex');

    this.filenameInput.focus();
    this.filenameInput.select();
  }

  public close(restoreFocus = true): void {
    if (!this.openState) return;
    this.openState = false;
    this.submitting = false;
    this.backdropEl.classList.add('hidden');
    this.backdropEl.classList.remove('flex');

    const target = this.previousFocus;
    this.previousFocus = null;
    if (restoreFocus && target && target.isConnected) {
      target.focus();
    }
  }

  private syncScopeControls(): void {
    const {workbook, activeSheet} = this.callbacks.getWorkbookState();
    const format = this.formatSelect.value as ExportFormat;

    if (format === 'xlsx') {
      const sheetCount = workbook.sheets.length;
      this.scopeTextEl.textContent = `Scope: Entire workbook (${sheetCount} sheet${sheetCount === 1 ? '' : 's'})`;
      this.sheetSuffixWrapEl.classList.add('hidden');
      this.sheetSuffixWrapEl.classList.remove('flex');
    } else {
      this.scopeTextEl.textContent = `Scope: Active sheet "${activeSheet.name}" only`;
      this.sheetSuffixLabelEl.textContent = `Append active sheet name (-${activeSheet.name})`;
      this.sheetSuffixWrapEl.classList.remove('hidden');
      this.sheetSuffixWrapEl.classList.add('flex');
    }
  }

  private syncPreviewAndValidation(forceShowError: boolean): boolean {
    const {activeSheet} = this.callbacks.getWorkbookState();
    const format = this.formatSelect.value as ExportFormat;
    const includeSheetSuffix =
      (format === 'csv' || format === 'tsv') && this.sheetSuffixCheckbox.checked;

    const validation = validateExportFilename(this.filenameInput.value, format, {
      includeSheetSuffix,
      sheetName: activeSheet.name,
    });

    if (validation.ok) {
      this.previewEl.textContent = validation.fileName;
      this.previewEl.classList.remove('text-rose-700');
      this.previewEl.classList.add('text-emerald-800');
      this.clearValidationError();
      return true;
    }

    this.previewEl.textContent = 'Enter a valid filename';
    this.previewEl.classList.remove('text-emerald-800');
    this.previewEl.classList.add('text-rose-700');

    const hasInput = this.filenameInput.value.trim().length > 0;
    const wasInvalid = this.filenameInput.getAttribute('aria-invalid') === 'true';
    if (forceShowError || hasInput || wasInvalid) {
      this.showValidationError(validation.error);
    } else {
      this.clearValidationError();
    }
    return false;
  }

  private showValidationError(message: string): void {
    this.filenameInput.setAttribute('aria-invalid', 'true');
    this.filenameInput.setAttribute('aria-describedby', 'save-as-error');
    this.filenameInput.classList.remove('border-slate-300', 'focus:border-emerald-600');
    this.filenameInput.classList.add('border-rose-500', 'focus:border-rose-600');
    this.errorTextEl.textContent = message;
    this.errorBoxEl.classList.remove('hidden');
    this.errorBoxEl.classList.add('flex');
  }

  private clearValidationError(): void {
    this.filenameInput.setAttribute('aria-invalid', 'false');
    this.filenameInput.removeAttribute('aria-describedby');
    this.filenameInput.classList.remove('border-rose-500', 'focus:border-rose-600');
    this.filenameInput.classList.add('border-slate-300', 'focus:border-emerald-600');
    this.errorTextEl.textContent = '';
    this.errorBoxEl.classList.add('hidden');
    this.errorBoxEl.classList.remove('flex');
  }

  private hideCancelNotice(): void {
    this.cancelNoticeEl.classList.add('hidden');
    this.cancelNoticeEl.classList.remove('flex');
  }

  private showCancelNotice(): void {
    this.cancelNoticeEl.classList.remove('hidden');
    this.cancelNoticeEl.classList.add('flex');
  }

  private async handleSubmit(): Promise<void> {
    if (this.submitting || !this.openState) return;

    const {workbook, activeSheet} = this.callbacks.getWorkbookState();
    const format = this.formatSelect.value as ExportFormat;
    const includeSheetSuffix =
      (format === 'csv' || format === 'tsv') && this.sheetSuffixCheckbox.checked;

    const validation = validateExportFilename(this.filenameInput.value, format, {
      includeSheetSuffix,
      sheetName: activeSheet.name,
    });

    if (!validation.ok) {
      this.syncPreviewAndValidation(true);
      this.filenameInput.focus();
      return;
    }

    this.submitting = true;
    this.submitBtn.disabled = true;
    this.hideCancelNotice();

    // Invoke saveExportFile immediately (without prior awaits) to preserve user activation for showSaveFilePicker.
    const outcome = await saveExportFile({
      workbook,
      activeSheet,
      fileName: validation.fileName,
      format,
      preferNativePicker: true,
    });

    if (this.disposed) return;

    this.submitting = false;
    this.submitBtn.disabled = false;

    if (outcome.status === 'cancelled') {
      this.showCancelNotice();
      this.filenameInput.focus();
      return;
    }

    const toast = getSaveExportOutcomeToast(outcome);
    if (toast) {
      this.callbacks.onNotify(toast);
    }

    if (outcome.status === 'saved' || outcome.status === 'download-started') {
      this.close(true);
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
