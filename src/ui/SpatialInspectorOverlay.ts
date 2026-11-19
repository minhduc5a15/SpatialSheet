import type {
  AggregationFn,
  ChartRecommendation,
  DatasetProfile,
  DerivedSpatialDataset,
  SamplingStrategy,
  ScaleType,
  SemanticType,
  SheetData,
  SpatialChartMode,
  SpatialConfig,
  SpatialDataItem,
  SpatialEnvironmentMode,
  SpatialSortOrder,
} from '../types';
import {getEffectiveSemanticType} from '../core/dataProfiler';
import {getValidAggregations} from '../core/spatialTransform';
import {formatDisplayNumber} from '../core/tabular';
import {svgIcon} from './icons';

export interface SpatialOverlayCallbacks {
  onModeChange: (mode: SpatialChartMode) => void;
  onConfigChange: (partial: Partial<SpatialConfig>) => void;
  onOverrideColumnRole: (colIndex: number, role: SemanticType | null) => void;
  onApplyRecommendation: (rec: ChartRecommendation) => void;
  onSelectItem: (item: SpatialDataItem | null) => void;
  onJumpToRow: (rowIndex: number) => void;
  onResetCamera: () => void;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function roleTag(role: SemanticType): string {
  switch (role) {
    case 'quantitative':
      return 'num';
    case 'categorical':
      return 'cat';
    case 'temporal':
      return 'date';
    case 'boolean':
      return 'bool';
    case 'identifier':
      return 'id';
    default:
      return 'text';
  }
}

export class SpatialInspectorOverlay {
  private hostEl: HTMLElement;
  private canvasMountEl: HTMLElement;
  private callbacks: SpatialOverlayCallbacks;

  private topBarEl!: HTMLElement;
  private recsPopoverEl!: HTMLElement;
  private configDrawerEl!: HTMLElement;
  private inspectorDrawerEl!: HTMLElement;
  private tooltipEl!: HTMLElement;
  private validationOverlayEl!: HTMLElement;
  private footerLegendEl!: HTMLElement;

  private isConfigOpen = false;
  private isRecsOpen = false;
  private roleTargetColIndex: number | null = null;

  private sheet: SheetData | null = null;
  private profile: DatasetProfile | null = null;
  private config: SpatialConfig | null = null;
  private derived: DerivedSpatialDataset | null = null;
  private recommendations: ChartRecommendation[] = [];
  private selectedItem: SpatialDataItem | null = null;
  private readonly abortController = new AbortController();

  constructor(
    hostEl: HTMLElement,
    canvasMountEl: HTMLElement,
    callbacks: SpatialOverlayCallbacks
  ) {
    this.hostEl = hostEl;
    this.canvasMountEl = canvasMountEl;
    this.callbacks = callbacks;
    this.mountContainers();
    this.bindEvents();
  }

  private mountContainers(): void {
    this.topBarEl = this.hostEl.querySelector('[data-role="spatial-topbar"]')!;
    this.footerLegendEl = this.hostEl.querySelector(
      '[data-role="spatial-footer"]'
    )!;

    this.tooltipEl = document.createElement('div');
    this.tooltipEl.dataset.role = 'spatial-tooltip';
    this.tooltipEl.className =
      'pointer-events-none hidden absolute z-30 max-w-[260px] rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100 shadow-xl';

    this.validationOverlayEl = document.createElement('div');
    this.validationOverlayEl.dataset.role = 'spatial-validation';
    this.validationOverlayEl.className =
      'hidden absolute inset-0 z-20 flex items-center justify-center p-6 pointer-events-none';

    this.recsPopoverEl = document.createElement('div');
    this.recsPopoverEl.dataset.role = 'spatial-recs-popover';
    this.recsPopoverEl.className =
      'hidden absolute top-2 left-2 z-30 w-80 max-w-[calc(100%-1rem)] max-h-[calc(100%-1rem)] overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 p-3 text-xs text-slate-100 shadow-2xl';

    this.configDrawerEl = document.createElement('div');
    this.configDrawerEl.dataset.role = 'spatial-config-drawer';
    this.configDrawerEl.className =
      'hidden absolute top-2 right-2 z-30 w-72 max-w-[calc(100%-1rem)] max-h-[calc(100%-1rem)] overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 p-3 text-xs text-slate-100 shadow-2xl';

    this.inspectorDrawerEl = document.createElement('div');
    this.inspectorDrawerEl.dataset.role = 'spatial-inspector';
    this.inspectorDrawerEl.className =
      'hidden absolute bottom-2 right-2 z-20 w-72 max-w-[calc(100%-1rem)] max-h-[70%] overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 p-3 text-xs text-slate-100 shadow-2xl';

    this.canvasMountEl.append(
      this.tooltipEl,
      this.validationOverlayEl,
      this.recsPopoverEl,
      this.configDrawerEl,
      this.inspectorDrawerEl
    );
  }

  private bindEvents(): void {
    const {signal} = this.abortController;
    this.topBarEl.addEventListener(
      'click',
      (e) => {
        const target = e.target as HTMLElement | null;
        if (!target) return;

        const modeBtn = target.closest<HTMLButtonElement>('[data-spatial-mode]');
        if (modeBtn) {
          this.callbacks.onModeChange(
            modeBtn.dataset.spatialMode as SpatialChartMode
          );
          return;
        }

        if (target.closest('[data-action="toggle-spatial-config"]')) {
          this.isConfigOpen = !this.isConfigOpen;
          if (this.isConfigOpen) this.isRecsOpen = false;
          this.renderTopBar();
          this.renderDrawers();
          return;
        }

        if (target.closest('[data-action="toggle-spatial-recs"]')) {
          this.isRecsOpen = !this.isRecsOpen;
          if (this.isRecsOpen) this.isConfigOpen = false;
          this.renderTopBar();
          this.renderDrawers();
          return;
        }

        if (target.closest('[data-action="reset-spatial-camera"]')) {
          this.callbacks.onResetCamera();
          return;
        }

        if (target.closest('[data-action="toggle-spatial-env"]')) {
          const nextEnv: SpatialEnvironmentMode =
            this.config?.environmentMode === 'studio' ? 'clean' : 'studio';
          this.callbacks.onConfigChange({environmentMode: nextEnv});
        }
      },
      {signal}
    );

    this.recsPopoverEl.addEventListener(
      'click',
      (e) => {
        const target = e.target as HTMLElement | null;
        if (!target) return;
        if (target.closest('[data-action="close-recs"]')) {
          this.isRecsOpen = false;
          this.renderTopBar();
          this.renderDrawers();
          return;
        }
        const applyBtn = target.closest<HTMLButtonElement>('[data-apply-rec-id]');
        if (applyBtn) {
          const rec = this.recommendations.find(
            (r) => r.id === applyBtn.dataset.applyRecId
          );
          if (rec) {
            this.isRecsOpen = false;
            this.renderTopBar();
            this.callbacks.onApplyRecommendation(rec);
          }
        }
      },
      {signal}
    );

    this.validationOverlayEl.addEventListener(
      'click',
      (e) => {
        const target = e.target as HTMLElement | null;
        if (target?.closest('[data-action="switch-to-bar3d"]')) {
          this.callbacks.onModeChange('bar3d');
        } else if (target?.closest('[data-action="open-config-from-err"]')) {
          this.isConfigOpen = true;
          this.isRecsOpen = false;
          this.renderTopBar();
          this.renderDrawers();
        }
      },
      {signal}
    );

    this.configDrawerEl.addEventListener(
      'click',
      (e) => {
        const target = e.target as HTMLElement | null;
        if (target?.closest('[data-action="close-config"]')) {
          this.isConfigOpen = false;
          this.renderTopBar();
          this.renderDrawers();
        }
      },
      {signal}
    );

    this.configDrawerEl.addEventListener(
      'change',
      (e) => {
        const el = e.target as HTMLSelectElement | null;
        if (!el || !this.config) return;
        const role = el.dataset.cfgField;
        if (!role) return;

        switch (role) {
          case 'xColIndex':
            this.callbacks.onConfigChange({xColIndex: Number(el.value)});
            break;
          case 'yColIndex':
            this.callbacks.onConfigChange({yColIndex: Number(el.value)});
            break;
          case 'zColIndex':
            this.callbacks.onConfigChange({
              zColIndex: el.value === '' ? null : Number(el.value),
            });
            break;
          case 'groupByColIndex':
            this.callbacks.onConfigChange({
              groupByColIndex: el.value === '' ? null : Number(el.value),
            });
            break;
          case 'colorColIndex':
            this.callbacks.onConfigChange({
              colorColIndex: el.value === '' ? null : Number(el.value),
            });
            break;
          case 'aggregation':
            this.callbacks.onConfigChange({
              aggregation: el.value as AggregationFn,
            });
            break;
          case 'sortOrder':
            this.callbacks.onConfigChange({
              sortOrder: el.value as SpatialSortOrder,
            });
            break;
          case 'topK':
            this.callbacks.onConfigChange({topK: Number(el.value)});
            break;
          case 'scaleType':
            this.callbacks.onConfigChange({scaleType: el.value as ScaleType});
            break;
          case 'samplingStrategy':
            this.callbacks.onConfigChange({
              samplingStrategy: el.value as SamplingStrategy,
            });
            break;
          case 'sampleLimit':
            this.callbacks.onConfigChange({sampleLimit: Number(el.value)});
            break;
          case 'roleTargetCol':
            this.roleTargetColIndex = Number(el.value);
            this.renderConfigDrawer();
            break;
          case 'roleOverride': {
            const targetCol = this.roleTargetColIndex ?? this.config.yColIndex;
            const nextRole =
              el.value === 'auto' ? null : (el.value as SemanticType);
            this.callbacks.onOverrideColumnRole(targetCol, nextRole);
            break;
          }
        }
      },
      {signal}
    );

    this.inspectorDrawerEl.addEventListener(
      'click',
      (e) => {
        const target = e.target as HTMLElement | null;
        if (!target) return;
        if (target.closest('[data-action="close-inspector"]')) {
          this.callbacks.onSelectItem(null);
          return;
        }
        const jumpBtn = target.closest<HTMLButtonElement>('[data-jump-row]');
        if (jumpBtn) {
          this.callbacks.onJumpToRow(Number(jumpBtn.dataset.jumpRow));
        }
      },
      {signal}
    );
  }

  public update(params: {
    sheet: SheetData;
    profile: DatasetProfile;
    config: SpatialConfig;
    derived: DerivedSpatialDataset;
    recommendations: ChartRecommendation[];
    selectedItem: SpatialDataItem | null;
  }): void {
    this.sheet = params.sheet;
    this.profile = params.profile;
    this.config = params.config;
    this.derived = params.derived;
    this.recommendations = params.recommendations;
    this.selectedItem = params.selectedItem;

    if (
      this.roleTargetColIndex === null ||
      this.roleTargetColIndex >= params.sheet.columns.length
    ) {
      this.roleTargetColIndex = params.config.yColIndex;
    }

    this.renderTopBar();
    this.renderValidationState();
    this.renderDrawers();
    this.renderInspector();
    this.renderFooterLegend();
  }

  public showTooltip(
    item: SpatialDataItem | null,
    clientX: number,
    clientY: number
  ): void {
    if (!item || !this.derived) {
      this.tooltipEl.classList.add('hidden');
      return;
    }

    const rect = this.canvasMountEl.getBoundingClientRect();
    const yUnit = item.yUnit ? ` ${item.yUnit}` : '';
    const aggBadge =
      item.aggregation !== 'none'
        ? `<span class="ml-1.5 px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 font-mono text-[10px]">${item.aggregation.toUpperCase()}</span>`
        : '';

    const zLine =
      this.derived.mode === 'scatter3d' && item.zRaw !== null
        ? `<div class="text-slate-300">Z (${escapeHtml(this.derived.axes.z?.title ?? 'Z')}): <span class="font-mono text-white">${escapeHtml(String(item.zRaw))}${item.zUnit ? ` ${escapeHtml(item.zUnit)}` : ''}</span></div>`
        : this.derived.mode === 'ring3d' && item.proportion !== undefined
          ? `<div class="text-slate-300">Share: <span class="font-mono text-white">${(item.proportion * 100).toFixed(1)}%</span></div>`
          : '';

    const xLine =
      this.derived.mode === 'scatter3d'
        ? `<div class="text-slate-300">X (${escapeHtml(this.derived.axes.x.title)}): <span class="font-mono text-white">${escapeHtml(String(item.xRaw))}${item.xUnit ? ` ${escapeHtml(item.xUnit)}` : ''}</span></div>`
        : '';

    const footerLine =
      item.recordCount > 1
        ? `Records aggregated: ${item.recordCount.toLocaleString('en-US')}`
        : `Source Row #${item.firstRowIndex + 1}`;

    this.tooltipEl.innerHTML = `
      <div class="flex items-center gap-1.5 font-semibold text-white mb-1">
        <span class="w-2.5 h-2.5 rounded-xs shrink-0" style="background-color:${item.colorHex}"></span>
        <span class="truncate">${escapeHtml(item.label)}</span>
        ${aggBadge}
      </div>
      ${item.seriesLabel ? `<div class="text-[11px] text-slate-400 mb-1">${escapeHtml(item.seriesLabel)}</div>` : ''}
      ${xLine}
      <div class="text-slate-200">${escapeHtml(this.derived.axes.y.title)}: <span class="font-mono font-semibold text-white">${escapeHtml(formatDisplayNumber(item.yValue))}${escapeHtml(yUnit)}</span></div>
      ${zLine}
      <div class="mt-1 pt-1 border-t border-slate-800 text-[10px] text-slate-400">${escapeHtml(footerLine)} · Click to inspect</div>
    `;

    this.tooltipEl.classList.remove('hidden');

    const tipW = 240;
    const tipH = 120;
    const rawX = clientX - rect.left + 14;
    const rawY = clientY - rect.top - 14;
    const clampedX = Math.max(8, Math.min(rect.width - tipW, rawX));
    const clampedY = Math.max(8, Math.min(rect.height - tipH, rawY));
    this.tooltipEl.style.left = `${clampedX}px`;
    this.tooltipEl.style.top = `${clampedY}px`;
  }

  private renderTopBar(): void {
    if (!this.derived || !this.config) return;
    const mode = this.derived.mode;
    const envIsStudio = this.config.environmentMode === 'studio';
    const spatialRecs = this.recommendations.filter(
      (r) => r.targetSurface === '3d'
    );

    const modes: {id: SpatialChartMode; label: string}[] = [
      {id: 'bar3d', label: '3D Bars'},
      {id: 'scatter3d', label: '3D Scatter'},
      {id: 'ring3d', label: '3D Ring'},
    ];

    const modeButtonsHtml = modes
      .map((m) => {
        const active = m.id === mode;
        const cls = active
          ? 'bg-blue-600 text-white font-semibold'
          : 'text-slate-300 hover:bg-slate-800 hover:text-white';
        return `<button type="button" data-spatial-mode="${m.id}" class="px-2.5 py-1 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${cls}">${m.label}</button>`;
      })
      .join('');

    this.topBarEl.innerHTML = `
      <div class="flex flex-wrap items-center gap-1.5" role="group" aria-label="3D chart style">
        ${modeButtonsHtml}
      </div>
      <div class="flex flex-wrap items-center gap-1.5">
        ${
          spatialRecs.length > 0
            ? `<button
                type="button"
                data-action="toggle-spatial-recs"
                aria-expanded="${this.isRecsOpen}"
                class="inline-flex items-center gap-1 px-2 py-1 rounded-md border ${this.isRecsOpen ? 'bg-blue-600/20 border-blue-400 text-blue-200' : 'border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700'} transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                title="View recommended views for this dataset"
              >
                <span>Suggest (${spatialRecs.length})</span>
              </button>`
            : ''
        }
        <button
          type="button"
          data-action="toggle-spatial-env"
          class="px-2 py-1 rounded-md border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          title="Toggle Clean Analytical view vs Studio Pedestal"
        >
          ${envIsStudio ? 'Studio' : 'Clean'}
        </button>
        <button
          type="button"
          data-action="reset-spatial-camera"
          class="px-2 py-1 rounded-md border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          title="Reset 3D camera angle"
        >
          Reset View
        </button>
        <button
          type="button"
          data-action="toggle-spatial-config"
          aria-expanded="${this.isConfigOpen}"
          class="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border ${this.isConfigOpen ? 'bg-blue-600 border-blue-500 text-white font-semibold' : 'border-slate-700 bg-slate-800 text-slate-100 hover:bg-slate-700'} transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <span>Configure</span>
        </button>
      </div>
    `;
  }

  private renderValidationState(): void {
    if (!this.derived || this.derived.isValid) {
      this.validationOverlayEl.classList.add('hidden');
      this.validationOverlayEl.innerHTML = '';
      return;
    }

    const msg =
      this.derived.validationMessage ??
      'Unable to plot the current configuration.';
    const showBarFallback = this.derived.mode === 'ring3d';

    this.validationOverlayEl.innerHTML = `
      <div class="pointer-events-auto max-w-sm rounded-xl border border-slate-700 bg-slate-900 p-4 text-center shadow-2xl">
        <p class="text-sm font-semibold text-white">Visualization Not Applicable</p>
        <p class="mt-1.5 text-xs text-slate-300 leading-relaxed">${escapeHtml(msg)}</p>
        <div class="mt-3 flex items-center justify-center gap-2">
          ${
            showBarFallback
              ? `<button type="button" data-action="switch-to-bar3d" class="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-semibold text-white cursor-pointer">Switch to 3D Bars</button>`
              : ''
          }
          <button type="button" data-action="open-config-from-err" class="px-3 py-1.5 rounded-lg border border-slate-600 bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 cursor-pointer">Configure Axes</button>
        </div>
      </div>
    `;
    this.validationOverlayEl.classList.remove('hidden');
  }

  private renderDrawers(): void {
    if (this.isRecsOpen) {
      this.renderRecommendationsPopover();
      this.recsPopoverEl.classList.remove('hidden');
    } else {
      this.recsPopoverEl.classList.add('hidden');
    }

    if (this.isConfigOpen) {
      this.renderConfigDrawer();
      this.configDrawerEl.classList.remove('hidden');
    } else {
      this.configDrawerEl.classList.add('hidden');
    }
  }

  private renderRecommendationsPopover(): void {
    const cards = this.recommendations
      .map(
        (rec) => `
      <div class="rounded-lg border border-slate-700/80 bg-slate-950/60 p-2.5 flex flex-col gap-1.5">
        <div class="flex items-start justify-between gap-2">
          <span class="font-semibold text-white leading-snug">${escapeHtml(rec.title)}</span>
          <span class="px-1.5 py-0.5 rounded bg-slate-800 text-[10px] font-mono text-blue-300 shrink-0">${rec.targetSurface.toUpperCase()}</span>
        </div>
        <p class="text-[11px] text-slate-400 leading-relaxed">${escapeHtml(rec.reason)}</p>
        <button
          type="button"
          data-apply-rec-id="${escapeHtml(rec.id)}"
          class="self-start mt-0.5 px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-500 text-[11px] font-semibold text-white cursor-pointer"
        >Apply View</button>
      </div>
    `
      )
      .join('');

    this.recsPopoverEl.innerHTML = `
      <div class="flex items-center justify-between pb-2 mb-2 border-b border-slate-800">
        <span class="font-semibold text-white">Recommended Explorations</span>
        <button type="button" data-action="close-recs" class="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white cursor-pointer" aria-label="Close recommendations">
          ${svgIcon('close', 'w-3.5 h-3.5')}
        </button>
      </div>
      <div class="flex flex-col gap-2">
        ${cards || '<p class="text-slate-400">Load a dataset with numeric and categorical columns for recommendations.</p>'}
      </div>
    `;
  }

  private renderConfigDrawer(): void {
    if (!this.sheet || !this.profile || !this.config || !this.derived) return;
    const cols = this.profile.columns;
    const cfg = this.config;
    const mode = this.derived.mode;

    const buildColOptions = (
      selected: number | null,
      includeNone = false,
      noneLabel = 'None'
    ): string => {
      const noneOpt = includeNone
        ? `<option value="" ${selected === null ? 'selected' : ''}>${escapeHtml(noneLabel)}</option>`
        : '';
      return (
        noneOpt +
        cols
          .map((c) => {
            const eff = getEffectiveSemanticType(c);
            const unitStr =
              c.unit && !c.name.includes(`(${c.unit})`) ? ` (${c.unit})` : '';
            return `<option value="${c.colIndex}" ${selected === c.colIndex ? 'selected' : ''}>${escapeHtml(c.name)}${escapeHtml(unitStr)} [${roleTag(eff)}]</option>`;
          })
          .join('')
      );
    };

    const yColProfile = cols[cfg.yColIndex];
    const aggStatuses = getValidAggregations(yColProfile, mode);
    const aggOptionsHtml = aggStatuses
      .map(
        (st) =>
          `<option value="${st.fn}" ${cfg.aggregation === st.fn ? 'selected' : ''} ${st.enabled ? '' : 'disabled'}>${escapeHtml(st.label)}${st.enabled ? '' : ' (Invalid)'}</option>`
      )
      .join('');

    const disabledHint = aggStatuses.find(
      (s) => !s.enabled && s.reason
    )?.reason;

    const targetRoleColIdx = this.roleTargetColIndex ?? cfg.yColIndex;
    const targetCol = cols[targetRoleColIdx];
    const currentOverride = targetCol?.roleOverride ?? 'auto';

    this.configDrawerEl.innerHTML = `
      <div class="flex items-center justify-between pb-2 mb-2.5 border-b border-slate-800">
        <span class="font-semibold text-white">Spatial Configuration</span>
        <button type="button" data-action="close-config" class="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white cursor-pointer" aria-label="Close configuration">
          ${svgIcon('close', 'w-3.5 h-3.5')}
        </button>
      </div>

      <div class="flex flex-col gap-2.5">
        <label class="flex flex-col gap-1">
          <span class="text-[11px] text-slate-400">X Axis (Category / Dimension)</span>
          <select data-cfg-field="xColIndex" class="bg-slate-950 border border-slate-700 rounded-md px-2 py-1.5 text-slate-100">
            ${buildColOptions(cfg.xColIndex)}
          </select>
        </label>

        <label class="flex flex-col gap-1">
          <span class="text-[11px] text-slate-400">Y Axis (Metric)</span>
          <select data-cfg-field="yColIndex" class="bg-slate-950 border border-slate-700 rounded-md px-2 py-1.5 text-slate-100">
            ${buildColOptions(cfg.yColIndex)}
          </select>
        </label>

        ${
          mode === 'scatter3d'
            ? `
          <label class="flex flex-col gap-1">
            <span class="text-[11px] text-slate-400">Z Axis (3rd Coordinate)</span>
            <select data-cfg-field="zColIndex" class="bg-slate-950 border border-slate-700 rounded-md px-2 py-1.5 text-slate-100">
              ${buildColOptions(cfg.zColIndex, true, 'Select Z column...')}
            </select>
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-[11px] text-slate-400">Color Dimension (4th Dim)</span>
            <select data-cfg-field="colorColIndex" class="bg-slate-950 border border-slate-700 rounded-md px-2 py-1.5 text-slate-100">
              ${buildColOptions(cfg.colorColIndex, true, 'Single color')}
            </select>
          </label>
        `
            : mode === 'bar3d'
              ? `
          <label class="flex flex-col gap-1">
            <span class="text-[11px] text-slate-400">Group By Series (Z Axis)</span>
            <select data-cfg-field="groupByColIndex" class="bg-slate-950 border border-slate-700 rounded-md px-2 py-1.5 text-slate-100">
              ${buildColOptions(cfg.groupByColIndex, true, 'None (Single Series)')}
            </select>
          </label>
        `
              : ''
        }

        ${
          mode !== 'scatter3d'
            ? `
          <div class="grid grid-cols-2 gap-2">
            <label class="flex flex-col gap-1">
              <span class="text-[11px] text-slate-400">Aggregation</span>
              <select data-cfg-field="aggregation" class="bg-slate-950 border border-slate-700 rounded-md px-2 py-1.5 text-slate-100">
                ${aggOptionsHtml}
              </select>
            </label>
            <label class="flex flex-col gap-1">
              <span class="text-[11px] text-slate-400">Sort Order</span>
              <select data-cfg-field="sortOrder" class="bg-slate-950 border border-slate-700 rounded-md px-2 py-1.5 text-slate-100">
                <option value="source" ${cfg.sortOrder === 'source' ? 'selected' : ''}>Source Order</option>
                <option value="value-desc" ${cfg.sortOrder === 'value-desc' ? 'selected' : ''}>Value High→Low</option>
                <option value="value-asc" ${cfg.sortOrder === 'value-asc' ? 'selected' : ''}>Value Low→High</option>
                <option value="label-asc" ${cfg.sortOrder === 'label-asc' ? 'selected' : ''}>Label A→Z</option>
              </select>
            </label>
          </div>
          ${disabledHint ? `<p class="text-[10px] text-amber-300/90 leading-snug">${escapeHtml(disabledHint)}</p>` : ''}
        `
            : ''
        }

        <div class="grid grid-cols-2 gap-2">
          ${
            mode !== 'scatter3d'
              ? `
            <label class="flex flex-col gap-1">
              <span class="text-[11px] text-slate-400">${mode === 'ring3d' ? 'Max Slices' : 'Top-K Groups'}</span>
              <select data-cfg-field="topK" class="bg-slate-950 border border-slate-700 rounded-md px-2 py-1.5 text-slate-100">
                ${(mode === 'ring3d' ? [5, 8, 10] : [8, 12, 16, 24, 36])
                  .map(
                    (k) =>
                      `<option value="${k}" ${cfg.topK === k ? 'selected' : ''}>Top ${k}</option>`
                  )
                  .join('')}
              </select>
            </label>
          `
              : `
            <label class="flex flex-col gap-1">
              <span class="text-[11px] text-slate-400">Sample Limit</span>
              <select data-cfg-field="sampleLimit" class="bg-slate-950 border border-slate-700 rounded-md px-2 py-1.5 text-slate-100">
                ${[250, 500, 1500, 5000]
                  .map(
                    (n) =>
                      `<option value="${n}" ${cfg.sampleLimit === n ? 'selected' : ''}>${n.toLocaleString('en-US')} pts</option>`
                  )
                  .join('')}
              </select>
            </label>
          `
          }

          ${
            mode !== 'ring3d'
              ? `
            <label class="flex flex-col gap-1">
              <span class="text-[11px] text-slate-400">Axis Scale</span>
              <select data-cfg-field="scaleType" class="bg-slate-950 border border-slate-700 rounded-md px-2 py-1.5 text-slate-100">
                <option value="linear" ${cfg.scaleType === 'linear' ? 'selected' : ''}>Linear</option>
                <option value="log" ${cfg.scaleType === 'log' ? 'selected' : ''}>Logarithmic</option>
              </select>
            </label>
          `
              : ''
          }
        </div>

        ${
          mode === 'scatter3d' || cfg.aggregation === 'none'
            ? `
          <label class="flex flex-col gap-1">
            <span class="text-[11px] text-slate-400">Sampling Strategy</span>
            <select data-cfg-field="samplingStrategy" class="bg-slate-950 border border-slate-700 rounded-md px-2 py-1.5 text-slate-100">
              <option value="systematic" ${cfg.samplingStrategy === 'systematic' ? 'selected' : ''}>Evenly Spaced (Systematic)</option>
              <option value="first-n" ${cfg.samplingStrategy === 'first-n' ? 'selected' : ''}>First N Rows</option>
            </select>
          </label>
        `
            : ''
        }

        <div class="pt-2 border-t border-slate-800 flex flex-col gap-1.5">
          <span class="text-[11px] font-medium text-slate-300">Column Semantic Role Override</span>
          <div class="grid grid-cols-2 gap-2">
            <select data-cfg-field="roleTargetCol" class="bg-slate-950 border border-slate-700 rounded-md px-2 py-1 text-[11px] text-slate-100">
              ${cols
                .map(
                  (c) =>
                    `<option value="${c.colIndex}" ${c.colIndex === targetRoleColIdx ? 'selected' : ''}>${escapeHtml(c.name)}</option>`
                )
                .join('')}
            </select>
            <select data-cfg-field="roleOverride" class="bg-slate-950 border border-slate-700 rounded-md px-2 py-1 text-[11px] text-slate-100">
              <option value="auto" ${currentOverride === 'auto' ? 'selected' : ''}>Auto (${targetCol?.semanticType ?? 'text'})</option>
              <option value="quantitative" ${currentOverride === 'quantitative' ? 'selected' : ''}>Quantitative</option>
              <option value="categorical" ${currentOverride === 'categorical' ? 'selected' : ''}>Categorical</option>
              <option value="temporal" ${currentOverride === 'temporal' ? 'selected' : ''}>Temporal</option>
              <option value="boolean" ${currentOverride === 'boolean' ? 'selected' : ''}>Boolean</option>
              <option value="identifier" ${currentOverride === 'identifier' ? 'selected' : ''}>Identifier</option>
              <option value="text" ${currentOverride === 'text' ? 'selected' : ''}>Text</option>
            </select>
          </div>
        </div>
      </div>
    `;
  }

  private renderInspector(): void {
    const item = this.selectedItem;
    if (!item || !this.derived || !this.sheet) {
      this.inspectorDrawerEl.classList.add('hidden');
      this.inspectorDrawerEl.innerHTML = '';
      return;
    }

    const yUnit = item.yUnit ? ` ${item.yUnit}` : '';
    const aggStatsHtml = item.aggStats
      ? `
      <div class="grid grid-cols-2 gap-1.5 pt-2 border-t border-slate-800 text-[11px]">
        <div class="bg-slate-950/70 rounded px-2 py-1"><span class="text-slate-400">Sum:</span> <span class="font-mono text-white">${formatDisplayNumber(item.aggStats.sum)}${escapeHtml(yUnit)}</span></div>
        <div class="bg-slate-950/70 rounded px-2 py-1"><span class="text-slate-400">Avg:</span> <span class="font-mono text-white">${formatDisplayNumber(item.aggStats.avg)}${escapeHtml(yUnit)}</span></div>
        <div class="bg-slate-950/70 rounded px-2 py-1"><span class="text-slate-400">Min:</span> <span class="font-mono text-white">${formatDisplayNumber(item.aggStats.min)}${escapeHtml(yUnit)}</span></div>
        <div class="bg-slate-950/70 rounded px-2 py-1"><span class="text-slate-400">Max:</span> <span class="font-mono text-white">${formatDisplayNumber(item.aggStats.max)}${escapeHtml(yUnit)}</span></div>
      </div>
    `
      : '';

    const zDetail =
      item.zRaw !== null && this.derived.axes.z
        ? `<div class="flex justify-between gap-2"><span class="text-slate-400">${escapeHtml(this.derived.axes.z.title)}</span><span class="font-mono text-slate-100">${escapeHtml(String(item.zRaw))}${item.zUnit ? ` ${escapeHtml(item.zUnit)}` : ''}</span></div>`
        : item.proportion !== undefined
          ? `<div class="flex justify-between gap-2"><span class="text-slate-400">Share of Total</span><span class="font-mono text-slate-100">${(item.proportion * 100).toFixed(2)}%</span></div>`
          : '';

    const sourceRowsPreview = item.rowIndices.slice(0, 12);
    const recordsHtml = sourceRowsPreview
      .map((rIdx) => {
        const row = this.sheet!.rows[rIdx] ?? [];
        const previewVal = row[this.config?.yColIndex ?? 0] ?? '';
        const previewLbl = row[this.config?.xColIndex ?? 0] ?? `Row ${rIdx + 1}`;
        return `
        <button
          type="button"
          data-jump-row="${rIdx}"
          class="w-full flex items-center justify-between gap-2 px-2 py-1 rounded bg-slate-950/70 hover:bg-slate-800 text-left transition-colors cursor-pointer"
        >
          <span class="truncate text-slate-300">#${rIdx + 1} · ${escapeHtml(previewLbl)}</span>
          <span class="font-mono text-blue-300 shrink-0">${escapeHtml(previewVal)}</span>
        </button>
      `;
      })
      .join('');

    this.inspectorDrawerEl.innerHTML = `
      <div class="flex items-start justify-between gap-2 pb-2 border-b border-slate-800">
        <div class="min-w-0">
          <div class="flex items-center gap-1.5">
            <span class="w-2.5 h-2.5 rounded-xs shrink-0" style="background-color:${item.colorHex}"></span>
            <h3 class="font-semibold text-white truncate">${escapeHtml(item.label)}</h3>
          </div>
          <p class="text-[11px] text-slate-400 mt-0.5">${escapeHtml(item.seriesLabel)} · ${item.recordCount > 1 ? `${item.recordCount.toLocaleString('en-US')} records (${item.aggregation.toUpperCase()})` : `Raw row #${item.firstRowIndex + 1}`}</p>
        </div>
        <button type="button" data-action="close-inspector" class="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white cursor-pointer shrink-0" aria-label="Close inspector">
          ${svgIcon('close', 'w-3.5 h-3.5')}
        </button>
      </div>

      <div class="mt-2 flex flex-col gap-1 text-[11px]">
        <div class="flex justify-between gap-2">
          <span class="text-slate-400">${escapeHtml(this.derived.axes.x.title)}</span>
          <span class="font-mono text-slate-100 truncate">${escapeHtml(String(item.xRaw))}${item.xUnit ? ` ${escapeHtml(item.xUnit)}` : ''}</span>
        </div>
        <div class="flex justify-between gap-2">
          <span class="text-slate-400">${escapeHtml(this.derived.axes.y.title)}</span>
          <span class="font-mono font-semibold text-white">${escapeHtml(formatDisplayNumber(item.yValue))}${escapeHtml(yUnit)}</span>
        </div>
        ${zDetail}
      </div>

      ${aggStatsHtml}

      <div class="mt-2.5 pt-2 border-t border-slate-800 flex flex-col gap-1.5">
        <div class="flex items-center justify-between">
          <span class="text-[11px] text-slate-400">Source Records (${item.recordCount > sourceRowsPreview.length ? `first ${sourceRowsPreview.length} of ${item.recordCount}` : item.recordCount})</span>
          <button
            type="button"
            data-jump-row="${item.firstRowIndex}"
            class="px-2 py-0.5 rounded bg-blue-600 hover:bg-blue-500 text-[11px] font-semibold text-white cursor-pointer"
          >Jump to Row #${item.firstRowIndex + 1}</button>
        </div>
        <div class="flex flex-col gap-1 max-h-28 overflow-y-auto">
          ${recordsHtml}
        </div>
      </div>
    `;

    this.inspectorDrawerEl.classList.remove('hidden');
  }

  private renderFooterLegend(): void {
    if (!this.derived) return;
    const d = this.derived;

    let legendHtml = '';
    if (d.legend.kind === 'continuous') {
      legendHtml = `
        <div class="flex items-center gap-2">
          <span class="text-slate-400">${escapeHtml(d.legend.title)}:</span>
          <span class="font-mono text-[10px] text-slate-300">${escapeHtml(d.legend.minLabel ?? '')}</span>
          <span class="w-24 h-2.5 rounded-xs" style="background:linear-gradient(90deg, #2563eb, #06b6d4, #10b981, #f59e0b, #e11d48)"></span>
          <span class="font-mono text-[10px] text-slate-300">${escapeHtml(d.legend.maxLabel ?? '')}</span>
        </div>
      `;
    } else if (d.legend.kind === 'discrete' && d.legend.entries.length > 0) {
      const swatches = d.legend.entries
        .slice(0, 7)
        .map(
          (e) => `
          <span class="inline-flex items-center gap-1">
            <span class="w-2 h-2 rounded-xs shrink-0" style="background-color:${e.colorHex}"></span>
            <span class="text-slate-200 truncate max-w-[110px]">${escapeHtml(e.label)}</span>
          </span>
        `
        )
        .join('');
      const overflow =
        d.legend.entries.length > 7
          ? `<span class="text-slate-400">+${d.legend.entries.length - 7} more</span>`
          : '';
      legendHtml = `<div class="flex flex-wrap items-center gap-x-3 gap-y-1">${swatches}${overflow}</div>`;
    }

    const badgeColor =
      d.dataStateKind === 'aggregated'
        ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
        : d.dataStateKind === 'sampled'
          ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
          : 'bg-blue-500/15 text-blue-300 border-blue-500/30';

    const warningHtml = d.warningMessage
      ? `<span class="text-[11px] text-amber-300">${escapeHtml(d.warningMessage)}</span>`
      : '';

    this.footerLegendEl.innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-2 w-full">
        ${legendHtml || '<div></div>'}
        <div class="flex flex-wrap items-center gap-2 ml-auto">
          ${warningHtml}
          <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded border text-[10px] font-medium ${badgeColor}">
            <span>${d.dataStateKind.toUpperCase()}</span>
            <span class="text-slate-300">· ${escapeHtml(d.dataStateSummary)}</span>
          </span>
        </div>
      </div>
    `;
  }

  public dispose(): void {
    this.abortController.abort();
  }
}
