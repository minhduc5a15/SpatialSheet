export type ColumnType = 'text' | 'number' | 'percent';

export type ChartType = 'bar' | 'line' | 'pie' | 'scatter';

export type SpatialChartMode = 'bar3d' | 'scatter3d' | 'ring3d';

export type WorkspaceLayout = 'split' | 'table' | 'charts' | 'spatial';

export type SortDirection = 'asc' | 'desc' | null;

export interface SortState {
  colIndex: number | null;
  direction: SortDirection;
}

export interface SheetData {
  id: string;
  name: string;
  columns: string[];
  rows: string[][];
  types: ColumnType[];
}

export interface WorkbookState {
  fileName: string;
  fileFormat: 'csv' | 'tsv' | 'xlsx' | 'json' | 'blank';
  sheets: SheetData[];
  activeSheetIndex: number;
}

export interface ColumnStats {
  count: number;
  nonEmptyCount: number;
  numericCount: number;
  uniqueCount: number;
  sum: number;
  avg: number;
  min: number;
  max: number;
}

export interface CellCoord {
  rowIndex: number;
  colIndex: number;
}

export interface ChartConfig {
  type: ChartType;
  xColIndex: number;
  yColIndices: number[];
  spatialMode: SpatialChartMode;
}
