# Dependencies

Package manifests declare JavaScript dependencies; `pnpm-lock.yaml` records their resolved versions. Install the checked-in versions with `pnpm install --frozen-lockfile`. The root `package.json` pins pnpm and requires Node 24.

| Component | Main dependencies |
| --- | --- |
| Workbench | React, React DOM, i18next |
| Editor | CodeMirror 6, Lezer |
| Shared documents | Yjs, y-protocols, y-codemirror.next |
| Terminal | xterm.js and its rendering, search, clipboard, and font addons |
| Runtime | ws, chokidar, node-pty, TypeScript Language Server, vscode-jsonrpc |
| Previews and formatting | markdown-it, DOMPurify, Prettier, TypeScript |
| Builds and checks | Vite, TypeScript, ESLint, Vitest, Playwright, WebdriverIO |
| Desktop and iOS | Tauri and the crates recorded in each application's Cargo.lock |

`node-pty` requires native build tools when a prebuilt binary is unavailable. Node filesystem, process, and server transport dependencies stay in the runtime build. Browser code uses the native WebSocket API. xterm falls back from GPU rendering after WebGL context loss.

The root pnpm override pins `@xterm/addon-ligatures` to `0.11.0-beta.213` for browser compatibility. Instrument Sans and JetBrains Mono are self-hosted under `apps/web/public/fonts` with their OFL license files.

Desktop binary versions and checksums are in `scripts/desktop/binaries.json`. Managed language-server versions, artifact sources, and integrity values are in `apps/runtime/src/managed/npm/package-lock.json` and `apps/runtime/src/managed/artifacts.lock.json`. See [language support](language-support.md) for provider notices and [iOS](ios.md#vendored-crates) for the native patches.
