# Phase 2 remaining gap

**Open as of 2026-09-06:** native directory recovery after refresh has not
passed its browser test. Phase 2 verification remains incomplete.

The test saves a file as Latin-1, keeps an unsaved edit, then refreshes. It
uses a real origin-private filesystem handle through a directory-picker stub.
The first run failed at `page.reload()`:

```text
Object with guid response@c5c31d0e00a7259a9698acf2b55eacff was not bound in the connection
```

The retry accepted the before-unload prompt and used `location.reload()`.
Navigation completed, then the test failed:

```text
page.waitForFunction: Target page, context or browser has been closed
```

The cause remains unknown. Checks for workspace identity, the saved bytes,
encoding, and the recovered draft did not finish. Work stopped after two
failures under the requested rule.

To close this gap, fix the connection loss and pass those checks:

```sh
pnpm build
pnpm exec playwright test --grep 'native browser directory handles'
```

Actual OS directory-picker use and restored permissions were not tested.

- [Test](tests/browser/acceptance.spec.ts)
- [Full run: 18 passed, 1 failed](evidence/audit-browser.log)
- [Retry log](evidence/audit-directory-browser.log)
- [All results and unrun checks](evidence/acceptance.md)
