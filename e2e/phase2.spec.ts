import {test,expect,importCsv,role,cell,edit,drag} from './helpers';
import type {Page} from '@playwright/test';
const longText='Prompt 日本語\n  Preserve indentation\n'+'Long response '.repeat(25);
const csv=`Group,Score,Other,Prompt\nA,10,100,"${longText}"\nA,30,200,short\nA,,300,missing\nB,80,400,last`;
async function setup(page:Page) {
 await importCsv(page,csv,4,4);
 await page.getByRole('button',{name:'Split',exact:true}).click();
 await page.getByLabel('Select X-axis column').selectOption('0');
 const series=role(page,'series-manager-trigger');await series.click();
 const manager=page.getByRole('dialog',{name:'Chart Series Manager'});
 await manager.getByRole('button',{name:'Clear',exact:true}).click();
 await manager.locator('[data-series-col="1"]').check();
 await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'Inspect data',exact:true}).click();
 return role(page,'data-inspector');
}

test('Inspector resolves source cells, preserves full Unicode text, copies record and follows keyboard',async({page,context})=>{
 await context.grantPermissions(['clipboard-read','clipboard-write']);
 const inspector=await setup(page);
 await cell(page,'D1').click();
 await expect(inspector.locator('[data-inspector-summary]')).toContainText('D1');
 await inspector.getByRole('button',{name:'View full Prompt',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Full field text'});
 await expect(dialog.locator('pre')).toHaveText(longText);
 await dialog.getByRole('button',{name:'Copy full text',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toBe(longText);
 await dialog.getByRole('button',{name:'Close full text',exact:true}).click();
 await inspector.getByRole('button',{name:'Copy record JSON',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toContain('Preserve indentation');
 await inspector.getByLabel('Search record fields').fill('Score');
 await expect(inspector.locator('.inspector-field')).toHaveCount(1);
 await cell(page,'B2').click();await page.keyboard.press('ArrowDown');
 await expect(inspector.locator('[data-inspector-summary]')).toContainText('B3');
 await expect(inspector.locator('[data-inspector-value]')).toHaveText('');
 await page.getByRole('button',{name:'Select row 2',exact:true}).click();
 await expect(inspector.getByRole('heading',{name:'Selected row',exact:true})).toBeVisible();
});

test('raw chart point selects correct source field, highlights row, and jumps to source',async({page})=>{
 const inspector=await setup(page);
 await page.getByLabel('Chart aggregation').selectOption('none');
 const point=role(page,'chart-canvas-wrap').locator('[data-point-row="1"][data-point-col="1"]').first();
 await point.focus(); await page.keyboard.press('Enter');
 await expect(point).toBeFocused();
 await expect(inspector.getByRole('heading',{name:'Selected chart point',exact:true})).toBeVisible();
 await expect(inspector.locator('[data-inspector-summary]')).toContainText('B2');
 await expect(inspector.locator('[data-inspector-value]')).toHaveText('30');
 await expect(point).toHaveAttribute('aria-pressed','true');
 await inspector.getByRole('button',{name:'Jump to source',exact:true}).click();
 await expect(page.locator('tr[data-row-index="1"]')).toHaveAttribute('data-highlighted','1');
});

test('aggregate inspector shows actual mean, exclusions, contributors, and group filter',async({page})=>{
 const inspector=await setup(page);
 await page.getByLabel('Chart aggregation').selectOption('avg');
 await role(page,'chart-canvas-wrap').locator('[data-point-row="0"]').first().click();
 await expect(inspector.getByRole('heading',{name:'Selected aggregate',exact:true})).toBeVisible();
 await expect(inspector.locator('[data-inspector-value]')).toHaveText('20');
 await expect(inspector.locator('dl')).toContainText('Represented rows3');
 await expect(inspector.locator('dl')).toContainText('Invalid / missing excluded1');
 await expect(inspector.getByRole('button',{name:'Jump to source',exact:true})).toHaveCount(0);
 await inspector.getByRole('button',{name:'Inspect contributing records',exact:true}).click();
 await expect(inspector.locator('[data-source-row]')).toHaveText(['Source row 1','Source row 2']);
 await page.screenshot({path:'test-results/phase2-desktop.png',fullPage:true});
 await inspector.getByRole('button',{name:'Filter to selected group',exact:true}).click();
 await expect(cell(page,'A4')).toHaveCount(0);
 await expect(cell(page,'A3')).toBeVisible();
});

test('Chart Builder rejects invalid scatter mapping, preserves preview, then renders numeric pairs',async({page})=>{
 await setup(page);
 await page.getByLabel('Chart aggregation').selectOption('avg');
 await page.getByLabel('Chart sort order').selectOption('value-desc');
 await expect(role(page,'chart-canvas-wrap').locator('[data-point-row]').first()).toHaveAttribute('data-point-row','3');
 const before=await role(page,'chart-canvas-wrap').innerHTML();
 await page.getByRole('button',{name:'Scatter',exact:true}).click();
 await expect(page.locator('[data-builder-error]')).toContainText('Scatter charts require numerical X and Y');
 expect(await role(page,'chart-canvas-wrap').innerHTML()).toBe(before);
 await page.getByLabel('Select X-axis column').selectOption('2');
 await expect(page.locator('[data-builder-error]')).toBeHidden();
 await expect(role(page,'chart-canvas-wrap').locator('circle[data-point-row]')).toHaveCount(3);
 await role(page,'chart-canvas-wrap').locator('circle[data-point-row="1"]').click();
 await expect(role(page,'data-inspector').locator('[data-inspector-value]')).toHaveText('30');
 await page.getByRole('button',{name:'Reset chart',exact:true}).click();
 await expect(page.getByLabel('Chart aggregation')).toHaveValue('none');
 await page.getByRole('button',{name:'Apply recommended chart',exact:true}).click();
 await expect(page.locator('[data-builder-error]')).toBeHidden();
});

test('3D objects use accessible plotted-object selection and unified aggregate semantics',async({page})=>{
 const inspector=await setup(page);
 await page.getByRole('button',{name:'3D XR',exact:true}).click();
 const objects=page.getByLabel('Inspect spatial object');
 await expect(objects).toBeVisible();
 await expect.poll(()=>objects.locator('option').count()).toBeGreaterThan(1);
 await expect(role(page,'xr-canvas')).toHaveCount(1);
 await expect(role(page,'xr-canvas')).toBeVisible();
 // Normal keyboard-accessible UI selects the same derived objects as canvas picking.
 await page.getByRole('button',{name:'Configure',exact:true}).click();
 const agg=page.locator('select[data-cfg-field="aggregation"]');
 await agg.selectOption('none');
 const first=await objects.locator('option').nth(1).getAttribute('value');
 await objects.selectOption(first!);
 await expect(inspector.getByRole('heading',{name:'Selected spatial object',exact:true})).toBeVisible();
 await expect(inspector.locator('[data-inspector-summary]')).toContainText('B1');
 await expect(inspector.locator('[data-inspector-value]')).toHaveText('10');
 await agg.selectOption('avg');
 await objects.selectOption({label:'A · 20 (avg, 2 records)'});
 await expect(inspector.getByRole('heading',{name:'Selected aggregate',exact:true})).toBeVisible();
 await expect(inspector.locator('[data-inspector-value]')).toHaveText('20');
 await inspector.getByRole('button',{name:'Inspect contributing records',exact:true}).click();
 await expect(inspector.locator('[data-source-row]')).toHaveText(['Source row 1','Source row 2']);
});

test('Inspector responsive drawer closes with focus restoration; desktop split remains resizable',async({page})=>{
 await page.setViewportSize({width:1600,height:1000});
 const inspector=await setup(page);
 await cell(page,'B1').click();
 const main=role(page,'workspace-main'),before=(await main.boundingBox())!.width;
 await drag(page,page.getByRole('separator',{name:'Resize spreadsheet and chart panes'}),50);
 await expect(inspector.locator('[data-inspector-summary]')).toContainText('B1');
 await inspector.getByRole('button',{name:'Close Inspector',exact:true}).click();
 expect((await main.boundingBox())!.width).toBeGreaterThan(before+250);
 await page.setViewportSize({width:900,height:800});
 await page.getByRole('button',{name:'Inspect data',exact:true}).click();
 await expect(inspector).toHaveAttribute('role','dialog');
 await expect(inspector).toHaveAttribute('aria-modal','true');
 await page.keyboard.press('Escape');
 await expect(inspector).toBeHidden();
 await expect(page.getByRole('button',{name:'Inspect data',exact:true})).toBeFocused();
 await page.setViewportSize({width:390,height:844});
 await page.getByRole('button',{name:'Inspect data',exact:true}).click();
 const box=(await inspector.boundingBox())!;expect(box.width).toBeLessThanOrEqual(390);expect(box.y).toBeGreaterThan(100);
 await page.screenshot({path:'test-results/phase2-mobile.png',fullPage:true});
});

test('Inspector updates after edits, undo/redo, and structural deletion',async({page})=>{
 const inspector=await setup(page);
 await edit(page,'B1','42');await cell(page,'B1').click();
 await expect(inspector.locator('[data-inspector-value]')).toHaveText('42');
 await page.getByRole('button',{name:/Undo/}).click();
 await expect(inspector.locator('[data-inspector-value]')).toHaveText('10');
 await page.getByRole('button',{name:/Redo/}).click();
 await expect(inspector.locator('[data-inspector-value]')).toHaveText('42');
 await page.locator('tr[data-row-index="0"]').hover();
 await page.getByRole('button',{name:'Delete row 1',exact:true}).click();
 await expect(inspector.getByRole('heading',{name:'No data selected',exact:true})).toBeVisible();
});

test('Excel export preserves source workbook after analytical configuration',async({page})=>{
 await setup(page);
 await page.getByLabel('Chart aggregation').selectOption('avg');
 const pending=page.waitForEvent('download');
 await page.getByRole('button',{name:'Export Excel',exact:true}).click();
 const stream=await (await pending).createReadStream(),chunks:Buffer[]=[];
 for await(const chunk of stream!)chunks.push(Buffer.from(chunk));
 const XLSX=await import('xlsx');
 const workbook=XLSX.read(Buffer.concat(chunks),{type:'buffer'});
 const rows=XLSX.utils.sheet_to_json<string[]>(workbook.Sheets[workbook.SheetNames[0]],{header:1,raw:false});
 expect(rows[0]).toEqual(['Group','Score','Other','Prompt']);
 expect(rows[1]).toEqual(['A','10','100',longText]);
 expect(rows).toHaveLength(5);
});

test('group filter transfers exact visible membership to worker spatial aggregation',async({page})=>{
 const rows=Array.from({length:6000},(_,i)=>`${i<3000?'A':'B'},${i<3000?10:90}`);
 await importCsv(page,'Group,Score\n'+rows.join('\n'),6000,2);
 await page.getByRole('button',{name:'Charts',exact:true}).click();
 await page.getByLabel('Select X-axis column').selectOption('0');
 await page.getByLabel('Chart aggregation').selectOption('avg');
 await page.getByRole('button',{name:'Inspect data',exact:true}).click();
 await role(page,'chart-canvas-wrap').locator('[data-point-row="0"]').first().click();
 await role(page,'data-inspector').getByRole('button',{name:'Filter to selected group',exact:true}).click();
 await expect(role(page,'chart-display-summary')).toContainText('3,000 filtered rows');
 await page.getByRole('button',{name:'3D XR',exact:true}).click();
 await page.getByRole('button',{name:'Configure',exact:true}).click();
 await page.locator('[data-cfg-field="aggregation"]').selectOption('avg');
 await expect(page.getByLabel('Inspect spatial object').locator('option')).toHaveText(['Choose plotted object','A · 10 (avg, 3000 records)']);
});
