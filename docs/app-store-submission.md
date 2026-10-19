# App Store submission requirements (iOS and iPadOS)

Created: 2026-10-19. Last updated: 2026-10-19.

Apple's requirements for an Oxbit App Store submission as of 2026-10-19. The 0.13.0 package with the field values, screenshots, and gap list is in [`design/releases/v0.13.0/store`](../design/releases/v0.13.0/store). App Store Connect Help pages carry no update dates; the App Review Guidelines were updated 2026-10-16.

## Build

| Requirement | Since |
| --- | --- |
| Xcode 26+ and the iOS 26 SDK | 2026-04-28 |
| Xcode 27.1 and the iOS 27.1 SDK accepted | 2026-10-15 |
| iOS 27 SDK required; UIScene lifecycle required when built with it | April 2027 |
| `PrivacyInfo.xcprivacy` at the root of the `.app` when the binary calls required-reason APIs | 2024-05-01 |

Oxbit's binary calls the file timestamp APIs (`stat`, `fstat`, `fstatat`, `lstat`) and the system boot time APIs (`mach_absolute_time`, `systemUptime`). Declare C617.1 and 3B52.1 for file timestamps and 35F9.1 for boot time.

## Screenshots

PNG or JPEG, 1 to 10 per set, no alpha channel (enforced since 2026-07-08). App Store Connect scales the largest set down to smaller classes.

| Set | Pixels (portrait) | Status for Oxbit |
| --- | --- | --- |
| iPhone Dynamic Island medium (6.3") | 1206 × 2622 or 1179 × 2556 | Required |
| iPhone Dynamic Island large (6.9") | 1320 × 2868, 1290 × 2796, or 1260 × 2736 | Upload; satisfies the large-class rule |
| iPad 13" | 2064 × 2752 or 2048 × 2732 | Required: the app runs on iPad |
| iPhone Duo outer / inner | 1398 × 2034 / 2007 × 2853 | Required from April 2027; earlier uploads get the Duo badge |

Guideline 2.3.3: show the app in use; text and image overlays are allowed. Guideline 2.3.9: use fictional account data. App previews (optional) are 15 to 30 s, up to 3 per set, 886 × 1920 for iPhone and 1200 × 1600 for iPad.

The optional iOS 27 creative assets (guideline 2.3.14, 2026-10-16) are a product page header at 3840 × 1646 (21:9) or 5244 × 2950 (16:9) and a search results image from 1920 × 1280 to 3840 × 2560 (3:2).

## Text fields

| Field | Limit |
| --- | --- |
| Name, Subtitle | 30 characters each |
| Promotional Text | 170 characters, editable without review |
| Description, What's New | 4000 characters |
| Keywords | 100 bytes, no app or company names |
| Review Notes | 4000 bytes; name the AI services the app uses |

## Policies that apply to Oxbit

| Guideline | Rule | Oxbit |
| --- | --- | --- |
| 5.1.2(i) | Disclose sharing personal data with third-party AI and get explicit permission first | Needs a consent sheet before AI requests |
| 2.5.2 | No downloaded code that adds features | Runtime extensions are off on iOS; check URL installs of browser extensions |
| 4.7 | Non-bundled software, chatbots, and plug-ins need consent, filtering, and an index | Relevant if extensions or chat features load remote code |
| 1.2 | AI content creation apps need filtering, reporting, blocking, and contact information | The coding agent returns the user's own provider's output |
| 2.5.5 | Works on IPv6-only networks | Check runtime pairing |
| 2.5.19 (new) | No hidden or undocumented features | |

## Age rating, privacy, and compliance

- Age rating tiers are 4+, 9+, 13+, 16+, and 18+. Unrestricted Web Access maps to 16+. Answers to the new questions were due 2026-01-31; the social media questions apply from September 2026.
- App Privacy: data processed only on the device needs no disclosure; data sent to the developer's or partners' servers does.
- Accessibility Nutrition Labels are voluntary.
- Export compliance: encryption outside Apple's frameworks with standard algorithms (Oxbit bundles OpenSSL and russh) needs a French encryption declaration for distribution in France.
- EU DSA: trader status is required for EU storefronts; traders publish an address, phone number, and email.

## Sources

- [Screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/screenshot-specifications)
- [App preview specifications](https://developer.apple.com/help/app-store-connect/reference/app-preview-specifications)
- [App information](https://developer.apple.com/help/app-store-connect/reference/app-information) and [platform version information](https://developer.apple.com/help/app-store-connect/reference/platform-version-information)
- [App Review information](https://developer.apple.com/help/app-store-connect/reference/app-review-information)
- [Age ratings values and definitions](https://developer.apple.com/help/app-store-connect/reference/age-ratings-values-and-definitions)
- [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) (2026-10-16)
- [Upcoming requirements](https://developer.apple.com/news/upcoming-requirements/) and [App Store Connect release notes](https://developer.apple.com/help/app-store-connect/release-notes/)
- [Describing use of required reason API](https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api)
- [App privacy details](https://developer.apple.com/app-store/app-privacy-details/)
- [Accessibility Nutrition Labels](https://developer.apple.com/help/app-store-connect/manage-app-accessibility/overview-of-accessibility-nutrition-labels)
- [Export compliance documentation for encryption](https://developer.apple.com/help/app-store-connect/reference/export-compliance-documentation-for-encryption)
- [EU Digital Services Act trader requirements](https://developer.apple.com/help/app-store-connect/manage-compliance-information/manage-european-union-digital-services-act-trader-requirements)
- [Creative assets specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/creative-assets-specifications)
- [TN3187: Migrating to the UIKit scene-based life cycle](https://developer.apple.com/documentation/technotes/tn3187-migrating-to-the-uikit-scene-based-life-cycle)
