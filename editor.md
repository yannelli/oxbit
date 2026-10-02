# Feature gaps: editor track

Created: 2026-10-02. Last updated: 2026-10-02.

Items 3, 6, 7, 8, and 10 from the [feature gaps index](README.md). Order: 3, 6, 8, 7, 10.

## 3. Vim keymap

**Current state.** `packages/features/keymaps/src/maps/` has seven keymaps
(`vscode.ts`, `jetbrains.ts`, `sublime.ts`, `atom.ts`, `emacs.ts`,
`visual-studio.ts`, `macos.ts`). Each is a flat
command-to-chord table. Modal editing has no representation. The keymap
contribution in `docs/sdk.md` applies bindings above command defaults and below
user keybindings.

**Target.** Normal, insert, visual (character, line, block), and replace modes.
Operators, motions, text objects, counts, registers, marks, dot repeat, macros,
search with `/` and `?`, and a `:` command line with `:w`, `:q`, `:e`, `:s`,
`:%s`, `:noh`, and `:set`. A mode indicator in the status bar. Multi-cursor
through visual block.

**Design.**

- Adopt `@replit/codemirror-vim` as the engine. It is a CodeMirror 6 port of the
  CodeMirror 5 Vim implementation and covers the target list. New dependency;
  requires approval before the work starts.
- Register it as an `editorDecoration` contribution from a new
  `packages/features/keymaps/src/vim.ts` so it mounts per editor and unmounts
  when the keymap changes. Mode state is per-view, matching existing per-view
  selection ownership in `packages/documents`.
- Add a `vim` keymap entry in `maps/` for workbench chords such as `Ctrl+W`
  splits, and route `:` commands with no editor meaning to the palette.
- Route `:w`, `:q`, `:e`, `:vsplit`, and `:split` to `file.save`,
  `editor.closeTab`, `workbench.quickOpen`, and `editor.splitRight`/`splitDown`.
- Mode indicator: a `statusItem` contribution reading the view's mode.
- Collaboration: the Yjs undo manager owns history. Disable the plugin's own
  undo and map `u` and `Ctrl+R` to the document undo commands.
- Settings: `vim.enabled` per user scope, `vim.leader`, `vim.useSystemClipboard`.

**Steps.**

1. Dependency approval and license entry in `THIRD_PARTY_NOTICES.md`
2. Extension mount through `editorDecoration`, undo routing, mode indicator
3. `vim` workbench keymap and `:` command routing
4. Settings and documentation in `docs/feature-map.md`

**Checks.** Unit tests for `:` routing. A Playwright scenario that enters normal
mode, runs `ciw`, `.`, `:%s/a/b/g`, and `:w`, and asserts document and disk
state. A collaboration test where two clients with Vim enabled undo their own
edits.

## 6. LSP depth

**Current state.** `docs/language-support.md` states that CodeLens, pull
diagnostics, range formatting, and on-type formatting stay unsupported even when
advertised. Advanced TextMate snippet transforms are incomplete.

**Target.** CodeLens with resolve and command execution. Pull diagnostics
including workspace diagnostics. Range formatting, on-type formatting, server
folding ranges, selection ranges, linked editing ranges, and full TextMate
variable and regex transforms in snippets.

**Design.** All of these fit the existing capability negotiation in
`packages/sdk/src/lsp-capabilities.ts` and the request routing in
`packages/features/language/src/index.ts`.

- CodeLens: viewport request with 150 ms debounce like inlay hints in
  `overlays.ts`. Render as a block widget above the line. Resolve lazily on
  visibility. Commands run through the same advertised-command path as completion.
- Pull diagnostics: when advertised, replace push subscription with
  `textDocument/diagnostic` on change plus `workspace/diagnostic` on idle. Keep
  the per-server version checks.
- Range formatting: an `editor.formatSelection` command. On-type formatting: a
  hook keyed by the server's trigger characters, gated by `editor.formatOnType`.
- Folding and selection ranges: replace the syntax-tree fold source with the
  server's when available. Add `editor.expandSelection` plus
  `editor.shrinkSelection`.
- Linked editing: on cursor in a linked range, apply edits to all ranges.
- Snippets: implement `${TM_FILENAME_BASE}`, `${TM_SELECTED_TEXT}`,
  `${CLIPBOARD}`, and `${1/regex/fmt/}` with case modifiers in `completion.ts`.

**Steps.** One commit per capability in the order above. Update the capability
matrix in `docs/language-support.md` and remove the "remain unsupported" sentence.

**Checks.** Unit tests per capability in `packages/features/language`. Extend
`scripts/language/intelligence.ts` to assert CodeLens on a TypeScript fixture
plus pull diagnostics on a Rust fixture after item 2.

## 7. Refactoring

**Current state.** Rename through `prepareRename` and code actions through the
`codeAction` contribution. No move-file import rewrite, extract, change
signature, or safe delete.

**Target.** Move or rename a file in the explorer and rewrite imports across the
project. Extract function, variable, constant, and interface. Inline, change
signature, safe delete with usage preview, and a refactor preview panel that
shows every edit before it applies.

**Design.**

- Most operations are LSP code actions with `refactor.*` kinds. Surface them in
  a Refactor submenu and the `editor.refactor` command, grouped by kind.
- File moves: `workspace/willRenameFiles` returns a `WorkspaceEdit`. Hook the
  explorer rename and drag-drop paths to request it, preview, then apply through
  the revision-safe editing path in `packages/documents`.
- Safe delete: `workspace/willDeleteFiles` plus a references query for the
  file's exported symbols. Show usages before confirming.
- Preview panel: a reusable multi-file `WorkspaceEdit` preview built on the
  search replace preview, which already checks document versions per file.
- Where a server lacks an operation, the TypeScript companion in the runtime
  provides extract and move through `ts.LanguageService.getEditsForRefactor`
  and `getEditsForFileRename`.

**Steps.**

1. `WorkspaceEdit` preview panel
2. `willRenameFiles` on explorer rename and move
3. Refactor submenu with kind grouping
4. `willDeleteFiles` and safe delete
5. TypeScript fallbacks for extract and change signature

**Checks.** Unit tests for edit preview and apply. Playwright: rename a
TypeScript file with two importers and assert both imports update.

## 8. Inline AI completion

**Current state.** `packages/features/agent-acp` provides chat, editor context,
permission controls, diff review, and subagent tracking. No ghost-text
completion.

**Target.** Multi-line ghost text with Tab accept, word and line partial accept,
next-edit suggestions, and a provider abstraction so users choose their model.

**Design.**

- `packages/sdk/src/inline-completion.ts`: `InlineCompletionProvider` with
  `provide(document, position, context, signal)` and an `inlineCompletion`
  contribution kind.
- Providers: an ACP-backed provider that reuses the configured agent's model,
  and an OpenAI-compatible HTTP provider for local models. Requests run through
  the runtime so keys stay out of the browser.
- Editor: a CodeMirror view plugin that renders the suggestion as a widget
  decoration, debounced at 300 ms, cancelled on edit. Context is the current
  document plus open-tab excerpts, bounded to a token budget. Yjs awareness
  ignores ghost text.
- Privacy: off by default, per-workspace opt-in, an indicator while a request
  is in flight, and a setting to exclude globs.

**Steps.**

1. SDK types and view plugin with a fake provider
2. Runtime proxy and OpenAI-compatible provider
3. ACP provider
4. Partial accept and next-edit suggestions

**Checks.** Unit tests for the view plugin with a scripted provider. Playwright
against a local stub server asserting Tab accept and cancellation on typing.

## 10. Large-file and monorepo performance

**Current state.** Semantic tokens and inlay hints default off above 1 MiB.
Syntax uses CodeMirror Lezer grammars and legacy modes. The project scanner
caps at 20,000 files and 1 MiB per file.

**Target.** Published benchmarks on a large monorepo and a 50 MiB log file.
Keystroke latency under 16 ms at the p95 on both. Tree-sitter highlighting for
languages without a Lezer grammar, incremental and off the main thread.

**Design.**

- Benchmarks: `scripts/bench/` with Playwright traces that measure input latency,
  file open time, and search time. Publish results in `docs/performance.md`.
- Tree-sitter: `web-tree-sitter` in a worker, one WASM grammar per language,
  highlight queries from upstream. Expose as a `language` contribution so
  extensions can add grammars. Lezer stays for languages that have it.
- Large files: streaming open with a read-only fast path above 32 MiB, no
  Yjs binding until the user edits, and viewport-only decorations.
- Search: ripgrep already backs workspace search. Add result streaming with
  cancellation to the search view.
- Explorer: virtualized tree and lazy directory reads for roots above 10,000
  entries.
- Index: raise the scanner cap to 200,000 files with an incremental watcher
  update path in place of full rescans.

**Steps.**

1. Benchmark harness and baseline numbers
2. Explorer virtualization and search streaming
3. Large-file read-only fast path
4. Tree-sitter worker and first three grammars
5. Incremental index updates

**Checks.** Benchmark job in CI that fails on a 20 percent regression against
the recorded baseline.
