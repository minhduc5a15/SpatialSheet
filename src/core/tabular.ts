import type {
  ChartConfig,
  ColumnStats,
  ColumnType,
  SheetData,
  SortState,
  VisibleRowsSource,
  WorkbookState,
} from '../types';

export const CHART_PALETTE = [
  '#2563eb', // Cobalt
  '#059669', // Emerald
  '#d97706', // Amber
  '#e11d48', // Rose
  '#4f46e5', // Indigo
  '#0d9488', // Teal
] as const;

const EN_COLLATOR = new Intl.Collator('en', {
  numeric: true,
  sensitivity: 'base',
});

const INFER_SAMPLE_LIMIT = 2000;

export function columnIndexToLetter(index: number): string {
  let result = '';
  let n = index;
  while (n >= 0) {
    result = String.fromCharCode((n % 26) + 65) + result;
    n = Math.floor(n / 26) - 1;
  }
  return result;
}

export function detectDelimiter(text: string): string {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const sampleLines: string[] = [];
  let segStart = 0;
  let current = '';
  let inQuotes = false;
  const limit = Math.min(clean.length, 64 * 1024);

  for (let i = 0; i < limit && sampleLines.length < 6; i++) {
    const ch = clean[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      current += clean.slice(segStart, i);
      if (current.trim().length > 0) {
        sampleLines.push(current);
      }
      current = '';
      if (ch === '\r' && clean[i + 1] === '\n') i++;
      segStart = i + 1;
    }
  }
  if (sampleLines.length < 6 && segStart < limit) {
    current += clean.slice(segStart, limit);
    if (current.trim().length > 0) {
      sampleLines.push(current);
    }
  }

  const candidates = [',', ';', '\t'];
  let bestDelim = ',';
  let bestScore = -1;

  for (const delim of candidates) {
    let minCount = Infinity;
    let totalCount = 0;
    let firstCount = -1;
    let allSame = true;

    for (const line of sampleLines) {
      const c = countOutsideQuotes(line, delim);
      if (firstCount === -1) firstCount = c;
      else if (c !== firstCount) allSame = false;
      if (c < minCount) minCount = c;
      totalCount += c;
    }

    if (totalCount === 0) continue;
    const consistent = allSame ? 10 : 0;
    const score = totalCount + (minCount > 0 ? 5 : 0) + consistent;
    if (score > bestScore) {
      bestScore = score;
      bestDelim = delim;
    }
  }

  return bestDelim;
}

function countOutsideQuotes(line: string, delim: string): number {
  let count = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === delim && !inQuotes) {
      count++;
    }
  }
  return count;
}

export function parseCsvRecords(text: string, delimiter?: string): string[][] {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (!clean.trim()) return [];
  const delim = delimiter ?? detectDelimiter(clean);
  const delimCode = delim.charCodeAt(0);

  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let segStart = 0;
  let inQuotes = false;
  let hasTail = false;
  const len = clean.length;

  for (let i = 0; i < len; i++) {
    const code = clean.charCodeAt(i);

    if (inQuotes) {
      if (code === 34 /* " */) {
        if (i > segStart) field += clean.slice(segStart, i);
        if (clean.charCodeAt(i + 1) === 34) {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
        segStart = i + 1;
      }
    } else if (code === 34 /* " */) {
      if (i > segStart) field += clean.slice(segStart, i);
      inQuotes = true;
      hasTail = true;
      segStart = i + 1;
    } else if (code === delimCode) {
      row.push(i > segStart ? field + clean.slice(segStart, i) : field);
      field = '';
      hasTail = true;
      segStart = i + 1;
    } else if (code === 13 /* \r */ || code === 10 /* \n */) {
      row.push(i > segStart ? field + clean.slice(segStart, i) : field);
      records.push(row);
      row = [];
      field = '';
      hasTail = false;
      if (code === 13 && clean.charCodeAt(i + 1) === 10) {
        i++;
      }
      segStart = i + 1;
    }
  }

  if (segStart < len) {
    field += clean.slice(segStart);
    hasTail = true;
  }

  if (hasTail || field.length > 0 || row.length > 0) {
    row.push(field);
    records.push(row);
  }

  // Drop trailing completely empty rows
  while (
    records.length > 0 &&
    records[records.length - 1].every((cell) => cell.trim() === '')
  ) {
    records.pop();
  }

  return records;
}

export function normalizeRecordsToSheet(
  records: unknown[][],
  sheetName = 'Sheet 1',
  id = 'sheet-1'
): SheetData {
  if (records.length === 0) {
    return {
      id,
      name: sheetName,
      columns: ['Column A', 'Column B', 'Column C'],
      rows: [['', '', '']],
      types: ['text', 'text', 'text'],
    };
  }

  let maxCols = 1;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (Array.isArray(r) && r.length > maxCols) {
      maxCols = r.length;
    }
  }

  const rawHeaders = Array.isArray(records[0]) ? records[0] : [];
  const seen = new Map<string, number>();
  const columns = new Array<string>(maxCols);

  for (let c = 0; c < maxCols; c++) {
    const raw = String(rawHeaders[c] ?? '').trim();
    const base = raw || `Column ${columnIndexToLetter(c)}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    columns[c] = count === 0 ? base : `${base} (${count + 1})`;
  }

  const rowCount = Math.max(0, records.length - 1);
  const rows = new Array<string[]>(rowCount);
  for (let r = 1; r < records.length; r++) {
    const sourceRow = Array.isArray(records[r]) ? records[r] : [];
    const normalizedRow = new Array<string>(maxCols);
    for (let c = 0; c < maxCols; c++) {
      const cell = sourceRow[c];
      normalizedRow[c] =
        cell === null || cell === undefined
          ? ''
          : typeof cell === 'string'
            ? cell
            : String(cell);
    }
    rows[r - 1] = normalizedRow;
  }

  const types = inferColumnTypes(columns, rows);
  return {
    id,
    name: sheetName,
    columns,
    rows,
    types,
  };
}

export function parseCsvText(
  text: string,
  sheetName = 'CSV Data',
  id = 'sheet-csv'
): SheetData {
  const records = parseCsvRecords(text);
  return normalizeRecordsToSheet(records, sheetName, id);
}

export function serializeCsv(sheet: SheetData): string {
  const escapeCell = (val: string): string => {
    if (
      val.includes(',') ||
      val.includes('"') ||
      val.includes('\n') ||
      val.includes('\r')
    ) {
      return `"${val.replace(/"/g, '""')}"`;
    }
    return val;
  };

  const lines = new Array<string>(sheet.rows.length + 1);
  lines[0] = sheet.columns.map(escapeCell).join(',');
  const colCount = sheet.columns.length;
  for (let r = 0; r < sheet.rows.length; r++) {
    const row = sheet.rows[r];
    const cells = new Array<string>(colCount);
    for (let c = 0; c < colCount; c++) {
      cells[c] = escapeCell(row[c] ?? '');
    }
    lines[r + 1] = cells.join(',');
  }
  return lines.join('\r\n');
}

export function parseNumericValue(raw: string): {
  value: number | null;
  isPercent: boolean;
} {
  const trimmed = raw.trim();
  if (!trimmed) return {value: null, isPercent: false};

  const isPercent = trimmed.endsWith('%');
  let cleaned = isPercent ? trimmed.slice(0, -1).trim() : trimmed;

  // Strip common currency markers and whitespace
  cleaned = cleaned.replace(/[₫$€£¥\s]/g, '').replace(/(VND|USD|EUR)$/i, '');

  if (!cleaned) return {value: null, isPercent: false};

  // Handle US comma-separated thousands: 1,250,000 or 1,250.50
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(cleaned)) {
    cleaned = cleaned.replace(/,/g, '');
  } else if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(cleaned)) {
    const dotCount = (cleaned.match(/\./g) ?? []).length;
    if (dotCount >= 2 || cleaned.includes(',')) {
      cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    }
  } else if (/^-?\d+,\d{1,2}$/.test(cleaned)) {
    cleaned = cleaned.replace(',', '.');
  }

  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(cleaned)) {
    return {value: null, isPercent: false};
  }

  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) {
    return {value: null, isPercent: false};
  }
  return {value: parsed, isPercent};
}

export function inferSingleColumnType(
  rows: string[][],
  colIdx: number
): ColumnType {
  const total = rows.length;
  if (total === 0) return 'text';

  let nonEmpty = 0;
  let numeric = 0;
  let percent = 0;

  if (total <= INFER_SAMPLE_LIMIT) {
    for (let r = 0; r < total; r++) {
      const cell = (rows[r][colIdx] ?? '').trim();
      if (!cell) continue;
      nonEmpty++;
      const parsed = parseNumericValue(cell);
      if (parsed.value !== null) {
        numeric++;
        if (parsed.isPercent) percent++;
      }
    }
  } else {
    const step = (total - 1) / (INFER_SAMPLE_LIMIT - 1);
    for (let s = 0; s < INFER_SAMPLE_LIMIT; s++) {
      const r = Math.round(s * step);
      const cell = (rows[r][colIdx] ?? '').trim();
      if (!cell) continue;
      nonEmpty++;
      const parsed = parseNumericValue(cell);
      if (parsed.value !== null) {
        numeric++;
        if (parsed.isPercent) percent++;
      }
    }
  }

  if (nonEmpty === 0) return 'text';
  if (numeric / nonEmpty >= 0.75) {
    return percent / numeric >= 0.5 ? 'percent' : 'number';
  }
  return 'text';
}

export function inferColumnTypes(
  columns: string[],
  rows: string[][]
): ColumnType[] {
  const types = new Array<ColumnType>(columns.length);
  for (let c = 0; c < columns.length; c++) {
    types[c] = inferSingleColumnType(rows, c);
  }
  return types;
}

export function computeColumnStats(
  sheet: SheetData,
  colIndex: number,
  rowIndices?: VisibleRowsSource
): ColumnStats {
  const count = rowIndices ? rowIndices.length : sheet.rows.length;
  const unique = new Set<string>();
  let nonEmptyCount = 0;
  let numericCount = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;

  for (let i = 0; i < count; i++) {
    const rowIdx = rowIndices ? rowIndices[i] : i;
    const raw = (sheet.rows[rowIdx]?.[colIndex] ?? '').trim();
    if (!raw) continue;
    nonEmptyCount++;
    unique.add(raw);
    const parsed = parseNumericValue(raw);
    if (parsed.value !== null) {
      const v = parsed.value;
      numericCount++;
      sum += v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }

  if (numericCount === 0) {
    return {
      count,
      nonEmptyCount,
      numericCount: 0,
      uniqueCount: unique.size,
      sum: 0,
      avg: 0,
      min: 0,
      max: 0,
    };
  }

  return {
    count,
    nonEmptyCount,
    numericCount,
    uniqueCount: unique.size,
    sum,
    avg: sum / numericCount,
    min,
    max,
  };
}

export function filterAndSortRowsBuffer(
  sheet: SheetData,
  searchQuery: string,
  sort: SortState
): Int32Array {
  const total = sheet.rows.length;
  const q = searchQuery.trim().toLowerCase();

  let filtered: number[];
  if (!q) {
    // Fast path when neither filtering nor sorting
    if (sort.colIndex === null || sort.direction === null) {
      const seq = new Int32Array(total);
      for (let i = 0; i < total; i++) seq[i] = i;
      return seq;
    }
    filtered = new Array<number>(total);
    for (let i = 0; i < total; i++) filtered[i] = i;
  } else {
    filtered = [];
    const colCount = sheet.columns.length;
    for (let i = 0; i < total; i++) {
      const row = sheet.rows[i];
      let match = false;
      for (let c = 0; c < colCount; c++) {
        const cell = row[c];
        if (cell && cell.toLowerCase().includes(q)) {
          match = true;
          break;
        }
      }
      if (match) filtered.push(i);
    }
  }

  if (sort.colIndex !== null && sort.direction !== null && filtered.length > 1) {
    const colIdx = sort.colIndex;
    const dir = sort.direction === 'asc' ? 1 : -1;
    const colType = sheet.types[colIdx] ?? 'text';
    const rows = sheet.rows;

    if (colType === 'number' || colType === 'percent') {
      // Pre-extract numeric keys once (Schwartzian transform) to avoid N*log2(N) regex parsing
      const numKeys = new Float64Array(total);
      const isEmpty = new Uint8Array(total);
      numKeys.fill(Number.NaN);

      for (let i = 0; i < filtered.length; i++) {
        const rIdx = filtered[i];
        const raw = (rows[rIdx]?.[colIdx] ?? '').trim();
        if (!raw) {
          isEmpty[rIdx] = 1;
        } else {
          const parsed = parseNumericValue(raw).value;
          if (parsed !== null) numKeys[rIdx] = parsed;
        }
      }

      filtered.sort((aIdx, bIdx) => {
        if (isEmpty[aIdx] && isEmpty[bIdx]) return 0;
        if (isEmpty[aIdx]) return 1;
        if (isEmpty[bIdx]) return -1;

        const aNum = numKeys[aIdx];
        const bNum = numKeys[bIdx];
        const aOk = !Number.isNaN(aNum);
        const bOk = !Number.isNaN(bNum);
        if (aOk && bOk) return (aNum - bNum) * dir;
        if (aOk) return -1 * dir;
        if (bOk) return 1 * dir;

        const aRaw = (rows[aIdx]?.[colIdx] ?? '').trim();
        const bRaw = (rows[bIdx]?.[colIdx] ?? '').trim();
        return EN_COLLATOR.compare(aRaw, bRaw) * dir;
      });
    } else {
      // Cache trimmed strings for comparison
      filtered.sort((aIdx, bIdx) => {
        const aRaw = (rows[aIdx]?.[colIdx] ?? '').trim();
        const bRaw = (rows[bIdx]?.[colIdx] ?? '').trim();
        if (!aRaw && !bRaw) return 0;
        if (!aRaw) return 1;
        if (!bRaw) return -1;
        return EN_COLLATOR.compare(aRaw, bRaw) * dir;
      });
    }
  }

  return Int32Array.from(filtered);
}

export function filterAndSortRows(
  sheet: SheetData,
  searchQuery: string,
  sort: SortState
): number[] {
  return Array.from(filterAndSortRowsBuffer(sheet, searchQuery, sort));
}

const NUMBER_FORMATTERS = [
  new Intl.NumberFormat('en-US', {maximumFractionDigits: 0}),
  new Intl.NumberFormat('en-US', {maximumFractionDigits: 1}),
  new Intl.NumberFormat('en-US', {maximumFractionDigits: 2}),
];

export function formatDisplayNumber(
  value: number,
  type: ColumnType = 'number'
): string {
  if (!Number.isFinite(value)) return '0';
  const abs = Math.abs(value);
  const fmtIdx = abs >= 1000 ? 0 : abs >= 10 ? 1 : 2;
  const formatted = NUMBER_FORMATTERS[fmtIdx].format(value);
  return type === 'percent' ? `${formatted}%` : formatted;
}

export function suggestChartConfig(sheet: SheetData): ChartConfig {
  const numericCols: number[] = [];
  const textCols: number[] = [];

  sheet.types.forEach((t, idx) => {
    if (t === 'number' || t === 'percent') numericCols.push(idx);
    else textCols.push(idx);
  });

  const xColIndex = textCols[0] ?? 0;
  let yColIndices = numericCols.filter((idx) => idx !== xColIndex).slice(0, 2);
  if (yColIndices.length === 0 && numericCols.length > 0) {
    yColIndices = [numericCols[0]];
  }
  if (yColIndices.length === 0) {
    yColIndices = [Math.min(1, sheet.columns.length - 1)];
  }

  return {
    type: 'bar',
    xColIndex,
    yColIndices,
    spatialMode: 'bar3d',
  };
}

export function cloneSheet(sheet: SheetData): SheetData {
  return {
    id: sheet.id,
    name: sheet.name,
    columns: [...sheet.columns],
    rows: sheet.rows.map((r) => [...r]),
    types: [...sheet.types],
  };
}

export function cloneWorkbook(wb: WorkbookState): WorkbookState {
  return {
    fileName: wb.fileName,
    fileFormat: wb.fileFormat,
    activeSheetIndex: wb.activeSheetIndex,
    sheets: wb.sheets.map(cloneSheet),
  };
}

/** Structural-sharing (Copy-on-Write) single-cell update — O(1) row clone + O(1) column type check */
export function updateSheetCell(
  sheet: SheetData,
  rowIndex: number,
  colIndex: number,
  value: string
): SheetData {
  if (rowIndex < 0 || rowIndex >= sheet.rows.length) return sheet;
  if (colIndex < 0 || colIndex >= sheet.columns.length) return sheet;
  if (sheet.rows[rowIndex][colIndex] === value) return sheet;

  const nextRows = sheet.rows.slice();
  const nextRow = sheet.rows[rowIndex].slice();
  nextRow[colIndex] = value;
  nextRows[rowIndex] = nextRow;

  const nextTypes = sheet.types.slice();
  nextTypes[colIndex] = inferSingleColumnType(nextRows, colIndex);

  return {
    id: sheet.id,
    name: sheet.name,
    columns: sheet.columns,
    rows: nextRows,
    types: nextTypes,
  };
}

export function addSheetRow(sheet: SheetData): SheetData {
  const hasAnyNonEmptyFirstCol = sheet.rows.some(
    (r) => (r[0] ?? '').trim().length > 0
  );
  const newRow = sheet.columns.map((_, colIdx) => {
    const type = sheet.types[colIdx];
    if (colIdx === 0 && type === 'text') {
      return hasAnyNonEmptyFirstCol ? `Item ${sheet.rows.length + 1}` : '';
    }
    if (type === 'number' || type === 'percent') return '0';
    return '';
  });
  const nextRows = sheet.rows.slice();
  nextRows.push(newRow);

  return {
    id: sheet.id,
    name: sheet.name,
    columns: sheet.columns,
    rows: nextRows,
    types: inferColumnTypes(sheet.columns, nextRows),
  };
}

export function deleteSheetRow(sheet: SheetData, rowIndex: number): SheetData {
  if (rowIndex < 0 || rowIndex >= sheet.rows.length) return sheet;
  const nextRows = sheet.rows.slice();
  nextRows.splice(rowIndex, 1);

  return {
    id: sheet.id,
    name: sheet.name,
    columns: sheet.columns,
    rows: nextRows,
    types: inferColumnTypes(sheet.columns, nextRows),
  };
}

export function addSheetColumn(
  sheet: SheetData,
  columnName?: string
): SheetData {
  const nextColumns = sheet.columns.slice();
  const name =
    columnName?.trim() || `Column ${columnIndexToLetter(nextColumns.length)}`;
  const hasAnyRowsWithData = sheet.rows.some((r) =>
    r.some((cell) => cell.trim().length > 0)
  );
  nextColumns.push(name);
  const fillVal = hasAnyRowsWithData ? '0' : '';
  const nextRows = sheet.rows.map((r) => [...r, fillVal]);

  return {
    id: sheet.id,
    name: sheet.name,
    columns: nextColumns,
    rows: nextRows,
    types: [...sheet.types, inferSingleColumnType(nextRows, nextColumns.length - 1)],
  };
}

export function createBlankWorkbook(): WorkbookState {
  const columns = ['Column A', 'Column B', 'Column C'];
  const rows = Array.from({length: 6}, () => ['', '', '']);
  return {
    fileName: 'Untitled.xlsx',
    fileFormat: 'blank',
    activeSheetIndex: 0,
    sheets: [
      {
        id: 'sheet-1',
        name: 'Sheet 1',
        columns,
        rows,
        types: ['text', 'text', 'text'],
      },
    ],
  };
}

export function renameSheetColumn(
  sheet: SheetData,
  colIndex: number,
  newName: string
): SheetData {
  if (colIndex < 0 || colIndex >= sheet.columns.length) return sheet;
  const trimmed = newName.trim();
  if (!trimmed || trimmed === sheet.columns[colIndex]) return sheet;
  const nextColumns = sheet.columns.slice();
  nextColumns[colIndex] = trimmed;

  return {
    id: sheet.id,
    name: sheet.name,
    columns: nextColumns,
    rows: sheet.rows,
    types: sheet.types,
  };
}

export function deleteSheetColumn(sheet: SheetData, colIndex: number): SheetData {
  if (sheet.columns.length <= 1) return sheet;
  if (colIndex < 0 || colIndex >= sheet.columns.length) return sheet;
  const nextColumns = sheet.columns.slice();
  nextColumns.splice(colIndex, 1);

  const nextTypes = sheet.types.slice();
  nextTypes.splice(colIndex, 1);

  const nextRows = sheet.rows.map((row) => {
    const copy = row.slice();
    copy.splice(colIndex, 1);
    return copy;
  });

  return {
    id: sheet.id,
    name: sheet.name,
    columns: nextColumns,
    rows: nextRows,
    types: nextTypes,
  };
}

export class HistoryManager<T> {
  private past: T[] = [];
  private future: T[] = [];
  private present: T;
  private maxDepth: number;

  constructor(initial: T, maxDepth = 50) {
    this.present = initial;
    this.maxDepth = maxDepth;
  }

  get current(): T {
    return this.present;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  push(nextState: T): T {
    this.past.push(this.present);
    if (this.past.length > this.maxDepth) {
      this.past.shift();
    }
    this.present = nextState;
    this.future = [];
    return this.present;
  }

  undo(): T | null {
    if (this.past.length === 0) return null;
    const previous = this.past.pop()!;
    this.future.push(this.present);
    this.present = previous;
    return this.present;
  }

  redo(): T | null {
    if (this.future.length === 0) return null;
    const next = this.future.pop()!;
    this.past.push(this.present);
    this.present = next;
    return this.present;
  }

  reset(initial: T): void {
    this.past = [];
    this.future = [];
    this.present = initial;
  }
}
