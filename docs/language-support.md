# Language support milestones

Implementation order: server configuration, protocol/capabilities, completion/signature help, semantic tokens/inlay hints, navigation. A milestone is complete only when its full gate passes. This document records implementation and evidence separately.

## 1. Server configuration and language coverage

The SDK registry resolves user associations before filename patterns, extensions and optional shebangs. Wire IDs use LSP names; existing `tsx` and JavaScript settings remain aliases. Editor syntax, configuration scopes, formatter selection, activation, file badges and language providers use this registry.

`languageServers` is a JSON object keyed by preset ID. Supported options are `enabled`, `selectors`, `rootMarkers`, `executable`, `args`, `env`, `initializationOptions`, `settings`, and `priority`. `files.associations` maps globs to language IDs. Settings use existing user/workspace persistence. The Settings page includes JSON editors and a Language Servers category.

Runtime instances are keyed by definition, nearest project root within the authorized workspace and effective configuration fingerprint. The status indicator lists only providers associated with the current document. Switching files immediately filters the list, even if other projects still have running processes. Relevant stopped providers retain their Start controls; no editor document means an empty list. Matching clients share a process. Manual Stop survives reconnects; unattached instances stop after five minutes. Failed processes require an explicit Retry, preventing repeated requests from causing crash loops. A legacy request without an instance ID still targets the original TypeScript server, including `OXBIT_LSP_COMMAND`.

Managed installations live in `~/.oxbit/language-servers` (or the runtime's `OXBIT_LSP_CACHE`). Downloads use checked-in versions, dependency locks and integrity hashes. Installation uses private staging directories, cross-process locks and atomic rename; earlier version directories remain available. Normal startup invokes the runtime's Node executable or managed binaries directly, without npm, a shell, Homebrew, Cargo or system Java. `scripts/language/package.ts` packages open-source cache trees in CI; Intelephense is acquired directly from its upstream tarballs and excluded from bundle publication.

Optional Intelephense credentials belong in `credentials.json` inside this runtime-local cache: `{"intelephense":"your-key"}`. Never put a key in workspace settings. Free capabilities are the acceptance baseline. Server options disable telemetry where supported. Server output is bounded; license material is excluded from status and fingerprints.

Cargo manifests use a checked-in SchemaStore schema; `.cargo/config.toml` and legacy `.cargo/config` use a separate focused configuration schema. `Cargo.lock` is TOML and receives neither manifest association. JSONL validation parses each nonblank record separately. Local providers never evaluate shell or environment contents. Zsh does not receive Bash/ShellCheck diagnostics. Logs only highlight text and link workspace-relative locations.

Review entry points: `packages/sdk/src/languages.ts`, `language-servers.ts`, `apps/runtime/src/lsp-manager.ts`, `managed/`, editor `local-syntax.ts`, language `local.ts`, settings `schema.json`, and language `status.tsx`.

## 2. Capability handling and synchronization

Runtime transport uses `vscode-jsonrpc` with bounded input framing and protocol types. Instances negotiate UTF-16 and open/close, full/incremental changes, save text and will-save behavior. Browser and contributed worker transports support server-initiated requests. Registration and unregistration update selectors and command availability; unsupported registrations fail atomically. Newly registered synchronization replays matching open documents.

Scoped configuration, fixed project workspace folders, prompts, progress, watcher registration and refresh requests are handled. Watcher globs support alternatives, character classes and relative patterns within the authorized root. Filesystem events are serialized with collaborative document updates before reaching attached servers and clients. There is one canonical document stream per attached instance, with per-server diagnostics and document/version/generation checks on asynchronous results. Save notifications follow successful writes; will-save waits are bounded and edits still use the existing revision checks.

Review entry points: `apps/runtime/src/lsp.ts`, `lsp-stream.ts`, `lsp-composite.ts`, `runtime.ts`, SDK `lsp-capabilities.ts`, `lsp-glob.ts`, `text-positions.ts`, and language transport/synchronization code in `packages/features/language/src/index.ts`. Vue owns a matching TypeScript companion, routes bridge requests and merges script features without exposing a second unrelated status entry.

## 3. Completion and signature help

Completion lists/defaults, insert/replace ranges, additional edits, commit characters, snippets, sort/filter order, preselection and incomplete retriggers are handled. Eligible services merge results while retaining their source for resolution and application. Selected-item documentation resolves lazily through the sanitized hover renderer. Edits/provider removal/restarts invalidate outstanding work. Associated advertised commands run only after completion application succeeds.

CodeMirror snippets provide numbered/default placeholders and Tab/Shift+Tab navigation. Signature help is an anchored popup with overload controls, parameter emphasis and documentation. Keyboard Show Hover uses the same renderer as mouse hover; Escape closes the popup and restores editor focus.

Review entry points: `completion.ts`, `popups.ts`, `hover.ts`, `providers.ts` and the completion source in language `index.ts`. Advanced TextMate variable/regular-expression transformations are not a complete TextMate implementation; common LSP placeholder and choice forms are supported.

## 4. Semantic highlighting and inlay hints

Semantic full/delta/range requests follow effective capabilities. Invalid deltas trigger a full refresh; malformed token streams are rejected. Decorations use theme tokens and retain syntax fallback. Viewport hints support resolution, tooltips, label locations and validated text edits. The highest-priority capable service supplies each overlay, and SDK contributions can provide semantic tokens, hints and navigation.

One document session shares cached data across split views. A focused regression verifies viewport-only requests for large documents and the explicit opt-in for full requests/hints. Background requests debounce for 150 ms and discard obsolete results. Semantic highlighting and type/parameter hints default on. Above 1 MiB, full-document semantic requests and hints default off; available streaming syntax remains active. Settings support user, workspace and language scopes:

- `editor.semanticHighlighting`
- `editor.inlayHints.types`
- `editor.inlayHints.parameters`
- `editor.largeFileIntelligence`

Review entry points: `overlays.ts`, `overlays.test.ts`, SDK `language-providers.ts`, editor large-document syntax selection, and settings `schema.json`.

## 5. Navigation and external sources

Declaration, type definition, implementation, references and definitions normalize/deduplicate locations across providers. One result opens directly; multiple results use a reusable results view. Back/forward history includes selections made from the results view. Workspace-symbol searches are cancellable; call/type hierarchy children load lazily. Document highlights, document links and advertised prepareRename are integrated with existing outline and revision-safe editing.

Dependency and SDK sources open in a separate read-only editor. Runtime-issued opaque handles authorize only canonical roots registered by trusted presets. TypeScript SDKs and actual installed dependency trees, including transitive package-store locations, are registered during resolution. Symlink escapes, arbitrary external paths, stale handles and external writes remain rejected. A server response cannot grant filesystem access.

Review entry points: `navigation.tsx`, language navigation commands in `index.ts`, runtime `external-sources.ts`, and `managed/dependencies.ts`.

## Verification and gate status

Implementation and gate completion are separate. **The full five-phase acceptance matrix is not marked complete.** Checked-in evidence lives in `evidence/language-milestone1/` (the original evidence directory is retained for stable links).

Verified locally:

- All 11 pinned managed presets install/initialize, answer advertised document-symbol requests and stop on Apple Silicon macOS and Ubuntu 24.04 x64. Ubuntu checks ran under Docker x64 emulation on this Mac, including network-disabled cached startup with `PATH=/nonexistent`.
- Real HTML and JSON-schema completion, PHP free signatures, TypeScript signatures/tokens/type and parameter hints/resolved auto-import edits, Vue bridge completion and resolved auto-import edits, Astro SDK completion, separate Cargo schema associations and read-only TypeScript SDK navigation.
- Deterministic protocol fixtures cover registration/unregistration, scoped configuration, watcher filtering, synchronization variants, Unicode/CRLF changes, save ordering, cancellation and restart replay. Manager fixtures cover instance sharing, root bounds, canonical fanout, persistent Stop and atomic/concurrent/interrupted installation.
- Browser journeys cover current-document filtering, untrusted local support, preserved hover/status controls, phone layout, snippets, overload selection, keyboard hover, malformed-delta recovery, split-view cache reuse, removal of stale overlays, navigation result deduplication, history and lazy hierarchies.
- A packaged macOS runtime passes with read-only resources, a minimal environment, bundled Node/ripgrep/TypeScript, real PTY and process cleanup. A dedicated native WebView test checks local status filtering, real TypeScript overlays, hover geometry and external-source rendering. The embedded driver reports an occluded document, so the test harness supplies timer-backed animation frames; production scheduling is unchanged. Native screenshot capture omits the fixed hover layer, so pixel-level native hover verification remains open.
- Open-source dependency archives produced identical SHA-256 manifests across two packaging runs. Intelephense is excluded from those archives.

Outstanding acceptance work: the full native Ubuntu WebView/installed-app journey, pixel-level native hover verification and CI execution; exhaustive split-view, large-file, touch/screen-reader, collaborative multi-server and restart/removal combinations; real-server navigation fixtures for every applicable preset. Advanced snippet transforms and a user-facing catalog-update workflow remain incomplete. Catalog upgrades currently arrive with a new checked-in application catalog; startup never resolves `latest`.

Reproduce:

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

`.github/workflows/language-servers.yml` provides a macOS/Ubuntu server matrix, clean and cached startup, real intelligence checks and reproducible bundles. An authored workflow is not evidence that CI has run.

## Capability matrix

`A` means the pinned server advertised a feature consumed by this client in the initialization fixture; `—` means it was not advertised there. Registrations, project settings and licenses can change the effective result. This is not a claim that every advertised operation has its own real-server acceptance test. Local providers advertise only their implemented operations.

| Managed preset | Completion | Signature | Semantic tokens | Inlay hints | Additional advertised navigation |
|---|---|---|---|---|---|
| typescript | A | A | A | A | type definition, implementation, workspace symbols |
| marksman | A | — | A | — | workspace symbols |
| html | A | A | — | — | links |
| vue | A | A | A | A | type definition, implementation, workspace symbols, links |
| astro | A | A | A | A | type definition, implementation, workspace symbols, call hierarchy, links |
| dockerfile | A | A | A | — | links |
| bash | A | — | — | — | workspace symbols |
| json | A | — | — | — | links |
| taplo | A | — | A | — | links |
| intelephense | A | A | — | — | workspace symbols |
| lemminx | — | — | — | — | type definition, links |

| Local files | Implemented intelligence |
|---|---|
| Zsh | Same-document function symbols and builtin completion; no Bash/ShellCheck diagnostics |
| JSONL / NDJSON | Per-nonblank-record JSON diagnostics and completion with mapped offsets |
| INI | Section/key symbols, structural diagnostics and same-document key completion |
| Environment files | Assignment symbols/completion and structural diagnostics; contents are never executed |
| CSV | Quoted-record parsing, column syntax, header symbols/hover and structural diagnostics |
| Logs | Severity/timestamp syntax and workspace-relative location links; no generic diagnostics |

PHP/Intelephense uses the free advertised capabilities as its baseline. Premium operations remain license-dependent and are enabled only when advertised; no license was supplied for these checks. Cargo support covers TOML manifests, lockfiles and configuration, not Rust. Range/on-type formatting, CodeLens and pull diagnostics remain outside these milestones even when an upstream server advertises them.

## Upstream references

- [Vue integration](https://github.com/vuejs/language-tools/tree/master/packages/language-server) (bridge behavior is verified against the pinned installed package).
- [Astro language server](https://github.com/withastro/astro/tree/main/packages/language-tools/language-server).
- [Taplo schema configuration](https://taplo.tamasfe.dev/configuration/using-schemas.html).
- [LemMinX](https://github.com/eclipse-lemminx/lemminx).

Versions, licenses, artifact sources and integrity values are in `apps/runtime/src/managed/npm/package-lock.json`, `apps/runtime/src/managed/artifacts.lock.json`, and `apps/runtime/src/managed/schemas/sources.json`. Dependency license files are retained inside installed packages. See `apps/runtime/src/managed/NOTICES.md` for direct-provider notices.
