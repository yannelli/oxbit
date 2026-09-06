# Implement the modular web-based code editor

Implement the functional editor represented by the approved interactive mockup and its design handoff.

The deliverable includes the working web application, the supporting runtime required for development-environment features, a public extension SDK, first-party feature packages, and verification evidence.

## Design contract

Read the mockup source, screenshots, design tokens, interaction specification, and extension-surface documentation.

Preserve the approved visual language, layout, density, component states, keyboard behavior, responsive behavior, and interaction flows.

Replace simulated services with working implementations while retaining the approved presentation.

Resolve unspecified details consistently with the design system and document the decision. Do not silently remove designed features or substitute a different workbench layout.

Use the mockup’s fixtures and screenshots as repeatable visual-regression references.

## Product and platform scope

Build a professional, web-first editor with the quality, responsiveness, and interaction coherence established by the design.

Ship the functional web experience in this assignment.

Prepare clean boundaries for:
- Electron hosts on macOS, Windows, and Linux.
- Future iOS and Android hosts.
- Future Paseo 0.7.0 plugin compatibility.
- Standalone and embedded editor usage.

Keep browser rendering, operating-system access, process execution, and host integration behind explicit adapters. Shared application logic and extension contracts should remain independent of a particular host.

Future native packaging and Paseo integration are deferred. Preserve an embeddable editor surface, host-provided themes and layout, and replaceable host services. Document the intended Paseo compatibility direction and the checks required against its exact v0.7.0 SDK before claiming compatibility.

## Dependency guidance

Use the following versions as compatibility targets. Install the packages used by the implementation. Additional dependencies are permitted when they serve a defined requirement.

Verify dependency resolution, peer requirements, runtime support, and production builds. Preserve exact pins and version ranges as supplied below unless a documented incompatibility requires a change.

Keep React Native dependencies in the relevant native or host-integration packages. Keep Node-only dependencies out of browser bundles.

```json
{
  "react": "19.1.0",
  "react-dom": "19.1.0",
  "typescript": "^5.9.3",
  "ws": "^8.20.0",
  "lightningcss": "1.30.1",
  "@codemirror/commands": "6.10.4",
  "@codemirror/language": "6.12.4",
  "@codemirror/search": "6.7.1",
  "@codemirror/state": "6.7.1",
  "@codemirror/view": "6.43.6",
  "markdown-it": "^10.0.0",
  "htmlparser2": "^12.0.0",
  "i18next": "^26.3.0",
  "react-i18next": "^17.0.8",
  "@xterm/addon-clipboard": "^0.3.0-beta.213",
  "@xterm/addon-fit": "^0.12.0-beta.213",
  "@xterm/addon-image": "^0.10.0-beta.213",
  "@xterm/addon-ligatures": "^0.11.0-beta.213",
  "@xterm/addon-search": "^0.17.0-beta.213",
  "@xterm/addon-unicode11": "^0.10.0-beta.213",
  "@xterm/addon-web-links": "^0.13.0-beta.213",
  "@xterm/addon-webgl": "^0.20.0-beta.212",
  "@xterm/xterm": "^6.1.0-beta.213",
  "react-native": "0.81.5",
  "react-native-draggable-flatlist": "^4.0.3",
  "react-native-edge-to-edge": "^1.7.0",
  "react-native-gesture-handler": "~2.28.0",
  "react-native-keyboard-controller": "1.21.12",
  "react-native-markdown-display": "^7.0.2",
  "react-native-nitro-modules": "0.35.5",
  "react-native-reanimated": "4.3.1",
  "react-native-safe-area-context": "~5.6.0",
  "react-native-screens": "~4.16.0",
  "react-native-svg": "^15.14.0",
  "react-native-uitextview": "^2.2.0",
  "react-native-unistyles": "^3.2.4",
  "react-native-web": "~0.21.0",
  "react-native-webview": "^13.16.0",
  "react-native-worklets": "0.8.3"
}
```

## Architecture: a small core and composable features

Keep the core limited to shared contracts and essential coordination: lifecycle, service registration, commands, context, events/hooks, configuration, disposal, and workspace/document identity.

Implement meaningful product features as independently maintainable packages or plugins. This includes the editor integration, explorer, search, language support, terminal, tasks, source control, previews, collaboration, themes, settings UI, and extension-management UI.

Use shared component libraries for visual primitives.

First-party features must consume the same documented extension contracts available to third-party packages. Adding a normal feature should require a package and its registration, without edits to unrelated feature internals.

Make dependencies explicit. Support optional capabilities and meaningful unavailable states when a dependency or host service is absent.

## Extension SDK and lifecycle

Provide a typed, versioned public SDK with documented exports and compatibility rules.

Each extension should declare its identity, version, compatible SDK range, supported environments, dependencies, activation conditions, configuration schema, requested capabilities, and contributions.

Support contributions for:
- Commands, shortcuts, menus, and contextual actions.
- Panels, tabs, toolbars, status items, and custom document views.
- Themes, icons, and settings.
- Languages, diagnostics, completion, formatting, and code actions.
- Filesystem, transport, and other host-service providers.

Define deterministic ordering and conflict behavior for contributed actions and UI.

Support registration, activation, deactivation, disablement, removal, and compatible updates. Lazy activation should follow declared triggers.

Every registration must be disposable. Deactivation must remove UI contributions, release subscriptions, cancel owned work, and clean up resources without deleting user documents or settings.

Handle activation failures and dependency failures with actionable diagnostics and recovery controls. Contain plugin errors at defined runtime boundaries and document the limits of that isolation.

Support loading a trusted external extension from a documented package artifact or development source. A public marketplace is deferred.

Provide an example extension outside the built-in feature implementation that adds a command, panel, setting, and status item using the public SDK.

## Events, hooks, and commands

Use typed, documented contracts with stable identifiers and payloads.

Distinguish informational events from interceptable hooks. Define ordering, asynchronous behavior, cancellation, errors, and disposal.

Include document open/change/save/close, workspace changes, active-editor changes, selection changes, command execution, diagnostics, terminal sessions, connection changes, and extension lifecycle events.

Give save hooks explicit timing, cancellation, and failure behavior. Prevent recursive event loops and duplicate registrations.

Route equivalent actions from shortcuts, menus, toolbars, and the command palette through the same command contract. Context should determine availability and shortcut precedence.

## Documents, files, and workspaces

Provide a shared document model with stable identity, versioned changes, dirty state, selections, undo/redo, and multiple views of the same document.

Keep document state independent of React component mounting. Splitting or closing a view must preserve the underlying document appropriately.

Provide filesystem contracts for listing, reading, writing, creating, renaming, deleting, metadata, and watching.

Ship a usable browser-persisted workspace with import/export, plus a real workspace provider through the supporting runtime. Browser-local filesystem access should use capability detection and an explicit fallback.

Handle external changes, permission failures, save failures, deleted files, and concurrent writes. Detect conflicting changes before overwriting newer content.

Persist workspace layout, open documents, recovery drafts, and settings. Recover unsaved work after refresh or an interrupted session.

Implement the designed workspace search and replace against actual files, including filters, cancellation, replacement previews, and explicit reporting of partial failures.

## Editing and language intelligence

Implement the approved editor behavior with CodeMirror 6, including multiple selections, undo/redo, folding, indentation, search, brackets, shortcuts, tabs, and split views.

Ship syntax support for TypeScript, TSX, JavaScript, JSON, HTML, CSS, and Markdown.

Implement genuine LSP integration through a replaceable transport and server-provider contract. Support browser-worker language servers where suitable and runtime-hosted language servers through the backend boundary.

Handle initialization, capability negotiation, document synchronization, document versions, request cancellation, stale responses, shutdown, server failures, and reconnection.

Implement completion, hover, signature help, definitions, references, rename, diagnostics, formatting, symbols, and code actions where the connected server advertises support.

Apply language-server edits through the shared document model, including multi-file edits and resource operations. Preserve unsaved buffers and reject stale edits safely.

Prove the integration with at least one real TypeScript-capable language server. Syntax highlighting, fixture responses, and mocked diagnostics do not satisfy this requirement.

## Terminal, tasks, Git, and previews

Connect the terminal UI to real PTY-backed sessions through the supporting runtime.

Implement input, output, resizing, scrollback, search, clipboard behavior, Unicode handling, session termination, and the designed reconnect behavior. Bound output buffering and handle slow consumers.

Tasks must run real commands, report status, support cancellation, and expose navigable output.

Implement actual Git status, diffs, staging, unstaging, commits, and the branch operations represented in the approved design. Preserve uncommitted work and surface conflicts or failed operations.

Implement Markdown rendering and preview synchronization. Sanitize untrusted rendered content and apply explicit policies to links and embedded resources.

Keep shell execution, filesystem access, Git operations, and language-server processes in the authorized runtime boundary.

## Real-time behavior and collaboration

Implement live filesystem updates, diagnostic updates, terminal streams, task status, and connection recovery.

Use the browser’s WebSocket API in browser code and the appropriate Node transport in the supporting runtime.

Provide reconnect behavior, cancellation, bounded queues, flow control, and resynchronization. Reconnection must not duplicate non-idempotent operations such as commands or commits.

Implement shared-document collaboration with an established concurrency mechanism, participant presence, and remote selections.

Preserve concurrent edits, maintain per-user undo semantics, and distinguish local persistence from synchronization.

Define how collaboration interacts with disk writes, external file changes, document versions, and LSP synchronization. Use an explicit authority for persisting a shared document.

Verify collaboration across two independent browser sessions connected through the runtime, including simultaneous edits and reconnect recovery.

## Settings, accessibility, and customization

Implement the approved settings and shortcut interfaces with validation, defaults, reset behavior, and documented user/workspace/language precedence.

Persist themes, editor preferences, layouts, and extension configuration.

Externalize interface strings for localization. Preserve keyboard navigation, accessible names, focus restoration, reduced motion, and touch behavior from the mockup.

Expose supported customization through stable settings and extension points.

Reserve documented provider boundaries for future debugging and AI features. Implement additional providers only when included in the approved scope.

## Runtime security and trust

Define and document the trust boundary for workspaces, extensions, processes, and network access.

Authenticate runtime connections and authorize each workspace, terminal, and collaboration operation. Validate origins and incoming messages.

Constrain filesystem access to authorized roots, including traversal and symlink handling. Require appropriate trust before executing workspace tools or extension code.

Keep credentials and privileged operations out of browser bundles.

State which capabilities are technically enforced and which depend on trusted code. Permission declarations alone do not establish isolation.

## Performance and reliability

Keep keystroke processing local and responsive. Avoid rerendering the entire workbench for document changes.

Use incremental updates, lazy loading, virtualization, and background workers where the workload requires them.

Provide defined behavior for large files, large workspaces, slow searches, terminal bursts, disconnected services, and extension failures.

Set reproducible performance targets and record the browser, hardware, dataset, and measurement method. Target p95 keystroke-to-paint latency of 50 ms or less and cached file switching of 100 ms or less on the documented reference environment.

Report observed measurements separately from targets.

Exercise IME composition, Unicode, multiple cursors, repeated plugin activation, document recovery, and long-lived sessions.

## Verification and acceptance

Run type checking, production builds, automated tests, and browser-based checks.

Demonstrate these end-to-end outcomes:

1. Open a real workspace, edit files, save, refresh, and recover the expected content and layout.
2. Use real language-server completion, diagnostics, navigation, rename, and a supported code action.
3. Search and replace across actual files and inspect the resulting changes.
4. Run a real terminal command and task, resize the terminal, and cancel a running task.
5. Inspect and stage Git changes and create a real commit in a test repository.
6. Edit the same document from two browser sessions, disconnect one, reconnect, and verify convergence without lost edits.
7. Load the example extension through the public SDK, disable it, and verify that contributions and owned resources are removed.
8. Simulate runtime, language-server, save, and extension failures and verify recovery without losing local edits.
9. Compare the implementation with the approved screenshots at every reference viewport and in both themes.

Keep mocks available for deterministic tests and design review. Default functional workflows must use real implementations.

For each acceptance item, report passed, failed, or not run. Include commands, results, relevant paths, and captured evidence. Describe remaining limitations precisely.

## Deliverables

Deliver the working source and reproducible launch instructions for both the web application and supporting runtime.

Include:
- Architecture and package-boundary documentation.
- The public SDK reference and example extension.
- Host-adapter and dependency-compatibility notes.
- Persistence, recovery, security, and trust-model documentation.
- Tests, visual comparisons, and measured performance results.
- A feature-status record distinguishing implemented, deferred, and unverified behavior.

Complete the functionality against the approved design. Preserve the design handoff as the reference for subsequent changes.
