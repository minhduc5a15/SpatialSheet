import {test as base, expect, type Page, type Locator} from '@playwright/test';
import {fileURLToPath} from 'node:url';

export const test = base.extend<{browserErrors: string[]}>({
  browserErrors: [async ({page}, use, testInfo) => {
    // Fonts are cosmetic and remote; use the application's system fallback in CI.
    await page.route('https://fonts.googleapis.com/**', route => route.fulfill({contentType: 'text/css', body: ''}));
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(`pageerror: ${error.stack ?? error.message}`));
    page.on('console', message => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });
    await use(errors);
    if (errors.length || testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('browser-errors', {body: JSON.stringify(errors, null, 2), contentType: 'application/json'});
    }
    expect(errors, 'No browser console errors or uncaught exceptions').toEqual([]);
  }, {auto: true}],
});
export {expect};
export const role = (page: Page, name: string) => page.locator(`[data-role="${name}"]`);
export const cell = (page: Page, ref: string) => page.getByRole('button', {name: `Cell ${ref}`, exact: true});
export async function importFixture(page: Page, name = 'identity.csv', rows = 2, cols = 4) {
  await page.goto('/');
  await role(page, 'file-input').setInputFiles(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
  await expect(role(page, 'file-meta')).toContainText(`${rows} rows · ${cols} cols`);
  await expect(role(page, 'loading-status')).toBeHidden();
}
export async function importCsv(page: Page, csv: string, rows: number, cols: number) {
  await page.goto('/');
  await role(page, 'file-input').setInputFiles({name: 'generated.csv', mimeType: 'text/csv', buffer: Buffer.from(csv)});
  await expect(role(page, 'file-meta')).toContainText(`${rows.toLocaleString('en-US')} rows · ${cols} cols`);
  await expect(role(page, 'loading-status')).toBeHidden();
}
export async function drag(page: Page, handle: Locator, dx: number) {
  let box: Awaited<ReturnType<Locator['boundingBox']>> = null;
  // Virtualized headers can be replaced between locator resolution and geometry retrieval.
  await expect.poll(async () => {box = await handle.boundingBox(); return box;}).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  try { await page.mouse.move(box!.x + box!.width / 2 + dx, box!.y + box!.height / 2, {steps: 8}); }
  finally { await page.mouse.up(); }
}
export async function configureColumns(page: Page) {
  await page.getByRole('button', {name: 'Table', exact: true}).click();
  await role(page, 'col-manager-trigger').click();
  const manager = page.getByRole('dialog', {name: 'Manage spreadsheet columns'});
  await manager.getByRole('button', {name: 'Pin column C to left', exact: true}).click();
  await manager.getByRole('button', {name: 'Hide column B', exact: true}).click();
  await manager.getByRole('button', {name: 'Move column D left', exact: true}).click();
  await page.keyboard.press('Escape');
  await drag(page, page.getByRole('separator', {name: 'Resize column C', exact: true}), 70);
  await expect(cell(page, 'C1')).toHaveText('c1');
  await expect(cell(page, 'B1')).toHaveCount(0);
  await expect(page.locator('tr[data-row-index="0"] [data-cell]')).toHaveText(['c1', 'd1', 'a1']);
}
export async function edit(page: Page, ref: string, value: string, key = 'Enter') {
  await cell(page, ref).dblclick();
  const input = page.getByRole('textbox', {name: `Edit cell ${ref}`, exact: true});
  await input.fill(value);
  await input.press(key);
}
export async function exportCsv(page: Page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', {name: 'Export CSV', exact: true}).click();
  const stream = await (await pending).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trimEnd();
}
