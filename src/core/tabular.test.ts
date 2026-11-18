import assert from 'node:assert/strict';
import test from 'node:test';
import {WorkbookHistoryManager} from './history';
import {
  HistoryManager,
  addSheetColumn,
  addSheetRow,
  columnIndexToLetter,
  computeColumnStats,
  createBlankWorkbook,
  deleteSheetColumn,
  deleteSheetRow,
  filterAndSortRows,
  filterAndSortRowsBuffer,
  normalizeRecordsToSheet,
  parseCsvRecords,
  parseCsvText,
  parseNumericValue,
  serializeCsv,
  suggestChartConfig,
  updateSheetCell,
} from './tabular';
import {
  computeColumnVirtualWindow,
  computeRowVirtualWindow,
  computeScrollTopForRow,
  sampleChartIndices,
} from './virtualWindow';

test('columnIndexToLetter maps Excel-style columns', () => {
  assert.equal(columnIndexToLetter(0), 'A');
  assert.equal(columnIndexToLetter(25), 'Z');
  assert.equal(columnIndexToLetter(26), 'AA');
});

test('parseCsvText handles UTF-8 BOM, multiline quoted fields, escaped quotes, and quoted commas', () => {
  const csv = [
    '\uFEFFKhu vực,Doanh thu,"Ghi chú, chi tiết",Tăng trưởng',
    '"Hà Nội",1250,"Tăng mạnh,\n""quý 1""",18.5%',
    '"TP. Hồ Chí Minh",2400,"Ổn định",24%',
  ].join('\n');

  const sheet = parseCsvText(csv, 'Kinh doanh');
  assert.equal(sheet.name, 'Kinh doanh');
  assert.deepEqual(sheet.columns, [
    'Khu vực',
    'Doanh thu',
    'Ghi chú, chi tiết',
    'Tăng trưởng',
  ]);
  assert.equal(sheet.rows.length, 2);
  assert.equal(sheet.rows[0][2], 'Tăng mạnh,\n"quý 1"');
  assert.deepEqual(sheet.types, ['text', 'number', 'text', 'percent']);
});

test('parseCsvText auto-detects semicolon delimiter', () => {
  const csv = 'Sản phẩm;Số lượng;Đơn giá\nLaptop;12;1500\nChuột;40;25';
  const sheet = parseCsvText(csv);
  assert.deepEqual(sheet.columns, ['Sản phẩm', 'Số lượng', 'Đơn giá']);
  assert.equal(sheet.rows[1][2], '25');
});

test('serializeCsv round-trips quoted fields and newlines', () => {
  const csv = 'Name,Note,Value\n"Alpha, Inc.","Line 1\nLine 2",42';
  const sheet = parseCsvText(csv);
  const out = serializeCsv(sheet);
  const reparsed = parseCsvText(out);
  assert.deepEqual(reparsed.rows, sheet.rows);
});

test('parseNumericValue handles formatted numbers, percentages, and currency', () => {
  assert.deepEqual(parseNumericValue('1,250.5'), {
    value: 1250.5,
    isPercent: false,
  });
  assert.deepEqual(parseNumericValue('1.250.000'), {
    value: 1250000,
    isPercent: false,
  });
  assert.deepEqual(parseNumericValue('34.5%'), {
    value: 34.5,
    isPercent: true,
  });
  assert.deepEqual(parseNumericValue('$420'), {
    value: 420,
    isPercent: false,
  });
  assert.deepEqual(parseNumericValue('Hà Nội'), {
    value: null,
    isPercent: false,
  });
});

test('computeColumnStats calculates sum, avg, min, max accurately', () => {
  const sheet = parseCsvText('Kênh,Chi phí\nAds,100\nSEO,250\nEmail,150');
  const stats = computeColumnStats(sheet, 1);
  assert.equal(stats.numericCount, 3);
  assert.equal(stats.sum, 500);
  assert.equal(Math.round(stats.avg * 100) / 100, 166.67);
  assert.equal(stats.min, 100);
  assert.equal(stats.max, 250);
});

test('filterAndSortRows and filterAndSortRowsBuffer map filtered & sorted indices accurately', () => {
  const sheet = parseCsvText(
    'Tên,Điểm,Tỷ lệ\nAn,80,10%\nBình,95,25%\nChâu,70,5%\nBảo,88,18%'
  );
  const filtered = filterAndSortRows(sheet, 'B', {
    colIndex: 1,
    direction: 'asc',
  });
  // Matches Bình (row 1, 95) and Bảo (row 3, 88) -> ascending order: [3, 1]
  assert.deepEqual(filtered, [3, 1]);

  const bufDesc = filterAndSortRowsBuffer(sheet, '', {
    colIndex: 2,
    direction: 'desc',
  });
  assert.deepEqual(Array.from(bufDesc), [1, 3, 0, 2]);
});

test('editing cells, adding/deleting rows & columns, and HistoryManager undo/redo work', () => {
  const initial = parseCsvText('Mục,Giá trị\nA,10\nB,20');
  const history = new HistoryManager(initial);

  const edited = updateSheetCell(history.current, 0, 1, '55');
  history.push(edited);
  assert.equal(history.current.rows[0][1], '55');
  assert.equal(history.canUndo, true);

  const withRow = addSheetRow(history.current);
  history.push(withRow);
  assert.equal(history.current.rows.length, 3);

  const withCol = addSheetColumn(history.current, 'Ghi chú');
  history.push(withCol);
  assert.equal(history.current.columns.length, 3);

  const withoutCol = deleteSheetColumn(history.current, 2);
  history.push(withoutCol);
  assert.equal(history.current.columns.length, 2);

  const withoutRow = deleteSheetRow(history.current, 2);
  history.push(withoutRow);
  assert.equal(history.current.rows.length, 2);

  // Undo back to edited state (4 steps: withoutRow -> withoutCol -> withCol -> withRow -> edited)
  history.undo();
  history.undo();
  history.undo();
  history.undo();
  assert.equal(history.current.rows.length, 2);
  assert.equal(history.current.rows[0][1], '55');

  history.undo();
  assert.equal(history.current.rows[0][1], '10');
  assert.equal(history.canRedo, true);
});

test('updateSheetCell preserves structural sharing for untouched rows', () => {
  const sheet = parseCsvText('ColA,ColB\n1,2\n3,4\n5,6');
  const updated = updateSheetCell(sheet, 1, 0, '99');
  assert.notEqual(updated.rows, sheet.rows);
  assert.notEqual(updated.rows[1], sheet.rows[1]);
  assert.equal(updated.rows[0], sheet.rows[0]);
  assert.equal(updated.rows[2], sheet.rows[2]);
  assert.equal(updated.rows[1][0], '99');
});

test('normalizeRecordsToSheet handles 100,000 rows x 20 columns without stack overflow', () => {
  const cols = 20;
  const rowCount = 100_000;
  const records: string[][] = new Array(rowCount + 1);
  records[0] = Array.from({length: cols}, (_, c) => `Col_${c}`);
  for (let r = 1; r <= rowCount; r++) {
    const row = new Array<string>(cols);
    row[0] = `Row ${r}`;
    for (let c = 1; c < cols; c++) {
      row[c] = String((r * c) % 1000);
    }
    records[r] = row;
  }

  const sheet = normalizeRecordsToSheet(records, 'BigSheet', 'big-1');
  assert.equal(sheet.rows.length, rowCount);
  assert.equal(sheet.columns.length, cols);
  assert.equal(sheet.types[0], 'text');
  assert.equal(sheet.types[1], 'number');

  const parsed = parseCsvRecords('a,b\n1,2\n3,4');
  assert.equal(parsed.length, 3);
});

test('virtualWindow computes row/column ranges, scroll targets, and chart sampling accurately', () => {
  const rowWin = computeRowVirtualWindow({
    totalRows: 100_000,
    scrollTop: 36 * 50_000,
    viewportHeight: 540,
    rowHeight: 36,
    overscan: 8,
  });
  assert.equal(rowWin.start, 49_992);
  assert.equal(rowWin.end, 50_023);
  assert.equal(rowWin.offsetTop, 49_992 * 36);
  assert.equal(rowWin.offsetBottom, (100_000 - 50_023) * 36);

  const nonVirtCols = computeColumnVirtualWindow({
    totalCols: 10,
    scrollLeft: 0,
    viewportWidth: 1000,
    colWidths: new Array(10).fill(140),
    fixedLeftWidth: 120,
    overscan: 2,
  });
  assert.equal(nonVirtCols.virtualized, false);
  assert.equal(nonVirtCols.start, 0);
  assert.equal(nonVirtCols.end, 10);

  const virtCols = computeColumnVirtualWindow({
    totalCols: 20,
    scrollLeft: 600,
    viewportWidth: 920,
    colWidths: new Array(20).fill(150),
    fixedLeftWidth: 120,
    overscan: 2,
  });
  assert.equal(virtCols.virtualized, true);
  assert.equal(virtCols.start, 2);
  assert.equal(virtCols.end, 12);
  assert.equal(virtCols.leftWidth, 300);
  assert.equal(virtCols.rightWidth, 8 * 150);

  const scrollTargetDown = computeScrollTopForRow({
    displayIndex: 30,
    rowHeight: 36,
    currentScrollTop: 0,
    viewportHeight: 400,
    headerHeight: 40,
  });
  assert.equal(scrollTargetDown, 31 * 36 - 360);

  const scrollInView = computeScrollTopForRow({
    displayIndex: 2,
    rowHeight: 36,
    currentScrollTop: 0,
    viewportHeight: 400,
    headerHeight: 40,
  });
  assert.equal(scrollInView, null);

  const big = new Int32Array(100_000);
  for (let i = 0; i < 100_000; i++) big[i] = i;
  const sampled = sampleChartIndices(big, 32);
  assert.equal(sampled.length, 32);
  assert.equal(sampled[0], 0);
  assert.equal(sampled[31], 99_999);
});

test('WorkbookHistoryManager commits O(1) cell patches, structural edits, undo/redo, and caps depth', () => {
  const wb = createBlankWorkbook();
  const history = new WorkbookHistoryManager(wb, 3);
  const initialRow1 = history.current.sheets[0].rows[1];

  assert.equal(history.commitCellEdit(0, 0, 'Alpha'), true);
  assert.equal(history.commitCellEdit(0, 0, 'Alpha'), false); // no-op
  assert.equal(history.current.sheets[0].rows[0][0], 'Alpha');
  assert.equal(history.current.sheets[0].rows[1], initialRow1); // structural sharing

  const undo1 = history.undo();
  assert.ok(undo1);
  assert.equal(history.current.sheets[0].rows[0][0], '');
  assert.equal(history.current.sheets[0].rows[1], initialRow1);

  const redo1 = history.redo();
  assert.ok(redo1);
  assert.equal(history.current.sheets[0].rows[0][0], 'Alpha');

  history.commitCellEdit(0, 1, 'Beta');
  history.commitCellEdit(1, 0, 'Gamma');
  history.commitSheetSnapshot(addSheetRow(history.current.sheets[0]));
  // maxDepth = 3, so oldest entry dropped
  assert.equal(history.depth, 3);
});

test('suggestChartConfig selects text X column and numeric Y columns', () => {
  const sheet = parseCsvText('Tháng,Doanh thu,Lợi nhuận\nT1,100,30\nT2,120,40');
  const cfg = suggestChartConfig(sheet);
  assert.equal(cfg.xColIndex, 0);
  assert.deepEqual(cfg.yColIndices, [1, 2]);
});

test('createBlankWorkbook creates an empty editable workbook without sample data', () => {
  const wb = createBlankWorkbook();
  assert.equal(wb.fileName, 'Untitled.xlsx');
  assert.equal(wb.fileFormat, 'blank');
  assert.equal(wb.sheets.length, 1);
  assert.deepEqual(wb.sheets[0].columns, ['Column A', 'Column B', 'Column C']);
  assert.equal(wb.sheets[0].rows.length, 6);
  assert.equal(wb.sheets[0].rows.flat().every((cell) => cell === ''), true);
});

