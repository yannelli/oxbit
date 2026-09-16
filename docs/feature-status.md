# Features and limits

Oxbit supports browser workspaces, a Node runtime, desktop apps, and iOS. Runtime workspaces add terminals, tasks, Git, language servers, and shared editing. Tool execution requires workspace trust.

| Feature | Guide | Limits |
| --- | --- | --- |
| Files, saves, drafts and layout recovery | [Documents and recovery](persistence.md) | Browser directory access depends on browser support and permissions. External edits can race a browser directory write. |
| Language services | [Language support](language-support.md) | Managed servers require a trusted runtime. No production browser worker server is bundled. |
| Search and replace | [Documents and recovery](persistence.md) | Replacement previews check document versions and apply to unsaved buffers. Failures are reported per file. |
| Terminals, tasks and services | [Tasks](tasks.md) | Runtime restarts end running processes. Commands are not replayed automatically. |
| Git | [Source Control](source-control.md) | Uses the runtime's Git installation and credentials. No interactive rebase editor, force push, or pull-request UI. |
| Shared editing | [Runtime](runtime.md) | Requires an authenticated runtime connection. The runtime saves shared files. |
| Extensions | [SDK](sdk.md) | Trusted JavaScript shares host privileges. No public marketplace. |
| Themes and icons | [Themes](themes/README.md), [icon packs](icon-packs.md) | OS dialogs, branding, and terminal application truecolor output keep their own appearance. |
| Agents | [Agent ACP](agent-acp.md) | Disabled by default. Requires a runtime owner and a configured provider. |
| Desktop and SSH | [Desktop](desktop.md), [Remote SSH](remote-ssh.md) | Desktop targets Apple Silicon macOS 26+ and Ubuntu 24.04+ x64. |
| iPhone and iPad | [iOS](ios.md) | Local files and runtime connections are supported. SSH tunnels and touch drag and drop are not implemented. |

## Verification limits

Browser tests use emulated touch and IME events. Physical-device input, large-workspace performance, and multi-hour editing sessions need separate checks. Native installation, signing, and updates require the platform checks in the desktop and iOS guides.

React Native integration, debugging providers, and certified Paseo compatibility are not implemented. See [architecture](architecture.md) for host boundaries and [security](security.md) for trust boundaries.
