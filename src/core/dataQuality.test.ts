import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeDatasetOverview,
  filterAndSortColumnCatalog,
  getValidatedSuggestedAnalyses,
} from './dataQuality';
import {inferColumnTypes} from './tabular';
import {AppStore} from './store';
import {DataWorkerClient} from './workerClient';
import type {SheetData, WorkbookState} from '../types';

function makeStoreForDataQuality(): AppStore {
  const columns = [
    'record_id',
    'category',
    'revenue',
    'is_active',
    'created_at',
    'constant_col',
    'notes',
  ];
  const rows = [
    ['ID-1', 'Alpha', '10', 'true', '2024-01-05', 'SAME', 'First record note'],
    ['ID-2', 'Alpha', '20', 'yes', '2024-02-10', 'SAME', 'Second record note'],
    ['ID-2', 'Beta', '30', 'false', '2024-03-15', 'SAME', ''],
    ['', 'Gamma', 'bad_num', 'maybe', 'not_a_date', 'SAME', 'Fourth record with longer text'],
    ['ID-5', '', '50', '0', '2024-05-01', 'SAME', 'Fifth'],
  ];
  const sheetA: SheetData = {
    id: 'sheet-a',
    name: 'Orders',
    columns,
    rows,
    types: inferColumnTypes(columns, rows),
  };
  const sheetB: SheetData = {
    id: 'sheet-b',
    name: 'Customers',
    columns: ['id', 'label'],
    rows: [
      ['1', 'X'],
      ['1', 'Y'],
    ],
    types: inferColumnTypes(['id', 'label'], [
      ['1', 'X'],
      ['1', 'Y'],
    ]),
  };
  const workbook: WorkbookState = {
    fileName: 'orders.csv',
    fileFormat: 'csv',
    activeSheetIndex: 0,
    sheets: [sheetA, sheetB],
  };
  return new AppStore(workbook, new DataWorkerClient({createWorker: () => null}));
}

test('analyzeDatasetOverview computes exact summary, quartiles, and role-specific distributions', (t) => {
  const store = makeStoreForDataQuality();
  t.after(() => store.dispose());

  // Apply search filter to verify visible vs total row distinction
  store.setSearchQueryDebounced('Alpha', 0);
  return new Promise<void>((resolve) => setTimeout(resolve, 10)).then(() => {
    const analysis = analyzeDatasetOverview(
      store.workbook,
      store.activeSheet,
      store.visibleRowIndices,
      store.datasetProfile,
      store.activeColumnView,
      store.getDismissedQualityIds()
    );

    // Total missing: row 3 col 0 (''), row 4 col 1 (''), row 2 col 6 ('') => 3 missing of 35 cells
    assert.equal(analysis.summary.fileName, 'orders.csv');
    assert.equal(analysis.summary.fileFormat, 'csv');
    assert.equal(analysis.summary.sheetName, 'Orders');
    assert.equal(analysis.summary.totalRows, 5);
    assert.equal(analysis.summary.visibleRows, 2);
    assert.equal(analysis.summary.isFiltered, true);
    assert.equal(analysis.summary.totalCols, 7);
    assert.equal(analysis.summary.missingCells, 3);
    assert.ok(Math.abs(analysis.summary.missingRate - 3 / 35) < 1e-9);

    // Override roles explicitly so tests are deterministic regardless of threshold edge cases
    store.overrideColumnRole(0, 'identifier');
    store.overrideColumnRole(1, 'categorical');
    store.overrideColumnRole(2, 'quantitative');
    store.overrideColumnRole(3, 'boolean');
    store.overrideColumnRole(4, 'temporal');
    store.overrideColumnRole(6, 'text');

    const refreshed = analyzeDatasetOverview(
      store.workbook,
      store.activeSheet,
      store.visibleRowIndices,
      store.datasetProfile,
      store.activeColumnView,
      store.getDismissedQualityIds()
    );

    // Numeric detail for revenue: valid values [10, 20, 30, 50], nonNumeric = 1 ('bad_num')
    const rev = refreshed.detailsByCol.get(2)!;
    assert.equal(rev.numericStats?.validCount, 4);
    assert.equal(rev.numericStats?.nonNumericCount, 1);
    assert.equal(rev.numericStats?.min, 10);
    assert.equal(rev.numericStats?.q1, 17.5);
    assert.equal(rev.numericStats?.median, 25);
    assert.equal(rev.numericStats?.mean, 27.5);
    assert.equal(rev.numericStats?.q3, 35);
    assert.equal(rev.numericStats?.max, 50);
    assert.equal(rev.numericStats?.positiveCount, 4);
    assert.equal(rev.numericStats?.negativeCount, 0);

    // Categorical detail for category: Alpha(2), Beta(1), Gamma(1)
    const cat = refreshed.detailsByCol.get(1)!;
    assert.equal(cat.categoricalStats?.topValues[0]?.value, 'Alpha');
    assert.equal(cat.categoricalStats?.topValues[0]?.count, 2);
    assert.equal(cat.categoricalStats?.topValues[0]?.share, 0.5);

    // Boolean detail for is_active: true('true','yes'), false('false','0'), unexpected('maybe')
    const boolCol = refreshed.detailsByCol.get(3)!;
    assert.equal(boolCol.booleanStats?.trueCount, 2);
    assert.equal(boolCol.booleanStats?.falseCount, 2);
    assert.equal(boolCol.booleanStats?.unexpectedCount, 1);

    // Temporal detail for created_at
    const timeCol = refreshed.detailsByCol.get(4)!;
    assert.equal(timeCol.temporalStats?.validCount, 4);
    assert.equal(timeCol.temporalStats?.invalidCount, 1);
    assert.equal(timeCol.temporalStats?.earliestIso, '2024-01-05');
    assert.equal(timeCol.temporalStats?.latestIso, '2024-05-01');

    // Identifier detail for record_id
    const idCol = refreshed.detailsByCol.get(0)!;
    assert.equal(idCol.identifierStats?.duplicateValueCount, 1);
    assert.equal(idCol.identifierStats?.duplicateRowCount, 2);
    assert.deepEqual(idCol.identifierStats?.topDuplicates, [{value: 'ID-2', count: 2}]);

    // Text detail for notes
    const textCol = refreshed.detailsByCol.get(6)!;
    assert.equal(textCol.textStats?.minLength, 5);
    assert.equal(textCol.textStats?.maxLength, 30);
  });
});

test('data quality flags missing, potential type issues, constant/near-constant, duplicate IDs without mutating data', (t) => {
  const store = makeStoreForDataQuality();
  t.after(() => store.dispose());
  store.overrideColumnRole(0, 'identifier');
  store.overrideColumnRole(2, 'quantitative');
  store.overrideColumnRole(3, 'boolean');
  store.overrideColumnRole(4, 'temporal');

  const snapshotBefore = JSON.stringify(store.activeSheet.rows);
  const analysis = analyzeDatasetOverview(
    store.workbook,
    store.activeSheet,
    store.visibleRowIndices,
    store.datasetProfile,
    store.activeColumnView,
    store.getDismissedQualityIds()
  );

  // Source data strictly untouched (zero silent cleaning)
  assert.equal(JSON.stringify(store.activeSheet.rows), snapshotBefore);

  const missingObs = analysis.observations.find((o) => o.category === 'missing' && o.colIndex === 1);
  assert.ok(missingObs);
  assert.deepEqual(missingObs.firstCell, {rowIndex: 4, colIndex: 1});

  const numTypeObs = analysis.observations.find((o) => o.category === 'type-consistency' && o.colIndex === 2);
  assert.ok(numTypeObs);
  assert.match(numTypeObs.title, /Potential/);
  assert.deepEqual(numTypeObs.examples, [{rowIndex: 3, colIndex: 2, value: 'bad_num'}]);

  const boolTypeObs = analysis.observations.find((o) => o.category === 'type-consistency' && o.colIndex === 3);
  assert.ok(boolTypeObs);
  assert.deepEqual(boolTypeObs.examples, [{rowIndex: 3, colIndex: 3, value: 'maybe'}]);

  const constObs = analysis.observations.find((o) => o.category === 'constant' && o.colIndex === 5);
  assert.ok(constObs);
  assert.match(constObs.title, /Constant column/);

  const dupIdObs = analysis.observations.find((o) => o.id === 'id-dup:0');
  assert.ok(dupIdObs);
  assert.equal(dupIdObs.category, 'identifier');
  assert.equal(dupIdObs.affectedCount, 2);

  const missingIdObs = analysis.observations.find((o) => o.id === 'id-missing:0');
  assert.ok(missingIdObs);
  assert.deepEqual(missingIdObs.firstCell, {rowIndex: 3, colIndex: 0});
});

test('near-constant threshold triggers at >=98% dominant non-empty share and dismiss/restore is isolated per sheet', (t) => {
  const columns = ['flag'];
  const rows = Array.from({length: 100}, (_, i) => [i === 99 ? 'RARE' : 'COMMON']);
  const s1: SheetData = {id: 's1', name: 'S1', columns, rows, types: inferColumnTypes(columns, rows)};
  const s2: SheetData = {id: 's2', name: 'S2', columns: ['flag'], rows: [['X'], ['X']], types: ['text']};
  const store = new AppStore(
    {fileName: 'near.csv', fileFormat: 'csv', activeSheetIndex: 0, sheets: [s1, s2]},
    new DataWorkerClient({createWorker: () => null})
  );
  t.after(() => store.dispose());

  let overview = analyzeDatasetOverview(
    store.workbook,
    store.activeSheet,
    store.visibleRowIndices,
    store.datasetProfile,
    store.activeColumnView,
    store.getDismissedQualityIds()
  );
  const nearObs = overview.observations.find((o) => o.id === 'constant:0');
  assert.ok(nearObs);
  assert.match(nearObs.title, /Near-constant/);
  assert.deepEqual(nearObs.firstCell, {rowIndex: 99, colIndex: 0});

  // Dismiss on Sheet 1, verify Sheet 2 unaffected, then restore Sheet 1
  store.dismissQualityObservation('constant:0');
  overview = analyzeDatasetOverview(
    store.workbook,
    store.activeSheet,
    store.visibleRowIndices,
    store.datasetProfile,
    store.activeColumnView,
    store.getDismissedQualityIds()
  );
  assert.equal(overview.catalog[0].issueCount, 0);

  store.switchSheet(1);
  const s2Overview = analyzeDatasetOverview(
    store.workbook,
    store.activeSheet,
    store.visibleRowIndices,
    store.datasetProfile,
    store.activeColumnView,
    store.getDismissedQualityIds()
  );
  assert.equal(s2Overview.catalog[0].issueCount, 1);

  store.switchSheet(0);
  store.restoreQualityObservations();
  overview = analyzeDatasetOverview(
    store.workbook,
    store.activeSheet,
    store.visibleRowIndices,
    store.datasetProfile,
    store.activeColumnView,
    store.getDismissedQualityIds()
  );
  assert.equal(overview.catalog[0].issueCount, 1);
});

test('catalog preserves source colIndex across hide/pin/reorder and supports filter/sort + role override live recompute', (t) => {
  const store = makeStoreForDataQuality();
  t.after(() => store.dispose());

  // Reorder, pin, hide column 1 ('category')
  store.toggleColumnPin(2);
  store.toggleColumnVisibility(1);
  store.moveColumnVisual(6, -1);

  const initial = analyzeDatasetOverview(
    store.workbook,
    store.activeSheet,
    store.visibleRowIndices,
    store.datasetProfile,
    store.activeColumnView
  );

  // Source index 1 remains at catalog[1], marked hidden, while index 2 is pinned
  assert.equal(initial.catalog[1].colIndex, 1);
  assert.equal(initial.catalog[1].isHidden, true);
  assert.equal(initial.catalog[2].isPinned, true);

  // Override role from 'text' on column 6 -> metrics switch away from textStats
  store.overrideColumnRole(6, 'categorical');
  const updated = analyzeDatasetOverview(
    store.workbook,
    store.activeSheet,
    store.visibleRowIndices,
    store.datasetProfile,
    store.activeColumnView
  );
  assert.equal(updated.detailsByCol.get(6)?.semanticType, 'categorical');
  assert.ok(updated.detailsByCol.get(6)?.categoricalStats);
  assert.equal(updated.detailsByCol.get(6)?.textStats, null);

  // Filter & sort
  const byMissing = filterAndSortColumnCatalog(updated.catalog, {
    search: '',
    role: 'all',
    issuesOnly: false,
    sortBy: 'missing',
  });
  assert.equal(byMissing[0].missingCount, 1);

  const alphaOnly = filterAndSortColumnCatalog(updated.catalog, {
    search: 'rev',
    role: 'quantitative',
    issuesOnly: false,
    sortBy: 'source',
  });
  assert.deepEqual(
    alphaOnly.map((c) => c.colIndex),
    [2]
  );
});

test('getValidatedSuggestedAnalyses filters invalid recommendations and preserves 2D/3D consistency', (t) => {
  const store = makeStoreForDataQuality();
  t.after(() => store.dispose());
  store.overrideColumnRole(0, 'identifier');
  store.overrideColumnRole(1, 'categorical');
  store.overrideColumnRole(2, 'quantitative');

  const suggestions = getValidatedSuggestedAnalyses(
    store.activeSheet,
    store.visibleRowIndices,
    store.datasetProfile,
    store.chartConfig,
    store.spatialConfig
  );
  assert.ok(suggestions.length > 0);
  for (const item of suggestions) {
    assert.ok(item.summary.length > 0);
    assert.ok(item.targetLayout === 'charts' || item.targetLayout === 'spatial');
  }

  // Empty data produces zero validated suggestions
  const emptySheet: SheetData = {id: 'empty', name: 'Empty', columns: ['A'], rows: [], types: ['text']};
  const emptySuggestions = getValidatedSuggestedAnalyses(
    emptySheet,
    [],
    store.datasetProfile,
    store.chartConfig,
    store.spatialConfig
  );
  assert.equal(emptySuggestions.length, 0);
});
