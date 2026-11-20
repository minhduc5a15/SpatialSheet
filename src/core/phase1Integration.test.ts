import test from 'node:test';
import assert from 'node:assert/strict';
import type {SheetData, WorkbookState} from '../types';
import {
  applySeriesPreset,
  evaluateSeriesEligibility,
  filterSeriesEligibilities,
  getAllSeriesEligibilities,
  getSecondaryControlsForChartType,
  getSeriesColor,
  getSeriesMarker,
} from '../ui/ChartSeriesManager';
import {extractChart2DPoints} from '../ui/InteractiveChart2D';
import {profileDataset} from './dataProfiler';
import {AppStore} from './store';
import {inferColumnTypes, serializeCsv} from './tabular';
import {getVisibleColumnsPlan, moveColumnVisualInView} from './columnView';
import {computePinnedColumnVirtualWindow} from './virtualWindow';
import {DataWorkerClient} from './workerClient';

function buildBenchmarkSheet(rows: number, cols: number): SheetData {
  const columns: string[] = [];
  for (let c = 0; c < cols; c++) {
    if (c === 0) columns.push('sample_id');
    else if (c === 1) columns.push('eval_name');
    else if (c === 2) columns.push('prompt');
    else if (c === 3) columns.push('category');
    else if (c === 4) columns.push('eval_date');
    else columns.push(`model_${c - 4}`);
  }

  const categories = ['Reasoning', 'Coding', 'Math', 'Vision'];
  const matrix: string[][] = new Array(rows);
  for (let r = 0; r < rows; r++) {
    const row = new Array<string>(cols);
    row[0] = `ID-${String(r + 1).padStart(6, '0')}`;
    if (cols > 1) row[1] = `Task_${(r % 25) + 1}`;
    if (cols > 2) {
      row[2] =
        r % 5 === 0
          ? `Long prompt description for evaluation case #${r + 1}: verify multi-step reasoning, edge-case formatting, and deterministic output across wide spreadsheets.`
          : `Prompt ${r + 1}`;
    }
    if (cols > 3) row[3] = categories[r % categories.length];
    if (cols > 4) row[4] = `2026-01-${String((r % 28) + 1).padStart(2, '0')}`;
    for (let c = 5; c < cols; c++) {
      row[c] = String(Number((50 + ((r * 7 + c * 11) % 50) * 0.9).toFixed(2)));
    }
    matrix[r] = row;
  }

  return {
    id: `bench-${rows}x${cols}`,
    name: `Bench ${rows}x${cols}`,
    columns,
    rows: matrix,
    types: inferColumnTypes(columns, matrix),
  };
}

function makeWorkbook(sheet: SheetData): WorkbookState {
  return {
    fileName: `${sheet.id}.csv`,
    fileFormat: 'csv',
    activeSheetIndex: 0,
    sheets: [sheet],
  };
}

function createSyncStore(sheet: SheetData): AppStore {
  return new AppStore(makeWorkbook(sheet), new DataWorkerClient({createWorker: () => null}));
}

test('ChartSeriesManager semantic gating, presets, search, selected-only, and color stability', () => {
  const sheet = buildBenchmarkSheet(100, 37);
  const profile = profileDataset(sheet, 1);

  const eligibilities = getAllSeriesEligibilities(sheet, profile, 1);
  assert.equal(eligibilities[0].eligible, false);
  assert.match(eligibilities[0].reason ?? '', /Identifier/i);
  assert.equal(eligibilities[1].eligible, false); // eval_name text
  assert.equal(eligibilities[2].eligible, false); // prompt text
  assert.equal(eligibilities[3].eligible, false); // category categorical
  assert.equal(eligibilities[4].eligible, false); // eval_date temporal
  assert.match(eligibilities[4].reason ?? '', /Temporal/i);
  assert.equal(eligibilities[5].eligible, true); // model_1 quantitative

  // Presets
  const first5 = applySeriesPreset('first5', sheet, profile, 1);
  assert.equal(first5.length, 5);
  assert.deepEqual(first5, [5, 6, 7, 8, 9]);

  const first10 = applySeriesPreset('first10', sheet, profile, 1);
  assert.equal(first10.length, 10);

  const allNum = applySeriesPreset('allNumeric', sheet, profile, 1);
  assert.equal(allNum.length, 32); // cols 5..36

  const cleared = applySeriesPreset('clear', sheet, profile, 1);
  assert.deepEqual(cleared, []);

  const rec = applySeriesPreset('recommended', sheet, profile, 1);
  assert.equal(rec.length, 2);
  assert.deepEqual(rec, [5, 6]);

  // Search + Selected only filter
  const selectedSet = new Set(first5);
  const searchFiltered = filterSeriesEligibilities(
    eligibilities,
    selectedSet,
    'model_3',
    false
  );
  assert.ok(searchFiltered.some((e) => e.colIndex === 7)); // model_3
  const selectedOnlyFiltered = filterSeriesEligibilities(
    eligibilities,
    selectedSet,
    '',
    true
  );
  assert.deepEqual(
    selectedOnlyFiltered.map((e) => e.colIndex),
    [5, 6, 7, 8, 9]
  );

  // Stable colors & markers by sourceColIndex
  const col7Color = getSeriesColor(7);
  const col7Marker = getSeriesMarker(7);
  assert.equal(col7Color, getSeriesColor(7));
  assert.equal(col7Marker, getSeriesMarker(7));

  // Role override allows gating updates
  const overridden = {
    ...profile,
    columns: profile.columns.map((c) =>
      c.colIndex === 5 ? {...c, roleOverride: 'identifier' as const} : c
    ),
  };
  assert.equal(evaluateSeriesEligibility(sheet, overridden, 5, 1).eligible, false);
});

test('Secondary chart controls visibility & InteractiveChart2D aggregation/sorting', () => {
  assert.deepEqual(getSecondaryControlsForChartType('bar'), {
    showAggregation: true,
    showSort: true,
    showLimit: true,
  });
  assert.deepEqual(getSecondaryControlsForChartType('line'), {
    showAggregation: true,
    showSort: false,
    showLimit: true,
  });
  assert.deepEqual(getSecondaryControlsForChartType('pie'), {
    showAggregation: true,
    showSort: true,
    showLimit: false,
  });
  assert.deepEqual(getSecondaryControlsForChartType('scatter'), {
    showAggregation: false,
    showSort: false,
    showLimit: true,
  });

  const sheet = buildBenchmarkSheet(40, 8);
  const vis = Array.from({length: 40}, (_, i) => i);

  // Group by category (col 3) with avg of model_1 (col 5), sorted desc
  const grouped = extractChart2DPoints(sheet, vis, 3, [5, 6], {
    aggregation: 'avg',
    sortOrder: 'value-desc',
    maxPoints: 12,
  });
  assert.equal(grouped.hasAnyNumeric, true);
  assert.equal(grouped.points.length, 4); // Reasoning, Coding, Math, Vision
  assert.ok((grouped.points[0].values[0] ?? 0) >= (grouped.points[1].values[0] ?? 0));
  assert.equal(grouped.points[0].groupCount, 10);
});

test('AppStore end-to-end 100x37 workflow: pin, hide, reorder, edit, undo/redo, export invariance, chart sync', () => {
  const sheet = buildBenchmarkSheet(100, 37);
  const originalCsv = serializeCsv(sheet);
  const store = createSyncStore(sheet);

  try {
    // 1. Pin sample_id (0) & eval_name (1)
    store.toggleColumnPin(0);
    store.toggleColumnPin(1);
    assert.deepEqual(store.activeColumnView.pinned, [0, 1]);

    // 2. Reorder col 5 (model_1) left into position before col 4
    store.moveColumnVisual(5, -1);
    const viewOrderBeforeHide = store.activeColumnView.order;
    assert.equal(viewOrderBeforeHide.indexOf(5) < viewOrderBeforeHide.indexOf(4), true);

    // 3. Hide prompt (2) and verify at least 1 remains visible
    store.toggleColumnVisibility(2);
    assert.equal(store.activeColumnView.hidden.includes(2), true);

    // 4. Underlying SheetData order and CSV export remain untouched by visual column view
    assert.equal(store.activeSheet.columns[2], 'prompt');
    assert.equal(store.activeSheet.columns[5], 'model_1');
    assert.equal(serializeCsv(store.activeSheet), originalCsv);

    // 5. Commit cell edit on pinned col 1 and moved col 5, then undo/redo
    store.commitCellEdit(3, 5, '99.99');
    assert.equal(store.activeSheet.rows[3][5], '99.99');
    store.undo();
    assert.notEqual(store.activeSheet.rows[3][5], '99.99');
    store.redo();
    assert.equal(store.activeSheet.rows[3][5], '99.99');

    // 6. Chart empty selection & preset sync
    store.setChartConfig({...store.chartConfig, yColIndices: []});
    assert.deepEqual(store.chartConfig.yColIndices, []);
    store.setChartConfig({...store.chartConfig, yColIndices: [5, 6, 7, 8, 9]});
    assert.equal(store.chartConfig.yColIndices.length, 5);

    // 7. Split ratio clamping & persistence
    store.setSplitRatio(0.95, false);
    assert.equal(store.splitRatio, 0.75);
    store.setSplitRatio(0.1, false);
    assert.equal(store.splitRatio, 0.25);
  } finally {
    store.dispose();
  }
});

test('AppStore & virtualization handles 3,000x40 and 100,000x100 sheets deterministically', (t) => {
  // 3,000 x 40
  const medium = buildBenchmarkSheet(3000, 40);
  const medStore = createSyncStore(medium);
  t.after(() => medStore.dispose());
  medStore.toggleColumnPin(0);
  medStore.toggleColumnPin(1);
  medStore.toggleColumnVisibility(2);
  medStore.autoFitColumn(2);
  const medPlan = getVisibleColumnsPlan({
    view: medStore.activeColumnView,
    colWidths: medium.columns.map((_, i) => medStore.activeColumnView.widths[i] ?? 156),
    viewportWidth: 820,
    rowNumWidth: 76,
  });
  const medSlice = computePinnedColumnVirtualWindow({
    unpinnedCols: medPlan.unpinnedCols,
    scrollLeft: 1200,
    viewportWidth: 820,
    colWidths: medium.columns.map(() => 156),
    fixedLeftWidth: 76 + medPlan.pinnedTotalWidth,
    overscan: 2,
  });
  assert.ok(medSlice.visibleUnpinnedCols.length < 40);

  // 100,000 x 100
  const huge = buildBenchmarkSheet(100_000, 100);
  const hugeStore = createSyncStore(huge);
  t.after(() => hugeStore.dispose());

  hugeStore.toggleColumnPin(0);
  hugeStore.toggleColumnPin(1);
  hugeStore.toggleColumnVisibility(2);
  const reordered = moveColumnVisualInView(hugeStore.activeColumnView, 6, -1);
  assert.ok(reordered.order.indexOf(6) < reordered.order.indexOf(5));
  hugeStore.autoFitColumn(0);
  const plan = getVisibleColumnsPlan({
    view: hugeStore.activeColumnView,
    colWidths: huge.columns.map((_, idx) => hugeStore.activeColumnView.widths[idx] ?? 156),
    viewportWidth: 960,
    rowNumWidth: 76,
  });
  const colWin = computePinnedColumnVirtualWindow({
    unpinnedCols: plan.unpinnedCols,
    scrollLeft: 4500,
    viewportWidth: 960,
    colWidths: huge.columns.map(() => 156),
    fixedLeftWidth: 76 + plan.pinnedTotalWidth,
    overscan: 2,
  });

  assert.equal(plan.pinnedCols.length, 2);
  assert.ok(colWin.virtualized);
  assert.ok(colWin.visibleUnpinnedCols.length <= 14);
});
