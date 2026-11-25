import type {
  CatalogFilterState,
  ChartConfig,
  ColumnCatalogEntry,
  ColumnDetailSummary,
  ColumnViewState,
  DatasetOverviewSummary,
  DatasetProfile,
  QualityExample,
  QualityObservation,
  SemanticType,
  SheetData,
  SpatialConfig,
  SuggestedAnalysisItem,
  VisibleRowsSource,
  WorkbookState,
} from '../types';
import {recommendCharts} from './chartRecommender';
import {validateChartConfig} from './chartValidation';
import {getEffectiveSemanticType, parseTemporalValue} from './dataProfiler';
import {getWorkbookDisplayName} from './fileNaming';
import {createDefaultSpatialConfig, transformSpatialDataset} from './spatialTransform';
import {columnIndexToLetter, formatDisplayNumber, parseNumericValue} from './tabular';

const TRUE_TOKENS = new Set(['true', 'yes', 'y', '1']);
const FALSE_TOKENS = new Set(['false', 'no', 'n', '0']);
const MAX_EXAMPLES = 5;

export function parseBooleanToken(raw: string): boolean | null {
  const lower = raw.trim().toLowerCase();
  if (!lower) return null;
  if (TRUE_TOKENS.has(lower)) return true;
  if (FALSE_TOKENS.has(lower)) return false;
  return null;
}

function quantileSorted(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  const frac = pos - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

export interface DatasetOverviewAnalysis {
  summary: DatasetOverviewSummary;
  catalog: ColumnCatalogEntry[];
  observations: QualityObservation[];
  detailsByCol: Map<number, ColumnDetailSummary>;
}

interface RawColumnScan {
  colIndex: number;
  totalRows: number;
  nonEmptyCount: number;
  missingCount: number;
  firstMissingRow: number | null;
  valueCounts: Map<string, number>;
  firstRowForValue: Map<string, number>;
  numericValues: number[];
  nonNumericExamples: QualityExample[];
  nonNumericCount: number;
  negativeCount: number;
  zeroCount: number;
  positiveCount: number;
  trueCount: number;
  falseCount: number;
  unexpectedBoolCount: number;
  unexpectedBoolExamples: QualityExample[];
  temporalValidCount: number;
  temporalInvalidCount: number;
  temporalInvalidExamples: QualityExample[];
  earliestTs: number | null;
  latestTs: number | null;
  minLength: number;
  maxLength: number;
  totalLength: number;
  sampleTexts: string[];
}

function scanColumnExact(
  sheet: SheetData,
  colIndex: number,
  semanticType: SemanticType
): RawColumnScan {
  const rows = sheet.rows;
  const totalRows = rows.length;
  let nonEmptyCount = 0;
  let missingCount = 0;
  let firstMissingRow: number | null = null;

  const valueCounts = new Map<string, number>();
  const firstRowForValue = new Map<string, number>();
  const numericValues: number[] = [];
  const nonNumericExamples: QualityExample[] = [];
  let nonNumericCount = 0;
  let negativeCount = 0;
  let zeroCount = 0;
  let positiveCount = 0;

  let trueCount = 0;
  let falseCount = 0;
  let unexpectedBoolCount = 0;
  const unexpectedBoolExamples: QualityExample[] = [];

  let temporalValidCount = 0;
  let temporalInvalidCount = 0;
  const temporalInvalidExamples: QualityExample[] = [];
  let earliestTs: number | null = null;
  let latestTs: number | null = null;

  let minLength = Infinity;
  let maxLength = 0;
  let totalLength = 0;
  const sampleTexts: string[] = [];

  for (let r = 0; r < totalRows; r++) {
    const raw = (rows[r]?.[colIndex] ?? '').trim();
    if (!raw) {
      missingCount++;
      if (firstMissingRow === null) firstMissingRow = r;
      continue;
    }

    nonEmptyCount++;
    totalLength += raw.length;
    if (raw.length < minLength) minLength = raw.length;
    if (raw.length > maxLength) maxLength = raw.length;
    if (sampleTexts.length < 5 && !sampleTexts.includes(raw)) {
      sampleTexts.push(raw);
    }

    valueCounts.set(raw, (valueCounts.get(raw) ?? 0) + 1);
    if (!firstRowForValue.has(raw)) {
      firstRowForValue.set(raw, r);
    }

    if (semanticType === 'quantitative') {
      const parsed = parseNumericValue(raw);
      if (parsed.value !== null) {
        const v = parsed.value;
        numericValues.push(v);
        if (v < 0) negativeCount++;
        else if (v === 0) zeroCount++;
        else positiveCount++;
      } else {
        nonNumericCount++;
        if (nonNumericExamples.length < MAX_EXAMPLES) {
          nonNumericExamples.push({rowIndex: r, colIndex, value: raw});
        }
      }
    } else if (semanticType === 'boolean') {
      const parsedBool = parseBooleanToken(raw);
      if (parsedBool === true) trueCount++;
      else if (parsedBool === false) falseCount++;
      else {
        unexpectedBoolCount++;
        if (unexpectedBoolExamples.length < MAX_EXAMPLES) {
          unexpectedBoolExamples.push({rowIndex: r, colIndex, value: raw});
        }
      }
    } else if (semanticType === 'temporal') {
      const ts = parseTemporalValue(raw);
      if (ts !== null) {
        temporalValidCount++;
        if (earliestTs === null || ts < earliestTs) earliestTs = ts;
        if (latestTs === null || ts > latestTs) latestTs = ts;
      } else {
        temporalInvalidCount++;
        if (temporalInvalidExamples.length < MAX_EXAMPLES) {
          temporalInvalidExamples.push({rowIndex: r, colIndex, value: raw});
        }
      }
    }
  }

  return {
    colIndex,
    totalRows,
    nonEmptyCount,
    missingCount,
    firstMissingRow,
    valueCounts,
    firstRowForValue,
    numericValues,
    nonNumericExamples,
    nonNumericCount,
    negativeCount,
    zeroCount,
    positiveCount,
    trueCount,
    falseCount,
    unexpectedBoolCount,
    unexpectedBoolExamples,
    temporalValidCount,
    temporalInvalidCount,
    temporalInvalidExamples,
    earliestTs,
    latestTs,
    minLength: nonEmptyCount > 0 ? minLength : 0,
    maxLength,
    totalLength,
    sampleTexts,
  };
}

function buildDetailFromScan(
  sheet: SheetData,
  profile: DatasetProfile,
  scan: RawColumnScan
): ColumnDetailSummary {
  const colIndex = scan.colIndex;
  const colProfile = profile.columns[colIndex];
  const semanticType = colProfile ? getEffectiveSemanticType(colProfile) : 'text';
  const inferredSemanticType = colProfile?.semanticType ?? 'text';
  const roleOverride = colProfile?.roleOverride ?? null;
  const name = sheet.columns[colIndex] ?? `Column ${colIndex + 1}`;
  const letter = columnIndexToLetter(colIndex);
  const baseType = sheet.types[colIndex] ?? 'text';
  const unit = colProfile?.unit ?? null;
  const missingRate = scan.totalRows > 0 ? scan.missingCount / scan.totalRows : 0;
  const uniqueCount = scan.valueCounts.size;

  let numericStats: ColumnDetailSummary['numericStats'] = null;
  let categoricalStats: ColumnDetailSummary['categoricalStats'] = null;
  let booleanStats: ColumnDetailSummary['booleanStats'] = null;
  let temporalStats: ColumnDetailSummary['temporalStats'] = null;
  let identifierStats: ColumnDetailSummary['identifierStats'] = null;
  let textStats: ColumnDetailSummary['textStats'] = null;

  if (semanticType === 'quantitative') {
    const sorted = scan.numericValues.slice().sort((a, b) => a - b);
    const validCount = sorted.length;
    const sum = sorted.reduce((acc, v) => acc + v, 0);
    numericStats = {
      validCount,
      nonNumericCount: scan.nonNumericCount,
      min: validCount > 0 ? sorted[0] : 0,
      q1: validCount > 0 ? quantileSorted(sorted, 0.25) : 0,
      median: validCount > 0 ? quantileSorted(sorted, 0.5) : 0,
      mean: validCount > 0 ? sum / validCount : 0,
      q3: validCount > 0 ? quantileSorted(sorted, 0.75) : 0,
      max: validCount > 0 ? sorted[sorted.length - 1] : 0,
      negativeCount: scan.negativeCount,
      zeroCount: scan.zeroCount,
      positiveCount: scan.positiveCount,
    };
  } else if (semanticType === 'categorical') {
    const entries = Array.from(scan.valueCounts.entries()).sort((a, b) => b[1] - a[1]);
    const topSlice = entries.slice(0, 8);
    const shownCount = topSlice.reduce((acc, [, c]) => acc + c, 0);
    categoricalStats = {
      topValues: topSlice.map(([value, count]) => ({
        value,
        count,
        share: scan.nonEmptyCount > 0 ? count / scan.nonEmptyCount : 0,
      })),
      otherCount: Math.max(0, scan.nonEmptyCount - shownCount),
    };
  } else if (semanticType === 'boolean') {
    booleanStats = {
      trueCount: scan.trueCount,
      falseCount: scan.falseCount,
      unexpectedCount: scan.unexpectedBoolCount,
    };
  } else if (semanticType === 'temporal') {
    temporalStats = {
      validCount: scan.temporalValidCount,
      invalidCount: scan.temporalInvalidCount,
      earliestIso: scan.earliestTs !== null ? new Date(scan.earliestTs).toISOString().slice(0, 10) : null,
      latestIso: scan.latestTs !== null ? new Date(scan.latestTs).toISOString().slice(0, 10) : null,
    };
  } else if (semanticType === 'identifier') {
    const duplicates = Array.from(scan.valueCounts.entries())
      .filter(([, c]) => c > 1)
      .sort((a, b) => b[1] - a[1]);
    const duplicateRowCount = duplicates.reduce((acc, [, c]) => acc + c, 0);
    identifierStats = {
      uniqueNonEmptyCount: uniqueCount,
      duplicateValueCount: duplicates.length,
      duplicateRowCount,
      topDuplicates: duplicates.slice(0, 5).map(([value, count]) => ({value, count})),
    };
  } else {
    textStats = {
      minLength: scan.minLength,
      maxLength: scan.maxLength,
      avgLength: scan.nonEmptyCount > 0 ? scan.totalLength / scan.nonEmptyCount : 0,
      samples: scan.sampleTexts,
    };
  }

  return {
    colIndex,
    name,
    letter,
    semanticType,
    inferredSemanticType,
    roleOverride,
    baseType,
    unit,
    totalRows: scan.totalRows,
    nonEmptyCount: scan.nonEmptyCount,
    missingCount: scan.missingCount,
    missingRate,
    uniqueCount,
    numericStats,
    categoricalStats,
    booleanStats,
    temporalStats,
    identifierStats,
    textStats,
  };
}

export function analyzeDatasetOverview(
  workbook: WorkbookState,
  sheet: SheetData,
  visibleRowIndices: VisibleRowsSource,
  profile: DatasetProfile,
  columnView: ColumnViewState,
  dismissedIds?: ReadonlySet<string>
): DatasetOverviewAnalysis {
  const totalRows = sheet.rows.length;
  const visibleRows = visibleRowIndices.length;
  const totalCols = sheet.columns.length;
  const hiddenSet = new Set(columnView.hidden);
  const pinnedSet = new Set(columnView.pinned);
  const visibleCols = Math.max(0, totalCols - hiddenSet.size);

  const visualPositionByCol = new Map<number, number>();
  let visPos = 0;
  for (const colIndex of columnView.order) {
    if (!hiddenSet.has(colIndex)) {
      visualPositionByCol.set(colIndex, visPos++);
    }
  }

  const roleCounts: Record<SemanticType, number> = {
    quantitative: 0,
    categorical: 0,
    temporal: 0,
    boolean: 0,
    identifier: 0,
    text: 0,
  };

  let totalMissingCells = 0;
  const observations: QualityObservation[] = [];
  const detailsByCol = new Map<number, ColumnDetailSummary>();
  const issueCountByCol = new Map<number, number>();
  const primaryIssueByCol = new Map<number, string>();

  const recordIssue = (colIndex: number, obs: QualityObservation) => {
    observations.push(obs);
    if (dismissedIds?.has(obs.id)) return;
    issueCountByCol.set(colIndex, (issueCountByCol.get(colIndex) ?? 0) + 1);
    if (!primaryIssueByCol.has(colIndex)) {
      primaryIssueByCol.set(colIndex, obs.title);
    }
  };

  const scans: RawColumnScan[] = [];
  for (let c = 0; c < totalCols; c++) {
    const colProfile = profile.columns[c];
    const role: SemanticType = colProfile ? getEffectiveSemanticType(colProfile) : 'text';
    roleCounts[role]++;

    const scan = scanColumnExact(sheet, c, role);
    scans.push(scan);
    totalMissingCells += scan.missingCount;
    detailsByCol.set(c, buildDetailFromScan(sheet, profile, scan));

    const colName = sheet.columns[c] ?? `Column ${c + 1}`;
    const denom = Math.max(1, totalRows);

    // 1. Missing values (for identifier columns, tagged clearly under identifier category as well as counted in total missing)
    if (scan.missingCount > 0 && scan.firstMissingRow !== null) {
      const pct = ((scan.missingCount / denom) * 100).toFixed(1);
      const examples: QualityExample[] = [];
      for (let r = scan.firstMissingRow; r < totalRows && examples.length < MAX_EXAMPLES; r++) {
        if ((sheet.rows[r]?.[c] ?? '').trim() === '') {
          examples.push({rowIndex: r, colIndex: c, value: '(Empty)'});
        }
      }
      if (role === 'identifier') {
        recordIssue(c, {
          id: `id-missing:${c}`,
          category: 'identifier',
          severity: 'attention',
          colIndex: c,
          columnName: colName,
          title: `Missing ID values in "${colName}"`,
          explanation: `${scan.missingCount} of ${totalRows} rows (${pct}%) have blank values in identifier column "${colName}".`,
          affectedCount: scan.missingCount,
          affectedRate: scan.missingCount / denom,
          firstCell: {rowIndex: scan.firstMissingRow, colIndex: c},
          examples,
        });
      } else {
        recordIssue(c, {
          id: `missing:${c}`,
          category: 'missing',
          severity: scan.missingCount / denom >= 0.2 ? 'attention' : 'info',
          colIndex: c,
          columnName: colName,
          title: `Missing values in "${colName}"`,
          explanation: `${scan.missingCount} of ${totalRows} rows (${pct}%) are empty in "${colName}".`,
          affectedCount: scan.missingCount,
          affectedRate: scan.missingCount / denom,
          firstCell: {rowIndex: scan.firstMissingRow, colIndex: c},
          examples,
        });
      }
    }

    // 2. Potential type consistency issues
    if (role === 'quantitative' && scan.nonNumericCount > 0) {
      const firstEx = scan.nonNumericExamples[0];
      recordIssue(c, {
        id: `type:${c}`,
        category: 'type-consistency',
        severity: 'attention',
        colIndex: c,
        columnName: colName,
        title: `Potential numeric type inconsistency in "${colName}"`,
        explanation: `Classified as quantitative, but ${scan.nonNumericCount} non-empty ${scan.nonNumericCount === 1 ? 'value does' : 'values do'} not parse as numbers. Review whether these represent missing sentinels or mixed formatting.`,
        affectedCount: scan.nonNumericCount,
        affectedRate: scan.nonNumericCount / Math.max(1, scan.nonEmptyCount),
        firstCell: {rowIndex: firstEx.rowIndex, colIndex: c},
        examples: scan.nonNumericExamples,
      });
    } else if (role === 'boolean' && scan.unexpectedBoolCount > 0) {
      const firstEx = scan.unexpectedBoolExamples[0];
      recordIssue(c, {
        id: `type:${c}`,
        category: 'type-consistency',
        severity: 'attention',
        colIndex: c,
        columnName: colName,
        title: `Potential boolean inconsistency in "${colName}"`,
        explanation: `Classified as boolean, but ${scan.unexpectedBoolCount} non-empty ${scan.unexpectedBoolCount === 1 ? 'value is' : 'values are'} outside true/false/yes/no/1/0.`,
        affectedCount: scan.unexpectedBoolCount,
        affectedRate: scan.unexpectedBoolCount / Math.max(1, scan.nonEmptyCount),
        firstCell: {rowIndex: firstEx.rowIndex, colIndex: c},
        examples: scan.unexpectedBoolExamples,
      });
    } else if (role === 'temporal' && scan.temporalInvalidCount > 0) {
      const firstEx = scan.temporalInvalidExamples[0];
      recordIssue(c, {
        id: `type:${c}`,
        category: 'type-consistency',
        severity: 'attention',
        colIndex: c,
        columnName: colName,
        title: `Potential date/time inconsistency in "${colName}"`,
        explanation: `Classified as temporal, but ${scan.temporalInvalidCount} non-empty ${scan.temporalInvalidCount === 1 ? 'value did' : 'values did'} not parse as an explicit date or timestamp.`,
        affectedCount: scan.temporalInvalidCount,
        affectedRate: scan.temporalInvalidCount / Math.max(1, scan.nonEmptyCount),
        firstCell: {rowIndex: firstEx.rowIndex, colIndex: c},
        examples: scan.temporalInvalidExamples,
      });
    }

    // 3. Constant or near-constant columns
    if (totalRows > 0 && scan.nonEmptyCount === 0) {
      recordIssue(c, {
        id: `constant:${c}`,
        category: 'constant',
        severity: 'info',
        colIndex: c,
        columnName: colName,
        title: `Empty column "${colName}"`,
        explanation: `All ${totalRows} rows in "${colName}" are empty, so it carries no analytical variance.`,
        affectedCount: totalRows,
        affectedRate: 1,
        firstCell: {rowIndex: 0, colIndex: c},
        examples: [{rowIndex: 0, colIndex: c, value: '(Empty)'}],
      });
    } else if (scan.nonEmptyCount >= 2 && scan.valueCounts.size === 1) {
      const [[onlyVal]] = Array.from(scan.valueCounts.entries());
      const r0 = scan.firstRowForValue.get(onlyVal) ?? 0;
      recordIssue(c, {
        id: `constant:${c}`,
        category: 'constant',
        severity: 'info',
        colIndex: c,
        columnName: colName,
        title: `Constant column "${colName}"`,
        explanation: `All ${scan.nonEmptyCount} non-empty values equal "${onlyVal}", providing zero variance for comparisons.`,
        affectedCount: scan.nonEmptyCount,
        affectedRate: 1,
        firstCell: {rowIndex: r0, colIndex: c},
        examples: [{rowIndex: r0, colIndex: c, value: onlyVal}],
      });
    } else if (scan.nonEmptyCount >= 5) {
      const sortedVals = Array.from(scan.valueCounts.entries()).sort((a, b) => b[1] - a[1]);
      const [domVal, domCount] = sortedVals[0];
      const share = domCount / scan.nonEmptyCount;
      if (share >= 0.98 && sortedVals.length > 1) {
        const minorityExamples: QualityExample[] = [];
        for (const [val] of sortedVals.slice(1)) {
          const rIdx = scan.firstRowForValue.get(val);
          if (rIdx !== undefined && minorityExamples.length < MAX_EXAMPLES) {
            minorityExamples.push({rowIndex: rIdx, colIndex: c, value: val});
          }
        }
        const firstTarget = minorityExamples[0] ?? {
          rowIndex: scan.firstRowForValue.get(domVal) ?? 0,
          colIndex: c,
          value: domVal,
        };
        recordIssue(c, {
          id: `constant:${c}`,
          category: 'constant',
          severity: 'info',
          colIndex: c,
          columnName: colName,
          title: `Near-constant column "${colName}"`,
          explanation: `"${domVal}" accounts for ${(share * 100).toFixed(1)}% of non-empty values (${domCount}/${scan.nonEmptyCount}).`,
          affectedCount: domCount,
          affectedRate: share,
          firstCell: {rowIndex: firstTarget.rowIndex, colIndex: c},
          examples: minorityExamples.length > 0 ? minorityExamples : [firstTarget],
        });
      }
    }

    // 4. Duplicate identifiers in identifier columns
    if (role === 'identifier') {
      const dupValues = new Set<string>();
      for (const [val, count] of scan.valueCounts.entries()) {
        if (count > 1) dupValues.add(val);
      }
      if (dupValues.size > 0) {
        const dupExamples: QualityExample[] = [];
        let dupRows = 0;
        for (let r = 0; r < totalRows; r++) {
          const raw = (sheet.rows[r]?.[c] ?? '').trim();
          if (raw && dupValues.has(raw)) {
            dupRows++;
            if (dupExamples.length < MAX_EXAMPLES) {
              dupExamples.push({rowIndex: r, colIndex: c, value: raw});
            }
          }
        }
        const firstDup = dupExamples[0];
        recordIssue(c, {
          id: `id-dup:${c}`,
          category: 'identifier',
          severity: 'attention',
          colIndex: c,
          columnName: colName,
          title: `Duplicate identifiers in "${colName}"`,
          explanation: `${dupValues.size} identifier ${dupValues.size === 1 ? 'value appears' : 'values appear'} multiple times across ${dupRows} rows.`,
          affectedCount: dupRows,
          affectedRate: dupRows / denom,
          firstCell: firstDup ? {rowIndex: firstDup.rowIndex, colIndex: c} : null,
          examples: dupExamples,
        });
      }
    }
  }

  const totalCells = totalRows * totalCols;
  const summary: DatasetOverviewSummary = {
    workbookName: getWorkbookDisplayName(workbook),
    ...(workbook.sourceFileName !== undefined
      ? {sourceFileName: workbook.sourceFileName}
      : {}),
    fileName: workbook.fileName,
    fileFormat: workbook.fileFormat,
    sheetId: sheet.id,
    sheetName: sheet.name,
    totalRows,
    visibleRows,
    isFiltered: visibleRows !== totalRows,
    totalCols,
    visibleCols,
    hiddenCols: hiddenSet.size,
    pinnedCols: pinnedSet.size,
    totalCells,
    missingCells: totalMissingCells,
    missingRate: totalCells > 0 ? totalMissingCells / totalCells : 0,
    roleCounts,
  };

  const catalog: ColumnCatalogEntry[] = scans.map((scan) => {
    const colIndex = scan.colIndex;
    const colProfile = profile.columns[colIndex];
    const semanticType = colProfile ? getEffectiveSemanticType(colProfile) : 'text';
    const issueCount = issueCountByCol.get(colIndex) ?? 0;
    return {
      colIndex,
      letter: columnIndexToLetter(colIndex),
      name: sheet.columns[colIndex] ?? `Column ${colIndex + 1}`,
      baseType: sheet.types[colIndex] ?? 'text',
      semanticType,
      inferredSemanticType: colProfile?.semanticType ?? 'text',
      roleOverride: colProfile?.roleOverride ?? null,
      unit: colProfile?.unit ?? null,
      totalRows,
      nonEmptyCount: scan.nonEmptyCount,
      missingCount: scan.missingCount,
      missingRate: totalRows > 0 ? scan.missingCount / totalRows : 0,
      cardinality: scan.valueCounts.size,
      isHidden: hiddenSet.has(colIndex),
      isPinned: pinnedSet.has(colIndex),
      visualPosition: visualPositionByCol.get(colIndex) ?? -1,
      hasIssues: issueCount > 0,
      issueCount,
      primaryIssueSummary: primaryIssueByCol.get(colIndex) ?? null,
    };
  });

  // Sort observations deterministically: attention first, then category priority, then affected count desc
  const severityWeight = (s: QualityObservation['severity']) => (s === 'attention' ? 0 : 1);
  const categoryWeight = (cat: QualityObservation['category']) => {
    if (cat === 'type-consistency') return 0;
    if (cat === 'identifier') return 1;
    if (cat === 'missing') return 2;
    return 3;
  };
  observations.sort((a, b) => {
    const sw = severityWeight(a.severity) - severityWeight(b.severity);
    if (sw !== 0) return sw;
    const cw = categoryWeight(a.category) - categoryWeight(b.category);
    if (cw !== 0) return cw;
    return b.affectedCount - a.affectedCount;
  });

  return {summary, catalog, observations, detailsByCol};
}

export function filterAndSortColumnCatalog(
  entries: ColumnCatalogEntry[],
  filter: CatalogFilterState
): ColumnCatalogEntry[] {
  const q = filter.search.trim().toLowerCase();
  const filtered = entries.filter((entry) => {
    if (filter.role !== 'all' && entry.semanticType !== filter.role) return false;
    if (filter.issuesOnly && !entry.hasIssues) return false;
    if (!q) return true;
    return (
      entry.name.toLowerCase().includes(q) ||
      entry.letter.toLowerCase().includes(q) ||
      entry.semanticType.toLowerCase().includes(q)
    );
  });

  const sorted = filtered.slice();
  sorted.sort((a, b) => {
    switch (filter.sortBy) {
      case 'name':
        return a.name.localeCompare(b.name, 'en', {sensitivity: 'base'}) || a.colIndex - b.colIndex;
      case 'missing':
        return b.missingCount - a.missingCount || a.colIndex - b.colIndex;
      case 'role':
        return a.semanticType.localeCompare(b.semanticType) || a.colIndex - b.colIndex;
      case 'cardinality':
        return b.cardinality - a.cardinality || a.colIndex - b.colIndex;
      case 'source':
      default:
        return a.colIndex - b.colIndex;
    }
  });
  return sorted;
}

export function getValidatedSuggestedAnalyses(
  sheet: SheetData,
  visibleRowIndices: VisibleRowsSource,
  profile: DatasetProfile,
  baseChartConfig: ChartConfig,
  baseSpatialConfig: SpatialConfig
): SuggestedAnalysisItem[] {
  if (sheet.rows.length === 0 || visibleRowIndices.length === 0 || sheet.columns.length === 0) {
    return [];
  }

  const candidates = recommendCharts(profile);
  const validated: SuggestedAnalysisItem[] = [];

  for (const rec of candidates) {
    if (rec.targetSurface === '2d') {
      const candidate2D: ChartConfig = {
        ...baseChartConfig,
        ...(rec.suggested2D ?? {}),
        ...(rec.chartType ? {type: rec.chartType} : {}),
      };
      if (validateChartConfig(sheet, profile, candidate2D) !== null) {
        continue;
      }
      const xName = sheet.columns[candidate2D.xColIndex] ?? 'X';
      const yNames = candidate2D.yColIndices
        .map((c) => sheet.columns[c])
        .filter(Boolean)
        .join(', ');
      validated.push({
        recommendation: rec,
        targetLayout: 'charts',
        summary: `2D ${candidate2D.type.toUpperCase()} · X: ${xName} · Y: ${yNames}`,
      });
    } else {
      const mode = rec.spatialMode ?? baseChartConfig.spatialMode;
      const defaults = createDefaultSpatialConfig(profile, baseChartConfig);
      const candidateSpatial: SpatialConfig = {
        ...defaults,
        ...baseSpatialConfig,
        ...(rec.suggestedSpatial ?? {}),
      };
      const derived = transformSpatialDataset({
        sheet,
        visibleRowIndices,
        profile,
        config: candidateSpatial,
        mode,
        yColIndices: baseChartConfig.yColIndices,
      });
      if (!derived.isValid || derived.items.length === 0) {
        continue;
      }
      validated.push({
        recommendation: rec,
        targetLayout: 'spatial',
        summary: `${mode.toUpperCase()} · ${derived.dataStateSummary}`,
      });
    }
  }

  return validated;
}

export function formatMetricPreview(detail: ColumnDetailSummary): string {
  if (detail.numericStats && detail.numericStats.validCount > 0) {
    const s = detail.numericStats;
    const unitSuffix = detail.unit && detail.unit !== '%' ? ` ${detail.unit}` : '';
    return `Min ${formatDisplayNumber(s.min, detail.baseType)}${unitSuffix} · Med ${formatDisplayNumber(s.median, detail.baseType)} · Max ${formatDisplayNumber(s.max, detail.baseType)}${unitSuffix}`;
  }
  if (detail.booleanStats) {
    return `True ${detail.booleanStats.trueCount} · False ${detail.booleanStats.falseCount}`;
  }
  if (detail.temporalStats && detail.temporalStats.earliestIso && detail.temporalStats.latestIso) {
    return `${detail.temporalStats.earliestIso} → ${detail.temporalStats.latestIso}`;
  }
  if (detail.categoricalStats && detail.categoricalStats.topValues.length > 0) {
    const top = detail.categoricalStats.topValues[0];
    return `${detail.uniqueCount} distinct · Top: ${top.value} (${top.count})`;
  }
  if (detail.identifierStats) {
    return `${detail.identifierStats.uniqueNonEmptyCount} unique IDs${detail.identifierStats.duplicateValueCount > 0 ? ` · ${detail.identifierStats.duplicateValueCount} dup` : ''}`;
  }
  if (detail.textStats && detail.nonEmptyCount > 0) {
    return `Avg length ${detail.textStats.avgLength.toFixed(1)} chars`;
  }
  return detail.missingCount === detail.totalRows ? 'All empty' : `${detail.uniqueCount} unique`;
}
