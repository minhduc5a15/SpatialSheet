import * as XLSX from 'xlsx';
import {test, expect, role, cell, importCsv, edit} from './helpers';

const multiColCsv = [
  'Code,Region,Revenue,Notes',
  '00123,North,1200,"Line 1',
  'Line 2 — Bảng tính 📊"',
  '00456,South,850,Steady growth',
].join('\n');

test('Blank workbook displays Untitled without .xlsx and supports inline rename, validation, Unicode, and undo/redo without corrupting sheet or column layout', async ({
  page,
}) => {
  await page.goto('/');

  // Blank workbook shows "Untitled" cleanly without ".xlsx"
  const titleTrigger = role(page, 'workbook-title-trigger');
  await expect(titleTrigger).toContainText('Untitled');
  await expect(titleTrigger).not.toContainText('.xlsx');
  await expect(role(page, 'file-meta')).toContainText('Untitled ·');
  await expect(role(page, 'file-meta')).not.toContainText('.xlsx');

  // Import CSV + configure column pin + edit a cell
  await importCsv(page, multiColCsv, 2, 4);
  await page.getByRole('button', {name: 'Split', exact: true}).click();
  await expect(titleTrigger).toContainText('generated');

  await role(page, 'col-manager-trigger').click();
  const colManager = page.getByRole('dialog', {
    name: 'Manage spreadsheet columns',
  });
  await colManager
    .getByRole('button', {name: 'Pin column Region to left', exact: true})
    .click();
  await page.keyboard.press('Escape');
  await edit(page, 'C1', '1999');
  await expect(cell(page, 'C1')).toHaveText('1999');

  // Open inline rename, test Escape cancellation preserves previous name & restores focus
  await titleTrigger.click();
  const titleInput = role(page, 'workbook-title-input');
  await expect(titleInput).toBeFocused();
  await titleInput.fill('Should Be Cancelled');
  await titleInput.press('Escape');
  await expect(titleTrigger).toBeFocused();
  await expect(titleTrigger).toContainText('generated');

  // Re-open inline rename, test validation errors (empty, slash, >120 chars)
  await titleTrigger.click();
  await titleInput.fill('   ');
  await titleInput.press('Enter');
  await expect(titleInput).toHaveAttribute('aria-invalid', 'true');
  await expect(role(page, 'workbook-title-error')).toBeVisible();

  await titleInput.fill('bad/name');
  await titleInput.press('Enter');
  await expect(titleInput).toHaveAttribute('aria-invalid', 'true');

  await titleInput.fill('x'.repeat(121));
  await titleInput.press('Enter');
  await expect(titleInput).toHaveAttribute('aria-invalid', 'true');

  // Valid Unicode name commits cleanly without appending .xlsx
  await titleInput.fill('Bảng tính 📊 2026');
  await titleInput.press('Enter');
  await expect(titleTrigger).toBeFocused();
  await expect(titleTrigger).toContainText('Bảng tính 📊 2026');
  await expect(titleTrigger).not.toContainText('.xlsx');
  await expect(role(page, 'file-meta')).toContainText('Bảng tính 📊 2026');
  await expect(role(page, 'file-meta')).toContainText('Source: generated.csv');

  // Repeated rename
  await titleTrigger.click();
  await titleInput.fill('Executive Summary');
  await page.locator('[data-action="workbook-rename-confirm"]').click();
  await expect(titleTrigger).toContainText('Executive Summary');

  // Verify Overview updates logical name while keeping source filename separate
  await page.getByRole('button', {name: 'Overview', exact: true}).click();
  await expect(role(page, 'overview-workbook-name')).toHaveText(
    'Executive Summary'
  );
  await expect(role(page, 'overview-header')).toContainText(
    'Source: generated.csv'
  );

  // Return to Split and confirm cell data + pinned column layout remain intact
  await page.getByRole('button', {name: 'Split', exact: true}).click();
  await expect(cell(page, 'C1')).toHaveText('1999');
  await expect(page.locator('th[data-sticky-col="1"]')).toContainText('Region');

  // Undo / Redo workbook renames via keyboard without breaking cell edits
  await cell(page, 'A1').click();
  await page.keyboard.press('Control+z');
  await expect(titleTrigger).toContainText('Bảng tính 📊 2026');
  await page.keyboard.press('Control+z');
  await expect(titleTrigger).toContainText('generated');
  await page.keyboard.press('Control+Shift+z');
  await expect(titleTrigger).toContainText('Bảng tính 📊 2026');
  await expect(cell(page, 'C1')).toHaveText('1999');
});

test('Save As exports multi-sheet XLSX and CSV/TSV with custom filename normalization, optional sheet suffix, and exact content preservation', async ({
  page,
}) => {
  await page.addInitScript(() => {
    delete (window as unknown as {showSaveFilePicker?: unknown})
      .showSaveFilePicker;
  });

  await importCsv(page, multiColCsv, 2, 4);
  await page.getByRole('button', {name: 'Split', exact: true}).click();

  // Add second sheet with data
  await page.locator('[data-action="add-sheet"]').click();
  await edit(page, 'A1', 'SecondSheetCell');

  // Switch back to first sheet and open Save As via Ctrl+Shift+S
  await page.locator('[data-sheet-tab="0"]').click();
  await cell(page, 'A1').click();
  await page.keyboard.press('Control+Shift+s');

  const dialog = role(page, 'save-as-dialog');
  const filenameInput = role(page, 'save-as-filename');
  const formatSelect = role(page, 'save-as-format');
  const preview = role(page, 'save-as-preview');
  const scopeText = role(page, 'save-as-scope');
  const suffixCheckbox = role(page, 'save-as-sheet-suffix');

  await expect(dialog).toBeVisible();
  await expect(filenameInput).toBeFocused();
  // Multi-sheet workbook defaults to Excel (.xlsx)
  await expect(formatSelect).toHaveValue('xlsx');
  await expect(scopeText).toContainText('Entire workbook (2 sheets)');
  await expect(preview).toHaveText('generated.xlsx');

  // Edge cases in preview & normalization
  await filenameInput.fill('sales.xlsx.xlsx');
  await expect(preview).toHaveText('sales.xlsx');

  await filenameInput.fill('Q1.report');
  await expect(preview).toHaveText('Q1.report.xlsx');

  await filenameInput.fill('Benchmark.csv');
  await expect(preview).toHaveText('Benchmark.xlsx');

  // Validation error blocks invalid name
  await filenameInput.fill('bad:file');
  await page.locator('[data-action="save-as-submit"]').click();
  await expect(filenameInput).toHaveAttribute('aria-invalid', 'true');
  await expect(role(page, 'save-as-error')).toBeVisible();
  await expect(dialog).toBeVisible();

  // Export multi-sheet XLSX with custom name
  await filenameInput.fill('Board Review 📊');
  await expect(preview).toHaveText('Board Review 📊.xlsx');
  const xlsxDownloadPromise = page.waitForEvent('download');
  await page.locator('[data-action="save-as-submit"]').click();
  const xlsxDownload = await xlsxDownloadPromise;
  expect(xlsxDownload.suggestedFilename()).toBe('Board Review 📊.xlsx');
  await expect(dialog).toBeHidden();
  await expect(role(page, 'toast-live-polite')).toContainText(
    'Download started: Board Review 📊.xlsx'
  );

  // Decode exported XLSX bytes to verify all sheets + leading zeros + multiline Unicode
  const stream = await xlsxDownload.createReadStream();
  const chunks: Buffer[] = [];
  for await (const c of stream!) chunks.push(Buffer.from(c));
  const decodedWb = XLSX.read(Buffer.concat(chunks), {type: 'buffer'});
  expect(decodedWb.SheetNames).toEqual(['generated', 'Sheet 2']);
  const s1Rows = XLSX.utils.sheet_to_json<unknown[]>(
    decodedWb.Sheets['generated'],
    {header: 1, raw: false}
  );
  expect(s1Rows[1]?.[0]).toBe('00123');
  expect(s1Rows[1]?.[3]).toBe('Line 1\nLine 2 — Bảng tính 📊');
  const s2Rows = XLSX.utils.sheet_to_json<unknown[]>(
    decodedWb.Sheets['Sheet 2'],
    {header: 1, raw: false}
  );
  expect(s2Rows[1]?.[0]).toBe('SecondSheetCell');

  // Re-open Save As and verify CSV without sheet suffix by default + optional sheet suffix toggle
  await page.locator('[data-action="save-as"]').click();
  await expect(dialog).toBeVisible();
  await formatSelect.selectOption('csv');
  await expect(scopeText).toContainText('Active sheet "generated" only');
  await expect(suffixCheckbox).not.toBeChecked();

  await filenameInput.fill('Results.CSV');
  await expect(preview).toHaveText('Results.csv');

  await suffixCheckbox.check();
  await expect(preview).toHaveText('Results-generated.csv');

  await suffixCheckbox.uncheck();
  await filenameInput.fill('.hidden');
  await expect(preview).toHaveText('.hidden.csv');

  await filenameInput.fill('CleanExport');
  const csvDownloadPromise = page.waitForEvent('download');
  await page.locator('[data-action="save-as-submit"]').click();
  const csvDownload = await csvDownloadPromise;
  expect(csvDownload.suggestedFilename()).toBe('CleanExport.csv');
});

test('Native showSaveFilePicker path reports saved status, handles AbortError silently, and reports write errors truthfully', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const state = {
      mode: 'success' as 'success' | 'abort' | 'error',
      lastOptions: null as unknown,
      lastWrittenText: '',
      closed: false,
    };
    (window as unknown as {__pickerMock: typeof state}).__pickerMock = state;
    (
      window as unknown as {
        showSaveFilePicker: (opts: unknown) => Promise<unknown>;
      }
    ).showSaveFilePicker = async (opts: unknown) => {
      state.lastOptions = opts;
      if (state.mode === 'abort') {
        const err = new Error('The user aborted a request.');
        err.name = 'AbortError';
        throw err;
      }
      return {
        name: 'ChosenByOS.xlsx',
        createWritable: async () => ({
          write: async (blob: Blob) => {
            if (state.mode === 'error') {
              throw new Error('Write failure');
            }
            state.lastWrittenText = String(blob.size);
          },
          close: async () => {
            state.closed = true;
          },
          abort: async () => {},
        }),
      };
    };
  });

  await importCsv(page, multiColCsv, 2, 4);
  await page.getByRole('button', {name: 'Split', exact: true}).click();

  // 1. Cancel (AbortError) -> dialog remains open with cancel notice, no error toast
  await page.evaluate(() => {
    (window as unknown as {__pickerMock: {mode: string}}).__pickerMock.mode =
      'abort';
  });
  await page.locator('[data-action="save-as"]').click();
  const dialog = role(page, 'save-as-dialog');
  await expect(dialog).toBeVisible();
  await page.locator('[data-action="save-as-submit"]').click();
  await expect(dialog).toBeVisible();
  await expect(role(page, 'save-as-cancel-note')).toBeVisible();
  await expect(role(page, 'toast-live-assertive')).toHaveText('');

  // 2. Write failure -> truthful error toast
  await page.evaluate(() => {
    (window as unknown as {__pickerMock: {mode: string}}).__pickerMock.mode =
      'error';
  });
  await page.locator('[data-action="save-as-submit"]').click();
  await expect(role(page, 'toast-live-assertive')).toContainText(
    'Unable to export the workbook. Please try again.'
  );

  // 3. Success -> closes dialog, reports Saved ChosenByOS.xlsx, verifies suggestedName & types
  await page.evaluate(() => {
    (window as unknown as {__pickerMock: {mode: string}}).__pickerMock.mode =
      'success';
  });
  await role(page, 'save-as-format').selectOption('xlsx');
  await role(page, 'save-as-filename').fill('My Report');
  await page.locator('[data-action="save-as-submit"]').click();
  await expect(dialog).toBeHidden();
  await expect(role(page, 'toast-live-polite')).toContainText(
    'Saved ChosenByOS.xlsx'
  );

  const pickerState = await page.evaluate(
    () =>
      (
        window as unknown as {
          __pickerMock: {
            lastOptions: {
              suggestedName?: string;
              types?: Array<{accept: Record<string, string[]>}>;
            };
            lastWrittenText: string;
            closed: boolean;
          };
        }
      ).__pickerMock
  );
  expect(pickerState.lastOptions.suggestedName).toBe('My Report.xlsx');
  expect(
    Object.values(pickerState.lastOptions.types?.[0]?.accept ?? {})[0]
  ).toEqual(['.xlsx']);
  expect(Number(pickerState.lastWrittenText)).toBeGreaterThan(0);
  expect(pickerState.closed).toBe(true);
});

test('Command Palette workbook commands, Ctrl+Shift+S guard inside inputs, focus restoration, and responsive desktop/mobile header fit', async ({
  page,
}) => {
  await page.setViewportSize({width: 1440, height: 900});
  await importCsv(page, multiColCsv, 2, 4);
  await page.getByRole('button', {name: 'Split', exact: true}).click();

  // Ctrl+Shift+S is ignored while typing inside search input
  const searchInput = role(page, 'search-input');
  await searchInput.click();
  await page.keyboard.press('Control+Shift+s');
  await expect(role(page, 'save-as-dialog')).toBeHidden();

  // Focus cell B1, launch Save As from Command Palette -> Esc restores focus back to B1
  await cell(page, 'B1').click();
  await expect(cell(page, 'B1')).toBeFocused();
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', {name: 'Command Palette'});
  await expect(palette).toBeVisible();
  const cmdInput = palette.getByRole('combobox', {
    name: 'Search commands, columns, sheets, and actions',
  });
  await cmdInput.fill('Save As');
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
  await expect(role(page, 'save-as-dialog')).toBeVisible();
  await expect(role(page, 'save-as-filename')).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(role(page, 'save-as-dialog')).toBeHidden();
  await expect(cell(page, 'B1')).toBeFocused();

  // Launch Rename Workbook from Command Palette
  await page.keyboard.press('Control+k');
  await cmdInput.fill('Rename Workbook');
  await page.keyboard.press('Enter');
  await expect(role(page, 'workbook-title-input')).toBeFocused();
  await role(page, 'workbook-title-input').fill('Palette Renamed');
  await role(page, 'workbook-title-input').press('Enter');
  await expect(role(page, 'workbook-title-trigger')).toContainText(
    'Palette Renamed'
  );

  // Desktop horizontal overflow check
  const desktopOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth
  );
  expect(desktopOverflow).toBe(false);

  // Mobile responsive check (390x844): title, inline edit, and Save As dialog fit with 0 overflow
  await page.setViewportSize({width: 390, height: 844});
  await expect(role(page, 'workbook-title-trigger')).toBeVisible();
  await expect(page.locator('[data-action="save-as"]')).toBeVisible();

  await role(page, 'workbook-title-trigger').click();
  await expect(role(page, 'workbook-title-input')).toBeVisible();
  const mobileEditingOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth
  );
  expect(mobileEditingOverflow).toBe(false);
  await role(page, 'workbook-title-input').press('Escape');

  await page.locator('[data-action="save-as"]').click();
  await expect(role(page, 'save-as-dialog')).toBeVisible();
  const dialogBox = await role(page, 'save-as-dialog').boundingBox();
  expect(dialogBox).not.toBeNull();
  expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
  expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(390);
  const mobileDialogOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth
  );
  expect(mobileDialogOverflow).toBe(false);
});
