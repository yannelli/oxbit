# iOS release artwork

Created: 2026-10-02. Last updated: 2026-10-05.

Use this guide when refreshing the iOS icon, preparing App Store screenshots,
or exporting the v0.3.1 marketing package.

The editable assets and native captures live in
[`design/releases/v0.3.1`](../design/releases/v0.3.1).
Open its `index.html` to review and download the exports.

## Visual direction

The [Oxbit project page](https://ryanyannelli.com/projects/oxbit/) supplies the
mint accent, charcoal surfaces, simple typography, and spacious headings.
The artwork uses the existing Oxbit symbol and bundled Instrument Sans fonts.
The sample Fieldnotes project contains synthetic source files and local SVG artwork.

Final App Store screenshots show the native app inside a simple frame.
They retain the navigation, editor controls, and preview toolbars from the capture.
Captions describe the visible feature. Computer runtimes remain optional for
local editing and previews.

## Icons

```sh
bun run ios:icons
```

This exports the established mint-on-charcoal icon from the native asset catalog.
The catalog and Tauri source PNGs match `v0.3.0-alpha.5` byte for byte, including
its original padding. The exporter verifies the original master checksum before
writing an opaque RGB marketing PNG and an SVG containing that same image.

The native catalog retains alpha.5's device-specific slots. No new dark or tinted
appearance is supplied. `ios:icons` exports marketing artwork without rewriting
native assets. Intentional future branding changes must update the approved
source and its checksum together.

## Screenshots and banners

The capture manifest records the simulator, OS, build identity, and native source
for each screen. The supplied sample project is under `sample-workspace/Fieldnotes`.
Capture it in dedicated release simulators with a 9:41 status bar, full battery,
and Wi-Fi. The capture helper accepts the task-owned simulator names and seeds
their sandbox. It does not alter the installed app on a physical device.

During this release's capture, the iPad framebuffer returned black images while
the app remained accessible to XCTest. Shutting down and booting that simulator,
then relaunching Oxbit, restored live captures while the Mac stayed locked.
The installed app and workspace data were preserved. Capture targets the primary
display with `xcrun simctl io <uuid> screenshot --display=primary --mask=ignored`.

```sh
bun run ios:graphics
```

The renderer requires all five native states for each device. It rejects missing,
duplicate, or incorrectly sized captures before exporting.

To export the icons and banners while capture is pending:

```sh
bun run ios:graphics --promo-only
```

This writes `release/v0.3.1/oxbit-v0.3.1-brand-artwork.zip` and marks screenshots
as pending in the manifest and preview page.

For layout review while native capture is blocked:

```sh
bun run ios:graphics --review
```

This packages the five native iPhone screenshots with five browser iPad drafts.
The iPad images carry a "Browser draft" label. The manifest records each image's
source and includes both capture manifests. Use the default command for the
complete native screenshot set.

To refresh the browser drafts:

```sh
node scripts/ios/capture-release-drafts.mjs
bun run ios:graphics --draft-captures
```

Browser drafts use the iOS frontend and synthetic filesystem data. The renderer
labels them "Browser draft", writes `draft-screenshots/`, and exports
`oxbit-v0.3.1-review-artwork.zip`. Replace them with native captures before submission.

| Export | Pixels | Use |
| --- | --- | --- |
| `screenshots/iphone-6.9/` | 1320 × 2868 | App Store iPhone screenshots |
| `screenshots/ipad-13/` | 2064 × 2752 | App Store iPad screenshots |
| `promo/promo-banner.png` | 2400 × 1260 | Website and release promotion |
| `promo/social-card.png` | 1200 × 630 | Social links and announcements |

Each exported screenshot has a self-contained HTML source next to it.
PNG exports are RGB and contain no alpha channel. The renderer checks canvas
bounds and image decoding. `manifest.json` records dimensions and SHA-256 hashes.
`store-copy.json` supplies an English listing draft with field-length validation.
Its privacy-policy URL is `https://oxbit.dev/privacy/`.
The policy source is `website/public/privacy/index.html`. Apple's app privacy
questions cover off-device collection and third-party services separately from
this policy page.

The complete ZIP is written to `release/v0.3.1/oxbit-v0.3.1-ios-artwork.zip`.
It includes the fonts' license, editable artwork, captures, provenance, and listing draft.
The [signed release guide](release.md) covers the separate build, TestFlight,
and publishing steps.

The v0.3.1 GitHub release was withdrawn and TestFlight build 0.3.1 (8) expired
on 2026-10-05 UTC after an unintended icon change. The earlier local IPA contains
the withdrawn icon and must not be redistributed. The corrected artwork has
not been packaged into a replacement IPA or release. See the
[alpha.5 comparison](release-audit-0.3.1.md) for findings and correction status.

## Apple references

Use these official references when changing asset dimensions, icon appearance
catalogs, or screenshot presentation:

- [Human Interface Guidelines: App icons](https://developer.apple.com/design/human-interface-guidelines/app-icons)
- [Configuring your app icon](https://developer.apple.com/documentation/xcode/configuring-your-app-icon)
- [Screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/)
- [Uploading previews and screenshots](https://developer.apple.com/help/app-store-connect/manage-app-information/upload-app-previews-and-screenshots/)
- [Platform version information](https://developer.apple.com/help/app-store-connect/reference/app-information/platform-version-information/)
- [App privacy details](https://developer.apple.com/app-store/app-privacy-details/)
