# Phase 2 acceptance evidence

Checked on 2026-09-06 with Node 24.19.0, pnpm 9.15.0 and Chromium
151.0.7922.34 on Linux ARM64. The [original-spec audit](../docs/phase-2-audit.md)
fixed implementation gaps. All 19 browser journeys and 123 unit/integration
tests passed. Native directory recovery failed twice on Chromium 153.0.8010.12;
[the gap record](../PHASE-2_REMAINING_GAP.md) documents that browser crash and
the Playwright pin that closes it.

## Check results

| Check | Result | Evidence |
| --- | --- | --- |
| Dependency installation | Passed, offline install using the existing store | [Install log](audit-install.log), [resolved versions](dependency-resolution.json) |
| Original dependency targets and MIT attribution | Passed: 25 package manifests, 23 installed targets, 16 deferred native dependencies | [Metadata](audit-metadata.json), [license/design artifacts](audit-artifacts.json) |
| Lint | Passed after correction | [Full lint stage](audit-check-corrected.log), [changed files](audit-corrections-lint.log), [browser test correction](audit-browser-correction-lint.log) |
| Type checking | Passed | `tsc -b` in the [production build](audit-build.log) |
| Unit/integration tests | Passed: 123 distinct tests across the recorded runs | [Suite](audit-resume.log), [corrected tests](audit-tests-corrected.log) |
| Runtime, SDK/example and browser production builds | Passed | [Build log](audit-build.log) |
| Browser Node boundary | Passed: 250 source modules, zero findings | [Bundle audit](browser-bundle.json) |
| Browser journeys | Passed: 19 passed | [Passing run](audit-browser-directory-fix.log), [earlier failure](audit-browser.log), [retry](audit-directory-browser.log) |
| Documentation links | Passed before the final result update | [Link check](document-links.json) |

[Structured verification](audit-verification.json) records counts and commands.
The first `pnpm check` stopped on an unused branch-status component; the
component is now mounted. Its next run passed lint and found a group-array
type mismatch. An explicit `Group[]` type fixed it. Type checking then passed.

The first unit run passed 115 tests, failed two tests, and could not collect
four suites. Test imports now use the workspace's source paths. Menu ownership
uses active extensions, and the room-close test discards its dirty document
explicitly. The terminal lifecycle test isolates the browser addon loader;
production builds still resolve the pinned addons. All 11 tests in those six
suites passed after correction; three had passed earlier. Total: 123 distinct
passing tests. Passed suites were not rerun.

Build output records large lazy TypeScript formatter chunks, a 1.78 MB main
JavaScript chunk (560 kB gzip), and duplicate source-map emission warnings for
formatter assets shared by browser and worker builds. No build errors occurred.

## Directory recovery check

The test selects a real origin-private filesystem handle through a picker
stub, saves Latin-1 bytes, keeps an unsaved draft, and refreshes the page. It
now passes: the workspace keeps its `directory:` identity, the draft returns as
`café unsaved`, the file on disk holds the Latin-1 bytes `99 97 102 233`, and
the before-unload confirmation fires.

Two earlier runs lost the browser connection instead. Both messages reported
one event: the Chromium browser process exiting with SIGTRAP when IndexedDB
deserializes an origin-private filesystem handle. Chromium 148 and 151 and
Google Chrome 152 read the same handle; Chrome for Testing 153.0.8010.12
crashes. `@playwright/test` is pinned to `1.62.1`, whose bundled Chromium is
151.0.7922.34. Application code and the test are unchanged.
[The gap record](../PHASE-2_REMAINING_GAP.md) holds the reduced case and the
per-browser results.

Native-handle unit tests passed for encoding hints, binary rename, directory
identity and permission fallback. OS directory-picker interaction was not
tested.

## Nine required outcomes

| Outcome | Result | Evidence scope |
| --- | --- | --- |
| 1. Workspace edits, save, refresh and layout recovery | Passed | Real runtime bytes, failed-save drafts, browser split/Unicode recovery and native-handle refresh recovery passed. |
| 2. Real language intelligence | Passed | TypeScript completion, diagnostics, definition, rename, code actions and server-initiated edit acknowledgements. Contributed provider lifecycle and stale-result checks passed. |
| 3. Search and replace | Passed | Real ripgrep/worker searches, unsaved buffers, revision checks, grouped results and reversible file selection. Partial failures preserve newer buffers. |
| 4. Terminal and tasks | Passed | Real PTY command/resize/replay, task cancellation, exit status, Unicode chunk decoding and SDK terminal events. |
| 5. Git | Passed | Actual staging/commits/deduplication, local-bare-remote clone/push/fetch, cancellation cleanup and protected checkout. |
| 6. Collaboration | Passed | Two independent browser contexts converge after offline edits; per-user undo preserves remote edits. [Left](collaboration-left.png), [right](collaboration-right.png). |
| 7. External SDK extension | Passed | Bundle Inspector loads as external ESM; 15 activation cycles dispose contributions. SDK exports, lazy commands, installed settings and provider teardown have checks. |
| 8. Failure recovery | Passed for tested runtime services | Save, language-server, extension and runtime-loss journeys preserve local edits. Ended PTYs are reported. [Runtime recovery](runtime-recovery.png). |
| 9. Design comparisons | Passed: comparisons captured | Both themes at all four exact dimensions, with no page overflow. Pixel differences are recorded below; strict visual parity is unverified. |

[Browser journeys](../tests/browser/acceptance.spec.ts) use real runtime services
and isolated test workspaces. Added journeys passed actual formatter workers,
Markdown side previews, contributed filesystem ownership, browser IME
commit/cancel, and emulated touch with reduced motion.

## Visual comparisons

All 31 ZIP entries remain byte-identical: [artifact check](audit-artifacts.json).
Original screenshots remain in [the reference](../design/reference/).
[Full-size baselines](../design/baselines/) use the supplied HTML.

| Viewport | Dark changed pixels | Light changed pixels | Captures |
| --- | --- | --- | --- |
| Desktop, 1440 × 900 | 8.28% | 9.58% | [Dark](visual/desktop-dark.png), [light](visual/desktop-light.png) |
| Tablet landscape, 1024 × 768 | 8.17% | 9.25% | [Dark](visual/tablet-landscape-dark.png), [light](visual/tablet-landscape-light.png) |
| Tablet portrait, 768 × 1024 | 9.30% | 10.44% | [Dark](visual/tablet-portrait-dark.png), [light](visual/tablet-portrait-light.png) |
| Phone, 390 × 844 | 19.51% | 21.80% | [Dark](visual/phone-dark.png), [light](visual/phone-light.png) |

[Comparison data](visual/comparison.json) counts pixels whose largest RGB
channel difference exceeds 25. These captures cover the workbench screen.
Manual approval of every designed screen was not run.

## Performance and sustained editing

| Measurement | p95 | Target | Samples |
| --- | --- | --- | --- |
| Keystroke to second animation frame | 32.3 ms | ≤50 ms | 60 |
| Cached file switch to next animation frame | 21.3 ms | ≤100 ms | 30 |

The dataset is the supplied `orbit-dash` fixture: README typing and cached
README/`src/App.tsx` switching. [Performance data](performance.json) records
browser and method. [Hardware](hardware.txt): ARM Neoverse-V3, eight logical
CPUs, 32,981,413,888 bytes RAM. Headless Chromium ran without CPU throttling.
Physical display presentation was not measured.

The [sustained session](sustained-session.json) ran for 120,493 ms and 193
editing/switching rounds, then recovered after refresh. IME testing uses
[Chromium's composition input API](https://chromedevtools.github.io/devtools-protocol/tot/Input/#method-imeSetComposition).
Touch testing uses browser device emulation: [phone capture](touch-phone.png).

## Not run

- Physical-device touch, OS IME candidate windows, screen-reader sessions, Safari and Firefox.
- OS directory-picker interaction and permission restoration on a desktop filesystem.
- Multi-hour soak, large-repository timing and constrained-device performance.
- External-network Git credentials and provider-specific network failure/retry scenarios. Local remote operations passed.
- A production worker-hosted language server. Worker transport and contributed provider contracts have focused tests; the required runtime TypeScript server has real integration coverage.
- Manual approval of every designed screen against the reference.

Native packaging, React Native, certified Paseo 0.7.0 compatibility, marketplace
distribution and further debugging/AI providers remain deferred by the scope.
