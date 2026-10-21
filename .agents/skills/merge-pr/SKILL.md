---
name: merge-pr
description: Merge an Oxbit PR once every check passes, with one rerun of failed jobs and an overlap check against other open PRs. Use when asked to merge, land, or get a PR on main, or when your own PR goes green.
---

# Merge a PR

1. `gh pr view <n> --json isDraft,mergeable,mergeStateStatus,headRefOid,files`. Mark a draft ready only if the user asked for the merge.
2. `gh pr checks <n> --watch --interval 30`. Wait for pending checks; do not merge while any check is pending.
3. If a check fails, read its log (`gh run view <run> --log-failed`). Rerun once with `gh run rerun <run> --failed` only when the log shows an infrastructure failure (runner lost, network, timeout). A test or lint failure needs a fix commit. If the rerun fails again, report the failure and stop.
4. Check file overlap with other open PRs: `gh pr list --state open --json number,files`. Name any PR that touches the same files.
5. `gh pr merge <n> --merge`. A hook blocks this while checks fail or are pending.
6. Update the ledgers in `docs/agents/ledgers/` for rows the PR closes, if the PR did not.

Report the PR URL, the check results, any rerun with its run id, and the merge commit.
