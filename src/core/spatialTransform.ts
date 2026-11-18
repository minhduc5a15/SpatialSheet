import type {
  AggregationFn,
  AxisCategoryTick,
  AxisSpec,
  AxisTick,
  ChartConfig,
  ColumnProfile,
  ColumnType,
  DatasetProfile,
  DerivedSpatialDataset,
  ScaleType,
  SemanticType,
  SheetData,
  SpatialChartMode,
  SpatialColorLegend,
  SpatialConfig,
  SpatialDataItem,
  SpatialLegendEntry,
  VisibleRowsSource,
} from '../types';
import {
  getEffectiveSemanticType,
  parseTemporalValue,
} from './dataProfiler';
import {CHART_PALETTE, formatDisplayNumber, parseNumericValue} from './tabular';
import {sampleChartIndices} from './virtualWindow';

const MAX_BAR_CATEGORIES = 36;
const MAX_GROUP_SERIES = 8;
const MAX_RING_SLICES = 10;
const MAX_INSPECTOR_ROW_REFS = 100;

/** 5-stop perceptually distinct sequential ramp (cool blue -> cyan -> emerald -> amber -> rose) */
const CONTINUOUS_RAMP = [
  '#2563eb',
  '#06b6d4',
  '#10b981',
  '#f59e0b',
  '#e11d48',
];

export interface AggregationOptionStatus {
  fn: AggregationFn;
  label: string;
  enabled: boolean;
  reason?: string;
}

export function isQuantitativeOrTemporal(role: SemanticType): boolean {
  return role === 'quantitative' || role === 'temporal' || role === 'boolean';
}

export function getValidAggregations(
  yCol: ColumnProfile | undefined,
  mode: SpatialChartMode
): AggregationOptionStatus[] {
  const yRole = yCol ? getEffectiveSemanticType(yCol) : 'text';
  const ySupportsNumericMath = yRole === 'quantitative' || yRole === 'boolean';

  const all: {fn: AggregationFn; label: string}[] = [
    {fn: 'none', label: 'Raw (None)'},
    {fn: 'avg', label: 'Average'},
    {fn: 'sum', label: 'Sum'},
    {fn: 'min', label: 'Min'},
    {fn: 'max', label: 'Max'},
    {fn: 'count', label: 'Count'},
  ];

  return all.map((item) => {
    if (mode === 'ring3d' && (item.fn === 'none' || item.fn === 'avg' || item.fn === 'min' || item.fn === 'max')) {
      return {
        ...item,
        enabled: false,
        reason: 'Proportional 3D Ring requires Sum or Count aggregation.',
      };
    }
    if (
      item.fn !== 'count' &&
      item.fn !== 'none' &&
      !ySupportsNumericMath
    ) {
      return {
        ...item,
        enabled: false,
        reason: `Column "${yCol?.name ?? 'Y'}" is ${yRole}; only Count is valid.`,
      };
    }
    if (item.fn === 'none' && !ySupportsNumericMath && mode !== 'scatter3d') {
      return {
        ...item,
        enabled: false,
        reason: `Column "${yCol?.name ?? 'Y'}" is non-numeric; use Count aggregation.`,
      };
    }
    return {...item, enabled: true};
  });
}

export function createDefaultSpatialConfig(
  profile: DatasetProfile,
  fallbackChartConfig?: ChartConfig
): SpatialConfig {
  const colCount = Math.max(1, profile.colCount);

  // Pick X: prefer categorical -> temporal -> boolean -> quant -> 0
  let xColIndex =
    profile.catCols[0] ??
    profile.temporalCols[0] ??
    profile.boolCols[0] ??
    fallbackChartConfig?.xColIndex ??
    0;
  xColIndex = Math.max(0, Math.min(xColIndex, colCount - 1));

  // Pick Y: prefer first quantitative column distinct from X
  let yColIndex =
    profile.quantCols.find((c) => c !== xColIndex) ??
    profile.quantCols[0] ??
    fallbackChartConfig?.yColIndices.find((c) => c < colCount) ??
    Math.min(1, colCount - 1);
  yColIndex = Math.max(0, Math.min(yColIndex, colCount - 1));

  // Pick Z: second quantitative (or temporal) distinct from X and Y for 3D Scatter
  const quantOrTemp = [...profile.quantCols, ...profile.temporalCols];
  const zColIndex =
    quantOrTemp.find((c) => c !== xColIndex && c !== yColIndex) ??
    quantOrTemp.find((c) => c !== yColIndex) ??
    null;

  // Pick Group By: low-cardinality categorical/boolean distinct from X & Y when multiple records share X
  const xProfile = profile.columns[xColIndex];
  const hasRepeatedX =
    xProfile !== undefined &&
    profile.rowCount > Math.max(1, xProfile.cardinality);

  const groupCandidate = [...profile.catCols, ...profile.boolCols].find((c) => {
    if (c === xColIndex || c === yColIndex) return false;
    const p = profile.columns[c];
    return p && p.cardinality >= 2 && p.cardinality <= MAX_GROUP_SERIES;
  });
  const groupByColIndex =
    hasRepeatedX && groupCandidate !== undefined ? groupCandidate : null;

  // Pick Color encoding for Scatter (low-card category or 4th numeric column)
  const colorColIndex =
    groupCandidate ??
    profile.quantCols.find(
      (c) => c !== xColIndex && c !== yColIndex && c !== zColIndex
    ) ??
    null;

  // Pick sensible aggregation: 'none' if small & unique X, otherwise 'avg'
  const yProfile = profile.columns[yColIndex];
  const yIsQuant =
    yProfile !== undefined &&
    (getEffectiveSemanticType(yProfile) === 'quantitative' ||
      getEffectiveSemanticType(yProfile) === 'boolean');

  let aggregation: AggregationFn = 'none';
  if (!yIsQuant) {
    aggregation = 'count';
  } else if (profile.rowCount > 24 || hasRepeatedX) {
    aggregation = 'avg';
  }

  return {
    xColIndex,
    yColIndex,
    zColIndex,
    groupByColIndex,
    colorColIndex,
    aggregation,
    sortOrder: 'source',
    topK: 16,
    samplingStrategy: 'systematic',
    sampleLimit: 500,
    scaleType: 'linear',
    environmentMode: 'clean',
  };
}

/** Ensures Scatter3D gets sensible 3D coordinate defaults when switching modes. */
export function resolveModeSwitchConfig(
  profile: DatasetProfile,
  current: SpatialConfig,
  nextMode: SpatialChartMode
): SpatialConfig {
  if (nextMode === 'scatter3d') {
    const quantOrTemp = [...profile.quantCols, ...profile.temporalCols];
    let {xColIndex, yColIndex, zColIndex} = current;
    const xRole = profile.columns[xColIndex]
      ? getEffectiveSemanticType(profile.columns[xColIndex])
      : 'text';

    if (quantOrTemp.length >= 3 && !isQuantitativeOrTemporal(xRole)) {
      xColIndex = quantOrTemp[0];
      yColIndex = quantOrTemp[1];
      zColIndex = quantOrTemp[2];
    } else if (zColIndex === null || zColIndex === yColIndex || zColIndex === xColIndex) {
      const candidateZ = quantOrTemp.find(
        (c) => c !== xColIndex && c !== yColIndex
      );
      if (candidateZ !== undefined) {
        zColIndex = candidateZ;
      } else if (quantOrTemp.length >= 2) {
        zColIndex = quantOrTemp.find((c) => c !== yColIndex) ?? quantOrTemp[0];
      }
    }

    return {
      ...current,
      xColIndex,
      yColIndex,
      zColIndex,
      aggregation: 'none',
    };
  }

  if (nextMode === 'ring3d') {
    const nextAgg: AggregationFn =
      current.aggregation === 'count' ? 'count' : 'sum';
    const catFirst = profile.catCols[0] ?? profile.boolCols[0];
    const curXRole = profile.columns[current.xColIndex]
      ? getEffectiveSemanticType(profile.columns[current.xColIndex])
      : 'text';
    const xColIndex =
      catFirst !== undefined && curXRole !== 'categorical'
        ? catFirst
        : current.xColIndex;
    return {
      ...current,
      xColIndex,
      aggregation: nextAgg,
      sortOrder: current.sortOrder === 'source' ? 'value-desc' : current.sortOrder,
      topK: Math.min(current.topK, MAX_RING_SLICES),
    };
  }

  // Switching back to bar3d
  const xFirst =
    profile.catCols[0] ?? profile.temporalCols[0] ?? profile.boolCols[0];
  const curXRole = profile.columns[current.xColIndex]
    ? getEffectiveSemanticType(profile.columns[current.xColIndex])
    : 'text';
  const xColIndex =
    xFirst !== undefined && curXRole === 'quantitative' && profile.catCols.length > 0
      ? xFirst
      : current.xColIndex;
  const yProfile = profile.columns[current.yColIndex];
  const yIsQuant =
    yProfile !== undefined &&
    (getEffectiveSemanticType(yProfile) === 'quantitative' ||
      getEffectiveSemanticType(yProfile) === 'boolean');
  let aggregation = current.aggregation;
  if (!yIsQuant) aggregation = 'count';
  else if (aggregation === 'none' && profile.rowCount > 24) aggregation = 'avg';

  const barTopKOptions = [8, 12, 16, 24, 36];
  const normalizedTopK = barTopKOptions.includes(current.topK)
    ? current.topK
    : barTopKOptions.reduce((best, opt) =>
        Math.abs(opt - current.topK) < Math.abs(best - current.topK) ? opt : best
      );

  return {
    ...current,
    xColIndex,
    aggregation,
    topK: normalizedTopK,
  };
}

function niceStepSize(rawStep: number): number {
  if (!Number.isFinite(rawStep) || rawStep <= 0) return 1;
  const exponent = Math.floor(Math.log10(rawStep));
  const pow10 = Math.pow(10, exponent);
  const fraction = rawStep / pow10;
  let niceFrac = 1;
  if (fraction <= 1) niceFrac = 1;
  else if (fraction <= 2) niceFrac = 2;
  else if (fraction <= 5) niceFrac = 5;
  else niceFrac = 10;
  return niceFrac * pow10;
}

export function formatCompactTick(
  val: number,
  colType: ColumnType = 'number',
  isTemporal = false
): string {
  if (isTemporal) {
    const d = new Date(val);
    if (!Number.isNaN(d.getTime())) {
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }
  }
  if (!Number.isFinite(val)) return '0';
  if (val === 0 || Object.is(val, -0)) {
    return colType === 'percent' ? '0%' : '0';
  }
  const abs = Math.abs(val);
  if (abs >= 1_000_000_000) {
    return `${(val / 1_000_000_000).toFixed(1).replace(/\.0$/, '')}B`;
  }
  if (abs >= 1_000_000) {
    return `${(val / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (abs >= 10_000) {
    return `${(val / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  }
  return formatDisplayNumber(val, colType);
}

export function computeNiceAxisScale(
  rawMin: number,
  rawMax: number,
  options: {
    tickTarget?: number;
    includeZero?: boolean;
    scaleType?: ScaleType;
    colType?: ColumnType;
    isTemporal?: boolean;
  } = {}
): {
  min: number;
  max: number;
  effectiveScaleType: ScaleType;
  fallbackNotice: string | null;
  zeroNormalized: number | null;
  ticks: AxisTick[];
} {
  const tickTarget = Math.max(2, options.tickTarget ?? 5);
  const includeZero = options.includeZero ?? false;
  let desiredScale: ScaleType = options.scaleType ?? 'linear';
  let fallbackNotice: string | null = null;
  const colType = options.colType ?? 'number';
  const isTemporal = options.isTemporal ?? false;

  let minVal = Number.isFinite(rawMin) ? rawMin : 0;
  let maxVal = Number.isFinite(rawMax) ? rawMax : 1;

  if (desiredScale === 'log' && (minVal <= 0 || maxVal <= 0 || isTemporal)) {
    desiredScale = 'linear';
    fallbackNotice =
      'Log scale requires strictly positive values (> 0). Falling back to linear scale.';
  }

  if (desiredScale === 'log') {
    const safeMin = Math.max(Number.MIN_VALUE, minVal);
    const safeMax = Math.max(safeMin * 10, maxVal);
    const expMin = Math.floor(Math.log10(safeMin));
    const expMax = Math.ceil(Math.log10(safeMax));
    const logMin = Math.pow(10, expMin);
    const logMax = Math.pow(10, Math.max(expMin + 1, expMax));
    const spanExp = Math.max(1, Math.log10(logMax) - Math.log10(logMin));

    const ticks: AxisTick[] = [];
    const expStep = Math.max(1, Math.ceil(spanExp / Math.max(2, tickTarget - 1)));
    for (let e = expMin; e <= Math.max(expMin + 1, expMax); e += expStep) {
      const v = Math.pow(10, e);
      const norm = (e - expMin) / spanExp;
      ticks.push({
        value: v,
        normalized: Math.max(0, Math.min(1, norm)),
        label: formatCompactTick(v, colType, false),
      });
    }
    return {
      min: logMin,
      max: logMax,
      effectiveScaleType: 'log',
      fallbackNotice: null,
      zeroNormalized: null,
      ticks,
    };
  }

  if (includeZero) {
    if (minVal > 0) minVal = 0;
    if (maxVal < 0) maxVal = 0;
  }

  const scaleRef = Math.max(0, Math.abs(minVal), Math.abs(maxVal));
  if (Math.abs(maxVal - minVal) <= scaleRef * 1e-12) {
    const pad = Math.abs(minVal) > 1e-30 ? Math.abs(minVal) * 0.2 : 1;
    minVal = includeZero && minVal >= 0 ? 0 : minVal - pad;
    maxVal = includeZero && maxVal <= 0 ? 0 : maxVal + pad;
  }

  const rawRange = maxVal - minVal;
  const step = niceStepSize(rawRange / Math.max(1, tickTarget - 1));
  let scaleMin = Math.floor(minVal / step) * step;
  let scaleMax = Math.ceil(maxVal / step) * step;

  if (includeZero) {
    if (minVal >= 0 && scaleMin > 0) scaleMin = 0;
    if (maxVal <= 0 && scaleMax < 0) scaleMax = 0;
  }

  const span = Math.max(Number.MIN_VALUE, scaleMax - scaleMin);
  const ticks: AxisTick[] = [];
  const stepsCount = Math.round(span / step);
  const maxSteps = Math.min(10, Math.max(1, stepsCount));
  const stride = stepsCount > 8 ? Math.ceil(stepsCount / 6) : 1;

  for (let i = 0; i <= maxSteps * stride; i += stride) {
    const v = scaleMin + i * step;
    if (v > scaleMax + step * 1e-4) break;
    const clampedV = Math.abs(v) < step * 1e-9 ? 0 : v;
    const norm = Math.max(0, Math.min(1, (clampedV - scaleMin) / span));
    ticks.push({
      value: clampedV,
      normalized: norm,
      label: formatCompactTick(clampedV, colType, isTemporal),
    });
  }

  const zeroNormalized =
    scaleMin <= 0 && scaleMax >= 0
      ? Math.max(0, Math.min(1, (0 - scaleMin) / span))
      : null;

  return {
    min: scaleMin,
    max: scaleMax,
    effectiveScaleType: 'linear',
    fallbackNotice,
    zeroNormalized,
    ticks,
  };
}

export function normalizeValueOnAxis(
  value: number,
  min: number,
  max: number,
  scaleType: ScaleType
): number {
  if (!Number.isFinite(value)) return 0;
  if (scaleType === 'log') {
    const safeMin = Math.max(Number.MIN_VALUE, min);
    const safeMax = Math.max(safeMin * 10, max);
    const safeVal = Math.max(safeMin, Math.min(safeMax, value));
    const span = Math.log10(safeMax) - Math.log10(safeMin);
    return Math.max(
      0,
      Math.min(1, (Math.log10(safeVal) - Math.log10(safeMin)) / span)
    );
  }
  const span = Math.max(Number.MIN_VALUE, max - min);
  return Math.max(0, Math.min(1, (value - min) / span));
}

function parseValueForDimension(
  raw: string,
  role: SemanticType
): number | null {
  if (role === 'temporal') {
    return parseTemporalValue(raw);
  }
  if (role === 'boolean') {
    const lower = raw.trim().toLowerCase();
    if (lower === 'true' || lower === 'yes' || lower === 'y' || lower === '1') {
      return 1;
    }
    if (lower === 'false' || lower === 'no' || lower === 'n' || lower === '0') {
      return 0;
    }
    return null;
  }
  return parseNumericValue(raw).value;
}

function interpolateHexColor(t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  const scaled = clamped * (CONTINUOUS_RAMP.length - 1);
  const idx = Math.min(CONTINUOUS_RAMP.length - 2, Math.floor(scaled));
  const localT = scaled - idx;
  const c1 = CONTINUOUS_RAMP[idx];
  const c2 = CONTINUOUS_RAMP[idx + 1];

  const r1 = parseInt(c1.slice(1, 3), 16);
  const g1 = parseInt(c1.slice(3, 5), 16);
  const b1 = parseInt(c1.slice(5, 7), 16);
  const r2 = parseInt(c2.slice(1, 3), 16);
  const g2 = parseInt(c2.slice(3, 5), 16);
  const b2 = parseInt(c2.slice(5, 7), 16);

  const r = Math.round(r1 + (r2 - r1) * localT);
  const g = Math.round(g1 + (g2 - g1) * localT);
  const b = Math.round(b1 + (b2 - b1) * localT);
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

function emptyDerivedDataset(
  mode: SpatialChartMode,
  validationMessage: string | null,
  totalVisibleRows: number,
  xTitle = 'X',
  yTitle = 'Y'
): DerivedSpatialDataset {
  return {
    mode,
    isValid: false,
    validationMessage,
    warningMessage: null,
    dataStateKind: 'raw',
    dataStateSummary: validationMessage ?? 'No plottable data.',
    totalVisibleRows,
    representedRowCount: 0,
    effectiveScaleType: 'linear',
    axes: {
      x: {
        title: xTitle,
        unit: null,
        kind: 'categorical',
        min: 0,
        max: 1,
        scaleType: 'linear',
        zeroNormalized: null,
        numericTicks: [],
        categoryTicks: [],
      },
      y: {
        title: yTitle,
        unit: null,
        kind: 'quantitative',
        min: 0,
        max: 1,
        scaleType: 'linear',
        zeroNormalized: 0,
        numericTicks: [],
        categoryTicks: [],
      },
      z: null,
    },
    legend: {kind: 'none', title: '', entries: []},
    items: [],
  };
}

export function transformSpatialDataset(params: {
  sheet: SheetData;
  visibleRowIndices: VisibleRowsSource;
  profile: DatasetProfile;
  config: SpatialConfig;
  mode: SpatialChartMode;
  yColIndices?: number[];
}): DerivedSpatialDataset {
  const {sheet, visibleRowIndices, profile, config, mode} = params;
  const totalVisible = visibleRowIndices.length;
  const colCount = sheet.columns.length;

  if (totalVisible === 0 || colCount === 0) {
    return emptyDerivedDataset(
      mode,
      'No visible rows match the current filter.',
      totalVisible
    );
  }

  const xColIdx = Math.max(0, Math.min(config.xColIndex, colCount - 1));
  const yColIdx = Math.max(0, Math.min(config.yColIndex, colCount - 1));
  const xProfile = profile.columns[xColIdx];
  const yProfile = profile.columns[yColIdx];
  const xTitle = xProfile?.name ?? sheet.columns[xColIdx] ?? 'X';
  const yTitle = yProfile?.name ?? sheet.columns[yColIdx] ?? 'Y';

  if (mode === 'scatter3d') {
    return transformScatter3D({
      sheet,
      visibleRowIndices,
      profile,
      config,
      xColIdx,
      yColIdx,
      xProfile,
      yProfile,
    });
  }

  if (mode === 'ring3d') {
    return transformRing3D({
      sheet,
      visibleRowIndices,
      profile,
      config,
      xColIdx,
      yColIdx,
      xProfile,
      yProfile,
      xTitle,
      yTitle,
    });
  }

  return transformBar3D({
    sheet,
    visibleRowIndices,
    profile,
    config,
    xColIdx,
    yColIdx,
    xProfile,
    yProfile,
    xTitle,
    yTitle,
    extraYColIndices: params.yColIndices,
  });
}

interface AggBucket {
  xLabel: string;
  seriesLabel: string;
  sum: number;
  min: number;
  max: number;
  count: number;
  firstRowIndex: number;
  rowIndices: number[];
}

function getAggregatedValue(bucket: AggBucket, agg: AggregationFn): number {
  switch (agg) {
    case 'sum':
      return bucket.sum;
    case 'avg':
      return bucket.count > 0 ? bucket.sum / bucket.count : 0;
    case 'min':
      return Number.isFinite(bucket.min) ? bucket.min : 0;
    case 'max':
      return Number.isFinite(bucket.max) ? bucket.max : 0;
    case 'count':
      return bucket.count;
    default:
      return bucket.sum;
  }
}

function transformBar3D(ctx: {
  sheet: SheetData;
  visibleRowIndices: VisibleRowsSource;
  profile: DatasetProfile;
  config: SpatialConfig;
  xColIdx: number;
  yColIdx: number;
  xProfile?: ColumnProfile;
  yProfile?: ColumnProfile;
  xTitle: string;
  yTitle: string;
  extraYColIndices?: number[];
}): DerivedSpatialDataset {
  const {sheet, visibleRowIndices, profile, config, xColIdx, yColIdx, xProfile, yProfile, xTitle, yTitle} =
    ctx;
  const totalVisible = visibleRowIndices.length;
  const colCount = sheet.columns.length;
  const yRole = yProfile ? getEffectiveSemanticType(yProfile) : 'text';
  const yIsNumeric = yRole === 'quantitative' || yRole === 'boolean';

  // Enforce valid aggregation for non-numeric Y columns
  let effectiveAgg = config.aggregation;
  let warningMessage: string | null = null;
  if (!yIsNumeric && effectiveAgg !== 'count') {
    effectiveAgg = 'count';
    warningMessage = `"${yTitle}" is ${yRole}; automatically showing Record Count instead of ${config.aggregation.toUpperCase()}.`;
  }

  const groupColIdx =
    config.groupByColIndex !== null &&
    config.groupByColIndex >= 0 &&
    config.groupByColIndex < colCount &&
    config.groupByColIndex !== xColIdx
      ? config.groupByColIndex
      : null;
  const groupColTitle =
    groupColIdx !== null ? sheet.columns[groupColIdx] ?? 'Group' : null;

  // Determine multi-Y series vs GroupBy column
  const multiYCols =
    groupColIdx === null &&
    effectiveAgg !== 'count' &&
    ctx.extraYColIndices &&
    ctx.extraYColIndices.length > 1
      ? ctx.extraYColIndices.filter((c) => {
          if (c < 0 || c >= colCount) return false;
          const p = profile.columns[c];
          const r = p ? getEffectiveSemanticType(p) : 'text';
          return r === 'quantitative' || r === 'boolean';
        })
      : [yColIdx];

  const activeYCols = multiYCols.length > 0 ? multiYCols.slice(0, 4) : [yColIdx];
  const hasMultipleYCols = activeYCols.length > 1;

  const topK = Math.max(4, Math.min(MAX_BAR_CATEGORIES, config.topK || 16));
  const yUnit = effectiveAgg === 'count' ? null : yProfile?.unit ?? null;
  const xUnit = xProfile?.unit ?? null;
  const yDisplayTitle =
    effectiveAgg === 'count'
      ? `Count (${yTitle})`
      : effectiveAgg === 'none'
        ? yTitle
        : `${effectiveAgg.toUpperCase()}(${yTitle})`;

  // Case A: Raw (no aggregation) mode
  if (effectiveAgg === 'none') {
    const sampleIndices =
      config.samplingStrategy === 'first-n'
        ? Array.from(visibleRowIndices.slice(0, topK))
        : sampleChartIndices(visibleRowIndices, topK);

    const isSampled = totalVisible > sampleIndices.length;
    if (isSampled) {
      warningMessage =
        warningMessage ??
        `Raw mode sampled ${sampleIndices.length} of ${totalVisible.toLocaleString('en-US')} rows. Switch Aggregation to AVG or SUM to summarize all records.`;
    }

    const rawEntries: {
      rowIndex: number;
      xLabel: string;
      seriesLabel: string;
      yCol: number;
      seriesIdx: number;
      val: number;
    }[] = [];

    let rawMin = Infinity;
    let rawMax = -Infinity;
    const xLabelOrder: string[] = [];
    const xSeen = new Set<string>();
    const seriesOrder: string[] = [];
    const seriesSeen = new Set<string>();
    const rawRowSet = new Set<number>();

    for (let i = 0; i < sampleIndices.length; i++) {
      const rIdx = sampleIndices[i];
      const row = sheet.rows[rIdx] ?? [];
      const xRaw = (row[xColIdx] ?? '').trim() || `Row ${rIdx + 1}`;
      let xKey = xRaw;
      if (xSeen.has(xKey)) {
        let suffix = rIdx + 1;
        xKey = `${xRaw} #${suffix}`;
        while (xSeen.has(xKey)) {
          suffix++;
          xKey = `${xRaw} #${suffix}`;
        }
      }

      if (groupColIdx !== null) {
        const parsed = parseValueForDimension(row[yColIdx] ?? '', yRole);
        if (parsed === null) continue;
        const gLabel = (row[groupColIdx] ?? '').trim() || '(Empty)';
        if (!seriesSeen.has(gLabel)) {
          seriesSeen.add(gLabel);
          seriesOrder.push(gLabel);
        }
        xSeen.add(xKey);
        xLabelOrder.push(xKey);
        rawRowSet.add(rIdx);
        if (parsed < rawMin) rawMin = parsed;
        if (parsed > rawMax) rawMax = parsed;
        rawEntries.push({
          rowIndex: rIdx,
          xLabel: xKey,
          seriesLabel: gLabel,
          yCol: yColIdx,
          seriesIdx: seriesOrder.indexOf(gLabel),
          val: parsed,
        });
      } else {
        let rowHadValid = false;
        for (let s = 0; s < activeYCols.length; s++) {
          const yc = activeYCols[s];
          const ycProfile = profile.columns[yc];
          const ycRole = ycProfile ? getEffectiveSemanticType(ycProfile) : 'quantitative';
          const parsed = parseValueForDimension(row[yc] ?? '', ycRole);
          if (parsed === null) continue;
          rowHadValid = true;
          const sLabel = sheet.columns[yc] ?? `Series ${s + 1}`;
          if (!seriesSeen.has(sLabel)) {
            seriesSeen.add(sLabel);
            seriesOrder.push(sLabel);
          }
          if (parsed < rawMin) rawMin = parsed;
          if (parsed > rawMax) rawMax = parsed;
          rawEntries.push({
            rowIndex: rIdx,
            xLabel: xKey,
            seriesLabel: sLabel,
            yCol: yc,
            seriesIdx: s,
            val: parsed,
          });
        }
        if (rowHadValid) {
          xSeen.add(xKey);
          xLabelOrder.push(xKey);
          rawRowSet.add(rIdx);
        }
      }
    }

    if (rawEntries.length === 0) {
      return emptyDerivedDataset(
        'bar3d',
        `No valid numeric values found in "${yTitle}".`,
        totalVisible,
        xTitle,
        yDisplayTitle
      );
    }

    const scale = computeNiceAxisScale(rawMin, rawMax, {
      includeZero: config.scaleType === 'linear',
      scaleType: config.scaleType,
      colType: yProfile?.baseType ?? 'number',
    });
    if (scale.fallbackNotice) {
      warningMessage = warningMessage
        ? `${warningMessage} ${scale.fallbackNotice}`
        : scale.fallbackNotice;
    }

    const zeroNorm = scale.zeroNormalized ?? 0;
    const xCount = Math.max(1, xLabelOrder.length);
    const zCount = Math.max(1, seriesOrder.length);
    const xIndexMap = new Map<string, number>(
      xLabelOrder.map((lbl, idx) => [lbl, idx])
    );

    const items: SpatialDataItem[] = rawEntries.map((e, idx) => {
      const xi = xIndexMap.get(e.xLabel) ?? 0;
      const zi = Math.max(0, seriesOrder.indexOf(e.seriesLabel));
      const xNorm = (xi + 0.5) / xCount;
      const zNorm = zCount > 1 ? (zi + 0.5) / zCount : 0.5;
      const yNorm = normalizeValueOnAxis(
        e.val,
        scale.min,
        scale.max,
        scale.effectiveScaleType
      );
      return {
        id: idx,
        label: e.xLabel,
        seriesLabel: e.seriesLabel,
        colorHex: CHART_PALETTE[zi % CHART_PALETTE.length],
        xNorm,
        yNorm,
        yZeroNorm: zeroNorm,
        zNorm,
        xRaw: e.xLabel,
        yValue: e.val,
        zRaw: zCount > 1 ? e.seriesLabel : null,
        colorRaw: zCount > 1 ? e.seriesLabel : null,
        xUnit,
        yUnit,
        zUnit: null,
        aggregation: 'none',
        recordCount: 1,
        firstRowIndex: e.rowIndex,
        rowIndices: [e.rowIndex],
        xBucketIndex: xi,
        xBucketCount: xCount,
        zBucketIndex: zi,
        zBucketCount: zCount,
      };
    });

    const categoryTicks: AxisCategoryTick[] = xLabelOrder.map((lbl, i) => ({
      index: i,
      normalized: (i + 0.5) / xCount,
      label: lbl,
    }));

    const zCategoryTicks: AxisCategoryTick[] = seriesOrder.map((lbl, i) => ({
      index: i,
      normalized: zCount > 1 ? (i + 0.5) / zCount : 0.5,
      label: lbl,
    }));

    const legendEntries: SpatialLegendEntry[] = seriesOrder.map((lbl, i) => ({
      label: lbl,
      colorHex: CHART_PALETTE[i % CHART_PALETTE.length],
    }));

    return {
      mode: 'bar3d',
      isValid: true,
      validationMessage: null,
      warningMessage,
      dataStateKind: isSampled ? 'sampled' : 'raw',
      dataStateSummary: isSampled
        ? `Sampled ${rawRowSet.size.toLocaleString('en-US')} plotted of ${totalVisible.toLocaleString('en-US')} visible rows (Raw)`
        : rawRowSet.size < totalVisible
          ? `Plotted ${rawRowSet.size.toLocaleString('en-US')} of ${totalVisible.toLocaleString('en-US')} visible rows (${(totalVisible - rawRowSet.size).toLocaleString('en-US')} missing/non-numeric skipped)`
          : `All ${totalVisible.toLocaleString('en-US')} raw records`,
      totalVisibleRows: totalVisible,
      representedRowCount: rawRowSet.size,
      effectiveScaleType: scale.effectiveScaleType,
      axes: {
        x: {
          title: xTitle,
          unit: xUnit,
          kind: 'categorical',
          min: 0,
          max: xCount,
          scaleType: 'linear',
          zeroNormalized: null,
          numericTicks: [],
          categoryTicks,
        },
        y: {
          title: yDisplayTitle,
          unit: yUnit,
          kind: 'quantitative',
          min: scale.min,
          max: scale.max,
          scaleType: scale.effectiveScaleType,
          zeroNormalized: scale.zeroNormalized,
          numericTicks: scale.ticks,
          categoryTicks: [],
        },
        z:
          zCount > 1
            ? {
                title: groupColTitle ?? 'Metric Series',
                unit: null,
                kind: 'categorical',
                min: 0,
                max: zCount,
                scaleType: 'linear',
                zeroNormalized: null,
                numericTicks: [],
                categoryTicks: zCategoryTicks,
              }
            : null,
      },
      legend: {
        kind: 'discrete',
        title: groupColTitle ?? 'Series',
        entries: legendEntries,
      },
      items,
    };
  }

  // Case B: Aggregated 3D Bars across ALL visible rows (O(N) single pass)
  const bucketMap = new Map<string, AggBucket>();
  const xTotals = new Map<string, number>();
  const xCounts = new Map<string, number>();
  const xMinMap = new Map<string, number>();
  const xMaxMap = new Map<string, number>();
  const xDistinctValidRows = new Map<string, number>();
  const seriesCounts = new Map<string, number>();
  const xSourceOrder: string[] = [];
  const seriesSourceOrder: string[] = [];

  for (let i = 0; i < totalVisible; i++) {
    const rIdx = visibleRowIndices[i];
    const row = sheet.rows[rIdx] ?? [];
    const xLabel = (row[xColIdx] ?? '').trim() || '(Blank)';

    if (!xTotals.has(xLabel)) {
      xTotals.set(xLabel, 0);
      xCounts.set(xLabel, 0);
      xMinMap.set(xLabel, Infinity);
      xMaxMap.set(xLabel, -Infinity);
      xDistinctValidRows.set(xLabel, 0);
      xSourceOrder.push(xLabel);
    }

    if (hasMultipleYCols) {
      let rowHadValidY = false;
      for (let s = 0; s < activeYCols.length; s++) {
        const yc = activeYCols[s];
        const ycProfile = profile.columns[yc];
        const ycRole = ycProfile ? getEffectiveSemanticType(ycProfile) : 'quantitative';
        const val = parseValueForDimension(row[yc] ?? '', ycRole);
        if (val === null) continue;
        rowHadValidY = true;
        const sLabel = sheet.columns[yc] ?? `Series ${s + 1}`;
        if (!seriesCounts.has(sLabel)) {
          seriesCounts.set(sLabel, 0);
          seriesSourceOrder.push(sLabel);
        }
        seriesCounts.set(sLabel, (seriesCounts.get(sLabel) ?? 0) + 1);

        const key = `${xLabel}\x00${sLabel}`;
        let b = bucketMap.get(key);
        if (!b) {
          b = {
            xLabel,
            seriesLabel: sLabel,
            sum: 0,
            min: Infinity,
            max: -Infinity,
            count: 0,
            firstRowIndex: rIdx,
            rowIndices: [],
          };
          bucketMap.set(key, b);
        }
        b.sum += val;
        if (val < b.min) b.min = val;
        if (val > b.max) b.max = val;
        b.count += 1;
        if (b.rowIndices.length < MAX_INSPECTOR_ROW_REFS) {
          b.rowIndices.push(rIdx);
        }
        xTotals.set(xLabel, (xTotals.get(xLabel) ?? 0) + val);
        xCounts.set(xLabel, (xCounts.get(xLabel) ?? 0) + 1);
        if (val < (xMinMap.get(xLabel) ?? Infinity)) xMinMap.set(xLabel, val);
        if (val > (xMaxMap.get(xLabel) ?? -Infinity)) xMaxMap.set(xLabel, val);
      }
      if (rowHadValidY) {
        xDistinctValidRows.set(xLabel, (xDistinctValidRows.get(xLabel) ?? 0) + 1);
      }
    } else {
      const sLabel =
        groupColIdx !== null
          ? (row[groupColIdx] ?? '').trim() || '(Blank)'
          : yTitle;

      let val = 1;
      if (effectiveAgg !== 'count') {
        const parsed = parseValueForDimension(row[yColIdx] ?? '', yRole);
        if (parsed === null) continue;
        val = parsed;
      }

      if (!seriesCounts.has(sLabel)) {
        seriesCounts.set(sLabel, 0);
        seriesSourceOrder.push(sLabel);
      }
      seriesCounts.set(sLabel, (seriesCounts.get(sLabel) ?? 0) + 1);

      const key = `${xLabel}\x00${sLabel}`;
      let b = bucketMap.get(key);
      if (!b) {
        b = {
          xLabel,
          seriesLabel: sLabel,
          sum: 0,
          min: Infinity,
          max: -Infinity,
          count: 0,
          firstRowIndex: rIdx,
          rowIndices: [],
        };
        bucketMap.set(key, b);
      }
      b.sum += val;
      if (val < b.min) b.min = val;
      if (val > b.max) b.max = val;
      b.count += 1;
      if (b.rowIndices.length < MAX_INSPECTOR_ROW_REFS) {
        b.rowIndices.push(rIdx);
      }
      xTotals.set(xLabel, (xTotals.get(xLabel) ?? 0) + val);
      xCounts.set(xLabel, (xCounts.get(xLabel) ?? 0) + 1);
      xDistinctValidRows.set(xLabel, (xDistinctValidRows.get(xLabel) ?? 0) + 1);
      if (val < (xMinMap.get(xLabel) ?? Infinity)) xMinMap.set(xLabel, val);
      if (val > (xMaxMap.get(xLabel) ?? -Infinity)) xMaxMap.set(xLabel, val);
    }
  }

  if (bucketMap.size === 0) {
    return emptyDerivedDataset(
      'bar3d',
      `No valid numeric values found in "${yTitle}".`,
      totalVisible,
      xTitle,
      yDisplayTitle
    );
  }

  // Sort X categories according to config.sortOrder and slice Top-K
  const getCategoryScore = (lbl: string): number => {
    const cnt = xCounts.get(lbl) ?? 0;
    if (effectiveAgg === 'count') return cnt;
    if (effectiveAgg === 'avg') return cnt > 0 ? (xTotals.get(lbl) ?? 0) / cnt : 0;
    if (effectiveAgg === 'min') {
      const m = xMinMap.get(lbl);
      return m !== undefined && Number.isFinite(m) ? m : 0;
    }
    if (effectiveAgg === 'max') {
      const m = xMaxMap.get(lbl);
      return m !== undefined && Number.isFinite(m) ? m : 0;
    }
    return xTotals.get(lbl) ?? 0;
  };

  const sortedX = xSourceOrder.filter((lbl) => (xCounts.get(lbl) ?? 0) > 0);
  if (config.sortOrder === 'value-desc') {
    sortedX.sort((a, b) => getCategoryScore(b) - getCategoryScore(a));
  } else if (config.sortOrder === 'value-asc') {
    sortedX.sort((a, b) => getCategoryScore(a) - getCategoryScore(b));
  } else if (config.sortOrder === 'label-asc') {
    sortedX.sort((a, b) => a.localeCompare(b, 'en', {numeric: true}));
  }

  const totalUniqueX = sortedX.length;
  const keptX = sortedX.slice(0, topK);
  if (totalUniqueX > keptX.length) {
    const msg = `Showing top ${keptX.length} of ${totalUniqueX.toLocaleString('en-US')} unique "${xTitle}" groups.`;
    warningMessage = warningMessage ? `${warningMessage} ${msg}` : msg;
  }

  // Limit series to MAX_GROUP_SERIES
  let keptSeries = seriesSourceOrder.slice();
  if (keptSeries.length > MAX_GROUP_SERIES) {
    keptSeries.sort(
      (a, b) => (seriesCounts.get(b) ?? 0) - (seriesCounts.get(a) ?? 0)
    );
    const totalSeries = keptSeries.length;
    keptSeries = keptSeries.slice(0, MAX_GROUP_SERIES);
    const msg = `Grouping limited to top ${MAX_GROUP_SERIES} of ${totalSeries} "${groupColTitle ?? 'Series'}" values.`;
    warningMessage = warningMessage ? `${warningMessage} ${msg}` : msg;
  }

  let valMin = Infinity;
  let valMax = -Infinity;
  const keptBuckets: {
    bucket: AggBucket;
    xi: number;
    zi: number;
    value: number;
  }[] = [];

  for (let xi = 0; xi < keptX.length; xi++) {
    const xLbl = keptX[xi];
    for (let zi = 0; zi < keptSeries.length; zi++) {
      const sLbl = keptSeries[zi];
      const bucket = bucketMap.get(`${xLbl}\x00${sLbl}`);
      if (!bucket) continue;
      const value = getAggregatedValue(bucket, effectiveAgg);
      if (value < valMin) valMin = value;
      if (value > valMax) valMax = value;
      keptBuckets.push({bucket, xi, zi, value});
    }
  }

  if (keptBuckets.length === 0) {
    return emptyDerivedDataset(
      'bar3d',
      'No aggregated groups available for the selected configuration.',
      totalVisible,
      xTitle,
      yDisplayTitle
    );
  }

  const scale = computeNiceAxisScale(valMin, valMax, {
    includeZero: config.scaleType === 'linear',
    scaleType: config.scaleType,
    colType: effectiveAgg === 'count' ? 'number' : yProfile?.baseType ?? 'number',
  });
  if (scale.fallbackNotice) {
    warningMessage = warningMessage
      ? `${warningMessage} ${scale.fallbackNotice}`
      : scale.fallbackNotice;
  }

  const zeroNorm = scale.zeroNormalized ?? 0;
  const xCount = Math.max(1, keptX.length);
  const zCount = Math.max(1, keptSeries.length);

  let representedRowCount = 0;
  const items: SpatialDataItem[] = keptBuckets.map((entry, idx) => {
    const {bucket, xi, zi, value} = entry;
    representedRowCount += bucket.count;
    const xNorm = (xi + 0.5) / xCount;
    const zNorm = zCount > 1 ? (zi + 0.5) / zCount : 0.5;
    const yNorm = normalizeValueOnAxis(
      value,
      scale.min,
      scale.max,
      scale.effectiveScaleType
    );
    const colorHex =
      zCount === 1
        ? CHART_PALETTE[0]
        : CHART_PALETTE[zi % CHART_PALETTE.length];

    return {
      id: idx,
      label: bucket.xLabel,
      seriesLabel: bucket.seriesLabel,
      colorHex,
      xNorm,
      yNorm,
      yZeroNorm: zeroNorm,
      zNorm,
      xRaw: bucket.xLabel,
      yValue: value,
      zRaw: zCount > 1 ? bucket.seriesLabel : null,
      colorRaw: zCount > 1 ? bucket.seriesLabel : null,
      xUnit,
      yUnit,
      zUnit: null,
      aggregation: effectiveAgg,
      recordCount: bucket.count,
      firstRowIndex: bucket.firstRowIndex,
      rowIndices: bucket.rowIndices,
      aggStats: {
        sum: bucket.sum,
        avg: bucket.count > 0 ? bucket.sum / bucket.count : 0,
        min: bucket.min,
        max: bucket.max,
        count: bucket.count,
      },
      xBucketIndex: xi,
      xBucketCount: xCount,
      zBucketIndex: zi,
      zBucketCount: zCount,
    };
  });

  // Count exact distinct rows represented across kept bars
  if (hasMultipleYCols) {
    representedRowCount = keptX.reduce(
      (acc, lbl) => acc + (xDistinctValidRows.get(lbl) ?? 0),
      0
    );
  }

  const categoryTicks: AxisCategoryTick[] = keptX.map((lbl, i) => ({
    index: i,
    normalized: (i + 0.5) / xCount,
    label: lbl,
  }));

  const zCategoryTicks: AxisCategoryTick[] = keptSeries.map((lbl, i) => ({
    index: i,
    normalized: zCount > 1 ? (i + 0.5) / zCount : 0.5,
    label: lbl,
  }));

  const legendEntries: SpatialLegendEntry[] = keptSeries.map((lbl, i) => ({
    label: lbl,
    colorHex:
      keptSeries.length === 1
        ? CHART_PALETTE[0]
        : CHART_PALETTE[i % CHART_PALETTE.length],
    count: seriesCounts.get(lbl),
  }));

  return {
    mode: 'bar3d',
    isValid: true,
    validationMessage: null,
    warningMessage,
    dataStateKind: 'aggregated',
    dataStateSummary: `Aggregated ${representedRowCount.toLocaleString('en-US')} of ${totalVisible.toLocaleString('en-US')} visible rows by ${xTitle}${groupColTitle ? ` × ${groupColTitle}` : ''} (${effectiveAgg.toUpperCase()}) -> ${items.length} bars`,
    totalVisibleRows: totalVisible,
    representedRowCount,
    effectiveScaleType: scale.effectiveScaleType,
    axes: {
      x: {
        title: xTitle,
        unit: xUnit,
        kind: 'categorical',
        min: 0,
        max: xCount,
        scaleType: 'linear',
        zeroNormalized: null,
        numericTicks: [],
        categoryTicks,
      },
      y: {
        title: yDisplayTitle,
        unit: yUnit,
        kind: 'quantitative',
        min: scale.min,
        max: scale.max,
        scaleType: scale.effectiveScaleType,
        zeroNormalized: scale.zeroNormalized,
        numericTicks: scale.ticks,
        categoryTicks: [],
      },
      z:
        zCount > 1
          ? {
              title: groupColTitle ?? 'Metric Series',
              unit: null,
              kind: 'categorical',
              min: 0,
              max: zCount,
              scaleType: 'linear',
              zeroNormalized: null,
              numericTicks: [],
              categoryTicks: zCategoryTicks,
            }
          : null,
    },
    legend: {
      kind: 'discrete',
      title: groupColTitle ?? 'Metric',
      entries: legendEntries,
    },
    items,
  };
}

function transformScatter3D(ctx: {
  sheet: SheetData;
  visibleRowIndices: VisibleRowsSource;
  profile: DatasetProfile;
  config: SpatialConfig;
  xColIdx: number;
  yColIdx: number;
  xProfile?: ColumnProfile;
  yProfile?: ColumnProfile;
}): DerivedSpatialDataset {
  const {sheet, visibleRowIndices, profile, config, xColIdx, yColIdx, xProfile, yProfile} =
    ctx;
  const totalVisible = visibleRowIndices.length;
  const colCount = sheet.columns.length;
  const zColIdx = config.zColIndex;

  if (zColIdx === null || zColIdx < 0 || zColIdx >= colCount) {
    return emptyDerivedDataset(
      'scatter3d',
      'Select a quantitative or temporal Z-axis column in Configure to plot a true 3D Scatter.',
      totalVisible,
      xProfile?.name ?? 'X',
      yProfile?.name ?? 'Y'
    );
  }

  const zProfile = profile.columns[zColIdx];
  const xRole = xProfile ? getEffectiveSemanticType(xProfile) : 'text';
  const yRole = yProfile ? getEffectiveSemanticType(yProfile) : 'text';
  const zRole = zProfile ? getEffectiveSemanticType(zProfile) : 'text';

  if (!isQuantitativeOrTemporal(yRole) || !isQuantitativeOrTemporal(zRole)) {
    return emptyDerivedDataset(
      'scatter3d',
      `3D Scatter requires quantitative/temporal Y and Z axes (current: Y is ${yRole}, Z is ${zRole}).`,
      totalVisible,
      xProfile?.name ?? 'X',
      yProfile?.name ?? 'Y'
    );
  }

  const xIsNumericOrTemporal = isQuantitativeOrTemporal(xRole);
  const limit = Math.max(50, Math.min(5000, config.sampleLimit || 500));
  const sampledIndices =
    config.samplingStrategy === 'first-n'
      ? Array.from(visibleRowIndices.slice(0, limit))
      : sampleChartIndices(visibleRowIndices, limit);
  const isSampled = totalVisible > sampledIndices.length;

  const colorColIdx =
    config.colorColIndex !== null &&
    config.colorColIndex >= 0 &&
    config.colorColIndex < colCount
      ? config.colorColIndex
      : null;
  const colorProfile =
    colorColIdx !== null ? profile.columns[colorColIdx] : undefined;
  const colorRole = colorProfile
    ? getEffectiveSemanticType(colorProfile)
    : 'text';
  const colorIsNumeric =
    colorColIdx !== null && isQuantitativeOrTemporal(colorRole);

  interface RawScatterRow {
    rowIndex: number;
    xRaw: string | number;
    xNum: number | null;
    yNum: number;
    zNum: number;
    colorStr: string | null;
    colorNum: number | null;
  }

  const parsedRows: RawScatterRow[] = [];
  const xCatList: string[] = [];
  const xCatMap = new Map<string, number>();

  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  let zMin = Infinity;
  let zMax = -Infinity;
  let cMin = Infinity;
  let cMax = -Infinity;

  const colorCatCounts = new Map<string, number>();

  for (let i = 0; i < sampledIndices.length; i++) {
    const rIdx = sampledIndices[i];
    const row = sheet.rows[rIdx] ?? [];
    const yVal = parseValueForDimension(row[yColIdx] ?? '', yRole);
    const zVal = parseValueForDimension(row[zColIdx] ?? '', zRole);
    if (yVal === null || zVal === null) continue;

    let xNum: number | null = null;
    let xRaw: string | number = (row[xColIdx] ?? '').trim() || `Row ${rIdx + 1}`;
    if (xIsNumericOrTemporal) {
      xNum = parseValueForDimension(row[xColIdx] ?? '', xRole);
      if (xNum === null) continue;
      xRaw = xNum;
      if (xNum < xMin) xMin = xNum;
      if (xNum > xMax) xMax = xNum;
    } else {
      const lbl = String(xRaw);
      if (!xCatMap.has(lbl)) {
        xCatMap.set(lbl, xCatList.length);
        xCatList.push(lbl);
      }
    }

    if (yVal < yMin) yMin = yVal;
    if (yVal > yMax) yMax = yVal;
    if (zVal < zMin) zMin = zVal;
    if (zVal > zMax) zMax = zVal;

    let colorStr: string | null = null;
    let colorNum: number | null = null;
    if (colorColIdx !== null) {
      colorStr = (row[colorColIdx] ?? '').trim() || '(Blank)';
      if (colorIsNumeric) {
        colorNum = parseValueForDimension(row[colorColIdx] ?? '', colorRole);
        if (colorNum !== null) {
          if (colorNum < cMin) cMin = colorNum;
          if (colorNum > cMax) cMax = colorNum;
        }
      } else {
        colorCatCounts.set(colorStr, (colorCatCounts.get(colorStr) ?? 0) + 1);
      }
    }

    parsedRows.push({
      rowIndex: rIdx,
      xRaw,
      xNum,
      yNum: yVal,
      zNum: zVal,
      colorStr,
      colorNum,
    });
  }

  if (parsedRows.length === 0) {
    return emptyDerivedDataset(
      'scatter3d',
      'No rows contain valid numeric values across the selected X, Y, and Z dimensions.',
      totalVisible,
      xProfile?.name ?? 'X',
      yProfile?.name ?? 'Y'
    );
  }

  let warningMessage: string | null = null;
  if (!xIsNumericOrTemporal && xCatList.length > 20) {
    warningMessage = `X column "${xProfile?.name}" has ${xCatList.length} categories plotted ordinally; pick a numeric X column for a continuous 3D point cloud.`;
  }

  const yScale = computeNiceAxisScale(yMin, yMax, {
    includeZero: false,
    scaleType: config.scaleType,
    colType: yProfile?.baseType ?? 'number',
    isTemporal: yRole === 'temporal',
  });
  const zScale = computeNiceAxisScale(zMin, zMax, {
    includeZero: false,
    scaleType: config.scaleType,
    colType: zProfile?.baseType ?? 'number',
    isTemporal: zRole === 'temporal',
  });
  if (yScale.fallbackNotice || zScale.fallbackNotice) {
    const notice = yScale.fallbackNotice ?? zScale.fallbackNotice!;
    warningMessage = warningMessage ? `${warningMessage} ${notice}` : notice;
  }

  let xAxisSpec: AxisSpec;
  if (xIsNumericOrTemporal) {
    const xScale = computeNiceAxisScale(xMin, xMax, {
      includeZero: false,
      scaleType: config.scaleType,
      colType: xProfile?.baseType ?? 'number',
      isTemporal: xRole === 'temporal',
    });
    xAxisSpec = {
      title: xProfile?.name ?? sheet.columns[xColIdx] ?? 'X',
      unit: xProfile?.unit ?? null,
      kind: xRole === 'temporal' ? 'temporal' : 'quantitative',
      min: xScale.min,
      max: xScale.max,
      scaleType: xScale.effectiveScaleType,
      zeroNormalized: xScale.zeroNormalized,
      numericTicks: xScale.ticks,
      categoryTicks: [],
    };
  } else {
    const catCount = Math.max(1, xCatList.length);
    xAxisSpec = {
      title: xProfile?.name ?? sheet.columns[xColIdx] ?? 'X',
      unit: xProfile?.unit ?? null,
      kind: 'categorical',
      min: 0,
      max: catCount,
      scaleType: 'linear',
      zeroNormalized: null,
      numericTicks: [],
      categoryTicks: xCatList.map((lbl, idx) => ({
        index: idx,
        normalized: catCount > 1 ? (idx + 0.5) / catCount : 0.5,
        label: lbl,
      })),
    };
  }

  // Build color legend
  let legend: SpatialColorLegend = {kind: 'none', title: '', entries: []};
  const discreteColorMap = new Map<string, string>();
  if (colorColIdx !== null && colorProfile) {
    if (colorIsNumeric && Number.isFinite(cMin) && Number.isFinite(cMax)) {
      legend = {
        kind: 'continuous',
        title: colorProfile.unit
          ? `${colorProfile.name} (${colorProfile.unit})`
          : colorProfile.name,
        minLabel: formatCompactTick(cMin, colorProfile.baseType, colorRole === 'temporal'),
        maxLabel: formatCompactTick(cMax, colorProfile.baseType, colorRole === 'temporal'),
        entries: CONTINUOUS_RAMP.map((hex, i) => ({
          label: `${Math.round((i / (CONTINUOUS_RAMP.length - 1)) * 100)}%`,
          colorHex: hex,
        })),
      };
    } else if (colorCatCounts.size > 0) {
      const sortedCats = Array.from(colorCatCounts.entries()).sort(
        (a, b) => b[1] - a[1]
      );
      const topCats = sortedCats.slice(0, MAX_GROUP_SERIES);
      const entries: SpatialLegendEntry[] = topCats.map(([lbl, cnt], i) => {
        const hex = CHART_PALETTE[i % CHART_PALETTE.length];
        discreteColorMap.set(lbl, hex);
        return {label: lbl, colorHex: hex, count: cnt};
      });
      if (sortedCats.length > MAX_GROUP_SERIES) {
        entries.push({
          label: 'Other',
          colorHex: '#94a3b8',
          count: sortedCats
            .slice(MAX_GROUP_SERIES)
            .reduce((acc, [, c]) => acc + c, 0),
        });
      }
      legend = {
        kind: 'discrete',
        title: colorProfile.name,
        entries,
      };
    }
  } else {
    legend = {
      kind: 'discrete',
      title: yProfile?.name ?? 'Data Point',
      entries: [
        {
          label: `${yProfile?.name ?? 'Y'} vs ${zProfile?.name ?? 'Z'}`,
          colorHex: CHART_PALETTE[0],
          count: parsedRows.length,
        },
      ],
    };
  }

  const labelColIdx = profile.catCols[0] ?? profile.idCols[0] ?? xColIdx;
  const effectiveScale =
    yScale.effectiveScaleType === 'log' && zScale.effectiveScaleType === 'log'
      ? 'log'
      : 'linear';

  const items: SpatialDataItem[] = parsedRows.map((row, idx) => {
    const xNorm = xIsNumericOrTemporal
      ? normalizeValueOnAxis(
          row.xNum!,
          xAxisSpec.min,
          xAxisSpec.max,
          xAxisSpec.scaleType
        )
      : (xCatMap.get(String(row.xRaw))! + 0.5) / Math.max(1, xCatList.length);

    const yNorm = normalizeValueOnAxis(
      row.yNum,
      yScale.min,
      yScale.max,
      yScale.effectiveScaleType
    );
    const zNorm = normalizeValueOnAxis(
      row.zNum,
      zScale.min,
      zScale.max,
      zScale.effectiveScaleType
    );

    let colorHex: string = CHART_PALETTE[0];
    if (colorColIdx !== null) {
      if (colorIsNumeric && row.colorNum !== null) {
        const span = Math.max(1e-12, cMax - cMin);
        colorHex = interpolateHexColor((row.colorNum - cMin) / span);
      } else if (row.colorStr !== null) {
        colorHex = discreteColorMap.get(row.colorStr) ?? '#94a3b8';
      }
    }

    const rowData = sheet.rows[row.rowIndex] ?? [];
    const displayLbl =
      (rowData[labelColIdx] ?? '').trim() || `Row ${row.rowIndex + 1}`;

    return {
      id: idx,
      label: displayLbl,
      seriesLabel: row.colorStr ?? zProfile?.name ?? 'Point',
      colorHex,
      xNorm,
      yNorm,
      yZeroNorm: yScale.zeroNormalized ?? 0,
      zNorm,
      xRaw: xIsNumericOrTemporal
        ? formatCompactTick(row.xNum!, xProfile?.baseType, xRole === 'temporal')
        : row.xRaw,
      yValue: row.yNum,
      zRaw: row.zNum,
      colorRaw: row.colorStr,
      xUnit: xProfile?.unit ?? null,
      yUnit: yProfile?.unit ?? null,
      zUnit: zProfile?.unit ?? null,
      aggregation: 'none',
      recordCount: 1,
      firstRowIndex: row.rowIndex,
      rowIndices: [row.rowIndex],
    };
  });

  const skippedScatterCount = sampledIndices.length - parsedRows.length;

  return {
    mode: 'scatter3d',
    isValid: true,
    validationMessage: null,
    warningMessage,
    dataStateKind: isSampled ? 'sampled' : 'raw',
    dataStateSummary: isSampled
      ? `Sampled ${items.length.toLocaleString('en-US')} of ${totalVisible.toLocaleString('en-US')} visible rows (${config.samplingStrategy})`
      : skippedScatterCount > 0
        ? `Plotted ${items.length.toLocaleString('en-US')} of ${totalVisible.toLocaleString('en-US')} visible rows (${skippedScatterCount.toLocaleString('en-US')} missing/non-numeric skipped)`
        : `All ${items.length.toLocaleString('en-US')} raw points plotted across 3 dimensions`,
    totalVisibleRows: totalVisible,
    representedRowCount: items.length,
    effectiveScaleType: effectiveScale,
    axes: {
      x: xAxisSpec,
      y: {
        title: yProfile?.name ?? sheet.columns[yColIdx] ?? 'Y',
        unit: yProfile?.unit ?? null,
        kind: yRole === 'temporal' ? 'temporal' : 'quantitative',
        min: yScale.min,
        max: yScale.max,
        scaleType: yScale.effectiveScaleType,
        zeroNormalized: yScale.zeroNormalized,
        numericTicks: yScale.ticks,
        categoryTicks: [],
      },
      z: {
        title: zProfile?.name ?? sheet.columns[zColIdx] ?? 'Z',
        unit: zProfile?.unit ?? null,
        kind: zRole === 'temporal' ? 'temporal' : 'quantitative',
        min: zScale.min,
        max: zScale.max,
        scaleType: zScale.effectiveScaleType,
        zeroNormalized: zScale.zeroNormalized,
        numericTicks: zScale.ticks,
        categoryTicks: [],
      },
    },
    legend,
    items,
  };
}

function transformRing3D(ctx: {
  sheet: SheetData;
  visibleRowIndices: VisibleRowsSource;
  profile: DatasetProfile;
  config: SpatialConfig;
  xColIdx: number;
  yColIdx: number;
  xProfile?: ColumnProfile;
  yProfile?: ColumnProfile;
  xTitle: string;
  yTitle: string;
}): DerivedSpatialDataset {
  const {sheet, visibleRowIndices, config, xColIdx, yColIdx, xProfile, yProfile, xTitle, yTitle} =
    ctx;
  const totalVisible = visibleRowIndices.length;
  const yRole = yProfile ? getEffectiveSemanticType(yProfile) : 'text';
  const yIsNumeric = yRole === 'quantitative' || yRole === 'boolean';

  let effectiveAgg: AggregationFn =
    config.aggregation === 'count' ? 'count' : 'sum';
  let warningMessage: string | null = null;
  if (!yIsNumeric && effectiveAgg !== 'count') {
    effectiveAgg = 'count';
    warningMessage = `"${yTitle}" is ${yRole}; 3D Ring displays Record Count breakdown.`;
  }

  const bucketMap = new Map<string, AggBucket>();
  let negativeCount = 0;

  for (let i = 0; i < totalVisible; i++) {
    const rIdx = visibleRowIndices[i];
    const row = sheet.rows[rIdx] ?? [];
    const xLabel = (row[xColIdx] ?? '').trim() || '(Blank)';

    let val = 1;
    if (effectiveAgg !== 'count') {
      const parsed = parseValueForDimension(row[yColIdx] ?? '', yRole);
      if (parsed === null) continue;
      if (parsed < 0) {
        negativeCount++;
        continue;
      }
      val = parsed;
    }

    let b = bucketMap.get(xLabel);
    if (!b) {
      b = {
        xLabel,
        seriesLabel: effectiveAgg === 'count' ? 'Count' : yTitle,
        sum: 0,
        min: Infinity,
        max: -Infinity,
        count: 0,
        firstRowIndex: rIdx,
        rowIndices: [],
      };
      bucketMap.set(xLabel, b);
    }
    b.sum += val;
    if (val < b.min) b.min = val;
    if (val > b.max) b.max = val;
    b.count += 1;
    if (b.rowIndices.length < MAX_INSPECTOR_ROW_REFS) {
      b.rowIndices.push(rIdx);
    }
  }

  if (negativeCount > 0) {
    return emptyDerivedDataset(
      'ring3d',
      `3D Ring requires non-negative values for proportional breakdown (${negativeCount} negative value${negativeCount > 1 ? 's' : ''} detected in "${yTitle}"). Switch to 3D Bars.`,
      totalVisible,
      xTitle,
      yTitle
    );
  }

  const positiveBuckets = Array.from(bucketMap.values()).filter(
    (b) => (effectiveAgg === 'count' ? b.count : b.sum) > 0
  );

  if (positiveBuckets.length === 0) {
    return emptyDerivedDataset(
      'ring3d',
      `No positive values available in "${yTitle}" to build a proportional 3D Ring.`,
      totalVisible,
      xTitle,
      yTitle
    );
  }

  // Sort by contribution descending
  positiveBuckets.sort((a, b) => {
    const va = effectiveAgg === 'count' ? a.count : a.sum;
    const vb = effectiveAgg === 'count' ? b.count : b.sum;
    return vb - va;
  });

  const maxSlices = Math.max(3, Math.min(MAX_RING_SLICES, config.topK || 8));
  let finalBuckets = positiveBuckets;

  if (positiveBuckets.length > maxSlices) {
    const head = positiveBuckets.slice(0, maxSlices - 1);
    const tail = positiveBuckets.slice(maxSlices - 1);
    const otherBucket: AggBucket = {
      xLabel: `Other (${tail.length})`,
      seriesLabel: effectiveAgg === 'count' ? 'Count' : yTitle,
      sum: 0,
      min: Infinity,
      max: -Infinity,
      count: 0,
      firstRowIndex: tail[0].firstRowIndex,
      rowIndices: [],
    };
    for (const tb of tail) {
      otherBucket.sum += tb.sum;
      otherBucket.count += tb.count;
      if (tb.min < otherBucket.min) otherBucket.min = tb.min;
      if (tb.max > otherBucket.max) otherBucket.max = tb.max;
      if (otherBucket.rowIndices.length < MAX_INSPECTOR_ROW_REFS) {
        otherBucket.rowIndices.push(tb.firstRowIndex);
      }
    }
    finalBuckets = [...head, otherBucket];
    const tailMsg = `Grouped ${tail.length} smaller "${xTitle}" categories into "Other". For full comparison across all ${positiveBuckets.length} categories, use 3D Bars.`;
    warningMessage = warningMessage ? `${warningMessage} ${tailMsg}` : tailMsg;
  }

  const grandTotal = finalBuckets.reduce(
    (acc, b) => acc + (effectiveAgg === 'count' ? b.count : b.sum),
    0
  );
  if (grandTotal <= 0) {
    return emptyDerivedDataset(
      'ring3d',
      'Total sum must be positive (> 0) for proportional 3D Ring.',
      totalVisible,
      xTitle,
      yTitle
    );
  }

  const yUnit = effectiveAgg === 'count' ? null : yProfile?.unit ?? null;
  const xUnit = xProfile?.unit ?? null;
  const yDisplayTitle =
    effectiveAgg === 'count' ? `Share by Count (${xTitle})` : `Share of ${yTitle}`;

  let currentAngle = -Math.PI / 2;
  const legendEntries: SpatialLegendEntry[] = [];
  const items: SpatialDataItem[] = finalBuckets.map((b, idx) => {
    const val = effectiveAgg === 'count' ? b.count : b.sum;
    const proportion = val / grandTotal;
    const angleSpan = proportion * Math.PI * 2;
    const angleStart = currentAngle;
    const angleEnd = currentAngle + angleSpan;
    currentAngle = angleEnd;

    const colorHex =
      idx === finalBuckets.length - 1 && b.xLabel.startsWith('Other (')
        ? '#64748b'
        : CHART_PALETTE[idx % CHART_PALETTE.length];

    legendEntries.push({
      label: `${b.xLabel} (${(proportion * 100).toFixed(1)}%)`,
      colorHex,
      count: b.count,
    });

    return {
      id: idx,
      label: b.xLabel,
      seriesLabel: yDisplayTitle,
      colorHex,
      xNorm: 0.5,
      yNorm: Math.max(0.12, Math.min(1, 0.25 + proportion * 0.75)),
      yZeroNorm: 0,
      zNorm: 0.5,
      xRaw: b.xLabel,
      yValue: val,
      zRaw: `${(proportion * 100).toFixed(1)}%`,
      colorRaw: b.xLabel,
      xUnit,
      yUnit,
      zUnit: '%',
      aggregation: effectiveAgg,
      recordCount: b.count,
      firstRowIndex: b.firstRowIndex,
      rowIndices: b.rowIndices,
      aggStats: {
        sum: b.sum,
        avg: b.count > 0 ? b.sum / b.count : 0,
        min: b.min,
        max: b.max,
        count: b.count,
      },
      proportion,
      angleStart,
      angleEnd,
    };
  });

  const representedRingRows = finalBuckets.reduce((acc, b) => acc + b.count, 0);

  return {
    mode: 'ring3d',
    isValid: true,
    validationMessage: null,
    warningMessage,
    dataStateKind: 'aggregated',
    dataStateSummary: `Aggregated share of ${representedRingRows.toLocaleString('en-US')} of ${totalVisible.toLocaleString('en-US')} rows across ${items.length} slices (Total: ${formatCompactTick(grandTotal, yProfile?.baseType)}${yUnit ? ` ${yUnit}` : ''})`,
    totalVisibleRows: totalVisible,
    representedRowCount: representedRingRows,
    effectiveScaleType: 'linear',
    axes: {
      x: {
        title: xTitle,
        unit: xUnit,
        kind: 'categorical',
        min: 0,
        max: items.length,
        scaleType: 'linear',
        zeroNormalized: null,
        numericTicks: [],
        categoryTicks: items.map((it, idx) => ({
          index: idx,
          normalized: (idx + 0.5) / items.length,
          label: it.label,
        })),
      },
      y: {
        title: yDisplayTitle,
        unit: yUnit,
        kind: 'quantitative',
        min: 0,
        max: grandTotal,
        scaleType: 'linear',
        zeroNormalized: 0,
        numericTicks: [],
        categoryTicks: [],
      },
      z: null,
    },
    legend: {
      kind: 'discrete',
      title: xTitle,
      entries: legendEntries,
    },
    items,
  };
}
