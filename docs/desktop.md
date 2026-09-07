# Oxbit desktop

Oxbit uses Tauri 2 and the shared React workbench. The desktop targets are **Apple Silicon macOS 26+** and **Ubuntu 24.04+ x64**. Ubuntu 24.04 is the build baseline and minimum supported Linux distribution. Windows, Intel Macs, Linux arm64, and app stores are outside this implementation.

The application identifier is `com.yannelli.oxbit`. `package.json` at the repository root supplies the application and release version. Browser and CLI commands keep their existing behavior. Read [desktop acceptance](../evidence/desktop-acceptance.md) for what has actually been tested; an unsigned build is not a distribution or update acceptance result.

## Develop and build

Install Node **24.20.0**, pnpm **9.15.0**, Rust **1.97.1**, and the native compiler tools. macOS needs Xcode Command Line Tools. Ubuntu needs:

```sh
sudo apt-get install build-essential python3 pkg-config libssl-dev \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev patchelf libxdo-dev libfuse2t64 xdg-utils xvfb dbus-x11
pnpm install --frozen-lockfile
pnpm desktop:dev
```

Desktop development uses the explicit `http://127.0.0.1:9280` Vite origin. It does not start the browser CLI daemon. Production loads bundled assets with Tauri's application protocol; project recovery does not depend on a runtime port.

| Command | Purpose |
| --- | --- |
| `pnpm desktop:prepare` | Verify and stage the target's complete runtime |
| `pnpm desktop:runtime:test` | Exercise the staged runtime outside the checkout with minimal environment and read-only resources |
| `pnpm desktop:dev` | Prepare, check the runtime, and run Tauri with frontend hot reload |
| `pnpm desktop:build` | Build unsigned local `.app`/DMG or AppImage/`.deb`, then validate structure |
| `pnpm desktop:check` | Production frontend build, Rust formatting, Clippy, and Rust tests |
| `pnpm desktop:test:build` | Build a debug app with the embedded native WebDriver |
| `pnpm desktop:test:native` | Run real WebView acceptance against the test app |
| `pnpm desktop:test:installed -- /absolute/path/to/oxbit-desktop` | Check a Linux production installation with isolated state and minimal PATH |
| `pnpm desktop:validate` | Validate staged resources and existing unsigned artifacts |
| `pnpm desktop:release` | Require release credentials, sign resources, and build signed artifacts |

On Linux run native tests with `xvfb-run -a dbus-run-session -- pnpm desktop:test:native`. Native tests use isolated temporary projects, application state, and the separate `com.yannelli.oxbit.native-test` application identity so a running release app does not intercept test launches. The `native-test` Rust feature and `VITE_DESKTOP_TEST=1` must be used together. Production compilation rejects the test feature and production validation rejects frontend test hooks. No remote page receives native capabilities.

Continue to run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm test:browser` for browser/CLI regressions. Desktop verification is additional to these commands. With Weston installed,
`xvfb-run -a dbus-run-session -- node scripts/desktop/wayland.mjs` runs the same
WebView journeys with the GTK Wayland backend under a headless compositor.
An outer X11 display remains available for clipboard interoperability.

## Runtime packaging

`scripts/desktop/binaries.json` pins Node, ripgrep, and Linux packaging helpers with SHA-256 checksums.
`bundle-tools.mjs` seeds and verifies Tauri’s helper cache before packaging;
plugin scripts use immutable upstream commits. Changed upstream binary assets
fail the checksum gate and require an explicit reviewed pin update. `desktop:prepare` stages ordinary files under `apps/desktop/src-tauri/resources/runtime`, including the production dependency tree, TypeScript, the language server, `node-pty`, spawn helpers, dependency notices, and a package inventory. There are no links to pnpm's store. Downloads cache in `.desktop-cache`; both cache and generated resources are ignored by Git.

The packager repairs executable modes before macOS signing. Only native prebuilds for the selected target remain. Linux builds compile native modules on Ubuntu 24.04 when no prebuild exists. Each release job builds on its actual target architecture; cross-compilation is not the release path.

Linux packages also include Ubuntu copyright files and common license texts.
The inventory labels these as a build-environment attribution superset, because
the AppImage helper can miss system-library notices across Ubuntu's merged
`/lib` and `/usr/lib` paths. This list does not claim every build dependency ships.

The staged-runtime gate copies the result to a path with spaces and Unicode outside the checkout, makes application resources read-only, uses no Node or pnpm on PATH, and verifies readiness, filesystem saves, bundled search, real PTY output/resize, TypeScript completion, trust enforcement, bad authentication/origin rejection, stable recovery, and cleanup on parent-channel loss.

## Projects and recovery

Open Folder starts an editable, untrusted project. Trust Workspace Tools explicitly enables terminals, tasks, Git, language services, and runtime extensions. Selecting a folder never grants tool trust automatically.

`desktop.projects.openBehavior` defaults to `currentWindow`. Projects remain live while another project is active; only the active workbench is mounted. Select `newWindow` to open new projects in separate windows. Open in New Window and Move Project to New Window are also explicit actions. A canonical directory has one owner and one runtime. Duplicate opens focus that owner. File-open events inside an existing project reuse it.

A move flushes drafts, layout, and settings, releases the old frontend session, rotates its connection credential, and transfers ownership. The runtime and existing tools continue. Runtime failures retain drafts, mark tools ended, and offer Restart Runtime. Commands or commits with an uncertain result are never replayed automatically.

State resides in the platform application-data directory:

- macOS: `~/Library/Application Support/com.yannelli.oxbit`
- Linux: `$XDG_DATA_HOME/com.yannelli.oxbit`, normally `~/.local/share/com.yannelli.oxbit`

`session.json` stores window geometry/order, active projects, recent paths, and shared user settings. `projects/<canonical-path-sha256>/ui.json` holds project recovery and layout. `projects/<key>/runtime/` holds trust and runtime state. Native writes are serialized, atomically replaced, and flushed; user settings merge per-setting patches across windows. Runtime credentials stay in memory and the private parent/child channel, with only hashes in runtime state. CLI state under `~/.oxbit` remains independent.

A runtime port may change after every launch without changing the project identity. Missing directories remain visible with recovery actions. Reconnect the volume and choose Restart Runtime. For corrupt application state, quit Oxbit and preserve a copy of the entire application-data directory before repairing a file or restoring a backup. Do not delete recovery files to troubleshoot an unavailable project.

Project/window close, Quit, and update restart coordinate Save All / Discard / Cancel across affected windows. Active terminals/tasks are listed in the warning. Cancelling any window cancels the transaction before sessions are disposed. Save or persistence errors keep the application available for recovery. Explicit Quit preserves the project/window list for restoration; closing a project removes it from that list while retaining recovery storage. macOS remains in the Dock after closing its last window; Linux exits.

## Native actions and developer tools

Folder/file dialogs, dragged paths, Finder/file-manager open events, and subsequent launches use the same coordinator. Native menus and the command palette provide open, move, save, close, reveal, workspace import/export, Developer Tools, and Check for Updates. Import/export uses native file dialogs. Clipboard and approved external URLs use native integrations. `Cmd/Ctrl+O` opens a folder, `Cmd/Ctrl+Shift+O` opens a file, and `Ctrl+Tab` switches projects; existing editing shortcuts remain available.

The login-shell environment is imported from a neutral directory with a timeout and output bound. Internal Node, ripgrep, and TypeScript use absolute bundled paths. Project terminals and tasks keep the user's environment and Node selection. Git credential helpers, SSH agent, proxy, `GH_CONFIG_DIR`, enterprise configuration, and inherited authentication variables remain available to Git/gh. Diagnostics return paths, versions, and an explicit authentication status; authentication output and tokens never enter the frontend.

Set `desktop.tools.gitPath` or `desktop.tools.ghPath` to an absolute executable path if automatic resolution fails. Restart the project's runtime after changing its Git path. The Developer Tools dialog checks GitHub authentication only after selecting Check GitHub Authentication. Sign In with gh in Terminal runs an interactive login only on request and only in a trusted project. No login or account-changing operation runs automatically.

The existing `oxbit` command still starts the browser editor. `oxbit --desktop [path]` opens the installed desktop application. Linux packages install the distinct `oxbit-desktop` binary/desktop entry. macOS bundles an optional launcher at `Oxbit.app/Contents/Resources/oxbit-desktop`; add it to your PATH explicitly if desired. Installation never replaces a pre-existing `oxbit` command.

## Signing and releases

Use the root [macOS signing and notarization worksheet](../MACOS_SIGNING_AND_NOTARIZATION.md)
for fill-in configuration, secure local Keychain setup, final-DMG submission, and
the recorded local Xcode test. `scripts/desktop/notarize.mjs` accepts
`APPLE_KEYCHAIN_PROFILE` and explicit `--app` / `--dmg` paths for local builds.

`.github/workflows/desktop.yml` builds macOS arm64 and Ubuntu 24.04 x64. Pull requests produce unsigned artifacts without signing secrets. Matching version tags (`v<root package version>`) produce a **draft** release in `yannelli/oxbit`. Both platform jobs must pass before artifact upload and manifest generation. Publishing the draft remains a separate release decision.

Configure these GitHub Actions secrets:

| Name | Purpose |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64 Developer ID Application certificate, including private key, in P12 format |
| `APPLE_CERTIFICATE_PASSWORD` | P12 import password |
| `APPLE_SIGNING_IDENTITY` | Exact Developer ID Application signing identity |
| `APPLE_ID` | Apple account for notarization |
| `APPLE_PASSWORD` | App-specific notarization password |
| `APPLE_TEAM_ID` | Apple developer team ID |
| `TAURI_SIGNING_PRIVATE_KEY` | Separate Tauri updater signing private key |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Updater-key passphrase, if configured |

Set the repository **variable** `OXBIT_UPDATER_PUBLIC_KEY` to the matching public key. It is embedded at build time. Keep both private keys outside the repository; no production key is generated by the build. See [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/) and [updater signing](https://v2.tauri.app/plugin/updater/).

Nested Mach-O executables/libraries are signed first. Bundled Node receives the JIT, unsigned executable memory, and library-loading entitlements it needs. The application uses the hardened runtime without granting Node's exceptions to the main executable. Tauri signs/notarizes the app; the separate `notarize.mjs` step signs, submits, staples, validates, and assesses the final DMG. Validate the downloaded artifact on a separate Mac before publication.

Signed macOS `.app.tar.gz` and Linux `.AppImage` update artifacts have separate `.sig` files. `draft-release.mjs` uploads both platform artifacts first, then `manifest.mjs` verifies their presence and writes the GitHub-hosted `latest.json`. An existing published release is never overwritten by this script. The app checks on startup and on request; installation requires acceptance. Invalid signatures or download failures leave the installed app untouched. Restart runs the same multi-window close flow. `.deb` installations link to package downloads instead of replacing themselves with an AppImage. Unsigned development builds have no working production updater configuration.

### Local macOS builds

`codesign` reads the Developer ID private key from the login Keychain, so a local
signed build must run in your GUI login session. `launchctl managername` prints
`Aqua` there and `Background` in an agent shell, an `ssh` session, or a launchd
job; in a background session `codesign` fails with `errSecInternalComponent`.

DMG bundling runs an AppleScript that arranges the Finder window. It needs
Automation permission for the terminal application, and without it `bundle_dmg.sh`
exits 64 after `Finder got an error: AppleEvent timed out. (-1712)`. Set `CI=1`
to pass `--skip-jenkins` and skip that cosmetic step; GitHub Actions already does.

```sh
export APPLE_SIGNING_IDENTITY="Developer ID Application: Ryan Yannelli (2P58V89SR7)"
export APPLE_TEAM_ID="2P58V89SR7"
CI=1 pnpm desktop:build
```

## Release acceptance still required

Before publishing, run the recorded acceptance matrix on actual installed artifacts, including a clean Ubuntu 24.04 x64 installation under X11 and Wayland, and downloaded-DMG/Gatekeeper checks on macOS 26+. Test without system Node/pnpm, missing Git/gh, existing gh authentication, read-only application resources, spaces/Unicode paths, native dialogs/clipboard, accessibility, conflicts, extensions, and collaboration. The browser collaboration regression suite does not establish native desktop sharing acceptance.

Finally install a signed previous version, open multiple projects with unsaved files and active tools, and accept a signed version-to-version update. Exercise Cancel, Save All, Discard, offline checks, invalid signatures, interrupted downloads, and an unwritable installation. Verify restored drafts/layout and no replayed tools after restart. These gates cannot be replaced by compilation or an unsigned installer; record platform/version and evidence in the acceptance file.
