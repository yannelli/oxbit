# macOS signing and notarization worksheet

Oxbit (`com.yannelli.oxbit`) targets Apple Silicon and macOS 26 or newer.
The root `package.json` supplies its version. Ubuntu's minimum remains 24.04.

Local signing needs nothing from a password manager: the Developer ID private key
is already in the login Keychain. Only DMG notarization and CI need new secrets.
Keep passwords, private keys, and certificate exports out of this document and Git.

## Your configuration

| Setting                                                | Value                                                    |
| ------------------------------------------------------ | -------------------------------------------------------- |
| Bundle identifier                                      | `com.yannelli.oxbit`                                     |
| Developer ID Application identity                      | `Developer ID Application: Ryan Yannelli (2P58V89SR7)`   |
| Identity SHA-1                                         | `3BBDCC0627FDF29581877804EC3D107A0AD7137C`               |
| Apple Developer team ID / App ID prefix                | `2P58V89SR7`                                             |
| App Group                                              | `group.com.yannelli.oxbit`                               |
| iCloud container                                       | `iCloud.com.yannelli.oxbit`                              |
| Services ID                                            | `dev.oxbit.oxbitcloud`                                   |
| Xcode Developer directory (optional, see below)        | `/Applications/Xcode-beta.app/Contents/Developer`        |
| Local notarytool Keychain profile name                 | `oxbit-notary`                                           |

Still outstanding, because each is a secret nobody has created yet:

| Secret                                                          | Needed for               | Location |
| ---------------------------------------------------------------- | ------------------------ | -------- |
| App-specific password, or an App Store Connect API key (`.p8`)  | DMG notarization         | ____     |
| Exported `.p12` (certificate + private key) and its password    | GitHub Actions signing   | ____     |
| Tauri updater private key and password                          | Signed in-app updates    | ____     |

Use a **Developer ID Application** identity for direct downloads. Apple Development
and Apple Distribution identities serve different distribution workflows. Apple's
[signing documentation](https://developer.apple.com/documentation/xcode/creating-distribution-signed-code-for-the-mac/)
describes these requirements.

## Local DMG workflow

Xcode is not required. `codesign`, `xcrun notarytool`, and `stapler` all ship with
the Command Line Tools, which is what `xcode-select -p` currently points at.
Set `DEVELOPER_DIR` only to pin the installed Xcode 27.0 for this terminal; it does
not change the machine's global `xcode-select` setting.

Run from the repository root:

```sh
export APPLE_SIGNING_IDENTITY="Developer ID Application: Ryan Yannelli (2P58V89SR7)"
export APPLE_TEAM_ID="2P58V89SR7"
export APPLE_KEYCHAIN_PROFILE="oxbit-notary"
export DEVELOPER_DIR="/Applications/Xcode-beta.app/Contents/Developer" # optional

security find-identity -v -p codesigning
xcrun notarytool --version
```

Signing reads the private key from the login Keychain, so run this from a terminal
in your own login session. A background session — an agent's shell, `ssh`, a
launchd job — sees the Keychain as locked and `codesign` fails with
`errSecInternalComponent`. Check with `launchctl managername`; it must print `Aqua`.
Unlock a background session explicitly with `security unlock-keychain`.

Create an app-specific password in your Apple account, then store it using the
secure prompt below. Do **not** add a `--password` argument or paste the password
into this file. This command validates the credentials and saves them in Keychain:

```sh
xcrun notarytool store-credentials "$APPLE_KEYCHAIN_PROFILE" \
  --apple-id "<your Apple Developer account email>" \
  --team-id "$APPLE_TEAM_ID"

xcrun notarytool history --keychain-profile "$APPLE_KEYCHAIN_PROFILE"
```

The profile belongs to this Mac and user; it is not transferred to GitHub Actions.
Apple also supports App Store Connect API keys if you prefer that authentication
method. See Apple's [custom notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow).

Install the repository's pinned Node, pnpm, and Rust toolchains, then build the
version you intend to distribute. Review the current working tree and run the
[desktop acceptance checks](docs/desktop.md) before releasing it.

```sh
pnpm install --frozen-lockfile
pnpm desktop:build
```

With `APPLE_SIGNING_IDENTITY` set, the build signs the bundled Node, ripgrep,
PTY addon, and spawn helper before Tauri signs the app with hardened runtime.
Node's entitlements are in `apps/desktop/src-tauri/NodeEntitlements.plist`;
the main app uses `Entitlements.plist`. Complete all resource and permission
changes **before** signing. Do not use `codesign --deep` to sign the app;
`--deep` below is only for verification.

Set the paths to that build. These defaults assume `CARGO_TARGET_DIR` is unset;
replace `OXBIT_BUNDLE_DIR` with your absolute bundle directory if you use it.

```sh
OXBIT_VERSION="$(node -p 'require("./package.json").version')"
OXBIT_BUNDLE_DIR="$PWD/apps/desktop/src-tauri/target/release/bundle"
OXBIT_APP="$OXBIT_BUNDLE_DIR/macos/Oxbit.app"
OXBIT_DMG="$OXBIT_BUNDLE_DIR/dmg/Oxbit_${OXBIT_VERSION}_aarch64.dmg"

codesign --verify --deep --strict --verbose=2 "$OXBIT_APP"
codesign --display --verbose=4 "$OXBIT_APP"

node scripts/desktop/notarize.mjs --app "$OXBIT_APP" --dmg "$OXBIT_DMG"
```

The script signs the outer DMG, submits it to Apple, waits up to 20 minutes,
staples its ticket, and verifies both its signature and Gatekeeper assessment.
It uses `APPLE_KEYCHAIN_PROFILE` locally; the existing Apple ID/password
environment variables remain supported for CI. An upload alone is not acceptance.

If the wait times out, Apple may still be processing the submission. Keep the
submission ID printed by the command. Resume it instead of signing or uploading
the same artifact again:

```sh
OXBIT_SUBMISSION_ID="" # Fill in the existing submission ID.
: "${OXBIT_SUBMISSION_ID:?Fill in the submission ID}"
xcrun notarytool info "$OXBIT_SUBMISSION_ID" \
  --keychain-profile "$APPLE_KEYCHAIN_PROFILE"
xcrun notarytool wait "$OXBIT_SUBMISSION_ID" \
  --keychain-profile "$APPLE_KEYCHAIN_PROFILE" --timeout 20m

# Run these only after Apple's status is Accepted.
xcrun stapler staple "$OXBIT_DMG"
xcrun stapler validate "$OXBIT_DMG"
codesign --verify --strict --verbose=2 "$OXBIT_DMG"
spctl --assess --type open --context context:primary-signature \
  --verbose=2 "$OXBIT_DMG"
shasum -a 256 "$OXBIT_DMG"
```

For an invalid submission, retrieve the explanation with `xcrun notarytool log
"$OXBIT_SUBMISSION_ID" --keychain-profile "$APPLE_KEYCHAIN_PROFILE"`. Fix the
reported problem, rebuild/re-sign, and submit the new artifact. Do not distribute
an artifact that failed notarization or Gatekeeper.

Mount the final DMG and verify the app **inside it**, then test a downloaded copy
on another Mac. Check launch, editing, search, TypeScript, and a real terminal.
Keep the download's quarantine attribute intact for the Gatekeeper test.
Notarizing an app alone does not establish notarization of a subsequently created
DMG; submit the final signed DMG as shown above.

## GitHub Actions release blanks

Configure these in `yannelli/oxbit` repository settings. Enter actual secret values
there, never here. The existing `.github/workflows/desktop.yml` consumes them.

| Repository secret                                                          | Fill in secure source/location, not the value |
| -------------------------------------------------------------------------- | --------------------------------------------- |
| `APPLE_CERTIFICATE` — base64 `.p12` containing certificate and private key | ____________________                          |
| `APPLE_CERTIFICATE_PASSWORD`                                               | ____________________                          |
| `APPLE_SIGNING_IDENTITY`                                                   | ____________________                          |
| `APPLE_ID`                                                                 | ____________________                          |
| `APPLE_PASSWORD` — app-specific password                                   | ____________________                          |
| `APPLE_TEAM_ID`                                                            | ____________________                          |
| `TAURI_SIGNING_PRIVATE_KEY` — separate updater signing key                 | ____________________                          |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — if the updater key is encrypted     | ____________________                          |

| Repository variable / release field                         | Fill in              |
| ----------------------------------------------------------- | -------------------- |
| `OXBIT_UPDATER_PUBLIC_KEY` — public half of the updater key | ____________________ |
| Root package version                                        | ____________________ |
| Matching tag, `v<version>`                                  | ____________________ |
| Person approving draft release publication                  | ____________________ |

Apple signing and Tauri updater signing use separate keys. `pnpm desktop:release`
requires both because it produces updater artifacts; the local DMG workflow above
does not need an updater key. Back up existing keys securely; do not replace an
updater key when already installed versions trust its public key. Version tags
produce a draft release, which must be reviewed before publication.

## Local test on 2026-09-07

The existing **0.1.0** installer snapshot was signed using Xcode **27.0
(27A5194q)** at `/Applications/Xcode-beta.app`, with **Developer ID Application:
Ryan Yannelli (2P58V89SR7)**. No new certificate or production key was generated.

The app was submitted through `xcodebuild -exportArchive` using Xcode's existing
account and a temporary Developer ID archive. Apple issued its notarization
ticket: app stapling, strict signature verification, and Gatekeeper's
`Notarized Developer ID` assessment passed. Xcode's later account-refresh errors
did not prevent direct retrieval of the issued ticket with `stapler`.

The separate final-DMG submission still requires the Keychain profile above.
See [local signing evidence](evidence/desktop/local-macos-signing.json) for the
artifact hash, exact checks, and any remaining acceptance limits. This test uses
the recorded installer snapshot, not subsequent edits in the working tree.
