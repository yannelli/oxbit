# Agent ACP acceptance — September 7, 2026

- `pnpm lint`: passed after removing an unused fixture import.
- `pnpm build`: passed, including TypeScript, runtime, SDK example, and web builds.
- `pnpm exec vitest run`: 432 tests passed across 55 files, including 14 new ACP tests.
- `pnpm exec playwright test tests/browser/agent-acp.spec.ts --reporter=list --output=/tmp/oxbit-acp-browser-results`: both journeys passed.
- `git diff --check`: passed.

Browser journeys verify disabled defaults in new and existing workspaces,
persisted explicit enable/disable, all three provider choices, missing-runtime
instructions, executable configuration, real stdio fixture conversations,
permission rejection, editor attachments, terminal output, approved edits to
shared files, new-file creation, dirty-buffer protection, Cursor questions,
cancellation, disable/reactivation, trust revocation, and rejection of non-owner
agent launch requests. The phone composer was clicked and focused with the
terminal panel closed; screenshots were visually inspected.

The real providers each completed ACP version 1 initialization through the
runtime bridge in an isolated temporary workspace:

| Provider | Launch | Advertised authentication methods |
| --- | --- | --- |
| Codex ACP | `npx -y @agentclientprotocol/codex-acp@1.10.0` | `api-key`, `chat-gpt` |
| Cursor ACP | `agent acp` | `cursor_login` |
| Amp Agent ACP | `npx -y amp-acp@0.9.0` | `setup` |

No live model prompt, provider billing, native Tauri launch, or complete existing
browser suite was exercised. Conversations, approvals, and terminal behavior
were tested through the deterministic ACP process fixture. Existing Vite
sourcemap and large-chunk build warnings remain.

Screenshots: [desktop](desktop.png), [phone](phone.png),
[conversation and tools](conversation.png).
