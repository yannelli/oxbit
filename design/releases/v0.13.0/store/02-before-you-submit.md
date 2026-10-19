# Oxbit 0.13.0: gaps found before App Store submission

Created: 2026-10-19. Last updated: 2026-10-19.

Checked against the App Review Guidelines (updated 2026-10-16), App Store Connect Help, and the 0.13.0 build (34) IPA from release run 39286774737.

## Blocks or likely rejections

| # | Gap | Evidence | Fix |
| --- | --- | --- | --- |
| 1 | No privacy manifest | `Oxbit.app` in `Oxbit_0.13.0_ios.ipa` has no `PrivacyInfo.xcprivacy`. The binary imports `stat`, `fstat`, `fstatat`, `lstat` (file timestamp APIs) and `mach_absolute_time` and `systemUptime` (system boot time APIs). Apple: undeclared required-reason API use is "not accepted by App Store Connect". | Add `PrivacyInfo.xcprivacy` (draft in this folder: C617.1, 3B52.1, 35F9.1) to the app target resources in `apps/ios/src-tauri/gen/apple/project.yml`, rebuild, and confirm it sits at the root of `Oxbit.app`. |
| 2 | No consent before sending data to third-party AI | Guideline 5.1.2(i): "clearly disclose where personal data will be shared with third parties, including with third-party AI, and obtain explicit permission before doing so." No consent screen was found in the agent or AI code. | Before the first agent or inline completion request to a provider, show a one-time sheet that names the provider and what is sent (prompt, files the agent reads, code around the cursor), with Allow and Cancel. Store the choice per provider. |
| 3 | Export compliance answer | `ITSAppUsesNonExemptEncryption = NO`, but the app bundles OpenSSL (libgit2) and russh crypto. | See "App Encryption Documentation" in `01-app-store-connect-fields.md`: French declaration or exclude France. |
| 4 | Store text describes the old app | Current description and review notes say Git and language tools run only on a connected computer. | Paste the 0.13.0 copy from `01-app-store-connect-fields.md`. |
| 5 | No screenshots uploaded | The iPhone 6.7" and iPad 12.9" sets hold 0 images. | Upload `screenshots/iphone-6.9`, `iphone-6.3`, and `ipad-13`. |

## Check before submitting

| # | Item | Why |
| --- | --- | --- |
| 6 | Extension install by URL | The Extensions panel says "Install a trusted ESM artifact by URL". Guideline 2.5.2 bars downloading code that adds features. Confirm iOS cannot install or update extensions from a URL (the WebView content policy limits scripts to the app origin), then add "Extensions on iOS are bundled with the app" to the review notes. |
| 7 | Privacy policy covers AI completions | oxbit.dev/privacy lists the agent's providers but omits inline completions to OpenRouter, custom APIs, and local servers. Add one sentence to `website/public/privacy/index.html`. |
| 8 | Age rating answers | The record holds Yes for Unrestricted Web Access, User-Generated Content, and Messaging and Chat. Recommended answers give 4+, or 13+ with the override. |
| 9 | App Privacy | Unreadable through the API; confirm "Data Not Collected" is published. |
| 10 | Availability in new territories | Off in the record. |
| 11 | DSA trader status | Required for EU storefronts. |
| 12 | Review notes "Tested on" line | Needs the devices you checked. |
| 13 | IPv6-only networks | Guideline 2.5.5. Runtime pairing prefers IPv4 addresses from Bonjour; check pairing by address on an IPv6-only network or NAT64 hotspot from macOS Internet Sharing. |

## Upcoming

| Date | Requirement |
| --- | --- |
| April 2027 | Uploads must use the iOS 27 SDK; UIScene lifecycle becomes required with that SDK (TN3187). Tauri's iOS host scene support was not checked. |
| April 2027 | iPhone Duo screenshots (1398 × 2034 outer, 2007 × 2853 inner) become required. |
| Voluntary | Accessibility Nutrition Labels; App previews; iOS 27 creative assets (included in `promo/`). |
