# Source Control expansion — local verification

Verified in this shared checkout on September 7, 2026. Existing unrelated edits were preserved; no repository commits, hosted pushes, or pull requests were created by this implementation task. Git mutations in tests ran in disposable fixture repositories and local bare remotes.

## Delivered

- Changes/History/Branches/Stashes navigation, file filtering, preserved list/tree views, upstream and ahead/behind indicators.
- File and bulk staging/unstaging; reviewed hunk staging/unstaging with stale-patch checks; rename handling; binary/oversized-preview handling.
- Commit composer shared with the global Ctrl/Cmd+Enter command, with duplicate-submission protection.
- Searchable, paginated branch/file history and per-commit file patches; revert and cherry-pick with explicit confirmation.
- Create/switch/rename/delete local branches, track remote branches, merge, add/remove remotes, fetch, publish, targeted push, fast-forward-only pull.
- Stash preview/save/apply/pop/delete with staged-state restoration and stale-entry checks.
- Separate conflict group, ordinary/diff3 resolution, dirty-buffer checks, continue/abort for in-progress Git operations, progress details and cancellation.
- Shared Git SDK types, trusted runtime RPC routing, serialized mutations and durable operation registration.

## Checks

- Source Control/runtime TypeScript builds: `pnpm exec tsc -b packages/features/git apps/runtime` — passed.
- Runtime bundle: `pnpm --filter @oxbit/runtime build` — passed.
- Web bundle: `pnpm --filter @oxbit/web build` — passed, with existing Vite chunk-size/duplicate-sourcemap warnings.
- Scoped lint and the whole-repository lint run — passed.
- Theme surface inventory regenerated and checked; `git diff --check` — passed.
- Full unit-suite rerun: **502 passed, 1 failed**. The failing existing workbench panel-toggle test is part of the concurrent panel-window work noted below.
- Git workflow tests: 12 real-repository scenarios passed; 3 feature diff/conflict tests passed. Existing local-remote tests also passed.
- Browser verification: 4 journeys passed against the built web UI. These covered the two new scenarios in `tests/browser/source-control.spec.ts`, the existing actual-commit/deduplication acceptance case, and the existing branch/list/tree/staging layout case. The latter was copied temporarily with screenshot destinations redirected here to preserve preexisting evidence, then removed.

The runtime tests cover unborn repositories, literal filenames, rename unstaging, unsafe branch-deletion refusal, history search/pagination and initial/renamed/deleted file diffs, hunk/index isolation and stale patches, stash/index/untracked restoration, stale stashes, local publishing/tracking/pulling and divergent-pull refusal, merge continuation/abort, cherry-pick/revert, binary/oversized previews, stash conflicts, and external rebase abort.

## Scope of evidence

Screenshots cover desktop hunk review, history and commit patches, branches/remotes, stash review, merge resolution, phone dark/light layouts, and the existing SCM list/tree layout regression. The phone composer was clicked and keyboard tab navigation verified; screenshots were visually inspected.

Hosted authentication, a fresh native desktop launch, and the complete preexisting browser suite were not exercised. See `docs/source-control.md` for functional scope and current exclusions.

## Shared-workspace validation caveat

A root `pnpm typecheck` and `pnpm build` are currently blocked by concurrent panel-window work outside this change: `packages/workbench/src/controller.ts` reports possibly undefined `patch.panelLayout`, and `apps/desktop/src/main.tsx` imports a not-yet-exported `configurePanelWindows`. The scoped Git/runtime type build and the runtime/web bundles above pass. The latest full unit-suite run also fails the existing `opens missing files in a retryable tab and toggles a panel` assertion at `packages/workbench/src/controller.test.ts:280` (`workbench.state.panel` remains false). These in-progress files were not rewritten to make the root checks pass.
