import assert from 'node:assert/strict';
import test from 'node:test';
import * as XLSX from 'xlsx';
import type {WorkbookState} from '../types';
import type {WorkerRequest, WorkerResponse} from './dataWorker';
import {parseTemporalValue, profileDataset} from './dataProfiler';
import {buildExcelWorkbookForExport, importTabularFile} from './excelIO';
import {extractChart2DPoints} from '../ui/InteractiveChart2D';
import {
  computeNiceAxisScale,
  createDefaultSpatialConfig,
  normalizeValueOnAxis,
  resolveModeSwitchConfig,
  transformSpatialDataset,
} from './spatialTransform';
import {AppStore} from './store';
import {
  addSheetColumn,
  addSheetRow,
  formatDisplayNumber,
  normalizeRecordsToSheet,
  parseCsvText,
  parseNumericValue,
  serializeCsv,
} from './tabular';
import {
  AI_LLM_BENCHMARK_CSV,
  DUPLICATE_TOPK_CSV,
  MIXED_TYPES_CSV,
  NEGATIVE_AND_TINY_CSV,
  SPARSE_MISSING_CSV,
  UNICODE_AND_EDGE_CSV,
  createMultiSheetXlsxFile,
  makeSyntheticLargeSheet,
  makeWorkbookFromCsv,
} from './testFixtures';
import {DataWorkerClient, type WorkerLike} from './workerClient';

class CrashingMockWorker implements WorkerLike {
  public posted: Array<{msg: WorkerRequest; transfer?: Transferable[]}> = [];
  private messageListeners: Array<(ev: MessageEvent<WorkerResponse>) => void> =
    [];
  private errorListeners: Array<(ev: ErrorEvent) => void> = [];

  postMessage(message: unknown, transfer?: Transferable[]): void {
    this.posted.push({msg: message as WorkerRequest, transfer});
  }

  addEventListener(type: 'message' | 'error', listener: any): void {
    if (type === 'message') this.messageListeners.push(listener);
    else this.errorListeners.push(listener);
  }

  emitError(message: string): void {
    for (const fn of this.errorListeners) {
      fn({message} as ErrorEvent);
    }
  }

  emitMessage(data: WorkerResponse): void {
    for (const fn of this.messageListeners) {
      fn({data} as MessageEvent<WorkerResponse>);
    }
  }

  terminate(): void {}
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createPrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// ============================================================================
// 1. ASYNC / WORKER ORCHESTRATION & STORE RECOVERY
// ============================================================================

test('AppStore: worker crash during stats, filter-sort, and spatial transform clears loading and recovers synchronously', async () => {
  const worker = new CrashingMockWorker();
  const client = new DataWorkerClient({createWorker: () => worker});
  const bigSheet = makeSyntheticLargeSheet(2600, 4, 'big-crash');
  const wb: WorkbookState = {
    fileName: 'big.csv',
    fileFormat: 'csv',
    sheets: [bigSheet],
    activeSheetIndex: 0,
  };

  const store = new AppStore(wb, client);
  store.setLayout('spatial');
  store.setSpatialConfig({aggregation: 'sum'}); // triggers off-thread transformSpatial
  assert.equal(store.activeColumnStats.loading, true);
  assert.equal(store.spatialTransformLoading, true);

  // Trigger async filter-sort too
  store.toggleSortColumn(2);

  // Simulate sudden worker crash
  worker.emitError('Worker crashed unexpectedly');
  await flushMicrotasks();

  // Stats must recover cleanly (not stuck in loading=true)
  assert.equal(store.activeColumnStats.loading, false);
  assert.ok(store.activeColumnStats.stats !== null);
  assert.equal(store.activeColumnStats.stats!.count, 2600);

  // Spatial transform must recover cleanly (not stuck in spatialTransformLoading=true)
  assert.equal(store.spatialTransformLoading, false);
  assert.equal(store.derivedSpatialData.isValid, true);
  assert.equal(store.derivedSpatialData.totalVisibleRows, 2600);

  // Sort/filter must recover via synchronous fallback so visibleRowIndices matches sorted order
  assert.equal(store.visibleRowIndices.length, 2600);
  const firstRowVal = Number(store.activeSheet.rows[store.visibleRowIndices[0]][2]);
  const lastRowVal = Number(
    store.activeSheet.rows[store.visibleRowIndices[2599]][2]
  );
  assert.ok(firstRowVal <= lastRowVal);

  // Crashed worker must be detached so subsequent cell selection completes cleanly without hanging
  assert.equal(client.hasWorker, false);
  store.selectCell({rowIndex: 0, colIndex: 3});
  assert.equal(store.activeColumnStats.loading, false);
  assert.equal(store.activeColumnStats.colIndex, 3);
  assert.equal(store.activeColumnStats.stats?.count, 2600);

  store.dispose();
});

test('DataWorkerClient: error response from worker (e.g. cache miss) settles pending promise and invalidates cache', async () => {
  const worker = new CrashingMockWorker();
  const client = new DataWorkerClient({createWorker: () => worker});
  const sheet = makeSyntheticLargeSheet(2600, 3);

  const p1 = client.filterAndSort({
    sheet,
    sheetVersion: 5,
    searchQuery: 'North',
    sort: {colIndex: null, direction: null},
  });
  const req1 = worker.posted[0].msg as Extract<WorkerRequest, {type: 'filter-sort'}>;

  worker.emitMessage({
    type: 'worker-error',
    requestId: req1.requestId,
    op: 'filter-sort',
    error: 'Sheet cache miss',
  } as unknown as WorkerResponse);

  const res1 = await Promise.race([
    p1,
    new Promise((r) => setTimeout(() => r('HUNG'), 30)),
  ]);
  assert.equal(res1, null);

  // Next call for same sheetVersion 5 MUST re-upload sheet because cache was invalidated
  worker.posted.length = 0;
  const p2 = client.filterAndSort({
    sheet,
    sheetVersion: 5,
    searchQuery: 'South',
    sort: {colIndex: null, direction: null},
  });
  const req2 = worker.posted[0].msg as Extract<WorkerRequest, {type: 'filter-sort'}>;
  assert.ok(req2.sheet !== undefined);
  worker.emitMessage({
    type: 'filter-sort-result',
    requestId: req2.requestId,
    sheetVersion: 5,
    indicesBuffer: Int32Array.from([1]).buffer,
  });
  await p2;
  client.dispose();
});

test('AppStore: addNewSheet generates unique IDs even when called twice in same millisecond', () => {
  const store = new AppStore();
  store.addNewSheet();
  store.addNewSheet();
  const ids = store.workbook.sheets.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  store.dispose();
});

// ============================================================================
// 2. CSV / EXCEL PARSING & SERIALIZATION INTEGRITY
// ============================================================================

test('tabular: parseNumericValue supports scientific notation while rejecting text', () => {
  assert.deepEqual(parseNumericValue('1.5e-4'), {value: 1.5e-4, isPercent: false});
  assert.deepEqual(parseNumericValue('-3.1E+2'), {value: -310, isPercent: false});
  assert.deepEqual(parseNumericValue('2.25e5'), {value: 225000, isPercent: false});
  assert.equal(parseNumericValue('1e999').value, null);
  assert.equal(parseNumericValue('abc').value, null);
});

test('tabular: normalizeRecordsToSheet guarantees unique column headers even with colliding "(2)" suffixes', () => {
  const sheet = parseCsvText(UNICODE_AND_EDGE_CSV, 'Edge');
  assert.equal(new Set(sheet.columns).size, sheet.columns.length);
  assert.deepEqual(sheet.columns.slice(0, 3), [
    'Revenue',
    'Revenue (2)',
    'Revenue (3)',
  ]);
  assert.equal(sheet.rows[0][3], 'Line 1\n"Quoted", <script>alert(1)</script>');
  assert.equal(sheet.rows[0][4], 'Hà Nội');
  // Round-trip CSV serialization preserves newlines, quotes, commas, and diacritics
  const reparsed = parseCsvText(serializeCsv(sheet), 'Edge');
  assert.deepEqual(reparsed.rows, sheet.rows);
});

test('tabular: addSheetRow and addSheetColumn leave new cells empty instead of fabricating "0"', () => {
  const sheet = parseCsvText('Region,Revenue\nNorth,100\nSouth,200');
  const afterRow = addSheetRow(sheet);
  assert.equal(afterRow.rows[2][1], '');
  const afterCol = addSheetColumn(sheet, 'Cost');
  assert.equal(afterCol.rows[0][2], '');
  assert.equal(afterCol.rows[1][2], '');
});

test('tabular: formatDisplayNumber preserves significance for small non-zero numbers (< 0.005)', () => {
  assert.notEqual(formatDisplayNumber(0.0002), '0');
  assert.notEqual(formatDisplayNumber(0.0015), '0');
  assert.equal(formatDisplayNumber(0), '0');
  assert.equal(formatDisplayNumber(-0), '0');
});

test('excelIO: importTabularFile reads multi-sheet .xlsx preserving leading zeros, and export preserves leading zeros & unsafe integers + unique sheet names', async () => {
  const xlsxFile = createMultiSheetXlsxFile('inventory.xlsx');
  const wb = await importTabularFile(xlsxFile);
  assert.equal(wb.sheets.length, 2);
  assert.equal(wb.sheets[0].name, 'Inventory');
  assert.equal(wb.sheets[0].rows[0][0], '000123');

  // Construct a workbook with leading-zero numeric-looking codes, unsafe 20-digit integer, and duplicate truncated names
  const s1 = normalizeRecordsToSheet([
    ['Postal', 'UnsafeID', 'Amount'],
    ['00123', '12345678901234567890', '42.5'],
    ['00456', '12345678901234567891', '100'],
  ]);
  s1.name = 'VeryLongSheetNameThatGetsTruncatedHere';
  s1.types = ['number', 'number', 'number']; // even if typed number, export must not corrupt strings
  const s2 = normalizeRecordsToSheet([['A'], ['1']]);
  s2.name = 'VeryLongSheetNameThatGetsTruncated_Extra';
  const s3 = normalizeRecordsToSheet([['B'], ['2']]);
  s3.name = 'VeryLongSheetNameThatGetsTruncated_More';

  const exportedWb = buildExcelWorkbookForExport({
    fileName: 'check.xlsx',
    fileFormat: 'xlsx',
    activeSheetIndex: 0,
    sheets: [s1, s2, s3],
  });

  assert.equal(exportedWb.SheetNames.length, 3);
  assert.equal(new Set(exportedWb.SheetNames).size, 3);
  const ws0 = exportedWb.Sheets[exportedWb.SheetNames[0]];
  const roundTripped = XLSX.utils.sheet_to_json<unknown[]>(ws0, {
    header: 1,
    raw: false,
  });
  assert.equal(roundTripped[1][0], '00123');
  assert.equal(roundTripped[1][1], '12345678901234567890');
  assert.equal(roundTripped[1][2], '42.5');
});

// ============================================================================
// 3. SEMANTIC PROFILER CORRECTNESS
// ============================================================================

test('dataProfiler: classifies leading-zero codes, unsafe integers, and short explicit IDs as identifier, and scientific notation as quantitative', () => {
  const sheet = parseCsvText(MIXED_TYPES_CSV, 'Mixed');
  const profile = profileDataset(sheet, 1);

  assert.equal(profile.columns[0].semanticType, 'identifier'); // Code: 00123..00999
  assert.equal(profile.columns[1].semanticType, 'identifier'); // UnsafeID: 20 digits > MAX_SAFE_INTEGER
  assert.equal(profile.columns[2].semanticType, 'quantitative'); // SciValue: 1.5e-4 ..
  assert.equal(profile.columns[3].semanticType, 'quantitative'); // Discount (%)
  assert.equal(profile.columns[3].unit, '%');
  assert.equal(profile.columns[4].semanticType, 'quantitative'); // Budget ($1200)
  assert.equal(profile.columns[5].semanticType, 'temporal'); // EventDate
  assert.equal(profile.columns[6].semanticType, 'boolean'); // Flag
  assert.equal(parseTemporalValue('1.5e-4'), null);

  // Small 3-row explicit ID column must still classify as identifier
  const tinyIdSheet = normalizeRecordsToSheet([
    ['Order_ID', 'Total'],
    ['1', '50'],
    ['2', '60'],
    ['3', '70'],
  ]);
  const tinyProfile = profileDataset(tinyIdSheet, 1);
  assert.equal(tinyProfile.columns[0].semanticType, 'identifier');
  assert.equal(tinyProfile.columns[1].semanticType, 'quantitative');
});

test('dataProfiler: accurately profiles AI / LLM Benchmark dataset with units and dimensions', () => {
  const sheet = parseCsvText(AI_LLM_BENCHMARK_CSV, 'AI Benchmarks');
  const profile = profileDataset(sheet, 1);
  const byName = new Map(profile.columns.map((c) => [c.name, c]));

  assert.equal(byName.get('Provider')?.semanticType, 'categorical');
  assert.equal(byName.get('Category')?.semanticType, 'categorical');
  assert.equal(byName.get('Release Date')?.semanticType, 'temporal');
  assert.equal(byName.get('Latency (ms)')?.semanticType, 'quantitative');
  assert.equal(byName.get('Latency (ms)')?.unit, 'ms');
  assert.equal(byName.get('Cost ($)')?.semanticType, 'quantitative');
  assert.equal(byName.get('Cost ($)')?.unit, '$');
  assert.equal(byName.get('Accuracy (%)')?.semanticType, 'quantitative');
  assert.equal(byName.get('Accuracy (%)')?.unit, '%');
  assert.equal(byName.get('Open Weights')?.semanticType, 'boolean');
});

// ============================================================================
// 4. SPATIAL ANALYTICS & 3D TRANSFORMATION MATH
// ============================================================================

test('spatialTransform: Bar3D Top-K & sortOrder use actual MIN and MAX bucket scores (not SUM)', () => {
  // CatA: Q1=100, Q2=5   => SUM=105, MAX=100, MIN=5
  // CatB: Q1=30,  Q2=25  => SUM=55,  MAX=30,  MIN=25
  // CatC: Q1=20,  Q2=20  => SUM=40,  MAX=20,  MIN=20
  // CatD: Q1=50,  Q2=1   => SUM=51,  MAX=50,  MIN=1
  const sheet = parseCsvText(DUPLICATE_TOPK_CSV, 'TopK');
  const profile = profileDataset(sheet, 1);
  const baseCfg = {
    ...createDefaultSpatialConfig(profile),
    groupByColIndex: null,
  };
  const visible = [0, 1, 2, 3, 4, 5, 6, 7];

  // Aggregated MIN descending: CatB(25) > CatC(20) > CatA(5) > CatD(1)
  const minDesc = transformSpatialDataset({
    sheet,
    visibleRowIndices: visible,
    profile,
    config: {...baseCfg, aggregation: 'min', sortOrder: 'value-desc'},
    mode: 'bar3d',
  });
  assert.deepEqual(
    minDesc.items.map((it) => it.label),
    ['CatB', 'CatC', 'CatA', 'CatD']
  );

  // Aggregated MAX descending: CatA(100) > CatD(50) > CatB(30) > CatC(20)
  const maxDesc = transformSpatialDataset({
    sheet,
    visibleRowIndices: visible,
    profile,
    config: {...baseCfg, aggregation: 'max', sortOrder: 'value-desc'},
    mode: 'bar3d',
  });
  assert.deepEqual(
    maxDesc.items.map((it) => it.label),
    ['CatA', 'CatD', 'CatB', 'CatC']
  );
});

test('spatialTransform: representedRowCount accurately reflects plotted/aggregated rows when rows are skipped or truncated', () => {
  const sheet = parseCsvText(SPARSE_MISSING_CSV, 'Sparse');
  const profile = profileDataset(sheet, 1);
  const baseCfg = {
    ...createDefaultSpatialConfig(profile),
    groupByColIndex: null,
  };
  const visible = [0, 1, 2, 3, 4, 5]; // rows 1, 2, 4 have missing/N/A Metric -> only 3 valid numeric rows (0, 3, 5)

  const aggBar = transformSpatialDataset({
    sheet,
    visibleRowIndices: visible,
    profile,
    config: {...baseCfg, aggregation: 'sum'},
    mode: 'bar3d',
  });
  assert.equal(aggBar.representedRowCount, 3);
  assert.equal(aggBar.totalVisibleRows, 6);

  const rawBar = transformSpatialDataset({
    sheet,
    visibleRowIndices: visible,
    profile,
    config: {...baseCfg, aggregation: 'none'},
    mode: 'bar3d',
  });
  assert.equal(rawBar.representedRowCount, 3);
  // Raw Bar3D must NOT emit ghost X-axis category ticks for rows whose Y was empty/invalid
  assert.equal(rawBar.axes.x.categoryTicks.length, rawBar.items.length);

  // Ring3D: only positive valid rows are represented (row 0 = 10, row 3 = 40; row 5 = 0 is filtered out)
  const ring = transformSpatialDataset({
    sheet,
    visibleRowIndices: visible,
    profile,
    config: {...baseCfg, aggregation: 'sum'},
    mode: 'ring3d',
  });
  assert.equal(ring.representedRowCount, 2);

  // Scatter3D with non-numeric/missing points skipped must not claim "All N raw points plotted" when skipped
  const scatterSheet = normalizeRecordsToSheet([
    ['Item', 'X', 'Y', 'Z'],
    ['P1', '1', '10', '100'],
    ['P2', '2', '', '200'],
    ['P3', '3', '30', '300'],
  ]);
  const scatterProfile = profileDataset(scatterSheet, 1);
  const scatterCfg = resolveModeSwitchConfig(
    scatterProfile,
    createDefaultSpatialConfig(scatterProfile),
    'scatter3d'
  );
  const scatter = transformSpatialDataset({
    sheet: scatterSheet,
    visibleRowIndices: [0, 1, 2],
    profile: scatterProfile,
    config: scatterCfg,
    mode: 'scatter3d',
  });
  assert.equal(scatter.representedRowCount, 2);
  assert.ok(!scatter.dataStateSummary.startsWith('All 3'));
});

test('spatialTransform: log scale supports small positive numbers (< 1e-6), ring3d Other bucket sums to 1.0, and systematic sampling is named correctly', () => {
  const tinyScale = computeNiceAxisScale(1e-9, 9e-9, {scaleType: 'log'});
  assert.equal(tinyScale.effectiveScaleType, 'log');
  assert.ok(tinyScale.min <= 1e-9);
  assert.ok(tinyScale.max >= 1e-8);
  const norm = normalizeValueOnAxis(3e-9, tinyScale.min, tinyScale.max, 'log');
  assert.ok(norm > 0 && norm < 1);

  // Ring3D with 12 distinct categories + topK=5 groups tail into "Other" and sum(proportion) == 1
  const records: unknown[][] = [['Cat', 'Val']];
  for (let i = 0; i < 12; i++) {
    records.push([`C${i}`, String((12 - i) * 10)]);
  }
  const ringSheet = normalizeRecordsToSheet(records);
  const ringProfile = profileDataset(ringSheet, 1);
  const baseCfg = createDefaultSpatialConfig(ringProfile);
  assert.equal(baseCfg.samplingStrategy, 'systematic');

  const ringCfg = resolveModeSwitchConfig(ringProfile, {...baseCfg, topK: 5}, 'ring3d');
  const ring = transformSpatialDataset({
    sheet: ringSheet,
    visibleRowIndices: Array.from({length: 12}, (_, i) => i),
    profile: ringProfile,
    config: ringCfg,
    mode: 'ring3d',
  });
  assert.equal(ring.items.length, 5);
  assert.ok(ring.items[4].label.startsWith('Other ('));
  const propSum = ring.items.reduce((acc, it) => acc + (it.proportion ?? 0), 0);
  assert.ok(Math.abs(propSum - 1) < 1e-9);

  // Switching back to bar3d from ring3d with topK=5 normalizes topK to valid bar3d select option (>= 8)
  const backToBar = resolveModeSwitchConfig(ringProfile, ringCfg, 'bar3d');
  assert.ok([8, 12, 16, 24, 36].includes(backToBar.topK));
});

// ============================================================================
// 5. STORE CROSS-VIEW SYNC & PROPERTY-BASED INVARIANTS
// ============================================================================

test('AppStore: filtering reconciles highlightedRowIndex and selectedSpatialItem when highlighted row is filtered out', async () => {
  const wb = makeWorkbookFromCsv('small.csv', DUPLICATE_TOPK_CSV);
  const noopWorker = new DataWorkerClient({
    createWorker: () => null as unknown as WorkerLike,
  });
  const store = new AppStore(wb, noopWorker);

  store.selectCell({rowIndex: 0, colIndex: 2}); // Row 0 is CatA
  assert.equal(store.highlightedRowIndex, 0);

  // Filter to 'CatC' (rows 4 and 5) -> row 0 is excluded
  store.setSearchQueryDebounced('CatC', 0);
  await flushMicrotasks();

  assert.deepEqual(Array.from(store.visibleRowIndices), [4, 5]);
  // Highlighted row must no longer point to hidden row 0
  assert.equal(store.highlightedRowIndex, null);
  assert.equal(store.selectedSpatialItem, null);

  // Out-of-bounds highlightRowFromChart must be ignored safely
  store.highlightRowFromChart(999);
  assert.equal(store.highlightedRowIndex, null);

  store.dispose();
});

test('Property-based invariants: seeded random edit, sort, filter, delete, undo, redo sequences never produce out-of-bounds indices or corrupt state', async () => {
  const rng = createPrng(20260518);
  const wb = makeWorkbookFromCsv('bench.csv', AI_LLM_BENCHMARK_CSV);
  const noopWorker = new DataWorkerClient({
    createWorker: () => null as unknown as WorkerLike,
  });
  const store = new AppStore(wb, noopWorker);

  const queries = ['', 'OpenAI', 'Google', 'Frontier', 'nonexistent_xyz'];
  const modes = ['bar3d', 'scatter3d', 'ring3d'] as const;

  for (let step = 0; step < 60; step++) {
    const action = Math.floor(rng() * 7);
    const sheet = store.activeSheet;

    if (action === 0 && sheet.rows.length > 0) {
      const r = Math.floor(rng() * sheet.rows.length);
      const c = Math.floor(rng() * sheet.columns.length);
      const val = c >= 4 && c <= 7 ? String(Math.round(rng() * 500)) : `Tag_${Math.floor(rng() * 10)}`;
      store.commitCellEdit(r, c, val);
    } else if (action === 1) {
      const c = Math.floor(rng() * sheet.columns.length);
      store.toggleSortColumn(c);
    } else if (action === 2) {
      const q = queries[Math.floor(rng() * queries.length)];
      store.setSearchQueryDebounced(q, 0);
    } else if (action === 3) {
      store.addRow();
    } else if (action === 4 && sheet.rows.length > 2) {
      const r = Math.floor(rng() * sheet.rows.length);
      store.deleteRow(r);
    } else if (action === 5) {
      store.undo();
    } else {
      store.redo();
    }

    await flushMicrotasks();

    // Switch mode occasionally to exercise all spatial modes on mutated/filtered states
    store.setSpatialMode(modes[step % modes.length]);

    const rowLen = store.activeSheet.rows.length;
    const vis = store.visibleRowIndices;
    const visSet = new Set<number>();

    // Invariant 1: Every visible row index is in [0, rowLen)
    for (let i = 0; i < vis.length; i++) {
      const idx = vis[i];
      assert.ok(idx >= 0 && idx < rowLen, `Out-of-bounds visible index ${idx} >= ${rowLen}`);
      visSet.add(idx);
    }

    // Invariant 2: Spatial dataset counts & row references are always bounded and consistent
    const d = store.derivedSpatialData;
    assert.equal(d.totalVisibleRows, vis.length);
    assert.ok(d.representedRowCount >= 0 && d.representedRowCount <= d.totalVisibleRows);
    for (const item of d.items) {
      assert.ok(visSet.has(item.firstRowIndex), `firstRowIndex ${item.firstRowIndex} not in visibleRowIndices`);
      for (const rIdx of item.rowIndices) {
        assert.ok(visSet.has(rIdx), `rowIndices entry ${rIdx} not in visibleRowIndices`);
      }
      assert.ok(Number.isFinite(item.xNorm) && Number.isFinite(item.yNorm) && Number.isFinite(item.zNorm));
    }

    // Invariant 3: Highlighted row, if non-null, belongs to sheet bounds
    if (store.highlightedRowIndex !== null) {
      assert.ok(store.highlightedRowIndex >= 0 && store.highlightedRowIndex < rowLen);
    }
  }

  // Undo back as far as history allows and verify no crash
  while (store.history.canUndo) {
    store.undo();
    await flushMicrotasks();
    assert.ok(store.visibleRowIndices.length <= store.activeSheet.rows.length);
  }

  // Re-verify unused NEGATIVE_AND_TINY_CSV fixture compiles & parses cleanly
  const negTiny = parseCsvText(NEGATIVE_AND_TINY_CSV, 'NegTiny');
  assert.equal(negTiny.rows.length, 4);

  store.dispose();
});

test('InteractiveChart2D: extractChart2DPoints preserves null for missing/non-numeric cells without fabricating zeros', () => {
  const sheet = parseCsvText(SPARSE_MISSING_CSV, 'Sparse');
  const visible = [0, 1, 2, 3, 4, 5];
  const {points, hasAnyNumeric} = extractChart2DPoints(sheet, visible, 0, [2]);

  assert.equal(hasAnyNumeric, true);
  assert.equal(points.length, 6);
  assert.deepEqual(
    points.map((p) => p.values[0]),
    [10, null, null, 40, null, 0]
  );
  assert.equal(points[0].hasAnyNumeric, true);
  assert.equal(points[1].hasAnyNumeric, false);
  assert.equal(points[2].hasAnyNumeric, false);
  assert.equal(points[5].hasAnyNumeric, true);
});

