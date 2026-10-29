# Agent ledgers

Created: 2026-10-21. Last updated: 2026-10-21.

Markdown tables that agents read and write through the `ledger_list`, `ledger_add` and `ledger_update` tools of the `oxbit-dev` MCP server (`node scripts/agent/mcp/server.mjs`).

This repo is public. Ledgers about the code live here; ledgers about the user's accounts and their open questions live in a local directory outside the repo, `~/.agents/shared/oxbit-ledgers/` (override with `OXBIT_LOCAL_LEDGER_DIR`). `ledger_list` merges both and tags each row with `location`. Pass `local: true` or `false` to `ledger_add` and `ledger_update` to pick the other place.

| Ledger | Home | ID prefix | Holds |
| --- | --- | --- | --- |
| follow-ups | [follow-ups.md](follow-ups.md) | `F-` | Work parked as "later" with no decision pending |
| device-checks | [device-checks.md](device-checks.md) | `D-` | On-device and on-screen checks that have not run |
| flaky-tests | [flaky-tests.md](flaky-tests.md) | `T-` | Test flakes with the message and CI run id |
| open-questions | local | `Q-` | Questions for the user that got no answer |
| account-actions | local | `A-` | Steps in the user's accounts and consoles |

`OXBIT_LEDGER_DIR` points the repo ledgers at another directory; the tests use it.

## Row format

Each file has one table with the header `| ID | Status | Item | Source | Updated |`.

- `ID` is the prefix and a three-digit number. `ledger_add` takes the highest number in the file plus one. IDs are not reused.
- `Status` is `open`, `blocked`, `done` or `dropped`.
- `Item` is one line in plain words. `|` is written as `\|`.
- `Source` names the evidence: PR, commit, CI run id, or `file:line`.
- `Updated` is the date of the last change, `YYYY-MM-DD`.

Each file stays under 300 lines; `ledger_add` refuses a row past that. Move `done` and `dropped` rows to an archive file then.

Leave secret values, key IDs, issuer IDs, team IDs and key file paths out of both places.
