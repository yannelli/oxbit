# Desktop acceptance — 2026-09-07

The minimum Linux target is **Ubuntu 24.04 x64**, as requested. The macOS target
is **Apple Silicon, macOS 26+**. The desktop implementation and unsigned local
packaging have been exercised; **distribution acceptance is not complete**.
No release was published and no production signing credentials were generated.

## Baseline and regression checks

The checkout was already dirty, and browser, language, branding, and theme work
continued during implementation. Those changes were retained. Test totals below
describe the observed checkout, not tests attributable solely to the desktop work.
The installers capture the desktop build recorded below. Further local-language
work was added concurrently after those builds; it is preserved in the working
tree and is not claimed to be included in these already-built installers.

| Check | Recorded result |
| --- | --- |
| Initial unit/integration baseline | [158 passed, 9 failed, across 34 files](desktop/baseline-unit.log) |
| Initial browser baseline | [25 passed](desktop/baseline-browser.log) |
| Final unit/integration run | [202 passed, across 38 files](desktop/unit.log) |
| Final browser run | [44 passed](desktop/browser.log) |
| ESLint and TypeScript project build | Passed for the recorded desktop integration build |
| Later whole-checkout TypeScript check | [Failed in concurrent theme and managed-language edits](desktop/final-types.log); those changes are outside the installer snapshot |
| Runtime, SDK/example, and browser production builds | Passed |
| Rust formatting and Clippy with warnings denied | Passed on macOS and Ubuntu 24.04 |
| Rust tests | 8 passed on each platform |
| macOS native WebView journeys | [14 passed](desktop/native-macos.log) |
| Ubuntu 24.04 native WebView journeys, X11 | [14 passed](desktop/native-linux.log) |
| Ubuntu 24.04 native WebView journeys, Wayland | [14 passed](desktop/native-linux.log) |

The initial runtime failures involved macOS's `/var` and `/private/var` aliases.
Workspace and private roots now use canonical paths without relaxing symlink
containment. Browser fixture isolation was also repaired: language tests no
longer reuse the file changed by save/recovery journeys, and the filesystem
provider journey accommodates the workspace dialog's descriptive button text.

The native suite covers untrusted folder opening, denial of arbitrary frontend
filesystem roots, memory-held credentials, dirty project switching, duplicate
focus, project Save All/Discard/Cancel, nested-file open events, real PTY/search,
clipboard, TypeScript completion, task cancellation, Git staging, disk conflicts,
bundled SDK extension loading, runtime crash recovery, shared settings, new-window
behavior, window transfer without a runtime restart, old-window authorization
denial, delayed close preparation, and cancellation of a multi-window quit.

The extension journey found and fixed a desktop integration issue: custom
application URLs were rejected by the shared extension loader. Only the exact
desktop application origin is added by the desktop host. Other custom origins
remain rejected. Native test builds have their own application identity, so a
running production app cannot intercept their launches.

## Runtime and installed artifacts

The staged runtime gate passed on both platforms, including a copy outside the
checkout with spaces/Unicode, read-only resources, and a minimal environment.
It exercised private readiness, filesystem writes, bundled ripgrep, a real PTY
and resize, bundled TypeScript completion, trust checks, authentication and
origin rejection, parent-loss cleanup, and stable identity after restart.

Unsigned artifacts are copied to the ignored `apps/desktop/artifacts/` directory:

- `Oxbit_0.1.0_aarch64.dmg`
- `Oxbit_0.1.0_amd64.deb`
- `Oxbit_0.1.0_amd64.AppImage`

[Artifact metadata](desktop/artifacts.json) contains sizes and SHA-256 hashes.
The package validator checks executable modes, ordinary dependency files,
TypeScript/PTY assets, dependency notices, the Ubuntu 24.04 package minimum, and
the absence of native test drivers and frontend test access in release inputs.

On macOS an unsigned app was copied from a mounted DMG to a directory outside the
checkout. Native UI checks opened a real project, saved through Cmd+S, opened and
cancelled a folder dialog, quit/relaunched with restoration, and checked that
closing the last window retained the Dock application. The host was macOS
**27.0 (26A5425a), arm64**, not a minimum-version machine. The final extension fix
also passed the automated native suite; the exact final DMG still needs the
downloaded-artifact and Gatekeeper release checks below.

A fresh Ubuntu **24.04 x64** container installed the `.deb` and launched its
production WebView with isolated application state. No system Node, pnpm, Git,
or gh was installed. The workbench opened and persisted a real project whose
path contained spaces and Unicode. The AppImage received the same check using
its own application resources. Neither artifact used the checkout at runtime.
The `.deb` was uninstalled before the final AppImage launch, so the AppImage
could not fall back to resources installed by the Debian package.
The [installed Linux log](desktop/installed-linux.log) records both launches.

Linux verification ran under Docker's x64 emulation on the arm64 Mac. The local
x64 Rust compiler crashed under that emulator, so local Linux compilation used
the pinned **Rust 1.97.1 arm64 host compiler with the x64 target** and Ubuntu 24.04
x64 libraries. Native CI is configured to use an actual x64 runner. Docker's
default handler also rejected the static AppImage bootstrap: an explicit
Ubuntu-provided arm64 QEMU executable launched the unmodified, checksum-verified
AppImage packaging helper and installed AppImage. This is an emulation caveat,
not evidence of a native x64 installation failure or native hardware acceptance.
The X11 suite used Xvfb; the Wayland suite used Weston 13 with a headless pixman
compositor and an outer X11 display for clipboard interoperability.

## Subsequent local Apple signing test

On 2026-09-07, the recorded macOS 0.1.0 installer snapshot was copied and signed
with **Developer ID Application: Ryan Yannelli (2P58V89SR7)** using the installed
**Xcode 27.0 (27A5194q)**. All four bundled native binaries and the application
passed strict signature verification. Xcode uploaded the app using an existing
account, Apple issued a ticket, and the packaged app passed both stapler validation
and Gatekeeper with `source=Notarized Developer ID`.

The separate `Oxbit_0.1.0_aarch64_local-signed.dmg` contains that stapled app and
has a verified Developer ID signature. **The DMG itself is not yet notarized**:
its Gatekeeper assessment is `Unnotarized Developer ID`, and no DMG ticket is
stapled. A notarytool Keychain profile was not configured. The root
[signing worksheet](../MACOS_SIGNING_AND_NOTARIZATION.md) provides fill-in fields
and the commands to finish final-DMG notarization. No private key was exported,
no production credential was generated, and the original unsigned artifacts were
preserved. [Local signing evidence](desktop/local-macos-signing.json) records the
new artifact's hash and the exact results. The [signed runtime smoke check](desktop/local-macos-signed-runtime.log)
passed, including a real PTY and TypeScript completion. The earlier unsigned-artifact
metadata above remains a record of the original build.

## Signed build of the current tree, 2026-09-07 10:26 EDT

The working tree — including the theme, icon-pack, and managed-language work that
postdates the installer snapshot above — was rebuilt and signed with **Developer ID
Application: Ryan Yannelli (2P58V89SR7)**. Xcode was not used; the Command Line
Tools SDK 27.0 supplied `codesign`. The application, bundled Node, ripgrep, and
`pty.node` all carry that identity with the hardened runtime, and
`codesign --verify --deep --strict` passes on the application and on the installed
copy at `/Applications/Oxbit.app`. `LSMinimumSystemVersion` and the executable's
`minos` are both **26.0**.

The signed DMG is `apps/desktop/artifacts/Oxbit_0.1.0_aarch64_signed.dmg`
(sha256 `c1db082d…`). It is **not notarized**: Gatekeeper assesses the application
as `Unnotarized Developer ID`, and no notarytool credential is configured.
[Signed build evidence](desktop/local-macos-signed-build.json) records the checks.

Two host-specific findings are recorded in [desktop setup](../docs/desktop.md):
`codesign` cannot reach the login Keychain from a background session, and
`bundle_dmg.sh` exits 64 when its Finder AppleScript times out without Automation
permission. `CI=1` skips that AppleScript step.

## Outstanding acceptance

These items remain open; the implementation must not be described as a fully
accepted signed release:

- Configure final-DMG notarization credentials, submit and staple the signed
  DMG, and verify Gatekeeper for a downloaded copy on a separate Mac. App signing
  and app notarization passed in the subsequent local test above.
- Configure the separate production updater public/private key pair. No
  production updater key was available in this session.
- Perform an actual signed version-to-version update with multiple projects,
  unsaved files, and active tools. Verify all Save All/Discard/Cancel paths,
  invalid signatures, offline checks, interrupted downloads, and unwritable
  installations. Compilation does not establish these outcomes.
- Run installed-artifact acceptance on actual Ubuntu 24.04 x64 desktops under
  X11 and Wayland, and on macOS 26. Verify accessibility and OS integration
  beyond the recorded native and manual journeys.
- Exercise existing gh authentication, enterprise/proxy/SSH-agent setups,
  interactive gh login, and platform browser handoff with test accounts. No
  login or account-changing command was run automatically.
- Complete native desktop invitation/join acceptance for collaboration. The
  collaboration transport remains active in shared documents and browser
  collaboration journeys pass, but those results do not establish a desktop
  invitation workflow: desktop-owned runtimes bind loopback and do not serve
  the browser pairing application.
- Execute the GitHub Actions workflow and inspect both platform jobs and the
  draft release. Workflow code was added; remote CI and release jobs were not run.
- Integrate and reverify the subsequent theme/local-language/managed-server work
  before producing a release from the latest working tree. The final additional
  typecheck recorded errors in those concurrently changing modules; this report
  does not claim the current, still-changing checkout is wholly green.

See [desktop setup, release, and recovery](../docs/desktop.md) for commands,
credential names, update policy, state locations, and recovery instructions.
