import type {
  ColumnViewState,
  SheetData,
  VisibleColumnPlan,
} from '../types';

export const MIN_COL_WIDTH = 84;
export const MAX_COL_WIDTH = 560;
export const DEFAULT_COL_WIDTH = 156;
export const MAX_AUTO_FIT_SAMPLES = 200;
export const MIN_UNPINNED_VIEWPORT_TAIL_PX = 180;

export function clampColumnWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_COL_WIDTH;
  return Math.round(Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, width)));
}

export function createColumnViewState(sheet: SheetData): ColumnViewState {
  const count = sheet.columns.length;
  const order = new Array<number>(count);
  for (let i = 0; i < count; i++) order[i] = i;
  return {
    order,
    hidden: [],
    pinned: [],
    widths: {},
  };
}

export function computeDefaultColumnWidths(
  sheet: SheetData,
  explicitWidths?: Record<number, number>
): number[] {
  const cols = sheet.columns;
  const rows = sheet.rows;
  const sampleLimit = Math.min(rows.length, 24);
  const widths = new Array<number>(cols.length);

  for (let c = 0; c < cols.length; c++) {
    if (explicitWidths && typeof explicitWidths[c] === 'number') {
      widths[c] = clampColumnWidth(explicitWidths[c]);
      continue;
    }
    let maxLen = cols[c].length;
    for (let r = 0; r < sampleLimit; r++) {
      const len = Math.min(28, (rows[r]?.[c] ?? '').length);
      if (len > maxLen) maxLen = len;
    }
    const headerWidth = cols[c].length * 7.2 + 114;
    const raw = Math.max(156, headerWidth, Math.min(250, maxLen * 7.5 + 68));
    widths[c] = clampColumnWidth(raw);
  }

  return widths;
}

export function computeAutoFitColumnWidth(
  sheet: SheetData,
  sourceColIndex: number,
  maxSamples = MAX_AUTO_FIT_SAMPLES
): number {
  if (sourceColIndex < 0 || sourceColIndex >= sheet.columns.length) {
    return DEFAULT_COL_WIDTH;
  }

  const headerName = sheet.columns[sourceColIndex] ?? '';
  let maxCellLen = 0;
  const rows = sheet.rows;
  const total = rows.length;

  if (total > 0) {
    const sampleCount = Math.min(total, Math.max(1, maxSamples));
    const step = sampleCount === 1 ? 0 : (total - 1) / (sampleCount - 1);
    for (let s = 0; s < sampleCount; s++) {
      const r = Math.round(s * step);
      const raw = rows[r]?.[sourceColIndex] ?? '';
      // Normalize multiline cells to longest single line capped reasonably
      const lineLen = raw.includes('\n')
        ? raw
            .split('\n')
            .reduce((best, line) => Math.max(best, line.length), 0)
        : raw.length;
      if (lineLen > maxCellLen) maxCellLen = lineLen;
    }
  }

  const headerRequired = headerName.length * 7.4 + 118;
  const contentRequired = Math.min(MAX_COL_WIDTH, maxCellLen * 7.6 + 34);
  return clampColumnWidth(Math.max(headerRequired, contentRequired));
}

export function normalizeColumnViewState(
  view: ColumnViewState | undefined,
  colCount: number
): ColumnViewState {
  if (!view) {
    const order = Array.from({length: colCount}, (_, i) => i);
    return {order, hidden: [], pinned: [], widths: {}};
  }

  const seen = new Set<number>();
  const order: number[] = [];
  for (const idx of view.order) {
    if (Number.isInteger(idx) && idx >= 0 && idx < colCount && !seen.has(idx)) {
      seen.add(idx);
      order.push(idx);
    }
  }
  for (let i = 0; i < colCount; i++) {
    if (!seen.has(i)) order.push(i);
  }

  const hiddenSet = new Set<number>();
  for (const idx of view.hidden) {
    if (Number.isInteger(idx) && idx >= 0 && idx < colCount) {
      hiddenSet.add(idx);
    }
  }
  // Never leave 0 visible columns
  if (colCount > 0 && hiddenSet.size >= colCount) {
    hiddenSet.delete(order[0]);
  }

  const pinnedSet = new Set<number>();
  const pinned: number[] = [];
  for (const idx of view.pinned) {
    if (
      Number.isInteger(idx) &&
      idx >= 0 &&
      idx < colCount &&
      !pinnedSet.has(idx)
    ) {
      pinnedSet.add(idx);
      pinned.push(idx);
    }
  }

  const widths: Record<number, number> = {};
  for (const [key, val] of Object.entries(view.widths)) {
    const colIdx = Number(key);
    if (
      Number.isInteger(colIdx) &&
      colIdx >= 0 &&
      colIdx < colCount &&
      typeof val === 'number' &&
      Number.isFinite(val)
    ) {
      widths[colIdx] = clampColumnWidth(val);
    }
  }

  return {
    order,
    hidden: Array.from(hiddenSet),
    pinned,
    widths,
  };
}

export function getOrderedDisplayColumns(view: ColumnViewState): {
  pinnedOrdered: number[];
  unpinnedOrdered: number[];
  allVisibleOrdered: number[];
} {
  const hiddenSet = new Set(view.hidden);
  const pinnedSet = new Set(view.pinned);

  const pinnedOrdered: number[] = [];
  const unpinnedOrdered: number[] = [];

  for (const colIdx of view.order) {
    if (hiddenSet.has(colIdx)) continue;
    if (pinnedSet.has(colIdx)) pinnedOrdered.push(colIdx);
    else unpinnedOrdered.push(colIdx);
  }

  return {
    pinnedOrdered,
    unpinnedOrdered,
    allVisibleOrdered: [...pinnedOrdered, ...unpinnedOrdered],
  };
}

export function getVisibleColumnsPlan(params: {
  view: ColumnViewState;
  colWidths: number[];
  viewportWidth: number;
  rowNumWidth: number;
}): VisibleColumnPlan {
  const {view, colWidths, viewportWidth, rowNumWidth} = params;
  const {pinnedOrdered, unpinnedOrdered, allVisibleOrdered} =
    getOrderedDisplayColumns(view);

  const safeViewport = Math.max(320, viewportWidth || 720);
  const maxStickyBudget = Math.max(
    140,
    safeViewport - rowNumWidth - MIN_UNPINNED_VIEWPORT_TAIL_PX
  );

  const pinnedCols: number[] = [];
  const downgradedCols: number[] = [];
  const pinnedLeftOffsets: Record<number, number> = {};
  let stickyWidth = 0;

  for (let i = 0; i < pinnedOrdered.length; i++) {
    const colIdx = pinnedOrdered[i];
    const w = colWidths[colIdx] ?? DEFAULT_COL_WIDTH;
    // Always allow at least 0 pinned cols if even the 1st pinned col exceeds narrow screen?
    // Wait: allow 1st pinned column if at least 120px scrollable tail remains, else downgrade all
    const remainingTail = safeViewport - (rowNumWidth + stickyWidth + w);
    const fitsBudget = stickyWidth + w <= maxStickyBudget;
    const isSingleAndUsable = pinnedCols.length === 0 && remainingTail >= 110;

    if (fitsBudget || isSingleAndUsable) {
      pinnedLeftOffsets[colIdx] = rowNumWidth + stickyWidth;
      stickyWidth += w;
      pinnedCols.push(colIdx);
    } else {
      downgradedCols.push(colIdx);
    }
  }

  return {
    visibleCols: allVisibleOrdered,
    pinnedCols,
    unpinnedCols: [...downgradedCols, ...unpinnedOrdered],
    pinnedLeftOffsets,
    pinnedTotalWidth: stickyWidth,
    downgradedPinCount: downgradedCols.length,
  };
}

export function setColumnWidthInView(
  view: ColumnViewState,
  sourceColIndex: number,
  width: number
): ColumnViewState {
  const clamped = clampColumnWidth(width);
  if (view.widths[sourceColIndex] === clamped) return view;
  return {
    ...view,
    widths: {
      ...view.widths,
      [sourceColIndex]: clamped,
    },
  };
}

export function toggleColumnPinInView(
  view: ColumnViewState,
  sourceColIndex: number
): ColumnViewState {
  const exists = view.pinned.includes(sourceColIndex);
  const pinned = exists
    ? view.pinned.filter((c) => c !== sourceColIndex)
    : [...view.pinned, sourceColIndex];

  // Ensure a newly pinned column is visible
  const hidden = exists
    ? view.hidden
    : view.hidden.filter((c) => c !== sourceColIndex);

  return {
    ...view,
    hidden,
    pinned,
  };
}

export function toggleColumnVisibilityInView(
  view: ColumnViewState,
  sourceColIndex: number
): ColumnViewState {
  const totalCols = view.order.length;
  const isHidden = view.hidden.includes(sourceColIndex);

  if (isHidden) {
    return {
      ...view,
      hidden: view.hidden.filter((c) => c !== sourceColIndex),
    };
  }

  const visibleCount = totalCols - view.hidden.length;
  if (visibleCount <= 1) {
    return view; // Always keep at least 1 column visible
  }

  return {
    ...view,
    hidden: [...view.hidden, sourceColIndex],
  };
}

export function restoreAllColumnsInView(view: ColumnViewState): ColumnViewState {
  if (view.hidden.length === 0) return view;
  return {
    ...view,
    hidden: [],
  };
}

export function moveColumnVisualInView(
  view: ColumnViewState,
  sourceColIndex: number,
  direction: -1 | 1
): ColumnViewState {
  if (view.hidden.includes(sourceColIndex)) return view;
  const {pinnedOrdered, unpinnedOrdered} = getOrderedDisplayColumns(view);
  const isPinned = view.pinned.includes(sourceColIndex);
  const segment = isPinned ? pinnedOrdered : unpinnedOrdered;
  const posInSeg = segment.indexOf(sourceColIndex);
  if (posInSeg < 0) return view;

  const targetPos = posInSeg + direction;
  if (targetPos < 0 || targetPos >= segment.length) return view;

  const neighborSourceIdx = segment[targetPos];
  const orderIdxA = view.order.indexOf(sourceColIndex);
  const orderIdxB = view.order.indexOf(neighborSourceIdx);
  if (orderIdxA < 0 || orderIdxB < 0) return view;

  const nextOrder = view.order.slice();
  nextOrder[orderIdxA] = neighborSourceIdx;
  nextOrder[orderIdxB] = sourceColIndex;

  return {
    ...view,
    order: nextOrder,
  };
}

export function reconcileColumnViewOnAdd(
  view: ColumnViewState,
  newSourceColIndex: number
): ColumnViewState {
  if (view.order.includes(newSourceColIndex)) return view;
  return {
    ...view,
    order: [...view.order, newSourceColIndex],
  };
}

export function reconcileColumnViewOnDelete(
  view: ColumnViewState,
  deletedSourceColIndex: number,
  nextTotalCols: number
): ColumnViewState {
  const shiftDown = (idx: number): number =>
    idx > deletedSourceColIndex ? idx - 1 : idx;

  const nextOrder: number[] = [];
  for (const idx of view.order) {
    if (idx === deletedSourceColIndex) continue;
    nextOrder.push(shiftDown(idx));
  }

  const nextHidden: number[] = [];
  for (const idx of view.hidden) {
    if (idx === deletedSourceColIndex) continue;
    nextHidden.push(shiftDown(idx));
  }

  const nextPinned: number[] = [];
  for (const idx of view.pinned) {
    if (idx === deletedSourceColIndex) continue;
    nextPinned.push(shiftDown(idx));
  }

  const nextWidths: Record<number, number> = {};
  for (const [k, w] of Object.entries(view.widths)) {
    const colIdx = Number(k);
    if (colIdx === deletedSourceColIndex) continue;
    nextWidths[shiftDown(colIdx)] = w;
  }

  return normalizeColumnViewState(
    {
      order: nextOrder,
      hidden: nextHidden,
      pinned: nextPinned,
      widths: nextWidths,
    },
    nextTotalCols
  );
}
