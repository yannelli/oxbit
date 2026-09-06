# Zapp — interaction specification (Phase 1)

Screen and state inventory, command/action IDs, triggers, transitions, keyboard behaviour, persistence and error handling for the Phase 1 mockup. Command IDs are the single vocabulary shared by the command palette, menus, context menus, toolbar buttons and keybindings (`fixtures.js › commands`).

## 1. Screens and states

| Screen | States | Entry | Exit |
|---|---|---|---|
| Empty workspace | idle · opening (progress 5→100 %, 4 steps) | Close Workspace, first launch without workspace | Pick recent / Open Folder… → workbench |
| Workbench shell | desktop · tablet · phone · focus mode | Workspace open | — |
| Title bar | menus (File/Edit/View/Go/Terminal/Help) open/closed · workspace switcher open · connection popover · notification centre | click / hover-switch between menus | Esc, click outside |
| Activity bar | explorer · search · scm · extensions (+ badges: unsaved, changes, updates) | click / view.* commands | — |
| Sidebar | visible/hidden · docked (desktop) · overlay (tablet) · sheet (phone) · width 180–520 | ⌘B, activity bar | ⌘B, Esc (overlay), scrim |
| Explorer | tree expanded/collapsed · selected · active-file bar · dirty dot · git badge (M/U/D/C) · diag dot · read-only lock · missing (strikethrough) · externally changed (italic) · renaming · creating (+ inline error) · drag-move confirm | — | — |
| Editor group | 1–3 groups · row/column split · active outline | ⌘\ / ⌘K ⌘\ | last tab closed removes group |
| Tab | active · inactive · preview (italic) · pinned · dirty (● replaces ×) · presence dot · missing (strikethrough) · dragging | click, open | ×, ⌘W, middle-click, drag to other group |
| Code editor | editable · read-only (banner, no caret) · externally changed (banner) · offline (banner) · conflict (toolbar + zones) · folded · find widget · widgets (hover/completion/signature/actions/rename/peek) · remote cursor · remote-edit flash | tab active | — |
| Diff | side-by-side · inline · git/saved/disk modes | Open Changes, Compare, SCM click | close tab |
| Markdown | editor · preview · split | tab actions, ⇧⌘V, ⌘K V | — |
| Settings | user/workspace scope · search · modified · validation error | ⌘, | close tab |
| Keyboard shortcuts | list · search · conflict rows · capture dialog (recording → keys → conflict → save/replace/keep both) | ⌘K ⌘S | Esc |
| Extension details | not installed · installing · installed-enabled · disabled · update available · incompatible · install failed (+retry) | click in Extensions view | close tab |
| Replace preview | per-file checkbox · apply/cancel · discard confirm | Search › Replace All | apply / cancel |
| Plugin document view | Bundle report | Bundle Size › Open report | close tab / extension disabled |
| File error view | missing (restore from git) · permission denied (retry) | open such file | close |
| Panel | terminal · problems · output · tasks · Bundle Size (plugin) · maximized · hidden · sheet (tablet/phone) | ⌘J, status bar | ⌘J, × |
| Terminal | idle · running · completed · failed · disconnected (Enter reconnects) · terminated · split (2) · search · rename | ⌃` , + | trash |
| Tasks | idle · running (cancel) · completed · failed · cancelled · rerun | ⇧⌘B, Run Task… | — |
| Problems | grouped by file · empty | ⇧⌘M, status bar | — |
| Output | channel select (plugin channel appears/disappears) | ⇧⌘U | — |
| Command palette | files · commands · symbols · line · recent · empty · disabled rows with reasons | ⌘P / ⇧⌘P / ⇧⌘O / ⌃G / ⌘E | Esc, run |
| Context menu | explorer · tab · editor · terminal · SCM item · problem | right-click / ⋯ | Esc, click, run |
| Dialog | close-dirty · confirm (danger) · info · pick list · key capture | actions | Esc/Enter/buttons |
| Notifications | toasts (≤3 desktop, 1 phone, auto-dismiss when `ttl`) · centre | events | ×, Clear all |
| Connection popover | online · offline · reconnecting · failed · recovered | title bar / status bar | Esc |
| Phone | top bar · bottom tab bar · More sheet · full-screen palette · virtual keyboard sim | viewport < 600 | — |

## 2. Commands (IDs → trigger → effect)

All commands are in `fixtures.js › commands` with `id`, `title`, `cat`, `mac`, `win`, `when`. Disabled commands stay visible in the palette and menus with the reason from `Component.reason(when)`:

`editor` no editor · `lsp` server not ready / no features for language · `formattable` no formatter · `markdown` not Markdown · `split` one group · `explorer` nothing selected · `gitRepo` no repo · `gitChanges` no changes · `gitStaged` nothing staged · `taskRunning` · `lastTask` · `terminal` · `collaborators` · `offline` already connected · `notifications` · `bundleExt` extension disabled · `workspace`.

Key groups: `workbench.*` (palette modes), `view.*` (views, layout, focus, reset), `file.*` (new/save/rename/delete/reveal/copy path), `editor.*` (tabs, splits, find/replace, format, rename, definition, references, code action, hover, suggest, fold, wrap), `terminal.*`, `tasks.*`, `git.*`, `lsp.restart`, `preview.*`, `settings.*`, `extensions.*`, `workspace.*`, `collab.*`, `sync.reconnect`, `notifications.clear`, `bundle.analyze` (plugin), `help.about`.

## 3. Keyboard

Primary modifier = ⌘ on macOS, Ctrl on Windows/Linux (labels switch with `platform`). Chords: ⌘K then Z / T / S / V / I / \ / ↩ / 0 / J / F; a status hint shows while waiting (3 s timeout).

Editor: Tab inserts indentation (setting-driven); Enter auto-indents and adds a level after `{ ( [`; ⌃Space suggestions; ↑↓ navigate, ↩/Tab accept, Esc dismiss; F12 definition; ⇧F12 references; F2 rename; ⌘. code actions; `(` opens signature help, `)` closes; typing `data.` opens member completions; ⌘-click goes to definition.

Explorer tree: ↑↓ move, →/← expand/collapse, Space preview, Enter rename (file) / toggle (folder), F2 rename, ⌘⌫ delete, right-click context menu. Tabs: Enter/Space activate, Delete/Backspace close.

Escape priority: dialog › context menu › menus/popovers › palette › sheet › editor widget › terminal search › find widget › overlay sidebar › focus mode (Esc Esc).

Focus: `:focus-visible` 2 px accent ring; overlays record the previously focused element and restore it on close (palette, context menu); revealing a location focuses the editor and selects the range; dialogs auto-focus the primary button (capture dialog focuses the recorder). Reduced motion via the `reducedMotion` tweak (`[data-rm="1"]`) disables transitions/animations.

## 4. Transitions and state consistency

- **Edit** → tab dirty dot, Open Editors dot, Explorer dot, status "N unsaved", SCM change appears as `M (unsaved)`; diagnostics recompute live (rule text present ⇢ diagnostic; removed ⇢ gone from gutter, Problems, status counts, explorer dots).
- **Save** (⌘S) → optional format-on-save, trim trailing whitespace, mock `fs.write`, saved content updated, SCM change recomputed against committed base. Read-only → warning toast. Autosave `afterDelay` schedules saves.
- **Close dirty** → alertdialog Save / Don't Save / Cancel. Closing a file open in no other group reverts unsaved content.
- **Split** → new group next to active, tab copied (unpinned); tabs drag between groups; empty group is removed.
- **Layout** (sidebar visibility/width/view, panel visibility/height/tab, split direction, theme) persists to `localStorage["zapp.layout.v1"]` (debounced 300 ms) and restores on load with a toast. `view.resetLayout` clears it.
- **Search** → 650 ms simulated worker; cancel keeps partial state "Search cancelled"; regex/glob errors and worker failure render inline with Retry. Result click reveals file + range. Replace preview → apply → unsaved edits + toast (Show changes / Save all).
- **LSP** state machine: starting (1.4 s) → ready; restart → restarting (1.2 s) → ready/failed; unavailable for non-LSP languages. Widgets require `ready`; otherwise commands explain why.
- **Git**: stage/unstage move items between groups; commit needs staged + message (Ctrl/⌘↩), 700 ms, updates log/ahead count, offers Push; failures show inline error with Retry/Dismiss; discard confirms and restores committed content (deletes untracked); conflict file shows zone colouring + Accept Current/Incoming/Both.
- **Terminal**: Enter runs scripted commands (`pnpm test`, `pnpm build`, `git status`, `ls`, `pwd`, `node -v`, `clear`; unknown → `command not found`, exit 127); ⌃C interrupts; kill confirms when running (setting); disconnected session reconnects on Enter.
- **Tasks**: run streams lines with delays; `fail` lines mark exit 1 + toast; refs `path:line:col` are clickable everywhere (terminal, tasks); cancel writes "Task cancelled".
- **Extensions**: install 1.1 s (Docker fails first time, Retry succeeds); enable/disable 350 ms; Bundle Inspector contributes panel tab, command, status item, output channel and document view — disabling removes all, closes its document tab and switches the panel if needed.
- **Connection**: offline → auto reconnect after 2.5 s → recovered (2.2 s) → online, or failed with Retry / Work offline. Edits while not online queue (`pendingSync`), shown in status and editor banner; recovery toast reports synced count. Remote edit inserts a line, shifts local selection, flashes and labels the line for 6 s, moves the participant cursor.
- **Settings**: scope-aware values (workspace overrides user overrides default); numbers validate min/max and are not applied when invalid; reset removes the scoped override; theme/density/sidebar location/indent/wrap/minimap/autosave/format-on-save/trim/terminal font/scrollback/diff layout all take effect immediately.
- **Keybindings**: user overrides in `keybindings`; conflicts detected per platform label and shown in the list and in the capture dialog with Replace existing / Keep both.

## 5. Persistence expectations

| Key | Content | Lifetime |
|---|---|---|
| `zapp.layout.v1` | sidebar, panel, splitDir, theme | localStorage |
| in-memory | documents, git, terminals, settings, extensions, notifications | session (reset via Review › Reset) |

Phase 2 should persist open editors/groups, per-file view state (cursor, folds, scroll), settings (user: profile; workspace: `.zapp/settings.json`), keybindings and recently used commands/files.

## 6. Error handling

- Filesystem: EACCES/EROFS/ENOENT surfaced inline (create error under the input; rename/delete/save as error toast with Retry; missing/permission files as full-editor error views).
- Search: invalid regex / glob and worker crash as inline alert with Retry; results cleared.
- Git: pre-commit hook failure / unreachable remote as inline alert in SCM + toast with Retry.
- Language server: failed/unavailable states in status bar and popover with Restart; features explain unavailability instead of failing silently.
- Extensions: install failure inline with Retry; incompatible extensions cannot be installed (reason shown).
- Connection: reconnect failure toast with Retry / Work offline; local edits never discarded.
- Settings: invalid values highlighted with message; value not applied.
- Dialogs use `role="alertdialog"` for destructive confirms.

## 7. Service boundaries (`services.js`)

| Adapter | Real capability (Phase 2) |
|---|---|
| `fs` | workspace filesystem (local FS / remote agent) |
| `git` | git CLI or libgit2 |
| `lsp` | language servers over LSP (tsserver, css-ls, eslint) |
| `search` | ripgrep over the workspace |
| `ext` | extension host + marketplace API |
| `sync` | collaboration transport (WebSocket + CRDT) |
| `terminal` | PTY sessions (node-pty / remote agent) |

`flags` on the service instance inject failures (`fsFail`, `gitFail`, `searchFail`, `lspMode`, `reconnectFails`) — the review drawer toggles them.

## 8. Verification log

| Check | Result | Evidence |
|---|---|---|
| Default workspace renders at 1440×900 (dark/light) | passed | `design/screenshots/desktop-*.png` |
| Tablet 1024×768 and 768×1024 layouts (overlay sidebar, sheet panel) | passed | `design/screenshots/tablet-*.png` |
| Phone 390×844 (top bar, tab bar, sheet, full-screen palette, virtual keyboard) | passed | `design/screenshots/phone-*.png` |
| J1 open → find → edit → split → save → restore | passed | Review › J1 playback |
| J2 diagnostic → navigate → quick fix → removed | passed | Review › J2; `desktop-problems-quickfix.png` |
| J3 search → replace preview → apply → diff | passed | `desktop-replace-preview.png`, `desktop-diff.png` |
| J4 stage → message → commit | passed | Review › J4 |
| J5 task → output → click reference | passed | `desktop-tasks.png` |
| J6 disable/enable extension contributions | passed | Review › J6; `desktop-extension.png` |
| J7 offline → edit → reconnect → recovered | passed | Review › J7 |
| Keyboard: palette, chords, editor shortcuts, Esc stack | passed | manual |
| Inner scroll position in html-to-image screenshots | not run | screenshot tool re-renders DOM; verified live only |
| Real clipboard, drag-and-drop in touch browsers | not run | out of scope for the mockup |
