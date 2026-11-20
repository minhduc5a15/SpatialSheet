import type {AnalyticalSelection, ContributorQuery, SheetData, VisibleRowsSource} from '../types';
import {parseChartCellValue} from './chartData';

export function matchesContributor(row: string[], query: ContributorQuery): boolean {
  return query.fields.every(field => ((row[field.colIndex] ?? '').trim() || field.emptyLabel) === field.value)
    && (query.numericColIndex === undefined || parseChartCellValue(row[query.numericColIndex] ?? '', !!query.booleanValues) !== null);
}

export function resolveRecord(sheet: SheetData, selection: AnalyticalSelection | null): string[] | null {
  if (!selection || selection.sheetId !== sheet.id || selection.kind === 'aggregate') return null;
  return sheet.rows[selection.rowIndex] ?? null;
}

/** Scan only on explicit drill-down, yielding periodically; keep at most one page plus lookahead. */
export async function contributorPage(
  sheet: SheetData, visible: VisibleRowsSource, selection: AnalyticalSelection,
  cursor = 0, limit = 20, signal?: AbortSignal,
): Promise<{rows: number[]; nextCursor: number | null; partial: boolean}> {
  if (selection.kind !== 'aggregate' || selection.sheetId !== sheet.id) return {rows: [], nextCursor: null, partial: false};
  const candidates = selection.query ? visible : selection.previewRowIndices ?? [];
  const rows: number[] = [];
  for (let i = cursor; i < candidates.length; i++) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const rowIndex = candidates[i];
    if (sheet.rows[rowIndex] && (!selection.query || matchesContributor(sheet.rows[rowIndex], selection.query))) {
      if (rows.length === limit) return {rows, nextCursor: i, partial: !selection.query};
      rows.push(rowIndex);
    }
    if (i > cursor && (i - cursor) % 2048 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  return {rows, nextCursor: null, partial: !selection.query};
}
