# iOS background location keep-alive

Created: 2026-10-19
Last updated: 2026-10-19

iOS suspends Oxbit a few seconds after the user switches apps. The suspension closes the runtime WebSocket, the SSH session and the in-app agent's model stream. **Stay Connected in the Background** (`runtime.backgroundLocation`, default off, in Settings › Runtime) keeps the app running with coarse location updates, which is the method Termius uses.

## Behavior

- The setting is registered only by the iOS app (`apps/ios/src/main.tsx`), so desktop and web do not list it.
- `BackgroundKeepAlive` (`packages/host-ios/src/keep-alive.ts`) starts location while the setting is on and either a remote workspace is open (a runtime, SSH runtime or SFTP folder) or an agent turn is `working` or `waiting`. It stops location when neither holds, when the setting turns off, and when the workspace closes.
- iOS starts location updates only for a visible app. A start requested while the app is hidden waits for the next `visibilitychange` to visible.
- The first start shows the When In Use prompt. If access is denied, the app posts one notice and stops asking until the setting is turned off and on again.
- `BackgroundLocation.swift` sets `desiredAccuracy = kCLLocationAccuracyThreeKilometers`, `distanceFilter = CLLocationDistanceMax`, `pausesLocationUpdatesAutomatically = false`, `allowsBackgroundLocationUpdates = true` and `showsBackgroundLocationIndicator = true`. On iOS 17 and later it also holds a `CLBackgroundActivitySession`. Location results are ignored and never leave the device, so `PrivacyInfo.xcprivacy` and the App Privacy answers need no location entry.
- `Info.ios.plist` adds `UIBackgroundModes` = `location` and `NSLocationWhenInUseUsageDescription`. Setting `allowsBackgroundLocationUpdates` without the background mode terminates the app.

## App Review

Guideline 2.5.4 limits background modes to their intended purpose. Location used only to stay running is a known rejection reason. The setting is off by default, its description and the permission text say what it does, and the blue location indicator shows while it runs. If review rejects the build, the fallback is to tie the mode to a user-visible location feature (Termius shows the connection's location on a map) or remove the mode and rely on reconnecting on return.

## Testing

- `packages/host-ios/src/keep-alive.test.ts` covers when the controller starts and stops, the visibility rule and the denied case.
- `tests/ios/keep-alive.spec.ts` drives the setting and agent activity through the bridge mock (`locationDenied`, `__iosTest.backgroundLocation`).
- On a device: turn the setting on, connect a runtime, open a terminal, switch to another app for a few minutes, and return. The terminal stays connected, and the location indicator shows while Oxbit is in the background.

## References

- [allowsBackgroundLocationUpdates](https://developer.apple.com/documentation/corelocation/cllocationmanager/allowsbackgroundlocationupdates)
- [showsBackgroundLocationIndicator](https://developer.apple.com/documentation/corelocation/cllocationmanager/showsbackgroundlocationindicator)
- [CLBackgroundActivitySession](https://developer.apple.com/documentation/corelocation/clbackgroundactivitysession-3mzv3)
- [Handling location updates in the background](https://developer.apple.com/documentation/corelocation/handling-location-updates-in-the-background)
- [UIBackgroundModes](https://developer.apple.com/documentation/bundleresources/information-property-list/uibackgroundmodes)
- [App Review Guidelines 2.5.4](https://developer.apple.com/app-store/review/guidelines/#software-requirements)
