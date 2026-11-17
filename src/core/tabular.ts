import type {
  ChartConfig,
  ColumnStats,
  ColumnType,
  SheetData,
  SortState,
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
  const clean = text.replace(/^\uFEFF/, '');
  const sampleLines: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < clean.length && sampleLines.length < 6; i++) {
    const ch = clean[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (current.trim().length > 0) {
        sampleLines.push(current);
      }
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0 && sampleLines.length < 6) {
    sampleLines.push(current);
  }

  const candidates = [',', ';', '\t'];
  let bestDelim = ',';
  let bestScore = -1;

  for (const delim of candidates) {
    const counts = sampleLines.map((line) => countOutsideQuotes(line, delim));
    const minCount = Math.min(...counts);
    const totalCount = counts.reduce((a, b) => a + b, 0);
    if (totalCount === 0) continue;
    const consistent = counts.every((c) => c === counts[0]) ? 10 : 0;
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
  const clean = text.replace(/^\uFEFF/, '');
  if (!clean.trim()) return [];
  const delim = delimiter ?? detectDelimiter(clean);

  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];

    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === delim) {
        row.push(field);
        field = '';
      } else if (ch === '\r') {
        if (clean[i + 1] === '\n') {
          i++;
        }
        row.push(field);
        records.push(row);
        row = [];
        field = '';
      } else if (ch === '\n') {
        row.push(field);
        records.push(row);
        row = [];
        field = '';
      } else {
        field += ch;
      }
    }
  }

  if (field.length > 0 || row.length > 0) {
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

  const maxCols = Math.max(
    1,
    ...records.map((r) => (Array.isArray(r) ? r.length : 0))
  );

  const rawHeaders = Array.isArray(records[0]) ? records[0] : [];
  const seen = new Map<string, number>();
  const columns: string[] = [];

  for (let c = 0; c < maxCols; c++) {
    const raw = String(rawHeaders[c] ?? '').trim();
    const base = raw || `Column ${columnIndexToLetter(c)}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    columns.push(count === 0 ? base : `${base} (${count + 1})`);
  }

  const rows: string[][] = [];
  for (let r = 1; r < records.length; r++) {
    const sourceRow = Array.isArray(records[r]) ? records[r] : [];
    const normalizedRow: string[] = [];
    for (let c = 0; c < maxCols; c++) {
      const cell = sourceRow[c];
      normalizedRow.push(cell === null || cell === undefined ? '' : String(cell));
    }
    rows.push(normalizedRow);
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

  const lines: string[] = [];
  lines.push(sheet.columns.map(escapeCell).join(','));
  for (const row of sheet.rows) {
    const padded = sheet.columns.map((_, idx) => escapeCell(row[idx] ?? ''));
    lines.push(padded.join(','));
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
    // Handle European/VN dot-separated thousands with optional decimal comma (e.g., 1.250.000 or 1.250.000,5)
    // Only treat single dot + 3 digits as thousand separator if there are >=2 dots or a trailing comma
    const dotCount = (cleaned.match(/\./g) ?? []).length;
    if (dotCount >= 2 || cleaned.includes(',')) {
      cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    }
  } else if (/^-?\d+,\d{1,2}$/.test(cleaned)) {
    // Simple comma decimal like "12,5"
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

export function inferColumnTypes(
  columns: string[],
  rows: string[][]
): ColumnType[] {
  return columns.map((_, colIdx) => {
    let nonEmpty = 0;
    let numeric = 0;
    let percent = 0;

    for (const row of rows) {
      const cell = (row[colIdx] ?? '').trim();
      if (!cell) continue;
      nonEmpty++;
      const parsed = parseNumericValue(cell);
      if (parsed.value !== null) {
        numeric++;
        if (parsed.isPercent) percent++;
      }
    }

    if (nonEmpty === 0) return 'text';
    if (numeric / nonEmpty >= 0.75) {
      return percent / numeric >= 0.5 ? 'percent' : 'number';
    }
    return 'text';
  });
}

export function computeColumnStats(
  sheet: SheetData,
  colIndex: number,
  rowIndices?: number[]
): ColumnStats {
  const indices = rowIndices ?? sheet.rows.map((_, i) => i);
  const values: number[] = [];
  const unique = new Set<string>();
  let nonEmptyCount = 0;

  for (const rowIdx of indices) {
    const raw = (sheet.rows[rowIdx]?.[colIndex] ?? '').trim();
    if (!raw) continue;
    nonEmptyCount++;
    unique.add(raw);
    const parsed = parseNumericValue(raw);
    if (parsed.value !== null) {
      values.push(parsed.value);
    }
  }

  if (values.length === 0) {
    return {
      count: indices.length,
      nonEmptyCount,
      numericCount: 0,
      uniqueCount: unique.size,
      sum: 0,
      avg: 0,
      min: 0,
      max: 0,
    };
  }

  let sum = 0;
  let min = values[0];
  let max = values[0];
  for (const v of values) {
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }

  return {
    count: indices.length,
    nonEmptyCount,
    numericCount: values.length,
    uniqueCount: unique.size,
    sum,
    avg: sum / values.length,
    min,
    max,
  };
}

export function filterAndSortRows(
  sheet: SheetData,
  searchQuery: string,
  sort: SortState
): number[] {
  const q = searchQuery.trim().toLowerCase();
  const indices: number[] = [];

  for (let i = 0; i < sheet.rows.length; i++) {
    if (!q) {
      indices.push(i);
      continue;
    }
    const row = sheet.rows[i];
    const match = row.some((cell) => cell.toLowerCase().includes(q));
    if (match) indices.push(i);
  }

  if (sort.colIndex !== null && sort.direction !== null) {
    const colIdx = sort.colIndex;
    const dir = sort.direction === 'asc' ? 1 : -1;
    const colType = sheet.types[colIdx] ?? 'text';

    indices.sort((aIdx, bIdx) => {
      const aRaw = (sheet.rows[aIdx]?.[colIdx] ?? '').trim();
      const bRaw = (sheet.rows[bIdx]?.[colIdx] ?? '').trim();

      if (!aRaw && !bRaw) return 0;
      if (!aRaw) return 1;
      if (!bRaw) return -1;

      if (colType === 'number' || colType === 'percent') {
        const aNum = parseNumericValue(aRaw).value;
        const bNum = parseNumericValue(bRaw).value;
        if (aNum !== null && bNum !== null) {
          return (aNum - bNum) * dir;
        }
      }

      return (
        aRaw.localeCompare(bRaw, 'en', {
          numeric: true,
          sensitivity: 'base',
        }) * dir
      );
    });
  }

  return indices;
}

export function formatDisplayNumber(value: number, type: ColumnType = 'number'): string {
  if (!Number.isFinite(value)) return '0';
  const abs = Math.abs(value);
  const maxFrac = abs >= 1000 ? 0 : abs >= 10 ? 1 : 2;
  const formatted = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: maxFrac,
  }).format(value);
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

export function updateSheetCell(
  sheet: SheetData,
  rowIndex: number,
  colIndex: number,
  value: string
): SheetData {
  if (rowIndex < 0 || rowIndex >= sheet.rows.length) return sheet;
  if (colIndex < 0 || colIndex >= sheet.columns.length) return sheet;

  const next = cloneSheet(sheet);
  next.rows[rowIndex][colIndex] = value;
  next.types = inferColumnTypes(next.columns, next.rows);
  return next;
}

export function addSheetRow(sheet: SheetData): SheetData {
  const next = cloneSheet(sheet);
  const hasAnyNonEmptyFirstCol = next.rows.some(
    (r) => (r[0] ?? '').trim().length > 0
  );
  const newRow = next.columns.map((_, colIdx) => {
    const type = next.types[colIdx];
    if (colIdx === 0 && type === 'text') {
      return hasAnyNonEmptyFirstCol ? `Item ${next.rows.length + 1}` : '';
    }
    if (type === 'number' || type === 'percent') return '0';
    return '';
  });
  next.rows.push(newRow);
  next.types = inferColumnTypes(next.columns, next.rows);
  return next;
}

export function deleteSheetRow(sheet: SheetData, rowIndex: number): SheetData {
  if (rowIndex < 0 || rowIndex >= sheet.rows.length) return sheet;
  const next = cloneSheet(sheet);
  next.rows.splice(rowIndex, 1);
  next.types = inferColumnTypes(next.columns, next.rows);
  return next;
}

export function addSheetColumn(sheet: SheetData, columnName?: string): SheetData {
  const next = cloneSheet(sheet);
  const name =
    columnName?.trim() || `Column ${columnIndexToLetter(next.columns.length)}`;
  const hasAnyRowsWithData = next.rows.some((r) =>
    r.some((cell) => cell.trim().length > 0)
  );
  next.columns.push(name);
  for (const row of next.rows) {
    row.push(hasAnyRowsWithData ? '0' : '');
  }
  next.types = inferColumnTypes(next.columns, next.rows);
  return next;
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
  if (!trimmed) return sheet;
  const next = cloneSheet(sheet);
  next.columns[colIndex] = trimmed;
  return next;
}

export function deleteSheetColumn(sheet: SheetData, colIndex: number): SheetData {
  if (sheet.columns.length <= 1) return sheet;
  if (colIndex < 0 || colIndex >= sheet.columns.length) return sheet;
  const next = cloneSheet(sheet);
  next.columns.splice(colIndex, 1);
  for (const row of next.rows) {
    row.splice(colIndex, 1);
  }
  next.types = inferColumnTypes(next.columns, next.rows);
  return next;
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
