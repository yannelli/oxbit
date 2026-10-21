---
name: preflight
description: Before pushing or opening a PR, run the local checks that the PR workflows run for the changed paths and list the docs those paths need updated. Use before git push, gh pr create, or when CI failed on something a local run would catch.
---

# Preflight

1. List changed files: `git diff --name-only origin/main...HEAD` plus `git status --porcelain`.
2. Call the `oxbit-dev` MCP tool `checks_for_paths` (no arguments uses the changed files). Without MCP, use the "Checks per path" table in `AGENTS.md`.
3. Run each returned command. Run the slow ones (`test:browser`, `desktop:check`, `ios:check`) only when their paths changed.
4. Call `docs_for_paths` and update each listed doc that the change makes wrong. Bump its `Last updated:` date.
5. For a flaky failure that passes alone, add a row to the flaky-tests ledger with the test name, error text and run id.

Report each command with pass or fail, and the docs you changed.
