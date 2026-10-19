# Oxbit 0.13.1 App Store submission package

Created: 2026-10-19. Last updated: 2026-10-19.

Prepared for App Store Connect app 6812456075 (`com.yannelli.oxbit`). Submit version 0.13.1: build 0.13.0 (34) lacks the privacy manifest and the AI data sharing prompt. Requirements were checked against Apple's documentation on 2026-10-19 (`requirements-2026-10.md`).

| Path | Contents |
| --- | --- |
| `01-app-store-connect-fields.md` | Every App Store Connect field in page order, with the value to enter and the current value |
| `02-before-you-submit.md` | Gaps found in the build and the record, ordered by risk |
| `store-copy.json` | Name, subtitle, promotional text, description, keywords, What's New, URLs, copyright |
| `PrivacyInfo.xcprivacy` | Privacy manifest, as added to the app target in 0.13.1 |
| `screenshots/iphone-6.9/` | 6 × 1320 × 2868, iPhone 6.9" (Dynamic Island large) |
| `screenshots/iphone-6.3/` | 6 × 1206 × 2622, iPhone 6.3" (Dynamic Island medium, required) |
| `screenshots/ipad-13/` | 6 × 2064 × 2752, iPad 13" (required) |
| `creative-assets/` | Optional iOS 27 product page header (3840 × 1646) and search results image (1920 × 1280) |
| `marketing/` | Promo banner (2400 × 1260) and social card (1200 × 630) |
| `icon/` | 1024 × 1024 App Store icon, RGB |
| `requirements-2026-10.md` | Apple requirements with sources |
| `provenance.json`, `manifest.json` | Capture source, sizes, and SHA-256 of each image |

All PNGs are RGB without alpha and under 10 MB. The screenshots are WebKit renders of the iOS frontend (`apps/ios`) at the device's point size and scale, with a mocked native bridge and the synthetic Fieldnotes project, framed with captions. They are not simulator captures.

## Order of work

1. Use build 0.13.1 and check the remaining items in `02-before-you-submit.md`.
2. App Information: name, subtitle, age rating, DSA status.
3. Pricing and Availability.
4. App Privacy.
5. Version page: text from `01-app-store-connect-fields.md`, screenshots in file-name order, build, App Review notes.
6. Add for Review.
