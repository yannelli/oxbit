# Zapp — Phase 1 design mockup

High-fidelity, interactive mockup of the Zapp web code editor. Everything runs on fixture data and mock service adapters; no backend.

## Launch

Open `Zapp Workbench.dc.html` in the project preview (or any modern browser served from the project root — it loads `support.js`, `fixtures.js`, `lang.js`, `services.js` as siblings). No build step.

Files:

- `Zapp Workbench.dc.html` — the workbench (template + logic class).
- `fixtures.js` — the `orbit-dash` fixture project, diagnostics, git state, terminals, tasks, extensions, commands, settings schema, keybindings, strings (en + long-label pseudo-locale).
- `lang.js` — tokenizer, decorations, folding, find, diff, markdown, fuzzy matching, formatter.
- `services.js` — mock service adapters (`createServices()`), each annotated with the real capability it replaces.
- `design/` — this handoff.

## Review routes

The **Review** pill (top-right, outside the workbench frame) opens the review drawer. It is separate from the workbench and can be hidden with the *Review tools* tweak.

- **Frame** — Fit / Desktop 1440×900 / Tablet 1024×768 / Tablet 768×1024 / Phone 390×844; theme, modifier labels (macOS vs Windows/Linux), simulated virtual keyboard (phone), density.
- **Journeys J1–J7** — scripted playback of the seven required journeys (1.5 s per step, step label shown).
- **Scenarios 1–12** — one group per spec section; each button applies a deterministic state (LSP failed, offline → reconnect fails, merge conflict, install failure, read-only file, …).
- **Reset fixture & layout** — returns to the default workspace and clears persisted layout.

Programmatic hooks for automation: `window.__zapp` is the workbench instance (`setState`, `openFile(path,{line,col})`, `runCommand(id)`, `playJourney(n)`, `setState({viewport:'phone'})`).

Tweaks panel props: `theme`, `density`, `platform`, `viewport`, `longLabels`, `reviewTools`, `reducedMotion`.

## Fixture scenarios (highlights)

| Area | Scenario | Where |
|---|---|---|
| Shell | Empty workspace, opening flow with progress, focus mode, split right/down, layout persistence + restore toast | Review › 1 |
| Files | Read-only `LICENSE`, missing `src/lib/cache.ts`, permission-denied `.env.local`, externally changed `src/lib/format.ts`, FS failure toggle, delete confirm, drag-move confirm | Review › 2 |
| Editor | Dirty-close dialog, preview tabs, pinned `App.tsx`, folding, find/replace widget, word wrap, minimap | Review › 3 |
| Commands | Palette modes (files `›` commands `@` symbols `:` line, recent), disabled commands with reasons, empty results, mac/win labels | Review › 4 |
| Search | Grouped results, loading + cancel, regex error, worker failure, no results, replace preview → apply → diff | Review › 5 |
| Language | LSP starting/ready/unavailable/restarting/failed; hover, completion, signature help, references peek, rename, code actions, format, Problems | Review › 6 |
| Terminal & tasks | Running/completed/failed/disconnected/terminated sessions, splits, search, kill confirm, task run/cancel/rerun with clickable refs, output channels | Review › 7 |
| SCM | Normal / empty repo / clean tree / merge conflict / failing commit+push; side-by-side and inline diffs; stage, unstage, discard confirm, commit | Review › 8 |
| Preview | Markdown editor / preview / split; plugin document view (Bundle report) | Review › 9 |
| Settings | Search, User/Workspace scopes, modified indicators, reset, validation error; keyboard shortcuts with conflict + remap capture | Review › 10 |
| Extensions | Installed/available, details tabs, install failure + retry, incompatible, update, enable/disable removing contributions | Review › 11 |
| Real-time | Online / offline / reconnecting / failed / recovered, queued local edits, remote cursors, remote edit by Mira, follow participant | Review › 12 |

## Scope of simulated behaviour

Simulated (works locally, coherent state transitions): editing, saving, folding, find/replace, workspace search, diagnostics (live text rules), completions/hover/signature/definition/references/rename/code actions/format (fixture tables), git stage/unstage/commit/discard/push/checkout, terminals (scripted commands), tasks, output channels, extension lifecycle, collaboration/connection states, settings and keybindings, layout persistence (`localStorage["zapp.layout.v1"]`).

Deferred to Phase 2 (explicitly not implemented): real language servers, shell execution, filesystem access, git binary, remote/collaboration transport, extension host execution, marketplace, authentication, clipboard integration beyond `navigator.clipboard.writeText`, encoding/EOL conversion, clone repository.

Each mock adapter in `services.js` documents the real capability it stands in for; see `interaction-spec.md` › *Service boundaries*.

## Verification (Phase 1)

Checks run against the mockup at the reference sizes are listed in `interaction-spec.md` › *Verification log*.
