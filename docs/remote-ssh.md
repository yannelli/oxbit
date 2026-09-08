# Remote workspaces over SSH

Choose **Connect over SSH…** in Oxbit's project bar, File menu, or command palette. Enter an SSH config alias or `user@host`, a remote folder or file such as `~/projects/app`, and an optional port. Remote projects appear in the project switcher and recent projects with an **SSH** label and restore when the app starts.

Oxbit uses the system OpenSSH client and your existing `~/.ssh/config`, identity files, SSH agent, and jump-host configuration. Connect to a new host once in a terminal to verify its host key and confirm key authentication. Password prompts and host-key acceptance are not embedded in the editor. The connector requires a known host and noninteractive key authentication; it never disables host-key checking or forwards your authentication agent.

The remote machine needs SSH access, a POSIX shell, `tar`, and `sha256sum` or `shasum`. Supported runtime targets are **Linux x64 with glibc** and **macOS Apple Silicon**. Linux payloads built by the macOS cross-build use Debian bookworm; native release payloads use Ubuntu 24.04. Linux systems must satisfy the native payload's libc requirements. Alpine/musl, Linux ARM, Windows SSH hosts, and macOS Intel are not included in this first connector.

No Node, npm, package manager, compiler, elevated privileges, or outbound internet connection is needed on the remote host. Oxbit copies a matching headless runtime, Node 24, ripgrep, TypeScript language server, and the native PTY module over SSH. Git and project-specific tools use the remote account's installed tools. Additional managed language servers retain their existing download requirements when first activated.

## Installation and connection lifecycle

The local application verifies its payload against its bundled SHA-256 manifest. The installer streams the archive over SSH, verifies it again, extracts into a private staging directory, checks the bundled Node executable, and publishes a completed version under `~/.oxbit/remote/runtimes/<sha256>`. Identical payloads are reused; different application builds install separate versions. Failed transfers leave no published installation. Nothing is written into the project to install the runtime.

The headless process accepts its workspace and session credential through SSH stdin. It listens on remote loopback only. A private SSH control connection forwards an ephemeral local loopback port to that runtime; the desktop uses the existing authenticated WebSocket protocol. Filesystem operations, filesystem watching, search, terminals, tasks, Git, and language services execute remotely. Files are edited in place, without a local mirror or SSHFS mount.

Runtime state is stored separately under `~/.oxbit/remote/workspaces/<root-hash>`. Desktop drafts remain in the local application's normal project recovery storage. Workspace trust is still required before terminals, tasks, Git commands, extensions, or language servers execute. SSH authentication does not automatically grant workspace trust. Each connection launches a supervised runtime. A second SSH session for the same canonical remote folder is rejected while its first runtime is alive, protecting the persisted workspace state. Close the first session before opening it elsewhere. A stopped owner's lock is recovered on the next connection.

Closing a project shuts down the remote runtime and its tools and closes the SSH tunnel. Loss of the parent channel also shuts it down. A 10-second heartbeat with a 75-second remote lease bounds orphaned process lifetime if a network failure prevents SSH EOF from arriving. The connector never forwards remote process IDs to the local native supervisor.

After a connection failure, choose **Reconnect over SSH**. Drafts are retained, saved files stay on the remote disk, and a cached runtime is reused. Runtime restarts end old terminal/task sessions; commands with an uncertain outcome are not automatically replayed. Moving a project between windows rotates its session token through the private SSH channel.

To remove cached runtime versions, close remote projects first, then remove the desired directories under `~/.oxbit/remote/runtimes` on that host. Removing `~/.oxbit/remote/workspaces` also removes trust, runtime operation records, and shared-document recovery state. It does not remove project files.

## Building and checking

Run `pnpm remote:prepare` to build and include both payloads in `apps/desktop/src-tauri/resources/runtime/remote`. This is also part of desktop preparation. Downloads are pinned and verified using `scripts/desktop/binaries.json`. macOS development builds use Docker to compile the Linux PTY against the pinned Node 24 build image. Docker's CLI and credential helper must be on PATH. Linux x64 builders use the installed native PTY build; build with Node 24 and enabled dependency lifecycle scripts.

For a native single-target artifact, set `OXBIT_REMOTE_TARGETS=darwin-arm64` or `OXBIT_REMOTE_TARGETS=linux-x64`. The desktop CI workflow builds these on their native runners, then assembles both artifacts into each desktop application using `OXBIT_REMOTE_PAYLOADS`. This avoids a Docker dependency on macOS CI runners. Missing platform payloads fail explicitly at connection time.

- `pnpm test` includes SSH target validation, shell quoting, checksum failure, and installation tests.
- `pnpm remote:test` builds an ephemeral Linux SSH container, creates temporary keys and a private known-hosts file, removes its outbound route, and exercises cold installation, remote file editing, conflicts, search, Git, real PTYs, TypeScript completion, token rotation, cached reconnection, shutdown, and transport loss. It cleans up the container and temporary keys. Results are written to `evidence/remote-ssh/results.json`.
- After `pnpm desktop:test:build`, `pnpm remote:test:native` checks the connection dialog, keyboard dismissal, input validation, and URI submission in the native WebView. Its submission is captured by the UI test; the separate SSH smoke test covers real transport.

OpenSSH's [connection sharing and local forwarding](https://man.openbsd.org/ssh.1) and [SSH configuration](https://man.openbsd.org/ssh_config.5) define the underlying transport behavior.
