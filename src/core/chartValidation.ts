import type {ChartConfig, DatasetProfile, SheetData} from '../types';
import {suggestChartConfig} from './tabular';
import {applySeriesPreset, evaluateSeriesEligibility, getSecondaryControlsForChartType} from '../ui/ChartSeriesManager';

export function validateChartConfig(sheet: SheetData, profile: DatasetProfile | null, config: ChartConfig): string | null {
  if (!['bar', 'line', 'pie', 'scatter'].includes(config.type)) return 'Choose a supported chart type.';
  if (!Number.isInteger(config.xColIndex) || !sheet.columns[config.xColIndex]) return 'Choose an X-axis field from this sheet.';
  if (config.yColIndices.some(c => !Number.isInteger(c) || !sheet.columns[c])) return 'Choose Y series from this sheet.';
  for (const col of config.yColIndices) {
    const eligibility = evaluateSeriesEligibility(sheet, profile, col, config.xColIndex);
    if (!eligibility.eligible) return `${sheet.columns[col]} cannot be a measurement: ${eligibility.reason}. Use a quantitative or binary field.`;
  }
  if (config.type === 'scatter') {
    const type = profile?.columns[config.xColIndex]?.roleOverride ?? profile?.columns[config.xColIndex]?.semanticType;
    if (type ? type !== 'quantitative' : sheet.types[config.xColIndex] === 'text') {
      return `Scatter charts require numerical X and Y values. ${sheet.columns[config.xColIndex]} is classified as ${type ?? 'text'}. Choose a numerical X field.`;
    }
  }
  if (!['none', 'sum', 'avg', 'count'].includes(config.aggregation ?? 'none')) return 'This chart supports None, Sum, Average, and Count valid values.';
  if (!['source', 'value-asc', 'value-desc'].includes(config.sortOrder ?? 'source')) return 'Choose source order or sort by the primary derived value.';
  if (config.maxPoints !== undefined && (!Number.isInteger(config.maxPoints) || config.maxPoints < 4 || config.maxPoints > 200)) return 'Use a point limit between 4 and 200.';
  return null;
}

export function resetChartConfig(sheet: SheetData, spatialMode: ChartConfig['spatialMode'], profile: DatasetProfile | null = null): ChartConfig {
  const suggested = suggestChartConfig(sheet);
  return {...suggested, yColIndices: applySeriesPreset('recommended', sheet, profile, suggested.xColIndex), spatialMode, aggregation: 'none', sortOrder: 'source', maxPoints: 32};
}

export function chartDisplaySummary(config: ChartConfig, visible: number, shown: number): string {
  const relevance = getSecondaryControlsForChartType(config.type);
  const agg = relevance.showAggregation ? config.aggregation ?? 'none' : 'none';
  const sort = relevance.showSort ? config.sortOrder ?? 'source' : 'source';
  if (agg !== 'none') return `${sort === 'source' ? 'First' : 'Top'} ${shown} groups ${sort === 'source' ? 'in source order' : `by ${sort === 'value-desc' ? 'descending' : 'ascending'} primary aggregate`} · ${agg} across ${visible.toLocaleString('en-US')} filtered rows`;
  if (sort !== 'source') return `${shown} records by ${sort === 'value-desc' ? 'descending' : 'ascending'} primary value${visible > 25000 ? ' from a systematic sample of 4,000 candidates' : ` from ${visible.toLocaleString('en-US')} filtered rows`}`;
  return `${visible > shown ? 'Systematic sample: ' : 'Displaying '}${shown} of ${visible.toLocaleString('en-US')} filtered records`;
}
