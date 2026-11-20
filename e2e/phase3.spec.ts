import {test, expect, role, cell, importCsv, edit} from './helpers';

const qualityCsv = [
  'record_id,region,amount,active,created_on,constant_flag,notes',
  'ID-1,North,10,true,2024-01-02,PROD,"Detailed operational summary note for record one in January"',
  'ID-2,North,20,true,2024-02-03,PROD,"Line 1 extended description text\nLine 2 continuation detail"',
  'ID-2,South,30,false,2024-03-04,PROD,""',
  ',East,bad_val,true,not_date,PROD,"Another thorough field observation recorded during audit four"',
  'ID-5,,50,false,2024-05-06,PROD,"Complete narrative comment capturing context for entry five"',
  'ID-6,West,60,true,2024-06-07,PROD,"Extended annotation describing regional validation check six"',
  'ID-7,North,70,false,2024-07-08,PROD,"Follow-up commentary detailing verification steps for row seven"',
  'ID-8,South,80,true,2024-08-09,PROD,"Concluding audit note documenting final approval step eight"',
  'ID-9,East,90,false,2024-09-10,PROD,"Supplementary reference commentary explaining baseline ninth row"',
].join('\n');

test('Overview auto-enters only on file import, not on New Sheet, edits, or undo', async ({page}) => {
  await page.goto('/');
  await expect(role(page, 'overview-host')).toBeHidden();
  await expect(role(page, 'grid-host')).toBeVisible();

  await role(page, 'file-input').setInputFiles({
    name: 'generated.csv', mimeType: 'text/csv', buffer: Buffer.from(qualityCsv),
  });
  await expect(role(page, 'file-meta')).toContainText('9 rows · 7 cols');
  await expect(role(page, 'loading-status')).toBeHidden();
  await expect(role(page, 'overview-host')).toBeVisible();
  await expect(role(page, 'grid-host')).toBeHidden();
  await expect(role(page, 'overview-header')).toContainText('generated.csv');
  await expect(role(page, 'overview-summary')).toContainText('3'); // row 4 ID + row 5 region + row 3 notes = 3
  await expect(role(page, 'overview-container')).not.toContainText(/\b\d+(?:\.\d+)?\s*(?:Bytes|KB|MB|GB)\b|Confidence score|Quality score/i);
  await expect(page.locator('canvas')).toHaveCount(1);

  // Edits & Undo in Split stay in Split
  await page.getByRole('button', {name: 'Explore in Split', exact: true}).click();
  await expect(role(page, 'overview-host')).toBeHidden();
  await expect(role(page, 'grid-host')).toBeVisible();
  await edit(page, 'B1', 'West');
  await expect(role(page, 'overview-host')).toBeHidden();
  await page.getByRole('button', {name: 'Undo', exact: true}).click();
  await expect(role(page, 'overview-host')).toBeHidden();

  // New Sheet returns to non-overview workspace
  await page.getByRole('button', {name: 'Overview', exact: true}).click();
  await expect(role(page, 'overview-host')).toBeVisible();
  await page.getByRole('button', {name: 'New Sheet', exact: true}).click();
  await expect(role(page, 'overview-host')).toBeHidden();
  await expect(role(page, 'grid-host')).toBeVisible();
});

test('Direct spatial startup preserves 3D mode after file import', async ({page}) => {
  await page.goto('/?mode=spatial');
  await role(page, 'file-input').setInputFiles({
    name: 'spatial.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(qualityCsv),
  });
  await expect(role(page, 'file-meta')).toContainText('spatial.csv');
  await expect(role(page, 'overview-host')).toBeHidden();
  await expect(role(page, 'xr-canvas')).toBeVisible();
});

test('Semantic filter chips, catalog sort, column detail, role override, focus hidden col, and axis/series actions', async ({page}) => {
  await importCsv(page, qualityCsv, 9, 7);
  const overview = role(page, 'overview-host');

  // Filter via semantic legend chip
  await overview.locator('[data-role-chip="categorical"]').click();
  await expect(overview.locator('[data-overview-col]')).toHaveCount(2); // region & constant_flag
  await overview.locator('[data-role-chip="all"]').click();
  await expect(overview.locator('[data-overview-col]')).toHaveCount(7);

  // Select amount column (col 2) and inspect numeric quartiles
  const catalog = role(page, 'overview-catalog-list');
  await catalog.locator('[data-overview-select-col="2"]').click();
  const detail = role(page, 'overview-column-detail');
  await expect(detail).toContainText('amount');
  await expect(detail).toContainText('Min');
  await expect(detail).toContainText('Q1');
  await expect(detail).toContainText('Median');
  await expect(detail).toContainText('Mean');
  await expect(detail).toContainText('Q3');
  await expect(detail).toContainText('Max');

  // Search catalog & sort by missing
  await page.getByLabel('Sort columns').selectOption('missing');
  const firstColAttr = await overview.locator('[data-overview-col]').first().getAttribute('data-overview-col');
  expect(['0', '1', '6']).toContain(firstColAttr);

  // Override role on 'region' (col 1) -> Y Series gating disables non-numeric roles, switches detail stats cleanly
  await catalog.locator('[data-overview-select-col="1"]').click();
  await expect(detail.locator('[data-overview-use-y]')).toBeDisabled();
  await page.getByLabel('Role Override').selectOption('text');
  await expect(detail).toContainText('Text Profile');
  await page.getByLabel('Role Override').selectOption('auto');
  await expect(detail).toContainText('Top Category Frequencies');

  // Hide col 1 in Table, return to Overview, verify Unhide & Focus in Table restores it
  await page.getByRole('button', {name: 'Table', exact: true}).click();
  await role(page, 'col-manager-trigger').click();
  await page.getByRole('button', {name: 'Hide column region', exact: true}).click();
  await page.keyboard.press('Escape');
  await expect(cell(page, 'B1')).toHaveCount(0);

  await page.getByRole('button', {name: 'Overview', exact: true}).click();
  await catalog.locator('[data-overview-select-col="1"]').click();
  await expect(overview.locator('[data-overview-col="1"]')).toContainText('Hidden');
  await detail.getByRole('button', {name: /Unhide & Focus in Table/}).click();
  await expect(role(page, 'grid-host')).toBeVisible();
  await expect(cell(page, 'B1')).toBeVisible();

  // Use as X Axis and Use as Y Series from Overview
  await page.getByRole('button', {name: 'Overview', exact: true}).click();
  await catalog.locator('[data-overview-select-col="1"]').click();
  await detail.getByRole('button', {name: 'Use as X Axis', exact: true}).click();
  await expect(role(page, 'chart2d-host')).toBeVisible();
  await expect(page.getByLabel('Select X-axis column')).toHaveValue('1');

  await page.getByRole('button', {name: 'Overview', exact: true}).click();
  await catalog.locator('[data-overview-select-col="2"]').click();
  await detail.getByRole('button', {name: 'Use as Y Series', exact: true}).click();
  await expect(role(page, 'chart2d-host')).toBeVisible();
  await expect(role(page, 'chart-legend')).toContainText('amount');
});

test('Data Quality observations explain issues, jump to affected cells, and dismiss/restore cleanly', async ({page}) => {
  await importCsv(page, qualityCsv, 9, 7);
  const quality = role(page, 'overview-quality');

  await expect(quality).toContainText('Potential numeric type inconsistency in "amount"');
  await expect(quality).toContainText('Constant column "constant_flag"');
  await expect(quality).toContainText('Duplicate identifiers in "record_id"');
  await expect(quality).toContainText('Missing ID values in "record_id"');

  // Dismiss an observation and restore
  const typeObs = quality.locator('[data-quality-id="type:2"]');
  await expect(typeObs).toBeVisible();
  await typeObs.getByRole('button', {name: /Dismiss/}).click();
  await expect(typeObs).toHaveCount(0);
  await expect(quality.getByRole('button', {name: 'Restore dismissed (1)', exact: true})).toBeVisible();
  await quality.getByRole('button', {name: 'Restore dismissed (1)', exact: true}).click();
  await expect(typeObs).toBeVisible();

  // Jump to first affected cell in amount ('bad_val' at row 4, col C)
  await typeObs.getByRole('button', {name: 'Jump to first affected cell', exact: true}).click();
  await expect(role(page, 'grid-host')).toBeVisible();
  await expect(page.getByLabel('Selected cell', {exact: true})).toHaveText('C4');
  await expect(cell(page, 'C4')).toHaveText('bad_val');
});

test('Suggested Analyses apply into Charts/3D XR, bottom ascending summary is truthful, and Excel export intact', async ({page}) => {
  const rows = [
    'Date,Category,Revenue,Profit',
    '2024-01-01,Zeta,10,4',
    '2024-02-01,Beta,50,18',
    '2024-03-01,Alpha,30,11',
    '2024-04-01,Gamma,90,32',
  ].join('\n');
  await importCsv(page, rows, 4, 4);

  const suggestions = role(page, 'overview-suggestions');
  await expect(suggestions).toContainText('2D');
  await expect(suggestions).toContainText('3D');

  // Apply first 2D suggestion in Charts, then verify categorical bottom ascending vs top descending copy
  await suggestions.getByRole('button', {name: 'Open in Charts', exact: true}).first().click();
  await expect(role(page, 'chart2d-host')).toBeVisible();
  await page.getByRole('button', {name: 'Bar', exact: true}).click();
  await page.getByLabel('Select X-axis column').selectOption('1');
  await page.getByLabel('Chart aggregation', {exact: true}).selectOption('avg');
  await page.getByLabel('Chart sort order', {exact: true}).selectOption('value-asc');
  await expect(role(page, 'chart-display-summary')).toContainText('by ascending primary aggregate');
  await page.getByLabel('Chart sort order', {exact: true}).selectOption('value-desc');
  await expect(role(page, 'chart-display-summary')).toContainText('by descending primary aggregate');

  // Apply 3D suggestion and export Excel to verify raw data unchanged
  await page.getByRole('button', {name: 'Overview', exact: true}).click();
  await suggestions.getByRole('button', {name: 'Open in 3D Stage', exact: true}).first().click();
  await expect(role(page, 'xr-canvas')).toBeVisible();

  const pending = page.waitForEvent('download');
  await page.getByRole('button', {name: 'Export Excel', exact: true}).click();
  const stream = await (await pending).createReadStream();
  const chunks: Buffer[] = [];
  for await (const c of stream!) chunks.push(Buffer.from(c));
  const XLSX = await import('xlsx');
  const wb = XLSX.read(Buffer.concat(chunks), {type: 'buffer'});
  const outRows = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[wb.SheetNames[0]], {header: 1, raw: false});
  expect(outRows[0]).toEqual(['Date', 'Category', 'Revenue', 'Profit']);
  expect(outRows).toHaveLength(5);
});

test('Opt-in Inspector auto-open stays non-stealing, pauses on dismiss across arrow/undo nav, and resumes on manual toggle', async ({page}) => {
  await importCsv(page, qualityCsv, 9, 7);
  await page.getByRole('button', {name: 'Split', exact: true}).click();
  const inspector = role(page, 'data-inspector');
  const autoOpen = page.locator('[data-action="auto-open-inspector"]');

  await expect(autoOpen).not.toBeChecked();
  await cell(page, 'A1').click();
  await expect(inspector).toBeHidden();

  // Enable Auto-open -> pointer click opens Inspector without stealing focus from grid cell
  await autoOpen.check();
  await cell(page, 'B2').click();
  await expect(inspector).toBeVisible();
  await expect(cell(page, 'B2')).toBeFocused();

  // Close Inspector -> pause auto-open for subsequent keyboard nav & clicks
  await inspector.getByRole('button', {name: 'Close Inspector', exact: true}).click();
  await expect(inspector).toBeHidden();
  await cell(page, 'B2').focus();
  await page.keyboard.press('ArrowDown');
  await expect(inspector).toBeHidden();

  // Another explicit pointer click stays paused while user dismissed it
  await cell(page, 'C1').click();
  await expect(inspector).toBeHidden();

  // Manual Inspect data button re-arms auto-open on later interactions
  await page.getByRole('button', {name: 'Inspect data', exact: true}).click();
  await expect(inspector).toBeVisible();
  await inspector.getByRole('button', {name: 'Close Inspector', exact: true}).click();
  await autoOpen.uncheck();
  await autoOpen.check();
  await role(page, 'chart-canvas-wrap').locator('[data-point-row]').first().click();
  await expect(inspector).toBeVisible();
});

test('Inspector preserves search, hide-empty, page offset, and live Full field text on same-record edits/undo; resets on delete/change', async ({page}) => {
  const longA = 'Line one\n  Line two\n' + 'extra long token '.repeat(18);
  const longB = 'Updated line\n  Second line\n' + 'modified token '.repeat(18);
  const wideCols = Array.from({length: 25}, (_, i) => (i === 0 ? 'Group' : i === 1 ? 'LongField' : `Col_${i}`));
  const wideRow1 = wideCols.map((_, i) => (i === 0 ? 'A' : i === 1 ? longA : `v_${i}`));
  const wideRow2 = wideCols.map((_, i) => (i === 0 ? 'B' : i === 1 ? 'Short' : `w_${i}`));
  const wideCsv = [wideCols.join(','), wideRow1.map((v) => `"${v.replace(/"/g, '""')}"`).join(','), wideRow2.join(',')].join('\n');

  await importCsv(page, wideCsv, 2, 25);
  await page.getByRole('button', {name: 'Split', exact: true}).click();
  await page.getByRole('button', {name: 'Inspect data', exact: true}).click();

  const inspector = role(page, 'data-inspector');
  await edit(page, 'B1', longB);
  await cell(page, 'B1').click();

  // Open Full field text dialog and verify live update on Undo & Redo
  await inspector.getByRole('button', {name: 'View full LongField', exact: true}).click();
  const dialog = page.getByRole('dialog', {name: 'Full field text'});
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('pre')).toContainText('Updated line');
  await page.keyboard.press('Control+z');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('pre')).toContainText('Line one');
  await page.keyboard.press('Control+y');
  await expect(dialog.locator('pre')).toContainText('Updated line');
  await dialog.getByRole('button', {name: 'Close full text', exact: true}).click();

  // Select bottom row B2 so committing B2 keeps B2 selected; verify search, hide-empty, and page offset persist across edit + undo
  await cell(page, 'B2').click();
  await inspector.getByLabel('Hide empty values').check();
  await inspector.getByLabel('Search record fields').fill('Col_');
  await inspector.getByRole('button', {name: 'Next fields', exact: true}).click();
  await expect(inspector).toContainText('Col_22');

  await edit(page, 'B2', 'Third edit');
  await expect(inspector.getByLabel('Search record fields')).toHaveValue('Col_');
  await expect(inspector.getByLabel('Hide empty values')).toBeChecked();
  await expect(inspector).toContainText('Col_22');

  await page.getByRole('button', {name: 'Undo', exact: true}).click();
  await expect(inspector.getByLabel('Search record fields')).toHaveValue('Col_');
  await expect(inspector.getByLabel('Hide empty values')).toBeChecked();
  await expect(inspector).toContainText('Col_22');

  // Selecting another row resets pagination offset on new record
  await inspector.getByLabel('Search record fields').fill('');
  await cell(page, 'B1').click();
  await expect(inspector).toContainText('LongField');

  // Deleting inspected row clears selection cleanly
  await page.locator('tr[data-row-index="0"]').hover();
  await page.getByRole('button', {name: 'Delete row 1', exact: true}).click();
  await expect(inspector.getByRole('heading', {name: 'No data selected', exact: true})).toBeVisible();
});

test('Overview responds across Desktop (1440x900), Tablet (900x800), Mobile (390x844) with zero horizontal overflow and single canvas', async ({page}) => {
  await importCsv(page, qualityCsv, 9, 7);

  for (const vp of [
    {width: 1440, height: 900},
    {width: 900, height: 800},
    {width: 390, height: 844},
  ]) {
    await page.setViewportSize(vp);
    await expect(role(page, 'overview-host')).toBeVisible();
    await expect(page.locator('canvas')).toHaveCount(1);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow, `Viewport ${vp.width}x${vp.height} horizontal overflow`).toBeLessThanOrEqual(1);
  }
});
