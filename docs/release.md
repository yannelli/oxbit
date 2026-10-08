# Signed releases

Created: 2026-10-02. Last updated: 2026-10-08.

`.github/workflows/release.yml` builds, signs, and publishes a release when a
`v<version>` tag is pushed. The tag must match the root `package.json` version.

| Job | Output |
| --- | --- |
| `remote-runtime` | SSH runtime payloads for `darwin-arm64` and `linux-x64` |
| `macos` | Developer ID signed, notarized, and stapled app and DMG; signed updater archive; web, runtime, and extension tarballs; the bundled SSH runtime payloads and `remote-runtime-manifest.json` |
| `ios` | App Store IPA with the pinned `remote-runtime-manifest.json`, validated and uploaded to TestFlight with tester notes and assignment to the internal `Internal Testing` group; starts after `macos` |
| `publish` | GitHub release with the files above, `latest.json`, and `SHA256SUMS` |

The SSH runtime release assets and the iOS manifest pin are described in [Remote workspaces over SSH](remote-ssh.md#release-assets).

A version with a hyphen (`0.3.0-alpha.5`) publishes as a pre-release. The
updater reads `releases/latest/download/latest.json`, and GitHub's latest
release skips pre-releases, so stable installs are not offered an alpha.

The iOS build uses the version without its suffix (`0.3.0`) because App Store
Connect accepts only numeric versions. `scripts/ios/build-number.mjs` asks App
Store Connect for the highest uploaded build number and uses the next one.

Pushing to `main` does not release. `workflow_dispatch` on `main` runs the same
build and IPA validation but skips TestFlight upload, distribution, and publishing.

The PR workflows (`desktop.yml`, `ios.yml`) run the regression suites and do not
sign or publish.

The same tag publishes `@oxbit/cli` to npm through `.github/workflows/npm.yml`;
see [npm packages](npm.md).

## Cutting a release

Write tester instructions in `docs/testflight/0.3.0-alpha.6.md` before running the
commands below. Each version needs its own file. Use plain text without a version
header; the distribution script adds `Oxbit <numeric-version> (<build>)`.

```sh
node --input-type=module -e "
import fs from 'node:fs';
import { versionFiles, setVersion } from './scripts/release.mjs';
for (const f of versionFiles) fs.writeFileSync(f, setVersion(f, fs.readFileSync(f, 'utf8'), process.argv[1]));
" 0.3.0-alpha.6
git add docs/testflight/0.3.0-alpha.6.md
git commit -am "Release v0.3.0-alpha.6"
git tag v0.3.0-alpha.6
git push origin HEAD:main v0.3.0-alpha.6
```

For a stable `X.Y.Z` version, first create and commit `docs/testflight/X.Y.Z.md`
so the working tree is clean. Then `bun run release X.Y.Z --no-desktop --no-ios --commit --tag`
bumps the version files, builds web and runtime locally, commits, and tags; push
with `git push --follow-tags`.

## TestFlight distribution

The tag workflow validates `docs/testflight/<full-package-version>.md` before
building or uploading the IPA. Missing or invalid tester notes fail this preflight.
After upload, it runs `node scripts/ios/distribute-testflight.mjs --build <number> --internal`.
The command uses the existing App Store Connect API credentials, waits up to 30
minutes for that exact app, numeric version, build number, and `IOS` platform to
become `VALID`, then:

1. Creates or updates the build's `en-US` "What to Test" with the version header
   and notes from the file.
2. Enables automatic tester notifications.
3. Assigns the build to the internal `Internal Testing` group and verifies the
   saved notes, group membership, and notification setting.

Internal testers need no beta review. External testers receive a build only after
it is checked on a device and promoted. Promote the same build to the external
`Public Beta` group from a checkout at the release tag:

```sh
export APPLE_API_KEY=<key id> APPLE_API_ISSUER=<issuer id> APPLE_API_KEY_PATH=<path to .p8>
node scripts/ios/distribute-testflight.mjs --build <number>
```

Without `--internal`, the command also submits beta review when required,
preserving existing submissions and approvals, then assigns `Public Beta`. Apple
controls beta review approval; the command finishes after submission and
verification. Re-running either mode for the same build reuses its existing
metadata and review state.

Check the current version's notes locally without contacting Apple:

```sh
node scripts/ios/distribute-testflight.mjs --build 7 --check-notes
```

The workflow writes the existing `APPLE_API_KEY_BASE64` secret to a `.p8` file and
passes its location as `APPLE_API_KEY_PATH`, alongside `APPLE_API_KEY` and
`APPLE_API_ISSUER`. Distribution needs no additional credentials.

## Secrets

| Name | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64 `.p12` of the Developer ID Application identity and its intermediate |
| `APPLE_CERTIFICATE_PASSWORD` | Password of that `.p12` |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Ryan Yannelli (2P58V89SR7)` |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | Notarization account, app-specific password, team |
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Updater key contents and passphrase |
| `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_BASE64` | App Store Connect API key ID, issuer ID, base64 `.p8` |
| `IOS_CERTIFICATE`, `IOS_CERTIFICATE_PASSWORD` | Base64 `.p12` of an Apple Distribution identity and its password |
| `IOS_MOBILE_PROVISION` | Base64 App Store provisioning profile for `com.yannelli.oxbit` |

Repository variable `OXBIT_UPDATER_PUBLIC_KEY` holds the updater public key.

## Credential notes

- The App Store Connect issuer ID for team `2P58V89SR7` is the provider
  "Public ID" printed by `xcrun altool --list-providers -u <apple-id> -p <app-password>`.
- The API key can create Apple Distribution certificates and profiles. Creating a
  Developer ID certificate through the API returns 403 "Account Holder" only, so
  the Developer ID `.p12` comes from the account holder's keychain
  (Keychain Access > My Certificates > Export).
- Tauri's `IOS_*` variables switch the Xcode project to manual signing. Xcode
  rejects Xcode-managed profiles for manual signing, so the profile is a
  manually created `IOS_APP_STORE` profile ("Oxbit CI App Store"). The CI
  distribution certificate and profile both expire on 2027-10-02.
- Renewing the iOS pair: create a CSR with `openssl req -new`, `POST /v1/certificates`
  with `certificateType: DISTRIBUTION`, then `POST /v1/profiles` with
  `profileType: IOS_APP_STORE` for that certificate, and replace the three `IOS_*`
  secrets.

## References

- [Tauri iOS code signing](https://v2.tauri.app/distribute/sign/ios/)
- [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/)
- [App Store Connect API: certificates](https://developer.apple.com/documentation/appstoreconnectapi/certificates)
  and [profiles](https://developer.apple.com/documentation/appstoreconnectapi/profiles)
- [Generating App Store Connect API tokens](https://developer.apple.com/documentation/appstoreconnectapi/generating-tokens-for-api-requests)
- [TestFlight build localizations](https://developer.apple.com/documentation/appstoreconnectapi/beta-build-localizations)
- [Assigning builds to beta groups](https://developer.apple.com/documentation/appstoreconnectapi/post-v1-betagroups-_id_-relationships-builds)
- [Submitting beta app review](https://developer.apple.com/documentation/appstoreconnectapi/post-v1-betaappreviewsubmissions)
- [Inviting external testers](https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers)
- [Fastlane's review and group assignment order](https://github.com/fastlane/fastlane/blob/master/pilot/lib/pilot/build_manager.rb)

Use the TestFlight references above when changing tester notes, external group
assignment, notifications, or review submission.
