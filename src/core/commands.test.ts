import test from 'node:test';
import assert from 'node:assert/strict';

import type {CommandContext, AppCommand} from './commands';
import {
  buildAppCommands,
  formatColumnDisambiguatedLabel,
  validateCommandRegistry,
} from './commands';
import {
  groupRankedCommands,
  rankAndFilterCommands,
  scoreCommandMatch,
} from './commandSearch';
import {
  APP_SHORTCUTS,
  detectShortcutConflicts,
  dispatchKeyboardShortcut,
  formatShortcutString,
  formatShortcutTokens,
  isEditableEventTarget,
  isMacPlatform,
  matchesShortcut,
} from './shortcuts';
import {createColumnViewState} from './columnView';
import {profileDataset} from './dataProfiler';
import type {SheetData, WorkbookState} from '../types';

function makeMockContext(overrides: Partial<CommandContext> = {}): {
  ctx: CommandContext;
  calls: Array<{fn: string; args: unknown[]}>;
} {
  const calls: Array<{fn: string; args: unknown[]}> = [];
  const sheet: SheetData = {
    id: 'sheet-1',
    name: 'Revenue',
    columns: ['Region', 'Amount', 'Region', 'Notes'],
    rows: [
      ['North', '100', 'East', 'First note'],
      ['South', '200', 'West', 'Second note'],
    ],
    types: ['text', 'number', 'text', 'text'],
  };
  const sheet2: SheetData = {
    id: 'sheet-2',
    name: 'Q4 Summary',
    columns: ['Month', 'Total'],
    rows: [['Oct', '50']],
    types: ['text', 'number'],
  };
  const workbook: WorkbookState = {
    fileName: 'sales.csv',
    fileFormat: 'csv',
    sheets: [sheet, sheet2],
    activeSheetIndex: 0,
  };
  const profile = profileDataset(sheet, 1);

  const ctx: CommandContext = {
    workbook,
    activeSheet: sheet,
    activeColumnView: {
      ...createColumnViewState(sheet),
      order: [2, 1, 0, 3],
      hidden: [3],
      pinned: [2],
    },
    datasetProfile: profile,
    layout: 'split',
    chartPanelMode: '2d',
    chartType: 'bar',
    xColIndex: 0,
    selectedCell: {rowIndex: 0, colIndex: 0},
    analyticalSelection: null,
    canUndo: true,
    canRedo: false,
    isInspectorOpen: false,
    hasGroupFilter: false,
    hasSearchOrSort: false,
    is3DStageVisible: false,

    setLayout: (l) => calls.push({fn: 'setLayout', args: [l]}),
    setChartPanelMode: (m) => calls.push({fn: 'setChartPanelMode', args: [m]}),
    focusColumnInTable: (c, r, l) => calls.push({fn: 'focusColumnInTable', args: [c, r, l]}),
    toggleColumnPin: (c) => calls.push({fn: 'toggleColumnPin', args: [c]}),
    toggleColumnVisibility: (c) => calls.push({fn: 'toggleColumnVisibility', args: [c]}),
    restoreAllColumns: () => calls.push({fn: 'restoreAllColumns', args: []}),
    resetColumnView: () => calls.push({fn: 'resetColumnView', args: []}),
    autoFitColumn: (c) => calls.push({fn: 'autoFitColumn', args: [c]}),
    useColumnAsChartX: (c, l) => calls.push({fn: 'useColumnAsChartX', args: [c, l]}),
    addColumnAsChartY: (c, l) => {
      calls.push({fn: 'addColumnAsChartY', args: [c, l]});
      return c === 1
        ? {applied: true, reason: null}
        : {applied: false, reason: 'Requires numeric column'};
    },
    setChartType: (t) => calls.push({fn: 'setChartType', args: [t]}),
    resetChart: () => calls.push({fn: 'resetChart', args: []}),
    toggleInspector: () => calls.push({fn: 'toggleInspector', args: []}),
    clearSelection: () => calls.push({fn: 'clearSelection', args: []}),
    filterToSelectionGroup: () => {
      calls.push({fn: 'filterToSelectionGroup', args: []});
    },
    inspectContributingRecords: () => calls.push({fn: 'inspectContributingRecords', args: []}),
    clearSearch: () => calls.push({fn: 'clearSearch', args: []}),
    switchSheet: (i) => calls.push({fn: 'switchSheet', args: [i]}),
    addNewSheet: () => calls.push({fn: 'addNewSheet', args: []}),
    addRow: () => calls.push({fn: 'addRow', args: []}),
    addColumn: () => calls.push({fn: 'addColumn', args: []}),
    undo: () => calls.push({fn: 'undo', args: []}),
    redo: () => calls.push({fn: 'redo', args: []}),
    openFilePicker: () => calls.push({fn: 'openFilePicker', args: []}),
    newBlankWorkbook: () => calls.push({fn: 'newBlankWorkbook', args: []}),
    exportCsv: () => calls.push({fn: 'exportCsv', args: []}),
    exportXlsx: () => calls.push({fn: 'exportXlsx', args: []}),
    openColumnManager: () => calls.push({fn: 'openColumnManager', args: []}),
    openSeriesManager: () => calls.push({fn: 'openSeriesManager', args: []}),
    focusSearch: () => calls.push({fn: 'focusSearch', args: []}),
    openShortcutsHelp: () => calls.push({fn: 'openShortcutsHelp', args: []}),
    reset3DCamera: () => calls.push({fn: 'reset3DCamera', args: []}),
    ...overrides,
  };

  return {ctx, calls};
}

test('validateCommandRegistry rejects duplicate command IDs', () => {
  const mk = (id: string): AppCommand => ({
    id,
    title: id,
    category: 'Navigation',
    icon: 'split',
    execute: () => ({ok: true}),
  });
  assert.doesNotThrow(() => validateCommandRegistry([mk('a'), mk('b')]));
  assert.throws(() => validateCommandRegistry([mk('dup'), mk('dup')]), /Duplicate command id/);
});

test('command search ranks exact > prefix > word-boundary > substring > keyword > fuzzy deterministically', () => {
  const mk = (id: string, title: string, keywords: string[] = []): AppCommand => ({
    id,
    title,
    category: 'Navigation',
    keywords,
    icon: 'split',
    execute: () => ({ok: true}),
  });

  const cmds = [
    mk('fuzzy', 'Toggle Spatial XRay View'),
    mk('kw', 'Inspect Data Drawer', ['table']),
    mk('substr', 'Open Spreadsheet Table'),
    mk('wb', 'Focus Column Table'),
    mk('prefix', 'Table View Options'),
    mk('exact', 'Table'),
  ];

  const ranked = rankAndFilterCommands(cmds, 'table', {limit: 20});
  assert.deepEqual(
    ranked.map((r) => r.command.id),
    ['exact', 'prefix', 'wb', 'substr', 'kw']
  );

  // Fuzzy match works when no closer match prevents it
  const fuzzy = scoreCommandMatch(mk('f1', 'Go to Dataset Overview'), 'dtov');
  assert.ok(fuzzy !== null);
  assert.equal(fuzzy.matchKind, 'fuzzy');

  // Result capping works cleanly
  const capped = rankAndFilterCommands(cmds, '', {limit: 3});
  assert.equal(capped.length, 3);
});

test('dynamic column commands disambiguate duplicate names, preserve source index, and expose hidden columns only on explicit reveal', async () => {
  const {ctx, calls} = makeMockContext();
  const cmds = buildAppCommands(ctx);

  // Duplicate "Region" columns (col 0 and col 2) are distinctly labeled
  const dupLabel0 = formatColumnDisambiguatedLabel(ctx.activeSheet.columns, 0);
  const dupLabel2 = formatColumnDisambiguatedLabel(ctx.activeSheet.columns, 2);
  assert.equal(dupLabel0.hasDuplicateName, true);
  assert.notEqual(dupLabel0.titleName, dupLabel2.titleName);
  assert.match(dupLabel0.titleName, /A, col #1/);
  assert.match(dupLabel2.titleName, /C, col #3/);

  const focusCol0 = cmds.find((c) => c.id === 'col.focus.0');
  const focusCol2 = cmds.find((c) => c.id === 'col.focus.2');
  const focusHidden = cmds.find((c) => c.id === 'col.focus.3');
  assert.ok(focusCol0 && focusCol2 && focusHidden);
  assert.equal(focusHidden.badge, 'Hidden');

  // Execute focus on visually reordered duplicate column #2 -> passes source index 2
  const res2 = await focusCol2.execute();
  assert.equal(res2.ok, true);
  assert.deepEqual(calls.at(-1), {fn: 'focusColumnInTable', args: [2, undefined, undefined]});

  // Navigating to Charts does NOT call focusColumnInTable / unhide
  const navCharts = cmds.find((c) => c.id === 'nav.charts')!;
  await navCharts.execute();
  assert.deepEqual(calls.at(-1), {fn: 'setLayout', args: ['charts']});
  assert.equal(calls.some((c) => c.fn === 'toggleColumnVisibility'), false);

  // Sheet switching commands track active vs inactive sheets
  const sheet0 = cmds.find((c) => c.id === 'sheet.switch.0')!;
  const sheet1 = cmds.find((c) => c.id === 'sheet.switch.1')!;
  assert.equal(sheet0.isEnabled, false);
  assert.equal(sheet1.isEnabled, true);
  await sheet1.execute();
  assert.deepEqual(calls.at(-1), {fn: 'switchSheet', args: [1]});
});

test('contextual availability and enabled state adapt to selected column semantic role and aggregate selection', async () => {
  // Categorical column 0 selected -> Use as Y Series disabled with reason
  const {ctx: catCtx} = makeMockContext({selectedCell: {rowIndex: 0, colIndex: 0}});
  const catCmds = buildAppCommands(catCtx);
  const catUseY = catCmds.find((c) => c.id === 'context.col.useY');
  assert.ok(catUseY);
  assert.equal(catUseY.isEnabled, false);
  assert.ok(catUseY.disabledReason);

  // Quantitative column 1 selected in split layout -> keeps split so user sees chart beside grid
  const {ctx: numCtx, calls: numCalls} = makeMockContext({selectedCell: {rowIndex: 0, colIndex: 1}, layout: 'split'});
  const numCmds = buildAppCommands(numCtx);
  const numUseY = numCmds.find((c) => c.id === 'context.col.useY');
  assert.ok(numUseY);
  assert.equal(numUseY.isEnabled, true);
  await numUseY.execute();
  assert.deepEqual(numCalls.at(-1), {fn: 'addColumnAsChartY', args: [1, 'split']});

  // Quantitative column 1 selected in table layout -> switches to charts
  const {ctx: tblCtx, calls: tblCalls} = makeMockContext({selectedCell: {rowIndex: 0, colIndex: 1}, layout: 'table'});
  const tblUseY = buildAppCommands(tblCtx).find((c) => c.id === 'context.col.useY')!;
  await tblUseY.execute();
  assert.deepEqual(tblCalls.at(-1), {fn: 'addColumnAsChartY', args: [1, 'charts']});

  // Aggregate Inspector selection enables contributor and group filter commands
  const {ctx: aggCtx, calls: aggCalls} = makeMockContext({
    selectedCell: null,
    analyticalSelection: {
      kind: 'aggregate',
      origin: '2d',
      sheetId: 'sheet-1',
      label: 'North',
      aggregation: 'sum',
      colIndex: 1,
      value: 100,
      representedRowCount: 3,
      query: {fields: [{colIndex: 0, value: 'North', emptyLabel: '(Empty)'}]},
    },
  });
  const aggCmds = buildAppCommands(aggCtx);
  const contribCmd = aggCmds.find((c) => c.id === 'context.inspector.contributors')!;
  const filterGroupCmd = aggCmds.find((c) => c.id === 'context.inspector.filterGroup')!;
  assert.equal(contribCmd.isEnabled ?? true, true);
  assert.equal(filterGroupCmd.isEnabled, true);
  await filterGroupCmd.execute();
  assert.deepEqual(aggCalls.at(-1), {fn: 'filterToSelectionGroup', args: []});

  // 3D Reset Camera disabled when 3D stage hidden
  const resetCam = aggCmds.find((c) => c.id === 'spatial.resetCamera')!;
  assert.equal(resetCam.isEnabled, false);
  assert.ok(resetCam.disabledReason);

  // Grouping order puts Contextual first when present
  const sections = groupRankedCommands(rankAndFilterCommands(aggCmds, '', {limit: 40}));
  assert.equal(sections[0]?.category, 'Contextual');
});

test('shortcuts detect zero conflicts, adapt modifier display by platform, and guard editable inputs', () => {
  const conflicts = detectShortcutConflicts(APP_SHORTCUTS);
  assert.deepEqual(conflicts, []);

  assert.equal(isMacPlatform({platform: 'MacIntel'}), true);
  assert.equal(isMacPlatform({platform: 'Win32'}), false);

  assert.deepEqual(formatShortcutTokens({ctrlOrCmd: true, key: 'k'}, true), ['⌘', 'K']);
  assert.deepEqual(formatShortcutTokens({ctrlOrCmd: true, key: 'k'}, false), ['Ctrl', 'K']);
  assert.equal(formatShortcutString({ctrlOrCmd: true, shift: true, key: 'z'}, true), '⌘⇧Z');
  assert.equal(formatShortcutString({ctrlOrCmd: true, shift: true, key: 'z'}, false), 'Ctrl+Shift+Z');

  // Editable target checks
  assert.equal(isEditableEventTarget({tagName: 'INPUT', getAttribute: () => 'text'}), true);
  assert.equal(isEditableEventTarget({tagName: 'TEXTAREA'}), true);
  assert.equal(isEditableEventTarget({tagName: 'SELECT'}), true);
  assert.equal(isEditableEventTarget({tagName: 'DIV', isContentEditable: true}), true);
  assert.equal(isEditableEventTarget({tagName: 'INPUT', getAttribute: () => 'checkbox'}), false);
  assert.equal(isEditableEventTarget({tagName: 'BUTTON'}), false);

  // Dispatch behavior inside vs outside editable targets
  let paletteCount = 0;
  let undoCount = 0;
  let helpCount = 0;
  const handlers = {
    'palette.open': () => { paletteCount += 1; },
    'history.undo': () => { undoCount += 1; },
    'help.shortcuts': () => { helpCount += 1; },
  };

  // Inside text input: Ctrl+K allowed, Ctrl+Z & ? ignored so native editor keeps them
  dispatchKeyboardShortcut({key: 'k', ctrlKey: true}, {tagName: 'INPUT', getAttribute: () => 'text'}, handlers);
  dispatchKeyboardShortcut({key: 'z', ctrlKey: true}, {tagName: 'INPUT', getAttribute: () => 'text'}, handlers);
  dispatchKeyboardShortcut({key: '?', shiftKey: true}, {tagName: 'TEXTAREA'}, handlers);
  assert.equal(paletteCount, 1);
  assert.equal(undoCount, 0);
  assert.equal(helpCount, 0);

  // On non-editable grid cell button: Ctrl+Z & ? work cleanly
  dispatchKeyboardShortcut({key: 'z', ctrlKey: true}, {tagName: 'BUTTON'}, handlers);
  dispatchKeyboardShortcut({key: '?', shiftKey: true}, {tagName: 'BUTTON'}, handlers);
  assert.equal(undoCount, 1);
  assert.equal(helpCount, 1);
  assert.equal(matchesShortcut({key: '?', shiftKey: true}, {key: '?'}), true);
});
