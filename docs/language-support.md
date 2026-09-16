# Language support

MDX, the official Laravel LSP, automatic JSON Schema discovery/caching and persistent project data are described in [Project intelligence and additional language support](project-intelligence.md). These providers use the same registry and managed-server lifecycle.

## Server configuration and language coverage

The SDK registry resolves user associations before filename patterns, extensions and optional shebangs. Wire IDs use LSP names; existing `tsx` and JavaScript settings remain aliases. Editor syntax, configuration scopes, formatter selection, activation, file badges and language providers use this registry.

`languageServers` is a JSON object keyed by preset ID. Supported options are `enabled`, `selectors`, `rootMarkers`, `executable`, `args`, `env`, `initializationOptions`, `settings`, and `priority`. `files.associations` maps globs to language IDs. Settings use existing user/workspace persistence. The Settings page includes JSON editors and a Language Servers category.

Runtime instances are keyed by definition, nearest project root within the authorized workspace and effective configuration fingerprint. The status indicator lists only providers associated with the current document. Switching files immediately filters the list, even if other projects still have running processes. Relevant stopped providers retain their Start controls; no editor document means an empty list. Matching clients share a process. Manual Stop survives reconnects; unattached instances stop after five minutes. Failed processes require an explicit Retry, preventing repeated requests from causing crash loops. A legacy request without an instance ID still targets the original TypeScript server, including `OXBIT_LSP_COMMAND`.

Managed installations live in `~/.oxbit/language-servers` (or the runtime's `OXBIT_LSP_CACHE`). Downloads use checked-in versions, dependency locks and integrity hashes. Installation uses private staging directories, cross-process locks and atomic rename; earlier version directories remain available. Normal startup invokes the runtime's Node executable or managed binaries directly, without npm, a shell, Homebrew, Cargo or system Java. `scripts/language/package.ts` packages open-source cache trees in CI; Intelephense is acquired directly from its upstream tarballs and excluded from bundle publication.

Optional Intelephense credentials belong in `credentials.json` inside this runtime-local cache: `{"intelephense":"your-key"}`. Never put a key in workspace settings. Free capabilities work without a license key. Server options disable telemetry where supported. Server output is bounded; license material is excluded from status and fingerprints.

Cargo manifests use a checked-in SchemaStore schema; `.cargo/config.toml` and legacy `.cargo/config` use a separate focused configuration schema. `Cargo.lock` is TOML and receives neither manifest association. JSONL validation parses each nonblank record separately. Local providers never evaluate shell or environment contents. Zsh does not receive Bash/ShellCheck diagnostics. Logs only highlight text and link workspace-relative locations.

Source: `packages/sdk/src/languages.ts`, `language-servers.ts`, `apps/runtime/src/lsp-manager.ts`, `managed/`, editor `local-syntax.ts`, language `local.ts`, settings `schema.json`, and language `status.tsx`.

## Capability handling and synchronization

Runtime transport uses `vscode-jsonrpc` with bounded input framing and protocol types. Instances negotiate UTF-16 and open/close, full/incremental changes, save text and will-save behavior. Browser and contributed worker transports support server-initiated requests. Registration and unregistration update selectors and command availability; unsupported registrations fail atomically. Newly registered synchronization replays matching open documents.

Scoped configuration, fixed project workspace folders, prompts, progress, watcher registration and refresh requests are handled. Watcher globs support alternatives, character classes and relative patterns within the authorized root. Filesystem events are serialized with collaborative document updates before reaching attached servers and clients. There is one canonical document stream per attached instance, with per-server diagnostics and document/version/generation checks on asynchronous results. Save notifications follow successful writes; will-save waits are bounded and edits still use the existing revision checks.

Source: `apps/runtime/src/lsp.ts`, `lsp-stream.ts`, `lsp-composite.ts`, `runtime.ts`, SDK `lsp-capabilities.ts`, `lsp-glob.ts`, `text-positions.ts`, and language transport/synchronization code in `packages/features/language/src/index.ts`. Vue owns a matching TypeScript companion, routes bridge requests and merges script features without exposing a second unrelated status entry.

## Completion and signature help

Completion lists/defaults, insert/replace ranges, additional edits, commit characters, snippets, sort/filter order, preselection and incomplete retriggers are handled. Eligible services merge results while retaining their source for resolution and application. Selected-item documentation resolves lazily through the sanitized hover renderer. Edits/provider removal/restarts invalidate outstanding work. Associated advertised commands run only after completion application succeeds.

CodeMirror snippets provide numbered/default placeholders and Tab/Shift+Tab navigation. Signature help is an anchored popup with overload controls, parameter emphasis and documentation. Keyboard Show Hover uses the same renderer as mouse hover; Escape closes the popup and restores editor focus.

Source: `completion.ts`, `popups.ts`, `hover.ts`, `providers.ts` and the completion source in language `index.ts`. Advanced TextMate variable/regular-expression transformations are not a complete TextMate implementation; common LSP placeholder and choice forms are supported.

## Semantic highlighting and inlay hints

Semantic full/delta/range requests follow effective capabilities. Invalid deltas trigger a full refresh; malformed token streams are rejected. Decorations use theme tokens and retain syntax fallback. Viewport hints support resolution, tooltips, label locations and validated text edits. The highest-priority capable service supplies each overlay, and SDK contributions can provide semantic tokens, hints and navigation.

One document session shares cached data across split views. Background requests debounce for 150 ms and discard obsolete results. Semantic highlighting and type/parameter hints default on. Above 1 MiB, full-document semantic requests and hints default off; available streaming syntax remains active. Settings support user, workspace and language scopes:

- `editor.semanticHighlighting`
- `editor.inlayHints.types`
- `editor.inlayHints.parameters`
- `editor.largeFileIntelligence`

Source: `overlays.ts`, `overlays.test.ts`, SDK `language-providers.ts`, editor large-document syntax selection, and settings `schema.json`.

## Navigation and external sources

Declaration, type definition, implementation, references and definitions normalize/deduplicate locations across providers. One result opens directly; multiple results use a reusable results view. Back/forward history includes selections made from the results view. Workspace-symbol searches are cancellable; call/type hierarchy children load lazily. Document highlights, document links and advertised prepareRename are integrated with existing outline and revision-safe editing.

Dependency and SDK sources open in a separate read-only editor. Runtime-issued opaque handles authorize only canonical roots registered by trusted presets. TypeScript SDKs and actual installed dependency trees, including transitive package-store locations, are registered during resolution. Symlink escapes, arbitrary external paths, stale handles and external writes remain rejected. A server response cannot grant filesystem access.

Source: `navigation.tsx`, language navigation commands in `index.ts`, runtime `external-sources.ts`, and `managed/dependencies.ts`.

## Limits and checks

Advanced snippet transforms and a user-facing catalog-update workflow are incomplete. Catalog upgrades arrive with a new application catalog. Startup uses the pinned versions.

Native Ubuntu installed-app behavior, native hover rendering, physical touch and screen-reader input, and collaborative multi-server behavior require separate checks. The capability table below describes advertised operations; it does not establish real-server coverage for every operation.

Run the language checks:

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:language:servers
pnpm exec tsx scripts/language/intelligence.ts
pnpm exec playwright test --config scripts/language/playwright.config.ts
pnpm desktop:prepare
pnpm desktop:runtime:test
node scripts/language/build-native.mjs
pnpm exec wdio run tests/desktop/language.conf.mjs
```

`.github/workflows/language-servers.yml` provides a macOS/Ubuntu server matrix, clean and cached startup, real intelligence checks and reproducible bundles.

## Capability matrix

`A` marks a capability advertised in the pinned server initialization fixture; `-` marks an unadvertised capability. Registrations, project settings, and licenses affect the available operations. Local providers advertise their implemented operations.

| Managed preset | Completion | Signature | Semantic tokens | Inlay hints | Additional advertised navigation |
|---|---|---|---|---|---|
| typescript | A | A | A | A | type definition, implementation, workspace symbols |
| marksman | A | - | A | - | workspace symbols |
| html | A | A | - | - | links |
| vue | A | A | A | A | type definition, implementation, workspace symbols, links |
| astro | A | A | A | A | type definition, implementation, workspace symbols, call hierarchy, links |
| dockerfile | A | A | A | - | links |
| bash | A | - | - | - | workspace symbols |
| json | A | - | - | - | links |
| taplo | A | - | A | - | links |
| intelephense | A | A | - | - | workspace symbols |
| lemminx | - | - | - | - | type definition, links |

| Local files | Implemented intelligence |
|---|---|
| Zsh | Same-document function symbols and builtin completion; no Bash/ShellCheck diagnostics |
| JSONL / NDJSON | Per-nonblank-record JSON diagnostics and completion with mapped offsets |
| INI | Section/key symbols, structural diagnostics and same-document key completion |
| Environment files | Assignment symbols/completion and structural diagnostics; contents are never executed |
| CSV | Quoted-record parsing, column syntax, header symbols/hover and structural diagnostics |
| Logs | Severity/timestamp syntax and workspace-relative location links; no generic diagnostics |

PHP/Intelephense uses the free advertised capabilities as its baseline. Premium operations remain license-dependent and are enabled only when advertised. Cargo support covers TOML manifests, lockfiles and configuration, not Rust. Range/on-type formatting, CodeLens and pull diagnostics remain unsupported even when an upstream server advertises them.

## Upstream references

- [Vue integration](https://github.com/vuejs/language-tools/tree/master/packages/language-server).
- [Astro language server](https://github.com/withastro/astro/tree/main/packages/language-tools/language-server).
- [Taplo schema configuration](https://taplo.tamasfe.dev/configuration/using-schemas.html).
- [LemMinX](https://github.com/eclipse-lemminx/lemminx).

Versions, licenses, artifact sources and integrity values are in `apps/runtime/src/managed/npm/package-lock.json`, `apps/runtime/src/managed/artifacts.lock.json`, and `apps/runtime/src/managed/schemas/sources.json`. Dependency license files are retained inside installed packages. See `apps/runtime/src/managed/NOTICES.md` for direct-provider notices.
