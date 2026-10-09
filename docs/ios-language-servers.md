# Language servers on iOS

Created: 2026-10-02. Last updated: 2026-10-09.

Device folders get language servers without a computer connection. Each server is its own extension under **Extensions**:

| Extension | Server | File types (default) |
| --- | --- | --- |
| `oxbit.language-typescript` | TypeScript language service | `typescript`, `typescriptreact`, `javascript`, `javascriptreact` |
| `oxbit.language-json` | vscode-json-languageservice | `json`, `jsonc` |
| `oxbit.language-yaml` | yaml-language-server | `yaml` (`.yaml`, `.yml`) |
| `oxbit.language-dockerfile` | dockerfile-language-service, dockerfile-utils | `dockerfile` (`Dockerfile`, `*.dockerfile`, `Containerfile`) |
| `oxbit.language-shell` | bash-language-server analyser, tree-sitter-bash, shfmt | `shellscript` (`.sh`, `.bash`, bash/sh/dash/ksh shebangs) |
| `oxbit.language-zsh` | Same bundle as shell, bash grammar | `zsh` (`.zsh`, `.zshrc`, zsh shebang) |
| `oxbit.language-python` | Ruff (Wasm), basedpyright | `python` (`.py`, `.pyi`, python shebangs) |

- TypeScript and JavaScript: diagnostics, completion, hover, definitions, type definitions, implementations, references, rename, document symbols, signature help. Reads `tsconfig.json`/`jsconfig.json`, imports, and installed type declarations.
- JSON: diagnostics, completion, hover, document symbols, formatting, with SchemaStore schemas (see Schemas).
- YAML: diagnostics, completion, hover, document symbols, and formatting (Prettier inside yaml-language-server). Schemas come from SchemaStore catalog associations and `# yaml-language-server: $schema=` modelines. Kubernetes detection is off.
- Dockerfile: diagnostics from dockerfile-utils, completion, hover, document symbols, signature help, and formatting. Image tag completion makes no network requests.
- Bash and sh: syntax errors from the tree-sitter parse, completion (symbols, keywords, builtins), hover, definitions, references, highlights, and document symbols across open documents and up to 500 workspace `.sh`/`.bash`/`.zsh` files scanned once at start. shfmt formats with the bash dialect. ShellCheck is GPL-3.0 and is not included.
- Zsh: the same features with the bash grammar. Syntax errors are not reported, because the bash grammar rejects valid zsh such as `${(f)x}` and `{ cmd }`. shfmt formats with its zsh dialect.
- Python: Ruff diagnostics (default rules E, F, W; `line-length`, `select`, `ignore`, and `extend-select` from `.ruff.toml`, `ruff.toml`, or `[tool.ruff]` in `pyproject.toml` at the workspace root) and Ruff formatting. basedpyright adds type diagnostics, completion, hover, definitions, and signature help with `typeCheckingMode: "standard"`. basedpyright starts on the first opened Python file from a snapshot of the workspace's `.py`/`.pyi` files (8 MB cap). It runs in child JavaScriptCore contexts on the session's virtual machine; diagnostics wait up to 15 s for its first result, then fall back to Ruff alone. An undefined name is reported by both Ruff (F821) and basedpyright.

WebAssembly modules load synchronously (`initSync`, `Language.loadSync`): on a dispatch queue, promises from `WebAssembly.instantiate` did not resolve.

## Settings

**Configure** on an extension opens only that extension's settings.

- `languageServer.<id>.fileTypes`: language IDs or glob patterns. An entry with `*`, `?`, `/`, or a leading `.` is a glob matched against the workspace path (`**/*.yaml.tmpl`, `.clang-format`); other entries are language IDs. The list becomes the transport's `selectors` (`packages/sdk/src/languages.ts` `fileTypesToSelectors`).
- `json.schemaStore.enable`, `yaml.schemaStore.enable`: associate files with SchemaStore catalog schemas.
- `json.schemaDownload.enable`, `yaml.schemaDownload.enable`: download schemas over HTTPS. When off, cached and bundled copies are used. `languageServers.json.settings.json.schemaDownload.enable: false` and the matching `schemaStore` and `yaml` keys from desktop also turn these off.

Workspaces saved with the earlier single **iOS Language Servers** extension (`oxbit.ios-language`) disabled open with every server extension disabled (`migrateIosLanguageState` in `packages/host-ios/src/language.ts`).

On desktop and connected runtimes, each managed server (`typescript`, `json`, `yaml`, `basedpyright`, `ruff`, `bash`, and the others in `apps/runtime/src/managed/catalog.ts`) is also an extension `oxbit.language-<id>`. Disabling one writes `languageServers.<id>.enabled: false`; its file types setting writes `languageServers.<id>.selectors`. Existing `languageServers` settings keep working.

## Bundles

`scripts/ios/build-language-servers.mjs` builds one IIFE bundle per server kind into `apps/ios/src-tauri/gen/apple/assets/language-servers/<kind>.js`, with the Wasm and worker files each kind loads and the bundled schemas. Xcode copies the `assets` folder into the app. The generated folder stays out of Git. Node built-ins resolve to `path-browserify` or empty stubs; any other built-in fails the build.

Sizes on 2026-10-09 (bytes):

| Kind | Script | Other files | Total |
| --- | --- | --- | --- |
| typescript | 6,821,576 | | 6,821,576 |
| json | 159,599 | | 159,599 |
| yaml | 1,179,692 | | 1,179,692 |
| dockerfile | 314,044 | | 314,044 |
| shell | 408,318 | tree-sitter-bash.wasm 1,358,679; web-tree-sitter.wasm 210,415; shfmt.wasm 400,843 | 2,378,255 |
| python | 45,397 | ruff_wasm_bg.wasm 10,924,574; pyright.worker.js 17,982,887 | 28,952,858 |

`assets/language-servers` is 39 MB in the simulator build (196 MB app). `OXBIT_LANGUAGE_SIZES=1 node scripts/ios/build-language-servers.mjs` prints the totals.

## Runtime

Swift (`LanguageServerRuntime.swift`) runs each session in its own JavaScriptCore context on a serial queue and loads only that session's bundle. The context gets timers, a monotonic clock, logging, `resource(name)` for bundled Wasm bytes, and `schema(uri, download, completion)` for JSON schemas. App contexts run without the JIT; WebAssembly runs in the IPInt interpreter. `ios_lsp_message` validates the open workspace; filesystem callbacks check resolved paths against its root, including symlinks. Closing a workspace releases its contexts before releasing folder access.

## Schemas

`SchemaCache.swift` serves schemas to the JSON and YAML servers and mirrors the desktop runtime's `apps/runtime/src/json-schemas.ts`:

- HTTPS only (HTTP upgrades), no credentials or non-default ports, redirects must stay on HTTPS.
- 5 MiB limit; JSON objects or booleans only.
- Cached in `Caches/json-schemas` with a SHA-256 integrity check for 24 hours; offline requests use the stale copy.
- A failed download waits 60 seconds before retrying.
- First launch offline uses the bundled copies in `packages/features/language/schemas/`: a trimmed SchemaStore catalog, `package.json`, `tsconfig.json`, GitHub workflow, and Compose specification schemas (about 940 KB). Kubernetes is not bundled: SchemaStore's Kubernetes schema references a multi-megabyte definitions file.

## Validation

- `bun run test` runs the native server tests (`packages/features/language/src/native/*.test.ts`), the transport and extension tests (`packages/host-ios/src/language.test.ts`), and the desktop extension tests (`packages/features/language/src/managed-extensions.test.ts`).
- `bun run ios:check` builds the bundles, runs the Swift filesystem and schema cache tests, and loads each bundle in JavaScriptCore with `JSC_useJIT=0` (`Tests/LanguageServerBundle/main.swift`). The harness prints load, initialize, first-diagnostics, and completion times per language.
- `tests/ios/language-extensions.spec.ts` covers the Extensions list, migration, Configure, and the file types editor.

Simulator timings (iPhone 17 Pro simulator, iOS 26.5, `JSC_useJIT=0`, cold run after boot, milliseconds since the bundle started loading):

| Language | Load | Initialize | First diagnostics |
| --- | --- | --- | --- |
| TypeScript | 184 | 191 | 1,708 |
| JSON | 5 | 33 | 104 |
| YAML | 123 | 174 | 257 |
| Dockerfile | 11 | 13 | 15 |
| Bash | 19 | 55 | 55 |
| Zsh | 18 | 36 | 39 (no diagnostics by design) |
| Python (Ruff + basedpyright) | 2 | 3 | 7,866 |

In the app with the JIT off, the time from tapping a file to the first underline was 715 ms (YAML), 736 ms (JSON), at most 840 ms (Dockerfile, shell), 2,144 ms (TypeScript), and 8,578 ms (Python). Ruff alone reached first diagnostics in 117 ms on macOS before basedpyright was added; basedpyright's first answer dominates the Python time. Peak memory of the macOS harness with Python loaded was 448 to 624 MB.

## Research

[On-device language research](ios-language-research.md) records the package choices, JIT-less Wasm measurements, and App Store rules.

## API references

- [Apple JavaScriptCore](https://developer.apple.com/documentation/javascriptcore) describes native JavaScript evaluation.
- [Apple JSContext](https://developer.apple.com/documentation/javascriptcore/jscontext) documents context creation and script evaluation.
- [JSVirtualMachine](https://developer.apple.com/documentation/javascriptcore/jsvirtualmachine) documents contexts that share objects.
- [Tauri mobile plugin development](https://v2.tauri.app/develop/plugins/develop-mobile/) documents Swift commands and `run_mobile_plugin`.
