# On-device language intelligence research

Created: 2026-10-09. Last updated: 2026-10-09.

Research behind the iOS YAML, Dockerfile, shell, and Python servers in [iOS language servers](ios-language-servers.md). Probes ran on the iOS 18.5 and 26.5 simulators and macOS 27.2 on an M1 Max. Nothing ran on a physical device.

## WebAssembly in a JSContext without the JIT

- WebKit bug 277266 (2024-08-01) added JIT-less entry into WebAssembly, and bug 286390 (2025-01-23) fixed IPInt for that mode. Safari 18.4 (2025-03-31) lists Wasm with the JIT disabled. The JetStream 3 post (2026-03-31) reports IPInt SIMD with the JIT disabled.
- JavaScriptCore `Options.cpp` keeps `useWasm` on when the JIT is off; IPInt is the ARM64 default.
- Measured: the iOS 26.5 simulator with `JSC_useJIT=0`, the iOS 18.5 simulator, and a macOS hardened-runtime binary without `allow-jit` all ran Wasm modules. Apple does not document this behavior. Oxbit's minimum iOS is 26.0.
- A JSContext has no `SharedArrayBuffer`, `URL`, `fetch`, `Worker`, timers, `TextEncoder`, or `console`. `packages/features/language/src/native/prelude.ts` and `LanguageServerRuntime.swift` provide timers, text coding, and logging.

## Measured speed, JIT off and on (M1 Max)

JIT on stands in for a worker inside a WKWebView.

| Workload | JIT off | JIT on |
| --- | --- | --- |
| Ruff check, `argparse.py` (2,786 lines) | 135 ms | 8 ms |
| Ruff format, same file | 141 ms | 20 ms |
| web-tree-sitter parse, `git-completion.bash` (4,021 lines) | 420 ms | 14-23 ms |
| basedpyright initialize | 3.3 s | 0.38 s |
| basedpyright first diagnostics, `argparse.py` | 5.5 s | 0.82 s |
| basedpyright first completion | 3.8 s | 0.37 s |
| basedpyright later completion | about 95 ms | about 70 ms |

## Packages

| Language | Package | Notes |
| --- | --- | --- |
| YAML | `yaml-language-server` 1.24.0 (MIT) | `getLanguageService` runs in a browser context with `path` aliased to `path-browserify`. The service bundles Prettier and Ajv. SchemaStore schemas are Apache-2.0 data. |
| Dockerfile | `dockerfile-language-service` 0.16.1, `dockerfile-utils` 0.16.3 (MIT) | Browser-capable; one Node `https` import fetches Docker Hub tags. |
| Bash, sh, zsh | `bash-language-server` 5.8.1 (MIT), `web-tree-sitter` 0.27.1 (MIT), `@wasm-fmt/shfmt` 0.2.7 (MIT) | The analyser parses with `tree-sitter-bash.wasm` from the package. zsh is in `BASH_DIALECTS` and parses with the bash grammar. Workspace scanning (`fs`, `fast-glob`) and `child_process` calls need replacements. |
| Shell lint | ShellCheck | GPL-3.0; excluded from the app. Wasm builds exist (`@vscode-shellcheck/shellcheck-wasm`, 9.9 MB). |
| Python | `@astral-sh/ruff-wasm-web` 0.16.10 (MIT) | 10.9 MB Wasm with `Workspace.check()` and `format()`; no LSP. |
| Python | `browser-basedpyright` 1.40.2 (MIT) | One 18 MB `pyright.worker.js` with typeshed. Boots with a `browser/boot` message, then LSP over `postMessage`; a background worker starts through `browser/newWorker` and a `MessageChannel`. |
| Python | ty, Pyright, Pyodide + Jedi | ty has no npm Wasm build. Pyright has no official browser build. Pyodide is 9.6 MB Wasm plus 2.5 MB stdlib and was not run in a JSContext. |

## Other iOS editors (2025-2026)

- Code App runs jedi-language-server on bundled CPython and bridges it to Monaco over a localhost WebSocket.
- Pyto and Carnets use Jedi inside embedded CPython. a-Shell uses ios_system and Wasm. Blink Code runs vscode.dev in a WKWebView.
- No shipping app was found running Pyright, clangd, or rust-analyzer on device.

## App Store rules

- Guideline 2.5.2 (updated 2026-06-08) bars downloading, installing, or executing code that changes app features.
- DPLA 3.3.1(B) allows downloaded interpreted code only when it does not change the app's primary purpose.
- Consequence: every server and Wasm module ships in the app bundle. Downloaded JSON schemas are data.

## Sources

- WebKit: [bug 277266](https://bugs.webkit.org/show_bug.cgi?id=277266), [bug 286390](https://bugs.webkit.org/show_bug.cgi?id=286390), [Safari 18.4 features](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/), [JetStream 3](https://webkit.org/blog/17899/introducing-the-jetstream-3-benchmark-suite/), [JavaScriptCore runtime options](https://github.com/WebKit/WebKit/tree/main/Source/JavaScriptCore/runtime)
- YAML: [yaml-language-server](https://github.com/redhat-developer/yaml-language-server), [monaco-yaml](https://github.com/remcohaszing/monaco-yaml), [SchemaStore](https://github.com/SchemaStore/schemastore), [Compose specification schema](https://github.com/compose-spec/compose-go/blob/main/schema/compose-spec.json)
- Dockerfile: [dockerfile-language-service](https://github.com/rcjsuen/dockerfile-language-service)
- Shell: [bash-language-server](https://github.com/bash-lsp/bash-language-server), [wasm-fmt/shfmt](https://github.com/wasm-fmt/shfmt), [shellcheck-wasm](https://github.com/vscode-shellcheck/shellcheck-wasm)
- Python: [browser-basedpyright](https://www.npmjs.com/package/browser-basedpyright), [ruff-wasm-web](https://www.npmjs.com/package/@astral-sh/ruff-wasm-web), [ty](https://astral.sh/blog/ty), [Pyodide lock](https://cdn.jsdelivr.net/npm/pyodide@314.0.7/pyodide-lock.json)
- Editors: [Code App](https://github.com/thebaselab/codeapp), [a-Shell](https://github.com/holzschu/a-shell), [ios_system](https://github.com/holzschu/ios_system), [Blink Code](https://docs.blink.sh/advanced/code)
- Apple: [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/), [Developer Program License Agreement](https://developer.apple.com/support/terms/apple-developer-program-license-agreement/), [WKNavigationDelegate content process termination](https://developer.apple.com/documentation/webkit/wknavigationdelegate/webviewwebcontentprocessdidterminate(_:))
