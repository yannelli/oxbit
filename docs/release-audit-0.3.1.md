# Withdrawn v0.3.1 compared with alpha.5

Created: 2026-10-05 UTC.

Baseline: `v0.3.0-alpha.5` (`34f8227ef106dc8fccfff1bd5288aab5e84b3f53`).
Withdrawn release: `db19a25e6e31241466d510d770df76f73554264c`.

## Withdrawal

- The Release workflow had completed before cancellation was requested.
- GitHub release v0.3.1 was deleted after GitHub rejected returning an immutable
  release to draft. Readback confirmed it is absent. The latest stable release
  returned to v0.2.5; alpha.5 remains a prerelease.
- TestFlight v0.3.1 build 8 was expired. Readback showed both internal and external
  testing states as `EXPIRED`. Before withdrawal, external review was pending.
- The ten newly uploaded screenshots were removed from the existing 0.2.1
  App Store draft after matching their filenames and checksums. Both sets are empty.
- No replacement release, IPA upload, or App Store submission was performed.
  The historical v0.3.1 tag remains at the withdrawn commit.

## Confirmed mistakes and corrections

| Finding | Impact | Correction |
| --- | --- | --- |
| Default icon colors were reversed and the symbol enlarged | Changed the established mint-on-charcoal identity and padding | Restored all 23 native icon/catalog files byte for byte from alpha.5; removed the new appearance variants |
| The icon generator rewrote native assets using its new design | Regeneration could reintroduce the unwanted change | Export from the original catalog master, verify its baseline checksum, and leave native assets untouched |
| More excluded Search and Add-ons from its selected state | iOS hides those buttons, so opening either panel left no visible navigation selection | Account for the existing iOS shell and phone breakpoint |
| Phone CSS hid Collapse folders | Removed a working Explorer action with no replacement | Restore the existing button |
| Preview options and panel picker did not establish their focus return target | Both new flows failed focus restoration in macOS-hosted WebKit CI | Focus the invoking button before opening the dialog; retain existing focus assertions |
| v0.3.1 screenshots were attached to the 0.2.1 draft | Prepared assets were associated with the wrong version and could not appear in TestFlight | Removed those attachments; retain local artwork for a correctly versioned future listing |

The icon, generator, and screenshot-association mistakes were introduced during
release preparation. The four navigation/accessibility defects were in the
preceding mobile UI changes included in v0.3.1.

## Other changes in the comparison

The comparison includes three earlier commits as well as release preparation:

- `77570ae`: automatic TestFlight notes and Public Beta distribution.
- `2d7490d` and `00c2735`: the previously requested mobile navigation, panel,
  preview, editor border, breadcrumb, notification, workspace, and formatting changes.
- `db19a25`: version metadata, iOS icon changes, artwork tooling/assets,
  listing draft, tester notes, and the approved privacy-page work.

The workflow now enables tester notifications, submits beta review when needed,
and assigns the build to Public Beta. GitHub publication depends on that step
succeeding. These are material workflow changes from alpha.5, originating in
`77570ae`, rather than an icon-related change.

No dependency-lockfile, desktop-icon, runtime-backend, or app-capability changes
appear in this comparison. The website privacy page was explicitly requested
and remains deployed.

## Completed CI failures and limits

PR35's iOS and desktop checks failed after the PR was merged. The separate
Release workflow passed and published artifacts; packaging success did not
establish that the UI regression suites passed.

The two new dialog-focus failures are corrected above. A Markdown preview
control measured 25px against a 44px requirement on macOS-hosted WebKit. Its
markup, sizing rule, and test match alpha.5; no alpha.5 runtime comparison was
performed, so this is an observed issue without evidence of a new regression.

Other failed checks include unchanged fixture/configuration problems: task and
theme suites running outside their dedicated servers, a macOS-only screenshot
path used on Linux, and an Astro fixture attempting to create an existing file.
These failures do not establish new regressions from release preparation.

Four other logged failures remain unresolved: ACP panel content measured 193px
against a 200px minimum; Project Intelligence did not show Related files; an ACP
setup promise was garbage-collected; and source-control/terminal tests reached
a missing runtime while trying to trust it. The relevant feature code is largely
unchanged, but that alone does not establish that these failures predate alpha.5.
They need runtime reproduction before a cause or fix can be claimed.

The runtime, formatter, and language-service source audit found no other
confirmed new regression. The native Swift root-path change still lacks a
focused device reproduction proving that it fixes the originally reported
failure. This remains an evidence gap.

## Correction verification

- All 23 native icon/catalog files match alpha.5 exactly.
- The exported marketing icon has zero pixel differences from the alpha.5 master.
- The corrected artwork package contains 13 graphics; all ten screenshots and
  both banners retain their prior hashes. The package is marked withdrawn.
- Asset generation, archive integrity, JavaScript syntax, and diff checks passed.
- Focused lint and stylesheet parsing passed.
- Browser assertions cover the navigation controls and dialog focus. They were
  not rerun for this correction. No native build or replacement IPA was produced.

The retained captures show the withdrawn build's in-app UI. They are historical
capture evidence, not screenshots of a newly rebuilt corrected app.
