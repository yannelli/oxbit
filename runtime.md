# Feature gaps: runtime and languages track

Created: 2026-10-02. Last updated: 2026-10-02.

Items 1, 2, 4, 5, and 9 from the [feature gaps index](README.md). Order: 2, 1, 5, 9, 4.

## 1. Debugger

**Current state.** No Debug Adapter Protocol support. `docs/architecture.md` and
`docs/sdk.md` list debugging providers as not implemented. The runtime already
supervises language-server child processes through `apps/runtime/src/lsp-manager.ts`,
frames JSON-RPC with `vscode-jsonrpc` in `apps/runtime/src/lsp.ts`, and installs
pinned binaries through `apps/runtime/src/managed/install.ts`.

**Target.** Breakpoints (plain, conditional, logpoint), stepping, continue and
pause, call stack, scopes and variables, watch expressions, a debug console with
REPL, exception breakpoints, and a launch configuration picker. Managed adapters
for Node (`js-debug`), Python (`debugpy`), Go (`delve`), Rust and C/C++
(`codelldb`), and PHP (`xdebug` via `vscode-php-debug`).

**Design.**

- `packages/sdk/src/debug.ts`: `DebugAdapterDefinition`, `LaunchConfiguration`,
  `DebugSession`, `Breakpoint`, `StackFrame`, `Scope`, `Variable`. Add a `debug`
  contribution kind so extensions can register adapters.
- `apps/runtime/src/dap-manager.ts` mirrors `LanguageServerManager`. One process
  per session, keyed by adapter, root, and configuration fingerprint. Reuses
  `managed/install.ts` for downloads and `owned-processes.ts` for lifecycle. DAP
  messages use the same `vscode-jsonrpc` framing with the DAP header variant.
- `apps/runtime/src/managed/debug-catalog.ts` holds pinned adapter versions and
  integrity hashes in the same layout as `catalog.ts` and `artifacts.lock.json`.
- Protocol: new `debug.*` request and event envelopes in `packages/protocol`.
  Events carry sequence numbers and bounded replay like process output.
- `packages/features/debug`: breakpoint gutter through the existing
  `editorDecoration` contribution, a Run and Debug activity view, call stack and
  variables panels, a watch panel, and a debug console tab in the panel area.
  Breakpoints persist in project `ui.json` recovery state.
- Launch configurations: read `.vscode/launch.json` for compatibility, plus
  `debug.configurations` in the merged settings files. The task supervisor in
  `apps/runtime/src/tasks` runs `preLaunchTask`.
- Trust: adapters run only in trusted runtime workspaces, the same gate as terminals.

**Steps.**

1. SDK types, protocol envelopes, settings schema entries
2. Runtime DAP manager with the Node adapter only, plus an integration test that
   sets a breakpoint in a fixture script and reads a variable
3. Breakpoint gutter, session controls, call stack and variables UI
4. Debug console and watch expressions
5. Remaining managed adapters, one per commit, each with a fixture project in
   `scripts/language/` style smoke coverage
6. `.vscode/launch.json` import and `preLaunchTask`

**Checks.** `pnpm test` for manager and protocol units. A Playwright scenario per
adapter under `tests/browser` that launches, hits a breakpoint, inspects a
variable, and disconnects. Desktop smoke through `pnpm desktop:runtime:test`.

## 2. Language breadth

**Current state.** `apps/runtime/src/managed/catalog.ts` ships thirteen presets:
TypeScript, Marksman, MDX, HTML, Vue, Astro, Dockerfile, Bash, JSON, Taplo,
Intelephense, Laravel, LemMinX. Rust support covers Cargo TOML only. npm
presets install through `managed/npm/package-lock.json`. Binary presets like
Laravel use `artifacts.lock.json` with SHA-256 pins.

**Target.** Managed presets for Rust, Go, Python, C/C++, Java, Kotlin, Ruby, C#,
CSS/SCSS, YAML, Svelte. Each preset has syntax fallback and a file badge. Each
also gets a settings scope and a capability matrix row in `docs/language-support.md`.

**Design.** Each preset is one `preset(...)` entry in `catalog.ts` plus an
installer source. Binary servers pin per-platform artifacts in
`artifacts.lock.json` for macOS arm64 and Linux x64, with Windows x64 added
under item 4.

| Language | Server | Source | Syntax fallback |
| --- | --- | --- | --- |
| Rust | rust-analyzer | GitHub release binary | `@codemirror/lang-rust` |
| Go | gopls | Release binaries built in CI; `go install` at runtime is disallowed | `@codemirror/lang-go` |
| Python | basedpyright | npm | `@codemirror/lang-python` |
| C/C++ | clangd | GitHub release binary | `@codemirror/lang-cpp` |
| Java | jdtls | Eclipse release tarball, bundled JRE | `@codemirror/lang-java` |
| Kotlin | kotlin-language-server | GitHub release, shares the jdtls JRE | legacy mode |
| Ruby | ruby-lsp | Needs a project Ruby; user-provided executable | legacy mode |
| C# | csharp-ls | .NET tool; user-provided executable | legacy mode |
| CSS/SCSS/Less | vscode-css-language-server | npm (`vscode-langservers-extracted`, already installed) | `@codemirror/lang-css` |
| YAML | yaml-language-server | npm, SchemaStore reuse from `json-schemas.ts` | `@codemirror/lang-yaml` |
| Svelte | svelte-language-server | npm, TypeScript companion like Vue | Vue-style composite |

Ruby and C# depend on a project toolchain. Those presets ship with `executable`
unset and a status message that links to the setting, matching how Laravel
reports a missing PHP environment.

**Steps.**

1. CSS, YAML, Python, Svelte: npm-only and lowest risk, one commit each
2. Rust, Go, clangd: binary artifacts with integrity pins, and extend
   `scripts/language/package.ts` to bundle them in CI
3. Java and Kotlin: shared managed JRE artifact first, then both servers
4. Ruby and C#: user-provided executable presets with documented setup
5. Update the capability matrix and the `language-servers.yml` workflow matrix

**Checks.** `pnpm test:language:servers` and
`pnpm exec tsx scripts/language/intelligence.ts` gain one fixture project per
language that asserts completion, hover, go-to-definition, and references
against the real server.

## 4. Windows desktop

**Current state.** `docs/desktop.md` limits desktop to Apple Silicon macOS 26+
and Ubuntu 24.04+ x64. Tauri 2 supports Windows. Blockers are in the runtime:
the PTY addon build, path handling, process signals, and binary artifacts.

**Target.** Windows 11 x64 installer (MSI and NSIS), managed servers and
adapters for Windows, PowerShell and cmd terminals, and CI coverage.

**Design.**

- PTY: `scripts/repair-pty.mjs` builds the terminal addon from source. Windows
  needs the ConPTY backend and a prebuilt binary in the desktop bundle.
- Paths: audit `apps/runtime/src/filesystem.ts`, `projects.ts`, and
  `external-sources.ts` for `path.posix`, leading-slash URI assumptions, and
  case-sensitive canonicalization. Canonical workspace URIs lowercase the
  drive letter and use forward slashes.
- Processes: `process-lifecycle.ts` kill semantics use signals. Add a `taskkill`
  tree-kill path. Task shell selection defaults to PowerShell.
- Artifacts: add `win32-x64` entries to `artifacts.lock.json` for every binary
  preset. npm presets already run through the runtime's Node.
- Daemon: `daemon.ts` writes `daemon.json` under `~/.oxbit`. Use
  `%LOCALAPPDATA%\oxbit` on Windows and named pipes for the private
  parent/child channel where the loopback tunnel is used today.
- SSH connector: Windows as a client host only in the first release.
- Signing: Authenticode through a CI secret, documented alongside
  `MACOS_SIGNING_AND_NOTARIZATION.md`.

**Steps.**

1. Runtime path and process audit with a Windows CI job running `pnpm test`
2. PTY prebuild and terminal smoke on Windows
3. Tauri Windows build in `scripts/desktop/run.mjs` and the release script
4. Artifact matrix for binary presets
5. Installer signing and `docs/desktop.md` update

**Checks.** A `windows-latest` job in the desktop workflow runs `pnpm check`
minus Playwright, then `pnpm desktop:test:installed`. The language-server
workflow matrix gains Windows for each binary preset.

## 5. Test runner

**Current state.** No test discovery or results view. `apps/runtime/src/tasks`
runs commands with output streaming and port allocation.
`docs/project-intelligence.md` already matches test and source filenames.

**Target.** A Tests activity view that lists discovered tests as a tree, gutter
run and debug buttons on each test, a results panel, inline failure messages as
diagnostics, rerun failed, and watch mode.

**Design.**

- `packages/sdk/src/testing.ts`: `TestController`, `TestItem`, `TestRun`,
  `TestMessage`, and a `testController` contribution kind.
- Discovery uses the project intelligence index for file candidates and a
  per-framework parser for test names. First adapters: Vitest and Jest through
  their JSON reporters, then Playwright, pytest, Go test, and cargo test.
- Execution reuses the task supervisor. Each adapter maps a `TestRun` to a task
  definition with a reporter flag, parses the reporter stream into `TestMessage`
  events, and publishes failures through the `diagnostics` contribution.
- Debug a test: the adapter emits a `LaunchConfiguration` for item 1.
- Gutter buttons use `editorDecoration` at the line of each discovered test.

**Steps.**

1. SDK types and a Tests activity view with static tree rendering
2. Vitest adapter end to end: discovery, run, results, inline failures
3. Gutter decorations and rerun failed
4. Jest, Playwright, pytest, Go, cargo adapters
5. Debug-test integration once item 1 lands

**Checks.** Vitest adapter test against this repo's own suite. A Playwright
scenario that runs one failing test in a fixture and asserts the inline
diagnostic.

## 9. Git depth

**Current state.** `docs/source-control.md` lists staging, commits, history,
branches, remotes, stashes, and merge recovery. It excludes interactive rebase,
line-level staging, blame, tag management, force push, and pull requests.
`apps/runtime/src/git.ts` exposes `status`, `diff`, `log`, `show`,
`commitDiff`, `stashes`, `stashDiff`, and `action`.

**Target.** Inline blame and a blame gutter, line-level staging, a merge editor
with a base pane, tags, force push with lease and confirmation, interactive
rebase as a reorderable list, and pull request creation and review for GitHub
and GitLab.

**Design.**

- Blame: `git blame --porcelain` per file, cached by file revision. Render as
  an `editorDecoration` gutter and an inline hover with commit detail from
  `show`.
- Line staging: build a patch from selected lines using the existing hunk
  patch builder and `git apply --cached`.
- Merge editor: a `documentView` contribution for conflicted files with base,
  ours, theirs, and result panes. Accept actions edit the result buffer through
  the revision-safe path.
- Tags: list, create, delete, push.
- Force push: `--force-with-lease` only, with a confirmation dialog that shows
  the remote ref it expects.
- Interactive rebase: generate the todo list in the UI, write it to a temp
  file, and run `git rebase -i` with `GIT_SEQUENCE_EDITOR` set to a script that
  copies that file. Conflicts land in the merge editor.
- Pull requests: a `git.hosting` provider interface with GitHub and GitLab
  implementations using tokens stored in runtime-local credentials. List, open
  diff, comment, approve, create.

**Steps.**

1. Blame gutter and hover
2. Line-level staging
3. Tags and force push with lease
4. Merge editor
5. Interactive rebase
6. Hosting providers and pull request view

**Checks.** Runtime unit tests against temporary repositories for each
operation, matching `git.test.ts`. Playwright scenarios for blame hover, line
staging, and a merge conflict resolution.
