import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SPLIT_RATIO,
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  SPLIT_PRESETS,
  WORKSPACE_PREFS_STORAGE_KEY,
  clampSplitRatio,
  computeSplitPaneWidths,
  computeSplitRatioFromPointer,
  getEffectiveSplitBounds,
  isDesktopSplitViewport,
  loadWorkspaceSplitRatio,
  parseWorkspacePrefs,
  saveWorkspaceSplitRatio,
  type StorageLike,
} from './workspaceLayout';

class MemoryStorage implements StorageLike {
  private data = new Map<string, string>();
  public throwOnGet = false;
  public throwOnSet = false;

  getItem(key: string): string | null {
    if (this.throwOnGet) throw new Error('Storage denied');
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.throwOnSet) throw new Error('Quota exceeded');
    this.data.set(key, value);
  }
}

test('workspace split ratio clamps to min/max ratios and minimum pane pixel widths', () => {
  assert.equal(clampSplitRatio(0.1), MIN_SPLIT_RATIO);
  assert.equal(clampSplitRatio(0.95), MAX_SPLIT_RATIO);
  assert.equal(clampSplitRatio(Number.NaN), DEFAULT_SPLIT_RATIO);

  // At 900px container width with 14px divider (886px usable), 300px min forces ~0.338..0.661
  const bounds = getEffectiveSplitBounds(900, 14, 300);
  assert.ok(bounds.minRatio > 0.33 && bounds.minRatio < 0.35);
  assert.ok(bounds.maxRatio > 0.65 && bounds.maxRatio < 0.67);

  const panes = computeSplitPaneWidths({
    containerWidth: 900,
    splitRatio: 0.1,
    dividerWidth: 14,
    minPanePx: 300,
  });
  assert.ok(panes.leftWidthPx >= 300);
  assert.ok(panes.rightWidthPx >= 300);
  assert.equal(panes.leftWidthPx + panes.rightWidthPx, 886);
});

test('pointer drag calculation maps clientX accurately and clamps cleanly', () => {
  const containerLeft = 20;
  const containerWidth = 1414; // usable = 1400
  const midX = containerLeft + 7 + 700;
  const midRatio = computeSplitRatioFromPointer({
    clientX: midX,
    containerLeft,
    containerWidth,
  });
  assert.ok(Math.abs(midRatio - 0.5) < 0.005);

  const farLeft = computeSplitRatioFromPointer({
    clientX: -50,
    containerLeft,
    containerWidth,
  });
  assert.equal(farLeft, MIN_SPLIT_RATIO);

  const farRight = computeSplitRatioFromPointer({
    clientX: 3000,
    containerLeft,
    containerWidth,
  });
  assert.equal(farRight, MAX_SPLIT_RATIO);
});

test('presets and responsive breakpoint helpers match Phase A contract', () => {
  assert.deepEqual(
    SPLIT_PRESETS.map((p) => p.ratio),
    [0.3, 0.5, 0.7]
  );
  assert.equal(isDesktopSplitViewport(1024), true);
  assert.equal(isDesktopSplitViewport(1440), true);
  assert.equal(isDesktopSplitViewport(1023), false);
  assert.equal(isDesktopSplitViewport(390), false);
});

test('workspace preferences persist safely and reject corrupted payloads', () => {
  const mem = new MemoryStorage();
  assert.equal(loadWorkspaceSplitRatio(mem), DEFAULT_SPLIT_RATIO);

  saveWorkspaceSplitRatio(0.68, mem);
  assert.equal(loadWorkspaceSplitRatio(mem), 0.68);

  // Corrupted JSON or wrong schema version falls back safely
  mem.setItem(WORKSPACE_PREFS_STORAGE_KEY, '{bad json');
  assert.equal(loadWorkspaceSplitRatio(mem), DEFAULT_SPLIT_RATIO);

  mem.setItem(
    WORKSPACE_PREFS_STORAGE_KEY,
    JSON.stringify({version: 99, splitRatio: 0.4})
  );
  assert.equal(loadWorkspaceSplitRatio(mem), DEFAULT_SPLIT_RATIO);

  assert.equal(parseWorkspacePrefs(JSON.stringify({version: 1, splitRatio: '0.5'})), null);

  // Out-of-bounds ratio in valid schema gets clamped
  mem.setItem(
    WORKSPACE_PREFS_STORAGE_KEY,
    JSON.stringify({version: 1, splitRatio: 0.99})
  );
  assert.equal(loadWorkspaceSplitRatio(mem), MAX_SPLIT_RATIO);

  // Storage read/write exceptions never crash
  mem.throwOnGet = true;
  mem.throwOnSet = true;
  assert.equal(loadWorkspaceSplitRatio(mem), DEFAULT_SPLIT_RATIO);
  assert.doesNotThrow(() => saveWorkspaceSplitRatio(0.4, mem));
});
