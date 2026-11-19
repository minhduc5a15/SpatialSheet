import type {SheetData, WorkbookState} from '../types';
import {computeAutoFitColumnWidth, getVisibleColumnsPlan, moveColumnVisualInView} from '../core/columnView';
import {AppStore} from '../core/store';
import {inferColumnTypes} from '../core/tabular';
import {computePinnedColumnVirtualWindow} from '../core/virtualWindow';
import {DataWorkerClient} from '../core/workerClient';

function buildSheet(rows: number, cols: number): SheetData {
  const columns: string[] = [];
  for (let c = 0; c < cols; c++) {
    if (c === 0) columns.push('sample_id');
    else if (c === 1) columns.push('eval_name');
    else if (c === 2) columns.push('prompt');
    else if (c === 3) columns.push('category');
    else if (c === 4) columns.push('eval_date');
    else columns.push(`model_${c - 4}`);
  }

  const categories = ['Reasoning', 'Coding', 'Math', 'Vision'];
  const matrix: string[][] = new Array(rows);
  for (let r = 0; r < rows; r++) {
    const row = new Array<string>(cols);
    row[0] = `ID-${String(r + 1).padStart(6, '0')}`;
    if (cols > 1) row[1] = `Task_${(r % 25) + 1}`;
    if (cols > 2) {
      row[2] =
        r % 5 === 0
          ? `Long prompt description for evaluation case #${r + 1}: verify multi-step reasoning and edge-case formatting across wide spreadsheets.`
          : `Prompt ${r + 1}`;
    }
    if (cols > 3) row[3] = categories[r % categories.length];
    if (cols > 4) row[4] = `2026-01-${String((r % 28) + 1).padStart(2, '0')}`;
    for (let c = 5; c < cols; c++) {
      row[c] = String(Number((50 + ((r * 7 + c * 11) % 50) * 0.9).toFixed(2)));
    }
    matrix[r] = row;
  }

  return {
    id: `bench-${rows}x${cols}`,
    name: `Bench ${rows}x${cols}`,
    columns,
    rows: matrix,
    types: inferColumnTypes(columns, matrix),
  };
}

function runScenario(rows: number, cols: number): void {
  const sheet = buildSheet(rows, cols);
  const wb: WorkbookState = {
    fileName: `${sheet.id}.csv`,
    fileFormat: 'csv',
    activeSheetIndex: 0,
    sheets: [sheet],
  };

  const tInit0 = performance.now();
  const store = new AppStore(
    wb,
    new DataWorkerClient({createWorker: () => null}),
    null
  );
  const initMs = performance.now() - tInit0;

  const tOps0 = performance.now();
  store.toggleColumnPin(0);
  store.toggleColumnPin(1);
  store.toggleColumnVisibility(2);
  moveColumnVisualInView(store.activeColumnView, 5, -1);
  const autoW = computeAutoFitColumnWidth(sheet, 2);
  store.setColumnWidth(2, autoW);

  const plan = getVisibleColumnsPlan({
    view: store.activeColumnView,
    colWidths: sheet.columns.map((_, i) => store.activeColumnView.widths[i] ?? 156),
    viewportWidth: 960,
    rowNumWidth: 76,
  });
  const win = computePinnedColumnVirtualWindow({
    unpinnedCols: plan.unpinnedCols,
    scrollLeft: 2400,
    viewportWidth: 960,
    colWidths: sheet.columns.map(() => 156),
    fixedLeftWidth: 76 + plan.pinnedTotalWidth,
    overscan: 2,
  });
  const opsMs = performance.now() - tOps0;

  const tStruct0 = performance.now();
  store.deleteColumn(2);
  store.undo();
  store.redo();
  store.undo();
  const structMs = performance.now() - tStruct0;

  console.log(
    `[ColumnBench ${rows.toLocaleString('en-US')}x${cols}] init=${initMs.toFixed(1)}ms | viewOps+virt=${opsMs.toFixed(1)}ms (visibleUnpinned=${win.visibleUnpinnedCols.length}, autoW=${autoW}px) | del+undo+redo+undo=${structMs.toFixed(1)}ms`
  );
  store.dispose();
}

runScenario(100, 37);
runScenario(3000, 40);
runScenario(100_000, 100);
