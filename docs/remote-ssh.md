# Remote workspaces over SSH

Created: 2026-09-08. Last updated: 2026-10-09.

Choose **Connect over SSH…** in Oxbit's project bar, File menu, or command palette. Enter an SSH config alias or `user@host`, a remote folder or file such as `~/projects/app`, and an optional port. Remote projects appear in the project switcher and recent projects with an **SSH** label and restore when the app starts.

Oxbit uses the system OpenSSH client and your existing `~/.ssh/config`, identity files, SSH agent, and jump-host configuration. Connect to a new host once in a terminal to verify its host key and confirm key authentication. Password prompts and host-key acceptance are not embedded in the editor. The connector requires a known host and noninteractive key authentication; it never disables host-key checking or forwards your authentication agent.

The remote machine needs SSH access, a POSIX shell, `tar`, and `sha256sum` or `shasum`. Supported runtime targets are **Linux x64 with glibc** and **macOS Apple Silicon**. Linux payloads built by the macOS cross-build use Debian bookworm; native release payloads use Ubuntu 24.04. Linux systems must satisfy the native payload's libc requirements. Alpine/musl, Linux ARM, Windows SSH hosts, and macOS Intel are not supported.

No Node, npm, package manager, compiler, elevated privileges, or outbound internet connection is needed on the remote host. Oxbit copies a matching headless runtime, Node 24, ripgrep, TypeScript language server, and the native PTY module over SSH. Git and project-specific tools use the remote account's installed tools. Additional managed language servers retain their existing download requirements when first activated.

## Installation and connection lifecycle

The local application verifies its payload against its bundled SHA-256 manifest. The installer streams the archive over SSH, verifies it again, extracts into a private staging directory, checks the bundled Node executable, and publishes a completed version under `~/.oxbit/remote/runtimes/<sha256>`. Identical payloads are reused; different application builds install separate versions. Failed transfers leave no published installation. Nothing is written into the project to install the runtime.

The headless process accepts its workspace and session credential through SSH stdin. It listens on remote loopback only. A private SSH control connection forwards an ephemeral local loopback port to that runtime; the desktop uses the existing authenticated WebSocket protocol. Filesystem operations, filesystem watching, search, terminals, tasks, Git, and language services execute remotely. Files are edited in place, without a local mirror or SSHFS mount.

Runtime state is stored separately under `~/.oxbit/remote/workspaces/<root-hash>`. Desktop drafts remain in the local application's normal project recovery storage. Workspace trust is still required before terminals, tasks, Git commands, extensions, or language servers execute. SSH authentication does not automatically grant workspace trust. Each connection launches a supervised runtime. A second SSH session for the same canonical remote folder is rejected while its first runtime is alive, protecting the persisted workspace state. Close the first session before opening it elsewhere. A stopped owner's lock is recovered on the next connection.

Closing a project shuts down the remote runtime and its tools and closes the SSH tunnel. When the SSH channel drops instead, the remote runtime keeps running until its lease expires. The launch frame's `keepAlive` sets the lease in milliseconds: absent means 75000, and `0` runs until stopped. A 10-second heartbeat refreshes the lease, and a connected authenticated WebSocket client holds it; the countdown starts once both stop. A launch for the same folder with the same workspace key sends SIGTERM to the previous runtime, waits up to 5 seconds for it to exit, and takes its lock, so a reconnect replaces its own orphan. A launch with a different workspace key still reports that the folder is already open. The connector never forwards remote process IDs to the local native supervisor.

After a connection failure, choose **Reconnect over SSH**. Drafts are retained, saved files stay on the remote disk, and a cached runtime is reused. Runtime restarts end old terminal/task sessions; commands with an uncertain outcome are not automatically replayed. Moving a project between windows rotates its session token through the private SSH channel.

To remove cached runtime versions, close remote projects first, then remove the desired directories under `~/.oxbit/remote/runtimes` on that host. Removing `~/.oxbit/remote/workspaces` also removes trust, runtime operation records, and shared-document recovery state. It does not remove project files.

## Building and checking

Run `bun run remote:prepare` to build and include both payloads in `apps/desktop/src-tauri/resources/runtime/remote`. This is also part of desktop preparation. Downloads are pinned and verified using `scripts/desktop/binaries.json`. macOS development builds use Docker to compile the Linux PTY against the pinned Node 24 build image. Docker's CLI and credential helper must be on PATH. Linux x64 builders use the installed native PTY build; build with Node 24 and enabled dependency lifecycle scripts.

For a native single-target artifact, set `OXBIT_REMOTE_TARGETS=darwin-arm64` or `OXBIT_REMOTE_TARGETS=linux-x64`. The desktop CI workflow builds these on their native runners, then assembles both artifacts into each desktop application using `OXBIT_REMOTE_PAYLOADS`. This avoids a Docker dependency on macOS CI runners. Missing platform payloads fail explicitly at connection time.

## Release assets

Each tagged release attaches the payloads the macOS app bundles, copied after `scripts/desktop/sign-resources.mjs` signs and repacks the darwin archive:

- `remote-runtime-darwin-arm64.tar.gz` and `remote-runtime-linux-x64.tar.gz`
- `remote-runtime-manifest.json`: `{"version": "<package version>", "platforms": {"<platform>": {"sha256": "<hex>", "size": <bytes>}}}`

`node scripts/remote/release-manifest.mjs <output> <payload-directory>...` writes these files. Each payload directory holds `manifest.json` and `<platform>.tar.gz`, as produced by `bun run remote:prepare`. The script checks each archive against its `manifest.json` digest and requires both platforms.

The iOS release build embeds the combined manifest. The `ios` job in `release.yml` waits for the `macos` job, downloads the `remote-manifest` artifact, and sets `TAURI_OXBIT_REMOTE_RUNTIME_MANIFEST` to its absolute path. `tauri ios build` runs cargo from the Xcode script phase and with a filtered environment that keeps `TAURI_` variables and drops `OXBIT_` ones. `apps/ios/src-tauri/build.rs` turns that file into a constant; without the variable, local and simulator builds compile with no manifest. `remote_runtime::pinned_manifest()` and `remote_runtime::pinned_download(platform)` in `apps/ios/src-tauri/src/remote_runtime.rs` reject a manifest with unknown fields, a missing or unknown platform, a digest other than 64 lowercase hex characters, an empty payload, or a version other than the app's Cargo version. Download URLs follow `https://github.com/yannelli/oxbit/releases/download/v<version>/remote-runtime-<platform>.tar.gz`. Desktop and iOS install the same digest into `~/.oxbit/remote/runtimes/<sha256>` on a host, so they share one installed runtime.

- `bun run test` includes SSH target validation, shell quoting, checksum failure, and installation tests.
- `bun run remote:test` builds an ephemeral Linux SSH container, creates temporary keys and a private known-hosts file, removes its outbound route, and exercises cold installation, remote file editing, conflicts, search, Git, real PTYs, TypeScript completion, token rotation, cached reconnection, shutdown, and transport loss. It cleans up the container and temporary keys.
- After `bun run desktop:test:build`, `bun run remote:test:native` checks the connection dialog, keyboard dismissal, input validation, and URI submission in the native WebView. Its submission is captured by the UI test; the separate SSH smoke test covers real transport.

OpenSSH's [connection sharing and local forwarding](https://man.openbsd.org/ssh.1) and [SSH configuration](https://man.openbsd.org/ssh_config.5) define the underlying transport behavior.
