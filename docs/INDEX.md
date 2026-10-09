# Documentation index

Created: 2026-10-02. Last updated: 2026-10-09.

| Guide | Use when |
| --- | --- |
| [Signed releases](release.md) | Cutting a release; signing and publishing; versioned TestFlight notes, `Internal Testing` assignment, `Public Beta` promotion, and export compliance; secrets and renewal; Apple TestFlight API references for distribution changes. |
| [npm packages](npm.md) | Publishing `@oxbit/sdk` and `@oxbit/cli`; staging layout; install scripts; trusted publishing setup and token removal; npm trusted publishing and provenance references. |
| [Remote workspaces over SSH](remote-ssh.md) | Building SSH runtime payloads; the release's `remote-runtime-*` assets and the manifest pinned into the iOS build. |
| [iOS setup](ios.md) | Building the iOS app or connecting to a computer runtime. |
| [iOS release artwork](ios-release-assets.md) | Rendering app icon exports, native App Store screenshots, promo banners, and listing drafts; includes Apple design, asset specifications, and app privacy references. |
| [Withdrawn v0.3.1 audit](release-audit-0.3.1.md) | Comparing alpha.5 with the withdrawn release, confirmed corrections, and unresolved CI failures. |
| [iOS language servers](ios-language-servers.md) | Changing device-local LSPs, the per-server language extensions, the JavaScriptCore runtime, bundled Wasm, or the shared schema cache; includes Apple and Tauri API references. |
| [On-device language research](ios-language-research.md) | Choosing or upgrading an on-device YAML, Dockerfile, shell, or Python server; JIT-less Wasm timings, package licenses, App Store rules, and sources. |
| [iOS SSH and SFTP workspaces](ios-ssh.md) | Changing SSH keys, saved hosts, known-hosts trust, the russh session pool, the SFTP FileSystem, transfers, Git over SSH remotes, or the remote runtime started from iOS; includes russh/aws-lc build notes and russh, Keychain, SFTP, git2 transport, and pack protocol references. |
| [iOS source control integration](ios-source-control.md) | On-device repositories, GitHub and Gitea credentials, OpenPGP commit signing, SSH remote key choice, native transport, and official API references |
| [Source Control](source-control.md) | Git workflows in runtime workspaces |
