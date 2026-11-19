import test from 'node:test';
import assert from 'node:assert/strict';
import type {SheetData, WorkbookState} from '../types';
import {
  DEFAULT_COL_WIDTH,
  MAX_AUTO_FIT_SAMPLES,
  MAX_COL_WIDTH,
  MIN_COL_WIDTH,
  clampColumnWidth,
  computeAutoFitColumnWidth,
  createColumnViewState,
  getOrderedDisplayColumns,
  getVisibleColumnsPlan,
  moveColumnVisualInView,
  reconcileColumnViewOnAdd,
  reconcileColumnViewOnDelete,
  restoreAllColumnsInView,
  setColumnWidthInView,
  toggleColumnPinInView,
  toggleColumnVisibilityInView,
} from './columnView';
import {
  COLUMN_VIEW_STORAGE_KEY,
  MAX_PERSISTED_COLUMN_VIEWS,
  clearPersistedColumnView,
  computeSheetLayoutIdentity,
  loadPersistedColumnView,
  savePersistedColumnView,
} from './columnViewPersistence';
import {AppStore} from './store';
import {
  computeColumnVirtualWindow,
  computePinnedColumnVirtualWindow,
  computeScrollLeftForColumn,
} from './virtualWindow';
import {serializeCsv, updateSheetCell} from './tabular';
import {DataWorkerClient} from './workerClient';

function makeWideSheet(rowsCount: number, colsCount: number): SheetData {
  const columns = Array.from({length: colsCount}, (_, c) => `col_${c}`);
  const rows = Array.from({length: rowsCount}, (_, r) =>
    Array.from({length: colsCount}, (_, c) => `r${r}_c${c}`)
  );
  const types = Array.from({length: colsCount}, () => 'text' as const);
  return {
    id: 'wide-sheet',
    name: 'Wide',
    columns,
    rows,
    types,
  };
}

function makeMemoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(key: string) {
      return data.has(key) ? data.get(key)! : null;
    },
    key(index: number) {
      return Array.from(data.keys())[index] ?? null;
    },
    removeItem(key: string) {
      data.delete(key);
    },
    setItem(key: string, value: string) {
      data.set(key, String(value));
    },
  };
}

function makeSheet(
  id: string,
  name: string,
  columns: string[],
  rows: string[][]
): SheetData {
  return {
    id,
    name,
    columns,
    rows,
    types: columns.map(() => 'text' as const),
  };
}

function makeWorkbookForStore(
  sheets: SheetData[],
  fileFormat: WorkbookState['fileFormat'] = 'csv',
  fileName = 'dataset.csv'
): WorkbookState {
  return {
    fileName,
    fileFormat,
    activeSheetIndex: 0,
    sheets,
  };
}

test('column resize clamps within [MIN_COL_WIDTH, MAX_COL_WIDTH] and auto-fit uses bounded sampling on 100k rows', () => {
  assert.equal(clampColumnWidth(12), MIN_COL_WIDTH);
  assert.equal(clampColumnWidth(2000), MAX_COL_WIDTH);
  assert.equal(clampColumnWidth(Number.NaN), DEFAULT_COL_WIDTH);

  const hugeSheet = makeWideSheet(100_000, 12);
  const sampleIdx = Math.round(
    (100 * (hugeSheet.rows.length - 1)) / (MAX_AUTO_FIT_SAMPLES - 1)
  );
  hugeSheet.rows[sampleIdx][2] = 'X'.repeat(65);
  const autoW = computeAutoFitColumnWidth(hugeSheet, 2, MAX_AUTO_FIT_SAMPLES);

  assert.ok(autoW > 220 && autoW <= MAX_COL_WIDTH);
});

test('visual reorder, hide/show, and pin never mutate underlying SheetData or CSV export', () => {
  const sheet = makeWideSheet(3, 5);
  sheet.columns = ['ID', 'Prompt', 'ModelA', 'ModelB', 'Notes'];
  const originalCsv = serializeCsv(sheet);

  let view = createColumnViewState(sheet);
  view = toggleColumnPinInView(view, 1); // Pin 'Prompt'
  view = toggleColumnVisibilityInView(view, 3); // Hide 'ModelB'
  view = moveColumnVisualInView(view, 4, -1); // Move 'Notes' left past 'ModelA'

  const display = getOrderedDisplayColumns(view);
  assert.deepEqual(display.pinnedOrdered, [1]);
  assert.deepEqual(display.unpinnedOrdered, [0, 4, 2]);
  assert.deepEqual(display.allVisibleOrdered, [1, 0, 4, 2]);

  // Underlying sheet columns & rows remain completely untouched
  assert.deepEqual(sheet.columns, ['ID', 'Prompt', 'ModelA', 'ModelB', 'Notes']);
  assert.equal(serializeCsv(sheet), originalCsv);

  // Editing cell at sourceColIndex=4 writes exact source cell
  const updated = updateSheetCell(sheet, 1, 4, 'Edited Note');
  assert.equal(updated.rows[1][4], 'Edited Note');
  assert.equal(updated.rows[1][2], 'r1_c2');

  // Cannot hide the last remaining visible column
  let minimalView = view;
  minimalView = toggleColumnVisibilityInView(minimalView, 0);
  minimalView = toggleColumnVisibilityInView(minimalView, 1);
  minimalView = toggleColumnVisibilityInView(minimalView, 2);
  minimalView = toggleColumnVisibilityInView(minimalView, 4); // would be last visible
  assert.equal(getOrderedDisplayColumns(minimalView).allVisibleOrdered.length, 1);

  const restored = restoreAllColumnsInView(view);
  assert.equal(restored.hidden.length, 0);
});

test('narrow viewport downgrades excess pinned columns so scrollable area stays usable', () => {
  const sheet = makeWideSheet(2, 6);
  const widths = [180, 180, 180, 180, 180, 180];
  let view = createColumnViewState(sheet);
  view = toggleColumnPinInView(view, 0);
  view = toggleColumnPinInView(view, 1);
  view = toggleColumnPinInView(view, 2);

  // Wide desktop: all 3 pinned fit cleanly
  const widePlan = getVisibleColumnsPlan({
    view,
    colWidths: widths,
    viewportWidth: 1100,
    rowNumWidth: 76,
  });
  assert.deepEqual(widePlan.pinnedCols, [0, 1, 2]);
  assert.equal(widePlan.downgradedPinCount, 0);
  assert.equal(widePlan.pinnedLeftOffsets[0], 76);
  assert.equal(widePlan.pinnedLeftOffsets[1], 76 + 180);
  assert.equal(widePlan.pinnedLeftOffsets[2], 76 + 360);

  // Narrow mobile viewport (390px): downgrades excess sticky columns
  const narrowPlan = getVisibleColumnsPlan({
    view,
    colWidths: widths,
    viewportWidth: 390,
    rowNumWidth: 76,
  });
  assert.ok(narrowPlan.pinnedCols.length <= 1);
  assert.ok(narrowPlan.downgradedPinCount >= 2);
  assert.equal(narrowPlan.pinnedCols.length + narrowPlan.unpinnedCols.length, 6);
});

test('pinned + unpinned column virtualization slices 120 columns accurately and clamps overscrolled scrollLeft', () => {
  const sheet = makeWideSheet(5, 120);
  const widths = Array.from({length: 120}, () => 140);
  let view = createColumnViewState(sheet);
  view = toggleColumnPinInView(view, 5);
  view = toggleColumnPinInView(view, 2);
  view = toggleColumnVisibilityInView(view, 10);

  const plan = getVisibleColumnsPlan({
    view,
    colWidths: widths,
    viewportWidth: 1000,
    rowNumWidth: 76,
  });

  assert.deepEqual(plan.pinnedCols, [2, 5]);
  const virt = computePinnedColumnVirtualWindow({
    unpinnedCols: plan.unpinnedCols,
    scrollLeft: 2800,
    viewportWidth: 1000,
    colWidths: widths,
    fixedLeftWidth: 76 + plan.pinnedTotalWidth,
    overscan: 2,
    virtualizeThreshold: 14,
  });

  assert.equal(virt.virtualized, true);
  assert.ok(virt.visibleUnpinnedCols.length < 15);
  assert.ok(virt.leftWidth > 0);
  assert.ok(virt.rightWidth > 0);
  assert.ok(!virt.visibleUnpinnedCols.includes(2));
  assert.ok(!virt.visibleUnpinnedCols.includes(5));
  assert.ok(!virt.visibleUnpinnedCols.includes(10));

  // Overscrolled scrollLeft beyond total width must clamp cleanly to tail columns
  const overscrolledPinned = computePinnedColumnVirtualWindow({
    unpinnedCols: plan.unpinnedCols,
    scrollLeft: 999_999,
    viewportWidth: 1000,
    colWidths: widths,
    fixedLeftWidth: 76 + plan.pinnedTotalWidth,
    overscan: 2,
    virtualizeThreshold: 14,
  });
  assert.ok(overscrolledPinned.visibleUnpinnedCols.length > 0);
  assert.equal(overscrolledPinned.end, plan.unpinnedCols.length);
  assert.equal(overscrolledPinned.rightWidth, 0);

  const overscrolledBasic = computeColumnVirtualWindow({
    totalCols: 40,
    scrollLeft: 999_999,
    viewportWidth: 800,
    colWidths: Array.from({length: 40}, () => 150),
    fixedLeftWidth: 76,
    overscan: 2,
    virtualizeThreshold: 14,
  });
  assert.equal(overscrolledBasic.end, 40);
  assert.equal(overscrolledBasic.rightWidth, 0);
  assert.ok(overscrolledBasic.start < overscrolledBasic.end);

  const scrollTarget = computeScrollLeftForColumn({
    unpinnedColPos: 40,
    unpinnedCols: plan.unpinnedCols,
    colWidths: widths,
    currentScrollLeft: 0,
    viewportWidth: 1000,
    fixedLeftWidth: 76 + plan.pinnedTotalWidth,
  });
  assert.ok(scrollTarget !== null && scrollTarget > 0);
});

test('structural add/delete reconciles column order, hidden, pinned, and widths safely', () => {
  const sheet = makeWideSheet(2, 4);
  let view = createColumnViewState(sheet);
  view = setColumnWidthInView(view, 3, 240);
  view = toggleColumnPinInView(view, 2);
  view = toggleColumnVisibilityInView(view, 1);

  view = reconcileColumnViewOnAdd(view, 4);
  assert.deepEqual(view.order, [0, 1, 2, 3, 4]);

  // Delete source col 1 (which was hidden): indices 2->1, 3->2, 4->3
  view = reconcileColumnViewOnDelete(view, 1, 4);
  assert.deepEqual(view.order, [0, 1, 2, 3]);
  assert.deepEqual(view.hidden, []);
  assert.deepEqual(view.pinned, [1]);
  assert.equal(view.widths[2], 240);
});

test('Store Scenarios A-G: getter purity, add/delete/undo/redo column view & roleOverride reconciliation, row edits, multi-sheet isolation', () => {
  const s1 = makeSheet('s1', 'Sheet1', ['A', 'B', 'C', 'D'], [
    ['a1', 'b1', 'c1', 'd1'],
    ['a2', 'b2', 'c2', 'd2'],
  ]);
  const s2 = makeSheet('s2', 'Sheet2', ['X', 'Y', 'Z'], [['x1', 'y1', 'z1']]);
  const storage = makeMemoryStorage();
  const store = new AppStore(
    makeWorkbookForStore([s1, s2], 'csv', 'reconcile.csv'),
    new DataWorkerClient({createWorker: () => null}),
    storage
  );

  try {
    // Getter purity: repeated reads return equivalent immutable snapshot without side effects
    const initialA = store.activeColumnView;
    const initialB = store.activeColumnView;
    assert.deepEqual(initialA, initialB);

    // Customize [A, B, C, D]: pin C(2), hide B(1), move D(3) left before B(1), set width on D(3)=240
    store.toggleColumnPin(2);
    store.toggleColumnVisibility(1);
    store.moveColumnVisual(3, -1); // unpinned before: [0,1,3] -> visible unpinned: [0,3] -> move 3 left -> order swaps
    store.setColumnWidth(3, 240);
    store.overrideColumnRole(3, 'identifier');

    const beforeDeleteView = store.activeColumnView;
    const beforeDeleteCols = store.activeSheet.columns.slice();

    // Scenario A/B: Delete middle hidden column B (colIndex 1) -> remaining [A, C, D] at indices 0, 1, 2
    store.deleteColumn(1);
    assert.deepEqual(store.activeSheet.columns, ['A', 'C', 'D']);
    assert.deepEqual(store.activeColumnView.pinned, [1]); // C shifted 2->1
    assert.deepEqual(store.activeColumnView.hidden, [] as number[]);
    assert.equal(store.activeColumnView.widths[2], 240); // D shifted 3->2
    assert.equal(store.datasetProfile.columns[2].roleOverride, 'identifier');

    // Also modify width on surviving column C (now index 1) before undo to verify surviving customizations stick
    store.setColumnWidth(1, 310);

    // Undo delete -> restores [A, B, C, D] with B hidden, C pinned (width 310), D width 240 & roleOverride 'identifier'
    store.undo();
    assert.deepEqual(store.activeSheet.columns, beforeDeleteCols);
    assert.equal(store.activeColumnView.pinned.includes(2), true);
    assert.equal(store.activeColumnView.hidden.includes(1), true);
    assert.equal(store.activeColumnView.widths[3], 240);
    assert.equal(store.activeColumnView.widths[2], 310);
    assert.equal(store.datasetProfile.columns[3].roleOverride, 'identifier');
    assert.equal(store.activeColumnView.order.length, 4);

    // Redo delete & repeat undo/redo symmetry twice
    store.redo();
    assert.deepEqual(store.activeSheet.columns, ['A', 'C', 'D']);
    assert.deepEqual(store.activeColumnView.pinned, [1]);
    assert.equal(store.activeColumnView.widths[2], 240);
    assert.equal(store.activeColumnView.widths[1], 310);

    store.undo();
    assert.deepEqual(store.activeSheet.columns, ['A', 'B', 'C', 'D']);
    assert.equal(store.activeColumnView.widths[3], 240);
    assert.deepEqual(store.activeColumnView.order.length, 4);

    // Scenario C: Delete first column A (0) and verify pin/hide/widths shift cleanly + undo
    store.deleteColumn(0);
    assert.deepEqual(store.activeSheet.columns, ['B', 'C', 'D']);
    assert.deepEqual(store.activeColumnView.pinned, [1]); // C shifted 2->1
    assert.deepEqual(store.activeColumnView.hidden, [0]); // B shifted 1->0
    assert.equal(store.activeColumnView.widths[2], 240); // D shifted 3->2
    store.undo();
    assert.deepEqual(store.activeSheet.columns, beforeDeleteCols);
    assert.equal(store.activeColumnView.pinned.includes(2), true);
    assert.equal(store.activeColumnView.hidden.includes(1), true);

    // Scenario D: addColumn() + undo() + redo()
    store.addColumn();
    assert.equal(store.activeSheet.columns.length, 5);
    assert.equal(store.activeColumnView.order.length, 5);
    store.undo();
    assert.equal(store.activeSheet.columns.length, 4);
    assert.equal(store.activeColumnView.order.length, 4);
    store.redo();
    assert.equal(store.activeSheet.columns.length, 5);
    assert.equal(store.activeColumnView.order.length, 5);

    // Scenario E: Row add/delete preserves ColumnViewState intact
    const viewBeforeRows = store.activeColumnView;
    const newRowIdx = store.addRow();
    assert.deepEqual(store.activeColumnView, viewBeforeRows);
    store.deleteRow(newRowIdx);
    assert.deepEqual(store.activeColumnView, viewBeforeRows);

    // Scenario F: Multi-sheet isolation (Sheet2 independent from Sheet1)
    store.switchSheet(1);
    assert.deepEqual(store.activeSheet.columns, ['X', 'Y', 'Z']);
    assert.deepEqual(store.activeColumnView.pinned, []);
    store.toggleColumnPin(0);
    assert.deepEqual(store.activeColumnView.pinned, [0]);

    store.switchSheet(0);
    assert.deepEqual(store.activeColumnView.pinned, [2]);
    // Undo targets previous workbook-switch back to Sheet2 cleanly
    store.undo();
    assert.equal(store.activeSheet.name, 'Sheet2');
    assert.deepEqual(store.activeColumnView.pinned, [0]);

    // Scenario G: 1-column / invalid index deleteColumn() guard
    store.deleteColumn(0);
    store.deleteColumn(0); // now 1 column left: ['Z']
    assert.equal(store.activeSheet.columns.length, 1);
    store.deleteColumn(0); // must be no-op
    store.deleteColumn(-1);
    store.deleteColumn(99);
    assert.equal(store.activeSheet.columns.length, 1);

    // Silence unused variable lint
    void beforeDeleteView;
  } finally {
    store.dispose();
  }
});

test('columnViewPersistence skips blank templates, avoids cell data, handles corrupt/throwing storage, and enforces LRU cap', () => {
  const storage = makeMemoryStorage();
  const blankId = computeSheetLayoutIdentity({
    fileName: 'Blank.csv',
    fileFormat: 'blank',
    sheetName: 'Sheet1',
    columns: ['Col1', 'Col2'],
  });
  assert.equal(blankId, null);

  const idA = computeSheetLayoutIdentity({
    fileName: 'eval.csv',
    fileFormat: 'csv',
    sheetName: 'Results',
    columns: ['ID', 'Prompt', 'Score'],
  });
  const idB = computeSheetLayoutIdentity({
    fileName: 'eval.csv',
    fileFormat: 'csv',
    sheetName: 'Results',
    columns: ['ID', 'Prompt', 'Latency'],
  });
  assert.ok(idA && idB && idA !== idB);

  // Store with secret cell value ensures no cell contents touch storage
  const sheet = makeSheet(
    'sec',
    'Results',
    ['ID', 'Prompt', 'Score'],
    [['1', 'TOP_SECRET_CELL_PAYLOAD_XYZ', '99']]
  );
  const store = new AppStore(
    makeWorkbookForStore([sheet], 'csv', 'eval.csv'),
    new DataWorkerClient({createWorker: () => null}),
    storage
  );
  store.toggleColumnPin(0);
  store.setColumnWidth(1, 320);

  const rawPersisted = storage.getItem(COLUMN_VIEW_STORAGE_KEY) ?? '';
  assert.equal(rawPersisted.includes('TOP_SECRET_CELL_PAYLOAD_XYZ'), false);

  // Reopen new store with same schema -> layout restores
  const reopened = new AppStore(
    makeWorkbookForStore([sheet], 'csv', 'eval.csv'),
    new DataWorkerClient({createWorker: () => null}),
    storage
  );
  assert.deepEqual(reopened.activeColumnView.pinned, [0]);
  assert.equal(reopened.activeColumnView.widths[1], 320);

  // resetColumnView clears persisted entry
  reopened.resetColumnView();
  assert.equal(loadPersistedColumnView(idA, 3, storage), null);
  reopened.dispose();
  store.dispose();

  // Corrupt JSON does not throw
  storage.setItem(COLUMN_VIEW_STORAGE_KEY, '{corrupt json!!!');
  assert.equal(loadPersistedColumnView(idA, 3, storage), null);

  // LRU eviction caps at MAX_PERSISTED_COLUMN_VIEWS
  storage.clear();
  for (let i = 0; i < MAX_PERSISTED_COLUMN_VIEWS + 6; i++) {
    const key = computeSheetLayoutIdentity({
      fileName: `f_${i}.csv`,
      fileFormat: 'csv',
      sheetName: 'Sheet1',
      columns: ['A', `B_${i}`],
    });
    savePersistedColumnView(
      key,
      {order: [0, 1], hidden: [], pinned: [0], widths: {0: 200}},
      2,
      storage
    );
  }
  const parsed = JSON.parse(storage.getItem(COLUMN_VIEW_STORAGE_KEY) ?? '{}');
  assert.equal(Object.keys(parsed.entries ?? {}).length, MAX_PERSISTED_COLUMN_VIEWS);

  // Throwing SecurityError / QuotaExceededError Storage never throws
  const brokenStorage: Storage = {
    get length() {
      return 0;
    },
    clear() {},
    key() {
      return null;
    },
    removeItem() {
      throw new Error('SecurityError');
    },
    getItem() {
      throw new Error('SecurityError');
    },
    setItem() {
      throw new Error('QuotaExceededError');
    },
  };
  assert.equal(loadPersistedColumnView(idA, 3, brokenStorage), null);
  assert.equal(
    savePersistedColumnView(
      idA,
      {order: [0, 1, 2], hidden: [], pinned: [], widths: {}},
      3,
      brokenStorage
    ),
    false
  );
  assert.equal(clearPersistedColumnView(idA, brokenStorage), false);
});

