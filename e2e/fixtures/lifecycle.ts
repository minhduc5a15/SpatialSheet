// Browser-only harness. Production components are imported directly; no application test hooks.
import '../../src/index.css';
import {DataInspector} from '../../src/ui/DataInspector';
import {AppStore} from '../../src/core/store';
import {DataWorkerClient} from '../../src/core/workerClient';
import {WorkspaceSplitter} from '../../src/ui/WorkspaceSplitter';
import {SpreadsheetGrid} from '../../src/ui/SpreadsheetGrid';
import {InteractiveChart2D} from '../../src/ui/InteractiveChart2D';
import {SpatialInspectorOverlay} from '../../src/ui/SpatialInspectorOverlay';
import {profileDataset} from '../../src/core/dataProfiler';
import {createDefaultSpatialConfig, transformSpatialDataset} from '../../src/core/spatialTransform';
import type {SheetData} from '../../src/types';

const sheet: SheetData = {id: 'lifecycle', name: 'Lifecycle', columns: ['Label', 'Value'], rows: [['First\nSecond', '10'], ['B', '20']], types: ['text', 'number']};
const profile = profileDataset(sheet, 1);
const config = createDefaultSpatialConfig(profile);
const visible = [0, 1];
let actions = 0;
const action = () => {actions++;};
const rafs = new Set<number>();
const nativeRaf = window.requestAnimationFrame.bind(window);
const nativeCancel = window.cancelAnimationFrame.bind(window);
window.requestAnimationFrame = callback => {
  const id = nativeRaf(time => {rafs.delete(id); callback(time);});
  rafs.add(id);
  return id;
};
window.cancelAnimationFrame = id => {rafs.delete(id); nativeCancel(id);};
const observers: Array<{active: boolean; fire: () => void}> = [];
const NativeObserver = window.ResizeObserver;
window.ResizeObserver = class extends NativeObserver {
  private record: {active: boolean; fire: () => void};
  constructor(callback: ResizeObserverCallback) {
    super((entries, observer) => callback(entries, observer));
    this.record = {active: true, fire: () => callback([], this)};
    observers.push(this.record);
  }
  disconnect() {this.record.active = false; super.disconnect();}
};
function host(id: string, style: string) {
  const el = document.createElement('div'); el.id = id; el.style.cssText = style; document.body.append(el); return el;
}
const splitHost = host('splitter', 'position:absolute;left:700px;top:10px;height:200px');
const splitter = new WorkspaceSplitter(splitHost, {getRatio: () => 0.55, getContainerRect: () => new DOMRect(0, 0, 1400, 200), onRatioCommit: action, onRatioPreview: action});
const gridHost = host('grid', 'width:680px;height:350px');
const grid = new SpreadsheetGrid(gridHost, {
  onCellCommit: action, onSelectCell: action, onSortColumn: action, onRenameColumn: action,
  onDeleteColumn: action, onDeleteRow: action, onAddRow: action, onAddColumn: action,
  onClearSearch: action, onResizeColumn: action,
});
grid.setData({sheet, visibleRowIndices: visible, sort: {colIndex: null, direction: null}, selectedCell: {rowIndex: 0, colIndex: 0}, highlightedRowIndex: null});
const chartHost = host('chart', 'width:680px;height:400px');
const chart = new InteractiveChart2D(chartHost, {onConfigChange: action, onRowSelect: action});
chart.setData({sheet, visibleRowIndices: visible, config: {type: 'bar', spatialMode: 'bar3d', xColIndex: 0, yColIndices: [1]}, highlightedRowIndex: null, profile});
const spatialHost = host('spatial', 'position:absolute;left:740px;top:10px;width:650px;height:700px');
spatialHost.innerHTML = '<div data-role="spatial-topbar"></div><div id="mount" style="position:relative;height:500px"></div><div data-role="spatial-footer"></div>';
const overlay = new SpatialInspectorOverlay(spatialHost, document.querySelector('#mount')!, {
  onModeChange: action, onConfigChange: action, onOverrideColumnRole: action,
  onApplyRecommendation: action, onSelectItem: action, onJumpToRow: action, onResetCamera: action,
});
overlay.update({sheet, profile, config, derived: transformSpatialDataset({sheet, visibleRowIndices: visible, profile, config, mode: 'bar3d'}), recommendations: [], selectedItem: null});
const inspectorStore = new AppStore({fileName:'fixture.csv',fileFormat:'csv',activeSheetIndex:0,sheets:[sheet]},new DataWorkerClient({createWorker:()=>null}));
const inspector = new DataInspector(host('inspector','position:fixed;right:0;top:0;height:90vh;z-index:100'), inspectorStore, action, action);
const components = {splitter, grid, chart, overlay, inspector};
const api = {
  openInspector() {inspectorStore.selectCell({rowIndex:0,colIndex:0}); inspector.open();},
  dispose(name: keyof typeof components) {components[name].dispose();},
  snapshot() {return {actions, pendingFrames: rafs.size, activeObservers: observers.filter(o => o.active).length};},
  // Force an already-queued observer delivery after disconnect to test the disposal guard.
  deliverStaleResize() {observers.forEach(observer => observer.fire());},
  queueGridAndDispose() {
    gridHost.querySelector('[data-role="table-container"]')!.dispatchEvent(new Event('scroll'));
    const pending = rafs.size;
    grid.dispose();
    return {pending, after: rafs.size};
  },
};
declare global {interface Window {lifecycle: typeof api}}
window.lifecycle = api;
