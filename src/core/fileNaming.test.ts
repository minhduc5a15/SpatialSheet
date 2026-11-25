import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';

import {
  MAX_WORKBOOK_NAME_LENGTH,
  buildExportFilename,
  deriveWorkbookNameFromFileName,
  getDefaultExportFormat,
  getWorkbookDisplayName,
  stripKnownExportExtension,
  validateExportFilename,
  validateWorkbookName,
} from './fileNaming';
import {
  createBlankWorkbook,
  parseCsvText,
  serializeCsv,
  serializeTsv,
} from './tabular';
import {buildExcelWorkbookForExport, importTabularFile} from './excelIO';
import {
  createExportBlob,
  getSaveExportOutcomeToast,
  getSavePickerFileType,
  saveExportFile,
  supportsNativeSaveFilePicker,
} from './saveFile';
import {analyzeDatasetOverview} from './dataQuality';
import {AppStore} from './store';
import type {WorkbookState} from '../types';

test('deriveWorkbookNameFromFileName and blank workbook keep clean logical names without synthetic extensions', () => {
  const blank = createBlankWorkbook();
  assert.equal(blank.name, 'Untitled');
  assert.equal(getWorkbookDisplayName(blank), 'Untitled');
  assert.equal(blank.sourceFileName, undefined);

  assert.equal(deriveWorkbookNameFromFileName('quarterly_sales.csv'), 'quarterly_sales');
  assert.equal(deriveWorkbookNameFromFileName('Benchmark.XLSX'), 'Benchmark');
  assert.equal(deriveWorkbookNameFromFileName('Q1.report.xlsx'), 'Q1.report');
  assert.equal(deriveWorkbookNameFromFileName('.hidden.csv'), '.hidden');
  assert.equal(deriveWorkbookNameFromFileName('.csv'), 'Untitled');
  assert.equal(deriveWorkbookNameFromFileName('   '), 'Untitled');
});

test('validateWorkbookName accepts Unicode & dotted names while rejecting empty, control chars, separators, dots, and >120 chars', () => {
  assert.deepEqual(validateWorkbookName('  Q4 Revenue  '), {
    ok: true,
    name: 'Q4 Revenue',
  });
  assert.deepEqual(validateWorkbookName('Bảng tính 📊'), {
    ok: true,
    name: 'Bảng tính 📊',
  });
  // Logical name retains arbitrary suffix without forcing .xlsx
  assert.deepEqual(validateWorkbookName('Q1.report'), {
    ok: true,
    name: 'Q1.report',
  });

  assert.equal(validateWorkbookName('').ok, false);
  assert.equal(validateWorkbookName('   \t ').ok, false);
  assert.equal(validateWorkbookName('.').ok, false);
  assert.equal(validateWorkbookName('..').ok, false);
  assert.equal(validateWorkbookName('a/b').ok, false);
  assert.equal(validateWorkbookName('a\\b').ok, false);
  assert.equal(validateWorkbookName('bad\x00name').ok, false);

  const exactMax = '📊'.repeat(MAX_WORKBOOK_NAME_LENGTH);
  assert.equal(validateWorkbookName(exactMax).ok, true);
  const tooLong = 'a'.repeat(MAX_WORKBOOK_NAME_LENGTH + 1);
  assert.equal(validateWorkbookName(tooLong).ok, false);
});

test('validateExportFilename & stripKnownExportExtension normalize extensions cleanly across formats and edge cases', () => {
  assert.equal(stripKnownExportExtension('sales.xlsx.xlsx'), 'sales');
  assert.equal(stripKnownExportExtension('Results.CSV'), 'Results');
  assert.equal(stripKnownExportExtension('Q1.report'), 'Q1.report');
  assert.equal(stripKnownExportExtension('.hidden'), '.hidden');

  // Duplicate extension deduplication
  assert.deepEqual(validateExportFilename('sales.xlsx.xlsx', 'xlsx'), {
    ok: true,
    baseName: 'sales',
    fileName: 'sales.xlsx',
    extension: 'xlsx',
  });

  // Case normalization
  assert.deepEqual(validateExportFilename('Results.CSV', 'csv'), {
    ok: true,
    baseName: 'Results',
    fileName: 'Results.csv',
    extension: 'csv',
  });

  // Switching extension cleanly when format changes
  assert.deepEqual(validateExportFilename('Benchmark.csv', 'xlsx'), {
    ok: true,
    baseName: 'Benchmark',
    fileName: 'Benchmark.xlsx',
    extension: 'xlsx',
  });
  assert.deepEqual(validateExportFilename('Report.xlsx', 'tsv'), {
    ok: true,
    baseName: 'Report',
    fileName: 'Report.tsv',
    extension: 'tsv',
  });

  // Arbitrary extensions & dot-prefixed stems preserved
  assert.deepEqual(validateExportFilename('Q1.report', 'xlsx'), {
    ok: true,
    baseName: 'Q1.report',
    fileName: 'Q1.report.xlsx',
    extension: 'xlsx',
  });
  assert.deepEqual(validateExportFilename('.hidden', 'csv'), {
    ok: true,
    baseName: '.hidden',
    fileName: '.hidden.csv',
    extension: 'csv',
  });

  // Sheet suffix optional and off by default
  const noSuffix = validateExportFilename('Sales', 'csv', {
    includeSheetSuffix: false,
    sheetName: 'North',
  });
  assert.deepEqual(noSuffix, {
    ok: true,
    baseName: 'Sales',
    fileName: 'Sales.csv',
    extension: 'csv',
  });
  assert.deepEqual(
    validateExportFilename('Sales', 'csv', {includeSheetSuffix: true, sheetName: 'North'}),
    {
      ok: true,
      baseName: 'Sales-North',
      fileName: 'Sales-North.csv',
      extension: 'csv',
    }
  );
  // Sheet suffix never applied to XLSX even if passed
  assert.deepEqual(
    validateExportFilename('Sales', 'xlsx', {includeSheetSuffix: true, sheetName: 'North'}),
    {
      ok: true,
      baseName: 'Sales',
      fileName: 'Sales.xlsx',
      extension: 'xlsx',
    }
  );

  // Rejections
  assert.equal(validateExportFilename('', 'xlsx').ok, false);
  assert.equal(validateExportFilename('   ', 'csv').ok, false);
  assert.equal(validateExportFilename('.csv', 'csv').ok, false);
  assert.equal(validateExportFilename('.xlsx', 'xlsx').ok, false);
  assert.equal(validateExportFilename('a/b', 'xlsx').ok, false);
  assert.equal(validateExportFilename('a:b', 'xlsx').ok, false);
  assert.equal(validateExportFilename('CON', 'csv').ok, false);
  assert.equal(validateExportFilename('nul.csv', 'csv').ok, false);
  assert.equal(validateExportFilename('x'.repeat(121), 'xlsx').ok, false);
});

test('buildExportFilename sanitizes safely and getDefaultExportFormat respects workbook state', () => {
  assert.equal(buildExportFilename('  bad/name:*?  ', 'xlsx'), 'bad name.xlsx');
  assert.equal(buildExportFilename('.csv', 'csv'), 'Untitled.csv');
  assert.equal(buildExportFilename('CON', 'csv'), 'CON_export.csv');
  assert.equal(buildExportFilename('Bảng tính 📊', 'tsv'), 'Bảng tính 📊.tsv');

  const multiSheetCsv: WorkbookState = {
    name: 'Multi',
    fileName: 'multi.csv',
    sourceFileName: 'multi.csv',
    fileFormat: 'csv',
    sheets: [
      {id: 's1', name: 'S1', columns: ['A'], rows: [['1']], types: ['number']},
      {id: 's2', name: 'S2', columns: ['B'], rows: [['2']], types: ['number']},
    ],
    activeSheetIndex: 0,
  };
  assert.equal(getDefaultExportFormat(multiSheetCsv), 'xlsx');
  assert.equal(
    getDefaultExportFormat({...multiSheetCsv, sheets: [multiSheetCsv.sheets[0]]}),
    'csv'
  );
  assert.equal(
    getDefaultExportFormat({
      ...multiSheetCsv,
      fileFormat: 'tsv',
      sheets: [multiSheetCsv.sheets[0]],
    }),
    'tsv'
  );
  assert.equal(getDefaultExportFormat(createBlankWorkbook()), 'xlsx');
});

test('TSV and Excel export preserve multiline, Unicode, leading zeros, and multi-sheet workbook structure', async () => {
  const sheet = parseCsvText(
    'Code,Region,Notes\n00123,"North, East","Line 1\nLine 2 — Bảng tính 📊"',
    'Summary',
    'sheet-0'
  );
  const tsvText = serializeTsv(sheet);
  assert.match(tsvText, /Code\tRegion\tNotes/);
  const parsedBack = parseCsvText(tsvText, 'Summary', 'sheet-0');
  assert.deepEqual(parsedBack.columns, sheet.columns);
  assert.deepEqual(parsedBack.rows, sheet.rows);

  // Confirm CSV preserves too
  const csvParsed = parseCsvText(serializeCsv(sheet), 'Summary', 'sheet-0');
  assert.deepEqual(csvParsed.rows, sheet.rows);

  // Multi-sheet XLSX export preserves all sheets & leading zero strings
  const wb: WorkbookState = {
    name: 'Quarterly Review',
    fileName: 'raw.csv',
    sourceFileName: 'raw.csv',
    fileFormat: 'csv',
    sheets: [
      sheet,
      {
        id: 'sheet-1',
        name: 'Metrics',
        columns: ['KPI', 'Target'],
        rows: [['Margin', '42.5']],
        types: ['text', 'number'],
      },
    ],
    activeSheetIndex: 0,
  };

  const xlsxWb = buildExcelWorkbookForExport(wb);
  assert.deepEqual(xlsxWb.SheetNames, ['Summary', 'Metrics']);
  const bytes = XLSX.write(xlsxWb, {bookType: 'xlsx', type: 'array'}) as ArrayBuffer;
  const decoded = XLSX.read(bytes, {type: 'array'});
  assert.deepEqual(decoded.SheetNames, ['Summary', 'Metrics']);
  const aoa0 = XLSX.utils.sheet_to_json<unknown[]>(decoded.Sheets['Summary'], {
    header: 1,
    raw: false,
  });
  assert.equal(aoa0[1]?.[0], '00123');
  assert.equal(aoa0[1]?.[2], 'Line 1\nLine 2 — Bảng tính 📊');

  // Imported file separates logical workbook name and sourceFileName
  const file = new File(['Region,Sales\nNorth,100'], 'sales_2026.csv', {
    type: 'text/csv',
  });
  const imported = await importTabularFile(file);
  assert.equal(imported.name, 'sales_2026');
  assert.equal(imported.sourceFileName, 'sales_2026.csv');
});

test('saveExportFile invokes native picker synchronously with expected filters, handles AbortError/write errors, and falls back to download', async () => {
  const wb = createBlankWorkbook();
  const sheet = wb.sheets[0];

  // Picker capability checks
  assert.equal(
    supportsNativeSaveFilePicker({
      isSecureContext: true,
      showSaveFilePicker: async () => ({createWritable: async () => ({write: async () => {}, close: async () => {}})}),
    } as unknown as Window),
    true
  );
  assert.equal(
    supportsNativeSaveFilePicker({
      isSecureContext: false,
      showSaveFilePicker: async () => ({}),
    } as unknown as Window),
    false
  );
  assert.equal(getSavePickerFileType('xlsx').accept['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']?.[0], '.xlsx');
  assert.equal(getSavePickerFileType('csv').accept['text/csv']?.[0], '.csv');
  assert.equal(getSavePickerFileType('tsv').accept['text/tab-separated-values']?.[0], '.tsv');

  // Native picker success path
  let pickerOptions: unknown = null;
  let writtenBytes = 0;
  let closed = false;
  const savedOutcome = await saveExportFile({
    workbook: wb,
    activeSheet: sheet,
    fileName: 'Board Deck.xlsx',
    format: 'xlsx',
    runtime: {
      picker: async (opts) => {
        pickerOptions = opts;
        return {
          name: 'Board Deck Final.xlsx',
          createWritable: async () => ({
            write: async (data) => {
              writtenBytes = data instanceof Blob ? data.size : 1;
            },
            close: async () => {
              closed = true;
            },
          }),
        };
      },
    },
  });
  assert.equal(savedOutcome.status, 'saved');
  assert.equal(savedOutcome.fileName, 'Board Deck Final.xlsx');
  assert.ok(writtenBytes > 0);
  assert.equal(closed, true);
  assert.deepEqual(pickerOptions, {
    suggestedName: 'Board Deck.xlsx',
    types: [getSavePickerFileType('xlsx')],
    excludeAcceptAllOption: false,
  });
  assert.deepEqual(getSaveExportOutcomeToast(savedOutcome), {
    kind: 'success',
    message: 'Saved Board Deck Final.xlsx',
  });

  // Native picker AbortError -> cancelled with null toast
  const abortOutcome = await saveExportFile({
    workbook: wb,
    activeSheet: sheet,
    fileName: 'Board Deck.csv',
    format: 'csv',
    runtime: {
      picker: async () => {
        const err = new Error('User cancelled');
        err.name = 'AbortError';
        throw err;
      },
    },
  });
  assert.equal(abortOutcome.status, 'cancelled');
  assert.equal(getSaveExportOutcomeToast(abortOutcome), null);

  // Native picker write error -> aborts writable and returns truthful error
  let abortedWritable = false;
  const writeErrOutcome = await saveExportFile({
    workbook: wb,
    activeSheet: sheet,
    fileName: 'Board Deck.csv',
    format: 'csv',
    runtime: {
      picker: async () => ({
        name: 'Board Deck.csv',
        createWritable: async () => ({
          write: async () => {
            throw new Error('Disk full');
          },
          close: async () => {},
          abort: async () => {
            abortedWritable = true;
          },
        }),
      }),
    },
  });
  assert.equal(writeErrOutcome.status, 'error');
  assert.equal(abortedWritable, true);
  assert.deepEqual(getSaveExportOutcomeToast(writeErrOutcome), {
    kind: 'error',
    message: 'Unable to export the workbook. Please try again.',
  });

  // Fallback download path
  let downloadedName = '';
  let downloadedBlob: Blob | null = null;
  const fallbackOutcome = await saveExportFile({
    workbook: wb,
    activeSheet: sheet,
    fileName: 'Snapshot.tsv',
    format: 'tsv',
    runtime: {
      picker: null,
      triggerDownload: (blob, fileName) => {
        downloadedBlob = blob;
        downloadedName = fileName;
      },
    },
  });
  assert.equal(fallbackOutcome.status, 'download-started');
  assert.equal(downloadedName, 'Snapshot.tsv');
  assert.ok(downloadedBlob && (downloadedBlob as Blob).size > 0);
  assert.deepEqual(getSaveExportOutcomeToast(fallbackOutcome), {
    kind: 'success',
    message: 'Download started: Snapshot.tsv',
  });

  const blob = createExportBlob(wb, sheet, 'csv');
  assert.ok(blob.size > 0);
});

test('AppStore.renameWorkbook supports undo/redo cleanly without corrupting sourceFileName, sheet data, or columnView state', () => {
  const initial: WorkbookState = {
    name: 'orders',
    fileName: 'orders.csv',
    sourceFileName: 'orders.csv',
    fileFormat: 'csv',
    sheets: [
      {
        id: 'sheet-0',
        name: 'Orders',
        columns: ['Region', 'Revenue', 'Cost'],
        rows: [
          ['North', '120', '40'],
          ['South', '200', '90'],
        ],
        types: ['text', 'number', 'number'],
      },
    ],
    activeSheetIndex: 0,
  };
  const store = new AppStore(initial);
  try {
    store.toggleColumnPin(1);
    const pinnedBefore = [...store.activeColumnView.pinned];
    const sheetVersionBefore = store.sheetVersion;
    const cellBefore = store.activeSheet.rows[0][1];

    // Unchanged rename is a no-op
    const noop = store.renameWorkbook('  orders  ');
    assert.deepEqual(noop, {ok: true, changed: false, name: 'orders'});
    assert.equal(store.history.canUndo, false);

    // Invalid rename rejected
    const bad = store.renameWorkbook('bad/name');
    assert.equal(bad.ok, false);
    assert.equal(getWorkbookDisplayName(store.workbook), 'orders');

    // Valid rename updates name, overview, and history while keeping source/sheet/layout intact
    const res1 = store.renameWorkbook('Executive Revenue');
    assert.deepEqual(res1, {ok: true, changed: true, name: 'Executive Revenue'});
    assert.equal(store.workbook.name, 'Executive Revenue');
    assert.equal(store.workbook.sourceFileName, 'orders.csv');
    assert.equal(store.workbook.fileFormat, 'csv');
    assert.equal(store.activeSheet.name, 'Orders');
    assert.equal(store.activeSheet.rows[0][1], cellBefore);
    assert.deepEqual(store.activeColumnView.pinned, pinnedBefore);
    assert.equal(store.sheetVersion, sheetVersionBefore);
    assert.equal(store.history.canUndo, true);

    // Overview analysis reflects logical workbookName & preserves sourceFileName separately
    const overview = analyzeDatasetOverview(
      store.workbook,
      store.activeSheet,
      store.visibleRowIndices,
      store.datasetProfile,
      store.activeColumnView
    );
    assert.equal(overview.summary.workbookName, 'Executive Revenue');
    assert.equal(overview.summary.sourceFileName, 'orders.csv');

    // Repeated rename
    const res2 = store.renameWorkbook('Board Final 📊');
    assert.deepEqual(res2, {ok: true, changed: true, name: 'Board Final 📊'});

    // Undo / Redo restores rename steps accurately
    store.undo();
    assert.equal(store.workbook.name, 'Executive Revenue');
    store.undo();
    assert.equal(store.workbook.name, 'orders');
    store.redo();
    assert.equal(store.workbook.name, 'Executive Revenue');
    store.redo();
    assert.equal(store.workbook.name, 'Board Final 📊');
  } finally {
    store.dispose();
  }
});
