import type {ChartConfig, ChartRecommendation, DatasetProfile, SheetData} from '../types';
import {ChartSeriesManager, getSecondaryControlsForChartType} from './ChartSeriesManager';
import {validateChartConfig, resetChartConfig} from '../core/chartValidation';
import {escapeHtml} from './inspectorUtils';

export class ChartBuilder {
  private abort = new AbortController();
  private series: ChartSeriesManager;
  private sheet: SheetData | null = null;
  private profile: DatasetProfile | null = null;
  private draft!: ChartConfig;
  private committedKey = '';
  private recommendations: ChartRecommendation[] = [];
  constructor(private host: HTMLElement, private onChange: (config: ChartConfig) => void) {
    host.className = 'chart-builder';
    host.setAttribute('aria-label', 'Visual Chart Builder');
    host.innerHTML = `
      <div class="builder-heading"><strong>Chart Builder</strong><div>
        <button type="button" data-builder-reset>Reset chart</button>
        <button type="button" data-builder-recommend>Apply recommended chart</button>
      </div></div>
      <div class="builder-mappings">
        <div role="group" aria-label="Chart type" class="builder-types">
          ${[['bar','Bar','Compare measurements across categories'],['line','Line','Follow a sequence in source order'],['pie','Pie','Compare positive parts of a whole; primary series'],['scatter','Scatter','Compare numerical X and Y; primary series']].map(([type,label,hint]) => `<button type="button" data-chart-type="${type}" title="${hint}" aria-pressed="false">${label}</button>`).join('')}
        </div>
        <label>X / Group <select aria-label="Select X-axis column" data-builder-x></select></label>
        <div data-role="series-manager-host"></div>
      </div>
      <div class="builder-options" data-role="chart-secondary-controls">
        <label data-agg-wrap>Aggregation <select aria-label="Chart aggregation" data-builder-aggregation>
          <option value="none">None (raw)</option><option value="sum">Sum</option><option value="avg">Average</option><option value="count">Count valid values</option>
        </select></label>
        <label data-sort-wrap>Sort <select aria-label="Chart sort order" data-builder-sortOrder>
          <option value="source">Source order</option><option value="value-desc">Descending value</option><option value="value-asc">Ascending value</option>
        </select></label>
        <label data-limit-wrap>Limit <select aria-label="Chart point limit" data-builder-maxPoints>
          ${[12,24,32,64,100,200].map(n => `<option value="${n}">${n}</option>`).join('')}
        </select></label>
        <details class="builder-guide"><summary>Mapping guide</summary><p>Bar compares categories; Line follows source order. Pie shows positive parts using the primary series. Scatter needs numerical X and Y. Aggregation groups by X; Sum/Average/Count use valid numeric or binary values, excluding missing values. Sorting ranks the primary derived value. Pie displays up to 12 positive categories from 32 candidates; proportions describe displayed slices. Series types and exclusion reasons appear in Series Manager.</p></details>
      </div>
      <p data-builder-error role="alert" hidden></p>`;
    this.series = new ChartSeriesManager(host.querySelector('[data-role="series-manager-host"]')!, {onChangeSeries: yColIndices => this.change({...this.draft, yColIndices})});
    host.addEventListener('change', event => {
      const input = event.target as HTMLSelectElement;
      if (!input.matches('select')) return;
      if (input.hasAttribute('data-builder-x')) this.change({...this.draft, xColIndex: Number(input.value)});
      else for (const key of ['aggregation','sortOrder','maxPoints'] as const) {
        if (input.hasAttribute(`data-builder-${key}`)) this.change({...this.draft, [key]: key === 'maxPoints' ? Number(input.value) : input.value});
      }
    }, {signal: this.abort.signal});
    host.addEventListener('click', event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
      if (!button || !this.sheet) return;
      if (button.dataset.chartType) this.change({...this.draft, type: button.dataset.chartType as ChartConfig['type']});
      if (button.hasAttribute('data-builder-reset')) this.change(resetChartConfig(this.sheet, this.draft.spatialMode, this.profile));
      if (button.hasAttribute('data-builder-recommend')) {
        const rec = this.recommendations.find(r => r.targetSurface === '2d' && r.suggested2D
          && !validateChartConfig(this.sheet!, this.profile, {...resetChartConfig(this.sheet!, this.draft.spatialMode, this.profile), ...r.suggested2D}));
        this.change({...resetChartConfig(this.sheet, this.draft.spatialMode, this.profile), ...(rec?.suggested2D ?? {})});
      }
    }, {signal: this.abort.signal});
  }
  update(sheet: SheetData, profile: DatasetProfile | null, config: ChartConfig, recommendations: ChartRecommendation[]): void {
    const key = `${sheet.id}|${sheet.columns.join('\0')}|${JSON.stringify(config)}`;
    if (key !== this.committedKey) {this.draft = {...config, yColIndices: [...config.yColIndices]}; this.committedKey = key;}
    this.sheet = sheet; this.profile = profile; this.recommendations = recommendations;
    this.render();
  }
  private change(config: ChartConfig): void {
    this.draft = config;
    const error = validateChartConfig(this.sheet!, this.profile, config);
    this.render();
    if (!error) this.onChange(config);
  }
  private render(): void {
    if (!this.sheet) return;
    const x = this.host.querySelector<HTMLSelectElement>('[data-builder-x]')!;
    x.innerHTML = this.sheet.columns.map((name, i) => {
      const p = this.profile?.columns[i];
      const type = p?.roleOverride ?? p?.semanticType ?? this.sheet!.types[i];
      return `<option value="${i}" title="${escapeHtml(name)} · ${type}">${escapeHtml(name)} · ${type}</option>`;
    }).join('');
    x.value = String(this.draft.xColIndex);
    x.title = this.sheet.columns[this.draft.xColIndex];
    this.host.querySelectorAll<HTMLButtonElement>('[data-chart-type]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.chartType === this.draft.type)));
    const relevance = getSecondaryControlsForChartType(this.draft.type);
    for (const [key, value, visible] of [['aggregation',this.draft.aggregation ?? 'none',relevance.showAggregation], ['sortOrder',this.draft.sortOrder ?? 'source',relevance.showSort], ['maxPoints',String(this.draft.maxPoints ?? 32),relevance.showLimit]] as const) {
      const select = this.host.querySelector<HTMLSelectElement>(`[data-builder-${key}]`)!;
      select.value = value;
      select.parentElement!.hidden = !visible;
    }
    this.series.update({sheet: this.sheet, profile: this.profile, xColIndex: this.draft.xColIndex, yColIndices: this.draft.yColIndices, chartType: this.draft.type});
    const error = validateChartConfig(this.sheet, this.profile, this.draft);
    const message = this.host.querySelector<HTMLElement>('[data-builder-error]')!;
    message.hidden = !error; message.textContent = error ? `${error} The last valid chart remains visible.` : '';
    x.setAttribute('aria-invalid', String(!!error));
  }
  openSeries(): void {this.series.open();}
  dispose(): void {this.abort.abort(); this.series.dispose();}
}
