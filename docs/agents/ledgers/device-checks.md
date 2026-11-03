# Device checks ledger

Created: 2026-10-21. Last updated: 2026-11-03.

On-device and on-screen checks that have not run. Link each to its `docs/testflight/X.Y.Z.md` when one exists. Run them through the Terminal `.command` route before calling them user-only. Format and IDs: [README](README.md).

| ID | Status | Item | Source | Updated |
| --- | --- | --- | --- | --- |
| D-001 | open | macOS notifications with the Mac unlocked: permission prompt, banner click, minimized and hidden window | `apps/desktop` | 2026-10-21 |
| D-002 | open | iOS edge swipe from the left and right edges; the left case has not been reproduced | 7f9b2e9 | 2026-10-21 |
| D-003 | open | Popped-out panel title bar in the macOS app: drag, double-click zoom, traffic lights | PR #93, v0.14.3 | 2026-10-21 |
| D-004 | open | iOS "Stay connected in the background" keep-alive | PR #96, `docs/testflight/0.14.3.md` | 2026-10-21 |
| D-005 | open | Explorer Copy Path in the macOS app | PR #88 | 2026-10-21 |
| D-006 | open | iOS LAN discovery lists an `oxbit --lan` runtime on a device | `docs/ios.md` | 2026-10-21 |
| D-007 | open | 0.16.0 iOS: Commit button under the message field; file and group line totals in one column; Discard curved arrow asks first (notes steps 1, 2) | docs/testflight/0.16.0.md, v0.16.0 | 2026-11-03 |
| D-008 | open | 0.16.0 iOS on a runtime folder: commit result with Undo in the message field, no list movement; Undo Last Commit in the Commit menu; hidden on device folders (notes steps 3, 4) | docs/testflight/0.16.0.md, v0.16.0 | 2026-11-03 |
| D-009 | open | 0.16.0 iOS: dimmed AI button opens AI settings with no model, writes a message after a model is added (notes step 5) | docs/testflight/0.16.0.md, v0.16.0 | 2026-11-03 |
| D-010 | open | 0.16.0 iOS: More sheet names match the bottom bar (Files, Changes); Auto chip keeps the agent name complete and turns orange; Paper light readability (notes steps 6 to 8) | docs/testflight/0.16.0.md, v0.16.0 | 2026-11-03 |
