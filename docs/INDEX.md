# Documentation index

Created: 2026-10-02. Last updated: 2026-10-09.

| Guide | Use when |
| --- | --- |
| [Signed releases](release.md) | Cutting a release; signing and publishing; versioned TestFlight notes, `Internal Testing` assignment, `Public Beta` promotion, and export compliance; secrets and renewal; Apple TestFlight API references for distribution changes. |
| [npm packages](npm.md) | Publishing `@oxbit/sdk` and `@oxbit/cli`; staging layout; install scripts; trusted publishing setup and token removal; npm trusted publishing and provenance references. |
| [Remote workspaces over SSH](remote-ssh.md) | Building SSH runtime payloads; the release's `remote-runtime-*` assets and the manifest pinned into the iOS build; the remote runtime lease and `runtime.keepAlive`. |
| [iOS setup](ios.md) | Building the iOS app, connecting to a computer runtime, Bonjour discovery of `oxbit --lan` runtimes, and keep-alive for SSH-started runtimes; NWBrowser, NSBonjourServices, RFC 6762/6763 and Tauri mobile plugin references. |
| [iOS release artwork](ios-release-assets.md) | Rendering app icon exports, native App Store screenshots, promo banners, and listing drafts; includes Apple design, asset specifications, and app privacy references. |
| [Withdrawn v0.3.1 audit](release-audit-0.3.1.md) | Comparing alpha.5 with the withdrawn release, confirmed corrections, and unresolved CI failures. |
| [iOS language servers](ios-language-servers.md) | Changing device-local LSPs, JavaScriptCore, or the native filesystem bridge; includes Apple and Tauri API references. |
| [iOS SSH and SFTP workspaces](ios-ssh.md) | Changing SSH keys, saved hosts, known-hosts trust, the russh session pool, the SFTP FileSystem, transfers, Git over SSH remotes, or the remote runtime started from iOS; includes russh/aws-lc build notes and russh, Keychain, SFTP, git2 transport, and pack protocol references. |
| [iOS source control integration](ios-source-control.md) | On-device repositories, GitHub and Gitea credentials, OpenPGP commit signing, SSH remote key choice, native transport, and official API references |
| [Source Control](source-control.md) | Git workflows in runtime workspaces |
| [Runtime, trust and recovery](runtime.md) | Starting runtimes, the random port, runtime identity, `oxbit --lan` and Bonjour advertising, keep-alive, and the Runtime page and its per-app connectors; RFC 6762 and RFC 6763 references for the mDNS responder. |
| [JSON settings](settings.md) | Settings files, precedence, the schema, and the `runtime.keepAlive` and `runtime.autoReconnect` settings. |
