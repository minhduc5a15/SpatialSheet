import {test, expect} from './helpers';
import type {} from './fixtures/lifecycle';

test.beforeEach(async ({page}) => {
  await page.goto('/e2e/fixtures/lifecycle.html');
  await expect(page.locator('#grid [data-cell]')).toHaveCount(4);
});

for (const target of ['splitter', 'grid'] as const) {
  test(`${target} disposal during actual pointer capture restores styles and cancels work`, async ({page}) => {
    const handle = target === 'splitter' ? page.locator('#splitter') : page.getByRole('separator', {name: 'Resize column Value'});
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    try {
      expect(await handle.evaluate(el => el.hasPointerCapture(1))).toBe(true);
      expect(await page.evaluate(() => document.body.style.cursor)).toBe('col-resize');
      // Queue a move and dispose synchronously before the browser can deliver its RAF.
      const result = await handle.evaluate((el, component) => {
        el.dispatchEvent(new PointerEvent('pointermove', {bubbles: true, pointerId: 1, clientX: 850, clientY: 100}));
        const before = window.lifecycle.snapshot();
        window.lifecycle.dispose(component);
        return {before, after: window.lifecycle.snapshot(), captured: el.hasPointerCapture(1)};
      }, target);
      expect(result.before.pendingFrames).toBeGreaterThan(0);
      expect(result.after.pendingFrames).toBe(0);
      expect(result.captured).toBe(false);
      expect(await page.evaluate(() => [document.body.style.cursor, document.body.style.userSelect])).toEqual(['', '']);
      await handle.dispatchEvent('keydown', {key: 'ArrowRight'});
      expect(await page.evaluate(() => window.lifecycle.snapshot().actions)).toBe(result.after.actions);
    } finally {await page.mouse.up();}
  });
}

test('grid disposal closes modal; cancels frames and stale ResizeObserver delivery', async ({page}) => {
  await page.getByRole('button', {name: 'Inspect and edit full cell text'}).click();
  await expect(page.getByRole('dialog', {name: 'Full cell text viewer and editor'})).toBeVisible();
  await page.getByLabel('Full cell text editor').fill('must not commit after disposal');
  const frames = await page.evaluate(() => window.lifecycle.queueGridAndDispose());
  expect(frames.pending).toBeGreaterThan(0);
  expect(frames.after).toBe(0);
  await expect(page.getByRole('dialog', {name: 'Full cell text viewer and editor'})).toBeHidden();
  await expect(page.getByRole('dialog', {name: 'Manage spreadsheet columns'})).toBeHidden();
  const before = await page.evaluate(() => window.lifecycle.snapshot());
  expect(before.activeObservers).toBe(0);
  await page.keyboard.press('Control+Enter');
  await page.evaluate(() => window.lifecycle.deliverStaleResize());
  await page.locator('#grid [data-role="col-manager-trigger"]').click();
  expect(await page.evaluate(() => window.lifecycle.snapshot())).toEqual(before);
  await expect(page.getByRole('dialog', {name: 'Manage spreadsheet columns'})).toBeHidden();
});

test('chart disposal closes Series Manager and detaches chart actions', async ({page}) => {
  await page.locator('#chart [data-role="series-manager-trigger"]').click();
  await expect(page.getByRole('dialog', {name: 'Chart Series Manager'})).toBeVisible();
  await page.evaluate(() => window.lifecycle.dispose('chart'));
  await expect(page.getByRole('dialog', {name: 'Chart Series Manager'})).toBeHidden();
  const before = await page.evaluate(() => window.lifecycle.snapshot().actions);
  await page.getByRole('button', {name: 'Line', exact: true}).click();
  await page.locator('#chart [data-role="series-manager-trigger"]').click();
  expect(await page.evaluate(() => window.lifecycle.snapshot().actions)).toBe(before);
  await expect(page.getByRole('dialog', {name: 'Chart Series Manager'})).toBeHidden();
});

test('spatial overlay disposal closes open drawers and detaches callbacks', async ({page}) => {
  await page.locator('[data-action="toggle-spatial-config"]').click();
  await expect(page.locator('[data-role="spatial-config-drawer"]')).toBeVisible();
  await page.evaluate(() => window.lifecycle.dispose('overlay'));
  await expect(page.locator('[data-role="spatial-config-drawer"]')).toBeHidden();
  const before = await page.evaluate(() => window.lifecycle.snapshot().actions);
  await page.locator('[data-action="reset-spatial-camera"]').click();
  expect(await page.evaluate(() => window.lifecycle.snapshot().actions)).toBe(before);
  await expect(page.locator('[data-role="spatial-recs-popover"]')).toHaveCount(0);
});

test('chart disposal hides an active tooltip', async ({page}) => {
  await page.locator('#chart [data-point-row]').first().hover();
  await expect(page.locator('#chart [data-role="chart-tooltip"]')).toBeVisible();
  await page.evaluate(() => window.lifecycle.dispose('chart'));
  await expect(page.locator('#chart [data-role="chart-tooltip"]')).toBeHidden();
});


test('grid disposal closes an open Column Manager and detaches its trigger', async ({page}) => {
  const trigger = page.locator('#grid [data-role="col-manager-trigger"]');
  const manager = page.getByRole('dialog', {name: 'Manage spreadsheet columns'});
  await trigger.click();
  await expect(manager).toBeVisible();
  await page.evaluate(() => window.lifecycle.dispose('grid'));
  await expect(manager).toBeHidden();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.click();
  await expect(manager).toBeHidden();
});


test('Inspector disposal closes full text dialog and removes field actions', async ({page}) => {
  await page.evaluate(() => window.lifecycle.openInspector());
  await page.getByRole('button',{name:'View full Label',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Full field text'})).toBeVisible();
  await page.evaluate(() => window.lifecycle.dispose('inspector'));
  await expect(page.getByRole('dialog',{name:'Full field text'})).toHaveCount(0);
  await expect(page.locator('#inspector')).toBeHidden();
  await expect(page.locator('#inspector button')).toHaveCount(0);
});
