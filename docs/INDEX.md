# Documentation index

Created: 2026-10-02. Last updated: 2026-10-10.

| Guide | Use when |
| --- | --- |
| [Agent ACP](agent-acp.md) | Changing agent providers, daemon-hosted sessions, attach and queue behavior, workspace MCP tools, permissions, or review; includes ACP and MCP protocol and editor-agent references. |
| [Editor consistency contracts](editor-consistency.md) | Changing document lifecycle, file operations, tab navigation, replacement semantics, Settings resolution, and runtime operation retention; Zed, ECMAScript, and idempotency references. |
| [Signed releases](release.md) | Cutting a release; signing and publishing; versioned TestFlight notes, `Internal Testing` assignment, `Public Beta` promotion, and export compliance; secrets and renewal; Apple TestFlight API references for distribution changes. |
| [npm packages](npm.md) | Publishing `@oxbit/sdk` and `@oxbit/cli`; staging layout; install scripts; trusted publishing setup and token removal; npm trusted publishing and provenance references. |
| [Remote workspaces over SSH](remote-ssh.md) | Building SSH runtime payloads for `darwin-arm64`, `linux-x64`, and `linux-arm64`; the release's `remote-runtime-*` assets and the manifest pinned into the iOS build; the remote runtime lease and `runtime.keepAlive`; running the SSH live harnesses against an arm64 container; Node, ripgrep, node-pty, GitHub arm runner, and Docker multi-platform references. |
| [Oxbit desktop](desktop.md) | Building, testing, and packaging the Tauri app for macOS arm64 and Ubuntu 24.04 x64/arm64; Linux bundle helper pins; updater manifest platforms; release checks. |
| [iOS setup](ios.md) | Building the iOS app, connecting to a computer runtime, Bonjour discovery of `oxbit --lan` runtimes, and keep-alive for SSH-started runtimes; NWBrowser, NSBonjourServices, RFC 6762/6763 and Tauri mobile plugin references. |
| [iOS release artwork](ios-release-assets.md) | Rendering app icon exports, native App Store screenshots, promo banners, and listing drafts; includes Apple design, asset specifications, and app privacy references. |
| [Withdrawn v0.3.1 audit](release-audit-0.3.1.md) | Comparing alpha.5 with the withdrawn release, confirmed corrections, and unresolved CI failures. |
| [iOS language servers](ios-language-servers.md) | Changing device-local LSPs, the per-server language extensions, the JavaScriptCore runtime, bundled Wasm, or the shared schema cache; includes Apple and Tauri API references. |
| [On-device language research](ios-language-research.md) | Choosing or upgrading an on-device YAML, Dockerfile, shell, or Python server; JIT-less Wasm timings, package licenses, App Store rules, and sources. |
| [iOS SSH and SFTP workspaces](ios-ssh.md) | Changing SSH keys, saved hosts, known-hosts trust, the russh session pool, the SFTP FileSystem, transfers, Git over SSH remotes, or the remote runtime started from iOS; includes russh/aws-lc build notes and russh, Keychain, SFTP, git2 transport, and pack protocol references. |
| [Runtime features on iOS](ios-runtime-parity.md) | Porting a runtime feature to iOS device folders; the runtime-to-iOS feature table, native search and quick-open parity rules, terminal options, and `ignore`/`grep-regex` crate references. |
| [iOS source control integration](ios-source-control.md) | On-device repositories, GitHub and Gitea credentials, OpenPGP commit signing, SSH remote key choice, native transport, and official API references |
| [Source Control](source-control.md) | Git workflows in runtime workspaces |
| [Dependency audit](security.md#dependency-audit) | Running `bun audit`, the managed language-server `npm audit`, and the Cargo OSV query; fixed versions and accepted advisories with reachability; OSV batch API reference. |
| [Runtime, trust and recovery](runtime.md) | Starting runtimes, the random port, runtime identity, `oxbit --lan` and Bonjour advertising, keep-alive, and the Runtime page and its per-app connectors; RFC 6762 and RFC 6763 references for the mDNS responder. |
| [JSON settings](settings.md) | Settings files, precedence, the schema, and the `runtime.keepAlive` and `runtime.autoReconnect` settings. |
| [Settings UI](settings-ui.md) | Changing the Settings screen: pages and sections from setting categories, the Language Servers Configure rows, the string list chip editor, the phone page list, and Edit as JSON; Zed Settings Editor references. |
