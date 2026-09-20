# macOS signing and notarization

Use a Developer ID Application identity to distribute Oxbit outside the Mac App
Store. The desktop app targets Apple Silicon and macOS 26+. Its version comes
from the root `package.json`.

## Local setup

Install the pinned Node, Bun, and Rust toolchains and Apple's command-line tools.
Import your Developer ID certificate and private key into your login Keychain.
Replace the identity and team placeholders below with your own values.

```sh
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export APPLE_TEAM_ID="TEAMID"
export APPLE_KEYCHAIN_PROFILE="oxbit-notary"

security find-identity -v -p codesigning
xcrun notarytool --version
```

Run signing commands in a session with access to the unlocked Keychain. If
`codesign` reports `errSecInternalComponent`, check that the session can access
the private key. Use `security unlock-keychain` to unlock it interactively.

Store notarization credentials through the secure prompt:

```sh
xcrun notarytool store-credentials "$APPLE_KEYCHAIN_PROFILE" \
  --apple-id "<your Apple Developer account email>" \
  --team-id "$APPLE_TEAM_ID"

xcrun notarytool history --keychain-profile "$APPLE_KEYCHAIN_PROFILE"
```

The profile belongs to this Mac and user. Keep passwords, certificate exports,
and private keys outside the repository.

## Build and notarize

Run the [desktop checks](docs/desktop.md) before building a release.

```sh
bun install --frozen-lockfile
bun run desktop:build
```

`APPLE_SIGNING_IDENTITY` selects the identity used to sign the bundled Node,
ripgrep, terminal addon, and spawn helper. Tauri then signs the app with hardened
runtime. Complete resource changes before signing.

Set paths to the resulting app and DMG. These defaults assume `CARGO_TARGET_DIR`
is unset; adjust `OXBIT_BUNDLE_DIR` if you use another build directory.

```sh
OXBIT_VERSION="$(node -p 'require("./package.json").version')"
OXBIT_BUNDLE_DIR="$PWD/apps/desktop/src-tauri/target/release/bundle"
OXBIT_APP="$OXBIT_BUNDLE_DIR/macos/Oxbit.app"
OXBIT_DMG="$OXBIT_BUNDLE_DIR/dmg/Oxbit_${OXBIT_VERSION}_aarch64.dmg"

codesign --verify --deep --strict --verbose=2 "$OXBIT_APP"
codesign --display --verbose=4 "$OXBIT_APP"
node scripts/desktop/notarize.mjs --app "$OXBIT_APP" --dmg "$OXBIT_DMG"
```

The script signs the DMG, submits it to Apple, waits up to 20 minutes, staples
the ticket, and verifies the signature and Gatekeeper assessment. It reads
`APPLE_KEYCHAIN_PROFILE` locally or `APPLE_ID`, `APPLE_PASSWORD`, and
`APPLE_TEAM_ID` in CI.

If the wait times out, use the printed submission ID to check the existing upload:

```sh
OXBIT_SUBMISSION_ID="<submission ID>"
xcrun notarytool info "$OXBIT_SUBMISSION_ID" \
  --keychain-profile "$APPLE_KEYCHAIN_PROFILE"
xcrun notarytool wait "$OXBIT_SUBMISSION_ID" \
  --keychain-profile "$APPLE_KEYCHAIN_PROFILE" --timeout 20m
```

After Apple reports `Accepted`, finish verification:

```sh
xcrun stapler staple "$OXBIT_DMG"
xcrun stapler validate "$OXBIT_DMG"
codesign --verify --strict --verbose=2 "$OXBIT_DMG"
spctl --assess --type open --context context:primary-signature \
  --verbose=2 "$OXBIT_DMG"
shasum -a 256 "$OXBIT_DMG"
```

For an invalid submission, retrieve the report with
`xcrun notarytool log "$OXBIT_SUBMISSION_ID" --keychain-profile "$APPLE_KEYCHAIN_PROFILE"`.
Fix the reported problem, rebuild, sign, and submit the new artifact.

Mount the final DMG and verify the app inside it. Test a downloaded copy on
another Mac with its quarantine attribute intact. Check launch, editing, search,
TypeScript, and a terminal.

## GitHub Actions

The [desktop workflow](.github/workflows/desktop.yml) reads these repository secrets:

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64-encoded `.p12` containing the certificate and private key |
| `APPLE_CERTIFICATE_PASSWORD` | Password for that export |
| `APPLE_SIGNING_IDENTITY` | Developer ID Application identity |
| `APPLE_ID` | Apple Developer account email |
| `APPLE_PASSWORD` | App-specific password |
| `APPLE_TEAM_ID` | Developer team ID |
| `TAURI_SIGNING_PRIVATE_KEY` | Tauri updater private key |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Updater key password, if encrypted |

Set the repository variable `OXBIT_UPDATER_PUBLIC_KEY` to the corresponding public
key. Apple signing and Tauri updater signing use separate keys.
`bun run desktop:release` requires both because it creates signed updater artifacts.
The local DMG workflow above does not require an updater key.

Push a tag matching the root version (`v<version>`) to create a draft release.
Review the artifacts before publishing. Keep the updater key used by installed
versions when signing subsequent updates.
