# Code fences

Created: 2026-10-19. Last updated: 2026-10-19.

Oxbit treats fenced code in Markdown files and in comments as code in the fence's language.

## Behavior

| Feature | Markdown fences | Fences in comments |
| --- | --- | --- |
| Syntax highlighting | The Markdown parser's `codeLanguages` option parses fence content with the fence language. | `commentFenceHighlighting` parses each fence with its language and adds theme classes as marks. |
| Problems, completion, hover, signature help | The fence's language server | The fence's language server |
| Semantic highlighting and inlay hints | The fence's language server | The fence's language server |

Fences in comments need a comment marker (`//`, `///`, `#`, `--`, `;`, or ` * ` inside a block comment) before the opening fence and on every content line. A fence in a string literal stays plain text.

The info string picks the language: an ID (`typescript`), an extension (`ts`), a settings alias, a title (`python`), or one of `shell`, `console`, `docker`, `json5`, `yml`, `py`, `md`. `{.tsx}` and `ts title=a.ts` resolve to the first word. Fences with no info string or an unknown language stay plain.

## Language servers

`packages/features/language/src/index.ts` keeps one in-memory document per fence while its host file is open in an editor:

- The path is a sibling of the host, `README.md.fence-0.ts`, so relative imports and `node_modules` resolve from the host's folder. The path has no `#` or `?`, which the iOS servers reject.
- The document is never written to disk and is not in `documents.documents`. The runtime accepts the missing file because `WorkspaceFiles.resolve(path, true)` in `apps/runtime/src/filesystem.ts` allows missing paths.
- Each host change re-reads the fences. A changed fence sends `didChange`; a removed fence sends `didClose`.
- Requests at a position inside a fence go to the fence document's server. Ranges in the response map back to the host (`fenceResultToHost` in `embedded.ts`).
- Problems from fence documents appear under the host file, in the editor and in Problems.

A fence is a separate file. Code that uses names from the host file, from earlier fences, or from packages that are not installed reports errors. Turn off `editor.embeddedCode.diagnostics` to hide them.

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| `editor.embeddedCode.highlighting` | `true` | Highlight fence content with the fence language. |
| `editor.embeddedCode.languageServers` | `true` | Open fences as documents for their language servers. |
| `editor.embeddedCode.diagnostics` | `true` | Show problems from fence documents. |

All three read the host file's language, so a per-language override such as `"[markdown]": { "editor.embeddedCode.diagnostics": false }` applies to Markdown files only. Turning off the language server for a file also turns off its fences.

## Code

- `packages/sdk/src/fences.ts`: fence detection, language lookup, offset mapping, and fence paths.
- `packages/features/editor/src/fence-syntax.ts`: Markdown `codeLanguages` and comment fence highlighting.
- `packages/features/language/src/embedded.ts`: fence documents and result mapping.
- `packages/features/language/src/overlays.ts`: `FenceOverlays` for semantic tokens and inlay hints.
- Tests: `packages/sdk/src/fences.test.ts`, `tests/browser/code-fences.spec.ts`.

## References

- CodeMirror `@codemirror/lang-markdown`, `codeLanguages` option: https://github.com/codemirror/lang-markdown
- CommonMark fenced code blocks: https://spec.commonmark.org/0.31.2/#fenced-code-blocks
- LSP 3.17 text document synchronization: https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_synchronization
- JetBrains language injections: https://www.jetbrains.com/help/idea/using-language-injections.html
