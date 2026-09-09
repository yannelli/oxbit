# Dispatched subagents — acceptance

Implemented for the selected Agent ACP conversation, with a shared tree in the
conversation and the dedicated **Agents** workbench view. The extension remains
disabled by default. No provider hooks, adapter upgrades, manual dispatch, or
individual child-control commands were added.

## Implemented behavior

- Codex negotiates child sessions and tracks native lifecycle, nested children,
  generation-specific identities, messages, thought chunks, tools, and results.
  Structured Codex metadata provides a fallback for adapters without native events.
- Cursor task notifications are correlated with tool calls and explicit outcomes.
  Amp's pinned Task mapping exposes task inputs and returned output. These paths
  are labeled limited visibility and never equate successful tool return with a
  background child's completion.
- Registry state belongs to a connection/root conversation. Registered descendants
  retain identity through updates, permissions, questions, filesystem requests,
  and session-scoped terminals. Unknown sessions cannot call client tools.
- Parent completion leaves live-child tracking and child requests intact. Active
  children and pending requests block conversation switching; disconnect still
  works. Expired requests cannot return after a delayed editor read.
- Both views share selection, expansion, lifecycle counts, and request attribution.
  Identity reconciliation preserves discovery order and timeline position.
  Keyboard navigation, phone layouts, and light/dark colors are covered.
- Historical children are marked as historical, never live. Replay updates the
  existing tree without duplicate dispatch or resending the draft. Preview
  truncation cannot remove runtime session authorization or active-child counts.

## Interfaces and retention

Shared SDK types describe child identity/parent, discovery order, reported state,
activity phase, evidence/visibility, timestamps, bounded activity, and results.
The runtime emits `acp.subagent` deltas including the root session, changed child,
removed display IDs, active count, and truncation. Existing update/request/terminal
events carry session/root attribution; `acp.requestsExpired` identifies reviews
that must be removed. No persisted record authorizes a runtime operation.

The runtime retains up to 256 display records, 32 activity entries per child, and
512,000 serialized activity characters in total. Native registration and fallback
lifecycle state are independently bounded at 1,024 identities each. Native
registration survives display pruning. History stores child summaries within its
750,000-character child-preview allocation and existing approximate 4 MiB budget.
Older version-1 histories without children remain compatible.

## Verification

- Unit/integration coverage includes real stdio subprocesses, nested and reopened
  children, native/fallback identity merging, early updates, stale outcomes,
  malformed metadata, Cursor and Amp correlation, concurrent requests, terminal
  and workspace isolation, root completion before child approval, request expiry,
  history budgets, and protection against two children replacing the same file.
- The subagent browser journey exercises both real UI surfaces, keyboard tree
  navigation, permission approval, editor diff review and disk save, parent/child
  transcript separation, historical reload, provider replay, draft retention,
  phone overflow, and both themes.
- The existing ACP opt-in, lifecycle, and conversation workflow browser journeys
  are also included in validation.

Final checks on 2026-09-08:

- Full unit suite: **668 passed across 76 files** (25.54 seconds).
- ACP browser journeys: **4 passed**: subagents, conversation workflows, opt-in
  persistence, and lifecycle/tooling.
- Root typecheck and lint: passed.
- Runtime and web production builds: passed. The web build retains the existing
  large-bundle advisory.
- Theme surface inventory and `git diff --check`: passed.
- Final dark/light phone captures and the attributed Agents approval were visually
  inspected.

## Installed adapter checks — 2026-09-08

All three providers completed ACP v1 initialization through the actual updated
`AgentACP` runtime bridge in a disposable workspace. No model prompt was sent.

| Provider | Version observed | Result |
| --- | --- | --- |
| Codex ACP | Adapter 1.10.0; installed standalone Codex CLI 0.153.4 | Initialization passed and advertised `sessionCapabilities.subagents`. The adapter uses its own compatible Codex dependency. |
| Cursor | CLI 2026.08.11-e8db854 | Initialization passed; no native subagent capability advertised. |
| Amp ACP | Adapter 0.9.0; Amp CLI 0.0.1788883237-g0b98e3 | Initialization passed; no native subagent capability advertised. |

[Captured initialization metadata](adapter-handshakes.json) contains only provider
identity and capabilities. Live authenticated model dispatch, fresh native desktop
launch, and CI were not exercised. Provider task lifecycles were validated with
version-grounded deterministic fixtures rather than paid model runs.

## Visual captures

- [Conversation tree](conversation-dark.png)
- [Agents view and attributed approval](agents-dark.png)
- [Phone, dark](phone-dark.png)
- [Phone, light](phone-light.png)
