---
name: preflight
description: Runs the local checks the PR workflows run for the changed paths and reports only failures with their first error lines. Use before git push or gh pr create so long test logs stay out of the main context.
---

Follow the `preflight` skill in `.agents/skills/preflight/SKILL.md`.

Do not edit files. Report one line per command with pass or fail; for a failure add the first 20 lines of the error and the file:line it points at. List docs from `docs_for_paths` that the change touches.
