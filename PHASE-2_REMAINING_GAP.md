# Phase 2 remaining gap

**Closed on 2026-09-06:** native directory recovery after refresh passes its
browser test. All 19 browser journeys pass.

```sh
pnpm build
pnpm exec playwright test --grep 'native browser directory handles'
```

## What failed

The test saves a file as Latin-1, keeps an unsaved edit, then refreshes. It
uses a real origin-private filesystem handle through a directory-picker stub.
Two runs lost the browser connection, once at `page.reload()` and once at the
first `page.waitForFunction` after `location.reload()`:

```text
Object with guid response@c5c31d0e00a7259a9698acf2b55eacff was not bound in the connection
page.waitForFunction: Target page, context or browser has been closed
```

## Cause

Both messages report the same event: the Chromium browser process exits with
SIGTRAP. It exits when IndexedDB deserializes a `FileSystemDirectoryHandle`
backed by the origin-private filesystem — the read in
[`restoreDirectory`](packages/host-browser/src/index.ts). A page reload is not
required; the same read crashes the process within one page session.

The crash belongs to one Chromium build. A reduced case that writes
`navigator.storage.getDirectory()` into IndexedDB and reads it back gives:

| Browser | Result |
| --- | --- |
| Chrome for Testing 153.0.8010.12 (Playwright 1.63.0) | SIGTRAP |
| Chromium 151.0.7922.34 (Playwright 1.62.1) | reads the handle |
| Chromium 148.0.7778.0 (Playwright 1.60.0) | reads the handle |
| Google Chrome 152.0.7977.64 | reads the handle |

Removing Playwright's `--disable-features` defaults and enabling
`ThirdPartyStoragePartitioning` did not change the 153 result.

## Fix

`@playwright/test` is pinned to `1.62.1`, the last release whose bundled
Chromium reads the handle. Application code and the test are unchanged.

Restoring a handle picked from a desktop filesystem, and its permission
prompt, are still untested; the picker cannot be driven headlessly.

- [Test](tests/browser/acceptance.spec.ts)
- [Passing run: 19 passed](evidence/audit-browser-directory-fix.log)
- [Earlier failures](evidence/audit-browser.log) and [retry](evidence/audit-directory-browser.log)
- [All results and unrun checks](evidence/acceptance.md)
