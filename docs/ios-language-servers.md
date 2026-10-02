# Language servers on iOS

Created: 2026-10-02. Last updated: 2026-10-02.

Device folders support TypeScript, JavaScript, TSX, JSX, JSON, and JSONC without a computer connection. Open a supported file to start its server. The LSP status control supports stopping and restarting it. Disable **iOS Language Servers** in Extensions to turn off the device providers.

TypeScript and JavaScript provide diagnostics, completion, hover, definitions, type definitions, implementations, references, rename, document symbols, and signature help. The server reads the workspace's `tsconfig.json` or `jsconfig.json`, imports, installed type declarations, and unsaved open documents. JSON and JSONC provide diagnostics, completion, hover, and document symbols. JSON schemas resolve from workspace files. Remote schema downloads are unavailable.

`scripts/ios/build-language-servers.mjs` bundles the existing TypeScript and JSON libraries and TypeScript standard declarations into `Resources/language-servers.js` and embeds it in `Sources/LanguageServerBundle.swift`. Swift compiles the script into the native plugin. Both the iOS dev and build commands generate these files. The generated files stay out of Git.

Swift runs each server in a JavaScriptCore context on a serial background queue. `ios_lsp_message` validates the open workspace before forwarding its canonical root to the native plugin. Filesystem callbacks check resolved paths against that root, including symlinks. They expose reads and directory listings. Closing a workspace releases its contexts before releasing folder access. LSP document changes carry unsaved editor text.

Connected computer workspaces use their runtime's existing LSPs. Device providers are registered for local folders. Executable-based desktop servers require a computer runtime.

## Validation

The native server and transport tests run through `bun run test`. `bun run ios:check` builds the frontend and native server bundle, compiles and runs the Foundation filesystem tests, and checks the Rust host on macOS. `bun run ios:simulator` builds the iOS app for simulator checks.

## API references

Use these references when changing the JavaScriptCore context or Rust-to-Swift bridge:

- [Apple JavaScriptCore](https://developer.apple.com/documentation/javascriptcore) describes native JavaScript evaluation.
- [Apple JSContext](https://developer.apple.com/documentation/javascriptcore/jscontext) documents context creation and script evaluation.
- [Tauri mobile plugin development](https://v2.tauri.app/develop/plugins/develop-mobile/) documents Swift commands and `run_mobile_plugin`.
