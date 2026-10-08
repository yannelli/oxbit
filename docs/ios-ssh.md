# iOS SSH and SFTP workspaces

Created: 2026-10-08. Last updated: 2026-10-08.

The iOS app opens folders on a server over SFTP, starts an Oxbit runtime on a server, and uses SSH remotes for Git in device folders. Keys, saved hosts, host-key trust, the connection pool, and transfers live in the iOS crate (`apps/ios/src-tauri/src/ssh/`). Private keys and saved passwords live in the Keychain through the `oxbit-files` plugin.

## Entry points

- The start screen section "On a server" has Connect with SSH…, SSH Hosts and Keys…, and recent SSH workspaces.
- The same section has Start Oxbit on This Server… and recent remote runtime workspaces.
- With a workspace open, the command palette has `ssh.hosts` (SSH Hosts and Keys), `ssh.connect` (Connect with SSH…), `ssh.runtime` (Start Oxbit on This Server…), and `ssh.runtime.reconnect`.
- An SSH workspace adds `ssh.upload` (Upload Files Here…) and `ssh.download` (Download to Device…) to the palette and the explorer context menu.

All four dialogs render as `.ios-shell > .modal-scrim`, above the workspace sheet.

## Keys

Generate Ed25519 Key creates the key on the device with `ssh-key` (comment `<name>@oxbit-ios`). Import Key… accepts a pasted key or a file from the Files picker, with an optional passphrase. Import goes through `russh::keys::decode_secret_key`, which reads OpenSSH, PEM (PKCS#1), and PKCS#8 keys, encrypted or not. The decrypted key is re-encoded as unencrypted OpenSSH before it is stored, so the passphrase is not saved. `PASSPHRASE_REQUIRED` and `KEY_INVALID` errors reach the dialog.

`SshKeyStore.swift` (Foundation and Security only) stores one generic-password item per key or password; `SshKeys.swift` maps plugin requests onto it:

| Item | Service | Account | Accessibility |
| --- | --- | --- | --- |
| Private key and metadata (JSON) | `com.yannelli.oxbit.ssh-key` | key id | `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` |
| Saved host password | `com.yannelli.oxbit.ssh-password` | host id | `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` |

The plugin command `ssh_keys` accepts only `list` and `delete` from JavaScript and returns `id`, `name`, `algorithm`, `fingerprint`, and `publicKey` (`plugins/oxbit-files/src/ssh_keys.rs`). The `save`, `read`, `savePassword`, `readPassword`, and `forgetPassword` operations run only from Rust through `run_mobile_plugin`. Copy public key writes the `publicKey` line to the clipboard.

## Hosts

`ssh/hosts.json` in the app data directory holds up to 100 hosts: `id`, `label`, `hostname`, `port`, `username`, `auth` (`key` or `password`), `keyId`, and `passwordSaved`. Validation rejects hostnames outside `[A-Za-z0-9._:-]`, usernames with `@`, `:`, `/`, or a leading `-`, and key hosts without a key id.

Password hosts ask for the password at connect time. The "Save password in the Keychain" checkbox stores it only after authentication succeeds. Changing the hostname, port, username, auth method, or key disconnects the host and closes its open roots. Switching a host to key auth forgets its saved password.

## Known hosts

`ssh/known_hosts.json` maps an authority to its trusted keys. The authority is `hostname:port` in lowercase, with IPv6 addresses in brackets (`[::1]:22`). Each entry stores the key algorithm, the OpenSSH SHA256 fingerprint, and the time it was added.

During the handshake, `Client::check_server_key` records the presented key and its verdict:

| Saved keys for the authority | Presented key | Result |
| --- | --- | --- |
| none | any | `hostUnknown`: the dialog shows the key type and SHA256 fingerprint. Trust and Connect saves it and connects again. |
| one or more | algorithm and fingerprint match a saved key | connected |
| one or more | anything else, including a different key type | `hostChanged`: no connection; the dialog shows the saved and presented fingerprints and offers Forget saved host key. |

`ios_ssh_trust` refuses with `HOST_KEY_CHANGED` when the authority already has a key, so a changed key cannot replace a saved one. Forgetting removes every key for the authority and disconnects the host; the next connection shows the first-use prompt again. The client lists the saved key's algorithm first in `Preferred.key`, so a server with several host keys presents the trusted type. Reconnects after a dropped connection run the same check and fail with `HOST_KEY_CHANGED`.

## Session pool

`session::Pool` keeps one slot per host id: the target (hostname, port, username), the credential, and one `Connection` (`russh::client::Handle`, an `SftpSession`, and the remote home folder). All roots on a host share that connection. The credential stays in memory only while the slot exists; `ios_ssh_disconnect`, host edits, host removal, and forgetting the host key drop the slot.

- Keepalive every 15 s, disconnect after 3 missed replies, no inactivity timeout. Connect times out after 20 s; SFTP requests after 30 s.
- `Pool::run` checks `Handle::is_closed` first. When the connection is closed or an SFTP call fails with `CONNECTION_LOST`, it reconnects with the stored credential and retries the operation once.
- `connect::authenticate` runs the TCP connect, host key check, and authentication. `connect::establish` adds a session channel with the `sftp` subsystem and passes the channel stream to `SftpSession::new`. Git over SSH calls `authenticate` and opens its own exec channel on a separate connection (see below). Port forwarding (`channel_open_direct_tcpip`) has no caller.

## FileSystem mapping

`SshFileSystem` (`packages/host-ios/src/filesystem.ts`) reuses `IosFileSystem` with the `ios_ssh_*` commands. `ios_ssh_open_root` resolves the folder (empty and `~` mean home, `/` starts an absolute path, anything else is relative to home), canonicalizes it, and returns `ios:` plus SHA-256 of `ssh\0<host id>\0<path>` as the workspace id.

| FileSystem | Command | SFTP |
| --- | --- | --- |
| `list` | `ios_ssh_fs_list` | `read_dir`, following symlinks; hides `.oxbit-tmp-*` |
| `read` | `ios_ssh_fs_read` (raw response) | `read`, 20 MiB limit |
| `write` | `ios_ssh_fs_write` (raw body, `x-oxbit-*` headers) | see below |
| `mkdir` | `ios_ssh_fs_mkdir` | `create_dir` for each missing parent |
| `rename` | `ios_ssh_fs_rename` | `EXISTS` if the target exists, creates the parent, `rename` |
| `delete` | `ios_ssh_fs_delete` | recursive `remove_file` and `remove_dir` |
| `watch` | none | inert: SFTP has no change notifications |

Writes compare the SHA-256 of the current remote bytes with the expected revision and fail with `CONFLICT` (`File revision conflict:`) on a mismatch, so documents show the usual conflict UI. Identical content returns the current revision without writing. Otherwise the bytes go to `.oxbit-tmp-<uuid>`, the existing file moves to a backup name, the temporary file takes the target name, and the backup is removed. A failed rename moves the backup back. The original permission bits are reapplied. `russh-sftp` has no `posix-rename`, and plain SFTP rename refuses an existing target, so the backup step is required.

Error codes and messages match `fs_core` (`NOT_FOUND` with `ENOENT: no such file or directory:`, `EXISTS`, `CONFLICT`), which `packages/documents` uses to classify failures. Search works through `list` and `read`, as in other workspaces without a runtime. SSH workspaces have no device Git client and no device language servers.

## Transfers

- Upload and key-file import pick files with `UIDocumentPickerViewController` (`asCopy: true`). Apple's reference for that initializer says only that the picker copies the selected document; it does not name the destination. Rust (`picked_file` in `ssh/commands.rs`) accepts any regular file under the canonicalized temporary directory, with or without a `<bundle-id>-Inbox` subfolder, and canonicalizes the picked path too, so `/var/...` and `/private/var/...` spellings match. Each file is written to a temporary name in the target folder and renamed into place. An existing name fails the upload with `EXISTS` before any bytes move. The temporary copies are deleted afterwards.
- Download picks a device folder with the existing folder picker, keeps its security scope open for the transfer, then closes and forgets the bookmark. Files and folders (up to 10,000 entries) download into a hidden staging folder inside the destination, which is renamed to the final name on success.
- Both send 256 KiB chunks and emit `ios-ssh-transfer:<transferId>` events with `transferred`, `total`, and `file`. `ios_ssh_transfer_cancel` sets a flag that the copy loop checks between chunks; a cancelled transfer removes its temporary files and returns `CANCELLED`.

## Git over SSH

Fetch, pull, push, publish, and clone accept `ssh://[user@]host[:port]/path` and scp-style `[user@]host:path` remotes for device folders. The git2 build keeps its `ssh` feature off; libssh2 is not linked.

- `git_core/ssh_transport.rs` registers a custom `ssh://` smart subtransport with `git2::transport::register` at app startup. libgit2 also routes scp-style URLs to the transport registered for `ssh://` ([transport lookup](https://docs.rs/crate/libgit2-sys/0.18.8+1.9.7/source/libgit2/src/libgit2/transport.c)). The transport is stateful (`rpc: false`): git2 calls `action` for `UploadPackLs` or `ReceivePackLs` and reuses that stream for the pack exchange.
- `ssh/git.rs` (`GitConnector`) picks the key, connects with `connect::authenticate` against `known_hosts.json`, and runs `git-upload-pack '<path>'` or `git-receive-pack '<path>'` on an exec channel. The path is single-quoted with `'` written as `'\''`, as Git's SSH transport does. `ssh/git_stream.rs` bridges the channel to blocking `Read`/`Write` on the Git operation thread through the Tokio runtime handle, checks the cancel flag every 250 ms, and stops after 120 s without data. A non-zero exit status turns the server's stderr (up to 4 KiB) into the `GIT_FAILED` message, such as `fatal: '/root/missing.git' does not appear to be a git repository`.
- `ssh://host/~/repo` sends `~/repo`, relative to the login's home folder. scp-style paths are sent as written.
- URL rules: the user is `[A-Za-z0-9._-]` without a leading `-`; a `user:password@` form, `%` in the authority, port 0, and hosts that start with `-` or `.` are refused.

Key selection, in order:

1. The repository's key: workspace storage key `git-ssh-key` under the root's scope, set in Git Accounts and Commit Author under **SSH key for this repository**.
2. The key of a saved SSH host with the same hostname (case-insensitive) and port, using `key` auth. A host whose username matches the URL's user wins over another host on the same server.
3. Otherwise the request fails with `SSH_KEY_REQUIRED`, and the **Choose SSH Key** dialog saves a key host for that server (label and hostname from the remote) before the request runs again.

The username comes from the URL, then the matched saved host, then `git`.

Prompts: a failed request stores its prompt in `Ssh.git_prompts` under the workspace root ID and returns `SSH_KEY_REQUIRED`, `HOST_KEY_UNKNOWN`, or `HOST_KEY_CHANGED`. `IosGitClient` calls `IosGitClient.sshPrompt` (set in `main.tsx`) for those codes, up to three times per request, and repeats the request with a new request ID when the handler resolves `true`. `ssh-git-prompt.tsx` reads the prompt with `ios_ssh_git_prompt`:

| Prompt | Dialog | Command |
| --- | --- | --- |
| `keyRequired` | Choose SSH Key: key and user name | `ios_ssh_host_save`, then the request runs again |
| `hostUnknown` | Confirm Host Key: key type and SHA256 fingerprint | `ios_ssh_git_trust` trusts only the fingerprint the request presented, then the request runs again |
| `hostChanged` | Host Key Changed: saved and presented fingerprints | `ios_ssh_git_forget_host_key` forgets the server's keys and disconnects saved hosts on that server; the request stays failed |

Host keys share `known_hosts.json` and its refusal rules with SFTP workspaces, so trusting a server in either place covers both. Each Git network operation opens its own SSH connection and disconnects when libgit2 drops the stream. Private keys load from the Keychain only when a remote needs one and stay out of progress and error text; `safe_output` still redacts HTTPS tokens in the same output.

## Remote runtime

Start Oxbit on This Server runs the desktop's headless runtime (`desktop.js`) on a saved host and connects the iOS runtime client to it, so terminals, tasks, and agents run on the server. The Rust side mirrors `apps/runtime/src/ssh.ts` and `ssh-target.ts` and lives in `apps/ios/src-tauri/src/ssh/runtime_*.rs`. The remote layout matches the desktop, so a host shared with the desktop reuses its install under `~/.oxbit/remote/runtimes/<sha256>`.

- Platform: `uname -s; uname -m` maps to `linux-x64` or `darwin-arm64`. Other hosts fail with the desktop's message.
- Payload: `runtime_install::pinned` is the one manifest lookup. It calls `remote_runtime::pinned_download`, which reads `TAURI_OXBIT_REMOTE_RUNTIME_MANIFEST` at build time. A build without a manifest reports that it has no remote runtime.
- Install order: a `.complete` marker skips the install. Otherwise the host runs `curl -fsSL` (with a 15 s connect timeout and a 30 s stall limit) or `wget -qO-` piped into the desktop's install script, which checks the pinned SHA-256 before it writes `.complete`. If the host has neither tool or the download fails, the `oxbit-files` plugin downloads the archive with `URLSession` (`RuntimeDownloadStore.swift`, HTTPS only) and keeps it in Caches only when its size and SHA-256 match. Rust checks both again, and the archive streams into the same script over the exec channel. A unit test compares the script byte for byte with `ssh-target.ts`.
- Launch: `bin/node desktop.js` runs with `NODE_OPTIONS`, `NODE_PATH`, and `OXBIT_LSP_COMMAND` unset. The launch frame carries `remoteRuntime: true`, the root, the workspace key, and a random token. The runtime then accepts that token as the owner, so `/api/pair` and its rate limit are not used. Stdout frames follow version 1 with a 64 KiB line cap: `ready`, `rotated`, `taskForward`, `error`, and `progress`. A heartbeat goes out every 10 s against the runtime's 75 s lease.
- Tunnel: a listener on `127.0.0.1:0` forwards each accepted connection over a `direct-tcpip` channel to the port in the `ready` frame. `taskForward` requests get their own loopback listener per `host:port` and a `taskForwarded` reply. The WebView reaches the loopback port through `NSAllowsLocalNetworking` and the `127.0.0.0/8` exception in `apps/ios/src-tauri/Info.ios.plist`.
- Lifecycle: closing the workspace cancels a running device download, sends `shutdown`, and closes the channel and listeners. Task listeners stay open until then, as on the desktop (`apps/runtime/src/ssh.ts`); after a task stops, their connections close without data. When the exec channel ends, or the app returns to the foreground, `ensure` reconnects the pooled SSH connection, stops a stale runtime by PID only when its command line is an Oxbit runtime, and relaunches with the same token and local port, so the runtime client's own WebSocket reconnect picks it up. Automatic attempts stop after 3 in 60 s with a message to reconnect. Reconnect (`ssh.runtime.reconnect`) and the foreground return bypass that budget and start a new one.
- Origins: the runtime allows `tauri://localhost`. A dev build served from `http://127.0.0.1:9281` is not an allowed origin, so remote runtimes need a bundled build.

## Build notes

- `russh = "=0.64.1"` and `ssh-key = "=0.7.0-rc.11"` are pinned together because russh requires that exact `ssh-key` release. Upgrade both in one change.
- russh's default features use `aws-lc-rs` 1.18.1. `aws-lc-sys` 0.45.0 builds with its `cc` builder for `aarch64-apple-ios` and `aarch64-apple-ios-sim`, with no cmake, nasm, bindgen, or clang settings. Its symbols carry the `aws_lc_0_45_0` prefix, so they link next to the vendored OpenSSL from `git2` without duplicate symbols.
- Standalone `cargo build` for iOS needs `IPHONEOS_DEPLOYMENT_TARGET=26.0`. Without it, `cc` targets the SDK version and `ld` warns that aws-lc objects were built for a newer iOS. Xcode-driven Tauri builds set the variable.
- Key generation uses `getrandom` 0.4 (`sys_rng`) through `ssh_key::rand_core::UnwrapErr(getrandom::SysRng)`.
- Host `cargo test` runs on a machine with little free disk use `CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0` to keep the target directory small.
- License notices for the added crates ship in `apps/web/public/licenses/ios-ssh-crates.txt`, built from each crate's published license files.

## Testing

- Unit tests: `cargo test --locked` in `apps/ios/src-tauri` (keys, hosts, known hosts, SSH URL parsing and command quoting in `git_core/ssh_transport_tests.rs`, key selection in `ssh/git.rs`) and `cargo test --locked -p tauri-plugin-oxbit-files` in the same folder (request validation and metadata filtering).
- Keychain: `bun run ios:check` compiles `SshKeyStore.swift` with `Tests/SshKeys/main.swift` and runs save, read, list, update, delete, and password save/read/forget against the macOS login keychain, under per-run service names that it deletes afterwards. Its first Keychain call is a write; when that returns `errSecInteractionNotAllowed` (-25308), as in a `Background` launchd session with a locked login keychain (`launchctl managername`), it prints `SshKeyStore tests skipped: the login keychain is locked in this session` and exits 0. Any other failure fails the check. An unsigned binary on macOS uses the file-based keychain, which rejects `kSecReturnData` with `kSecMatchLimitAll` (`errSecParam`), so `keys()` lists accounts and reads each item. The macOS run does not exercise the data-protection keychain or `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` as iOS applies them.
- Runtime download: `bun run ios:check` compiles `RuntimeDownloadStore.swift` with `Tests/RuntimeDownload/main.swift` and downloads fixed ripgrep 14.1.1 release assets from GitHub: a download with matching size and SHA-256, a corrupt cached file replaced, refusal of `http://` and a malformed digest, size and digest mismatches that leave nothing in the cache, and cancellation. Without a network it prints `RuntimeDownload tests skipped: the network is unavailable` and exits 0.
- Live tests: `bun run ios:ssh-live` builds `scripts/remote/sshd.Dockerfile`, starts a container with a key port and a password port, and runs the ignored `ssh::live_` tests one at a time. `ssh::live_git_tests` runs first and covers the key prompt without a saved host, the first-use host key prompt, clone over `ssh://`, push, fetch, pull, a server error from a missing repository, and refusal when the saved host key differs. `ssh::live_runtime_tests` installs the runtime through the device stream after a failed host download and through `curl` from a local HTTP server, runs `fs.read` and a terminal command through the tunnel with `scripts/ios/runtime-probe.mjs`, reuses the cache, relaunches after `kill -9`, and reconnects after `docker restart`. `ssh::live_runtime_task_tests` installs with `wget` on a host without `curl`, runs a service task and fetches it through the `taskForward` listener with `scripts/ios/runtime-task-probe.mjs`, and checks that 3 failed automatic relaunches stop and wait for Reconnect. Both need `bun run remote:prepare` first and are skipped without the payload. `ssh::live_tests` covers key auth with a passphrase-protected key, first-use trust, SFTP list/read/write/conflict/mkdir/rename/delete, upload and download with progress and cancel, password auth, reconnect after `docker restart`, and refusal after the container's host keys are regenerated. The script removes the container afterwards.
- UI: `bunx playwright test -c tests/ios/playwright.config.ts ssh.spec.ts` with the in-memory SSH bridge in `tests/ios/ssh-bridge.ts`. Its `clone` seed makes `git.clone` return the SSH prompt errors in order. `ssh-runtime.spec.ts` covers the start dialog, progress, the recent entry, and a failed start, with the runtime WebSocket mocked by `page.routeWebSocket`. `OXBIT_SSH_SCREENSHOTS` sets the screenshot folder (default `evidence/ios-ssh`).

## Not implemented

- scp-style remotes on a port other than 22 (use `ssh://host:port/path`), password authentication for Git remotes, and `ssh+git://` or `git+ssh://` URLs.
- Keyboard-interactive authentication, SSH agents, certificates, and jump hosts.
- Port forwarding and exec channels in the UI.
- Change notifications for SSH workspaces. The explorer refreshes after Oxbit's own file operations and uploads.

## References

- russh 0.64.1: https://docs.rs/russh/0.64.1/russh/
- russh-sftp 3.0.1: https://docs.rs/russh-sftp/3.0.1/russh_sftp/
- ssh-key 0.7.0-rc.11: https://docs.rs/ssh-key/0.7.0-rc.11/ssh_key/
- aws-lc-rs platform support: https://aws.github.io/aws-lc-rs/platform_support.html
- Keychain item accessibility: https://developer.apple.com/documentation/security/ksecattraccessiblewhenunlockedthisdeviceonly
- TN3137, On Mac keychain APIs and implementations: https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains
- UIDocumentPickerViewController: https://developer.apple.com/documentation/uikit/uidocumentpickerviewcontroller
- init(forOpeningContentTypes:asCopy:): https://developer.apple.com/documentation/uikit/uidocumentpickerviewcontroller/init(forOpeningContentTypes:asCopy:)
- SSH transport and host keys: https://www.rfc-editor.org/rfc/rfc4253
- git2 custom transports: https://docs.rs/git2/0.21.0/git2/transport/index.html
- Git pack protocol over SSH: https://git-scm.com/docs/pack-protocol
- Git URL forms: https://git-scm.com/docs/git-clone
- direct-tcpip channels: https://www.rfc-editor.org/rfc/rfc4254#section-7.2
- NSAllowsLocalNetworking: https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking
- SFTP version 3 draft: https://datatracker.ietf.org/doc/html/draft-ietf-secsh-filexfer-02
