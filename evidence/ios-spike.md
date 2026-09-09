# iOS spike (Phase 0)

Recorded 2026-09-09 on macOS 27.0 with Xcode 27.0 beta (27A5194q), Tauri CLI 2.11.4, tauri 2.11.5, tao 0.35.3, wry 0.55.1. The spike frontend rendered the shared workbench over an IndexedDB `BrowserFileSystem` and reported the values below through a temporary Rust command.

| Check | iPhone 17 Pro, iOS 27.0 simulator | iPhone 17, iOS 26.5 simulator |
| --- | --- | --- |
| Launch | Crashed until `UIApplicationSceneManifest` named `TaoSceneDelegate`; launches with it | Launches with and without the manifest |
| `location.origin` | `tauri://localhost` | `tauri://localhost` |
| `localStorage` after terminate and relaunch | kept (counter 1 → 2) | kept (counter 1 → 3 over three launches) |
| IndexedDB (`oxbit` database) after relaunch | kept | kept |
| Module worker (`new Worker(..., { type: "module" })`) | starts, replies | starts, replies |
| `env(safe-area-inset-*)` with `viewport-fit=cover` | top 62px, bottom 34px, sides 0 | top 62px, bottom 34px, sides 0 |
| `window.innerHeight` vs `visualViewport.height`, keyboard closed | 874 / 874 | 874 / 874 |
| Bundled fonts | Instrument Sans reported loaded on the second launch; JetBrains Mono not reported | same |
| `Info.ios.plist` keys in the built Info.plist | `UIFileSharingEnabled`, `LSSupportsOpeningDocumentsInPlace`, scene manifest present | same |
| Documents directory round trip from Rust | wrote and read `Documents/oxbit-spike.txt` | same |
| Workbench render | phone layout, editor with sample files; title bar overlaps the status bar because only the bottom safe-area inset is applied | same |

Decisions taken from these results:

- Layout, drafts, settings, and icon packs go through native JSON persistence (`IosPersistence`, `IosIconPackStore`). IndexedDB persisted across relaunches here, so custom theme packs stay in the `oxbit-theme-packs` IndexedDB store for v1; the WebKit quota and eviction behavior on a real device is unverified.
- The scene manifest with `UIApplicationSupportsMultipleScenes` set to `true` is required on iOS 27. tao 0.35.3 defers app readiness to the first connected scene in that mode.
- Top, left, and right safe-area insets need CSS work (Phase 2).
- `xcodebuild` and `xcrun` run through `scripts/ios/xcode-shim` because the Tauri CLI spawns them with only `HOME`, `PATH`, and `TERM`, dropping `DEVELOPER_DIR`.
- The Tauri CLI matches simulators by name; the repo uses uniquely named devices `Oxbit iPhone` and `Oxbit iPad` on the iOS 27.0 runtime.

Not checked: keyboard-open viewport values (needs an interactive session), physical device behavior, storage after a 7-day idle period, WebGL.
