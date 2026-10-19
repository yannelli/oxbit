# Oxbit 0.13.1: gaps found before App Store submission

Created: 2026-10-19. Last updated: 2026-10-19.

Checked against the App Review Guidelines (updated 2026-10-16), App Store Connect Help, and the 0.13.0 build (34) IPA from release run 39286774737.

## Blocks or likely rejections

| # | Gap | Evidence | Fix |
| --- | --- | --- | --- |
| 1 | No privacy manifest in 0.13.0 | `Oxbit.app` in `Oxbit_0.13.0_ios.ipa` has no `PrivacyInfo.xcprivacy`. The binary imports `stat`, `fstat`, `fstatat`, `lstat` (file timestamp APIs) and `mach_absolute_time` and `systemUptime` (system boot time APIs). | Fixed in 0.13.1: `apps/ios/src-tauri/gen/apple/PrivacyInfo.xcprivacy` (C617.1, 3B52.1, 35F9.1) is in the app target's resources. Submit 0.13.1. |
| 2 | No consent before sending data to third-party AI in 0.13.0 | Guideline 5.1.2(i): "clearly disclose where personal data will be shared with third parties, including with third-party AI, and obtain explicit permission before doing so." | Fixed in 0.13.1: `apps/ios/src/ai-consent.ts` asks "Share data with <service>?" before the first request to each model service from the device and saves Allow on the device. Requests from a connected computer's runtime are sent by that computer. |
| 3 | Export compliance | The app bundles OpenSSL (libgit2) and russh crypto. | Decided: France stays excluded; no declaration needed. See `01-app-store-connect-fields.md`. |
| 4 | Store text describes the old app | Current description and review notes say Git and language tools run only on a connected computer. | Paste the copy from `01-app-store-connect-fields.md`. |
| 5 | No screenshots uploaded | The iPhone 6.7" and iPad 12.9" sets hold 0 images. | Upload `screenshots/iphone-6.9`, `iphone-6.3`, and `ipad-13`. |

## Check before submitting

| # | Item | Why |
| --- | --- | --- |
| 6 | Extension install by URL | The Extensions panel offers installing an ESM artifact by URL. On iOS the content security policy in `apps/ios/src-tauri/tauri.conf.json` allows scripts from the app only (`script-src 'self'`) and has no `https:` in `connect-src`, so remote code cannot load. Checked in the config; a device check of the install attempt was not run. |
| 7 | Privacy policy covers AI completions | Added in 0.13.1 to `website/public/privacy/index.html`; live on oxbit.dev after the merge deploys. |
| 8 | Age rating answers | The record holds Yes for Unrestricted Web Access, User-Generated Content, and Messaging and Chat. Recommended answers give 4+, or 13+ with the override. |
| 9 | App Privacy | Unreadable through the API; confirm "Data Not Collected" is published. |
| 10 | Availability | 10 territories on 2026-10-19, France excluded. Add the others you want. |
| 11 | DSA trader status | Required for EU storefronts. |
| 12 | Review notes "Tested on" line | Needs the devices you checked. |
| 13 | IPv6-only networks | Guideline 2.5.5. Runtime pairing prefers IPv4 addresses from Bonjour; check pairing by address on an IPv6-only network or NAT64 hotspot from macOS Internet Sharing. |

## Upcoming

| Date | Requirement |
| --- | --- |
| April 2027 | Uploads must use the iOS 27 SDK; UIScene lifecycle becomes required with that SDK (TN3187). Tauri's iOS host scene support was not checked. |
| April 2027 | iPhone Duo screenshots (1398 × 2034 outer, 2007 × 2853 inner) become required. |
| Voluntary | Accessibility Nutrition Labels; App previews; iOS 27 creative assets (included in `promo/`). |
