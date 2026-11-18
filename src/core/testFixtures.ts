import * as XLSX from 'xlsx';
import type {SheetData, WorkbookState} from '../types';
import {normalizeRecordsToSheet, parseCsvText} from './tabular';

export const SMALL_DETERMINISTIC_CSV = [
  'Category,Group,Value,Flag',
  'North,Alpha,100,true',
  'North,Beta,200,false',
  'South,Alpha,150,true',
  'South,Beta,50,false',
  'East,Alpha,300,true',
  'West,Beta,75,false',
].join('\n');

export const MIXED_TYPES_CSV = [
  'Code,UnsafeID,SciValue,Discount,Budget,EventDate,Flag',
  '00123,12345678901234567890,1.5e-4,12.5%,$1200,2025-01-15,true',
  '00456,12345678901234567891,2.25e5,8%,$950,2025-02-01,false',
  '00789,12345678901234567892,-3.1E+2,15.0%,$1400,2025-03-10,true',
  '00999,12345678901234567893,4.0e0,5%,$800,2025-04-22,false',
].join('\n');

export const UNICODE_AND_EDGE_CSV = [
  '\uFEFF"Revenue","Revenue (2)","Revenue","Note <tag>","Khu vực"',
  '100,200,300,"Line 1\n""Quoted"", <script>alert(1)</script>","Hà Nội"',
  '150,250,350,"Comma, semi; tab\there","TP. Hồ Chí Minh"',
  '175,275,375,"Đà Nẵng — miền Trung 🎉","Đà Nẵng"',
].join('\r\n');

export const SPARSE_MISSING_CSV = [
  'Segment,Series,Metric,Notes',
  'A,S1,10,ok',
  'A,S1,,missing',
  'B,S1,N/A,invalid text',
  'B,S2,40,valid',
  'C,S1,,only empty',
  'D,S2,0,explicit zero',
].join('\n');

export const NEGATIVE_AND_TINY_CSV = [
  'Bucket,SignedVal,AllZero,TinyPositive,UltraSmall',
  'B1,-40,0,0.0002,1e-9',
  'B2,0,0,0.0005,3e-9',
  'B3,65,0,0.0008,7e-9',
  'B4,-15,0,0.0012,9e-9',
].join('\n');

export const DUPLICATE_TOPK_CSV = [
  'Region,Quarter,Amount',
  'CatA,Q1,100',
  'CatA,Q2,5',
  'CatB,Q1,30',
  'CatB,Q2,25',
  'CatC,Q1,20',
  'CatC,Q2,20',
  'CatD,Q1,50',
  'CatD,Q2,1',
].join('\n');

export const AI_LLM_BENCHMARK_CSV = [
  'Model,Provider,Category,Release Date,Context Window,Latency (ms),Cost ($),Accuracy (%),Open Weights',
  'GPT-4.1,OpenAI,Frontier,2025-04-14,1000000,420,$2.00,91.2%,false',
  'Claude 3.7 Sonnet,Anthropic,Frontier,2025-02-24,200000,390,$3.00,92.4%,false',
  'Gemini 2.5 Pro,Google,Frontier,2025-03-25,2000000,340,$1.25,93.8%,false',
  'Gemini 2.5 Flash,Google,Fast,2025-04-17,1000000,145,$0.15,87.5%,false',
  'Llama 4 Maverick,Meta,Open,2025-04-05,1000000,190,$0.22,86.9%,true',
  'Qwen 3 235B,Alibaba,Open,2025-04-28,128000,260,$0.30,88.1%,true',
  'DeepSeek R1,DeepSeek,Reasoning,2025-01-20,128000,680,$0.55,91.0%,true',
  'Mistral Medium 3,Mistral,Fast,2025-05-07,128000,170,$0.40,85.2%,false',
  'o4-mini,OpenAI,Reasoning,2025-04-16,200000,510,$1.10,90.4%,false',
  'Gemma 3 27B,Google,Open,2025-03-12,128000,120,$0.08,81.3%,true',
  'Phi-4,Microsoft,Fast,2024-12-12,16000,95,$0.05,78.6%,true',
  'Command A,Cohere,Enterprise,2025-03-13,256000,280,$2.50,84.0%,false',
].join('\n');

export function makeSyntheticLargeSheet(
  rowCount = 10_000,
  colCount = 8,
  id = 'sheet-synth'
): SheetData {
  const columns = Array.from({length: colCount}, (_, c) =>
    c === 0
      ? 'ID'
      : c === 1
        ? 'Category'
        : c === 2
          ? 'Value'
          : `Metric_${c}`
  );
  const cats = ['North', 'South', 'East', 'West', 'Central'];
  const rows: string[][] = new Array(rowCount);
  for (let r = 0; r < rowCount; r++) {
    const row = new Array<string>(colCount);
    row[0] = String(r + 1);
    row[1] = cats[r % cats.length];
    row[2] = String(((r * 37) % 1000) + 1);
    for (let c = 3; c < colCount; c++) {
      row[c] = String(((r + c) * 13) % 500);
    }
    rows[r] = row;
  }
  const types: SheetData['types'] = columns.map((_, c) =>
    c === 1 ? 'text' : 'number'
  );
  return {
    id,
    name: 'LargeSynthetic',
    columns,
    rows,
    types,
  };
}

export function makeWorkbookFromCsv(
  fileName: string,
  csv: string
): WorkbookState {
  const sheet = parseCsvText(csv, fileName.replace(/\.[^.]+$/, ''), 'sheet-0');
  return {
    fileName,
    fileFormat: 'csv',
    sheets: [sheet],
    activeSheetIndex: 0,
  };
}

export function createMultiSheetXlsxFile(fileName = 'multi.xlsx'): File {
  const wb = XLSX.utils.book_new();
  const s1 = XLSX.utils.aoa_to_sheet([
    ['SKU', 'Amount', 'Note'],
    ['000123', 1500, 'Leading zero SKU'],
    ['000456', 2400.5, 'Second item'],
  ]);
  const s2 = XLSX.utils.aoa_to_sheet([
    ['Region', 'Share'],
    ['APAC', '42%'],
    ['EMEA', '58%'],
  ]);
  XLSX.utils.book_append_sheet(wb, s1, 'Inventory');
  XLSX.utils.book_append_sheet(wb, s2, 'Summary');
  const buf = XLSX.write(wb, {type: 'array', bookType: 'xlsx'}) as ArrayBuffer;
  return new File([buf], fileName, {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

export function makeSheetFromRecords(
  records: unknown[][],
  name = 'TestSheet',
  id = 'sheet-test'
): SheetData {
  return normalizeRecordsToSheet(records, name, id);
}
