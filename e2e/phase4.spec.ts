import {test, expect, role, cell, importCsv, edit} from './helpers';

const sampleCsv = [
  'Region,Category,Revenue,Orders,Notes',
  'North,Hardware,1200,12,Quarterly enterprise renewal',
  'South,Software,850,8,Mid-market expansion',
  'East,Services,430,5,Onboarding package',
  'West,Hardware,980,10,Multi-year contract',
].join('\n');

test('Command Palette opens via Ctrl+K, searches/executes contextual and dynamic column commands, shows disabled reasons, and restores focus', async ({page}) => {
  await importCsv(page, sampleCsv, 4, 5);
  await page.getByRole('button', {name: 'Split', exact: true}).click();

  // Select cell A1 (Region - non-numeric categorical column)
  await cell(page, 'A1').click();
  await expect(cell(page, 'A1')).toBeFocused();

  // Open via Ctrl+K
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', {name: 'Command Palette'});
  const input = palette.getByRole('combobox', {name: 'Search commands, columns, sheets, and actions'});
  await expect(palette).toBeVisible();
  await expect(input).toBeFocused();
  await expect(palette.locator('[data-role="command-palette-context"]')).toContainText('Cell A1 (Region)');

  // Typing '?' inside the palette search input must type '?' and NOT open Shortcuts Help
  await page.keyboard.type('?');
  await expect(input).toHaveValue('?');
  await expect(page.getByRole('dialog', {name: 'Keyboard Shortcuts'})).toHaveCount(0);
  await expect(palette.locator('[data-role="command-palette-empty"]')).toBeVisible();
  await palette.locator('[data-palette-empty-clear]').click();
  await expect(input).toHaveValue('');

  // Attempt disabled contextual command: Use Region as Chart Y Series -> stays open & notifies
  await input.fill('Use Region (A) as Chart Y Series');
  const disabledOpt = palette.locator('[role="option"][data-cmd-id="context.col.useY"]');
  await expect(disabledOpt).toBeVisible();
  await expect(disabledOpt).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Enter');
  await expect(palette).toBeVisible();
  await expect(role(page, 'toast-live-polite')).not.toHaveText('');

  // Escape closes palette and restores focus to cell A1
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();
  await expect(cell(page, 'A1')).toBeFocused();

  // Open Column Manager via Command Palette -> focus stays inside Column Manager (not stolen back)
  await page.locator('[data-action="open-command-palette"]').click();
  await expect(palette).toBeVisible();
  await input.fill('Open Column Manager');
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
  const colManager = page.getByRole('dialog', {name: 'Manage spreadsheet columns'});
  await expect(colManager).toBeVisible();
  await expect(colManager.getByLabel('Filter columns by name or letter')).toBeFocused();

  // Hide Revenue column, close Column Manager, then reveal & focus it via Command Palette
  await colManager.getByRole('button', {name: 'Hide column Revenue', exact: true}).click();
  await page.keyboard.press('Escape');
  await expect(colManager).toBeHidden();
  await expect(cell(page, 'C1')).toHaveCount(0);

  await page.keyboard.press('Control+k');
  await input.fill('Focus Column: Revenue');
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
  await expect(cell(page, 'C1')).toBeVisible();
  await expect(cell(page, 'C1')).toBeFocused();
});

test('Keyboard Shortcuts Help opens on ? outside inputs, traps Tab, restores focus, and ignores ? inside inputs', async ({page}) => {
  await importCsv(page, sampleCsv, 4, 5);
  await page.getByRole('button', {name: 'Split', exact: true}).click();

  // Typing '?' inside search input enters '?' literally and does not open dialog
  const searchInput = role(page, 'search-input');
  await searchInput.click();
  await page.keyboard.type('?');
  await expect(searchInput).toHaveValue('?');
  const helpDialog = page.getByRole('dialog', {name: 'Keyboard Shortcuts'});
  await expect(helpDialog).toBeHidden();
  await searchInput.fill('');

  // Typing '?' while inline editing a cell must not open Shortcuts Help; Escape cancels edit cleanly
  await cell(page, 'A1').dblclick();
  const cellEditor = page.getByRole('textbox', {name: 'Edit cell A1', exact: true});
  await cellEditor.fill('North?');
  await expect(helpDialog).toBeHidden();
  await cellEditor.press('Escape');
  await expect(cell(page, 'A1')).toHaveText('North');

  // Focusing a non-text cell button and pressing '?' opens Keyboard Shortcuts Help
  await cell(page, 'B1').focus();
  await page.keyboard.press('?');
  await expect(helpDialog).toBeVisible();
  await expect(helpDialog).toContainText('Global Workspace');
  await expect(helpDialog).toContainText('Spreadsheet Grid');
  await expect(helpDialog.getByRole('button', {name: 'Close keyboard shortcuts help'})).toBeFocused();

  // Escape closes Help and restores focus to cell B1
  await page.keyboard.press('Escape');
  await expect(helpDialog).toBeHidden();
  await expect(cell(page, 'B1')).toBeFocused();

  // Opening Help from Command Palette footer button and closing restores focus to cell B1
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', {name: 'Command Palette'});
  await palette.locator('[data-action="palette-open-shortcuts"]').click();
  await expect(palette).toBeHidden();
  await expect(helpDialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(helpDialog).toBeHidden();
  await expect(cell(page, 'B1')).toBeFocused();
});

test('Global Ctrl+F, Ctrl+Z, Ctrl+Shift+Z shortcuts work and ToastManager keeps a bounded slot pool across repeated cycles', async ({page}) => {
  await importCsv(page, sampleCsv, 4, 5);
  await page.getByRole('button', {name: 'Split', exact: true}).click();

  const toastContainer = role(page, 'toast-container');
  const toastSlots = toastContainer.locator('[data-toast-slot]');
  await expect(role(page, 'toast-live-polite')).toHaveCount(1);
  await expect(role(page, 'toast-live-assertive')).toHaveCount(1);
  await expect(toastSlots).toHaveCount(3);
  await expect(toastContainer.locator('> *')).toHaveCount(5);

  // Dismiss any visible import toast cleanly
  for (let i = 0; i < 3; i++) {
    const closeBtn = page.locator(`[data-toast-close="${i}"]`);
    if (await closeBtn.isVisible()) await closeBtn.click();
  }
  await expect(toastContainer.locator('[data-toast-slot]:visible')).toHaveCount(0);

  // Ctrl+F focuses search input
  await cell(page, 'A1').click();
  await page.keyboard.press('Control+f');
  await expect(role(page, 'search-input')).toBeFocused();

  // Edit cell then Undo via Ctrl+Z and Redo via Ctrl+Shift+Z, verifying toasts + bounded slot pool
  await edit(page, 'C1', '9999');
  await expect(cell(page, 'C1')).toHaveText('9999');

  await cell(page, 'C1').focus();
  await page.keyboard.press('Control+z');
  await expect(cell(page, 'C1')).toHaveText('1200');
  await expect(page.locator('[data-toast-slot="0"]')).toBeVisible();
  await expect(page.locator('[data-toast-slot="0"]')).toContainText('Undid last change');
  await expect(role(page, 'toast-live-polite')).toContainText('Undid last change');
  await expect(toastSlots).toHaveCount(3);
  await expect(toastContainer.locator('> *')).toHaveCount(5);

  await page.keyboard.press('Control+Shift+z');
  await expect(cell(page, 'C1')).toHaveText('9999');
  await expect(role(page, 'toast-live-polite')).toContainText('Redid change');
  await expect(toastSlots).toHaveCount(3);
  await expect(toastContainer.locator('> *')).toHaveCount(5);

  // Exercise repeated show/dismiss/recycle cycles across all 3 slots (> MAX_SLOTS)
  const settledToastNodes = await toastContainer.locator('*').count();
  for (let cycle = 0; cycle < 4; cycle++) {
    await page.keyboard.press('Control+z');
    await expect(cell(page, 'C1')).toHaveText('1200');
    await page.keyboard.press('Control+Shift+z');
    await expect(cell(page, 'C1')).toHaveText('9999');
    await expect(toastSlots).toHaveCount(3);
    await expect(toastContainer.locator('> *')).toHaveCount(5);
    const activeCount = await toastContainer.locator('[data-toast-slot]:visible').count();
    expect(activeCount).toBeLessThanOrEqual(3);
  }

  for (let i = 0; i < 3; i++) {
    const closeBtn = page.locator(`[data-toast-close="${i}"]`);
    if (await closeBtn.isVisible()) await closeBtn.click();
  }
  await expect(toastContainer.locator('[data-toast-slot]:visible')).toHaveCount(0);
  await expect(toastSlots).toHaveCount(3);
  await expect(toastContainer.locator('> *')).toHaveCount(5);
  await expect(toastContainer.locator('*')).toHaveCount(settledToastNodes);
});

test('Empty chart series and empty filter states offer clear recovery actions', async ({page}) => {
  await importCsv(page, sampleCsv, 4, 5);
  await page.getByRole('button', {name: 'Split', exact: true}).click();

  // Clear chart series -> actionable Choose series button opens Series Manager
  await role(page, 'series-manager-trigger').click();
  const seriesMgr = page.getByRole('dialog', {name: 'Chart Series Manager'});
  await seriesMgr.getByRole('button', {name: 'Clear', exact: true}).click();
  await page.keyboard.press('Escape');
  await expect(role(page, 'chart-empty-selection')).toBeVisible();
  await page.locator('[data-empty-chart="open-series"]').click();
  await expect(seriesMgr).toBeVisible();
  await seriesMgr.getByRole('button', {name: 'Recommended', exact: true}).click();
  await page.keyboard.press('Escape');

  await expect(role(page, 'chart-empty-selection')).toHaveCount(0);
  await expect(role(page, 'series-manager-trigger')).toContainText('Series (2)');
  await expect(role(page, 'chart-legend')).toContainText('Revenue');
  await expect(role(page, 'chart-legend')).toContainText('Orders');
  const svg = role(page, 'chart-canvas-wrap').locator('svg');
  await expect(svg).toHaveCount(1);
  await expect(svg.locator('[data-point-row]')).toHaveCount(8);
  await expect(svg.locator('[data-point-row]').first()).toHaveAttribute('data-tip-sub', 'Revenue: 1,200');

  // Non-matching table search -> Clear filter button restores rows
  const searchInput = role(page, 'search-input');
  await searchInput.fill('__no_such_value_xyz__');
  await expect(page.getByRole('button', {name: 'Clear filter', exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'Clear filter', exact: true}).click();
  await expect(searchInput).toHaveValue('');
  await expect(cell(page, 'A1')).toHaveText('North');
});

test('Command Palette and Shortcuts Help respond cleanly across Desktop (1280x800), Tablet (900x800), and Mobile (390x844)', async ({page}) => {
  await importCsv(page, sampleCsv, 4, 5);
  await page.getByRole('button', {name: 'Split', exact: true}).click();

  for (const vp of [
    {width: 1280, height: 800},
    {width: 900, height: 800},
    {width: 390, height: 844},
  ]) {
    await page.setViewportSize(vp);

    // Document has no horizontal overflow
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow, `Viewport ${vp.width}x${vp.height} horizontal overflow`).toBeLessThanOrEqual(1);

    // Palette fits inside viewport, input & list work, keyboard nav + Tab trap + close button stay accessible
    await page.locator('[data-action="open-command-palette"]').click();
    const palette = page.getByRole('dialog', {name: 'Command Palette'});
    await expect(palette).toBeVisible();
    const pBox = (await palette.boundingBox())!;
    expect(pBox.x).toBeGreaterThanOrEqual(0);
    expect(pBox.width).toBeGreaterThanOrEqual(Math.min(340, vp.width - 32));
    expect(pBox.x + pBox.width).toBeLessThanOrEqual(vp.width + 1);
    expect(pBox.y + pBox.height).toBeLessThanOrEqual(vp.height + 1);

    const paletteInput = palette.getByRole('combobox', {name: 'Search commands, columns, sheets, and actions'});
    await expect(paletteInput).toBeVisible();
    await expect(paletteInput).toBeFocused();
    const inputBox = (await paletteInput.boundingBox())!;
    expect(inputBox.x + inputBox.width).toBeLessThanOrEqual(pBox.x + pBox.width + 1);

    const listEl = role(page, 'command-palette-list');
    await expect(listEl).toBeVisible();
    const listBox = (await listEl.boundingBox())!;
    expect(listBox.y + listBox.height).toBeLessThanOrEqual(pBox.y + pBox.height + 1);
    const listScrollable = await listEl.evaluate((el) => el.scrollHeight > el.clientHeight);
    expect(listScrollable).toBe(true);

    const initialActive = await paletteInput.getAttribute('aria-activedescendant');
    await page.keyboard.press('ArrowDown');
    const nextActive = await paletteInput.getAttribute('aria-activedescendant');
    expect(nextActive).not.toBe(initialActive);

    // Tab focus remains trapped inside Command Palette
    await page.keyboard.press('Tab');
    const focusInsidePalette = await page.evaluate(() =>
      Boolean(document.activeElement?.closest('[data-role="command-palette-dialog"]'))
    );
    expect(focusInsidePalette).toBe(true);

    const closePaletteBtn = palette.getByRole('button', {name: 'Close Command Palette', exact: true});
    await expect(closePaletteBtn).toBeVisible();
    const closePBox = (await closePaletteBtn.boundingBox())!;
    expect(closePBox.x + closePBox.width).toBeLessThanOrEqual(vp.width + 1);
    await closePaletteBtn.click();
    await expect(palette).toBeHidden();

    // Shortcuts Help fits inside viewport with accessible close button and zero internal horizontal overflow
    await page.locator('[data-action="open-shortcuts-help"]').click();
    const help = page.getByRole('dialog', {name: 'Keyboard Shortcuts'});
    await expect(help).toBeVisible();
    const hBox = (await help.boundingBox())!;
    expect(hBox.x).toBeGreaterThanOrEqual(0);
    expect(hBox.x + hBox.width).toBeLessThanOrEqual(vp.width + 1);
    expect(hBox.y + hBox.height).toBeLessThanOrEqual(vp.height + 1);

    const closeHelpBtn = help.getByRole('button', {name: 'Close keyboard shortcuts help', exact: true});
    await expect(closeHelpBtn).toBeVisible();
    await closeHelpBtn.click();
    await expect(help).toBeHidden();
  }
});
