# Automated verification

Use **Node.js 24 LTS** (`.node-version`) and **Bun 1.4.5**. Bun is the dependency manager; `bun.lock` is the only dependency lockfile. Older Bun releases may not understand its format. npm is used only to invoke scripts, not to install dependencies.

```sh
bun install --frozen-lockfile
bun run playwright install chromium
# Linux CI / machines without browser system libraries:
bun run playwright install --with-deps chromium

npm run lint           # TypeScript: application, tests, browser harnesses, configs
npm run test           # Node unit + integration tests via project-managed tsx
npm run test:e2e        # Actual Chromium, Vite starts and stops automatically
npm run build
npm run verify         # All four checks, stops on the first failure
npm run test:e2e:ui     # Optional interactive Playwright runner
```

The test script uses `node --import tsx --test`, preserving Node's native test runner and avoiding both runner downloads and the tsx CLI's extra IPC socket. Browser installation is a separate setup step tied to the exact pinned Playwright version. No production API keys are needed.

Playwright uses `http://127.0.0.1:4173`, a strict port, two workers, fresh browser contexts, and a 1440 × 900 desktop viewport. A server on that port may be reused locally; CI always owns its server. Run browser benchmarks separately from E2E so they do not compete for the port or CPU. The suite serves an empty Google Fonts stylesheet and uses the application's system font fallbacks to remove a third-party network dependency. Application data processing and Web Workers remain real.

Failures retain screenshots and traces in `test-results/`, and attach console errors and uncaught page exceptions. Successful cases do not take screenshots. CI retries once; traces are retained for every failed attempt, including the initial failure. View the HTML report with `bun run playwright show-report` or a trace with `bun run playwright show-trace <path>`.

## Coverage and data semantics

- CSV import with Unicode, embedded quotes and multiline values, real worker startup, loading completion, and source CSV downloads.
- Pointer-driven split resizing, pane bounds, default reset, presets, localStorage persistence, selected-cell and chart-setting retention.
- Pin/hide/reorder/resize, editing after reordering, undo/redo and source-column deletion with metadata reconciliation.
- Arrow/Tab/Enter/Escape navigation, pinned boundaries, hidden columns and horizontal virtualization.
- A generated 37-column dataset exercises series search, multiple selections, First 5, Clear, Recommended, identifier exclusion, chart labels and exact plotted values.
- Table/Split/Charts/3D transitions, a live WebGL context, bounded canvas/chart counts, repeated interactions and single-action undo.
- Real-browser component disposal during captured pointer drags, queued animation frames, stale ResizeObserver delivery, an open text modal, popovers, tooltip and spatial configuration drawer. The isolated harness imports production components directly and is not part of the production build.
- Existing unit/integration coverage is preserved, with additional column permutations, widths by logical identity, hidden/pinned bounds, source sorting/filtering, structural history and sheet isolation. Debounce uses Node's mock clock; asynchronous completions drain the event loop without arbitrary sleeps.

**CSV export follows source workbook order.** Pinning, hiding and visual reordering do not change exported columns or values. Deleting a column changes source data; undo restores it. Workbook data itself is not persisted by a browser reload. Multiline values are inspected through the full-text editor; the formula bar is a single-line HTML input.

Full XR headset/session behavior is not covered by headless browser tests. Firefox/WebKit, mobile layouts, GPU-driver combinations and production-host behavior are outside this initial Chromium suite.

## Benchmarks

```sh
npm run bench                # Pure functions + small/medium store scenarios
npm run bench:micro          # Warmed functions, median and p95
npm run bench:store          # 100×37 and 3,000×40 store scenarios
npm run bench:heavy          # Also 100,000×100
npm run bench:browser        # Small/medium browser measurements
npm run bench:browser:heavy  # Also 100,000×100; opt-in, memory intensive
```

No elapsed-time threshold gates functional tests. The existing 50,000-row aggregation correctness test retains its group/count/memory-bound assertions; its timing is measured in `microBench.ts`. The existing deterministic 100,000×100 functional virtualization regression remains in the unit suite; only performance runs are opt-in.

Datasets are generated deterministically in memory; large files are never committed. Microbenchmarks run three warmups, then report median/p95 wall time. Store benchmarks report a single initialization, view-operation/virtualization batch and structural-history batch, excluding generation. Browser benchmarks run one cold navigation/import and five samples each for vertical/horizontal wheel scrolling, column resizing and split dragging. Interaction samples include Playwright protocol time, pointer steps and two animation frames: they are **not sustained FPS** or isolated renderer latency.

Browser JSON attachments in `benchmark-results/` include runtime/OS/CPU/browser, dataset dimensions, viewport, raw samples, Long Task durations, CDP heap/DOM counters and canvas/chart counts. Heap covers the main-page isolate, without forced GC; worker/GPU memory is not included. Canvas counts are renderer-instance proxies, not proof of absence of every GPU resource leak. Vite compilation, software rendering, GC, caching and shared-host load affect results. There are no performance gates until a representative baseline and variability budget have been established.

## CI

`.github/workflows/ci.yml` runs on pushes to `main` and pull requests targeting `main`. Independent jobs install Node 24, Bun 1.4.5 and dependencies from the frozen lockfile. One runs type checking, unit/integration tests and build; the other installs Chromium plus Linux libraries and runs E2E. Bun's download cache is keyed by the lockfile; browser binaries are installed for the pinned Playwright release. Failure artifacts are retained for 14 days. Permissions are read-only; no deployment or production credentials are involved.

A locally passing CI-equivalent command is not evidence of a completed GitHub Actions run. Actual hosted CI execution must be checked after these changes reach GitHub.
