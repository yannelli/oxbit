# Architecture

Oxbit runs a React 19 / CodeMirror 6 browser workbench and a Node 24 runtime. The production runtime serves the browser build and an authenticated WebSocket endpoint. Browser workspaces run without that connection and persist in IndexedDB.

| Package | Owns |
| --- | --- |
| `apps/web` | Bootstrap, workspace switching, pairing UI, localization resources |
| `apps/runtime` | Authentication, workspace grants, filesystem, processes, Git, ripgrep, TypeScript language server, shared Yjs rooms |
| `packages/sdk` | Versioned public interfaces, manifests, contributions, host contracts |
| `packages/protocol` | Version 1 runtime envelopes, validation, request/error shapes |
| `packages/core` | Commands, context, settings, services, events, save hooks, extension lifecycle |
| `packages/documents` | Stable document identities, Yjs transactions, revisions, undo, recovery and per-view state |
| `packages/host-browser` | IndexedDB storage, archive import/export, detected browser directory access |
| `packages/host-runtime` | Authenticated browser WebSocket client and runtime filesystem adapter |
| `packages/ui` | Design tokens, icons and accessible primitives |
| `packages/workbench` | Layout, groups, tabs, palettes, menus, notifications and contribution mounting |
| `packages/features/*` | Independently registered editor, explorer, settings, themes, extensions, language, search, previews, formatters, terminal, tasks, Git and collaboration |
| `examples/bundle-inspector` | External SDK extension and installable ESM artifact |

The browser imports public SDK contracts and host adapters. Node filesystem, process, socket-server and PTY dependencies stay in the runtime build. First-party features register through the same ExtensionContext as Bundle Inspector. Shared services are registered by explicit string IDs; disabling an extension disposes its registrations and subscriptions. A component error boundary contains render failures; trusted extension JavaScript shares browser privileges.

A document owns one Y.Doc, Y.Text, saved revision, undo manager and awareness instance. React editor views bind to that text and own their selections and scroll positions. Runtime rooms merge Yjs updates, persist them separately from file saves and maintain the canonical language-server document stream. A shared save waits for pending local updates, then asks the runtime to write the room's text against the expected disk revision.

Runtime requests have IDs and optional cancellation. Process output uses sequence numbers, bounded replay and acknowledgements. Reconnection authenticates, rejoins shared rooms and retrieves operation/session state. The client does not resend an uncertain commit or command execution automatically.

# Host direction

`HostAdapter` separates rendering, persistence, filesystem and runtime transports. `Workbench` accepts a controller and host callbacks, so an embedding host can provide surrounding layout and CSS tokens. An Electron host can supply the runtime boundary and native directory access; a mobile host can implement the same document and persistence contracts.

Native packaging, React Native integration, debugging/AI providers, marketplace distribution and certified Paseo compatibility are deferred. Before claiming Paseo 0.7.0 compatibility, verify its exact SDK exports, lifecycle/disposal rules, contribution surfaces, theme/layout ownership, host permissions, transport behavior, document identity and embedding behavior against a running v0.7.0 host. No Paseo compatibility check has been run.
