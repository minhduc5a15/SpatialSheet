import {test, expect, role, cell, importFixture, importCsv, configureColumns, edit, exportCsv, drag} from './helpers';
import {datasetCsv} from './fixtures/datasets';

test('startup imports Unicode, quoted multiline fields, and completes worker loading', async ({page}) => {
  await importFixture(page, 'unicode.csv', 2, 3);
  await page.getByRole('button', {name: 'Split', exact: true}).click();
  expect(page.workers().some(worker => worker.url().includes('dataWorker'))).toBe(true);
  await expect(cell(page, 'A1')).toHaveText('Nguyễn');
  await expect(cell(page, 'A2')).toHaveText('東京');
  await cell(page, 'B1').click();
  await page.getByRole('button', {name: 'Inspect and edit full cell text'}).click();
  await expect(page.getByLabel('Full cell text editor')).toHaveValue('First line\nSecond line, with comma');
  await page.getByRole('button', {name: 'Close full text viewer'}).click();
  await expect(cell(page, 'C2')).toHaveText('25');
  const exported = await exportCsv(page);
  expect(exported).toContain('"He said ""hello"" 🌍"');
  expect(exported).toContain('"First line\nSecond line, with comma"');
});

test('split pointer resizing, bounds, reset, preset persistence preserve selection and chart', async ({page}) => {
  await importCsv(page, datasetCsv(), 100, 37);
  await page.getByRole('button', {name: 'Split', exact: true}).click();
  await cell(page, 'C1').click();
  await page.getByLabel('Chart aggregation', {exact: true}).selectOption('sum');
  const divider = page.getByRole('separator', {name: 'Resize spreadsheet and chart panes'});
  const grid = role(page, 'grid-host');
  const viz = role(page, 'viz-host');
  await expect(grid).toBeVisible();
  await expect(role(page, 'chart2d-host')).toBeVisible();
  const beforeGrid = (await grid.boundingBox())!.width;
  const beforeViz = (await viz.boundingBox())!.width;
  await drag(page, divider, -120);
  await expect.poll(async () => (await grid.boundingBox())!.width).toBeLessThan(beforeGrid - 80);
  expect((await viz.boundingBox())!.width).toBeGreaterThan(beforeViz + 80);
  for (const dx of [-2000, 2000]) {
    await drag(page, divider, dx);
    expect((await grid.boundingBox())!.width).toBeGreaterThanOrEqual(300);
    expect((await viz.boundingBox())!.width).toBeGreaterThanOrEqual(300);
  }
  await divider.dblclick({position: {x: 7, y: 200}});
  await expect(divider).toHaveAttribute('aria-valuenow', '55');
  await expect(page.getByLabel('Selected cell', {exact: true})).toHaveText('C1');
  await expect(page.getByLabel('Chart aggregation', {exact: true})).toHaveValue('sum');
  await divider.hover();
  await page.getByRole('button', {name: 'Set split ratio 30/70'}).click();
  await expect(divider).toHaveAttribute('aria-valuenow', '30');
  await page.reload();
  await expect(divider).toHaveAttribute('aria-valuenow', '30');
});

test('visual column preferences persist and preserve source edit, history, and CSV identity', async ({page}) => {
  await importFixture(page);
  await configureColumns(page);
  await edit(page, 'D1', 'edited D');
  await expect(cell(page, 'D1')).toHaveText('edited D');
  await expect(cell(page, 'A1')).toHaveText('a1');
  await expect(cell(page, 'C1')).toHaveText('c1');
  await page.getByRole('button', {name: 'Undo', exact: true}).click();
  await expect(cell(page, 'D1')).toHaveText('d1');
  await page.getByRole('button', {name: 'Redo', exact: true}).click();
  await expect(cell(page, 'D1')).toHaveText('edited D');
  expect(await exportCsv(page)).toBe('A,B,C,D\na1,b1,c1,edited D\na2,b2,c2,d2');
  const savedWidth = await page.locator('col[data-col-idx="2"]').getAttribute('style');
  await importFixture(page); // New document, same workbook identity; view preferences persist.
  await page.getByRole('button', {name: 'Table', exact: true}).click();
  await expect(page.locator('tr[data-row-index="0"] [data-cell]')).toHaveText(['c1', 'd1', 'a1']);
  await expect(page.locator('td[data-sticky-col="2"]').first()).toContainText('c1');
  await expect(page.locator('col[data-col-idx="2"]')).toHaveAttribute('style', savedWidth!);

});

test('structural delete and history reconcile activeColumnView metadata by source identity', async ({page}) => {
  await importFixture(page);
  await configureColumns(page);
  const widthC = await page.locator('col[data-col-idx="2"]').evaluate(el => (el as HTMLElement).style.width);
  await drag(page, page.getByRole('separator', {name: 'Resize column D', exact: true}), 40);
  const widthD = await page.locator('col[data-col-idx="3"]').evaluate(el => (el as HTMLElement).style.width);
  await role(page, 'col-manager-trigger').click();
  await page.getByRole('dialog', {name: 'Manage spreadsheet columns'}).getByRole('button', {name: 'Delete column B', exact: true}).click();
  await page.keyboard.press('Escape');
  for (let step = 0; step < 3; step++) {
    await expect(role(page, 'file-meta')).toContainText('3 cols');
    await expect(page.locator('tr[data-row-index="0"] [data-cell]')).toHaveText(['c1', 'd1', 'a1']);
    await expect(page.locator('tr[data-row-index="1"] [data-cell]')).toHaveText(['c2', 'd2', 'a2']);
    await expect(page.locator('td[data-sticky-col="1"]').first()).toContainText('c1');
    await expect(page.locator('col[data-col-idx="1"]')).toHaveAttribute('style', `width:${widthC}`);
    await expect(page.locator('col[data-col-idx="2"]')).toHaveAttribute('style', `width:${widthD}`);
    expect(await exportCsv(page)).toBe('A,C,D\na1,c1,d1\na2,c2,d2');
    await page.getByRole('button', {name: 'Undo', exact: true}).click();
    await expect(role(page, 'file-meta')).toContainText('4 cols');
    await expect(cell(page, 'B1')).toHaveCount(0); // restored hidden preference
    expect(await exportCsv(page)).toBe('A,B,C,D\na1,b1,c1,d1\na2,b2,c2,d2');
    await page.getByRole('button', {name: 'Redo', exact: true}).click();
  }
});

test('keyboard follows visible order across pinned boundary and commits/cancels source cells', async ({page}) => {
  await importFixture(page);
  await configureColumns(page);
  await cell(page, 'C1').click();
  await page.keyboard.press('ArrowRight');
  await expect(cell(page, 'D1')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(cell(page, 'A1')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(cell(page, 'D1')).toBeFocused();
  await edit(page, 'D1', 'tab edit', 'Tab');
  await expect(cell(page, 'A1')).toBeFocused();
  await edit(page, 'A1', 'enter edit', 'Enter');
  await expect(cell(page, 'A2')).toBeFocused();
  await edit(page, 'C1', 'cancelled', 'Escape');
  await expect(cell(page, 'C1')).toHaveText('c1');
  expect(await exportCsv(page)).toBe('A,B,C,D\nenter edit,b1,c1,tab edit\na2,b2,c2,d2');
});

test('horizontal keyboard navigation scrolls the focused source cell into view', async ({page}) => {
  await importCsv(page, datasetCsv(), 100, 37);
  await page.getByRole('button', {name: 'Split', exact: true}).click();
  await cell(page, 'A1').click();
  for (let c = 0; c < 20; c++) await page.keyboard.press('ArrowRight');
  await expect(cell(page, 'U1')).toBeFocused();
  const box = (await cell(page, 'U1').boundingBox())!;
  const viewport = (await role(page, 'table-container').boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(viewport.x);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.x + viewport.width + 1);
  expect(await role(page, 'table-container').evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
});

test('37-column Series Manager search, presets, semantic gating, and rendered values', async ({page}) => {
  await importCsv(page, datasetCsv(), 100, 37);
  await page.getByRole('button', {name: 'Charts', exact: true}).click();
  await page.getByLabel('Select X-axis column').selectOption('0');
  await page.getByRole('button', {name: 'Bar', exact: true}).click();
  const controls = role(page, 'chart-controls');
  const height = (await controls.boundingBox())!.height;
  await role(page, 'series-manager-trigger').click();
  const manager = page.getByRole('dialog', {name: 'Chart Series Manager'});
  await manager.getByRole('button', {name: 'Clear', exact: true}).click();
  await expect(role(page, 'chart-empty-selection')).toBeVisible();
  await page.getByLabel('Search chart series').fill('metric_12');
  await expect(manager.locator('[data-series-col]')).toHaveCount(1);
  await manager.locator('[data-series-col="13"]').check();
  await page.getByLabel('Search chart series').fill('metric_13');
  await manager.locator('[data-series-col="14"]').check();
  await expect(role(page, 'series-manager-trigger')).toHaveText('Series (2)');
  await expect(role(page, 'chart-legend')).toContainText('metric_12');
  await expect(role(page, 'chart-legend')).toContainText('metric_13');
  await expect(page.locator('[data-point-row="0"][data-tip-sub="metric_12: 34"]')).toHaveCount(1);
  await page.getByLabel('Search chart series').fill('');
  await expect(manager.locator('[data-series-col="0"]')).toBeDisabled();
  await expect(manager.locator('[data-series-col="1"]')).toBeDisabled();
  await manager.getByRole('button', {name: 'First 5', exact: true}).click();
  await expect(manager.locator('[data-series-col]:checked')).toHaveCount(5);
  await expect(role(page, 'chart-legend')).toContainText('metric_5');
  await expect(role(page, 'chart-legend')).not.toContainText('metric_12');
  await manager.getByRole('button', {name: 'Clear', exact: true}).click();
  await expect(manager.locator('[data-series-col]:checked')).toHaveCount(0);
  await manager.getByRole('button', {name: 'Recommended', exact: true}).click();
  await expect(manager.locator('[data-series-col]:checked')).toHaveCount(2);
  await expect(manager.locator('[data-series-col="2"]')).toBeChecked();
  await expect(manager.locator('[data-series-col="3"]')).toBeChecked();
  await page.keyboard.press('Escape');
  expect((await controls.boundingBox())!.height).toBe(height);
  expect(height).toBeLessThan(150);
});

test('Table, Split, Charts, and normal-browser 3D transitions retain configuration', async ({page}) => {
  await importCsv(page, datasetCsv(), 100, 37);
  await page.getByRole('button', {name: 'Split', exact: true}).click();
  await cell(page, 'C1').click();
  await page.getByLabel('Chart aggregation', {exact: true}).selectOption('sum');
  for (const mode of ['Table', 'Split', 'Charts', '3D XR', 'Split']) {
    await page.getByRole('button', {name: mode, exact: true}).click();
    if (mode === 'Table' || mode === 'Split') await expect(role(page, 'grid-host')).toBeVisible();
    else await expect(role(page, 'grid-host')).toBeHidden();
    if (mode === 'Table') await expect(role(page, 'viz-host')).toBeHidden();
    else await expect(role(page, 'viz-host')).toBeVisible();
    if (mode === 'Charts') await expect(role(page, 'chart2d-host')).toBeVisible();
    if (mode === '3D XR') {
      await expect(role(page, 'chart2d-host')).toBeHidden();
      await expect(role(page, 'xr-canvas')).toBeVisible();
      await expect(role(page, 'spatial-footer')).not.toHaveText('');
      const rendering = await role(page, 'xr-canvas').evaluate(el => {
        const canvas = el as HTMLCanvasElement;
        const gl = canvas.getContext('webgl2');
        return {width: canvas.width, height: canvas.height, context: !!gl, lost: gl?.isContextLost()};
      });
      expect(rendering.context).toBe(true);
      expect(rendering.lost).toBe(false);
      expect(rendering.width).toBeGreaterThan(0);
      expect(rendering.height).toBeGreaterThan(0);
    }
    await expect(role(page, 'xr-canvas')).toHaveCount(1);
    await expect(page.locator('canvas')).toHaveCount(1);
  }
  await page.getByRole('button', {name: '2D Charts', exact: true}).click();
  await expect(page.getByLabel('Selected cell', {exact: true})).toHaveText('C1');
  await expect(page.getByLabel('Chart aggregation', {exact: true})).toHaveValue('sum');
  await expect(role(page, 'chart-canvas-wrap').locator('svg')).toHaveCount(1);
  await expect(page.getByRole('separator', {name: 'Resize spreadsheet and chart panes'})).toBeVisible();
});

test('repeated managers, split drags, modes, and column resizing remain responsive and bounded', async ({page}) => {
  await importCsv(page, datasetCsv(), 100, 37);
  await page.getByRole('button', {name: 'Split', exact: true}).click();
  let settledNodes: number | undefined;
  for (let i = 0; i < 5; i++) {
    await role(page, 'col-manager-trigger').click();
    await expect(page.getByRole('dialog', {name: 'Manage spreadsheet columns'})).toBeVisible();
    await page.keyboard.press('Escape');
    await role(page, 'series-manager-trigger').click();
    await expect(page.getByRole('dialog', {name: 'Chart Series Manager'})).toBeVisible();
    await page.keyboard.press('Escape');
    await drag(page, page.getByRole('separator', {name: 'Resize spreadsheet and chart panes'}), i % 2 ? -25 : 25);
    await drag(page, page.getByRole('separator', {name: 'Resize column sample_id', exact: true}), i % 2 ? -10 : 10);
    await page.getByRole('button', {name: 'Charts', exact: true}).click();
    await page.getByRole('button', {name: 'Split', exact: true}).click();
    await expect(role(page, 'col-manager-trigger')).toHaveAttribute('aria-expanded', 'false');
    await expect(role(page, 'series-manager-trigger')).toHaveAttribute('aria-expanded', 'false');
    await expect(role(page, 'chart-canvas-wrap').locator('svg')).toHaveCount(1);
    await expect(role(page, 'xr-canvas')).toHaveCount(1);
    await expect(page.locator('canvas')).toHaveCount(1);
    await page.getByRole('separator', {name: 'Resize spreadsheet and chart panes'}).dblclick({position: {x: 7, y: 200}});
    await page.getByRole('separator', {name: 'Resize column sample_id', exact: true}).dblclick();
    await expect(page.locator('[data-col-manager-row]')).toHaveCount(37);
    await expect(page.locator('[data-series-col]')).toHaveCount(37);
    const nodes = await page.locator('*').count();
    if (settledNodes !== undefined) expect(nodes).toBe(settledNodes);
    settledNodes = nodes;
  }
  await edit(page, 'A1', 'one action');
  await page.getByRole('button', {name: 'Undo', exact: true}).click();
  await expect(cell(page, 'A1')).toHaveText('ID-000001');
  await expect(page.getByRole('button', {name: 'Undo', exact: true})).toBeDisabled();
  expect(await page.evaluate(() => [document.body.style.cursor, document.body.style.userSelect])).toEqual(['', '']);
});
