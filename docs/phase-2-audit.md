# Original Phase 2 audit

The audit uses [the original specification](../PHASE-2_FULL_IMPLEMENTATION.md)
and the preserved [design interaction](../design/interaction-spec.md) and
[extension surface](../design/extension-surfaces.md) contracts. It checks
reachable behavior, public consumers, disposal, and recovery.

Native directory recovery passes: its browser journey failed twice on a
Chromium 153 browser crash, and passes on the pinned Chromium 151. All 19
browser journeys and 123 unit/integration tests passed. This audit does not
certify Phase 2 as gap-free.

## Gaps fixed

| Area | Change |
| --- | --- |
| Public SDK | Provider payloads now have consumers for filesystems, transports, syntax, diagnostics, completions, code actions, formatting, and editor decorations. The browser facade is generated from SDK exports. |
| Extension lifecycle | Manifest setting schemas stay available while installed. Disablement cancels owned work; failed updates restore the earlier schemas and implementation. |
| Documents | Saves and resource operations preserve revisions, format choices, view state, and recovery content. Native directory renames copy bytes; stable directory IDs and encoding hints survive reselection. |
| Workspaces | Opening a native or contributed filesystem uses its files. Switching persists drafts, disposes the previous host, and preserves the prior session if opening fails. |
| Configuration | Pending runtime settings and their base revision survive refresh. Disk conflicts have explicit reload/save commands. Autosave uses language scopes and cancels old timers when settings change. |
| Workbench | Contribution menus, toolbars, tabs, views, themes, icons, decorations, notification actions, and expiry are connected. Tab/group actions use the selected target and preserve independent view state. |
| Editor | Text changes update document metadata without rerendering the entire shell on each keystroke. Large files use a stated reduced feature set. |
| Language intelligence | Server-initiated workspace edits return to their initiating browser for permission/revision checks and acknowledgement. Contributed providers cancel stale work and clear removed results. |
| Search | Results group by file; replacement selection is reversible. Previews keep their query and revisions. Workers use bounded batches and report unreadable files. |
| Formatters and preview | Prettier and the TypeScript compiler are separate worker providers. Markdown opens beside its source, synchronizes scrolling, and applies a defined link policy. |
| Runtime and terminals | Reconnect renews file watching; trust revocation cancels pending tools. Task output preserves split UTF-8 sequences. Terminal lifecycle events reach SDK listeners. |
| Git | Clone reserves its destination before work starts. Local-remote tests cover clone, push, fetch, cancellation, and checkout preservation. Buffer comparisons keep buffer, saved, disk, and index content separate. |
| Collaboration | Recovered drafts upload before shared saves. Closing documents leaves rooms; disabling collaboration blocks stale saves and releases listeners. |
| Licensing and README | MIT names Ryan Yannelli, his email, and `yannelli`. Package metadata and SDK/example licenses match. Font notices remain intact. README covers launch, workspaces, development, extensions, tests, and reference links. |

## Requirement ownership

| Original specification section | Main implementation |
| --- | --- |
| Design contract; settings, accessibility and customization | `packages/ui`, `packages/workbench`, settings/editor/themes features; `design/`, [ownership map](feature-map.md) |
| Product/platform scope; architecture | `apps/*`, `packages/host-*`, `packages/core`; [host boundaries](architecture.md) |
| Dependencies | Workspace manifests, `pnpm-lock.yaml`; [versions and exceptions](dependencies.md) |
| Extension SDK/lifecycle; events/hooks/commands | `packages/sdk`, `packages/core`, extension feature, external Bundle Inspector; [SDK](sdk.md) |
| Documents/files/workspaces | Document and host packages, explorer/search features, `apps/web/src/configuration.ts`; [persistence](persistence.md) |
| Editing/language intelligence | Editor, language, and formatter features; runtime LSP; [language services](language.md) |
| Terminal/tasks/Git/previews | Their feature packages and `apps/runtime`; [runtime](runtime.md) |
| Real-time/collaboration; runtime security/trust | Protocol/host-runtime, collaboration feature, runtime; [trust](security.md) |
| Performance/reliability; verification/acceptance | Focused tests, browser journeys, comparisons, measurements; [acceptance record](../evidence/acceptance.md) |
| Deliverables | Source, README, SDK/example, architecture/trust/recovery docs, design references, test evidence, [feature status](feature-status.md) |

Check results and remaining verification limits are recorded in
[acceptance evidence](../evidence/acceptance.md). Native packaging, React Native,
certified Paseo 0.7.0 integration, marketplace distribution, and additional
debugging/AI providers remain deferred by the original scope.
