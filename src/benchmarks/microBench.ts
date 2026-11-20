import {moveColumnVisualInView, getVisibleColumnsPlan} from '../core/columnView';
import {profileDataset} from '../core/dataProfiler';
import {createDefaultSpatialConfig, transformSpatialDataset} from '../core/spatialTransform';
import type {SheetData} from '../types';

function measure(name: string, fn: () => unknown, iterations: number) {
  for (let i = 0; i < 3; i++) fn();
  const samples = Array.from({length: iterations}, () => {
    const start = performance.now(); fn(); return performance.now() - start;
  }).sort((a, b) => a - b);
  console.log(JSON.stringify({name, iterations, medianMs: samples[Math.floor(samples.length / 2)], p95Ms: samples[Math.min(samples.length - 1, Math.floor(samples.length * .95))]}));
}
console.log(JSON.stringify({kind: 'pure functions', node: process.version, platform: process.platform, arch: process.arch, methodology: '3 warmups; individual wall-clock samples; no timing thresholds; shared CPU/GC variability'}));
const view = {order: Array.from({length: 100}, (_, i) => i), hidden: [], pinned: [], widths: {}};
measure('moveColumnVisual:100 columns', () => moveColumnVisualInView(view, 50, -1), 1000);
measure('visibleColumns:100 columns', () => getVisibleColumnsPlan({view, colWidths: Array(100).fill(156), viewportWidth: 960, rowNumWidth: 76}), 1000);
const sheet: SheetData = {id: 'aggregate', name: 'Aggregate', columns: ['ID', 'Region', 'Amount'], types: ['number', 'text', 'number'], rows: Array.from({length: 50_000}, (_, r) => [String(r + 1), ['NA', 'EU', 'APAC', 'LATAM'][r % 4], String(r % 100 + 1)])};
const profile = profileDataset(sheet, 1);
const config = {...createDefaultSpatialConfig(profile), aggregation: 'sum' as const};
const visibleRowIndices = Int32Array.from({length: 50_000}, (_, i) => i);
measure('aggregate:50000x3', () => transformSpatialDataset({sheet, profile, config, visibleRowIndices, mode: 'bar3d'}), 20);
