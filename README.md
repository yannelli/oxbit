![Oxbit: An open source dev environment that runs anywhere.](apps/web/public/brand/oxbit-github-banner.png)

Oxbit is a code editor built with React and CodeMirror. It runs in a browser,
on macOS and Linux, and on iPhone and iPad. Connect the Node runtime for files,
terminals, Git, tasks, language services, and collaboration.

## Quick start

Install Node 24, Bun 1.4.2, Git, and ripgrep (`rg`). Building the terminal addon
from source also requires Python, make, and a C++ compiler.

```sh
git clone https://github.com/yannelli/oxbit.git
cd oxbit
bun install --frozen-lockfile
bun run install:global
```

This builds the workspace and installs the `oxbit` command:

```sh
oxbit                     # Open the current directory
oxbit ~/code/my-project   # Open a project
oxbit src/main.ts         # Open a file in the current project
```

Oxbit starts a runtime, opens the editor in your browser, and returns to the
shell. Running it again in the same project reuses that runtime.

1. Select **Trust workspace tools** in **Runtime connection** to enable terminals,
   tasks, Git, and language services.
2. Open the command palette with `Ctrl+Shift+P` (`Cmd+Shift+P` on macOS).

The global install links this checkout. Run `bun run build` after pulling changes.
Run `npm uninstall -g oxbit` to remove the command.

| Command | Effect |
| --- | --- |
| `oxbit --status` | Report the runtime serving this workspace |
| `oxbit --stop` | Stop the workspace runtime |
| `oxbit -f` | Keep the runtime attached to the terminal |
| `oxbit --no-open` | Start without opening a browser |
| `oxbit --port 9300` | Choose a port for a new runtime; stop an existing one first |
| `oxbit --help` | Show all options |

The first runtime uses port 9277. Later runtimes choose a free port and record it
in `~/.oxbit/workspaces/<id>/daemon.json`. The printed URL includes a pairing code
in its fragment, which the editor consumes and removes from the address bar.
Opening `http://127.0.0.1:9277` without that fragment loads the browser sample
workspace; use **Runtime connection** to pair it with your project.

Without a global install, run `OXBIT_WORKSPACE=/absolute/path bun run start` after
building. See [runtime configuration](docs/runtime.md) for network hosting,
allowed origins, and storage.

## Native apps

### Desktop

The Tauri desktop app bundles Node, ripgrep, the terminal addon, and managed
language services. It targets Apple Silicon with macOS 26+ and Ubuntu 24.04+ x64.
Run `bun run desktop:dev` for development or `bun run desktop:build` for local installers.
Use `oxbit --desktop [path]` to open an installed app.

**Connect over SSH…** opens a remote folder on Linux x64 or macOS Apple Silicon.
Oxbit installs its headless runtime through SSH; the remote host does not need
Node or npm for the bundled runtime.

See [desktop setup](docs/desktop.md) and [SSH workspaces](docs/remote-ssh.md).

### iOS and iPadOS

The Tauri iOS app runs on iOS 26+. Edit the app's Documents folder or folders
selected through Files. Connect to a runtime on another computer for terminals,
Git, tasks, and language services. Pairing credentials are stored in Keychain.

Run `bun run ios:dev "Oxbit iPhone"` or `bun run ios:simulator` on macOS with Xcode.
See [iOS setup and runtime connections](docs/ios.md).

## Features

- Browser workspaces persist files, settings, layout, and drafts in IndexedDB.
  **Open Workspace** imports or exports workspace JSON.
- **Open directory** uses browser directory access where supported. Runtime
  workspaces read and write files on disk and check revisions before saving.
- The editor includes split views, multiple cursors, find and replace, formatters,
  Markdown and HTML previews, themes, and icon packs.
- Managed language servers provide completion, diagnostics, navigation, and
  formatting in trusted runtime workspaces. See [language support](docs/language-support.md).
- [Source Control](docs/source-control.md) supports staging, commits, history,
  branches, remotes, stashes, and merge recovery.
- [Tasks](docs/tasks.md) imports project commands and runs services, dependencies,
  and worktree lifecycle hooks.
- [JSON settings](docs/settings.md) combine user preferences, private project
  overrides, and optional project configuration files.
- **Share Workspace** creates revocable collaboration grants. Tool trust and
  access grants have separate controls. See [security](docs/security.md).
- [Recovery](docs/persistence.md) preserves drafts and reconnects surviving
  terminals. Commands with uncertain outcomes are not repeated automatically.

## Extensions

Enable **Agent ACP** in Extensions to use Codex ACP, Cursor ACP, or Amp Agent ACP
in a trusted runtime workspace. It includes conversation history, editor context,
permission controls, diff review, and subagent tracking. It is disabled by default.
See [Agent ACP](docs/agent-acp.md) for setup.

[Bundle Inspector](examples/bundle-inspector) demonstrates the public SDK with a
command, panel, setting, status item, output channel, and document view.

```sh
bun run build:example
```

To load the built bundle, remove the existing Bundle Inspector registration in
**Extensions**, then install `/extensions/bundle-inspector.js`. See the
[SDK reference](docs/sdk.md) for extension development.

## Development

Run these commands in separate terminals:

```sh
OXBIT_WORKSPACE=/absolute/path/to/your/project \
OXBIT_ORIGINS=http://localhost:9279,http://127.0.0.1:9279 bun run dev
```

```sh
bun run dev:web
```

Open `http://localhost:9279` and pair with `http://127.0.0.1:9277` using the code
printed by the runtime. Set `OXBIT_WATCH_POLLING=1` if the system exhausts file
watchers.

| Location | Contents |
| --- | --- |
| `apps/web`, `apps/runtime` | Browser application and Node runtime |
| `apps/desktop`, `apps/ios` | Tauri native apps |
| `packages/core`, `packages/sdk`, `packages/protocol` | Coordination, extension contracts, runtime messages |
| `packages/documents`, `packages/host-*` | Shared documents, persistence, host adapters |
| `packages/ui`, `packages/workbench`, `packages/app-workbench` | Components, layout, shared application |
| `packages/features/*` | Editor features |
| `examples/` | Extension and icon-pack examples |

See [architecture](docs/architecture.md), [feature status](docs/feature-status.md),
[dependencies](docs/dependencies.md), and [design assets](design/README.md).

### Checks

```sh
bunx playwright install chromium webkit
bun run check
```

`bun run check` runs lint, TypeScript checks, unit and integration tests, production
builds, and browser tests. Browser tests use port 9278 and temporary workspaces;
they run processes and create Git repositories. Reports and screenshots go into
the ignored `evidence/` directory.

Run individual checks with `bun run lint`, `bun run typecheck`, `bun run test`,
`bun run build`, or `bun run test:browser`. Browser tests require a production build.
Native checks are documented in the desktop and iOS guides.

## Releases

```sh
bun run release patch
bun run release minor
bun run release 2.0.0
bun run release patch --dry-run
bun run release:all
```

The release script updates 8 version files and collects builds in
`release/v<version>/` with a manifest and SHA-256 checksums. Desktop and iOS
builds run when the host has the required platform and toolchain; skipped builds
print a reason. `bun run release:all` runs lint and tests before a patch release.

| Flag | Effect |
| --- | --- |
| `--out <dir>` | Write artifacts to `<dir>/v<version>` |
| `--no-desktop`, `--no-ios` | Skip the selected native build |
| `--check` | Run lint and tests before building |
| `--commit` | Commit the version files after a successful build |
| `--tag` | Also create an annotated `v<version>` tag |
| `--dry-run` | Print the plan without writing files |

`--commit` and `--tag` require a clean working tree. Push a version tag to trigger
the release workflows. See [desktop releases](docs/desktop.md),
[macOS signing](MACOS_SIGNING_AND_NOTARIZATION.md), and [iOS distribution](docs/ios.md)
for signing credentials and platform requirements.

## License

[MIT](LICENSE). Copyright © 2026 Ryan Yannelli.
Bundled fonts and dependencies retain their [third-party licenses](THIRD_PARTY_NOTICES.md).
