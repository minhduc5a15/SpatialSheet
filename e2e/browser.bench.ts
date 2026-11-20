import {test, expect, role, drag} from './helpers';
import {datasetCsv} from './fixtures/datasets';
import {cpus, platform, release} from 'node:os';

for (const [rows, cols] of [[100, 37], [3000, 40], ...(process.env.SPATIALSHEET_HEAVY ? [[100_000, 100]] : [])]) {
  test(`browser measurements ${rows}x${cols}`, async ({page, browser}, testInfo) => {
    const csv = datasetCsv(rows, cols);
    await page.addInitScript(() => {
      const longTasks: number[] = [];
      (window as unknown as {longTasks: number[]}).longTasks = longTasks;
      if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
        new PerformanceObserver(list => list.getEntries().forEach(entry => longTasks.push(entry.duration))).observe({type: 'longtask', buffered: true});
      }
    });
    const renderStart = performance.now();
    await page.goto('/');
    await expect(role(page, 'col-manager-trigger')).toBeVisible();
    const initialRenderMs = performance.now() - renderStart;
    const importStart = performance.now();
    await role(page, 'file-input').setInputFiles({name: 'benchmark.csv', mimeType: 'text/csv', buffer: Buffer.from(csv)});
    await expect(role(page, 'file-meta')).toContainText(`${rows.toLocaleString('en-US')} rows · ${cols} cols`, {timeout: 120_000});
    await expect(role(page, 'loading-status')).toBeHidden();
    await expect(page.locator('[data-cell="0:0"]')).toBeVisible();
    const csvImportMs = performance.now() - importStart;
    const paint = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const table = role(page, 'table-container');
    const latencies: Record<string, number[]> = {verticalScrollMs: [], horizontalScrollMs: [], columnResizeMs: [], splitDragMs: []};
    for (let i = 0; i < 5; i++) {
      for (const [name, dx, dy] of [['verticalScrollMs', 0, 250], ['horizontalScrollMs', 250, 0]] as const) {
        await table.hover();
        const before = await table.evaluate(el => ({x: el.scrollLeft, y: el.scrollTop}));
        const start = performance.now();
        await page.mouse.wheel(dx, dy);
        await expect.poll(() => table.evaluate((el, horizontal) => horizontal ? el.scrollLeft : el.scrollTop, dx > 0)).toBeGreaterThan(dx ? before.x : before.y);
        await paint();
        latencies[name].push(performance.now() - start);
      }
      await table.evaluate(el => {el.scrollLeft = 0;});
      await paint(); // finish the reset's virtual-window update outside the resize sample
      await expect(page.getByRole('separator', {name: 'Resize column sample_id', exact: true})).toBeVisible();
      let start = performance.now();
      await drag(page, page.getByRole('separator', {name: 'Resize column sample_id', exact: true}), i % 2 ? -15 : 15);
      await paint(); latencies.columnResizeMs.push(performance.now() - start);
      start = performance.now();
      await drag(page, page.getByRole('separator', {name: 'Resize spreadsheet and chart panes'}), i % 2 ? -20 : 20);
      await paint(); latencies.splitDragMs.push(performance.now() - start);
    }
    const session = await page.context().newCDPSession(page);
    const heap = await session.send('Runtime.getHeapUsage');
    const dom = await session.send('Memory.getDOMCounters');
    const state = await page.evaluate(() => ({
      longTasks: (window as unknown as {longTasks: number[]}).longTasks,
      longTasksSupported: PerformanceObserver.supportedEntryTypes.includes('longtask'),
      domElements: document.querySelectorAll('*').length,
      canvases: document.querySelectorAll('canvas').length,
      chartInstances: document.querySelectorAll('[data-role="chart-canvas-wrap"] > svg').length,
      xrCanvases: document.querySelectorAll('[data-role="xr-canvas"]').length,
      viewport: [innerWidth, innerHeight],
    }));
    const report = {environment: {node: process.version, browser: browser.version(), os: `${platform()} ${release()}`, cpu: cpus()[0]?.model}, dataset: {rows, cols}, methodology: 'One cold navigation/import; five command-to-two-RAF samples per interaction, including Playwright protocol and pointer steps. Long Tasks cover whole page lifetime. Heap is CDP main-page isolate only, no forced GC. Not FPS or a performance gate.', initialRenderMs, csvImportMs, ...latencies, heap, dom, ...state};
    console.log(JSON.stringify(report));
    await testInfo.attach('measurements', {body: JSON.stringify(report, null, 2), contentType: 'application/json'});
    await session.detach();
  });
}
