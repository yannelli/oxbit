---
name: device-check
description: Run or track Oxbit checks that need a simulator, a paired device, or the macOS app on screen, and record each in the device-check ledger. Use for TestFlight notes items, iOS gestures, notifications, popout windows, background keep-alive, or LAN discovery.
---

# Device checks

1. List open rows: `ledger_list` with ledger `device-checks`, or read `docs/agents/ledgers/device-checks.md`. Rows come from `docs/testflight/<version>.md` items and from PRs that change on-screen behavior.
2. Run `launchctl managername`. In a `Background` session, run `xcrun devicectl`, `simctl` screenshots and GUI checks through a Terminal `.command` script (see `AGENTS.md`, "Shell on this Mac"). Try that before you call a check user-only.
3. Simulator first: `bun run ios:simulator`, then `xcrun simctl install booted <app>` and `xcrun simctl launch booted <bundle id>`; capture with `xcrun simctl io booted screenshot <file>`. Browser-level phone checks: `bun run test:browser -- --project webkit-phone`.
4. Device: `xcrun devicectl list devices`, then `xcrun devicectl device install app` and `device process launch`. Gestures and permission prompts that no tool can drive stay with the user; write the exact taps in the ledger row.
5. Update the row with the date, the build, pass or fail, and the evidence path.

Report the rows you ran, the evidence files, and the rows left for the user with their steps.
