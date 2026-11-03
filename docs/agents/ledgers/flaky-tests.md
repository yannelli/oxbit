# Flaky tests ledger

Created: 2026-10-21. Last updated: 2026-11-03.

Each flake with its test, message and CI run id. Format and IDs: [README](README.md).

| ID | Status | Item | Source | Updated |
| --- | --- | --- | --- | --- |
| T-001 | open | Terminal ANSI theme test failed once with "Resulting promise was garbage collected" and passed alone; test file and run id not recorded | local run, run id not recorded | 2026-10-21 |
| T-002 | open | tests/browser/project-intelligence.spec.ts Laravel spec on linux-x64 failed with "Resulting promise was garbage collected", then the retry hit EEXIST on the /tmp/oxbit-e2e-*/laravel folder the first attempt left | run 38192983794, PR #60 | 2026-10-21 |
| T-003 | open | `apps/runtime/tests/lsp-manager.test.ts:105` Laravel PHP probe hit its 300 ms limit in the full parallel `bun run test` and passed alone | local run on fix/scm-critique-fixes 09b4b4d, no CI run id | 2026-11-03 |
| T-004 | open | `[webkit-phone] tests/browser/settings-header.spec.ts:22` page.goto("/") timed out at 120 s with a blank page in the full browser run and passed on rerun | local run on fix/scm-critique-fixes 09b4b4d, no CI run id | 2026-11-03 |
