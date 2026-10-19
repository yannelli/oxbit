# AI editing

Created: 2026-10-18. Last updated: 2026-10-19.

The `oxbit.ai` feature (`packages/features/ai`) adds ghost text completions and inline edits to the CodeMirror editor. Both send code from the open file to the provider `ai.provider` names: the Oxbit agent's provider, OpenRouter, a custom OpenAI-compatible API, or a local Ollama or llama.cpp server.

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
| `ai.provider` | `agent` | `agent` (Agent harness): the Oxbit agent's provider and key. `openrouter`: `https://openrouter.ai/api`. `openai-compatible` (Custom OpenAI API): Chat Completions at `ai.baseUrl`. `local`: Ollama or a llama.cpp server at `ai.baseUrl`, without a key. |
| `ai.baseUrl` | `""` | Base URL for `openai-compatible` and `local`. Empty `local` uses `http://localhost:11434`. llama.cpp's `llama-server` listens on `http://127.0.0.1:8080`. On iPhone, use the computer's LAN address. |
| `ai.model` | `""` | Model ID for AI editing. With `agent`, empty uses the Oxbit agent's model. Other providers need one. |
| `ai.effort` | `""` | Reasoning level sent with each request, for example `minimal` or `low`. |

The settings appear on the Editor page under **AI**. The provider select shows the labels from `Setting.enumLabels`. **Set API Key…** runs **AI: Set AI Provider API Key**, which saves the `openrouter` or `openai-compatible` key: on iOS in the Keychain through `AGENT_MODELS_SERVICE`, under the same account Agent setup uses for that endpoint; with a runtime, in the Oxbit agent's `auth.json` through the runtime's `ai.key` method, under the slot `oxbit-agent login --provider` writes.

### Model suggestions

The `oxbit.ai.models` `settingSuggestions` contribution lists models under **AI model**. `src/models.ts` holds recommended inline completion models per catalog (OpenRouter, OpenAI, Anthropic, local), with price per 1M input/output tokens, context or download size, and one benchmark score. [AI inline completion models](ai-inline-models.md) lists the sources and dates. The `agent` provider uses the catalog for the agent's API. For `local` and `openai-compatible`, the list adds the models the server returns from `GET /v1/models`, through the iOS model service or the runtime's `ai.models` method; local models the server has show `installed`. Selecting a suggestion sets `ai.model`.

The Settings page reloads suggestions when `SettingSuggestions.key()` changes, which covers the provider, base URL and the agent's API.

## Where requests go

`createAiService` in `src/service.ts` picks the transport for each request:

1. With `ai.provider` `agent`, when the host registers `AGENT_MODELS_SERVICE` and it holds a key for the Oxbit agent endpoint, the request goes through it. Only iOS registers that service; the key stays in the Keychain. With another provider, iOS sends through that service to the provider's endpoint, after checking for a saved key unless the provider is `local`.
2. Otherwise, with a runtime connection, it calls the runtime's `ai.complete` method. `apps/runtime/src/ai.ts` loads `~/.oxbit/agent/settings.json` (or `OXBIT_AGENT_HOME`) and `auth.json`, and selects the provider the way `oxbit-agent` does. A request with `provider` (`openrouter`, `openai-compatible` or `ollama`) and `baseUrl` lays them over the agent's settings first, so that provider's saved key, environment key (`OPENROUTER_API_KEY`) and method apply. It returns the reply's text. The key does not leave the runtime.
3. With neither, the request fails with "AI editor features need a runtime connection or an API key in Agent setup".

On a runtime, `local` reaches `http://` on loopback hosts only, the rule `normalizeBase` applies to `oxbit-agent`. On iOS, `AgentModelEndpoint.swift` also accepts `http://` on private network hosts, which the app's App Transport Security settings allow, and sends no key there when none is saved.

Requests use Chat Completions with a system prompt. Use chat or instruct models; fill-in-the-middle-only models return unusable text.

`ai.complete`, `ai.key` and `ai.models` require an owner session and a trusted workspace, the same rule as `acp.*`. It passes the request's abort signal to the model request, so a cancelled client request stops it. The runtime imports `@oxbit/agent/auth`, `@oxbit/agent/config` and `@oxbit/agent/providers`, which `vite.config.ts` and `vite.desktop.config.ts` bundle.

## Prompts

`src/prompt.ts` sends up to 6,000 characters before the cursor and 2,000 after, with a `<|cursor|>` marker, to a chat model. `cleanCompletion` removes a Markdown fence, an echoed cursor marker, a repeated current line, and characters that already follow the cursor, and keeps at most 24 lines. Inline completions request at most 256 output tokens; inline edits request at most 8,192.

## Implementation notes

- The ghost text `StateField`, `ViewPlugin` and keymap are module-level values. The editor rebuilds `editorDecoration` extensions on every context change, and reusing the same values keeps the current suggestion and in-flight request.
- The keymap uses `Prec.highest`, and each command returns `false` when there is nothing to accept, so Tab still indents and Escape still reaches other handlers.
- Documents use a Yjs `UndoManager`, which merges changes made within its capture window. The inline edit calls `stopCapturing()` before and after its change so Undo reverts only the AI edit.

## Tests

- `packages/features/ai/src/*.test.ts`: prompt cleanup, ghost state, inline edit application, transport and provider selection, and model suggestions.
- `apps/runtime/tests/ai.test.ts`: provider, key and model selection for `ai.complete`, named providers, `ai.key` and `ai.models`, with a fake `fetch`.
- `tests/browser/settings-pages.spec.ts`: provider labels, suggestion details, and choosing a suggested model.
- `tests/browser/ai-editor.spec.ts`: ghost text accept and dismiss, and the inline edit with undo, against a fake `agentModels` service.

## References

- CodeMirror reference manual, `Prec`, `StateField`, `ViewPlugin`, `WidgetType` and `keymap`: https://codemirror.net/docs/ref/
- Yjs `UndoManager` and `stopCapturing`: https://docs.yjs.dev/api/undo-manager
- Model APIs used by the adapters: [agent-model-apis.md](agent-model-apis.md)
- Recommended inline completion models and their sources: [ai-inline-models.md](ai-inline-models.md)
- Ollama OpenAI compatibility: https://docs.ollama.com/api/openai-compatibility
- llama.cpp `llama-server` OpenAI-compatible endpoints: https://github.com/ggml-org/llama.cpp/tree/master/tools/server
- OpenRouter models API: https://openrouter.ai/docs/api-reference/models/get-models
