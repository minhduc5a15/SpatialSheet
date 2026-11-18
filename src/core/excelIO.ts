import * as XLSX from 'xlsx';
import type {SheetData, WorkbookState} from '../types';
import {
  normalizeRecordsToSheet,
  parseCsvText,
  serializeCsv,
} from './tabular';

function stripExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

export async function importTabularFile(
  file: File,
  onProgress?: (progress: number, message: string) => void
): Promise<WorkbookState> {
  const nameLower = file.name.toLowerCase();

  if (
    nameLower.endsWith('.csv') ||
    nameLower.endsWith('.tsv') ||
    nameLower.endsWith('.txt')
  ) {
    onProgress?.(0.15, `Reading ${file.name}…`);
    const text = await file.text();
    onProgress?.(0.55, `Parsing CSV rows…`);
    const sheet = parseCsvText(text, stripExtension(file.name), 'sheet-0');
    onProgress?.(1, 'Ready');
    return {
      fileName: file.name,
      fileFormat: nameLower.endsWith('.tsv') ? 'tsv' : 'csv',
      sheets: [sheet],
      activeSheetIndex: 0,
    };
  }

  if (nameLower.endsWith('.json')) {
    onProgress?.(0.15, `Reading ${file.name}…`);
    const raw = await file.text();
    onProgress?.(0.5, `Parsing JSON records…`);
    const parsed: unknown = JSON.parse(raw);
    const records: unknown[][] = [];

    if (Array.isArray(parsed) && parsed.length > 0) {
      if (Array.isArray(parsed[0])) {
        for (const row of parsed) {
          if (Array.isArray(row)) records.push(row);
        }
      } else if (typeof parsed[0] === 'object' && parsed[0] !== null) {
        const keySet = new Set<string>();
        for (const item of parsed) {
          if (typeof item === 'object' && item !== null) {
            for (const k of Object.keys(item)) keySet.add(k);
          }
        }
        const keys = Array.from(keySet);
        records.push(keys);
        for (const item of parsed) {
          const obj = (item ?? {}) as Record<string, unknown>;
          records.push(keys.map((k) => obj[k] ?? ''));
        }
      }
    }

    const sheet = normalizeRecordsToSheet(
      records,
      stripExtension(file.name),
      'sheet-0'
    );
    onProgress?.(1, 'Ready');
    return {
      fileName: file.name,
      fileFormat: 'json',
      sheets: [sheet],
      activeSheetIndex: 0,
    };
  }

  // Excel / ODS via SheetJS
  onProgress?.(0.15, `Reading ${file.name}…`);
  const buffer = await file.arrayBuffer();
  onProgress?.(0.45, `Decoding spreadsheet…`);
  const wb = XLSX.read(buffer, {type: 'array'});
  const totalSheets = Math.max(1, wb.SheetNames.length);
  const sheets: SheetData[] = wb.SheetNames.map((sheetName, idx) => {
    const ws = wb.Sheets[sheetName];
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, {
      header: 1,
      defval: '',
      raw: false,
    });
    onProgress?.(
      0.5 + ((idx + 1) / totalSheets) * 0.45,
      `Normalizing ${sheetName}…`
    );
    return normalizeRecordsToSheet(aoa, sheetName, `sheet-${idx}`);
  });

  if (sheets.length === 0) {
    sheets.push(normalizeRecordsToSheet([], 'Sheet1', 'sheet-0'));
  }

  onProgress?.(1, 'Ready');
  return {
    fileName: file.name,
    fileFormat: 'xlsx',
    sheets,
    activeSheetIndex: 0,
  };
}

export function exportSheetAsCsv(sheet: SheetData, baseFileName: string): void {
  const csvContent = '\uFEFF' + serializeCsv(sheet);
  const blob = new Blob([csvContent], {type: 'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const cleanBase = stripExtension(baseFileName);
  anchor.href = url;
  anchor.download = `${cleanBase}-${sheet.name}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function shouldPreserveAsExcelString(trimmed: string): boolean {
  const compact = trimmed.replace(/,/g, '');
  if (/^-?0\d+$/.test(compact)) return true; // Leading zeros like "00123"
  if (/^-?\d{16,}$/.test(compact)) return true; // Exceeds IEEE-754 safe integer precision
  return false;
}

export function buildExcelWorkbookForExport(
  workbook: WorkbookState
): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  const usedNames = new Set<string>();

  workbook.sheets.forEach((sheet, index) => {
    const aoa: unknown[][] = [
      sheet.columns,
      ...sheet.rows.map((row) =>
        row.map((cell, colIdx) => {
          const type = sheet.types[colIdx];
          if (type === 'number') {
            const trimmed = cell.trim();
            if (trimmed !== '' && !shouldPreserveAsExcelString(trimmed)) {
              const compact = trimmed.replace(/,/g, '');
              if (/^-?(\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(compact)) {
                const num = Number(compact);
                if (Number.isFinite(num)) return num;
              }
            }
          }
          return cell;
        })
      ),
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    let safeBase = (sheet.name || `Sheet${index + 1}`)
      .replace(/[\\/?*[\]:]/g, ' ')
      .trim()
      .slice(0, 31);
    if (!safeBase) safeBase = `Sheet${index + 1}`;
    let safeName = safeBase;
    let suffix = 2;
    while (usedNames.has(safeName)) {
      const tag = `_${suffix++}`;
      safeName = `${safeBase.slice(0, Math.max(1, 31 - tag.length))}${tag}`;
    }
    usedNames.add(safeName);
    XLSX.utils.book_append_sheet(wb, ws, safeName);
  });

  return wb;
}

export function exportWorkbookAsExcel(workbook: WorkbookState): void {
  const wb = buildExcelWorkbookForExport(workbook);
  const cleanBase = stripExtension(workbook.fileName) || 'Spreadsheet';
  XLSX.writeFile(wb, `${cleanBase}.xlsx`);
}
