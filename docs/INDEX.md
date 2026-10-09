# Documentation index

Created: 2026-10-02. Last updated: 2026-10-09.

| Guide | Use when |
| --- | --- |
| [Signed releases](release.md) | Cutting a release; signing and publishing; versioned TestFlight notes, `Internal Testing` assignment, `Public Beta` promotion, and export compliance; secrets and renewal; Apple TestFlight API references for distribution changes. |
| [npm packages](npm.md) | Publishing `@oxbit/sdk` and `@oxbit/cli`; staging layout; install scripts; trusted publishing setup and token removal; npm trusted publishing and provenance references. |
| [Remote workspaces over SSH](remote-ssh.md) | Building SSH runtime payloads for `darwin-arm64`, `linux-x64`, and `linux-arm64`; the release's `remote-runtime-*` assets and the manifest pinned into the iOS build; running the SSH live harnesses against an arm64 container; Node, ripgrep, node-pty, GitHub arm runner, and Docker multi-platform references. |
| [Oxbit desktop](desktop.md) | Building, testing, and packaging the Tauri app for macOS arm64 and Ubuntu 24.04 x64/arm64; Linux bundle helper pins; updater manifest platforms; release checks. |
| [iOS setup](ios.md) | Building the iOS app or connecting to a computer runtime. |
| [iOS release artwork](ios-release-assets.md) | Rendering app icon exports, native App Store screenshots, promo banners, and listing drafts; includes Apple design, asset specifications, and app privacy references. |
| [Withdrawn v0.3.1 audit](release-audit-0.3.1.md) | Comparing alpha.5 with the withdrawn release, confirmed corrections, and unresolved CI failures. |
| [iOS language servers](ios-language-servers.md) | Changing device-local LSPs, JavaScriptCore, or the native filesystem bridge; includes Apple and Tauri API references. |
| [iOS SSH and SFTP workspaces](ios-ssh.md) | Changing SSH keys, saved hosts, known-hosts trust, the russh session pool, the SFTP FileSystem, transfers, Git over SSH remotes, or the remote runtime started from iOS; includes russh/aws-lc build notes and russh, Keychain, SFTP, git2 transport, and pack protocol references. |
| [iOS source control integration](ios-source-control.md) | On-device repositories, GitHub and Gitea credentials, OpenPGP commit signing, SSH remote key choice, native transport, and official API references |
| [Source Control](source-control.md) | Git workflows in runtime workspaces |
| [Dependency audit](security.md#dependency-audit) | Running `bun audit`, the managed language-server `npm audit`, and the Cargo OSV query; fixed versions and accepted advisories with reachability; OSV batch API reference. |
