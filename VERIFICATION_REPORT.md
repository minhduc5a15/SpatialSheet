# SpatialSheet engineering verification — 2026-11-20

Recommendation: **READY FOR PERFORMANCE BENCHMARKING**, subject to the explicitly unverified hosted-CI and XR-hardware checks below. This is a verification-infrastructure milestone, not a claim that large datasets already meet an interactive-performance budget.

## Infrastructure

- Bun 1.4.5 owns `bun.lock`; no npm lockfile was introduced. A clean install using only the manifest and frozen lockfile succeeded in a fresh temporary directory (128 installed packages), followed by passing unit tests and production build.
- Node 24 is declared for development and CI. Final verification used Node **24.22.3**. The host's original Node 25.9.0 also executed the baseline suite.
- `tsx` **4.23.15** and `@playwright/test` **1.65.1** are exact development dependencies. Test execution downloads no runner.
- `npm run verify` checks application/browser TypeScript, Node unit/integration tests, production build and Chromium tests. Benchmark scripts are independent.
- Playwright owns a Vite server at `127.0.0.1:4173`, uses fresh contexts and two workers, captures failed-test screenshots/traces and attaches browser-error logs. CI retries once. Existing accessible control names and stable source-column/data-role selectors are reused; there are no production test hooks.
- GitHub Actions has separate static/unit/build and Chromium jobs on main pushes and pull requests to main, frozen installs, Bun caching, Linux browser dependencies, timeouts, read-only permissions and artifact uploads. Nothing deploys.

## Test inventory

The 69 Node tests retain the existing CSV/Excel, worker race/recovery, history, profiling, spatial transforms, virtual-window, chart semantics, column persistence and lifecycle coverage. The new structural invariant test checks every deletion position, complete column permutations, valid pinned/hidden indices, widths by original logical column, undo/redo, source sorting/filtering and independent sheets. Existing debounce tests now use a mock clock, worker-completion tests use event-loop completion instead of 25/30 ms races, and store/worker cleanup runs even when assertions fail. The 400 ms aggregation limit moved out of regression tests without removing its correctness assertions.

The Chromium suite covers these workflows:

1. Startup and real-worker CSV import, Unicode, embedded quotes, multiline editor contents, row/column counts, loading completion and exported values.
2. Split pointer drags, minimum pane sizes, double-click default, preset/reload persistence and selected-cell/chart configuration retention.
3. Pin C, hide B, move D before A, resize C, edit source D, undo/redo, exact source CSV order and persisted column layout after reimport.
4. Delete hidden source B after customization; verify C/D data, source-index shifts, pinned metadata and both widths through repeated undo/redo.
5. Keyboard navigation through visible order and pinned boundaries, Tab/Enter commit and Escape cancellation.
6. Horizontal virtualized navigation keeps the focused source cell inside the viewport.
7. 37-column series search, multiple selection, First 5, Clear, Recommended, identifier exclusion, stable toolbar height, exact plotted value and legend labels.
8. Table/Split/Charts/3D visibility, valid WebGL context, selected-cell/chart retention and unique canvas/chart instances.
9. Repeated manager openings, split/column resizing, layout changes, stable populated DOM counts, responsive single-action edit/undo and restored body styles.

Browser component tests exercise real pointer capture and cancellation for Splitter and Grid; Grid modal/RAF/ResizeObserver cleanup; open Column Manager and Series Manager disposal; spatial drawer removal; and active chart tooltip cleanup. The harness imports production components directly and is excluded from production bundling.

## Executed checks

| Command/check | Actual result |
| --- | --- |
| Baseline TypeScript and production build | Passed before application behavior changes |
| Baseline existing Node suite | 68 passed, 0 failed |
| `bun install --frozen-lockfile` with Bun 1.4.5 | Passed in workspace and fresh temporary directory |
| `npm run lint` | Passed; includes browser tests/configuration |
| `npm run test:unit` | 69 passed, 0 failed |
| Clean-install unit suite | 69 passed, 0 failed |
| `npm run build` and clean-install build | Passed; existing >500 kB chunk-size warning remains |
| `npm run verify` under Node 24 | Passed with 69 Node tests and the then-current 15 Chromium tests |
| Final `npm run test:e2e` | **16 passed, 0 failed**, no retries, 39.9 seconds |
| `npm run bench:micro` | Completed all 3 measurements |
| `npm run bench:heavy` | Completed all 3 store dataset sizes |
| `npm run bench:browser:heavy` | 3 passed, 0 failed, including 100,000 × 100 |
| GitHub Actions hosted run | **NOT VERIFIED** — workflow was created locally, not pushed/run on GitHub |
| XR headset/session hardware | **NOT VERIFIED** |

The original `npm run test` failed with `ENOTFOUND registry.npmjs.org` while `npx` tried to download the undeclared runner. Bun 1.3.2 could not read the existing lockfile version. Installing Bun 1.4.5 and declaring the runner resolved those setup problems. The restricted sandbox also blocked the tsx CLI IPC socket; tests ran with `node --import tsx`, and final Node/browser verification ran with normal subprocess/socket access. Sandboxed file-level-only output was not treated as evidence of all individual assertions passing.

The first browser run passed 6/9: three test assumptions were corrected against application contracts (multiline editor versus single-line formula input, two recommended series, and lazy popover DOM population). Subsequent lifecycle tests demonstrated two actual defects before fixes: an open spatial configuration drawer and active chart tooltip remained visible after disposal. Production changes remove overlay-owned nodes and hide/release the chart tooltip. Both regressions subsequently passed. The first heavy browser benchmark encountered a transient detached virtual header; explicit render completion and geometry polling fixed the harness without weakening application assertions.

## Browser and runtime environment

Actual browser: Playwright-managed **headless Chromium 159.0.8154.6**, build v1255. OS: **Ubuntu 24.04.5 LTS**, Linux **7.0.0-43-generic**, x86_64. CPU: **Intel Core i5-10500H @ 2.50 GHz**. Browser viewport: **1440 × 900**. Node **24.22.3**, Bun **1.4.5**. No production API keys were supplied. The normal-browser 3D path created a valid, non-lost WebGL2 context; headset/XR sessions were not invoked.

## Measured performance foundation

These are local observations, not CI budgets. Browser results came from one sequential run with one browser worker. Initial render measures navigation to visible grid controls; import measures file upload through ready metadata/loading state and visible first cell. Interaction values are medians of five command-to-two-animation-frame samples, including Playwright protocol overhead and pointer steps. They are not sustained FPS or isolated renderer timings.

| Browser dataset | Initial render ms | Import ms | Vertical scroll ms | Horizontal scroll ms | Column resize ms | Split drag ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 × 37 | 510.7 | 71.7 | 159.9 | 166.1 | 221.8 | 200.5 |
| 3,000 × 40 | 417.0 | 294.1 | 173.8 | 154.3 | 274.6 | 233.3 |
| 100,000 × 100 | 409.7 | 7,094.6 | 170.2 | 148.3 | 245.5 | 250.1 |

| Browser dataset | Long Tasks count / total / max ms | Main-isolate JS heap MiB | Live DOM elements | CDP DOM nodes | Canvas / chart instances |
| --- | --- | ---: | ---: | ---: | --- |
| 100 × 37 | 3 / 325 / 117 | 11.1 | 1,431 | 58,157 | 1 / 1 |
| 3,000 × 40 | 5 / 444 / 118 | 18.6 | 1,431 | 58,178 | 1 / 1 |
| 100,000 × 100 | 4 / 5,125 / 3,881 | 264.6 | 1,491 | 58,494 | 1 / 1 |

Long Tasks cover the whole page lifetime, not only import. CDP DOM counts include nodes beyond the connected element tree, and no forced GC was performed. Heap excludes worker and GPU memory. Raw samples, all Long Task durations, heap fields and CDP counters are in [browser-baseline-2026-11-20.json](docs/verification/browser-baseline-2026-11-20.json).

| Store dataset | Initialization ms | View operations + virtualization ms | Delete/undo/redo/undo ms |
| --- | ---: | ---: | ---: |
| 100 × 37 | 10.3 | 1.5 | 24.5 |
| 3,000 × 40 | 60.1 | 0.2 | 170.5 |
| 100,000 × 100 | 247.5 | 0.3 | 609.3 |

Store runs are single samples excluding deterministic generation. Pure-function runs use 3 warmups: visual move (100 columns, 1,000 samples) median **0.00456 ms**, p95 **0.01042 ms**; visible-column plan (100 columns, 1,000 samples) median **0.00330 ms**, p95 **0.00507 ms**; 50,000-row aggregation (20 samples) median **19.58 ms**, p95 **20.12 ms**.

Shared CPU load, browser/software-rendering behavior, Vite compilation/cache state, JIT and GC introduce variability. Large import responsiveness merits follow-up: this run recorded 3,881 ms and 1,045 ms Long Tasks. No performance threshold or FPS claim follows from these measurements.

## Remaining verification limits

- Hosted GitHub Actions and XR hardware are **NOT VERIFIED**.
- Firefox, WebKit, mobile layouts, production hosting and GPU/driver combinations are outside this initial suite.
- No statistically meaningful flake rate has been established. Final runs use no local retries; early test/harness failures are described above.
- Browser heap/canvas/DOM checks do not establish absence of all detached-node or GPU-resource leaks.
- Browser benchmarks currently use the requested Vite server, not a deployed production bundle. Production build compilation itself passed.
- The existing bundle-size warning remains. Large-import Long Tasks are measured performance risks, not concealed test failures.

## Files changed

Infrastructure and documentation:

- `.gitignore`
- `.node-version`
- `package.json`
- `bun.lock`
- `playwright.config.ts`
- `playwright.bench.config.ts`
- `tsconfig.e2e.json`
- `.github/workflows/ci.yml`
- `TESTING.md`
- `VERIFICATION_REPORT.md`
- `docs/verification/browser-baseline-2026-11-20.json`

Browser tests and deterministic fixtures:

- `e2e/helpers.ts`
- `e2e/workflows.spec.ts`
- `e2e/lifecycle.spec.ts`
- `e2e/browser.bench.ts`
- `e2e/fixtures/datasets.ts`
- `e2e/fixtures/identity.csv`
- `e2e/fixtures/unicode.csv`
- `e2e/fixtures/lifecycle.html`
- `e2e/fixtures/lifecycle.ts`

Unit/integration hardening, benchmarks and confirmed fixes:

- `src/core/columnView.test.ts`
- `src/core/hardening.test.ts`
- `src/core/phase1Integration.test.ts`
- `src/core/regression.test.ts`
- `src/core/spatialTransform.test.ts`
- `src/benchmarks/columnBench.ts`
- `src/benchmarks/microBench.ts`
- `src/ui/InteractiveChart2D.ts`
- `src/ui/SpatialInspectorOverlay.ts`

The existing `src/ui/lifecycle.test.ts` is retained unchanged and passes. There are no logo, Store architecture, virtualization, Web Worker or XR feature removals.
