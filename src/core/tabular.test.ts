import assert from 'node:assert/strict';
import test from 'node:test';
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
  parseCsvText,
  parseNumericValue,
  serializeCsv,
  suggestChartConfig,
  updateSheetCell,
} from './tabular';

test('columnIndexToLetter maps Excel-style columns', () => {
  assert.equal(columnIndexToLetter(0), 'A');
  assert.equal(columnIndexToLetter(25), 'Z');
  assert.equal(columnIndexToLetter(26), 'AA');
});

test('parseCsvText handles UTF-8 BOM, Vietnamese text, and quoted commas', () => {
  const csv = [
    '\uFEFFKhu vực,Doanh thu,"Ghi chú, chi tiết",Tăng trưởng',
    '"Hà Nội",1250,"Tăng mạnh, quý 1",18.5%',
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
  assert.equal(sheet.rows[0][2], 'Tăng mạnh, quý 1');
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

test('filterAndSortRows maps filtered & sorted indices back to original rows', () => {
  const sheet = parseCsvText(
    'Tên,Điểm\nAn,80\nBình,95\nChâu,70\nBảo,88'
  );
  const filtered = filterAndSortRows(sheet, 'B', {
    colIndex: 1,
    direction: 'asc',
  });
  // Matches Bình (row 1, 95) and Bảo (row 3, 88) -> ascending order: [3, 1]
  assert.deepEqual(filtered, [3, 1]);
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
