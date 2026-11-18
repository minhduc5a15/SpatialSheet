import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyColumnRoleOverride,
  extractExplicitHeaderUnit,
  parseTemporalValue,
  profileDataset,
  reprofileColumn,
} from './dataProfiler';
import {normalizeRecordsToSheet, updateSheetCell} from './tabular';

test('dataProfiler detects quantitative, categorical, temporal, boolean, and sequential identifier columns', () => {
  const sheet = normalizeRecordsToSheet(
    [
      ['ID', 'Order Date', 'Region', 'Active', 'Revenue ($)', 'Margin (%)', 'Score'],
      ['1', '2025-01-01', 'North', 'true', '$1200', '22%', '88.5'],
      ['2', '2025-01-02', 'South', 'false', '$950', '-5%', '72.0'],
      ['3', '2025-01-03', 'North', 'true', '$1400', '25%', '91.2'],
      ['4', '2025-01-04', 'East', 'true', '$800', '18%', '64.5'],
      ['5', '2025-01-05', 'West', 'false', '$1100', '20%', '79.0'],
    ],
    'Sales',
    'sales-1'
  );

  const profile = profileDataset(sheet, 1);

  assert.equal(profile.columns[0].semanticType, 'identifier');
  assert.equal(profile.columns[1].semanticType, 'temporal');
  assert.equal(profile.columns[2].semanticType, 'categorical');
  assert.equal(profile.columns[3].semanticType, 'boolean');
  assert.equal(profile.columns[4].semanticType, 'quantitative');
  assert.equal(profile.columns[4].unit, '$');
  assert.equal(profile.columns[5].semanticType, 'quantitative');
  assert.equal(profile.columns[5].unit, '%');
  assert.equal(profile.columns[5].hasNegative, true);
  assert.equal(profile.columns[6].semanticType, 'quantitative');
  // Never fabricates unit for plain header 'Score'
  assert.equal(profile.columns[6].unit, null);

  // Sequential ID is in idCols, NOT quantCols
  assert.ok(profile.idCols.includes(0));
  assert.ok(!profile.quantCols.includes(0));
  assert.deepEqual(profile.quantCols, [4, 5, 6]);
  assert.deepEqual(profile.temporalCols, [1]);
  assert.deepEqual(profile.catCols, [2]);
  assert.deepEqual(profile.boolCols, [3]);
});

test('dataProfiler does not misclassify numeric years (e.g. 2020..2025) as identifier or temporal', () => {
  const sheet = normalizeRecordsToSheet([
    ['Year', 'Units'],
    ['2020', '100'],
    ['2021', '120'],
    ['2022', '145'],
    ['2023', '160'],
    ['2024', '190'],
  ]);
  const profile = profileDataset(sheet, 1);
  assert.equal(profile.columns[0].semanticType, 'quantitative');
  assert.equal(parseTemporalValue('2024'), null);
  assert.ok(parseTemporalValue('2024-05-15') !== null);
  assert.ok(parseTemporalValue('2024-Q2') !== null);
});

test('extractExplicitHeaderUnit never invents units and ignores duplicate header suffixes', () => {
  assert.equal(extractExplicitHeaderUnit('Latency (ms)'), 'ms');
  assert.equal(extractExplicitHeaderUnit('Weight [kg]'), 'kg');
  assert.equal(extractExplicitHeaderUnit('Revenue (2)'), null);
  assert.equal(extractExplicitHeaderUnit('Score'), null);
});

test('reprofileColumn updates single column incrementally and applyColumnRoleOverride updates role lists', () => {
  const sheet = normalizeRecordsToSheet([
    ['Code', 'Value'],
    ['A1', '10'],
    ['A2', '20'],
    ['A1', '30'],
    ['A3', '40'],
    ['A2', '50'],
  ]);
  const p1 = profileDataset(sheet, 1);
  assert.equal(p1.columns[0].semanticType, 'categorical');

  const edited = updateSheetCell(sheet, 0, 1, '100');
  const p2 = reprofileColumn(p1, edited, 1, 2);
  assert.equal(p2.sheetVersion, 2);
  assert.equal(p2.columns[1].max, 100);
  assert.equal(p2.columns[0], p1.columns[0]);

  const overridden = applyColumnRoleOverride(p2, 0, 'identifier');
  assert.ok(overridden.idCols.includes(0));
  assert.ok(!overridden.catCols.includes(0));
});
