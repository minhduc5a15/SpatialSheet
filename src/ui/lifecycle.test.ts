import test from 'node:test';
import assert from 'node:assert/strict';

interface ListenerRecord {
  type: string;
  fn: (ev: unknown) => void;
}

class MockClassList {
  private set = new Set<string>();
  add(...tokens: string[]): void {
    for (const t of tokens) if (t) this.set.add(t);
  }
  remove(...tokens: string[]): void {
    for (const t of tokens) this.set.delete(t);
  }
  toggle(token: string, force?: boolean): boolean {
    if (force === undefined) {
      if (this.set.has(token)) {
        this.set.delete(token);
        return false;
      }
      this.set.add(token);
      return true;
    }
    if (force) {
      this.set.add(token);
      return true;
    }
    this.set.delete(token);
    return false;
  }
  contains(token: string): boolean {
    return this.set.has(token);
  }
}

class MockElement {
  public tagName: string;
  public classList = new MockClassList();
  public style: Record<string, string> = {};
  public dataset: Record<string, string> = {};
  public attributes = new Map<string, string>();
  public children: MockElement[] = [];
  public parentNode: MockElement | null = null;
  public tabIndex = -1;
  public value = '';
  public disabled = false;
  public scrollTop = 0;
  public scrollLeft = 0;
  public clientWidth = 800;
  public clientHeight = 500;
  public pointerCapturedIds = new Set<number>();
  public listeners: ListenerRecord[] = [];
  private _innerHTML = '';
  private _textContent = '';

  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
  }

  get innerHTML(): string {
    return this._innerHTML;
  }

  set innerHTML(val: string) {
    this._innerHTML = val;
    this.children = [];
  }

  get textContent(): string {
    return this._textContent;
  }

  set textContent(val: string) {
    this._textContent = val;
  }

  setAttribute(name: string, val: string): void {
    this.attributes.set(name, String(val));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  appendChild(child: MockElement): MockElement {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  contains(target: unknown): boolean {
    if (target === this) return true;
    for (const c of this.children) {
      if (c.contains(target)) return true;
    }
    return false;
  }

  setPointerCapture(pointerId: number): void {
    this.pointerCapturedIds.add(pointerId);
  }

  releasePointerCapture(pointerId: number): void {
    this.pointerCapturedIds.delete(pointerId);
  }

  focus(): void {}
  closest(): MockElement | null {
    return null;
  }

  addEventListener(
    type: string,
    fn: (ev: unknown) => void,
    options?: {signal?: AbortSignal}
  ): void {
    if (options?.signal?.aborted) return;
    const rec: ListenerRecord = {type, fn};
    this.listeners.push(rec);
    options?.signal?.addEventListener(
      'abort',
      () => {
        const idx = this.listeners.indexOf(rec);
        if (idx >= 0) this.listeners.splice(idx, 1);
      },
      {once: true}
    );
  }

  dispatchEvent(ev: {type: string; [k: string]: unknown}): void {
    const copy = this.listeners.filter((l) => l.type === ev.type);
    for (const l of copy) l.fn(ev);
  }

  querySelector(selector: string): MockElement | null {
    // Minimal role/attribute lookup for UI shell selectors
    const existing = this.children.find(
      (c) => c.getAttribute('data-role') === selector || c.tagName === selector.toUpperCase()
    );
    if (existing) return existing;
    const match = selector.match(/data-role="([^"]+)"|data-action="([^"]+)"/);
    const roleName = match?.[1] ?? match?.[2] ?? selector;
    let found = this.children.find((c) => c.dataset.lookup === roleName);
    if (!found) {
      const isInput =
        roleName.includes('input') ||
        roleName.includes('search') ||
        roleName.includes('formula');
      const isBtn =
        roleName.includes('trigger') ||
        roleName.includes('long-text') ||
        roleName.includes('add-');
      found = new MockElement(isInput ? 'input' : isBtn ? 'button' : 'div');
      found.dataset.lookup = roleName;
      this.appendChild(found);
    }
    return found;
  }

  querySelectorAll(): MockElement[] {
    return [];
  }
}

function setupMockDom(): {
  documentEl: MockElement & {body: MockElement};
  windowTarget: MockElement & {
    requestAnimationFrame: (cb: () => void) => number;
    cancelAnimationFrame: (id: number) => void;
    activeRafs: Set<number>;
    ResizeObserver: new () => {observe(): void; disconnect(): void; disconnected: boolean};
  };
  teardown: () => void;
} {
  const prevDoc = (globalThis as Record<string, unknown>).document;
  const prevWin = (globalThis as Record<string, unknown>).window;
  const prevRO = (globalThis as Record<string, unknown>).ResizeObserver;
  const prevRaf = (globalThis as Record<string, unknown>).requestAnimationFrame;
  const prevCancelRaf = (globalThis as Record<string, unknown>).cancelAnimationFrame;

  const body = new MockElement('body');
  body.style.cursor = '';
  body.style.userSelect = '';
  const documentEl = new MockElement('document') as MockElement & {body: MockElement};
  documentEl.body = body;

  let rafSeq = 1;
  const activeRafs = new Set<number>();
  const rafFn = (_cb: () => void) => {
    const id = rafSeq++;
    activeRafs.add(id);
    return id;
  };
  const cancelRafFn = (id: number) => {
    activeRafs.delete(id);
  };

  class MockResizeObserver {
    public disconnected = false;
    observe(): void {}
    disconnect(): void {
      this.disconnected = true;
    }
  }

  const windowTarget = new MockElement('window') as MockElement & {
    requestAnimationFrame: (cb: () => void) => number;
    cancelAnimationFrame: (id: number) => void;
    activeRafs: Set<number>;
    ResizeObserver: new () => {observe(): void; disconnect(): void; disconnected: boolean};
  };
  windowTarget.requestAnimationFrame = rafFn;
  windowTarget.cancelAnimationFrame = cancelRafFn;
  windowTarget.activeRafs = activeRafs;
  windowTarget.ResizeObserver = MockResizeObserver;

  (globalThis as Record<string, unknown>).document = documentEl;
  (globalThis as Record<string, unknown>).window = windowTarget;
  (globalThis as Record<string, unknown>).ResizeObserver = MockResizeObserver;
  (globalThis as Record<string, unknown>).requestAnimationFrame = rafFn;
  (globalThis as Record<string, unknown>).cancelAnimationFrame = cancelRafFn;

  return {
    documentEl,
    windowTarget,
    teardown: () => {
      (globalThis as Record<string, unknown>).document = prevDoc;
      (globalThis as Record<string, unknown>).window = prevWin;
      (globalThis as Record<string, unknown>).ResizeObserver = prevRO;
      (globalThis as Record<string, unknown>).requestAnimationFrame = prevRaf;
      (globalThis as Record<string, unknown>).cancelAnimationFrame = prevCancelRaf;
    },
  };
}

test('WorkspaceSplitter dispose() restores body styles, releases pointer capture, cancels RAF, and detaches listeners', async () => {
  const dom = setupMockDom();
  try {
    const {WorkspaceSplitter} = await import('./WorkspaceSplitter');
    const host = new MockElement('div');
    let ratio = 0.52;
    let commits = 0;

    const splitter = new WorkspaceSplitter(host as unknown as HTMLElement, {
      getRatio: () => ratio,
      getContainerRect: () => ({left: 0, width: 1000} as DOMRect),
      onRatioPreview: () => {},
      onRatioCommit: (r) => {
        ratio = r;
        commits += 1;
      },
    });

    // Simulate active pointer drag
    host.dispatchEvent({
      type: 'pointerdown',
      pointerId: 7,
      button: 0,
      pointerType: 'mouse',
      clientX: 520,
      target: host,
      preventDefault: () => {},
    });
    assert.equal(dom.documentEl.body.style.cursor, 'col-resize');
    assert.equal(dom.documentEl.body.style.userSelect, 'none');
    assert.equal(host.pointerCapturedIds.has(7), true);

    host.dispatchEvent({
      type: 'pointermove',
      pointerId: 7,
      clientX: 600,
    });
    assert.ok(dom.windowTarget.activeRafs.size > 0);

    // Dispose mid-drag
    splitter.dispose();

    assert.equal(dom.documentEl.body.style.cursor, '');
    assert.equal(dom.documentEl.body.style.userSelect, '');
    assert.equal(host.pointerCapturedIds.has(7), false);
    assert.equal(dom.windowTarget.activeRafs.size, 0);
    assert.equal(host.listeners.length, 0);
    assert.equal(dom.windowTarget.listeners.length, 0);

    // Post-dispose keyboard event does not trigger commit
    host.dispatchEvent({type: 'keydown', key: 'ArrowLeft', preventDefault: () => {}});
    assert.equal(commits, 0);
  } finally {
    dom.teardown();
  }
});

test('ColumnManager and ChartSeriesManager dispose() close open popovers and detach document listeners', async () => {
  const dom = setupMockDom();
  try {
    const {ColumnManager} = await import('./ColumnManager');
    const {ChartSeriesManager} = await import('./ChartSeriesManager');

    const cmHost = new MockElement('div');
    const cm = new ColumnManager(cmHost as unknown as HTMLElement, {
      onToggleVisibility: () => {},
      onTogglePin: () => {},
      onMoveVisual: () => {},
      onAutoFit: () => {},
      onDeleteColumn: () => {},
      onShowAll: () => {},
      onResetLayout: () => {},
    });
    cm.update({
      sheet: {id: 's', name: 'S', columns: ['A', 'B'], rows: [['1', '2']], types: ['number', 'number']},
      view: {order: [0, 1], hidden: [], pinned: [], widths: {}},
    });
    cm.toggle(true);
    assert.ok(dom.documentEl.listeners.length >= 2);
    cm.dispose();
    assert.equal(dom.documentEl.listeners.length, 0);

    const smHost = new MockElement('div');
    const sm = new ChartSeriesManager(smHost as unknown as HTMLElement, {
      onChangeSeries: () => {},
    });
    sm.update({
      sheet: {id: 's', name: 'S', columns: ['A', 'B'], rows: [['x', '2']], types: ['text', 'number']},
      profile: null,
      xColIndex: 0,
      yColIndices: [1],
      chartType: 'bar',
    });
    sm.toggle(true);
    assert.ok(dom.documentEl.listeners.length >= 2);
    sm.dispose();
    assert.equal(dom.documentEl.listeners.length, 0);
  } finally {
    dom.teardown();
  }
});

test('SpreadsheetGrid dispose() detaches all shell/window listeners and cancels pending RAFs', async () => {
  const dom = setupMockDom();
  try {
    const {SpreadsheetGrid} = await import('./SpreadsheetGrid');
    const host = new MockElement('div');
    const grid = new SpreadsheetGrid(host as unknown as HTMLElement, {
      onCellCommit: () => {},
      onSelectCell: () => {},
      onSortColumn: () => {},
      onRenameColumn: () => {},
      onDeleteColumn: () => {},
      onDeleteRow: () => {},
      onAddRow: () => {},
      onAddColumn: () => {},
      onClearSearch: () => {},
    });

    grid.setData({
      sheet: {id: 's', name: 'S', columns: ['A', 'B'], rows: [['1', '2']], types: ['number', 'number']},
      visibleRowIndices: [0],
      sort: {colIndex: null, direction: null},
      selectedCell: {rowIndex: 0, colIndex: 0},
      highlightedRowIndex: 0,
    });
    grid.dispose();

    assert.equal(dom.windowTarget.activeRafs.size, 0);
    assert.equal(dom.documentEl.listeners.length, 0);
    assert.equal(dom.windowTarget.listeners.length, 0);
  } finally {
    dom.teardown();
  }
});
