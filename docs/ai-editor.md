# AI editing

Created: 2026-10-18. Last updated: 2026-10-18.

The `oxbit.ai` feature (`packages/features/ai`) adds ghost text completions and inline edits to the CodeMirror editor. Both send code from the open file to the model provider that the Oxbit agent uses.

## Features

| Feature | Use | Keys |
| --- | --- | --- |
| Inline completions | Off by default. Turn on `ai.inlineCompletions.enabled`, or run **AI: Toggle Inline Completions**. After `ai.inlineCompletions.delay` ms without typing, the model's suggestion appears as dim text at the cursor. Typing the suggested characters keeps the rest. | Tab accepts, Escape dismisses, Ctrl/Cmd+Right accepts one word. **AI: Suggest Inline Completion** requests one on demand. |
| Edit Selection with AI | Asks for an instruction, replaces the selection with the model's rewrite, and highlights the new text. With no selection it inserts code at the cursor. The edit is one undo step. If the selected text changes while the request runs, nothing is applied. | Ctrl/Cmd+Alt+K. Escape cancels a running request. |

Ctrl/Cmd+K is a chord prefix in Oxbit, so the inline edit uses Ctrl/Cmd+Alt+K.

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| `ai.inlineCompletions.enabled` | `false` | Request suggestions while typing. |
| `ai.inlineCompletions.delay` | `350` | Milliseconds of idle time before a request. |
| `ai.model` | `""` | Model ID for AI editing. Empty uses the Oxbit agent's model. |
| `ai.effort` | `""` | Reasoning level sent with each request, for example `minimal` or `low`. |

The settings appear on the Editor page under **AI**.

## Where requests go

`createAiService` in `src/service.ts` picks the transport for each request:

1. When the host registers `AGENT_MODELS_SERVICE` and it holds a key for the Oxbit agent endpoint, the request goes through it. Only iOS registers that service; the key stays in the Keychain.
2. Otherwise, with a runtime connection, it calls the runtime's `ai.complete` method. `apps/runtime/src/ai.ts` loads `~/.oxbit/agent/settings.json` (or `OXBIT_AGENT_HOME`) and `auth.json`, and selects the provider the way `oxbit-agent` does. It returns the reply's text. The key does not leave the runtime.
3. With neither, the request fails with "AI editor features need a runtime connection or an API key in Agent setup".

`ai.complete` requires an owner session and a trusted workspace, the same rule as `acp.*`. It passes the request's abort signal to the model request, so a cancelled client request stops it. The runtime imports `@oxbit/agent/auth`, `@oxbit/agent/config` and `@oxbit/agent/providers`, which `vite.config.ts` and `vite.desktop.config.ts` bundle.

## Prompts

`src/prompt.ts` sends up to 6,000 characters before the cursor and 2,000 after, with a `<|cursor|>` marker, to a chat model. `cleanCompletion` removes a Markdown fence, an echoed cursor marker, a repeated current line, and characters that already follow the cursor, and keeps at most 24 lines. Inline completions request at most 256 output tokens; inline edits request at most 8,192.

## Implementation notes

- The ghost text `StateField`, `ViewPlugin` and keymap are module-level values. The editor rebuilds `editorDecoration` extensions on every context change, and reusing the same values keeps the current suggestion and in-flight request.
- The keymap uses `Prec.highest`, and each command returns `false` when there is nothing to accept, so Tab still indents and Escape still reaches other handlers.
- Documents use a Yjs `UndoManager`, which merges changes made within its capture window. The inline edit calls `stopCapturing()` before and after its change so Undo reverts only the AI edit.

## Tests

- `packages/features/ai/src/*.test.ts`: prompt cleanup, ghost state, inline edit application, and transport selection.
- `apps/runtime/tests/ai.test.ts`: provider, key and model selection for `ai.complete`, with a fake `fetch`.
- `tests/browser/ai-editor.spec.ts`: ghost text accept and dismiss, and the inline edit with undo, against a fake `agentModels` service.

## References

- CodeMirror reference manual, `Prec`, `StateField`, `ViewPlugin`, `WidgetType` and `keymap`: https://codemirror.net/docs/ref/
- Yjs `UndoManager` and `stopCapturing`: https://docs.yjs.dev/api/undo-manager
- Model APIs used by the adapters: [agent-model-apis.md](agent-model-apis.md)
