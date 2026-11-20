import test from 'node:test';
import assert from 'node:assert/strict';
import {profileDataset} from './dataProfiler';
import {
  computeNiceAxisScale,
  createDefaultSpatialConfig,
  getValidAggregations,
  resolveModeSwitchConfig,
  transformSpatialDataset,
} from './spatialTransform';
import {recommendCharts} from './chartRecommender';
import {normalizeRecordsToSheet} from './tabular';

test('computeNiceAxisScale produces exact 1/2/5 ticks, zero baseline for negative spans, and log fallback', () => {
  const mixed = computeNiceAxisScale(-18, 43, {includeZero: true});
  assert.equal(mixed.effectiveScaleType, 'linear');
  assert.ok(mixed.min <= -18);
  assert.ok(mixed.max >= 43);
  assert.ok(mixed.zeroNormalized !== null);
  assert.ok(mixed.zeroNormalized! > 0 && mixed.zeroNormalized! < 1);
  assert.ok(mixed.ticks.some((t) => Math.abs(t.value) < 1e-9));

  const allNeg = computeNiceAxisScale(-42, -7, {includeZero: true});
  assert.equal(allNeg.max, 0);
  assert.equal(allNeg.zeroNormalized, 1);

  const logFallback = computeNiceAxisScale(0, 100, {scaleType: 'log'});
  assert.equal(logFallback.effectiveScaleType, 'linear');
  assert.ok(logFallback.fallbackNotice !== null);

  const validLog = computeNiceAxisScale(5, 500, {scaleType: 'log'});
  assert.equal(validLog.effectiveScaleType, 'log');
  assert.equal(validLog.min, 1);
  assert.equal(validLog.max, 1000);
});

test('transformSpatialDataset handles grouped 3D bars with negative values and all aggregations', () => {
  const sheet = normalizeRecordsToSheet([
    ['Category', 'Quarter', 'Profit ($)'],
    ['Cloud', 'Q1', '100'],
    ['Cloud', 'Q1', '200'],
    ['Cloud', 'Q2', '-50'],
    ['Retail', 'Q1', '40'],
    ['Retail', 'Q2', '80'],
  ]);
  const profile = profileDataset(sheet, 1);
  const visible = [0, 1, 2, 3, 4];
  const baseCfg = createDefaultSpatialConfig(profile);
  assert.equal(baseCfg.xColIndex, 0);
  assert.equal(baseCfg.yColIndex, 2);
  assert.equal(baseCfg.groupByColIndex, 1);

  const avgDerived = transformSpatialDataset({
    sheet,
    visibleRowIndices: visible,
    profile,
    config: {...baseCfg, aggregation: 'avg', sortOrder: 'label-asc'},
    mode: 'bar3d',
  });
  assert.equal(avgDerived.isValid, true);
  assert.equal(avgDerived.dataStateKind, 'aggregated');
  assert.equal(avgDerived.items.length, 4);

  const cloudQ1 = avgDerived.items.find(
    (it) => it.label === 'Cloud' && it.seriesLabel === 'Q1'
  )!;
  assert.equal(cloudQ1.yValue, 150);
  assert.equal(cloudQ1.recordCount, 2);
  assert.deepEqual(cloudQ1.aggStats, {
    sum: 300,
    avg: 150,
    min: 100,
    max: 200,
    count: 2,
  });

  const cloudQ2 = avgDerived.items.find(
    (it) => it.label === 'Cloud' && it.seriesLabel === 'Q2'
  )!;
  assert.equal(cloudQ2.yValue, -50);
  assert.ok(cloudQ2.yNorm < cloudQ2.yZeroNorm);

  // Sum, min, max, count
  for (const agg of ['sum', 'min', 'max', 'count'] as const) {
    const res = transformSpatialDataset({
      sheet,
      visibleRowIndices: visible,
      profile,
      config: {...baseCfg, aggregation: agg},
      mode: 'bar3d',
    });
    const item = res.items.find(
      (it) => it.label === 'Cloud' && it.seriesLabel === 'Q1'
    )!;
    const expected =
      agg === 'sum' ? 300 : agg === 'min' ? 100 : agg === 'max' ? 200 : 2;
    assert.equal(item.yValue, expected);
  }
});

test('non-numeric Y restricts aggregations to Count cleanly', () => {
  const sheet = normalizeRecordsToSheet([
    ['Region', 'Status'],
    ['North', 'Open'],
    ['North', 'Closed'],
    ['South', 'Open'],
  ]);
  const profile = profileDataset(sheet, 1);
  const statuses = getValidAggregations(profile.columns[1], 'bar3d');
  assert.equal(statuses.find((s) => s.fn === 'sum')?.enabled, false);
  assert.equal(statuses.find((s) => s.fn === 'count')?.enabled, true);

  const cfg = createDefaultSpatialConfig(profile);
  const derived = transformSpatialDataset({
    sheet,
    visibleRowIndices: [0, 1, 2],
    profile,
    config: {...cfg, yColIndex: 1, aggregation: 'sum'},
    mode: 'bar3d',
  });
  assert.equal(derived.isValid, true);
  assert.ok(derived.warningMessage !== null);
  assert.equal(derived.items.find((i) => i.label === 'North')?.yValue, 2);
});

test('3D Scatter plots true X/Y/Z normalized coordinates with 4th-dimension color legend', () => {
  const sheet = normalizeRecordsToSheet([
    ['Model', 'Latency (ms)', 'Accuracy (%)', 'Cost ($)', 'Tier'],
    ['Alpha', '100', '80', '1.0', 'Pro'],
    ['Beta', '200', '90', '2.0', 'Pro'],
    ['Gamma', '300', '85', '3.0', 'Lite'],
    ['Delta', '400', '95', '4.0', 'Lite'],
  ]);
  const profile = profileDataset(sheet, 1);
  const barCfg = createDefaultSpatialConfig(profile);
  const scatterCfg = resolveModeSwitchConfig(profile, barCfg, 'scatter3d');

  assert.equal(scatterCfg.xColIndex, 1);
  assert.equal(scatterCfg.yColIndex, 2);
  assert.equal(scatterCfg.zColIndex, 3);

  const derived = transformSpatialDataset({
    sheet,
    visibleRowIndices: [0, 1, 2, 3],
    profile,
    config: scatterCfg,
    mode: 'scatter3d',
  });

  assert.equal(derived.isValid, true);
  assert.equal(derived.axes.x.title, 'Latency (ms)');
  assert.equal(derived.axes.y.title, 'Accuracy (%)');
  assert.equal(derived.axes.z?.title, 'Cost ($)');
  assert.equal(derived.items.length, 4);
  // Points preserve true rowIndex and non-decreasing X, Z order
  assert.equal(derived.items[0].firstRowIndex, 0);
  assert.equal(derived.items[3].firstRowIndex, 3);
  assert.ok(derived.items[3].xNorm > derived.items[0].xNorm);
  assert.ok(derived.items[3].zNorm > derived.items[0].zNorm);
  assert.equal(derived.legend.kind, 'discrete');
});

test('3D Ring rejects negative values with actionable notice and computes accurate positive proportions', () => {
  const negSheet = normalizeRecordsToSheet([
    ['Dept', 'Net ($)'],
    ['A', '100'],
    ['B', '-20'],
  ]);
  const negProfile = profileDataset(negSheet, 1);
  const negRing = transformSpatialDataset({
    sheet: negSheet,
    visibleRowIndices: [0, 1],
    profile: negProfile,
    config: createDefaultSpatialConfig(negProfile),
    mode: 'ring3d',
  });
  assert.equal(negRing.isValid, false);
  assert.ok(negRing.validationMessage?.includes('non-negative'));

  const posSheet = normalizeRecordsToSheet([
    ['Dept', 'Spend ($)'],
    ['Eng', '300'],
    ['Sales', '100'],
  ]);
  const posProfile = profileDataset(posSheet, 1);
  const posRing = transformSpatialDataset({
    sheet: posProfile ? posSheet : posSheet,
    visibleRowIndices: [0, 1],
    profile: posProfile,
    config: {...createDefaultSpatialConfig(posProfile), aggregation: 'sum'},
    mode: 'ring3d',
  });
  assert.equal(posRing.isValid, true);
  assert.equal(posRing.items.length, 2);
  assert.equal(posRing.items[0].proportion, 0.75);
  assert.equal(posRing.items[1].proportion, 0.25);

  const recs = recommendCharts(posProfile);
  assert.ok(recs.some((r) => r.spatialMode === 'ring3d'));
});

test('50,000-row aggregation produces correct groups with bounded rowIndices memory', () => {
  const rows: string[][] = new Array(50000);
  const regions = ['NA', 'EU', 'APAC', 'LATAM'];
  for (let i = 0; i < 50000; i++) {
    rows[i] = [String(i + 1), regions[i % 4], String((i % 100) + 1)];
  }
  const sheet = {
    id: 'big',
    name: 'Big',
    columns: ['ID', 'Region', 'Amount'],
    rows,
    types: ['number', 'text', 'number'] as ('number' | 'text' | 'percent')[],
  };
  const visible = new Int32Array(50000);
  for (let i = 0; i < 50000; i++) visible[i] = i;

  const profile = profileDataset(sheet, 1);
  const cfg = createDefaultSpatialConfig(profile);
  const derived = transformSpatialDataset({
    sheet,
    visibleRowIndices: visible,
    profile,
    config: {...cfg, aggregation: 'sum'},
    mode: 'bar3d',
  });

  assert.equal(derived.isValid, true);
  assert.equal(derived.items.length, 4);
  assert.equal(derived.items[0].recordCount, 12500);
  assert.ok(derived.items[0].rowIndices.length <= 100);
});

import {AppStore} from './store';
import type {WorkerLike} from './workerClient';
import {DataWorkerClient} from './workerClient';

test('AppStore integrates profile, spatial transform, role override, recommendations, and item selection sync', (t) => {
  const noopWorker = new DataWorkerClient({
    createWorker: () => null as unknown as WorkerLike,
  });
  const wb = {
    fileName: 'bench.csv',
    fileFormat: 'csv' as const,
    activeSheetIndex: 0,
    sheets: [
      normalizeRecordsToSheet([
        ['Provider', 'Region', 'Latency (ms)', 'Score (%)', 'Cost ($)'],
        ['OpenAI', 'US', '420', '91', '3.0'],
        ['Google', 'US', '310', '93', '1.8'],
        ['Anthropic', 'EU', '390', '92', '2.9'],
        ['OpenAI', 'EU', '440', '90', '3.2'],
      ]),
    ],
  };

  const store = new AppStore(wb, noopWorker);
  t.after(() => store.dispose());
  assert.equal(store.datasetProfile.quantCols.length, 3);
  assert.ok(store.chartRecommendations.length >= 2);
  assert.equal(store.derivedSpatialData.mode, 'bar3d');
  assert.equal(store.derivedSpatialData.axes.y.unit, 'ms');

  store.setSpatialMode('scatter3d');
  assert.equal(store.derivedSpatialData.mode, 'scatter3d');
  assert.equal(store.derivedSpatialData.axes.z?.title, 'Cost ($)');

  const item = store.derivedSpatialData.items[1];
  store.selectSpatialItem(item);
  assert.equal(store.selectedSpatialItem?.id, item.id);
  assert.equal(store.highlightedRowIndex, item.firstRowIndex);

  store.overrideColumnRole(2, 'categorical');
  assert.ok(store.datasetProfile.catCols.includes(2));
});

