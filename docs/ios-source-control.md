# iOS source control integration

Created: 2026-10-02. Last updated: 2026-10-08.

## Device repositories

Open **Git Accounts and Commit Author** from the Source Control toolbar, the workspace screen, Settings, or the `git.account` command. Save an author name and email, then add GitHub accounts with personal access tokens and Gitea accounts with a server address and access token. The Accounts list shows each account’s login, provider, host, and a **Default** badge. The first account for a host becomes its default; **Make Default** moves the badge, and **Remove** asks to confirm. Removing a default makes the next account for that host the default. Removing accounts keeps the author identity.

When a device repository is open, **This Repository** chooses the account for that repository: **Default** follows the host’s default, or pick an account on the remote’s server. The list shows accounts for the host of the upstream remote, then `origin`, then the first remote.

Open a repository folder from Files or choose **Clone Repository…** on the workspace screen. Clone writes into the Oxbit Documents folder and opens the repository. Cloned folders appear in recents and reopen after relaunch. Source Control uses libgit2 on the device for changes, staging, commits, history, branches, remotes, stashes, and conflict recovery. Connected computer workspaces use the runtime’s Git installation and credential helpers.

HTTPS remotes support public repositories. Private GitHub repositories use a GitHub account’s personal access token; pushing requires repository Contents read and write access. Private Gitea repositories use a Gitea account’s token; the token needs the `read:user` scope, and pushing needs `write:repository`. For a remote, Git uses the repository’s chosen account when its host matches the remote, then the default account for the remote’s host. Without either, the operation fails with “Add an account for host in Git Accounts and Commit Author from the Source Control toolbar”. Clone uses the default account for the server; make an account the default before cloning its private repositories. File remotes stay inside the selected workspace. SSH authentication and pull requests are outside this interface. Native commits do not run Git hooks. Configure a repository’s Git author in its config or save an author through **Git Accounts and Commit Author**.

## Credentials

The Files plugin stores one profile in Keychain with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`: the author `name` and `email` and an `accounts` list. Each account has a UUID `id`, `provider` (`github` or `gitea`), `host`, `url` for Gitea, `login`, `token`, and `isDefault`. GitHub accounts use the host `github.com`. Each host with accounts has one default. Adding a token for a known provider, host, and login replaces that account’s token and keeps its ID. The profile holds at most 12 accounts in 64 KiB.

Public `git_credentials` calls accept `get`, `save` (`name`, `email`), `addGitHub` (`token`), `addGitea` (`url`, `token`), `remove` (`id`), and `setDefault` (`id`). They return `name`, `email`, and `accounts` with `id`, `provider`, `host`, `url`, `login`, and `isDefault`. Rust rejects public `read` requests and copies only those fields from responses, so tokens stay native. Internal `read_git_credentials()` supplies the tokens to native Git commands. Token validation uses [`GET /user`](https://docs.github.com/en/rest/users/users#get-the-authenticated-user), Bearer authentication, and supported [API version `2022-11-28`](https://docs.github.com/en/rest/about-the-rest-api/api-versions). The ephemeral URLSession refuses redirects, bounds responses to 64 KiB, and uses request/resource timeouts of 15/20 seconds. Git rejects remote redirects.

**Add Gitea Account** accepts an HTTPS server address with an optional sub-path, such as `https://git.example.com/gitea`. The address must not contain credentials, a query, or a fragment. The plugin drops port 443, lowercases the host, and stores the `host[:port]` authority with the account. Token validation calls [`GET /api/v1/user`](https://docs.gitea.com/development/api-usage) on that server with `Authorization: token`, under the same redirect, size, and timeout limits as GitHub. Git sends a token only to remotes whose HTTPS authority matches the account’s host, ignoring case and an explicit `:443`. Progress and error output redact every saved token.

### Repository accounts

The repository choice is stored in app storage under the workspace root’s scope (`workspaces/<root id>/ui.json`, key `git-account`), next to the workspace’s other state. The root ID hashes the canonical folder path. Keeping the choice outside the repository stops repository content, such as a `.git/config` from a shared folder, from selecting an account, and keeps device-local account IDs out of synced repositories. `ios_git_request` reads the key before each operation. A choice whose account was removed, or whose host differs from the remote, falls back to the host’s default.

### Migration

Profiles saved before multiple accounts held one GitHub `token` and `login` and one `gitea` object. The first Keychain read converts them into accounts that are the defaults for `github.com` and the Gitea host, with new UUIDs and unchanged tokens, then saves the profile without the old fields. `apps/ios/plugins/oxbit-files/ios/Sources/GitCredentialProfile.swift` holds the profile model and migration; `bun run ios:check` compiles it with `Tests/GitCredentialProfile/main.swift` and runs the tests.

## Transport

`createWorkbenchSession` accepts `git: RpcClient`. Source Control uses it ahead of the runtime for `git.*` requests and Git events. Runtime filesystem comparisons keep their existing transport. Native filesystem watches refresh Source Control. `IosGitClient` scopes calls and cancellation by root ID and request UUID, waits for native completion before disposal, and filters progress to active requests.

## Backend references

Consult the [git2 API](https://docs.rs/git2/0.21.0/git2/) when changing operations. The enabled features are HTTPS, vendored libgit2, and vendored OpenSSL. The published [build script](https://docs.rs/crate/libgit2-sys/0.18.8+1.9.7/source/build.rs) selects SecureTransport on Apple targets; its [Cargo manifest](https://docs.rs/crate/libgit2-sys/0.18.8+1.9.7/source/Cargo.toml.orig) also enables OpenSSL through HTTPS. Vendoring supplies that build dependency.

The iOS CI simulator build compiles the Swift plugin. Device Keychain behavior and live GitHub and Gitea validation remain unrun.
