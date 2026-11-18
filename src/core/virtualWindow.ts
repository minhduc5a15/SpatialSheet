import type {
  ColumnVirtualRange,
  VisibleRowsSource,
  VirtualRange,
} from '../types';

export interface RowWindowInput {
  totalRows: number;
  scrollTop: number;
  viewportHeight: number;
  rowHeight: number;
  overscan: number;
}

export function computeRowVirtualWindow(input: RowWindowInput): VirtualRange {
  const {totalRows, scrollTop, viewportHeight, rowHeight, overscan} = input;
  if (totalRows <= 0 || rowHeight <= 0) {
    return {start: 0, end: 0, total: 0, offsetTop: 0, offsetBottom: 0};
  }

  const safeViewport = Math.max(rowHeight, viewportHeight);
  const safeScroll = Math.max(0, scrollTop);

  const rawStart = Math.floor(safeScroll / rowHeight) - overscan;
  const start = Math.max(0, Math.min(totalRows - 1, rawStart));

  const visibleCount = Math.ceil(safeViewport / rowHeight);
  const rawEnd = Math.floor(safeScroll / rowHeight) + visibleCount + overscan;
  const end = Math.max(start, Math.min(totalRows, rawEnd));

  const offsetTop = start * rowHeight;
  const offsetBottom = Math.max(0, (totalRows - end) * rowHeight);

  return {start, end, total: totalRows, offsetTop, offsetBottom};
}

export interface ColumnWindowInput {
  totalCols: number;
  scrollLeft: number;
  viewportWidth: number;
  colWidths: number[];
  fixedLeftWidth: number;
  overscan: number;
  virtualizeThreshold?: number;
}

export function computeColumnVirtualWindow(
  input: ColumnWindowInput
): ColumnVirtualRange {
  const {
    totalCols,
    scrollLeft,
    viewportWidth,
    colWidths,
    fixedLeftWidth,
    overscan,
    virtualizeThreshold = 14,
  } = input;

  if (totalCols <= 0) {
    return {
      start: 0,
      end: 0,
      total: 0,
      leftWidth: 0,
      rightWidth: 0,
      virtualized: false,
    };
  }

  if (totalCols <= virtualizeThreshold) {
    return {
      start: 0,
      end: totalCols,
      total: totalCols,
      leftWidth: 0,
      rightWidth: 0,
      virtualized: false,
    };
  }

  const prefix = new Float64Array(totalCols + 1);
  for (let i = 0; i < totalCols; i++) {
    prefix[i + 1] = prefix[i] + (colWidths[i] ?? 150);
  }
  const totalWidth = prefix[totalCols];
  const visibleLeft = Math.max(0, scrollLeft);
  const visibleRight = visibleLeft + Math.max(200, viewportWidth - fixedLeftWidth);

  let start = 0;
  let lo = 0;
  let hi = totalCols - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (prefix[mid + 1] <= visibleLeft) {
      lo = mid + 1;
    } else {
      start = mid;
      hi = mid - 1;
    }
  }

  let end = totalCols;
  lo = start;
  hi = totalCols - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (prefix[mid] < visibleRight) {
      lo = mid + 1;
    } else {
      end = mid;
      hi = mid - 1;
    }
  }

  start = Math.max(0, start - overscan);
  end = Math.min(totalCols, Math.max(start + 1, end + overscan));

  const leftWidth = prefix[start];
  const rightWidth = Math.max(0, totalWidth - prefix[end]);

  return {
    start,
    end,
    total: totalCols,
    leftWidth,
    rightWidth,
    virtualized: true,
  };
}

export function computeScrollTopForRow(params: {
  displayIndex: number;
  rowHeight: number;
  currentScrollTop: number;
  viewportHeight: number;
  headerHeight: number;
}): number | null {
  const {displayIndex, rowHeight, currentScrollTop, viewportHeight, headerHeight} =
    params;
  if (displayIndex < 0) return null;

  const rowTop = displayIndex * rowHeight;
  const rowBottom = rowTop + rowHeight;
  const usableHeight = Math.max(rowHeight, viewportHeight - headerHeight);

  if (rowTop < currentScrollTop) {
    return rowTop;
  }
  if (rowBottom > currentScrollTop + usableHeight) {
    return Math.max(0, rowBottom - usableHeight);
  }
  return null;
}

export function sampleChartIndices(
  visibleRowIndices: VisibleRowsSource,
  maxPoints = 32
): number[] {
  const len = visibleRowIndices.length;
  if (len === 0 || maxPoints <= 0) return [];
  if (len <= maxPoints) {
    const out = new Array<number>(len);
    for (let i = 0; i < len; i++) {
      out[i] = visibleRowIndices[i];
    }
    return out;
  }

  const out = new Array<number>(maxPoints);
  const step = (len - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i++) {
    out[i] = visibleRowIndices[Math.round(i * step)];
  }
  return out;
}
