import {
  DEFAULT_SPLIT_RATIO,
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  SPLIT_PRESETS,
  SPLITTER_WIDTH_PX,
  computeSplitRatioFromPointer,
} from '../core/workspaceLayout';

export interface WorkspaceSplitterCallbacks {
  onRatioPreview: (ratio: number) => void;
  onRatioCommit: (ratio: number) => void;
  getContainerRect: () => DOMRect | null;
  getRatio: () => number;
}

export class WorkspaceSplitter {
  private el: HTMLElement;
  private callbacks: WorkspaceSplitterCallbacks;
  private activePointerId: number | null = null;
  private pendingRatio: number | null = null;
  private rafId = 0;
  private dragMoved = false;
  private dragStartX = 0;
  private prevBodyUserSelect = '';
  private prevBodyCursor = '';
  private percentageBadgeEl: HTMLElement | null = null;
  private readonly abortController = new AbortController();
  private disposed = false;

  constructor(el: HTMLElement, callbacks: WorkspaceSplitterCallbacks) {
    this.el = el;
    this.callbacks = callbacks;
    this.render();
    this.bindEvents();
  }

  private render(): void {
    const pct = Math.round(this.callbacks.getRatio() * 100);
    this.el.setAttribute('role', 'separator');
    this.el.setAttribute('aria-orientation', 'vertical');
    this.el.setAttribute('aria-label', 'Resize spreadsheet and chart panes');
    this.el.setAttribute('aria-valuemin', String(Math.round(MIN_SPLIT_RATIO * 100)));
    this.el.setAttribute('aria-valuemax', String(Math.round(MAX_SPLIT_RATIO * 100)));
    this.el.setAttribute('aria-valuenow', String(pct));
    this.el.tabIndex = 0;
    this.el.classList.add('group');
    this.el.style.width = `${SPLITTER_WIDTH_PX}px`;
    this.el.style.touchAction = 'none';

    const presetsHtml = SPLIT_PRESETS.map((p) => {
      return `
        <button
          type="button"
          data-split-preset="${p.ratio}"
          title="Set workspace split to ${p.label}"
          aria-label="Set split ratio ${p.label}"
          class="px-1.5 py-0.5 text-[10px] font-mono-tabular rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 hover:text-slate-900 shadow-xs transition-colors cursor-pointer"
        >${p.label}</button>
      `;
    }).join('');

    this.el.innerHTML = `
      <div class="relative w-full h-full flex items-center justify-center select-none">
        <div
          aria-hidden="true"
          class="w-[3px] h-full rounded-full bg-slate-200 group-hover:bg-blue-400 group-focus-visible:bg-blue-500 transition-colors"
        ></div>
        <div
          aria-hidden="true"
          class="pointer-events-none absolute top-1/2 -translate-y-1/2 w-2.5 h-10 rounded-full bg-white border border-slate-300 shadow-xs flex flex-col items-center justify-center gap-0.5 group-hover:border-blue-400"
        >
          <span class="w-1 h-1 rounded-full bg-slate-400 group-hover:bg-blue-500"></span>
          <span class="w-1 h-1 rounded-full bg-slate-400 group-hover:bg-blue-500"></span>
          <span class="w-1 h-1 rounded-full bg-slate-400 group-hover:bg-blue-500"></span>
        </div>
        <div
          data-role="split-presets-popover"
          class="hidden group-hover:flex group-focus-within:flex absolute top-3 left-1/2 -translate-x-1/2 z-30 items-center gap-1 p-1 rounded-lg bg-white/95 border border-slate-200 shadow-md whitespace-nowrap"
        >
          ${presetsHtml}
        </div>
        <div
          data-role="split-badge"
          class="hidden pointer-events-none absolute top-14 left-1/2 -translate-x-1/2 z-30 px-2 py-0.5 rounded-md bg-slate-900 text-white text-[11px] font-mono-tabular shadow-md whitespace-nowrap"
        >${pct}% / ${100 - pct}%</div>
      </div>
    `;

    this.percentageBadgeEl = this.el.querySelector('[data-role="split-badge"]');
  }

  private bindEvents(): void {
    const {signal} = this.abortController;
    this.el.addEventListener(
      'pointerdown',
      (e) => this.handlePointerDown(e),
      {signal}
    );
    this.el.addEventListener(
      'pointermove',
      (e) => this.handlePointerMove(e),
      {signal}
    );
    this.el.addEventListener(
      'pointerup',
      (e) => this.handlePointerUp(e),
      {signal}
    );
    this.el.addEventListener(
      'pointercancel',
      (e) => this.handlePointerUp(e),
      {signal}
    );
    this.el.addEventListener('dblclick', (e) => this.handleDblClick(e), {signal});
    this.el.addEventListener('keydown', (e) => this.handleKeyDown(e), {signal});
    this.el.addEventListener('click', (e) => this.handlePresetClick(e), {signal});
    window.addEventListener('blur', () => this.cancelActiveDrag(), {signal});
  }

  public syncRatio(ratio: number): void {
    const pct = Math.round(ratio * 100);
    this.el.setAttribute('aria-valuenow', String(pct));
    if (this.percentageBadgeEl) {
      this.percentageBadgeEl.textContent = `${pct}% / ${100 - pct}%`;
    }
    this.el
      .querySelectorAll<HTMLButtonElement>('[data-split-preset]')
      .forEach((btn) => {
        const presetRatio = Number(btn.dataset.splitPreset);
        const active = Math.abs(presetRatio - ratio) < 0.025;
        btn.classList.toggle('bg-blue-50', active);
        btn.classList.toggle('text-blue-700', active);
        btn.classList.toggle('border-blue-300', active);
        btn.classList.toggle('font-semibold', active);
      });
  }

  private handlePresetClick(e: MouseEvent): void {
    const target = e.target as HTMLElement | null;
    const btn = target?.closest<HTMLButtonElement>('[data-split-preset]');
    if (!btn) return;
    e.stopPropagation();
    const ratio = Number(btn.dataset.splitPreset);
    if (Number.isFinite(ratio)) {
      this.callbacks.onRatioCommit(ratio);
      this.syncRatio(ratio);
    }
  }

  private handleDblClick(e: MouseEvent): void {
    const target = e.target as HTMLElement | null;
    if (target?.closest('[data-split-preset]')) return;
    e.preventDefault();
    this.callbacks.onRatioCommit(DEFAULT_SPLIT_RATIO);
    this.syncRatio(DEFAULT_SPLIT_RATIO);
  }

  private handleKeyDown(e: KeyboardEvent): void {
    const cur = this.callbacks.getRatio();
    const step = e.shiftKey ? 0.05 : 0.02;
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = cur - step;
    else if (e.key === 'ArrowRight') next = cur + step;
    else if (e.key === 'Home') next = MIN_SPLIT_RATIO;
    else if (e.key === 'End') next = MAX_SPLIT_RATIO;
    else if (e.key === 'Enter' || e.key === ' ') next = DEFAULT_SPLIT_RATIO;

    if (next !== null) {
      e.preventDefault();
      this.callbacks.onRatioCommit(next);
      this.syncRatio(this.callbacks.getRatio());
    }
  }

  private handlePointerDown(e: PointerEvent): void {
    if (this.disposed || this.activePointerId !== null) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('[data-split-preset]')) return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;

    e.preventDefault();
    this.activePointerId = e.pointerId;
    this.dragMoved = false;
    this.dragStartX = e.clientX;
    this.pendingRatio = null;
    this.el.setPointerCapture?.(e.pointerId);

    this.prevBodyUserSelect = document.body.style.userSelect;
    this.prevBodyCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    this.percentageBadgeEl?.classList.remove('hidden');
  }

  private handlePointerMove(e: PointerEvent): void {
    if (this.disposed || this.activePointerId !== e.pointerId) return;
    if (Math.abs(e.clientX - this.dragStartX) >= 2) {
      this.dragMoved = true;
    }
    const rect = this.callbacks.getContainerRect();
    if (!rect || rect.width <= 0) return;

    const ratio = computeSplitRatioFromPointer({
      clientX: e.clientX,
      containerLeft: rect.left,
      containerWidth: rect.width,
    });
    this.pendingRatio = ratio;
    if (!this.rafId) {
      this.rafId = requestAnimationFrame(() => {
        this.rafId = 0;
        if (!this.disposed && this.pendingRatio !== null) {
          this.syncRatio(this.pendingRatio);
          this.callbacks.onRatioPreview(this.pendingRatio);
        }
      });
    }
  }

  private cancelActiveDrag(): void {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    if (this.activePointerId !== null) {
      const pid = this.activePointerId;
      this.activePointerId = null;
      try {
        this.el.releasePointerCapture?.(pid);
      } catch {
        // Ignore if pointer capture is already released
      }
      document.body.style.userSelect = this.prevBodyUserSelect;
      document.body.style.cursor = this.prevBodyCursor;
    }
    this.percentageBadgeEl?.classList.add('hidden');
    this.pendingRatio = null;
  }

  private handlePointerUp(e: PointerEvent): void {
    if (this.activePointerId !== e.pointerId) return;
    const commitRatio =
      this.dragMoved && this.pendingRatio !== null ? this.pendingRatio : null;
    this.cancelActiveDrag();

    if (commitRatio !== null && !this.disposed) {
      this.callbacks.onRatioCommit(commitRatio);
      this.syncRatio(this.callbacks.getRatio());
    }
  }

  public dispose(): void {
    this.disposed = true;
    this.cancelActiveDrag();
    this.abortController.abort();
  }
}
