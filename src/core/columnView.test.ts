import test from 'node:test';
import assert from 'node:assert/strict';
import type {SheetData} from '../types';
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
  computePinnedColumnVirtualWindow,
  computeScrollLeftForColumn,
} from './virtualWindow';
import {serializeCsv, updateSheetCell} from './tabular';

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

test('column resize clamps within [MIN_COL_WIDTH, MAX_COL_WIDTH] and auto-fit uses bounded sampling on 100k rows', () => {
  assert.equal(clampColumnWidth(12), MIN_COL_WIDTH);
  assert.equal(clampColumnWidth(2000), MAX_COL_WIDTH);
  assert.equal(clampColumnWidth(Number.NaN), DEFAULT_COL_WIDTH);

  const hugeSheet = makeWideSheet(100_000, 12);
  const sampleIdx = Math.round((100 * (hugeSheet.rows.length - 1)) / (MAX_AUTO_FIT_SAMPLES - 1));
  hugeSheet.rows[sampleIdx][2] = 'X'.repeat(65);
  const t0 = performance.now();
  const autoW = computeAutoFitColumnWidth(hugeSheet, 2, MAX_AUTO_FIT_SAMPLES);
  const elapsedMs = performance.now() - t0;

  assert.ok(autoW > 220 && autoW <= MAX_COL_WIDTH);
  assert.ok(elapsedMs < 25, `Expected bounded auto-fit < 25ms, got ${elapsedMs}ms`);
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

test('pinned + unpinned column virtualization slices 120 columns accurately without duplicates', () => {
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
