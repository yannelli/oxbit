# Phase 2 feature status

The original-spec audit fixed gaps in provider wiring, lifecycle, recovery, workbench controls, and runtime operations. 123 unit/integration tests and all 19 browser journeys passed. Native directory recovery passes after refresh; the earlier failure was a Chromium 153 browser crash, recorded in [the gap record](../PHASE-2_REMAINING_GAP.md). See [audit changes](phase-2-audit.md) and [acceptance evidence](../evidence/acceptance.md).

## Acceptance outcomes

| # | Implemented scope and owner | Check status |
| --- | --- | --- |
| 1 | Files, saves, drafts, splits and restored layout: `packages/documents`, `packages/host-browser`, `packages/host-runtime`, `packages/workbench`, `packages/features/explorer`, `packages/features/editor`. | Browser storage, real runtime file and OPFS-backed native-handle refresh journeys passed. OS directory-picker UI was not tested. |
| 2 | Real TypeScript language features: `packages/features/language`, `apps/runtime/src/lsp.ts`. Edits check local and server versions separately. | Real server and browser checks passed, including rename, code actions and server-initiated edit acknowledgements. Contributed provider lifecycle tests passed. No production browser worker server is shipped. |
| 3 | Worker/ripgrep search and version-checked replace previews: `packages/features/search`, `packages/documents`, `apps/runtime`. | Worker search, unsaved-buffer replacement, per-file selection and partial-failure checks passed. |
| 4 | Real terminals and tasks with resize, cancel, output replay and process exit state: `packages/features/terminal`, `packages/features/tasks`, `apps/runtime`. | Terminal and task journeys passed. Runtime loss reports ended terminals. |
| 5 | Git status/diffs, stage/unstage, commits, branch checkout, discard, push, clone, auto-fetch and conflict controls: `packages/features/git`, `apps/runtime`. | Real stage/commit/deduplication and local-bare-remote clone/push/fetch/cancellation/checkout checks passed. External network credentials were not tested. |
| 6 | Shared Yjs text, presence, following and per-user undo: `packages/features/collaboration`, `packages/documents`, `apps/runtime/src/collaboration.ts`. The runtime saves shared files. | Two separate browser sessions passed concurrent edits and reconnect/undo checks. |
| 7 | Trusted ESM loading and extension lifecycle: `packages/core`, `packages/features/extensions`, `examples/bundle-inspector`. | URL installation, disablement, failed-activation recovery, lazy commands, installed settings, provider teardown and runtime extension/CSP checks passed. |
| 8 | Save, runtime, language-server and extension failure recovery: document and host packages plus language/extensions features. | Recovery tests passed. A two-minute editing session passed; a multi-hour soak was not run. |
| 9 | Both themes and all reference sizes: `packages/ui`, `packages/workbench`, `packages/features/themes`. Reference files remain under `design/`. | Eight captures and pixel comparisons completed. Strict visual parity is not established; [comparison data](../evidence/visual/comparison.json) records the differences. |

## Other packages

`packages/sdk` and `packages/protocol` define public contracts. `packages/core` owns commands, context, events, save hooks, settings and resource disposal. `apps/runtime` checks grants and workspace trust before tools run. Trusted extensions share host process privileges; see [security.md](security.md).

`packages/features/settings` validates scoped settings and shortcut conflicts. `packages/features/formatters` provides independent Prettier and TypeScript compiler workers; both passed a browser journey with language-scoped selection. `packages/features/previews` sanitizes Markdown and synchronizes scrolling. UI strings use locale resources.

## Evidence and limits

Test coverage includes document/core contracts and real runtime services. Earlier failed logs remain; the final acceptance record identifies check results and counts for the delivered revision.

Unicode, multi-cursor, browser IME commit/cancel and emulated touch checks passed. Real OS IME and physical touch devices were not tested. See [paint and file-switch measurements](../evidence/performance.json) and the [two-minute session](../evidence/sustained-session.json). Targets are 50 ms typing-to-paint and 100 ms cached switching. Large-workspace and physical-device performance are unverified.

React Native, certified Paseo 0.7.0 support, a public marketplace and further debugging/AI providers are deferred. The iOS app covers local files only; its remote runtime and SSH phases are listed in [ios.md](ios.md). Future host checks are in [architecture.md](architecture.md).
