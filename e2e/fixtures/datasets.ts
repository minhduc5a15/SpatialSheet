// Generated in memory: no large CSVs are committed. Formula is shared by benchmarks.
export function datasetCsv(rows = 100, cols = 37): string {
  const header = ['sample_id', 'category', ...Array.from({length: cols - 2}, (_, c) => `metric_${c + 1}`)];
  return [header.join(','), ...Array.from({length: rows}, (_, r) =>
    [`ID-${String(r + 1).padStart(6, '0')}`, `Group ${r % 4}`, ...Array.from({length: cols - 2}, (_, c) => String(10 + ((r * 7 + c * 11) % 97)))].join(','))].join('\n');
}
