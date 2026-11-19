export const WORKSPACE_PREFS_STORAGE_KEY = 'spatialsheet.workspace.v1';
export const DEFAULT_SPLIT_RATIO = 0.55;
export const MIN_SPLIT_RATIO = 0.25;
export const MAX_SPLIT_RATIO = 0.75;
export const MIN_PANE_WIDTH_PX = 300;
export const DESKTOP_SPLIT_BREAKPOINT_PX = 1024;
export const SPLITTER_WIDTH_PX = 14;

export interface SplitPreset {
  id: '30-70' | '50-50' | '70-30';
  label: string;
  ratio: number;
}

export const SPLIT_PRESETS: readonly SplitPreset[] = [
  {id: '30-70', label: '30/70', ratio: 0.3},
  {id: '50-50', label: '50/50', ratio: 0.5},
  {id: '70-30', label: '70/30', ratio: 0.7},
] as const;

export interface WorkspacePrefsV1 {
  version: 1;
  splitRatio: number;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function isDesktopSplitViewport(viewportWidth: number): boolean {
  return Number.isFinite(viewportWidth) && viewportWidth >= DESKTOP_SPLIT_BREAKPOINT_PX;
}

export function getEffectiveSplitBounds(
  containerWidth: number,
  dividerWidth = SPLITTER_WIDTH_PX,
  minPanePx = MIN_PANE_WIDTH_PX
): {minRatio: number; maxRatio: number} {
  const usable = Math.max(0, containerWidth - dividerWidth);
  if (!Number.isFinite(usable) || usable <= minPanePx * 2) {
    return {minRatio: 0.5, maxRatio: 0.5};
  }
  const minByPx = minPanePx / usable;
  const maxByPx = 1 - minByPx;
  const minRatio = Math.max(MIN_SPLIT_RATIO, Math.min(0.5, minByPx));
  const maxRatio = Math.min(MAX_SPLIT_RATIO, Math.max(0.5, maxByPx));
  return minRatio <= maxRatio
    ? {minRatio, maxRatio}
    : {minRatio: 0.5, maxRatio: 0.5};
}

export function clampSplitRatio(
  ratio: number,
  containerWidth?: number,
  dividerWidth = SPLITTER_WIDTH_PX,
  minPanePx = MIN_PANE_WIDTH_PX
): number {
  const safe = Number.isFinite(ratio) ? ratio : DEFAULT_SPLIT_RATIO;
  if (typeof containerWidth === 'number' && containerWidth > 0) {
    const {minRatio, maxRatio} = getEffectiveSplitBounds(
      containerWidth,
      dividerWidth,
      minPanePx
    );
    return Math.min(maxRatio, Math.max(minRatio, safe));
  }
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, safe));
}

export function computeSplitRatioFromPointer(params: {
  clientX: number;
  containerLeft: number;
  containerWidth: number;
  dividerWidth?: number;
  minPanePx?: number;
}): number {
  const dividerWidth = params.dividerWidth ?? SPLITTER_WIDTH_PX;
  const minPanePx = params.minPanePx ?? MIN_PANE_WIDTH_PX;
  const usable = Math.max(1, params.containerWidth - dividerWidth);
  const rawLeft = params.clientX - params.containerLeft - dividerWidth / 2;
  const rawRatio = rawLeft / usable;
  return clampSplitRatio(rawRatio, params.containerWidth, dividerWidth, minPanePx);
}

export function computeSplitPaneWidths(params: {
  containerWidth: number;
  splitRatio: number;
  dividerWidth?: number;
  minPanePx?: number;
}): {leftWidthPx: number; rightWidthPx: number; clampedRatio: number} {
  const dividerWidth = params.dividerWidth ?? SPLITTER_WIDTH_PX;
  const minPanePx = params.minPanePx ?? MIN_PANE_WIDTH_PX;
  const usable = Math.max(0, params.containerWidth - dividerWidth);
  const clampedRatio = clampSplitRatio(
    params.splitRatio,
    params.containerWidth,
    dividerWidth,
    minPanePx
  );
  const leftWidthPx = Math.round(usable * clampedRatio);
  const rightWidthPx = Math.max(0, Math.round(usable - leftWidthPx));
  return {leftWidthPx, rightWidthPx, clampedRatio};
}

export function parseWorkspacePrefs(raw: string | null): WorkspacePrefsV1 | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    if (obj.version !== 1) return null;
    if (typeof obj.splitRatio !== 'number' || !Number.isFinite(obj.splitRatio)) {
      return null;
    }
    return {
      version: 1,
      splitRatio: clampSplitRatio(obj.splitRatio),
    };
  } catch {
    return null;
  }
}

export function loadWorkspaceSplitRatio(storage?: StorageLike | null): number {
  const target =
    storage !== undefined
      ? storage
      : typeof globalThis !== 'undefined' && 'localStorage' in globalThis
        ? globalThis.localStorage
        : null;
  if (!target) return DEFAULT_SPLIT_RATIO;
  try {
    const raw = target.getItem(WORKSPACE_PREFS_STORAGE_KEY);
    const parsed = parseWorkspacePrefs(raw);
    return parsed ? parsed.splitRatio : DEFAULT_SPLIT_RATIO;
  } catch {
    return DEFAULT_SPLIT_RATIO;
  }
}

export function saveWorkspaceSplitRatio(
  ratio: number,
  storage?: StorageLike | null
): void {
  const target =
    storage !== undefined
      ? storage
      : typeof globalThis !== 'undefined' && 'localStorage' in globalThis
        ? globalThis.localStorage
        : null;
  if (!target) return;
  try {
    const payload: WorkspacePrefsV1 = {
      version: 1,
      splitRatio: clampSplitRatio(ratio),
    };
    target.setItem(WORKSPACE_PREFS_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore storage quota or private-mode security errors
  }
}
