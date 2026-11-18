import type {
  ColumnProfile,
  DatasetProfile,
  SemanticType,
  SheetData,
} from '../types';
import {parseNumericValue} from './tabular';

const PROFILE_SAMPLE_LIMIT = 2000;

const EXPLICIT_ID_HEADER_RE =
  /(?:^|[_\s\-.])(id|uuid|guid|sku|code|postal|zip|key|index|seq|row_?id|record_?id|account_?no|invoice_?no)(?:$|[_\s\-.])/i;

const UNIT_PAREN_RE = /\(([^()]{1,18})\)\s*$/;
const UNIT_BRACKET_RE = /\[([^\[\]]{1,18})\]\s*$/;

const BOOLEAN_TOKENS = new Set([
  'true',
  'false',
  'yes',
  'no',
  'y',
  'n',
]);

const MONTH_NAME_RE =
  /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*[\s,-]+\d{4}$/i;
const ISO_DATE_RE =
  /^\d{4}[-/]\d{1,2}(?:[-/]\d{1,2})?(?:[T\s]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i;
const SLASH_DATE_RE = /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/;
const QUARTER_RE = /^(?:(\d{4})[-/\s]?Q([1-4])|Q([1-4])[-/\s]?(\d{4}))$/i;

/**
 * Extracts an explicit unit ONLY when visibly written in the column header
 * (e.g. "Latency (ms)", "Revenue [USD]", "Score (%)") or consistently as '%' suffix values.
 * Never fabricates units for plain headers.
 */
export function extractExplicitHeaderUnit(colName: string): string | null {
  const trimmed = colName.trim();
  const parenMatch = trimmed.match(UNIT_PAREN_RE);
  if (parenMatch) {
    const candidate = parenMatch[1].trim();
    // Ignore duplicate-column suffixes like "Revenue (2)" or "(3)"
    if (candidate && !/^\d+$/.test(candidate)) {
      return candidate;
    }
  }
  const bracketMatch = trimmed.match(UNIT_BRACKET_RE);
  if (bracketMatch) {
    const candidate = bracketMatch[1].trim();
    if (candidate && !/^\d+$/.test(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Parses explicit date/timestamp strings to epoch milliseconds.
 * Intentionally rejects plain integers/floats so numbers aren't misread as dates.
 */
export function parseTemporalValue(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return null;

  const qMatch = trimmed.match(QUARTER_RE);
  if (qMatch) {
    const year = Number(qMatch[1] ?? qMatch[4]);
    const quarter = Number(qMatch[2] ?? qMatch[3]);
    if (Number.isFinite(year) && quarter >= 1 && quarter <= 4) {
      return Date.UTC(year, (quarter - 1) * 3, 1);
    }
  }

  if (
    !ISO_DATE_RE.test(trimmed) &&
    !SLASH_DATE_RE.test(trimmed) &&
    !MONTH_NAME_RE.test(trimmed)
  ) {
    return null;
  }

  // Handle YYYY-MM explicitly for reliable UTC parsing
  if (/^\d{4}[-/]\d{1,2}$/.test(trimmed)) {
    const [yStr, mStr] = trimmed.split(/[-/]/);
    const y = Number(yStr);
    const m = Number(mStr);
    if (m >= 1 && m <= 12) {
      return Date.UTC(y, m - 1, 1);
    }
    return null;
  }

  const ts = Date.parse(trimmed);
  return Number.isFinite(ts) ? ts : null;
}

function getSampleRowIndices(totalRows: number): number[] {
  if (totalRows <= PROFILE_SAMPLE_LIMIT) {
    const arr = new Array<number>(totalRows);
    for (let i = 0; i < totalRows; i++) arr[i] = i;
    return arr;
  }
  const arr = new Array<number>(PROFILE_SAMPLE_LIMIT);
  const step = (totalRows - 1) / (PROFILE_SAMPLE_LIMIT - 1);
  for (let i = 0; i < PROFILE_SAMPLE_LIMIT; i++) {
    arr[i] = Math.round(i * step);
  }
  return arr;
}

function rebuildRoleIndexLists(
  columns: ColumnProfile[]
): Pick<
  DatasetProfile,
  'quantCols' | 'catCols' | 'temporalCols' | 'boolCols' | 'idCols'
> {
  const quantCols: number[] = [];
  const catCols: number[] = [];
  const temporalCols: number[] = [];
  const boolCols: number[] = [];
  const idCols: number[] = [];

  for (const col of columns) {
    const eff = col.roleOverride ?? col.semanticType;
    switch (eff) {
      case 'quantitative':
        quantCols.push(col.colIndex);
        break;
      case 'categorical':
        catCols.push(col.colIndex);
        break;
      case 'temporal':
        temporalCols.push(col.colIndex);
        break;
      case 'boolean':
        boolCols.push(col.colIndex);
        break;
      case 'identifier':
        idCols.push(col.colIndex);
        break;
      case 'text':
        // Text columns are intentionally omitted from default categorical/metric picks
        break;
    }
  }

  return {quantCols, catCols, temporalCols, boolCols, idCols};
}

export function getEffectiveSemanticType(col: ColumnProfile): SemanticType {
  return col.roleOverride ?? col.semanticType;
}

export function profileSingleColumn(
  sheet: SheetData,
  colIndex: number,
  sampleRowIndices?: number[],
  previousOverride?: SemanticType
): ColumnProfile {
  const colName = sheet.columns[colIndex] ?? `Column ${colIndex + 1}`;
  const baseType = sheet.types[colIndex] ?? 'text';
  const totalRows = sheet.rows.length;
  const indices = sampleRowIndices ?? getSampleRowIndices(totalRows);
  const isSampled = totalRows > indices.length;

  let missingCount = 0;
  let nonEmptyCount = 0;
  let numericCount = 0;
  let percentCount = 0;
  let temporalCount = 0;
  let boolWordCount = 0;
  let totalCharLength = 0;
  let hasCurrencyCue = false;
  let hasDecimal = false;
  let isSequentialOneBasedOrZeroBased = true;

  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let hasNegative = false;
  let hasZero = false;
  let hasPositive = false;

  const uniqueVals = new Set<string>();
  const numericValues: number[] = [];

  for (let s = 0; s < indices.length; s++) {
    const rIdx = indices[s];
    const raw = (sheet.rows[rIdx]?.[colIndex] ?? '').trim();
    if (!raw) {
      missingCount++;
      continue;
    }

    nonEmptyCount++;
    totalCharLength += raw.length;
    uniqueVals.add(raw);

    const lower = raw.toLowerCase();
    if (BOOLEAN_TOKENS.has(lower)) {
      boolWordCount++;
    }

    const parsed = parseNumericValue(raw);
    if (parsed.value !== null) {
      const v = parsed.value;
      numericCount++;
      numericValues.push(v);
      sum += v;
      if (v < min) min = v;
      if (v > max) max = v;
      if (v < 0) hasNegative = true;
      else if (v === 0) hasZero = true;
      else hasPositive = true;

      if (parsed.isPercent) percentCount++;
      if (/[₫$€£¥]|(VND|USD|EUR)$/i.test(raw)) hasCurrencyCue = true;
      if (!Number.isInteger(v)) hasDecimal = true;
    } else {
      isSequentialOneBasedOrZeroBased = false;
      if (parseTemporalValue(raw) !== null) {
        temporalCount++;
      }
    }
  }

  const cardinality = uniqueVals.size;
  const avgLen = nonEmptyCount > 0 ? totalCharLength / nonEmptyCount : 0;
  const uniqueRatio = nonEmptyCount > 0 ? cardinality / nonEmptyCount : 0;
  const isHighCardinality = cardinality > 24 && uniqueRatio > 0.35;

  // Check if numeric column is a strict sequential row index (e.g. 1, 2, 3, ...)
  if (
    isSequentialOneBasedOrZeroBased &&
    numericCount >= 5 &&
    !hasDecimal &&
    !hasCurrencyCue &&
    percentCount === 0 &&
    uniqueRatio === 1
  ) {
    const startVal = numericValues[0];
    if (startVal === 0 || startVal === 1) {
      for (let i = 0; i < numericValues.length; i++) {
        if (numericValues[i] !== startVal + (indices[i] - indices[0])) {
          isSequentialOneBasedOrZeroBased = false;
          break;
        }
      }
    } else {
      isSequentialOneBasedOrZeroBased = false;
    }
  } else {
    isSequentialOneBasedOrZeroBased = false;
  }

  // Unit extraction strictly from explicit header cues or explicit '%' suffix
  let unit = extractExplicitHeaderUnit(colName);
  if (!unit && numericCount > 0 && percentCount / numericCount >= 0.7) {
    unit = '%';
  }

  // Classify semantic type deterministically
  let semanticType: SemanticType = 'text';
  if (nonEmptyCount === 0) {
    semanticType = 'text';
  } else if (boolWordCount / nonEmptyCount >= 0.85 && cardinality <= 2) {
    semanticType = 'boolean';
  } else if (temporalCount / nonEmptyCount >= 0.75) {
    semanticType = 'temporal';
  } else if (
    EXPLICIT_ID_HEADER_RE.test(colName) &&
    nonEmptyCount >= 4 &&
    uniqueRatio >= 0.85 &&
    !hasCurrencyCue &&
    percentCount === 0
  ) {
    semanticType = 'identifier';
  } else if (
    numericCount === nonEmptyCount &&
    cardinality === 2 &&
    min === 0 &&
    max === 1 &&
    !hasCurrencyCue &&
    percentCount === 0 &&
    unit === null &&
    nonEmptyCount >= 4
  ) {
    semanticType = 'boolean';
  } else if (isSequentialOneBasedOrZeroBased) {
    semanticType = 'identifier';
  } else if (numericCount / nonEmptyCount >= 0.75) {
    semanticType = 'quantitative';
  } else if (
    cardinality <= Math.max(24, Math.floor(nonEmptyCount * 0.45)) &&
    avgLen <= 40
  ) {
    semanticType = 'categorical';
  } else if (uniqueRatio <= 0.7 && avgLen <= 28 && cardinality <= 80) {
    semanticType = 'categorical';
  } else {
    semanticType = 'text';
  }

  return {
    colIndex,
    name: colName,
    baseType,
    semanticType,
    unit,
    missingCount,
    nonEmptyCount,
    cardinality,
    isHighCardinality,
    min: numericCount > 0 ? min : null,
    max: numericCount > 0 ? max : null,
    mean: numericCount > 0 ? sum / numericCount : null,
    hasNegative,
    hasZero,
    hasPositive,
    sampleCount: indices.length,
    totalRows,
    isSampled,
    ...(previousOverride ? {roleOverride: previousOverride} : {}),
  };
}

export function profileDataset(
  sheet: SheetData,
  sheetVersion = 1,
  existingOverrides?: Map<number, SemanticType>
): DatasetProfile {
  const sampleIndices = getSampleRowIndices(sheet.rows.length);
  const columns = new Array<ColumnProfile>(sheet.columns.length);
  for (let c = 0; c < sheet.columns.length; c++) {
    columns[c] = profileSingleColumn(
      sheet,
      c,
      sampleIndices,
      existingOverrides?.get(c)
    );
  }
  const lists = rebuildRoleIndexLists(columns);
  return {
    sheetId: sheet.id,
    sheetVersion,
    rowCount: sheet.rows.length,
    colCount: sheet.columns.length,
    columns,
    ...lists,
  };
}

export function reprofileColumn(
  prevProfile: DatasetProfile,
  sheet: SheetData,
  colIndex: number,
  sheetVersion: number
): DatasetProfile {
  if (
    prevProfile.sheetId !== sheet.id ||
    prevProfile.colCount !== sheet.columns.length ||
    prevProfile.rowCount !== sheet.rows.length
  ) {
    const overrides = new Map<number, SemanticType>();
    for (const col of prevProfile.columns) {
      if (col.roleOverride) overrides.set(col.colIndex, col.roleOverride);
    }
    return profileDataset(sheet, sheetVersion, overrides);
  }

  const nextColumns = prevProfile.columns.slice();
  const prevOverride = nextColumns[colIndex]?.roleOverride;
  nextColumns[colIndex] = profileSingleColumn(
    sheet,
    colIndex,
    undefined,
    prevOverride
  );
  const lists = rebuildRoleIndexLists(nextColumns);
  return {
    ...prevProfile,
    sheetVersion,
    columns: nextColumns,
    ...lists,
  };
}

export function applyColumnRoleOverride(
  profile: DatasetProfile,
  colIndex: number,
  role: SemanticType | null
): DatasetProfile {
  if (colIndex < 0 || colIndex >= profile.columns.length) return profile;
  const nextColumns = profile.columns.slice();
  const cur = nextColumns[colIndex];
  const updated: ColumnProfile = {...cur};
  if (role === null || role === cur.semanticType) {
    delete updated.roleOverride;
  } else {
    updated.roleOverride = role;
  }
  nextColumns[colIndex] = updated;
  const lists = rebuildRoleIndexLists(nextColumns);
  return {
    ...profile,
    columns: nextColumns,
    ...lists,
  };
}
