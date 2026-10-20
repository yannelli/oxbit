# AI editing

Created: 2026-10-18. Last updated: 2026-10-20.

The `oxbit.ai` feature (`packages/features/ai`) adds ghost text completions and inline edits to the CodeMirror editor. Both send code from the open file to the provider `ai.provider` names: the Oxbit agent's provider, OpenRouter, a custom OpenAI-compatible API, or a local Ollama or llama.cpp server.

## Features

| Feature | Use | Keys |
| --- | --- | --- |
| Inline completions | Off by default. Turn on `ai.inlineCompletions.enabled`, or run **AI: Toggle Inline Completions**. After `ai.inlineCompletions.delay` ms without typing, the model's suggestion appears as dim text at the cursor. Typing the suggested characters keeps the rest. Deleting or moving the cursor dismisses the suggestion and cancels a running request without starting a new one. | Tab accepts, Escape dismisses, Ctrl/Cmd+Right accepts one word. **AI: Suggest Inline Completion** requests one on demand. |
| Edit Selection with AI | Asks for an instruction, replaces the selection with the model's rewrite, and highlights the new text. With no selection it inserts code at the cursor. The edit is one undo step. If the selected text changes while the request runs, nothing is applied. | Ctrl/Cmd+Alt+K. Escape cancels a running request. |

Ctrl/Cmd+K is a chord prefix in Oxbit, so the inline edit uses Ctrl/Cmd+Alt+K.

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| `ai.inlineCompletions.enabled` | `false` | Request suggestions while typing. |
| `ai.inlineCompletions.delay` | `350` | Milliseconds of idle time before a request. |
| `ai.inlineCompletions.maxTokens` | `256` | Output token cap per suggestion (16 to 4,096). |
| `ai.inlineCompletions.maxLines` | `2` | Lines in a suggestion. The system prompt asks for at most this many and `cleanCompletion` cuts longer replies. `1` asks for the rest of the current line only. |
| `ai.inlineCompletions.linesBefore` | `150` | Lines before the cursor sent as context. `0` sends the start of the cursor's line. |
| `ai.inlineCompletions.linesAfter` | `50` | Lines after the cursor sent as context. `0` sends the rest of the cursor's line. |
| `ai.inlineCompletions.contextTokens` | `2048` | Context budget per request, estimated at 4 characters per token. Lines farthest from the cursor go first; the code after the cursor keeps at least a quarter of the budget. Open files take up to a quarter when included. |
| `ai.inlineCompletions.includePath` | `true` | Send the file path and language. |
| `ai.inlineCompletions.includeDiagnostics` | `false` | Send up to 20 errors and warnings on the context lines, from `diagnostics.change` events. |
| `ai.inlineCompletions.includeOpenFiles` | `false` | Send the start of up to 3 other open documents, most recently opened first. |
| `ai.inlineCompletions.disabledGlobs` | Zed's `edit_predictions.disabled_globs` without its Zed settings paths | Files matching a glob request no suggestions and are left out of open-file context. Matching uses `lspGlobMatches`. |
| `ai.inlineCompletions.instructions` | `""` | Text appended to the completion system prompt. |
| `ai.provider` | `agent` | `agent` (Agent harness): the Oxbit agent's provider and key. `openrouter`: `https://openrouter.ai/api`. `openai-compatible` (Custom OpenAI API): Chat Completions at `ai.baseUrl`. `local`: Ollama or a llama.cpp server at `ai.baseUrl`, without a key. |
| `ai.baseUrl` | `""` | Base URL for `openai-compatible` and `local`. Empty `local` uses `http://localhost:11434`. llama.cpp's `llama-server` listens on `http://127.0.0.1:8080`. On iPhone, use the computer's LAN address. |
| `ai.model` | `""` | Model ID for AI editing. With `agent`, empty uses the Oxbit agent's model. Other providers need one. |
| `ai.effort` | `""` | Reasoning level sent with each request, for example `minimal` or `low`. |

Each `ai.inlineCompletions.*` setting is read for the file's language, so language overrides apply. The settings appear on the Editor page under **AI**. The provider select shows the labels from `Setting.enumLabels`. **Set API Key…** runs **AI: Set AI Provider API Key**, which saves the `openrouter` or `openai-compatible` key: on iOS in the Keychain through `AGENT_MODELS_SERVICE`, under the same account Agent setup uses for that endpoint; with a runtime, in the Oxbit agent's `auth.json` through the runtime's `ai.key` method, under the slot `oxbit-agent login --provider` writes.

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

For inline completions, `contextWindow` in `src/prompt.ts` takes the lines around the cursor within the line and token limits, and `completionPrompt` sends the path header, open files, and problems that are turned on, then the code with a `<|cursor|>` marker, to a chat model. `cleanCompletion` removes a Markdown fence and an echoed cursor marker, then:

- the longest end of the current line the reply starts with, when it holds at least 2 visible characters (`// ` before `// note`, `tot` before `total`);
- leading blank lines when the line before the cursor is blank or ends in whitespace, and for `maxLines` 1 any leading newline;
- leading reply lines that repeat the lines above a blank cursor line, and trailing reply lines that repeat the lines below the cursor (the last one can be cut short), when the repeated text has at least 6 visible characters, so a lone `}` stays;
- characters that already follow the cursor on its line.

It keeps at most `ai.inlineCompletions.maxLines` lines.

### Fill-in-the-middle for local models

Base code models such as `qwen2.5-coder:1.5b-base` have no chat template; a chat request returns prose and fences. With `ai.provider` `local`, ghost text first sends a fill-in-the-middle request: `POST /v1/completions` with the code before the cursor as `prompt` and the code after it as `suffix` (`fimComplete` in `@oxbit/agent-core`, used by the iOS service path and the runtime's `ai.complete` `fim` parameter). Ollama formats it with the model's FIM tokens when the model's template uses `.Suffix`, and answers 400 `does not support insert` for other models. On that answer, or 404, 405 or 501, Oxbit remembers the base URL and model for the session and uses the chat prompt. Inline edits and the other providers use the chat prompt. Checked against Ollama with `qwen2.5-coder:1.5b-base` (FIM) and `qwen3:0.6b` (rejected) on 2026-10-20. Inline edits send up to 6,000 characters before the selection and 2,000 after, and request at most 8,192 output tokens.

`withOutputLimit` in `@oxbit/agent-core` adds the output cap to editor requests: `max_tokens` for Chat Completions and `max_output_tokens` for OpenAI Responses. The Anthropic adapter sets `max_tokens` itself, and the ChatGPT backend rejects `max_output_tokens`. Agent turns do not use it.

## Implementation notes

- The ghost text `StateField`, `ViewPlugin` and keymap are module-level values. The editor rebuilds `editorDecoration` extensions on every context change, and reusing the same values keeps the current suggestion and in-flight request.
- The keymap uses `Prec.highest`, and each command returns `false` when there is nothing to accept, so Tab still indents and Escape still reaches other handlers.
- Documents use a Yjs `UndoManager`, which merges changes made within its capture window. The inline edit calls `stopCapturing()` before and after its change so Undo reverts only the AI edit.

## Tests

- `packages/features/ai/src/*.test.ts`: prompt cleanup, ghost state, inline edit application, transport and provider selection, and model suggestions.
- `packages/agent-core/src/fim.test.ts`: the FIM request body and the fallback after a rejection.
- `apps/runtime/tests/ai.test.ts`: provider, key and model selection for `ai.complete`, the local FIM request and its chat fallback, named providers, `ai.key` and `ai.models`, with a fake `fetch`.
- `tests/browser/settings-pages.spec.ts`: provider labels, suggestion details, and choosing a suggested model.
- `tests/browser/ai-editor.spec.ts`: ghost text accept and dismiss, the inline completion limits, instructions and excluded files, and the inline edit with undo, against a fake `agentModels` service.

## References

- CodeMirror reference manual, `Prec`, `StateField`, `ViewPlugin`, `WidgetType` and `keymap`: https://codemirror.net/docs/ref/
- Yjs `UndoManager` and `stopCapturing`: https://docs.yjs.dev/api/undo-manager
- Model APIs used by the adapters: [agent-model-apis.md](agent-model-apis.md)
- Recommended inline completion models and their sources: [ai-inline-models.md](ai-inline-models.md)
- Ollama OpenAI compatibility, including `suffix` on `/v1/completions`: https://docs.ollama.com/api/openai-compatibility
- Qwen2.5-Coder fill-in-the-middle format (`<|fim_prefix|>`, `<|fim_suffix|>`, `<|fim_middle|>`): https://github.com/QwenLM/Qwen2.5-Coder
- llama.cpp `llama-server` OpenAI-compatible endpoints: https://github.com/ggml-org/llama.cpp/tree/master/tools/server
- OpenRouter models API: https://openrouter.ai/docs/api-reference/models/get-models
- Inline completion options in other editors, checked 2026-10-19: Continue `autocompleteOptions` (`maxPromptTokens`, `prefixPercentage`, `maxSuffixPercentage`, `debounceDelay`, `useRecentlyOpened`, `template`), https://docs.continue.dev/reference; Zed `edit_predictions` (`disabled_globs`, per-language `show_edit_predictions`, `max_output_tokens`), https://zed.dev/docs/ai/edit-prediction and https://github.com/zed-industries/zed/blob/main/assets/settings/default.json
