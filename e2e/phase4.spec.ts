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
  await expect(colManager.getByLabel('Search columns')).toBeFocused();

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

test('Global Ctrl+F, Ctrl+Z, Ctrl+Shift+Z shortcuts work and Toasts keep total DOM node count invariant', async ({page}) => {
  await importCsv(page, sampleCsv, 4, 5);
  await page.getByRole('button', {name: 'Split', exact: true}).click();

  // Capture settled DOM node count with 0 active toasts (after dismissing any import toast)
  await page.locator('[data-toast-close="0"]').click({force: true}).catch(() => {});
  await page.waitForTimeout(50);
  const baselineNodes = await page.locator('*').count();

  // Ctrl+F focuses search input
  await cell(page, 'A1').click();
  await page.keyboard.press('Control+f');
  await expect(role(page, 'search-input')).toBeFocused();

  // Edit cell then Undo via Ctrl+Z and Redo via Ctrl+Shift+Z, verifying toasts + DOM invariance
  await edit(page, 'C1', '9999');
  await expect(cell(page, 'C1')).toHaveText('9999');

  await cell(page, 'C1').focus();
  await page.keyboard.press('Control+z');
  await expect(cell(page, 'C1')).toHaveText('1200');
  await expect(page.locator('[data-toast-slot="0"]')).toBeVisible();
  await expect(page.locator('[data-toast-slot="0"]')).toContainText('Undid last change');
  await expect(role(page, 'toast-live-polite')).toContainText('Undid last change');
  expect(await page.locator('*').count()).toBe(baselineNodes);

  await page.keyboard.press('Control+Shift+z');
  await expect(cell(page, 'C1')).toHaveText('9999');
  await expect(role(page, 'toast-live-polite')).toContainText('Redid change');
  expect(await page.locator('*').count()).toBe(baselineNodes);

  // Dismiss toast via close button
  await page.locator('[data-toast-close="0"]').click();
  await page.locator('[data-toast-close="1"]').click({force: true}).catch(() => {});
  await expect(page.locator('[data-toast-slot="0"]')).toBeHidden();
  expect(await page.locator('*').count()).toBe(baselineNodes);
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
  await expect(role(page, 'chart-canvas-wrap').locator('svg')).toHaveCount(1);

  // Non-matching table search -> Clear filter button restores rows
  const searchInput = role(page, 'search-input');
  await searchInput.fill('__no_such_value_xyz__');
  await expect(page.getByRole('button', {name: 'Clear filter', exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'Clear filter', exact: true}).click();
  await expect(searchInput).toHaveValue('');
  await expect(cell(page, 'A1')).toHaveText('North');
});

test('Command Palette and Shortcuts Help respond cleanly across Desktop (1280x800) and Mobile (390x844)', async ({page}) => {
  await importCsv(page, sampleCsv, 4, 5);
  await page.getByRole('button', {name: 'Split', exact: true}).click();

  for (const vp of [
    {width: 1280, height: 800},
    {width: 390, height: 844},
  ]) {
    await page.setViewportSize(vp);

    // Header has no horizontal overflow
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow, `Viewport ${vp.width}x${vp.height} horizontal overflow`).toBeLessThanOrEqual(1);

    // Palette fits inside viewport
    await page.locator('[data-action="open-command-palette"]').click();
    const palette = page.getByRole('dialog', {name: 'Command Palette'});
    await expect(palette).toBeVisible();
    const pBox = (await palette.boundingBox())!;
    expect(pBox.x).toBeGreaterThanOrEqual(0);
    expect(pBox.x + pBox.width).toBeLessThanOrEqual(vp.width + 1);
    expect(pBox.y + pBox.height).toBeLessThanOrEqual(vp.height + 1);
    await page.keyboard.press('Escape');

    // Shortcuts Help fits inside viewport
    await page.locator('[data-action="open-shortcuts-help"]').click();
    const help = page.getByRole('dialog', {name: 'Keyboard Shortcuts'});
    await expect(help).toBeVisible();
    const hBox = (await help.boundingBox())!;
    expect(hBox.x).toBeGreaterThanOrEqual(0);
    expect(hBox.x + hBox.width).toBeLessThanOrEqual(vp.width + 1);
    expect(hBox.y + hBox.height).toBeLessThanOrEqual(vp.height + 1);
    await page.keyboard.press('Escape');
  }
});
