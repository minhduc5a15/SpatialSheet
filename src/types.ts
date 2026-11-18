export type ColumnType = 'text' | 'number' | 'percent';

export type SemanticType =
  | 'quantitative'
  | 'categorical'
  | 'temporal'
  | 'boolean'
  | 'identifier'
  | 'text';

export interface ColumnProfile {
  colIndex: number;
  name: string;
  baseType: ColumnType;
  semanticType: SemanticType;
  unit: string | null;
  missingCount: number;
  nonEmptyCount: number;
  cardinality: number;
  isHighCardinality: boolean;
  min: number | null;
  max: number | null;
  mean: number | null;
  hasNegative: boolean;
  hasZero: boolean;
  hasPositive: boolean;
  sampleCount: number;
  totalRows: number;
  isSampled: boolean;
  roleOverride?: SemanticType;
}

export interface DatasetProfile {
  sheetId: string;
  sheetVersion: number;
  rowCount: number;
  colCount: number;
  columns: ColumnProfile[];
  quantCols: number[];
  catCols: number[];
  temporalCols: number[];
  boolCols: number[];
  idCols: number[];
}

export type ChartType = 'bar' | 'line' | 'pie' | 'scatter';

export type SpatialChartMode = 'bar3d' | 'scatter3d' | 'ring3d';

export type AggregationFn = 'none' | 'sum' | 'avg' | 'min' | 'max' | 'count';

export type SpatialSortOrder = 'source' | 'value-desc' | 'value-asc' | 'label-asc';

export type SamplingStrategy = 'stratified' | 'first-n';

export type ScaleType = 'linear' | 'log';

export type SpatialEnvironmentMode = 'clean' | 'studio';

export interface SpatialConfig {
  xColIndex: number;
  yColIndex: number;
  zColIndex: number | null;
  groupByColIndex: number | null;
  colorColIndex: number | null;
  aggregation: AggregationFn;
  sortOrder: SpatialSortOrder;
  topK: number;
  samplingStrategy: SamplingStrategy;
  sampleLimit: number;
  scaleType: ScaleType;
  environmentMode: SpatialEnvironmentMode;
}

export interface AxisTick {
  value: number;
  normalized: number;
  label: string;
}

export interface AxisCategoryTick {
  index: number;
  normalized: number;
  label: string;
}

export interface AxisSpec {
  title: string;
  unit: string | null;
  kind: 'quantitative' | 'categorical' | 'temporal';
  min: number;
  max: number;
  scaleType: ScaleType;
  zeroNormalized: number | null;
  numericTicks: AxisTick[];
  categoryTicks: AxisCategoryTick[];
}

export interface SpatialLegendEntry {
  label: string;
  colorHex: string;
  count?: number;
}

export interface SpatialColorLegend {
  kind: 'discrete' | 'continuous' | 'none';
  title: string;
  entries: SpatialLegendEntry[];
  minLabel?: string;
  maxLabel?: string;
}

export interface SpatialDataItem {
  id: number;
  label: string;
  seriesLabel: string;
  colorHex: string;
  xNorm: number;
  yNorm: number;
  yZeroNorm: number;
  zNorm: number;
  xRaw: string | number;
  yValue: number;
  zRaw: string | number | null;
  colorRaw: string | null;
  xUnit: string | null;
  yUnit: string | null;
  zUnit: string | null;
  aggregation: AggregationFn;
  recordCount: number;
  firstRowIndex: number;
  rowIndices: number[];
  aggStats?: {
    sum: number;
    avg: number;
    min: number;
    max: number;
    count: number;
  };
  /** Proportional metrics for Ring / Radial mode */
  proportion?: number;
  angleStart?: number;
  angleEnd?: number;
  /** Group slot counts for Bar width sizing */
  xBucketIndex?: number;
  xBucketCount?: number;
  zBucketIndex?: number;
  zBucketCount?: number;
}

export interface DerivedSpatialDataset {
  mode: SpatialChartMode;
  isValid: boolean;
  validationMessage: string | null;
  warningMessage: string | null;
  dataStateKind: 'raw' | 'sampled' | 'aggregated';
  dataStateSummary: string;
  totalVisibleRows: number;
  representedRowCount: number;
  effectiveScaleType: ScaleType;
  axes: {
    x: AxisSpec;
    y: AxisSpec;
    z: AxisSpec | null;
  };
  legend: SpatialColorLegend;
  items: SpatialDataItem[];
}

export interface ChartRecommendation {
  id: string;
  title: string;
  reason: string;
  targetSurface: '2d' | '3d';
  chartType?: ChartType;
  spatialMode?: SpatialChartMode;
  suggested2D?: Partial<ChartConfig>;
  suggestedSpatial?: Partial<SpatialConfig>;
}

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

export interface VirtualRange {
  start: number;
  end: number;
  total: number;
  offsetTop: number;
  offsetBottom: number;
}

export interface ColumnVirtualRange {
  start: number;
  end: number;
  total: number;
  leftWidth: number;
  rightWidth: number;
  virtualized: boolean;
}

export interface LoadingState {
  active: boolean;
  message: string;
  progress: number | null;
}

export type AppDomain =
  | 'workbook'
  | 'sheetData'
  | 'visibleRows'
  | 'selection'
  | 'stats'
  | 'profile'
  | 'chartConfig'
  | 'spatialData'
  | 'chartHighlight'
  | 'layout'
  | 'vizMode'
  | 'loading'
  | 'error'
  | 'history';

export type VisibleRowsSource = number[] | Int32Array;
