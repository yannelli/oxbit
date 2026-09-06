# Zapp

A web code editor built with React 19 and CodeMirror 6. Use a browser workspace
on its own, or connect the Node runtime for real files, TypeScript language
services, terminals, tasks, Git, and collaboration.

## Quick start

Install **Node 24**, **pnpm 9.15**, **Git**, and **ripgrep** (`rg`). PTY builds
also need Python, make, and a C++ compiler when a platform prebuild is absent.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
ZAPP_WORKSPACE=/absolute/path/to/your/project pnpm start
```

Open **http://127.0.0.1:4317**. The first launch opens the `orbit-dash` sample
workspace in IndexedDB. To edit the runtime's project:

1. Open **Runtime connection** and enter the owner pairing code printed in the terminal.
2. Connect, then select **Trust workspace tools** to enable terminals, tasks, Git, and language services.
3. Open a file in Explorer. Use the command palette (`Ctrl+Shift+P`, or `Cmd+Shift+P` on macOS) to find actions.

`ZAPP_WORKSPACE` selects the root exposed by this runtime. Stop the server with
`Ctrl+C`. The default host is loopback; [runtime configuration](docs/runtime.md)
covers ports, allowed origins, state storage, and network hosting.

## Workspaces and editing

- **Browser workspace:** files, settings, layout, and recovery drafts persist in
  IndexedDB. Use **Open Workspace** to import or export workspace JSON.
- **Open directory:** uses browser directory access when supported. A persisted
  browser workspace is the fallback. Reselect a directory if its permission expires.
- **Runtime filesystem:** reads and saves real files under the selected root.
  Saves check file revisions; external conflicts preserve local edits for resolution.

The editor supports TypeScript, TSX, JavaScript, JSON, HTML, CSS, and Markdown,
with split views, multiple cursors, find/replace, formatter selection, and
Markdown previews. Settings support user, workspace, and language scopes.
The TypeScript language server needs a connected, trusted runtime.

Runtime features include PTY sessions, cancellable tasks, Git changes and
commits, clone/push/checkout, and authenticated Yjs collaboration. **Share
Workspace** creates revocable grants for another browser session. Grants and
workspace tool trust have separate controls. Trusted extensions and commands
execute with their host's privileges; see [trust and security](docs/security.md).

Unsaved drafts survive refresh and connection loss. Reconnect merges shared
edits and reattaches surviving terminals. After runtime process loss, old
terminals are shown as ended. Uncertain commands and commits are not repeated
automatically. See [persistence and recovery](docs/persistence.md).

## Development

Run these in separate terminals from the repository root:

```sh
# Runtime, with access from the Vite development origin
ZAPP_WORKSPACE=/absolute/path/to/your/project \
ZAPP_ORIGINS=http://localhost:5173,http://127.0.0.1:5173 pnpm dev
```

```sh
# React application with hot reload
pnpm dev:web
```

Open **http://localhost:5173** and pair with runtime URL
**http://127.0.0.1:4317**. On systems that exhaust filesystem watchers, start
the runtime with `ZAPP_WATCH_POLLING=1`. A production build is the fallback
when development process watching also fails.

| Location | Responsibility |
| --- | --- |
| `apps/web`, `apps/runtime` | Browser entry point and authorized Node services |
| `packages/core`, `packages/sdk`, `packages/protocol` | Coordination, public contracts, runtime messages |
| `packages/documents`, `packages/host-*` | Shared documents, persistence, host adapters |
| `packages/ui`, `packages/workbench` | Components, layout, contribution surfaces |
| `packages/features/*` | Independently registered editor features |
| `examples/bundle-inspector` | External SDK extension example |

## Extensions

Bundle Inspector contributes a command, panel, setting, status item, output
channel, and custom document view through the public SDK.

```sh
pnpm build:example
```

This builds `examples/bundle-inspector/dist/bundle-inspector.js` and copies it
to the browser's public extension directory. In **Extensions**, remove the
existing Bundle Inspector registration, then install
`/extensions/bundle-inspector.js`. Disable it to remove its contributions and
release its resources. The production build permits same-origin artifacts;
Vite supports development sources. See [the SDK reference](docs/sdk.md) for
manifests, activation, contributions, updates, and disposal.

## Verification

After installing dependencies, install the browser used by the test suite:

```sh
pnpm exec playwright install chromium
pnpm check
```

`pnpm check` runs lint, TypeScript checks, unit/integration tests, production
builds, and browser journeys. Run a part with `pnpm lint`, `pnpm typecheck`,
`pnpm test`, `pnpm build`, or `pnpm test:browser`. Browser journeys require a
production build and use port 4318 plus isolated temporary workspaces. Tests
run real processes and create Git repositories and commits.

Current results: 123 unit/integration tests and 18 browser journeys passed.
Native directory recovery failed twice during browser refresh; Phase 2
verification remains incomplete. [Remaining gap](PHASE-2_REMAINING_GAP.md)
records the failure, the fix tried, and the checks needed to close it.

[Acceptance evidence](evidence/acceptance.md) records results, screenshots,
performance measurements, and checks that were not run.
[Feature status](docs/feature-status.md) separates implemented features,
verification limits, and deferred work.

## Design and technical references

The original Phase 1 ZIP is preserved under `design/reference/`, including
its HTML and supplied screenshots. Open `Zapp Workbench.dc.html` for the
original mockup. `design/baselines/` adds full-size captures at all four
reference dimensions in both themes.

- [Original Phase 2 requirements](PHASE-2_FULL_IMPLEMENTATION.md) and [audit changes](docs/phase-2-audit.md)
- [Architecture and future host compatibility](docs/architecture.md)
- [Design screens, commands, settings, and ownership](docs/feature-map.md)
- [Dependency versions and compatibility](docs/dependencies.md)
- [Language-server contracts](docs/language.md)

Native packaging, React Native integration, certified Paseo 0.7.0 support,
a public marketplace, and further debugging/AI providers remain deferred.

## License

[MIT](LICENSE). Copyright © 2026 **Ryan Yannelli**
([yannelli](https://github.com/yannelli), <ryanyannelli@gmail.com>).
Bundled fonts and dependencies keep their [third-party licenses](THIRD_PARTY_NOTICES.md).
