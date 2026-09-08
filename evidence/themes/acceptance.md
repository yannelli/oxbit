# JSON theme pack verification

Implemented and checked in the existing worktree, preserving unrelated work. See [authoring documentation](../../docs/themes/README.md), [token reference](../../docs/themes/tokens.md), [surface inventory](../../docs/theme-coverage.md), and [example pack](../../examples/theme-packs/ink.theme-pack.json).

- 69 scoped tests pass: generated schema/types/validator/fallback CSS agreement, catalog coverage, complete resolution, inheritance/property merges, references, invalid versions/values, safe archives, fonts, notices, persistence failures, multi-session updates, settings precedence/reset, migration and fallback restoration.
- All five built-in JSON packs (15 themes) and the authoring example pass CLI validation.
- Eight Chromium browser scenarios pass: JSON/ZIP import/export, updates and failed updates, enabled/removed packs, profile reload and cross-tab updates; editor identity and content preservation; bold, italic and combined Markdown syntax; selection foreground; custom fonts and font-load failure; theme rendering at desktop/tablet/phone sizes; live terminal ANSI/font changes/history; rendered Markdown, native popover inheritance and keyboard focus. Screenshots are in this folder.
- `pnpm lint`, full `pnpm typecheck`, web production build, and desktop frontend production build pass. Vite reports existing bundle-size warnings.
- `pnpm desktop:check` passes frontend compilation, Cargo checking and nine Rust tests.
- `node scripts/theme-coverage.mjs --check` and `git diff --check` pass.

The import control uses a regular themed button with a hidden file input. File type/size guidance and validation messages are separate; the native “Choose File / No file chosen” control is not visible. The button retains keyboard activation and a 44px minimum height on phone layouts.

## Native verification limit

A fresh native test build was attempted with `pnpm desktop:test:build`. Desktop dependency staging stops at `scripts/desktop/prepare.mjs` with:

> Dependency version collision: vscode-jsonrpc. Extend staging to preserve both versions.

The build cannot reach native application launch, so the active native shell and multiple native windows have not been exercised with this build. The active shell uses the same resolver/typography and subscribes to its session; web multi-session behavior and desktop compilation are verified. The staging failure is recorded in `native-launch-blocker.log` and was not changed as part of the theme work.

## Reproduce

```sh
pnpm themes:generate
pnpm themes:coverage --check
pnpm themes:validate examples/theme-packs/ink.theme-pack.json
pnpm exec vitest run packages/themes packages/features/themes packages/features/settings/src/scopes.test.ts packages/core/src/index.test.ts packages/workbench/src/contributions.test.ts
pnpm lint
pnpm typecheck
pnpm test:themes:browser
pnpm desktop:check
```

The browser suite builds the web client and launches isolated test servers on ports 9289/9290. It creates and removes a temporary runtime workspace; browser contexts use test-only profile storage.
