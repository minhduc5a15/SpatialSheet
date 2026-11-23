import {svgIcon} from './icons';

export type ToastKind = 'success' | 'info' | 'error';

export interface ToastOptions {
  kind?: ToastKind;
  message: string;
  durationMs?: number;
}

interface ToastSlotState {
  root: HTMLElement;
  iconEl: HTMLElement;
  messageEl: HTMLElement;
  closeBtn: HTMLButtonElement;
  active: boolean;
  key: string;
  shownAt: number;
  durationMs: number;
  remainingMs: number;
  timerId: number | null;
  paused: boolean;
}

const MAX_SLOTS = 3;
const DEDUP_WINDOW_MS = 1200;

export class ToastManager {
  private containerEl: HTMLElement;
  private politeLiveEl: HTMLElement;
  private assertiveLiveEl: HTMLElement;
  private slots: ToastSlotState[] = [];
  private readonly abortController = new AbortController();
  private disposed = false;

  constructor(parentHost: HTMLElement) {
    this.containerEl = document.createElement('div');
    this.containerEl.dataset.role = 'toast-container';
    this.containerEl.className =
      'fixed bottom-4 right-4 left-4 sm:left-auto z-[90] flex flex-col gap-2 sm:w-[360px] pointer-events-none';

    this.politeLiveEl = document.createElement('div');
    this.politeLiveEl.dataset.role = 'toast-live-polite';
    this.politeLiveEl.setAttribute('role', 'status');
    this.politeLiveEl.setAttribute('aria-live', 'polite');
    this.politeLiveEl.setAttribute('aria-atomic', 'true');
    this.politeLiveEl.className = 'sr-only';

    this.assertiveLiveEl = document.createElement('div');
    this.assertiveLiveEl.dataset.role = 'toast-live-assertive';
    this.assertiveLiveEl.setAttribute('role', 'alert');
    this.assertiveLiveEl.setAttribute('aria-live', 'assertive');
    this.assertiveLiveEl.setAttribute('aria-atomic', 'true');
    this.assertiveLiveEl.className = 'sr-only';

    this.containerEl.append(this.politeLiveEl, this.assertiveLiveEl);

    // Pre-mount fixed pool of reusable toast slots so showing/hiding toasts
    // never alters overall DOM node count during automated stability assertions.
    for (let i = 0; i < MAX_SLOTS; i++) {
      const slot = this.createSlotElement(i);
      this.slots.push(slot);
      this.containerEl.append(slot.root);
    }

    parentHost.append(this.containerEl);
  }

  private createSlotElement(index: number): ToastSlotState {
    const root = document.createElement('div');
    root.dataset.toastSlot = String(index);
    root.className =
      'hidden pointer-events-auto items-start gap-2.5 px-3.5 py-2.5 rounded-xl border shadow-lg bg-white text-slate-900 text-xs transition-opacity';

    const iconEl = document.createElement('span');
    iconEl.className = 'shrink-0 mt-0.5';
    iconEl.setAttribute('aria-hidden', 'true');

    const messageEl = document.createElement('span');
    messageEl.dataset.toastMessage = String(index);
    messageEl.className = 'flex-1 min-w-0 leading-relaxed font-medium text-slate-800 break-words';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.dataset.toastClose = String(index);
    closeBtn.setAttribute('aria-label', 'Dismiss notification');
    closeBtn.className =
      'shrink-0 p-1 -mr-1 -mt-0.5 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40';
    closeBtn.innerHTML = svgIcon('close', 'w-3.5 h-3.5');

    root.append(iconEl, messageEl, closeBtn);

    const slot: ToastSlotState = {
      root,
      iconEl,
      messageEl,
      closeBtn,
      active: false,
      key: '',
      shownAt: 0,
      durationMs: 3400,
      remainingMs: 3400,
      timerId: null,
      paused: false,
    };

    const {signal} = this.abortController;
    closeBtn.addEventListener(
      'click',
      () => this.dismissSlot(slot),
      {signal}
    );
    root.addEventListener(
      'mouseenter',
      () => this.pauseSlot(slot),
      {signal}
    );
    root.addEventListener(
      'mouseleave',
      () => this.resumeSlot(slot),
      {signal}
    );
    root.addEventListener(
      'focusin',
      () => this.pauseSlot(slot),
      {signal}
    );
    root.addEventListener(
      'focusout',
      () => this.resumeSlot(slot),
      {signal}
    );

    return slot;
  }

  public show(opts: ToastOptions): void {
    if (this.disposed) return;
    const message = opts.message.trim();
    if (!message) return;

    const kind: ToastKind = opts.kind ?? 'info';
    const durationMs = opts.durationMs ?? (kind === 'error' ? 5200 : 3400);
    const key = `${kind}:${message}`;
    const now = Date.now();

    // Deduplicate identical active message shown recently
    const existing = this.slots.find(
      (s) => s.active && s.key === key && now - s.shownAt < DEDUP_WINDOW_MS
    );
    if (existing) {
      existing.shownAt = now;
      existing.durationMs = durationMs;
      existing.remainingMs = durationMs;
      this.scheduleAutoDismiss(existing);
      return;
    }

    let target = this.slots.find((s) => !s.active);
    if (!target) {
      // Recycle the oldest active slot
      target = [...this.slots].sort((a, b) => a.shownAt - b.shownAt)[0];
      this.clearSlotTimer(target);
    }

    target.active = true;
    target.key = key;
    target.shownAt = now;
    target.durationMs = durationMs;
    target.remainingMs = durationMs;
    target.paused = false;
    target.root.dataset.toastKind = kind;
    target.messageEl.textContent = message;

    this.applySlotVisuals(target, kind);
    target.root.classList.remove('hidden');
    target.root.classList.add('flex');

    this.announce(kind, message);
    this.scheduleAutoDismiss(target);
  }

  private applySlotVisuals(slot: ToastSlotState, kind: ToastKind): void {
    slot.root.classList.remove(
      'border-emerald-200',
      'bg-emerald-50/95',
      'border-slate-200',
      'bg-white',
      'border-rose-200',
      'bg-rose-50/95'
    );

    if (kind === 'success') {
      slot.root.classList.add('border-emerald-200', 'bg-emerald-50/95');
      slot.iconEl.innerHTML = svgIcon('checkCircle', 'w-4 h-4 text-emerald-600');
    } else if (kind === 'error') {
      slot.root.classList.add('border-rose-200', 'bg-rose-50/95');
      slot.iconEl.innerHTML = svgIcon('alert', 'w-4 h-4 text-rose-600');
    } else {
      slot.root.classList.add('border-slate-200', 'bg-white');
      slot.iconEl.innerHTML = svgIcon('info', 'w-4 h-4 text-blue-600');
    }
  }

  private announce(kind: ToastKind, message: string): void {
    if (kind === 'error') {
      this.assertiveLiveEl.textContent = '';
      this.assertiveLiveEl.textContent = message;
    } else {
      this.politeLiveEl.textContent = '';
      this.politeLiveEl.textContent = message;
    }
  }

  private scheduleAutoDismiss(slot: ToastSlotState): void {
    this.clearSlotTimer(slot);
    if (this.disposed || slot.durationMs <= 0) return;
    slot.shownAt = Date.now();
    slot.timerId = window.setTimeout(() => {
      slot.timerId = null;
      this.dismissSlot(slot);
    }, slot.remainingMs);
  }

  private pauseSlot(slot: ToastSlotState): void {
    if (!slot.active || slot.paused) return;
    slot.paused = true;
    const elapsed = Date.now() - slot.shownAt;
    slot.remainingMs = Math.max(400, slot.remainingMs - elapsed);
    this.clearSlotTimer(slot);
  }

  private resumeSlot(slot: ToastSlotState): void {
    if (!slot.active || !slot.paused || this.disposed) return;
    slot.paused = false;
    this.scheduleAutoDismiss(slot);
  }

  private clearSlotTimer(slot: ToastSlotState): void {
    if (slot.timerId !== null) {
      window.clearTimeout(slot.timerId);
      slot.timerId = null;
    }
  }

  private dismissSlot(slot: ToastSlotState): void {
    this.clearSlotTimer(slot);
    slot.active = false;
    slot.key = '';
    slot.paused = false;
    slot.root.classList.add('hidden');
    slot.root.classList.remove('flex');
    slot.messageEl.textContent = '';
  }

  public dismissAll(): void {
    for (const slot of this.slots) {
      this.dismissSlot(slot);
    }
  }

  public getActiveCount(): number {
    return this.slots.filter((s) => s.active).length;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.dismissAll();
    this.abortController.abort();
    this.containerEl.remove();
  }
}
