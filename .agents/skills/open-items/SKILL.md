---
name: open-items
description: List what is open on Oxbit at session start: unanswered questions for the user, follow-ups, account actions, device checks, unpushed worktrees, and stale draft PRs. Use when the user asks for open gaps, status, or what is left, and at the start of a long session.
---

# Open items

1. `ledger_list` for `open-questions`, `follow-ups`, `account-actions` and `device-checks` with status `open` (or read `docs/agents/ledgers/`).
2. `unpushed_work` for worktrees with uncommitted changes or unpushed commits.
3. `stale_work` (or `gh pr list --state open --draft`) for draft PRs and how far behind `main` they are.
4. Answer with one table per source. Put open questions first and ask the ones that block current work again.
