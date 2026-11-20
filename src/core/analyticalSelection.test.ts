import test from 'node:test';
import assert from 'node:assert/strict';
import {AppStore} from './store';
import {DataWorkerClient} from './workerClient';
import {inferColumnTypes} from './tabular';
import {extractChart2DPoints} from './chartData';
import {contributorPage, resolveRecord} from './analyticalSelection';
import {validateChartConfig, resetChartConfig, chartDisplaySummary} from './chartValidation';
import type {SheetData} from '../types';

const longText='Unicode 日本語\n  preserved whitespace\n'+ 'long prompt '.repeat(30);
function setup() {
  const columns=['Group','Score','Other','Prompt'];
  const rows=[['A','10','100',longText],['A','30','200',''],['A','','300','missing'],['B','80','400','text']];
  const sheet:SheetData={id:'one',name:'One',columns,rows,types:inferColumnTypes(columns,rows)};
  const store=new AppStore({fileName:'test.csv',fileFormat:'csv',activeSheetIndex:0,sheets:[sheet,{...sheet,id:'two',name:'Two'}]},new DataWorkerClient({createWorker:()=>null}));
  store.setChartConfig({...store.chartConfig,type:'bar',xColIndex:0,yColIndices:[1],aggregation:'avg',sortOrder:'source',maxPoints:32});
  return store;
}

test('source selection resolves raw identity despite visual order, and preserves long text',t=>{
 const store=setup();t.after(()=>store.dispose());
 store.toggleColumnPin(2);store.toggleColumnVisibility(1);store.moveColumnVisual(3,-1);
 store.selectCell({rowIndex:0,colIndex:3});
 assert.equal(store.analyticalSelection?.colIndex,3);
 assert.equal(resolveRecord(store.activeSheet,store.analyticalSelection)?.[3],longText);
 assert.equal(resolveRecord({...store.activeSheet,id:'different'},store.analyticalSelection),null);
 store.selectRow(1);assert.equal(store.analyticalSelection?.kind,'row');
 store.selectCell(null);assert.equal(store.analyticalSelection,null);
});

test('2D aggregates preserve engine value, excluded count, and exact paginated contributors',async t=>{
 const store=setup();t.after(()=>store.dispose());
 const points=extractChart2DPoints(store.activeSheet,store.visibleRowIndices,0,[1],{aggregation:'avg',maxPoints:32,profile:store.datasetProfile});
 assert.equal(points.points[0].values[0],20);
 store.selectChartPoint(points.points[0],1,'avg');
 const s=store.analyticalSelection;assert.equal(s?.kind,'aggregate');if(s?.kind!=='aggregate')return;
 assert.equal(store.selectedCell,null);assert.equal(store.highlightedRowIndex,null);
 assert.equal(s.value,20);assert.equal(s.representedRowCount,3);assert.equal(s.excludedCount,1);
 assert.equal(resolveRecord(store.activeSheet,s),null);
 const first=await contributorPage(store.activeSheet,store.visibleRowIndices,s,0,1);
 assert.deepEqual(first.rows,[0]);assert.notEqual(first.nextCursor,null);
 assert.deepEqual((await contributorPage(store.activeSheet,store.visibleRowIndices,s,first.nextCursor!,1)).rows,[1]);
 await store.filterToSelectionGroup();assert.deepEqual([...store.visibleRowIndices],[0,1,2]);assert.equal(store.analyticalSelection,null);
});

test('missing measurements never become zero for means; count counts only valid values',t=>{
 const store=setup();t.after(()=>store.dispose());
 const points=extractChart2DPoints(store.activeSheet,store.visibleRowIndices,0,[1],{aggregation:'count',profile:store.datasetProfile});
 assert.equal(points.points[0].values[0],2);
 const raw=extractChart2DPoints(store.activeSheet,store.visibleRowIndices,0,[1],{aggregation:'none',profile:store.datasetProfile});
 assert.equal(raw.points[2].values[0],null);
});

test('edits, structural deletion, undo/redo and sheet changes cannot retain unrelated selection',async t=>{
 const store=setup();t.after(()=>store.dispose());
 store.selectCell({rowIndex:0,colIndex:1});store.commitCellEdit(0,1,'44');
 assert.equal(resolveRecord(store.activeSheet,store.analyticalSelection)?.[1],'44');
 await store.undo();assert.equal(resolveRecord(store.activeSheet,store.analyticalSelection)?.[1],'10');
 await store.redo();assert.equal(resolveRecord(store.activeSheet,store.analyticalSelection)?.[1],'44');
 store.deleteColumn(1);assert.equal(store.analyticalSelection,null);
 await store.undo();assert.equal(store.analyticalSelection,null);
 store.selectCell({rowIndex:0,colIndex:1});store.deleteRow(0);assert.equal(store.analyticalSelection,null);
 await store.undo();store.selectCell({rowIndex:1,colIndex:1});store.switchSheet(1);assert.deepEqual(store.analyticalSelection,{kind:'cell',sheetId:'two',rowIndex:0,colIndex:0});
 assert.equal(resolveRecord(store.activeSheet,store.analyticalSelection),store.activeSheet.rows[0]);
});

test('chart validation rejects identifier scatter X, accepts quantitative X, resets defaults and labels sampling',t=>{
 const store=setup();t.after(()=>store.dispose());
 const config={...store.chartConfig,type:'scatter' as const};
 assert.match(validateChartConfig(store.activeSheet,store.datasetProfile,config)!,/numerical X/);
 assert.equal(validateChartConfig(store.activeSheet,store.datasetProfile,{...config,xColIndex:2}),null);
 assert.match(validateChartConfig(store.activeSheet,store.datasetProfile,{...config,xColIndex:2,yColIndices:[3]})!,/measurement/);
 store.resetChart();assert.deepEqual(store.chartConfig,resetChartConfig(store.activeSheet,store.chartConfig.spatialMode,store.datasetProfile));
 assert.match(chartDisplaySummary({...config,type:'bar',aggregation:'none'},1000,32),/Systematic sample: 32 of 1,000/);
 assert.match(chartDisplaySummary({...config,type:'bar',aggregation:'avg',sortOrder:'value-desc'},1000,12),/Top 12 groups.*primary aggregate/);
});

test('spatial aggregates resolve exact inputs; raw objects retain source record',async t=>{
 const store=setup();t.after(()=>store.dispose());
 store.setSpatialConfig({xColIndex:0,yColIndex:1,aggregation:'avg'});
 const item=store.derivedSpatialData.items.find(i=>i.label==='A')!;assert.ok(item);
 store.selectSpatialItem(item);const selection=store.analyticalSelection;
 assert.equal(selection?.kind,'aggregate');assert.equal(store.selectedCell,null);
 assert.deepEqual((await contributorPage(store.activeSheet,store.visibleRowIndices,selection!)).rows,[0,1]);
 store.setSpatialConfig({aggregation:'none'});store.selectSpatialItem(store.derivedSpatialData.items[0]);
 assert.equal(store.analyticalSelection?.kind,'spatial-item');assert.ok(resolveRecord(store.activeSheet,store.analyticalSelection));
});

test('contributor scans honor cancellation and label bounded spatial previews',async t=>{
 const store=setup();t.after(()=>store.dispose());
 store.setSpatialConfig({aggregation:'avg'});store.selectSpatialItem(store.derivedSpatialData.items[0]);
 const s=store.analyticalSelection;assert.equal(s?.kind,'aggregate');if(s?.kind!=='aggregate')return;
 const aborted=new AbortController();aborted.abort();
 await assert.rejects(contributorPage(store.activeSheet,store.visibleRowIndices,s,0,20,aborted.signal),{name:'AbortError'});
 const preview=await contributorPage(store.activeSheet,store.visibleRowIndices,{...s,query:undefined,previewRowIndices:[0]});
 assert.deepEqual(preview.rows,[0]);assert.equal(preview.partial,true);
});


test('reset recommendations exclude numeric identifiers and spatial selection rejects pending derivation',t=>{
 const store=setup();t.after(()=>store.dispose());
 store.overrideColumnRole(2,'identifier');store.resetChart();
 assert.ok(!store.chartConfig.yColIndices.includes(2));
 assert.equal(validateChartConfig(store.activeSheet,store.datasetProfile,store.chartConfig),null);
 store.selectCell(null);store.spatialTransformLoading=true;
 store.selectSpatialItem(store.derivedSpatialData.items[0]);assert.equal(store.analyticalSelection,null);
});


test('initial and reloaded chart defaults exclude inferred numeric identifiers',t=>{
 const columns=['sample_id','Category','Score'];
 const rows=Array.from({length:30},(_,i)=>[String(i+1),i%2?'A':'B',String(50+(i*7)%23)]);
 const sheet:SheetData={id:'numeric-id',name:'Numeric IDs',columns,rows,types:inferColumnTypes(columns,rows)};
 const workbook={fileName:'ids.csv',fileFormat:'csv' as const,activeSheetIndex:0,sheets:[sheet]};
 const store=new AppStore(workbook,new DataWorkerClient({createWorker:()=>null}));t.after(()=>store.dispose());
 assert.equal(store.datasetProfile.columns[0].semanticType,'identifier');
 assert.deepEqual(store.chartConfig.yColIndices,[2]);
 store.resetWithWorkbook(workbook);assert.deepEqual(store.chartConfig.yColIndices,[2]);
});

test('chartDisplaySummary labels ascending, descending, and source group rankings truthfully',()=>{
 const base={type:'bar' as const,xColIndex:0,yColIndices:[1],spatialMode:'bar3d' as const,aggregation:'avg' as const,sortOrder:'value-asc' as const,maxPoints:12};
 assert.match(chartDisplaySummary(base,500,12),/Bottom 12 groups by ascending primary aggregate/);
 assert.match(chartDisplaySummary({...base,sortOrder:'value-desc'},500,12),/Top 12 groups by descending primary aggregate/);
 assert.match(chartDisplaySummary({...base,sortOrder:'source'},500,12),/First 12 groups in source order/);
});

test('loadFile enters overview for imported datasets unless spatial startup is requested; edits keep layout',async t=>{
 const store=setup();t.after(()=>store.dispose());
 assert.equal(store.layout,'split');
 store.commitCellEdit(0,1,'15');
 assert.equal(store.layout,'split');

 const file={name:'imported.csv',text:async()=>'Dept,Sales\nEng,100\nSales,200'} as unknown as File;
 await store.loadFile(file);
 assert.equal(store.layout,'overview');

 // Blank reset stays non-overview when switched away; spatial startup preference skips auto-overview
 store.setLayout('spatial');
 store.setPreferSpatialStartup(true);
 await store.loadFile(file);
 assert.equal(store.layout,'spatial');

 // Focus in table unhides hidden column and moves selection to requested row
 store.toggleColumnVisibility(1);
 store.focusColumnInTable(1,1,'split');
 assert.equal(store.layout,'split');
 assert.equal(store.activeColumnView.hidden.includes(1),false);
 assert.deepEqual(store.selectedCell,{rowIndex:1,colIndex:1});
});

