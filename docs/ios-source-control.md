# iOS source control integration

Created: 2026-10-02. Last updated: 2026-10-07.

## Device repositories

The iOS workspace screen and `git.account` command open **Git Accounts and Commit Author**. Save an author name and email, optionally connect a GitHub personal access token, and optionally connect one Gitea server with an access token. Disconnecting either account keeps the author identity.

Open a repository folder from Files or choose **Clone Repository…** on the workspace screen. Clone writes into the Oxbit Documents folder and opens the repository. Cloned folders appear in recents and reopen after relaunch. Source Control uses libgit2 on the device for changes, staging, commits, history, branches, remotes, stashes, and conflict recovery. Connected computer workspaces use the runtime’s Git installation and credential helpers.

HTTPS remotes support public repositories. Private GitHub repositories use the saved personal access token; pushing requires repository Contents read and write access. Private Gitea repositories use the saved Gitea token; the token needs the `read:user` scope, and pushing needs `write:repository`. File remotes stay inside the selected workspace. SSH authentication and pull requests are outside this interface. Native commits do not run Git hooks. Configure a repository’s Git author in its config or save an author through **Git Accounts and Commit Author**.

## Credentials

The Files plugin stores one profile in Keychain with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. Public `git_credentials` calls accept `get`, `save`, `forget`, `connectGitea`, and `forgetGitea`. They return `authenticated`, `login`, `name`, `email`, and a `gitea` object with `authenticated`, `url`, `host`, and `login`. Rust rejects public `read` requests and filters token fields from responses, including the Gitea token. Internal `read_git_credentials()` supplies the token to native Git commands. Token validation uses [`GET /user`](https://docs.github.com/en/rest/users/users#get-the-authenticated-user), Bearer authentication, and supported [API version `2022-11-28`](https://docs.github.com/en/rest/about-the-rest-api/api-versions). The ephemeral URLSession refuses redirects, bounds responses to 64 KiB, and uses request/resource timeouts of 15/20 seconds. Git sends the token to `github.com` over HTTPS and rejects remote redirects.

**Connect Gitea** accepts an HTTPS server address with an optional sub-path, such as `https://git.example.com/gitea`. The address must not contain credentials, a query, or a fragment. The plugin drops port 443, lowercases the host, and stores the `host[:port]` authority with the profile. Token validation calls [`GET /api/v1/user`](https://docs.gitea.com/development/api-usage) on that server with `Authorization: token`, under the same redirect, size, and timeout limits as GitHub. Git sends the Gitea token only to remotes whose HTTPS authority matches the saved authority, ignoring case and an explicit `:443`. Progress and error output redact both tokens.

## Transport

`createWorkbenchSession` accepts `git: RpcClient`. Source Control uses it ahead of the runtime for `git.*` requests and Git events. Runtime filesystem comparisons keep their existing transport. Native filesystem watches refresh Source Control. `IosGitClient` scopes calls and cancellation by root ID and request UUID, waits for native completion before disposal, and filters progress to active requests.

## Backend references

Consult the [git2 API](https://docs.rs/git2/0.21.0/git2/) when changing operations. The enabled features are HTTPS, vendored libgit2, and vendored OpenSSL. The published [build script](https://docs.rs/crate/libgit2-sys/0.18.8+1.9.7/source/build.rs) selects SecureTransport on Apple targets; its [Cargo manifest](https://docs.rs/crate/libgit2-sys/0.18.8+1.9.7/source/Cargo.toml.orig) also enables OpenSSL through HTTPS. Vendoring supplies that build dependency.

The iOS CI simulator build compiles the Swift plugin. Device Keychain behavior and live GitHub and Gitea validation remain unrun.
