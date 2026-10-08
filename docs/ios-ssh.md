# iOS SSH and SFTP workspaces

Created: 2026-10-08. Last updated: 2026-10-08.

The iOS app opens folders on a server over SFTP. Keys, saved hosts, host-key trust, the connection pool, and transfers live in the iOS crate (`apps/ios/src-tauri/src/ssh/`). Private keys and saved passwords live in the Keychain through the `oxbit-files` plugin.

## Entry points

- The start screen section "On a server" has Connect with SSH…, SSH Hosts and Keys…, and recent SSH workspaces.
- With a workspace open, the command palette has `ssh.hosts` (SSH Hosts and Keys) and `ssh.connect` (Connect with SSH…).
- An SSH workspace adds `ssh.upload` (Upload Files Here…) and `ssh.download` (Download to Device…) to the palette and the explorer context menu.

All four dialogs render as `.ios-shell > .modal-scrim`, above the workspace sheet.

## Keys

Generate Ed25519 Key creates the key on the device with `ssh-key` (comment `<name>@oxbit-ios`). Import Key… accepts a pasted key or a file from the Files picker, with an optional passphrase. Import goes through `russh::keys::decode_secret_key`, which reads OpenSSH, PEM (PKCS#1), and PKCS#8 keys, encrypted or not. The decrypted key is re-encoded as unencrypted OpenSSH before it is stored, so the passphrase is not saved. `PASSPHRASE_REQUIRED` and `KEY_INVALID` errors reach the dialog.

`SshKeys.swift` stores one generic-password item per key or password:

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
- `connect.rs` opens a session channel, requests the `sftp` subsystem, and passes the channel stream to `SftpSession::new`. Exec and port forwarding can open more channels on `Connection.handle` (`channel_open_session`, `channel_open_direct_tcpip`); nothing calls them yet.

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

- Upload picks files with `UIDocumentPickerViewController` (`asCopy`), which copies them under the app's temporary directory. Rust accepts only paths there. Each file is written to a temporary name in the target folder and renamed into place. An existing name fails the upload with `EXISTS` before any bytes move. The temporary copies are deleted afterwards.
- Download picks a device folder with the existing folder picker, keeps its security scope open for the transfer, then closes and forgets the bookmark. Files and folders (up to 10,000 entries) download into a hidden staging folder inside the destination, which is renamed to the final name on success.
- Both send 256 KiB chunks and emit `ios-ssh-transfer:<transferId>` events with `transferred`, `total`, and `file`. `ios_ssh_transfer_cancel` sets a flag that the copy loop checks between chunks; a cancelled transfer removes its temporary files and returns `CANCELLED`.

## Build notes

- `russh = "=0.64.1"` and `ssh-key = "=0.7.0-rc.11"` are pinned together because russh requires that exact `ssh-key` release. Upgrade both in one change.
- russh's default features use `aws-lc-rs` 1.18.1. `aws-lc-sys` 0.45.0 builds with its `cc` builder for `aarch64-apple-ios` and `aarch64-apple-ios-sim`, with no cmake, nasm, bindgen, or clang settings. Its symbols carry the `aws_lc_0_45_0` prefix, so they link next to the vendored OpenSSL from `git2` without duplicate symbols.
- Standalone `cargo build` for iOS needs `IPHONEOS_DEPLOYMENT_TARGET=26.0`. Without it, `cc` targets the SDK version and `ld` warns that aws-lc objects were built for a newer iOS. Xcode-driven Tauri builds set the variable.
- Key generation uses `getrandom` 0.4 (`sys_rng`) through `ssh_key::rand_core::UnwrapErr(getrandom::SysRng)`.
- Host `cargo test` runs on a machine with little free disk use `CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0` to keep the target directory small.
- License notices for the added crates ship in `apps/web/public/licenses/ios-ssh-crates.txt`, built from each crate's published license files.

## Testing

- Unit tests: `cargo test --locked` in `apps/ios/src-tauri` (keys, hosts, known hosts) and `cargo test --locked -p tauri-plugin-oxbit-files` in the same folder (request validation and metadata filtering).
- Live tests: `bun run ios:ssh-live` builds `scripts/remote/sshd.Dockerfile`, starts a container with a key port and a password port, and runs the ignored `ssh::live_tests` test. It covers key auth with a passphrase-protected key, first-use trust, SFTP list/read/write/conflict/mkdir/rename/delete, upload and download with progress and cancel, password auth, reconnect after `docker restart`, and refusal after the container's host keys are regenerated. The script removes the container afterwards.
- UI: `bunx playwright test -c tests/ios/playwright.config.ts ssh.spec.ts` with the in-memory SSH bridge in `tests/ios/ssh-bridge.ts`. `OXBIT_SSH_SCREENSHOTS` sets the screenshot folder (default `evidence/ios-ssh`).

## Not implemented

- Git over SSH remotes, a terminal, and the remote runtime over SSH.
- Keyboard-interactive authentication, SSH agents, certificates, and jump hosts.
- Port forwarding and exec channels in the UI.
- Change notifications for SSH workspaces. The explorer refreshes after Oxbit's own file operations and uploads.

## References

- russh 0.64.1: https://docs.rs/russh/0.64.1/russh/
- russh-sftp 3.0.1: https://docs.rs/russh-sftp/3.0.1/russh_sftp/
- ssh-key 0.7.0-rc.11: https://docs.rs/ssh-key/0.7.0-rc.11/ssh_key/
- aws-lc-rs platform support: https://aws.github.io/aws-lc-rs/platform_support.html
- Keychain item accessibility: https://developer.apple.com/documentation/security/ksecattraccessiblewhenunlockedthisdeviceonly
- UIDocumentPickerViewController: https://developer.apple.com/documentation/uikit/uidocumentpickerviewcontroller
- SSH transport and host keys: https://www.rfc-editor.org/rfc/rfc4253
- SFTP version 3 draft: https://datatracker.ietf.org/doc/html/draft-ietf-secsh-filexfer-02
