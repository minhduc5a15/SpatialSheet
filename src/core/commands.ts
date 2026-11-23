import type {
  AnalyticalSelection,
  CellCoord,
  ChartType,
  ColumnViewState,
  DatasetProfile,
  SheetData,
  WorkbookState,
  WorkspaceLayout,
} from '../types';
import {columnIndexToLetter} from './tabular';
import {evaluateSeriesEligibility} from '../ui/ChartSeriesManager';
import type {ShortcutKeyCombo} from './shortcuts';

export type CommandCategory =
  | 'Contextual'
  | 'Navigation'
  | 'Columns'
  | 'Sheets'
  | 'Charts & 3D'
  | 'Workbook & Data'
  | 'Inspector & Help';

export type CommandIconName =
  | 'overview'
  | 'split'
  | 'table'
  | 'barChart'
  | 'lineChart'
  | 'pieChart'
  | 'scatterChart'
  | 'cube3d'
  | 'columns'
  | 'sliders'
  | 'pin'
  | 'eye'
  | 'eyeOff'
  | 'maximize'
  | 'search'
  | 'filter'
  | 'layers'
  | 'plus'
  | 'upload'
  | 'download'
  | 'undo'
  | 'redo'
  | 'compass'
  | 'keyboard'
  | 'help'
  | 'info'
  | 'xr';

export interface CommandToastFeedback {
  kind: 'success' | 'info' | 'error';
  message: string;
}

export interface CommandExecutionResult {
  ok: boolean;
  toast?: CommandToastFeedback;
  /** When true, palette stays open (used if action expects sub-interaction or failed validation) */
  keepOpen?: boolean;
}

export interface AppCommand {
  id: string;
  title: string;
  subtitle?: string;
  category: CommandCategory;
  keywords?: string[];
  shortcut?: ShortcutKeyCombo;
  icon: CommandIconName;
  badge?: string;
  contextWeight?: number;
  isAvailable?: boolean;
  isEnabled?: boolean;
  disabledReason?: string;
  execute: () => CommandExecutionResult | Promise<CommandExecutionResult>;
}

export interface CommandContext {
  workbook: WorkbookState;
  activeSheet: SheetData;
  activeColumnView: ColumnViewState;
  datasetProfile: DatasetProfile | null;
  layout: WorkspaceLayout;
  chartPanelMode: '2d' | '3d';
  chartType: ChartType;
  xColIndex: number;
  selectedCell: CellCoord | null;
  analyticalSelection: AnalyticalSelection | null;
  canUndo: boolean;
  canRedo: boolean;
  isInspectorOpen: boolean;
  hasGroupFilter: boolean;
  hasSearchOrSort: boolean;
  is3DStageVisible: boolean;

  setLayout: (layout: WorkspaceLayout) => void;
  setChartPanelMode: (mode: '2d' | '3d') => void;
  focusColumnInTable: (colIndex: number, rowIndex?: number, targetLayout?: WorkspaceLayout) => void;
  toggleColumnPin: (colIndex: number) => void;
  toggleColumnVisibility: (colIndex: number) => void;
  restoreAllColumns: () => void;
  resetColumnView: () => void;
  autoFitColumn: (colIndex: number) => void;
  useColumnAsChartX: (colIndex: number, targetLayout?: WorkspaceLayout) => void;
  addColumnAsChartY: (
    colIndex: number,
    targetLayout?: WorkspaceLayout
  ) => {applied: boolean; reason: string | null};
  setChartType: (type: ChartType) => void;
  resetChart: () => void;
  toggleInspector: () => void;
  clearSelection: () => void;
  filterToSelectionGroup: () => void | Promise<void>;
  inspectContributingRecords: () => void;
  clearSearch: () => void;
  switchSheet: (sheetIndex: number) => void;
  addNewSheet: () => void;
  addRow: () => void;
  addColumn: () => void;
  undo: () => void;
  redo: () => void;
  openFilePicker: () => void;
  newBlankWorkbook: () => void;
  exportCsv: () => void;
  exportXlsx: () => void;
  openColumnManager: () => void;
  openSeriesManager: () => void;
  focusSearch: () => void;
  openShortcutsHelp: () => void;
  reset3DCamera: () => void;
}

export function validateCommandRegistry(commands: readonly AppCommand[]): void {
  const seen = new Set<string>();
  for (const cmd of commands) {
    if (!cmd.id) {
      throw new Error('Command definition missing required id');
    }
    if (seen.has(cmd.id)) {
      throw new Error(`Duplicate command id detected: "${cmd.id}"`);
    }
    seen.add(cmd.id);
  }
}

export function buildDuplicateColumnNameCounts(columns: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const name of columns) {
    const key = name.trim().toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function formatColumnDisambiguatedLabel(
  columns: readonly string[],
  colIndex: number,
  duplicateCounts?: ReadonlyMap<string, number>
): {titleName: string; refLabel: string; hasDuplicateName: boolean} {
  const rawName = columns[colIndex] ?? `Column ${colIndex + 1}`;
  const letter = columnIndexToLetter(colIndex);
  const counts = duplicateCounts ?? buildDuplicateColumnNameCounts(columns);
  const hasDuplicateName = (counts.get(rawName.trim().toLowerCase()) ?? 0) > 1;
  const refLabel = hasDuplicateName ? `${letter} · #${colIndex + 1}` : letter;
  return {
    titleName: hasDuplicateName ? `${rawName} (${letter}, col #${colIndex + 1})` : `${rawName} (${letter})`,
    refLabel,
    hasDuplicateName,
  };
}

export function buildAppCommands(ctx: CommandContext): AppCommand[] {
  const commands: AppCommand[] = [];
  const sheet = ctx.activeSheet;
  const view = ctx.activeColumnView;
  const hiddenSet = new Set(view.hidden);
  const pinnedSet = new Set(view.pinned);
  const visibleColCount = Math.max(0, sheet.columns.length - hiddenSet.size);
  const dupCounts = buildDuplicateColumnNameCounts(sheet.columns);

  const selectedColIdx =
    ctx.selectedCell?.colIndex ??
    (ctx.analyticalSelection && ctx.analyticalSelection.colIndex >= 0
      ? ctx.analyticalSelection.colIndex
      : null);

  // 1. Contextual commands based on active selection, filters, and layout
  if (
    selectedColIdx !== null &&
    selectedColIdx >= 0 &&
    selectedColIdx < sheet.columns.length
  ) {
    const {titleName} = formatColumnDisambiguatedLabel(sheet.columns, selectedColIdx, dupCounts);
    const isHidden = hiddenSet.has(selectedColIdx);
    const isPinned = pinnedSet.has(selectedColIdx);
    const yElig = evaluateSeriesEligibility(
      sheet,
      ctx.datasetProfile,
      selectedColIdx,
      ctx.xColIndex
    );

    commands.push({
      id: 'context.col.focus',
      title: isHidden
        ? `Unhide & Focus Selected Column: ${titleName}`
        : `Focus Selected Column in Table: ${titleName}`,
      subtitle: 'Jump to the active column in the spreadsheet view',
      category: 'Contextual',
      keywords: ['focus', 'column', 'selected', 'reveal', 'table', sheet.columns[selectedColIdx] ?? ''],
      icon: 'columns',
      badge: 'Selected',
      contextWeight: 95,
      execute: () => {
        ctx.focusColumnInTable(selectedColIdx);
        return {
          ok: true,
          toast: {kind: 'info', message: `Focused ${titleName}`},
        };
      },
    });

    commands.push({
      id: 'context.col.pin',
      title: isPinned
        ? `Unpin Selected Column: ${titleName}`
        : `Pin Selected Column Left: ${titleName}`,
      subtitle: isPinned ? 'Return column to scrollable strip' : 'Freeze column on left edge of table',
      category: 'Contextual',
      keywords: ['pin', 'unpin', 'freeze', 'selected', sheet.columns[selectedColIdx] ?? ''],
      icon: 'pin',
      badge: isPinned ? 'Pinned' : undefined,
      contextWeight: 90,
      execute: () => {
        ctx.toggleColumnPin(selectedColIdx);
        return {
          ok: true,
          toast: {
            kind: 'success',
            message: `${isPinned ? 'Unpinned' : 'Pinned'} ${titleName}`,
          },
        };
      },
    });

    const canToggleHide = isHidden || visibleColCount > 1;
    commands.push({
      id: 'context.col.hide',
      title: isHidden
        ? `Show Selected Column: ${titleName}`
        : `Hide Selected Column: ${titleName}`,
      subtitle: 'Adjust visual visibility without altering workbook export order',
      category: 'Contextual',
      keywords: ['hide', 'show', 'visibility', 'selected', sheet.columns[selectedColIdx] ?? ''],
      icon: isHidden ? 'eye' : 'eyeOff',
      isEnabled: canToggleHide,
      disabledReason: canToggleHide ? undefined : 'At least one visible column is required',
      contextWeight: 85,
      execute: () => {
        if (!canToggleHide) {
          return {
            ok: false,
            keepOpen: true,
            toast: {kind: 'error', message: 'Cannot hide the last visible column.'},
          };
        }
        ctx.toggleColumnVisibility(selectedColIdx);
        return {
          ok: true,
          toast: {
            kind: 'info',
            message: `${isHidden ? 'Shown' : 'Hidden'} ${titleName}`,
          },
        };
      },
    });

    commands.push({
      id: 'context.col.useX',
      title: `Use ${titleName} as Chart X Axis`,
      subtitle: 'Plot this column along the horizontal chart axis',
      category: 'Contextual',
      keywords: ['chart', 'x axis', 'domain', 'selected', sheet.columns[selectedColIdx] ?? ''],
      icon: 'barChart',
      contextWeight: 82,
      execute: () => {
        const dest: WorkspaceLayout =
          ctx.layout === 'charts' || ctx.layout === 'split' ? ctx.layout : 'charts';
        ctx.useColumnAsChartX(selectedColIdx, dest);
        return {
          ok: true,
          toast: {kind: 'success', message: `Chart X axis set to ${titleName}`},
        };
      },
    });

    commands.push({
      id: 'context.col.useY',
      title: `Use ${titleName} as Chart Y Series`,
      subtitle: yElig.eligible
        ? 'Add this numeric series to 2D charts'
        : yElig.reason ?? 'Requires a numeric or boolean column',
      category: 'Contextual',
      keywords: ['chart', 'y series', 'metric', 'plot', 'selected', sheet.columns[selectedColIdx] ?? ''],
      icon: 'lineChart',
      isEnabled: yElig.eligible,
      disabledReason: yElig.reason ?? undefined,
      contextWeight: 81,
      execute: () => {
        const dest: WorkspaceLayout =
          ctx.layout === 'charts' || ctx.layout === 'split' ? ctx.layout : 'charts';
        const res = ctx.addColumnAsChartY(selectedColIdx, dest);
        if (!res.applied) {
          return {
            ok: false,
            keepOpen: true,
            toast: {kind: 'error', message: res.reason ?? 'Column is not eligible as a Y series.'},
          };
        }
        return {
          ok: true,
          toast: {kind: 'success', message: `Added ${titleName} to chart Y series`},
        };
      },
    });
  }

  if (ctx.analyticalSelection?.kind === 'aggregate') {
    const aggSel = ctx.analyticalSelection;
    commands.push({
      id: 'context.inspector.contributors',
      title: `Inspect Contributing Records (${aggSel.representedRowCount} rows)`,
      subtitle: `View underlying source rows for "${aggSel.label}" in Data Inspector`,
      category: 'Contextual',
      keywords: ['inspector', 'contributors', 'drilldown', 'aggregate', 'source rows', aggSel.label],
      icon: 'info',
      badge: 'Aggregate',
      contextWeight: 98,
      execute: () => {
        ctx.inspectContributingRecords();
        return {
          ok: true,
          toast: {kind: 'info', message: `Opened contributing records for ${aggSel.label}`},
        };
      },
    });

    const canFilterGroup = Boolean(aggSel.query?.fields.length);
    commands.push({
      id: 'context.inspector.filterGroup',
      title: `Filter Table to Group "${aggSel.label}"`,
      subtitle: canFilterGroup
        ? 'Restrict spreadsheet rows to members of the selected aggregate group'
        : 'Grouping fields unavailable for combined multi-category selection',
      category: 'Contextual',
      keywords: ['filter', 'group', 'drilldown', 'aggregate', aggSel.label],
      icon: 'filter',
      isEnabled: canFilterGroup,
      disabledReason: canFilterGroup ? undefined : 'Selected aggregate has no filterable group predicate',
      contextWeight: 96,
      execute: async () => {
        if (!canFilterGroup) {
          return {ok: false, keepOpen: true};
        }
        await ctx.filterToSelectionGroup();
        return {
          ok: true,
          toast: {kind: 'success', message: `Filtered rows to group "${aggSel.label}"`},
        };
      },
    });
  }

  if (ctx.hasGroupFilter || ctx.hasSearchOrSort) {
    commands.push({
      id: 'context.filter.clear',
      title: 'Clear Active Search, Sort & Group Filter',
      subtitle: 'Restore all sheet rows in the spreadsheet and visualizations',
      category: 'Contextual',
      keywords: ['clear', 'reset', 'filter', 'search', 'sort', 'group filter'],
      icon: 'filter',
      badge: 'Active',
      contextWeight: 94,
      execute: () => {
        ctx.clearSearch();
        return {
          ok: true,
          toast: {kind: 'info', message: 'Cleared active filters and sort'},
        };
      },
    });
  }

  // 2. Navigation commands
  const navSpecs: Array<{
    id: string;
    layout: WorkspaceLayout;
    title: string;
    subtitle: string;
    keywords: string[];
    icon: CommandIconName;
  }> = [
    {
      id: 'nav.overview',
      layout: 'overview',
      title: 'Go to Dataset Overview',
      subtitle: 'Inspect dataset summary, semantic roles, quality checks, and suggestions',
      keywords: ['overview', 'profile', 'quality', 'summary', 'home'],
      icon: 'overview',
    },
    {
      id: 'nav.split',
      layout: 'split',
      title: 'Go to Split View',
      subtitle: 'Work side-by-side with the spreadsheet grid and charts or 3D stage',
      keywords: ['split', 'workspace', 'dual', 'side by side'],
      icon: 'split',
    },
    {
      id: 'nav.table',
      layout: 'table',
      title: 'Go to Table View',
      subtitle: 'Focus full-width on the virtualized spreadsheet grid',
      keywords: ['table', 'grid', 'spreadsheet', 'rows', 'cells'],
      icon: 'table',
    },
    {
      id: 'nav.charts',
      layout: 'charts',
      title: 'Go to 2D Charts View',
      subtitle: 'Configure bar, line, pie, and scatter charts',
      keywords: ['charts', '2d', 'bar', 'line', 'pie', 'scatter', 'plot'],
      icon: 'barChart',
    },
    {
      id: 'nav.spatial',
      layout: 'spatial',
      title: 'Go to 3D Stage View',
      subtitle: 'Explore 3D bars, scatter, and ring spatial visualizations',
      keywords: ['3d', 'spatial', 'xr', 'stage', 'canvas'],
      icon: 'cube3d',
    },
  ];

  for (const spec of navSpecs) {
    const isCurrent = ctx.layout === spec.layout;
    commands.push({
      id: spec.id,
      title: spec.title,
      subtitle: spec.subtitle,
      category: 'Navigation',
      keywords: spec.keywords,
      icon: spec.icon,
      badge: isCurrent ? 'Current' : undefined,
      contextWeight: isCurrent ? 10 : 40,
      execute: () => {
        ctx.setLayout(spec.layout);
        return {ok: true};
      },
    });
  }

  commands.push({
    id: 'nav.viz2d',
    title: 'Switch Visualization to 2D Charts',
    subtitle: 'Show the interactive 2D SVG chart inside Split or Charts mode',
    category: 'Navigation',
    keywords: ['2d', 'chart mode', 'switch visualization'],
    icon: 'barChart',
    badge: ctx.chartPanelMode === '2d' && (ctx.layout === 'split' || ctx.layout === 'charts') ? 'Current' : undefined,
    execute: () => {
      if (ctx.layout !== 'split' && ctx.layout !== 'charts') {
        ctx.setLayout('charts');
      } else {
        ctx.setChartPanelMode('2d');
      }
      return {ok: true};
    },
  });

  commands.push({
    id: 'nav.viz3d',
    title: 'Switch Visualization to 3D Stage',
    subtitle: 'Show the Three.js / XR Blocks 3D data stage',
    category: 'Navigation',
    keywords: ['3d', 'stage', 'spatial', 'switch visualization'],
    icon: 'cube3d',
    badge: ctx.chartPanelMode === '3d' && (ctx.layout === 'split' || ctx.layout === 'spatial') ? 'Current' : undefined,
    execute: () => {
      if (ctx.layout !== 'split' && ctx.layout !== 'spatial') {
        ctx.setLayout('split');
      }
      ctx.setChartPanelMode('3d');
      return {ok: true};
    },
  });

  commands.push({
    id: 'nav.inspector',
    title: ctx.isInspectorOpen ? 'Close Data Inspector' : 'Open Data Inspector',
    subtitle: 'Inspect source records, full field text, and contributing aggregate rows',
    category: 'Navigation',
    keywords: ['inspector', 'data inspector', 'drawer', 'panel', 'details'],
    icon: 'info',
    badge: ctx.isInspectorOpen ? 'Open' : undefined,
    contextWeight: 45,
    execute: () => {
      ctx.toggleInspector();
      return {ok: true};
    },
  });

  commands.push({
    id: 'nav.focusSearch',
    title: 'Focus Table Search Input',
    subtitle: 'Filter active sheet rows by text query',
    category: 'Navigation',
    keywords: ['search', 'find', 'filter rows'],
    shortcut: {ctrlOrCmd: true, key: 'f'},
    icon: 'search',
    contextWeight: 42,
    execute: () => {
      ctx.focusSearch();
      return {ok: true};
    },
  });

  // 3. Charts & 3D commands
  const chartTypes: Array<{type: ChartType; label: string; icon: CommandIconName}> = [
    {type: 'bar', label: 'Bar Chart', icon: 'barChart'},
    {type: 'line', label: 'Line Chart', icon: 'lineChart'},
    {type: 'pie', label: 'Pie Chart', icon: 'pieChart'},
    {type: 'scatter', label: 'Scatter Chart', icon: 'scatterChart'},
  ];

  for (const ct of chartTypes) {
    commands.push({
      id: `chart.type.${ct.type}`,
      title: `Switch Chart Type to ${ct.label}`,
      subtitle: 'Apply chart visualization type and open 2D chart view if hidden',
      category: 'Charts & 3D',
      keywords: ['chart', 'type', ct.type, ct.label.toLowerCase()],
      icon: ct.icon,
      badge: ctx.chartType === ct.type ? 'Current' : undefined,
      execute: () => {
        if (ctx.layout === 'overview' || ctx.layout === 'table' || ctx.layout === 'spatial') {
          ctx.setLayout('charts');
        } else if (ctx.layout === 'split' && ctx.chartPanelMode !== '2d') {
          ctx.setChartPanelMode('2d');
        }
        ctx.setChartType(ct.type);
        return {
          ok: true,
          toast: {kind: 'info', message: `Switched chart to ${ct.label}`},
        };
      },
    });
  }

  commands.push({
    id: 'chart.seriesManager',
    title: 'Open Chart Series Manager',
    subtitle: 'Search, toggle, and apply series presets across numeric columns',
    category: 'Charts & 3D',
    keywords: ['series', 'chart series manager', 'y axis', 'metrics'],
    icon: 'sliders',
    execute: () => {
      if (ctx.layout === 'overview' || ctx.layout === 'table' || ctx.layout === 'spatial') {
        ctx.setLayout('charts');
      } else if (ctx.layout === 'split' && ctx.chartPanelMode !== '2d') {
        ctx.setChartPanelMode('2d');
      }
      ctx.openSeriesManager();
      return {ok: true};
    },
  });

  commands.push({
    id: 'chart.reset',
    title: 'Reset Chart Configuration',
    subtitle: 'Restore recommended X/Y columns and default chart settings',
    category: 'Charts & 3D',
    keywords: ['reset chart', 'defaults', 'chart'],
    icon: 'barChart',
    execute: () => {
      ctx.resetChart();
      return {
        ok: true,
        toast: {kind: 'info', message: 'Reset chart configuration to recommended defaults'},
      };
    },
  });

  commands.push({
    id: 'spatial.resetCamera',
    title: 'Reset 3D Camera Position',
    subtitle: 'Recenter orbit camera on the active 3D spatial visualization',
    category: 'Charts & 3D',
    keywords: ['3d', 'camera', 'reset view', 'recenter', 'spatial'],
    icon: 'compass',
    isEnabled: ctx.is3DStageVisible,
    disabledReason: ctx.is3DStageVisible
      ? undefined
      : 'Switch to 3D Stage or Split (3D) first to recenter the 3D camera',
    execute: () => {
      if (!ctx.is3DStageVisible) {
        return {
          ok: false,
          keepOpen: true,
          toast: {kind: 'error', message: '3D Stage is not currently visible.'},
        };
      }
      ctx.reset3DCamera();
      return {
        ok: true,
        toast: {kind: 'info', message: 'Reset 3D camera view'},
      };
    },
  });

  // 4. Workbook & Data commands
  commands.push({
    id: 'workbook.open',
    title: 'Open CSV / Excel File…',
    subtitle: 'Import a CSV, TSV, Excel (.xlsx/.xls), ODS, or JSON workbook locally',
    category: 'Workbook & Data',
    keywords: ['open', 'import', 'upload', 'csv', 'excel', 'xlsx', 'file'],
    icon: 'upload',
    contextWeight: 35,
    execute: () => {
      ctx.openFilePicker();
      return {ok: true};
    },
  });

  commands.push({
    id: 'workbook.new',
    title: 'New Blank Workbook',
    subtitle: 'Start a fresh empty spreadsheet workbook',
    category: 'Workbook & Data',
    keywords: ['new sheet', 'blank', 'clear workbook', 'fresh'],
    icon: 'plus',
    execute: () => {
      ctx.newBlankWorkbook();
      return {
        ok: true,
        toast: {kind: 'info', message: 'Created new blank workbook'},
      };
    },
  });

  commands.push({
    id: 'workbook.exportCsv',
    title: 'Export Active Sheet as CSV',
    subtitle: `Download "${sheet.name}" in source column order as CSV`,
    category: 'Workbook & Data',
    keywords: ['export', 'download', 'csv', 'save'],
    icon: 'download',
    execute: () => {
      ctx.exportCsv();
      return {
        ok: true,
        toast: {kind: 'success', message: `Exported "${sheet.name}" as CSV`},
      };
    },
  });

  commands.push({
    id: 'workbook.exportXlsx',
    title: 'Export Workbook as Excel (.xlsx)',
    subtitle: 'Download all sheets in this workbook as an Excel file',
    category: 'Workbook & Data',
    keywords: ['export', 'download', 'excel', 'xlsx', 'workbook', 'save'],
    icon: 'download',
    execute: () => {
      ctx.exportXlsx();
      return {
        ok: true,
        toast: {kind: 'success', message: `Exported "${ctx.workbook.fileName}" as Excel`},
      };
    },
  });

  commands.push({
    id: 'workbook.undo',
    title: 'Undo Workbook Change',
    subtitle: ctx.canUndo ? 'Revert last cell edit or sheet change' : 'No actions to undo',
    category: 'Workbook & Data',
    keywords: ['undo', 'revert', 'history'],
    shortcut: {ctrlOrCmd: true, key: 'z'},
    icon: 'undo',
    isEnabled: ctx.canUndo,
    disabledReason: ctx.canUndo ? undefined : 'Nothing to undo yet',
    execute: () => {
      if (!ctx.canUndo) {
        return {ok: false, keepOpen: true};
      }
      ctx.undo();
      return {ok: true};
    },
  });

  commands.push({
    id: 'workbook.redo',
    title: 'Redo Workbook Change',
    subtitle: ctx.canRedo ? 'Reapply last undone workbook change' : 'No actions to redo',
    category: 'Workbook & Data',
    keywords: ['redo', 'reapply', 'history'],
    shortcut: {ctrlOrCmd: true, shift: true, key: 'z'},
    icon: 'redo',
    isEnabled: ctx.canRedo,
    disabledReason: ctx.canRedo ? undefined : 'Nothing to redo',
    execute: () => {
      if (!ctx.canRedo) {
        return {ok: false, keepOpen: true};
      }
      ctx.redo();
      return {ok: true};
    },
  });

  commands.push({
    id: 'sheet.add',
    title: 'Add New Sheet',
    subtitle: 'Append a new empty tab to the current workbook',
    category: 'Sheets',
    keywords: ['add sheet', 'new tab', 'worksheet'],
    icon: 'layers',
    execute: () => {
      ctx.addNewSheet();
      return {
        ok: true,
        toast: {kind: 'success', message: 'Added new sheet'},
      };
    },
  });

  commands.push({
    id: 'sheet.addRow',
    title: 'Add Row to Active Sheet',
    subtitle: `Append a blank row to "${sheet.name}"`,
    category: 'Workbook & Data',
    keywords: ['add row', 'insert row', 'append row'],
    icon: 'plus',
    execute: () => {
      ctx.addRow();
      return {
        ok: true,
        toast: {kind: 'success', message: 'Added new row'},
      };
    },
  });

  commands.push({
    id: 'sheet.addColumn',
    title: 'Add Column to Active Sheet',
    subtitle: `Append a new column to "${sheet.name}"`,
    category: 'Workbook & Data',
    keywords: ['add column', 'insert column', 'append column'],
    icon: 'plus',
    execute: () => {
      ctx.addColumn();
      return {
        ok: true,
        toast: {kind: 'success', message: 'Added new column'},
      };
    },
  });

  // 5. Dynamic Sheet Switching commands
  ctx.workbook.sheets.forEach((s, idx) => {
    const isActive = idx === ctx.workbook.activeSheetIndex;
    commands.push({
      id: `sheet.switch.${idx}`,
      title: `Switch to Sheet "${s.name}"`,
      subtitle: `${s.rows.length.toLocaleString('en-US')} rows · ${s.columns.length} cols${
        isActive ? ' · Current active sheet' : ''
      }`,
      category: 'Sheets',
      keywords: ['sheet', 'tab', 'switch', s.name],
      icon: 'layers',
      badge: isActive ? 'Active' : undefined,
      isEnabled: !isActive,
      disabledReason: isActive ? 'Already viewing this sheet' : undefined,
      contextWeight: isActive ? 5 : 25,
      execute: () => {
        if (isActive) {
          return {ok: false, keepOpen: true};
        }
        ctx.switchSheet(idx);
        return {
          ok: true,
          toast: {kind: 'info', message: `Switched to sheet "${s.name}"`},
        };
      },
    });
  });

  // 6. Global Column Management commands + Per-column Dynamic Commands
  commands.push({
    id: 'col.manager',
    title: 'Open Column Manager',
    subtitle: 'Search, pin, hide, reorder, auto-fit, or delete columns',
    category: 'Columns',
    keywords: ['column manager', 'columns', 'reorder', 'hide', 'pin'],
    icon: 'columns',
    contextWeight: 38,
    execute: () => {
      if (ctx.layout === 'overview' || ctx.layout === 'charts' || ctx.layout === 'spatial') {
        ctx.setLayout('split');
      }
      ctx.openColumnManager();
      return {ok: true};
    },
  });

  commands.push({
    id: 'col.restoreAll',
    title: 'Show All Hidden Columns',
    subtitle:
      hiddenSet.size > 0
        ? `Unhide ${hiddenSet.size} hidden column${hiddenSet.size === 1 ? '' : 's'} in "${sheet.name}"`
        : 'All columns are currently visible',
    category: 'Columns',
    keywords: ['show all', 'unhide', 'hidden columns', 'restore'],
    icon: 'eye',
    isEnabled: hiddenSet.size > 0,
    disabledReason: hiddenSet.size > 0 ? undefined : 'No columns are currently hidden',
    execute: () => {
      if (hiddenSet.size === 0) {
        return {ok: false, keepOpen: true};
      }
      ctx.restoreAllColumns();
      return {
        ok: true,
        toast: {kind: 'success', message: 'Restored all hidden columns'},
      };
    },
  });

  commands.push({
    id: 'col.resetView',
    title: 'Reset Column Order, Pins & Widths',
    subtitle: 'Restore default source column layout without changing data',
    category: 'Columns',
    keywords: ['reset columns', 'column layout', 'widths', 'unpin'],
    icon: 'columns',
    execute: () => {
      ctx.resetColumnView();
      return {
        ok: true,
        toast: {kind: 'info', message: 'Reset column view to default order and widths'},
      };
    },
  });

  // Dynamic column commands (preserve source colIndex identity)
  const includeBulkColumnSubActions = sheet.columns.length <= 120;
  for (let colIndex = 0; colIndex < sheet.columns.length; colIndex++) {
    const rawName = sheet.columns[colIndex] ?? `Column ${colIndex + 1}`;
    const letter = columnIndexToLetter(colIndex);
    const {titleName, refLabel, hasDuplicateName} = formatColumnDisambiguatedLabel(
      sheet.columns,
      colIndex,
      dupCounts
    );
    const isHidden = hiddenSet.has(colIndex);
    const isPinned = pinnedSet.has(colIndex);
    const semType =
      ctx.datasetProfile?.columns[colIndex]?.roleOverride ??
      ctx.datasetProfile?.columns[colIndex]?.semanticType ??
      sheet.types[colIndex] ??
      'text';
    const stateTags = [
      semType,
      isPinned ? 'Pinned' : '',
      isHidden ? 'Hidden' : '',
    ]
      .filter(Boolean)
      .join(' · ');

    commands.push({
      id: `col.focus.${colIndex}`,
      title: `Focus Column: ${titleName}`,
      subtitle: `${
        isHidden ? 'Hidden · Reveals column & focuses cell · ' : ''
      }Source ${refLabel} · ${stateTags}`,
      category: 'Columns',
      keywords: [
        'column',
        'focus',
        'goto',
        'select',
        rawName,
        letter,
        `#${colIndex + 1}`,
        hasDuplicateName ? 'duplicate' : '',
        isHidden ? 'hidden unhide' : '',
      ].filter(Boolean),
      icon: isHidden ? 'eye' : 'columns',
      badge: isHidden ? 'Hidden' : isPinned ? 'Pinned' : undefined,
      contextWeight: isHidden ? 15 : 22,
      execute: () => {
        ctx.focusColumnInTable(colIndex);
        return {
          ok: true,
          toast: {
            kind: 'info',
            message: isHidden
              ? `Revealed and focused column ${titleName}`
              : `Focused column ${titleName}`,
          },
        };
      },
    });

    if (includeBulkColumnSubActions) {
      commands.push({
        id: `col.pin.${colIndex}`,
        title: `${isPinned ? 'Unpin' : 'Pin'} Column: ${titleName}`,
        subtitle: `Source ${refLabel} · ${isPinned ? 'Unfreeze left pin' : 'Keep sticky on left'}`,
        category: 'Columns',
        keywords: ['pin', 'unpin', 'freeze', rawName, letter],
        icon: 'pin',
        badge: isPinned ? 'Pinned' : undefined,
        contextWeight: 12,
        execute: () => {
          ctx.toggleColumnPin(colIndex);
          return {
            ok: true,
            toast: {
              kind: 'success',
              message: `${isPinned ? 'Unpinned' : 'Pinned'} ${titleName}`,
            },
          };
        },
      });

      const canToggleHide = isHidden || visibleColCount > 1;
      commands.push({
        id: `col.vis.${colIndex}`,
        title: `${isHidden ? 'Show' : 'Hide'} Column: ${titleName}`,
        subtitle: `Source ${refLabel} · ${isHidden ? 'Make visible in spreadsheet grid' : 'Hide from grid view'}`,
        category: 'Columns',
        keywords: ['hide', 'show', 'unhide', 'visibility', rawName, letter],
        icon: isHidden ? 'eye' : 'eyeOff',
        isEnabled: canToggleHide,
        disabledReason: canToggleHide ? undefined : 'At least one visible column is required',
        contextWeight: 11,
        execute: () => {
          if (!canToggleHide) {
            return {
              ok: false,
              keepOpen: true,
              toast: {kind: 'error', message: 'Cannot hide the last visible column.'},
            };
          }
          ctx.toggleColumnVisibility(colIndex);
          return {
            ok: true,
            toast: {
              kind: 'info',
              message: `${isHidden ? 'Shown' : 'Hidden'} ${titleName}`,
            },
          };
        },
      });

      commands.push({
        id: `col.useX.${colIndex}`,
        title: `Chart X Axis: ${titleName}`,
        subtitle: `Source ${refLabel} · Assign column as X axis`,
        category: 'Columns',
        keywords: ['chart', 'x axis', 'axis', rawName, letter],
        icon: 'barChart',
        contextWeight: 10,
        execute: () => {
          const dest: WorkspaceLayout =
            ctx.layout === 'charts' || ctx.layout === 'split' ? ctx.layout : 'charts';
          ctx.useColumnAsChartX(colIndex, dest);
          return {
            ok: true,
            toast: {kind: 'success', message: `Chart X axis set to ${titleName}`},
          };
        },
      });

      const yElig = evaluateSeriesEligibility(
        sheet,
        ctx.datasetProfile,
        colIndex,
        ctx.xColIndex
      );
      commands.push({
        id: `col.useY.${colIndex}`,
        title: `Chart Y Series: ${titleName}`,
        subtitle: yElig.eligible
          ? `Source ${refLabel} · Add numeric column to chart Y series`
          : `Source ${refLabel} · ${yElig.reason ?? 'Ineligible for Y series'}`,
        category: 'Columns',
        keywords: ['chart', 'y series', 'series', 'metric', rawName, letter],
        icon: 'lineChart',
        isEnabled: yElig.eligible,
        disabledReason: yElig.reason ?? undefined,
        contextWeight: 10,
        execute: () => {
          const dest: WorkspaceLayout =
            ctx.layout === 'charts' || ctx.layout === 'split' ? ctx.layout : 'charts';
          const res = ctx.addColumnAsChartY(colIndex, dest);
          if (!res.applied) {
            return {
              ok: false,
              keepOpen: true,
              toast: {kind: 'error', message: res.reason ?? 'Column cannot be added as a Y series.'},
            };
          }
          return {
            ok: true,
            toast: {kind: 'success', message: `Added ${titleName} to chart Y series`},
          };
        },
      });
    }
  }

  // 7. Inspector & Help commands
  commands.push({
    id: 'inspector.clearSelection',
    title: 'Clear Active Selection',
    subtitle: 'Deselect active cell, chart point, or spatial item',
    category: 'Inspector & Help',
    keywords: ['clear selection', 'deselect', 'reset selection'],
    icon: 'info',
    isEnabled: Boolean(ctx.selectedCell || ctx.analyticalSelection),
    disabledReason:
      ctx.selectedCell || ctx.analyticalSelection
        ? undefined
        : 'No cell or point currently selected',
    execute: () => {
      ctx.clearSelection();
      return {ok: true};
    },
  });

  commands.push({
    id: 'help.shortcuts',
    title: 'Show Keyboard Shortcuts',
    subtitle: 'View global and spreadsheet keyboard shortcuts',
    category: 'Inspector & Help',
    keywords: ['keyboard', 'shortcuts', 'help', 'hotkeys', 'keybindings'],
    shortcut: {key: '?'},
    icon: 'keyboard',
    contextWeight: 30,
    execute: () => {
      ctx.openShortcutsHelp();
      return {ok: true};
    },
  });

  validateCommandRegistry(commands);
  return commands;
}
