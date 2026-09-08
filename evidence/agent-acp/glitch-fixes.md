# ACP glitch fixes — September 7, 2026

The panel rendered legacy mode/model selectors alongside the same controls in
`configOptions`, and the shared select's label was accessible-only. It now renders
one set of visibly labeled settings in the provider's order, with legacy fallback
when no config options are advertised. Connected provider names remain readable.
This follows the [ACP session configuration specification](https://agentclientprotocol.com/protocol/v1/session-config-options).

Settings changes lock until confirmed, apply dependent options together, retain
the confirmed selection on errors, and preserve keyboard focus. Session lifecycle
generations prevent old connection attempts, prompts, authentication, and settings
responses from changing newer session state. Prompt errors clear the working state;
failed cancellation can be retried. Disconnect and trust/runtime loss invalidate
pending file reviews and reset operation state.

Verified on the final ACP code:

- 29 tests passed: `pnpm exec vitest run apps/runtime/tests/agent-acp.test.ts packages/features/agent-acp/src`.
- Scoped TypeScript passed: `pnpm exec tsc -b packages/features/agent-acp apps/runtime`.
- ESLint passed for the ACP feature, SDK types, runtime bridge, runtime tests,
  browser journeys, and stdio fixture.
- Web and runtime production builds passed. Existing Vite source-map/chunk
  warnings remain.
- Both journeys passed: `pnpm exec playwright test tests/browser/agent-acp.spec.ts --reporter=list`.
  Coverage includes five labeled controls instead of seven duplicated controls,
  keyboard selection and focus restoration, dependent reasoning options,
  rejected model changes, draft retention, provider-originated config updates,
  prompt-error recovery, desktop/phone layouts, approvals, file edits and creation,
  dirty buffers, terminals, questions, cancellation, extension lifecycle, trust,
  and owner isolation.
- The locally cached real `@agentclientprotocol/codex-acp@1.10.0` adapter completed
  initialization and session creation in a temporary workspace. It advertised
  three legacy modes, 35 legacy model/reasoning combinations, and five modern
  controls: Mode, Collaboration mode, Model, Reasoning effort, and Fast mode.
  The new renderer selected those five modern controls. No model prompt was sent.
- `git diff --check` passed.

The full repository type check currently fails outside ACP at
`packages/features/editor/src/index.tsx:201` with TS2739 (`Language` is missing
`language` and `support` from `LanguageSupport`). Other workspace edits were
preserved. Native Tauri launch and live provider prompts were not tested in this
fix pass.

Visually inspected: [desktop settings](settings-desktop.png),
[phone settings](settings-phone.png), and the existing conversation journey.
