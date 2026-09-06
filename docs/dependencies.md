# Dependency contract

Resolution captured from pnpm on Node 24.19.0 / Linux arm64. Exact pins and ranges from the Phase 2 specification are retained for installed packages. Native React Native packages remain deferred. `pnpm-lock.yaml` records transitive resolutions.

| Package | Requested | Resolved | Purpose |
| --- | --- | --- | --- |
| @codemirror/autocomplete | ^6.18.7 | 6.20.3 | CodeMirror editing, selections, language and search APIs |
| @codemirror/commands | 6.10.4 | 6.10.4 | CodeMirror editing, selections, language and search APIs |
| @codemirror/lang-css | ^6.3.1 | 6.3.1 | CodeMirror syntax mode |
| @codemirror/lang-html | ^6.4.9 | 6.4.12 | CodeMirror syntax mode |
| @codemirror/lang-javascript | ^6.2.4 | 6.2.5 | CodeMirror syntax mode |
| @codemirror/lang-json | ^6.0.2 | 6.0.2 | CodeMirror syntax mode |
| @codemirror/lang-markdown | ^6.3.4 | 6.5.2 | CodeMirror syntax mode |
| @codemirror/language | 6.12.4 | 6.12.4 | CodeMirror editing, selections, language and search APIs |
| @codemirror/lint | ^6.8.5 | 6.9.7 | CodeMirror editing, selections, language and search APIs |
| @codemirror/search | 6.7.1 | 6.7.1 | CodeMirror editing, selections, language and search APIs |
| @codemirror/state | 6.7.1 | 6.7.1 | CodeMirror editing, selections, language and search APIs |
| @codemirror/view | 6.43.6 | 6.43.6 | CodeMirror editing, selections, language and search APIs |
| @lezer/highlight | ^1.2.1 | 1.2.3 | Theme-aware syntax highlighting |
| @playwright/test | ^1.55.0 | 1.63.0 | Independent browser sessions and visual/performance evidence |
| @types/markdown-it | ^10.0.3 | 10.0.3 | Type declarations |
| @types/node | ^24.3.0 | 24.13.3 | Type declarations |
| @types/react | ^19.1.13 | 19.2.18 | Type declarations |
| @types/react-dom | ^19.1.9 | 19.2.7 | Type declarations |
| @types/semver | ^7.7.1 | 7.8.0 | Type declarations |
| @types/ws | ^8.18.1 | 8.18.1 | Type declarations |
| @vitejs/plugin-react | ^5.0.3 | 5.2.0 | React JSX transform |
| @xterm/addon-clipboard | ^0.3.0-beta.213 | 0.3.0-beta.303 | Terminal rendering and clipboard support |
| @xterm/addon-fit | ^0.12.0-beta.213 | 0.12.0-beta.301 | Terminal rendering and fit support |
| @xterm/addon-image | ^0.10.0-beta.213 | 0.10.0-beta.301 | Terminal rendering and image support |
| @xterm/addon-ligatures | ^0.11.0-beta.213 | 0.11.0-beta.213 | Terminal rendering and ligatures support |
| @xterm/addon-search | ^0.17.0-beta.213 | 0.17.0-beta.301 | Terminal rendering and search support |
| @xterm/addon-unicode11 | ^0.10.0-beta.213 | 0.10.0-beta.301 | Terminal rendering and unicode11 support |
| @xterm/addon-web-links | ^0.13.0-beta.213 | 0.13.0-beta.301 | Terminal rendering and web-links support |
| @xterm/addon-webgl | ^0.20.0-beta.212 | 0.20.0-beta.300 | Terminal rendering and webgl support |
| @xterm/xterm | ^6.1.0-beta.213 | 6.1.0-beta.304 | Terminal rendering and @xterm/xterm support |
| chokidar | ^4.0.3 | 4.0.3 | Runtime file watching |
| dompurify | ^3.2.7 | 3.4.15 | Sanitize rendered Markdown |
| eslint | ^9.35.0 | 9.39.5 | Static lint checks |
| htmlparser2 | ^12.0.0 | 12.0.0 | Rendered HTML parsing |
| i18next | ^26.3.0 | 26.4.2 | Locale resources |
| lightningcss | 1.30.1 | 1.30.1 | Production CSS transform |
| markdown-it | ^10.0.0 | 10.0.0 | Markdown parsing |
| node-pty | ^1.1.0 | 1.1.0 | Real terminal PTYs |
| prettier | ^3.6.2 | 3.9.6 | Language-specific formatting |
| react | 19.1.0 | 19.1.0 | React workbench and extension views |
| react-dom | 19.1.0 | 19.1.0 | Browser rendering |
| react-i18next | ^17.0.8 | 17.0.13 | React localization binding |
| semver | ^7.7.2 | 7.8.5 | SDK and extension compatibility ranges |
| tsx | ^4.20.5 | 4.23.13 | Development runtime TypeScript execution |
| typescript | ^5.9.3 | 5.9.3 | Project references, runtime language service and browser formatter |
| typescript-eslint | ^8.42.0 | 8.69.0 | TypeScript-aware lint rules |
| typescript-language-server | ^5.0.0 | 5.3.0 | TypeScript/JavaScript LSP provider |
| vite | ^7.1.5 | 7.3.6 | Browser and runtime production builds |
| vitest | ^3.2.4 | 3.2.7 | Unit and real runtime integration tests |
| vscode-jsonrpc | ^8.2.1 | 8.2.1 | LSP transport compatibility target |
| ws | ^8.20.0 | 8.21.3 | Authenticated runtime WebSocket server |
| y-codemirror.next | ^0.3.5 | 0.3.6 | CodeMirror collaborative binding and local undo |
| y-protocols | ^1.0.6 | 1.0.7 | Participant awareness protocol |
| yjs | ^13.6.27 | 13.6.32 | Shared text CRDT |

`node-pty` built from source because the installed release has no Linux arm64 prebuild for this environment. Optional xterm GPU rendering falls back after WebGL context loss. Node process, filesystem, Git and server transport dependencies are confined to apps/runtime. Browser code uses the native WebSocket API.

The requested `@xterm/addon-ligatures` range remains `^0.11.0-beta.213`. A pnpm resolution override selects `0.11.0-beta.213`: beta.301 imports `node:diagnostics_channel` and fails Vite's browser build. The selected beta.213 artifact has no such import and builds with the resolved xterm release. Instrument Sans and JetBrains Mono are self-hosted under `apps/web/public/fonts` with their OFL license files.
