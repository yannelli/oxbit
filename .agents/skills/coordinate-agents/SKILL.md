---
name: coordinate-agents
description: Dispatch and supervise Oxbit subagents so none crash, stop early, or report less work than done. Use when you start more than one agent, write a /goal for a helper, or run an audit across many files.
---

# Coordinate agents

1. Write the brief to a shared file (for example `~/.agents/shared/<task>/helper-<x>.md`): files the helper owns, files it must not touch, the acceptance check, and the evidence to report. Point the helper's `/goal` at the file; a `/goal` condition holds at most 4,000 characters.
2. Give concurrent helpers disjoint files. You make the commits.
3. Each helper writes its own notes file after every step and ends it with `DONE` and the evidence list.
4. Keep a status file with each helper's id, files, state, decisions with reasons, and what is left. Update it after each step.
5. Watch each notes file's size and the agent's status. A file that stops growing while the agent runs gets one nudge; after that, replace the agent and record why.
6. Before accepting a result, read the files and rerun the acceptance check yourself. For audits, check coverage: every input item appears in the output.
7. Record any cut in scope with its reason in the status file.
