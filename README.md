# Oxbit feature gaps

Created: 2026-10-02. Last updated: 2026-10-02.

This document lists the IDE features Oxbit lacks as of 2026-10-02 and plans
the work for each. Each item states the current state with source references, the target,
the design, ordered steps, and the checks that prove it landed.

Oxbit's existing strengths stay in place. One codebase serves browser,
desktop, iOS, and SSH remote. Real-time collaboration is built in. The ACP
agent panel has permission controls and diff review. Every item below reuses
the runtime trust boundary, the SDK registry, and the managed installer, so
those strengths stay intact.

| # | Item | Size | Depends on | Plan |
| --- | --- | --- | --- | --- |
| 1 | Debugger (DAP) | Large | none | runtime.md |
| 2 | Language breadth | Medium | none | runtime.md |
| 3 | Vim keymap | Medium | none | editor.md |
| 4 | Windows desktop | Large | none | runtime.md |
| 5 | Test runner | Medium | 1 | runtime.md |
| 6 | LSP depth | Medium | none | editor.md |
| 7 | Refactoring | Medium | 6 | editor.md |
| 8 | Inline AI completion | Medium | none | editor.md |
| 9 | Git depth | Medium | none | runtime.md |
| 10 | Large-file and monorepo performance | Medium | none | editor.md |
| 11 | Extension sandbox and registry | Large | none | ecosystem.md |
| 12 | VS Code grammar and theme compatibility | Medium | 10, 11 | ecosystem.md |
| 13 | Tool windows | Large | 6, 11 | ecosystem.md |

Plans: [runtime.md](runtime.md), [editor.md](editor.md), [ecosystem.md](ecosystem.md).

## Sequencing

Two tracks run in parallel. Their write targets are disjoint.

| Track | Order |
| --- | --- |
| Runtime and languages | 2, 1, 5, 9, 4 |
| Editor and ecosystem | 3, 6, 8, 7, 10, 11, 12, 13 |

Item 2 goes first. Every later language feature needs a real server to test
against. Item 3 leads the editor track. It is the cheapest item with the
largest audience effect.

## New dependencies

These need approval before the item starts.

| Item | Package | Reason |
| --- | --- | --- |
| 3 | `@replit/codemirror-vim` | Modal editing engine |
| 2 | `@codemirror/lang-rust`, `lang-go`, `lang-python`, `lang-cpp`, `lang-java`, `lang-yaml` | Syntax fallback |
| 10 | `web-tree-sitter` | Worker highlighting |
| 12 | `vscode-textmate`, `vscode-oniguruma` | TextMate grammars |
| 13 | `pg`, `mysql2`, `better-sqlite3`, `dockerode` | Tool window drivers |

## Out of scope

- React Native host
- Windows as an SSH remote target
- Marketplace payments
- Intel Mac and Linux arm64 desktop builds
- App store distribution
