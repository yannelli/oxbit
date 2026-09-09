# iOS acceptance

Recorded 2026-09-09 for the v1 local-files app in `apps/ios`. Toolchain: macOS 27.0, Xcode 27.0 beta (27A5194q), iOS 27.0 and 26.5 simulator runtimes, Tauri CLI 2.11.4, tauri 2.11.5, Rust 1.97.1, Node 24.16, pnpm 9.15.0. Screenshots are in `evidence/ios/`.

## Simulator checks

| Check | Result |
| --- | --- |
| Debug simulator build (`pnpm ios:simulator`) with the `oxbit-files` Swift plugin | Built; product at `gen/apple/build/arm64-sim/Oxbit.app` |
| First launch on iPhone 17 Pro, iOS 27.0 | Start screen with the Oxbit folder and Open Folder… (`iphone-start-screen.png`) |
| Seeded `session.json` with `last-workspace: documents` and files placed in `Documents/` before launch, iPhone 17, iOS 26.5 | Workspace restored automatically; `README.md` from the Documents directory opened; `workspaces/<id>/ui.json`, `icon-packs-v1/index.json`, and a seeded icon-pack revision written under Application Support (`iphone-documents-workspace.png`) |
| Same seed on iPad Pro 13-inch (M5), iOS 27.0, portrait | Tablet layout with the left activity bar and full status bar; title bar below the status bar (`ipad-documents-workspace.png`) |
| Runtime-connection button and Clone repository without a runtime | Absent on both devices |
| Safe areas | Title bar starts below the status bar and Dynamic Island; bottom tab bar keeps the home-indicator inset |
| UIScene on iOS 27 | Launches with the `TaoSceneDelegate` manifest; crashed at launch without it (`iphone-ios27-spike.png` shows the manifest build) |
| Process log during launch and restore | No errors from the Oxbit process apart from system XPC notices |

## Automated checks

| Command | Result |
| --- | --- |
| `pnpm lint` | Clean |
| `pnpm typecheck` (through `pnpm build`) | Clean |
| `pnpm test` | 677 passed, 1 failed on the first run: `apps/runtime/tests/git-workflows.test.ts` expected commit author `Oxbit Test` and received the identity from the shell's `GIT_AUTHOR_NAME` and `GIT_COMMITTER_NAME` variables, which Git ranks above repo-local config. The test now pins those variables (`git-workflows.test.ts:10`); `pnpm vitest run apps/runtime` then passes 183 tests |
| `pnpm exec vitest run packages/host-ios packages/workbench` | 7 host-ios tests and 38 workbench tests passed, including the key-bar model |
| `pnpm ios:check` (frontend build, `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`) | Clean; 9 Rust tests passed |
| `pnpm test:browser --project webkit-phone` | 5 passed: coarse pointer and phone layout, no HTML5 drag on tabs and rows, long-press context menu, moving touch does not open a menu, key bar hidden without a keyboard |
| `pnpm test:browser --project chromium` for panel-design, panel-docking, explorer, and tooltips specs | 19 passed, 1 failed on the first run: `tooltips.spec.ts:9` waited for a "Toggle sidebar" button that commit 5229eaa renamed to "Toggle left panels". The spec now hovers "Toggle left panels" (`tooltips.spec.ts:15`); the tooltips spec then passes 7 tests |

## Not checked

- Choosing a folder from the Files app, reopening it from a bookmark after a relaunch, and stale-bookmark handling. The picker needs a tap; simulator automation in this session had no touch driver. Verify on a device or in the Simulator by hand.
- Editing, saving, renaming, and deleting through the UI. Covered by Rust unit tests for the filesystem core and by the shared workbench journeys on chromium; not exercised on the simulator.
- Software keyboard behavior, the key bar, and rotation. The key bar model is unit-tested; its appearance depends on the visual viewport shrinking under a real keyboard.
- Physical devices, TestFlight installation, storage after long idle periods, iCloud Drive placeholders.
