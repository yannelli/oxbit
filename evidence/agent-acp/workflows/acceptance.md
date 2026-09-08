# ACP editor workflow verification

Completed 2026-09-08 in the shared Oxbit checkout. Agent ACP remains disabled by
default, with the existing Codex, Cursor, and Amp presets.

## Delivered

- Workspace-local, bounded conversation history with search, Read, Resume,
  Forget, saved drafts and attachment snapshots. Capability-gated provider
  discovery, pagination, load replay, and resume without replay. No automatic
  prompt resend on failure or reload.
- Chronological Markdown messages and tool activity, expandable context, file
  links, copy actions, collapsible settings/plans, scroll-follow control, and
  a persistent shortcut to pending input.
- File and selection snapshots with line ranges, a workspace context browser,
  active-file diagnostics, character counts, and negotiated ACP resource blocks.
- Unified file proposals in the panel and main editor, shared approval expiry,
  and revision-guarded undo for existing files. Apply and Undo preserve exact
  snapshots while ordinary editor saves keep formatting hooks.
- Composer Ctrl/Cmd+Enter takes precedence over global shortcuts. The existing
  global commit binding previously swallowed this shortcut.
- Fixed a runtime startup race discovered by the browser tests: project watcher
  callbacks now wait for language server initialization before refreshing schemas.

## Evidence

- Full unit suite: **541 passed across 64 files**.
- Focused ACP and shared-document suites: **50 passed**.
- Root typecheck and lint: passed; scoped checks repeated after the shortcut fix.
- Runtime and web production bundles: passed. Existing Vite source-map and bundle
  size warnings remain.
- Browser: **3 passed**, covering default-disabled persistence; approvals,
  context, terminals, settings, cancellation and trust revocation; and the new
  history/reload/restore, Markdown, keyboard submission, context-resource,
  main-editor review, exact disk undo, and 390px dark/light workflow.
- Theme coverage inventory regenerated and checked; diff whitespace check passed.

The fixture uses a real child process and ACP stdio. History tests restart the
process and confirm the original prompt was not sent twice. Runtime tests also
exercise missing capabilities, resume-only agents, session pagination, workspace
filtering, failed loads, and attached-path containment. Document tests confirm
reviewed saves bypass transformation hooks while ordinary saves retain them.

Screenshots: `activity-dark.png`, `editor-review-dark.png`, `history-dark.png`,
`phone-dark.png`, and `phone-light.png`. Inspected desktop and phone captures.

Live model prompts, account authentication, native desktop launch, and CI were
not exercised in this iteration. Provider-specific behavior beyond the tested
ACP contract still requires live-account validation. Multimodal input, arbitrary
MCP configuration, and concurrent live conversations are not implemented here.

Research and protocol source links are in `docs/agent-acp.md`. Zed source/layout
was studied as a reference, with no code copied into Oxbit.
