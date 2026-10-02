# Signed releases

Created: 2026-10-02. Last updated: 2026-10-02.

`.github/workflows/release.yml` builds, signs, and publishes a release when a
`v<version>` tag is pushed. The tag must match the root `package.json` version.

| Job | Output |
| --- | --- |
| `remote-runtime` | SSH runtime payloads for `darwin-arm64` and `linux-x64` |
| `macos` | Developer ID signed, notarized, and stapled app and DMG; signed updater archive; web, runtime, and extension tarballs |
| `ios` | App Store IPA, validated with App Store Connect and uploaded to TestFlight |
| `publish` | GitHub release with the files above, `latest.json`, and `SHA256SUMS` |

A version with a hyphen (`0.3.0-alpha.5`) publishes as a pre-release. The
updater reads `releases/latest/download/latest.json`, and GitHub's latest
release skips pre-releases, so stable installs are not offered an alpha.

The iOS build uses the version without its suffix (`0.3.0`) because App Store
Connect accepts only numeric versions. `scripts/ios/build-number.mjs` asks App
Store Connect for the highest uploaded build number and uses the next one.

`workflow_dispatch` on `main` runs the same build and IPA validation but skips the
TestFlight upload and the release.

The PR workflows (`desktop.yml`, `ios.yml`) run the regression suites and do not
sign or publish.

## Cutting a release

```sh
node --input-type=module -e "
import fs from 'node:fs';
import { versionFiles, setVersion } from './scripts/release.mjs';
for (const f of versionFiles) fs.writeFileSync(f, setVersion(f, fs.readFileSync(f, 'utf8'), process.argv[1]));
" 0.3.0-alpha.6
git commit -am "Release v0.3.0-alpha.6" && git tag v0.3.0-alpha.6
git push origin HEAD:main v0.3.0-alpha.6
```

For a stable `X.Y.Z` version, `bun run release X.Y.Z --no-desktop --no-ios --commit --tag`
bumps the version files, builds web and runtime locally, commits, and tags; push
with `git push --follow-tags`.

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
