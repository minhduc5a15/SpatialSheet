import type {ChartAggregationMode, ChartSortOrder, DatasetProfile, SheetData, VisibleRowsSource} from '../types';
import {parseNumericValue} from './tabular';
import {sampleChartIndices} from './virtualWindow';
const DEFAULT_MAX_CHART_POINTS = 32;

export interface DataPointRow {
  rowIndex: number;
  label: string;
  values: (number | null)[];
  hasAnyNumeric: boolean;
  xNumeric: number | null;
  groupCount?: number;
  validCounts?: number[];
}

export interface ExtractChart2DOptions {
  maxPoints?: number;
  aggregation?: ChartAggregationMode;
  sortOrder?: ChartSortOrder;
  profile?: DatasetProfile | null;
}

export function parseChartCellValue(raw: string, isBoolCol: boolean): number | null {
  const p = parseNumericValue(raw);
  if (p.value !== null) return p.value;
  if (!isBoolCol) return null;
  const low = raw.trim().toLowerCase();
  if (low === 'true' || low === 'yes' || low === 'y') return 1;
  if (low === 'false' || low === 'no' || low === 'n') return 0;
  return null;
}

function isBooleanColumn(
  profile: DatasetProfile | null | undefined,
  colIdx: number
): boolean {
  const col = profile?.columns[colIdx];
  const sem = col?.roleOverride ?? col?.semanticType;
  return sem === 'boolean';
}

export function extractChart2DPoints(
  sheet: SheetData,
  visibleRowIndices: VisibleRowsSource,
  xColIndex: number,
  yColIndices: number[],
  options?: ExtractChart2DOptions
): {points: DataPointRow[]; hasAnyNumeric: boolean} {
  const maxPoints = Math.max(4, options?.maxPoints ?? DEFAULT_MAX_CHART_POINTS);
  const aggregation: ChartAggregationMode = options?.aggregation ?? 'none';
  const sortOrder: ChartSortOrder = options?.sortOrder ?? 'source';
  const profile = options?.profile ?? null;
  const boolFlags = yColIndices.map((c) => isBooleanColumn(profile, c));

  // Fast default path (no aggregation & source order)
  if (aggregation === 'none' && sortOrder === 'source') {
    const sampledIndices = sampleChartIndices(visibleRowIndices, maxPoints);
    let hasAnyNumeric = false;
    const points: DataPointRow[] = new Array<DataPointRow>(sampledIndices.length);

    for (let i = 0; i < sampledIndices.length; i++) {
      const rowIndex = sampledIndices[i];
      const row = sheet.rows[rowIndex] ?? [];
      const rawLabel = (row[xColIndex] ?? '').trim() || `Row ${rowIndex + 1}`;
      const xParsed = parseNumericValue(rawLabel).value;
      const values = new Array<number | null>(yColIndices.length);
      let rowHasNum = false;
      for (let s = 0; s < yColIndices.length; s++) {
        const val = parseChartCellValue(row[yColIndices[s]] ?? '', boolFlags[s]);
        if (val !== null) {
          values[s] = val;
          rowHasNum = true;
          hasAnyNumeric = true;
        } else {
          values[s] = null;
        }
      }
      points[i] = {
        rowIndex,
        label: rawLabel,
        values,
        hasAnyNumeric: rowHasNum,
        xNumeric: xParsed,
        groupCount: 1,
      };
    }

    return {points, hasAnyNumeric};
  }

  // Raw sorted path
  if (aggregation === 'none') {
    const scanCap = visibleRowIndices.length <= 25000 ? visibleRowIndices.length : 4000;
    const candidateIndices =
      visibleRowIndices.length <= scanCap
        ? visibleRowIndices
        : sampleChartIndices(visibleRowIndices, scanCap);

    let hasAnyNumeric = false;
    const allRows: DataPointRow[] = new Array<DataPointRow>(candidateIndices.length);
    for (let i = 0; i < candidateIndices.length; i++) {
      const rowIndex = candidateIndices[i];
      const row = sheet.rows[rowIndex] ?? [];
      const rawLabel = (row[xColIndex] ?? '').trim() || `Row ${rowIndex + 1}`;
      const xParsed = parseNumericValue(rawLabel).value;
      const values = new Array<number | null>(yColIndices.length);
      let rowHasNum = false;
      for (let s = 0; s < yColIndices.length; s++) {
        const val = parseChartCellValue(row[yColIndices[s]] ?? '', boolFlags[s]);
        if (val !== null) {
          values[s] = val;
          rowHasNum = true;
          hasAnyNumeric = true;
        } else {
          values[s] = null;
        }
      }
      allRows[i] = {
        rowIndex,
        label: rawLabel,
        values,
        hasAnyNumeric: rowHasNum,
        xNumeric: xParsed,
        groupCount: 1,
      };
    }

    if (sortOrder === 'value-desc' || sortOrder === 'value-asc') {
      const dir = sortOrder === 'value-desc' ? -1 : 1;
      allRows.sort((a, b) => {
        const av = a.values[0];
        const bv = b.values[0];
        if (av === null && bv === null) return 0;
        if (av === null) return 1;
        if (bv === null) return -1;
        return (av - bv) * dir;
      });
    }

    return {
      points: allRows.slice(0, maxPoints),
      hasAnyNumeric,
    };
  }

  // Grouped aggregation path ('sum' | 'avg' | 'count')
  const groups = new Map<
    string,
    {
      label: string;
      firstRowIndex: number;
      xNumeric: number | null;
      sums: number[];
      counts: number[];
      rowCount: number;
    }
  >();

  for (let i = 0; i < visibleRowIndices.length; i++) {
    const rowIndex = visibleRowIndices[i];
    const row = sheet.rows[rowIndex] ?? [];
    const rawLabel = (row[xColIndex] ?? '').trim() || '(Empty)';
    let group = groups.get(rawLabel);
    if (!group) {
      group = {
        label: rawLabel,
        firstRowIndex: rowIndex,
        xNumeric: parseNumericValue(rawLabel).value,
        sums: new Array<number>(yColIndices.length).fill(0),
        counts: new Array<number>(yColIndices.length).fill(0),
        rowCount: 0,
      };
      groups.set(rawLabel, group);
    }
    group.rowCount += 1;
    for (let s = 0; s < yColIndices.length; s++) {
      const val = parseChartCellValue(row[yColIndices[s]] ?? '', boolFlags[s]);
      if (val !== null) {
        group.sums[s] += val;
        group.counts[s] += 1;
      }
    }
  }

  let hasAnyNumeric = false;
  const aggregatedPoints: DataPointRow[] = [];
  for (const g of groups.values()) {
    const values = new Array<number | null>(yColIndices.length);
    let rowHasNum = false;
    for (let s = 0; s < yColIndices.length; s++) {
      if (aggregation === 'count') {
        values[s] = g.counts[s];
        rowHasNum = true;
        hasAnyNumeric = true;
      } else if (g.counts[s] > 0) {
        values[s] =
          aggregation === 'avg' ? g.sums[s] / g.counts[s] : g.sums[s];
        rowHasNum = true;
        hasAnyNumeric = true;
      } else {
        values[s] = null;
      }
    }
    aggregatedPoints.push({
      rowIndex: g.firstRowIndex,
      label: g.label,
      values,
      hasAnyNumeric: rowHasNum,
      xNumeric: g.xNumeric,
      groupCount: g.rowCount,
      validCounts: g.counts,
    });
  }

  if (sortOrder === 'value-desc' || sortOrder === 'value-asc') {
    const dir = sortOrder === 'value-desc' ? -1 : 1;
    aggregatedPoints.sort((a, b) => {
      const av = a.values[0];
      const bv = b.values[0];
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return (av - bv) * dir;
    });
  }

  return {
    points: aggregatedPoints.slice(0, maxPoints),
    hasAnyNumeric,
  };
}

