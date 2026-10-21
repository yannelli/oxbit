# Follow-ups ledger

Created: 2026-10-21. Last updated: 2026-10-21.

Work parked as "later" with no decision pending. Each PR updates the rows it opens or closes. Format and IDs: [README](README.md).

| ID | Status | Item | Source | Updated |
| --- | --- | --- | --- | --- |
| F-001 | open | Full i18n coverage: route the hardcoded strings in `packages/features/tasks/src/views.tsx`, `packages/features/themes/src/manager.tsx` and the native menus in `apps/desktop/src-tauri/src/main.rs` through `tr()`, add keys to `packages/ui/src/locales/*.json`, and add a lint check for coverage | `packages/ui/src/locales` | 2026-10-21 |
| F-002 | open | Agent session fork works only from the latest message; iOS device folders have no `@` branch diff | `packages/features/agent-acp/src` | 2026-10-21 |
| F-003 | open | The explorer tree and the runtime file watcher do not apply `.gitignore` (quick open and agent `@` search do) | `apps/runtime/src/runtime.ts`, `packages/features/explorer` | 2026-10-21 |
| F-004 | open | Task dialogs use their own `task-dialog-actions` row; iOS Cancel Transfer stays disabled until the first progress update | `packages/features/tasks/src/views.tsx`, `apps/ios/src/ssh-transfer.tsx` | 2026-10-21 |
| F-005 | open | iOS in-app agent: no search fallback on SFTP roots and no `/instructions` command (the CLI TUI has it) | `packages/features/agent-acp/src/local/extensions.ts` | 2026-10-21 |
| F-006 | open | `scripts/release.mjs` `supportedHost` and `apps/runtime/src/cli.ts` leave out Linux arm64 | `scripts/release.mjs` | 2026-10-21 |
| F-007 | open | `docs/ios-language-servers.md` says zsh reports no syntax errors; 48bd05e added them | `docs/ios-language-servers.md` | 2026-10-21 |
| F-008 | open | `git.branchDiff` has no iOS arm while `docs/ios-runtime-parity.md` says "No method gaps" | `docs/ios-runtime-parity.md` | 2026-10-21 |
| F-009 | open | The pgp 0.21.0 crates in the iOS app have no licence notice in `THIRD_PARTY_NOTICES.md` | `THIRD_PARTY_NOTICES.md` | 2026-10-21 |
| F-010 | open | No tests for the Git-over-SSH prompt commands or the forget-disconnect step | `apps/ios/src-tauri/src/ssh` | 2026-10-21 |
| F-011 | open | The per-task loopback listener stays bound after the task stops | `apps/runtime/src` | 2026-10-21 |
| F-012 | open | Record why basedpyright runs in JSContext instead of a WKWebView worker | `docs/ios-language-servers.md` | 2026-10-21 |
| F-013 | open | markdown-it 14 renders `\|` in table code spans and a trailing `*` in linkified URLs differently from 10.0.0 | `package.json` | 2026-10-21 |
