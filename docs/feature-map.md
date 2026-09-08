# Design reference ownership

The complete Phase 1 reference is preserved in `design/reference/`. Literal sample-project file contents seed the first IndexedDB workspace in `apps/web/src/seed.json`. Browser services do not import the reference mock adapters, diagnostics tables, terminal transcripts or collaboration fixtures. `design/baselines/` contains additional captures at the reference dimensions; original supplied images remain in `design/screenshots/`.

## Screens and states

| Reference screen | States | Owner |
| --- | --- | --- |
| Empty workspace | idle · opening (progress 5→100 %, 4 steps) | packages/workbench, packages/ui |
| Workbench shell | desktop · tablet · phone · focus mode | packages/workbench, packages/ui |
| Title bar | menus (File/Edit/View/Go/Terminal/Help) open/closed · workspace switcher open · connection popover · notification centre | packages/workbench, packages/ui |
| Activity bar | explorer · search · scm · extensions (+ badges: unsaved, changes, updates) | packages/workbench, packages/ui |
| Sidebar | visible/hidden · docked (desktop) · overlay (tablet) · sheet (phone) · width 180–520 | packages/workbench, packages/ui |
| Explorer | tree expanded/collapsed · selected · active-file bar · dirty dot · git badge (M/U/D/C) · diag dot · read-only lock · missing (strikethrough) · externally changed (italic) · renaming · creating (+ inline error) · drag-move confirm | packages/features/explorer |
| Editor group | 1–3 groups · row/column split · active outline | packages/workbench, packages/ui |
| Tab | active · inactive · preview (italic) · pinned · dirty (● replaces ×) · presence dot · missing (strikethrough) · dragging | packages/workbench, packages/ui |
| Code editor | editable · read-only (banner, no caret) · externally changed (banner) · offline (banner) · conflict (toolbar + zones) · folded · find widget · widgets (hover/completion/signature/actions/rename/peek) · remote cursor · remote-edit flash | packages/features/editor, packages/features/language, packages/features/collaboration |
| Diff | side-by-side · inline · git/saved/disk modes | packages/features/git |
| Markdown | editor · preview · split | packages/features/previews |
| Settings | user/workspace scope · search · modified · validation error | packages/features/settings |
| Keyboard shortcuts | list · search · conflict rows · capture dialog (recording → keys → conflict → save/replace/keep both) | packages/features/settings |
| Keymap | Oxbit default (unset) · VS Code · JetBrains · macOS · Sublime Text · Atom · Visual Studio · Emacs, selected by `workbench.keymap` | packages/features/keymaps |
| Extension details | not installed · installing · installed-enabled · disabled · update available · incompatible · install failed (+retry) | packages/features/extensions |
| Agent ACP | disabled by default · Codex/Cursor/Amp · streaming Markdown and ordered tools · inspectable context · searchable local/provider history · capability-gated resume · editor diff approval · guarded undo · phone layouts | packages/features/agent-acp, apps/runtime |
| Replace preview | per-file checkbox · apply/cancel · discard confirm | packages/features/search |
| Plugin document view | Bundle report | examples/bundle-inspector |
| File error view | missing (restore from git) · permission denied (retry) | packages/documents, packages/workbench |
| Panel | terminal · problems · output · tasks · Bundle Size (plugin) · maximized · hidden · sheet (tablet/phone) | packages/workbench, packages/ui |
| Terminal | idle · running · completed · failed · disconnected (Enter reconnects) · terminated · split (2) · search · rename | packages/features/terminal |
| Tasks | idle · running (cancel) · completed · failed · cancelled · rerun | packages/features/tasks |
| Problems | grouped by file · empty | packages/features/language |
| Output | channel select (plugin channel appears/disappears) | packages/features/tasks |
| Command palette | files · commands · symbols · line · recent · empty · disabled rows with reasons | packages/workbench, packages/ui |
| Context menu | explorer · tab · editor · terminal · SCM item · problem | packages/workbench, packages/ui |
| Dialog | close-dirty · confirm (danger) · info · pick list · key capture | packages/workbench, packages/ui |
| Notifications | toasts (≤3 desktop, 1 phone, auto-dismiss when `ttl`) · centre | packages/workbench, packages/ui |
| Connection popover | online · offline · reconnecting · failed · recovered | apps/web, packages/host-runtime |
| Phone | top bar · bottom tab bar · More sheet · full-screen palette · virtual keyboard sim | packages/workbench, packages/ui |

## Commands

Menu and palette presentation uses `packages/workbench/src/catalog.json`. Each feature registers commands through the SDK.

| Command ID | Title | Owner |
| --- | --- | --- |
| `workbench.showCommands` | Show All Commands | `packages/workbench` |
| `workbench.quickOpen` | Go to File… | `packages/workbench` |
| `workbench.gotoSymbol` | Go to Symbol in Editor… | `packages/workbench` |
| `workbench.gotoLine` | Go to Line/Column… | `packages/workbench` |
| `workbench.recent` | Go to Recent… | `packages/workbench` |
| `view.explorer` | Show Explorer | `packages/features/explorer` |
| `view.search` | Search in Files | `packages/features/search` |
| `view.scm` | Show Source Control | `packages/features/git` |
| `view.extensions` | Show Extensions | `packages/features/extensions` |
| `agentACP.open` | Open Agent ACP | `packages/features/agent-acp` |
| `view.problems` | Show Problems | `packages/features/language` |
| `project.intelligence` | Project Intelligence | `packages/features/language` |
| `view.output` | Show Output | `packages/features/tasks` |
| `view.toggleSidebar` | Toggle Sidebar | `packages/workbench` |
| `view.togglePanel` | Toggle Panel | `packages/workbench` |
| `view.focusMode` | Toggle Focus Mode | `packages/workbench` |
| `view.resetLayout` | Reset Workspace Layout | `packages/workbench` |
| `theme.toggle` | Toggle Light/Dark Theme | `packages/features/themes` |
| `theme.classicos98.apply` | Use ClassicOS 98 Theme and Icons | `packages/features/themes` |
| `settings.open` | Open Settings | `packages/features/settings` |
| `settings.keyboard` | Open Keyboard Shortcuts | `packages/features/settings` |
| `keymap.use.*` | Use <Name> Keymap | `packages/features/keymaps` |
| `file.new` | New File | `packages/features/explorer` |
| `file.newFolder` | New Folder | `packages/features/explorer` |
| `file.save` | Save | `packages/features/explorer` |
| `file.saveAll` | Save All | `packages/features/explorer` |
| `file.revert` | Revert File | `packages/features/explorer` |
| `file.rename` | Rename… | `packages/features/explorer` |
| `file.delete` | Delete | `packages/features/explorer` |
| `file.reveal` | Reveal Active File in Explorer | `packages/features/explorer` |
| `file.copyPath` | Copy Path | `packages/features/explorer` |
| `editor.closeTab` | Close Editor | `packages/features/editor` |
| `editor.closeOthers` | Close Other Editors | `packages/features/editor` |
| `editor.pin` | Pin Editor | `packages/features/editor` |
| `editor.keepOpen` | Keep Editor Open | `packages/features/editor` |
| `editor.splitRight` | Split Editor Right | `packages/features/editor` |
| `editor.splitDown` | Split Editor Down | `packages/features/editor` |
| `editor.moveToNextGroup` | Move Editor into Next Group | `packages/features/editor` |
| `editor.find` | Find | `packages/features/editor` |
| `editor.replace` | Replace | `packages/features/editor` |
| `editor.format` | Format Document | `packages/features/formatters` |
| `editor.rename` | Rename Symbol | `packages/features/language` |
| `editor.gotoDefinition` | Go to Definition | `packages/features/language` |
| `editor.references` | Find All References | `packages/features/language` |
| `editor.codeAction` | Quick Fix… | `packages/features/language` |
| `editor.hover` | Show Hover | `packages/features/language` |
| `editor.suggest` | Trigger Suggest | `packages/features/editor` |
| `editor.foldAll` | Fold All | `packages/features/editor` |
| `editor.unfoldAll` | Unfold All | `packages/features/editor` |
| `editor.toggleWordWrap` | Toggle Word Wrap | `packages/features/editor` |
| `editor.selectAll` | Select All | `packages/features/editor` |
| `terminal.new` | New Terminal | `packages/features/terminal` |
| `terminal.toggle` | Toggle Terminal | `packages/features/terminal` |
| `terminal.split` | Split Terminal | `packages/features/terminal` |
| `terminal.kill` | Kill Active Terminal | `packages/features/terminal` |
| `terminal.clear` | Clear Terminal | `packages/features/terminal` |
| `tasks.run` | Run Task… | `packages/features/tasks` |
| `tasks.runBuild` | Run Build Task | `packages/features/tasks` |
| `tasks.rerun` | Rerun Last Task | `packages/features/tasks` |
| `tasks.cancel` | Cancel Running Task | `packages/features/tasks` |
| `git.stageAll` | Stage All Changes | `packages/features/git` |
| `git.unstageAll` | Unstage All Changes | `packages/features/git` |
| `git.commit` | Commit | `packages/features/git` |
| `git.discardAll` | Discard All Changes | `packages/features/git` |
| `git.checkout` | Checkout to… | `packages/features/git` |
| `git.push` | Push | `packages/features/git` |
| `git.refresh` | Refresh | `packages/features/git` |
| `git.fetch` | Fetch All Remotes | `packages/features/git` |
| `git.pull` | Pull (Fast-forward Only) | `packages/features/git` |
| `git.publish` | Publish Branch | `packages/features/git` |
| `git.history` | Show Commit History | `packages/features/git` |
| `git.branches` | Manage Branches and Remotes | `packages/features/git` |
| `git.branchCreate` | Create Branch | `packages/features/git` |
| `git.stashes` | Manage Stashes | `packages/features/git` |
| `lsp.restart` | Restart Language Server | `packages/features/language` |
| `preview.markdown` | Open Preview | `packages/features/previews` |
| `preview.markdownSide` | Open Preview to the Side | `packages/features/previews` |
| `extensions.install` | Install Extension… | `packages/features/extensions` |
| `extensions.checkUpdates` | Check for Extension Updates | `packages/features/extensions` |
| `workspace.open` | Open Folder… | `apps/web` |
| `workspace.switch` | Switch Workspace… | `apps/web` |
| `workspace.close` | Close Workspace | `apps/web` |
| `collab.share` | Share Workspace… | `packages/features/collaboration` |
| `collab.follow` | Follow Participant… | `packages/features/collaboration` |
| `sync.reconnect` | Reconnect | `packages/features/collaboration` |
| `notifications.clear` | Clear All Notifications | `packages/workbench` |
| `bundle.analyze` | Bundle Inspector: Analyze | `examples/bundle-inspector` |
| `help.about` | About Oxbit | `packages/workbench` |

## Settings

Definitions and validation are owned by `packages/features/settings`. Consumers are listed below. Configuration precedence is defaults, user, workspace, user language, workspace language.

| Setting | Default | Consumer |
| --- | --- | --- |
| `workbench.colorTheme` | Graphite (dark) | packages/workbench, packages/features/themes |
| `workbench.density` | compact | packages/workbench, packages/features/themes |
| `workbench.sidebarLocation` | left | packages/workbench, packages/features/themes |
| `editor.fontFamily` | 'JetBrains Mono', ui-monospace, monospace | packages/features/editor |
| `editor.fontSize` | 13 | packages/features/editor |
| `editor.lineHeight` | 20 | packages/features/editor |
| `editor.fontLigatures` | false | packages/features/editor |
| `editor.tabSize` | 2 | packages/features/editor |
| `editor.insertSpaces` | true | packages/features/editor |
| `editor.detectIndentation` | true | packages/features/editor |
| `editor.renderIndentGuides` | true | packages/features/editor |
| `editor.wordWrap` | off | packages/features/editor |
| `editor.renderWhitespace` | selection | packages/features/editor |
| `editor.cursorBlinking` | blink | packages/features/editor |
| `editor.minimap` | false | packages/features/editor |
| `files.autoSave` | off | apps/web, packages/documents, packages/features/formatters |
| `files.autoSaveDelay` | 1000 | apps/web, packages/documents, packages/features/formatters |
| `files.trimTrailingWhitespace` | true | apps/web, packages/documents, packages/features/formatters |
| `editor.formatOnSave` | false | packages/features/formatters |
| `editor.defaultFormatter` | oxbit.prettier | packages/features/formatters |
| `terminal.fontSize` | 12 | packages/features/terminal |
| `terminal.scrollback` | 5000 | packages/features/terminal |
| `terminal.confirmOnKill` | true | packages/features/terminal |
| `scm.autoFetch` | true | packages/features/git |
| `scm.diffLayout` | side-by-side | packages/features/git |

## Scenarios and journeys

| Reference group | Runtime trigger | Owner |
| --- | --- | --- |
| 1. Shell | Open or close a persisted workspace; resize browser; toggle focus, split direction and panels; refresh | apps/web, packages/workbench |
| 2. Files | Create, rename, move and delete files; runtime permissions, external edits and deletion generate file states | packages/features/explorer, packages/documents, apps/runtime |
| 3. Editor | Edit, close a dirty tab, preview and pin tabs, fold, search, wrap and enable minimap | packages/features/editor, packages/workbench |
| 4. Commands | Open files, commands, symbols, line and recent palette modes; remap shortcuts; enter unmatched queries | packages/workbench, packages/features/settings |
| 5. Search | Search IndexedDB through worker or runtime through ripgrep; cancel; invalid regex; preview and apply replacements | packages/features/search |
| 6. Language | Pair and trust runtime; start TypeScript LSP; complete, hover, navigate, rename, format; stop or restart server | packages/features/language, apps/runtime |
| 7. Terminal and tasks | Pair and trust runtime; create, resize, split and terminate PTYs; run, cancel and rerun tasks; disconnect and reconnect | packages/features/terminal, packages/features/tasks, apps/runtime |
| 8. Source Control | Initialize/clone; file and hunk staging; commit history and patches; branch/remotes management; pull/publish; stashes; revert/cherry-pick; conflict resolution and operation recovery ([guide](source-control.md)) | packages/features/git, apps/runtime |
| 9. Preview | Open Markdown editor or preview; inspect a bundle manifest through external example | packages/features/previews, examples/bundle-inspector |
| 10. Settings | Search user/workspace/language settings; invalid numeric input; reset; capture conflicting shortcuts | packages/features/settings |
| 11. Extensions | Load trusted ESM; inspect details; activation failure; compatible update; disable and remove | packages/features/extensions, packages/core |
| 12. Real-time | Two authenticated browser sessions join a document; edit concurrently; disconnect one; reconnect; follow participant | packages/features/collaboration, packages/documents, apps/runtime |
| J1 | Open, find, edit, split, save, refresh and restore | apps/web, packages/workbench, packages/features/editor, packages/documents |
| J2 | Request actual LSP diagnostics and apply a server code action | packages/features/language, packages/documents |
| J3 | Worker/ripgrep search; revision-captured replace preview; apply and inspect unsaved text | packages/features/search |
| J4 | Stage real disk edits, enter a commit message and run Git commit | packages/features/git, apps/runtime |
| J5 | Run trusted task; stream output; navigate a file location | packages/features/tasks, apps/runtime |
| J6 | Disable and enable Bundle Inspector; contributed surfaces dispose and return | packages/features/extensions, examples/bundle-inspector, packages/core |
| J7 | Disconnect one session; edit retained Yjs document; reconnect and converge | packages/features/collaboration, packages/documents, apps/runtime |

The reference review drawer and simulated phone keyboard are design inspection tools. Browser resizing and the device input method exercise application behavior. Verification results are recorded separately under `evidence/`.
