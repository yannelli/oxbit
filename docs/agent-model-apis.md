# Model APIs for the built-in Oxbit agent

Created: 2026-10-10. Last updated: 2026-10-12.

The Oxbit agent loop and model adapters live in `packages/agent-core/src/` (`@oxbit/agent-core`). `packages/features/agent-acp/src/local/runtime.ts` runs it in the app and sends model requests through the host's `AgentModels` service (`packages/sdk/src/agent-models.ts`). The host adds the saved key, pins the request to the API origin, and adds provider headers such as `anthropic-version`. JavaScript does not see the key. Each adapter builds the request body and turns the streamed body into text, reasoning, tool call, usage, and stop events.

| `agentACP.oxbit.api` | Adapter | Request |
| --- | --- | --- |
| `openai` | `agent-core/src/openai-responses.ts` | `POST /v1/responses`, `stream: true` |
| `openai-compatible` | `agent-core/src/chat-completions.ts` | `POST {baseUrl}/v1/chat/completions`, `stream: true` |
| `anthropic` | `agent-core/src/anthropic-messages.ts` | `POST /v1/messages`, `stream: true` |
| `chatgpt` | `agent-core/src/chatgpt.ts` | `POST /codex/responses` under `https://chatgpt.com/backend-api`, `stream: true` |

`openai`, `openai-compatible` and `anthropic` use `GET /v1/models` for the model list; `chatgpt` uses `GET /codex/models`. Use this page when changing an adapter, the SSE parser (`agent-core/src/sse.ts`), or the ACP updates the agent sends.

## Server-sent events

`agent-core/src/sse.ts` joins lines split across chunks, accepts LF, CRLF and CR line endings, skips comment lines that start with `:` (OpenRouter sends `: OPENROUTER PROCESSING`), joins multi-line `data:` fields with a newline, and stops at `data: [DONE]`.

- Responses and Messages streams send an `event: <type>` line and a `data:` JSON object with the same `type`. Neither sends `[DONE]`; Messages removed it in version `2023-06-01`.
- Chat Completions sends `data:` lines only and ends with `data: [DONE]`.

## OpenAI Responses (`openai`)

Request fields the adapter sends:

- `model`, `instructions` (the system prompt), `input`, `stream: true`.
- `tools: [{type: "function", name, description, parameters, strict: false}]`. The tool schemas have optional properties, so strict mode is off.
- `reasoning: {effort, summary: "auto"}` only when the Reasoning option is set. Supported `effort` values depend on the model; see [Reasoning levels](#reasoning-levels).
- `store` is omitted. The reference says it defaults to `true`.

Input items: user text is `{type: "message", role: "user", content: [{type: "input_text", text}]}`. Tool results are `{type: "function_call_output", call_id, output}`. The adapter replays each earlier response's output items (`reasoning`, `message` with its `phase`, `function_call`) unchanged, as the reasoning guide requires for items between the last user message and a function call output. Items come from `response.output_item.done`.

Stream events the adapter reads:

- `response.output_text.delta` (`delta`): message text.
- `response.reasoning_summary_text.delta` and `response.reasoning_text.delta` (`delta`): reasoning. `response.reasoning_summary_part.added` with `summary_index > 0` starts a new paragraph.
- `response.output_item.done` (`output_index`, `item`): a `function_call` item has `call_id`, `name` and the full `arguments` JSON.
- `response.completed` and `response.incomplete`: `response.usage.{input_tokens, output_tokens}`; `response.incomplete_details.reason` is `max_output_tokens` or `content_filter` among others.
- `response.failed` (`response.error.message`) and the top-level `error` event (`message`) fail the turn.

`GET /v1/models` returns `{object: "list", data: [{id, object, created, owned_by}]}` with no context window, so OpenAI sessions send no `usage_update`.

References: [Create a response](https://developers.openai.com/api/reference/resources/responses/methods/create), [Responses streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events), [Reasoning guide](https://developers.openai.com/api/docs/guides/reasoning), [List models](https://developers.openai.com/api/reference/resources/models/methods/list).

## ChatGPT plan (`chatgpt`)

Added 2026-10-12. The host signs in with a device code (`AgentModels.chatgpt`), keeps the tokens in the keychain and adds the auth headers. `keys.has` reports a sign-in and `keys.remove` signs out.

- Request: the OpenAI Responses body plus `include: ["reasoning.encrypted_content"]` and `tool_choice: "auto"`, with `store: false` (the backend rejects `true`) and without `max_output_tokens`. `instructions` is required. Events use the OpenAI Responses parser. Output items saved by the `openai` or `chatgpt` adapter replay; the `openai` adapter replays only its own.
- Models: `GET /codex/models?client_version=0.162.1` returns `{models: ModelInfo[]}` (openai/codex `codex-rs/protocol/src/openai_models.rs`). The list keeps `visibility: "list"`, sorts by `priority`, and maps `slug`, `display_name` and `context_window`. A failed request or an empty list uses `CHATGPT_MODELS`, taken from openai/codex `codex-rs/models-manager/models.json` on 2026-10-12.

## Chat Completions (`openai-compatible`)

Request fields: `model`, `messages`, `tools: [{type: "function", function: {name, description, parameters}}]`, `stream: true`, `stream_options: {include_usage: true}`, and `reasoning_effort` when the Reasoning option is set.

Messages: `system`, `user`, assistant `{role: "assistant", content, tool_calls: [{id, type: "function", function: {name, arguments}}]}`, and one `{role: "tool", tool_call_id, content}` per result.

Chunks are `{choices: [{index, delta: {content, tool_calls: [{index, id, type, function: {name, arguments}}]}, finish_reason}], usage}`. The adapter joins `tool_calls` fragments by `index` and emits the calls after the stream ends. `finish_reason` is `stop`, `length`, `tool_calls`, `content_filter` or the deprecated `function_call`. With `include_usage`, a last chunk before `[DONE]` carries `usage.{prompt_tokens, completion_tokens}`.

Provider differences the adapter handles:

- OpenRouter streams `delta.reasoning` (text) and `delta.reasoning_details` (fragments with `index`). The adapter joins fragments by index and sends `reasoning_details` back unchanged on the assistant message. A mid-stream error is a chunk with a top-level `error: {code, message}` and `finish_reason: "error"`. `GET /api/v1/models` returns `context_length` and `top_provider.max_completion_tokens`; the agent uses `context_length` for `usage_update`.
- DeepSeek streams `delta.reasoning_content`. With tools in the request, the reasoning must be sent back in later requests, so the adapter replays it as `reasoning_content`.

References: [Create chat completion](https://developers.openai.com/api/reference/resources/chat), [Chat Completions streaming events](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events), [OpenRouter streaming](https://openrouter.ai/docs/api_reference/streaming), [OpenRouter reasoning tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens), [OpenRouter models](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties), [DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode).

## Anthropic Messages (`anthropic`)

Required header `anthropic-version: 2023-06-01`, set by the host. Request fields: `model`, `system`, `messages`, `tools: [{name, description, input_schema}]`, `stream: true`, `max_tokens` (required), and `output_config: {effort}` when the Reasoning option is set. Effort needs no beta header. The adapter sends no `thinking` parameter because the accepted thinking types depend on the model.

`max_tokens` comes from the model list's `max_tokens`. When the list failed, the adapter sends `DEFAULT_MAX_TOKENS` (8192).

Messages: assistant turns replay the streamed content blocks unchanged (`thinking` with `signature`, `redacted_thinking`, `text`, `tool_use`). The docs require thinking blocks to be passed back complete and unmodified with tool results. Tool results are `{type: "tool_result", tool_use_id, content, is_error}` blocks in a user message, placed before any user text that follows.

Stream events:

- `message_start`: `message.usage.input_tokens` plus `cache_read_input_tokens` and `cache_creation_input_tokens`.
- `content_block_start` (`index`, `content_block`): `text`, `thinking`, `redacted_thinking` or `tool_use` (`id`, `name`).
- `content_block_delta` (`index`, `delta`): `text_delta.text`, `thinking_delta.thinking`, `signature_delta.signature`, `input_json_delta.partial_json`.
- `content_block_stop`: the adapter parses the joined `partial_json` and emits the tool call.
- `message_delta`: `delta.stop_reason` (`end_turn`, `max_tokens`, `stop_sequence`, `tool_use`, `pause_turn`, `refusal`, `model_context_window_exceeded`) and cumulative `usage.output_tokens`.
- `message_stop` ends the response; `ping` and unknown events are ignored; `error` (`error.message`) fails the turn.

`GET /v1/models` returns `data: [{id, display_name, max_input_tokens, max_tokens, ...}]`. The agent uses `display_name` as the label, `max_input_tokens` for `usage_update`, and `max_tokens` for requests.

References: [Create a message](https://platform.claude.com/docs/en/api/messages/create), [Streaming messages](https://platform.claude.com/docs/en/build-with-claude/streaming), [Extended thinking](https://platform.claude.com/docs/en/build-with-claude/thinking), [Effort](https://platform.claude.com/docs/en/build-with-claude/effort), [Versioning](https://platform.claude.com/docs/en/api/versioning), [List models](https://platform.claude.com/docs/en/api/models/list).

## Reasoning levels

Added 2026-10-12. `agent-core/src/efforts.ts` gives each model its levels, lowest first. The Reasoning option (`category: "thought_level"`) lists "Model default" and those levels. `session/set_model` and `session/set_config_option` with `configId: "model"` return `configOptions` with the new model's levels. A level the new model lacks resets to "Model default", which sends no effort field. A model with no levels gets no Reasoning option. Levels come from the model list entry first, then the API's table, then `low`, `medium`, `high` for an unknown model.

| API | Levels from the model list | Table for models the list does not describe | Request field |
| --- | --- | --- | --- |
| `chatgpt` | `supported_reasoning_levels[].effort` from `/codex/models`; an empty array means no levels | `CHATGPT_MODELS` (`low` to `max`; `gpt-5.5` stops at `xhigh`), then the `openai` table | `reasoning.effort` |
| `openai` | none: `/v1/models` has no levels. With a ChatGPT plan token the CLI's `planModels` reads `supported_reasoning_levels` when the list has it | `openai` table below | `reasoning.effort` |
| `anthropic` | `capabilities.effort.{low,medium,high,xhigh,max}.supported`; `effort.supported: false` means no levels | `anthropic` table below; other Claude models have no effort parameter | `output_config.effort` |
| `openai-compatible` | OpenRouter `reasoning.supported_efforts` (highest first; `null` allows every gateway level, `mandatory: true` drops `none`). A `supported_parameters` list without `reasoning` or `reasoning_effort` means no levels | `low`, `medium`, `high` | `reasoning_effort` |

The `chatgpt` list drops `ultra` and `persistent`. The Codex client resolves `ultra` to `multi_agent_reasoning_effort`, else `max`, and adds task delegation; it sends `persistent` as `disabled` (`codex-rs/protocol/src/openai_models/reasoning_effort.rs`, 2026-10-12). OpenRouter documents `reasoning_effort` as equivalent to `reasoning.effort`, so the adapter sends one field for every OpenAI-compatible server.

`openai` table, from the developers.openai.com model pages on 2026-10-12. An ID matches a row when it equals the prefix or starts with the prefix and `-`.

| Model ID prefix | `reasoning.effort` |
| --- | --- |
| `gpt-6-astra`, `gpt-6.1-sol` | `low`, `medium`, `high`, `xhigh`, `max` |
| `gpt-6-sol`, `gpt-6-luna` | `none`, `low`, `medium`, `high`, `xhigh`, `max` |
| `gpt-5.6` | `low`, `medium`, `high`, `xhigh`, `max` (openai/codex `models.json`; the API docs list no levels) |
| `gpt-5.5`, `gpt-5.4`, `gpt-5.2` | `none`, `low`, `medium`, `high`, `xhigh` |
| `gpt-5.1` | `none`, `low`, `medium`, `high` |
| `gpt-5` | `minimal`, `low`, `medium`, `high` |
| `gpt-4`, `gpt-4o`, `gpt-4.1`, `gpt-4.5`, `gpt-3.5`, `chatgpt-4o` | none (non-reasoning models) |
| other, including the o-series | `low`, `medium`, `high` (the o-series pages list no levels) |

`anthropic` table, from [Effort](https://platform.claude.com/docs/en/build-with-claude/effort) on 2026-10-12. On `claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5-5` and `claude-haiku-5-5` a request without `thinking` runs adaptive thinking, so `output_config.effort` is the only field the adapter sends. The default is `medium` on Opus 5.5 and Haiku 5.5 and `high` on the others.

| Model | `output_config.effort` |
| --- | --- |
| `claude-fable-5-1`, `claude-mythos-5-1`, `claude-fable-5`, `claude-mythos-5`, `claude-opus-5-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-sonnet-5-5`, `claude-sonnet-5`, `claude-haiku-5-5` | `low`, `medium`, `high`, `xhigh`, `max` |
| `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-mythos-preview` | `low`, `medium`, `high`, `max` |
| `claude-opus-4-5` | `low`, `medium`, `high` |
| other Claude models, such as `claude-haiku-4-5` and `claude-sonnet-4-5` | none |

References: [OpenAI reasoning effort](https://developers.openai.com/api/docs/guides/reasoning#reasoning-effort), [OpenAI models](https://developers.openai.com/api/docs/models), [Anthropic List models](https://platform.claude.com/docs/en/api/models/list), [OpenRouter models](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties), [OpenRouter chat completion](https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request), openai/codex `codex-rs/protocol/src/openai_models.rs` and `codex-rs/models-manager/models.json`.

## ACP surface

The agent answers `initialize` with `protocolVersion: 1` and `promptCapabilities.embeddedContext`. `session/new` returns `sessionId`, `configOptions` with a `model` option (`category: "model"`), a `reasoning` option (`category: "thought_level"`) when the model has reasoning levels, and the legacy `models` field. ACP v1 selects models through `configOptions`; `models` comes from the unstable schema. When the model list fails, the list holds only the saved `agentACP.oxbit.model`, so a model ID typed in Agent setup still works.

Session updates: `agent_message_chunk`, `agent_thought_chunk`, `tool_call` and `tool_call_update` (kinds `read`, `search`, `edit`, `think`; edits carry `{type: "diff", path, oldText, newText}` with `oldText: null` for a new file), `plan` (the full entry list each time), and `usage_update` (`used`, `size`) when the model list gives a context window. `session/prompt` ends with `end_turn`, `max_tokens`, `max_turn_requests`, `refusal` or `cancelled`.

References: [ACP schema](https://agentclientprotocol.com/protocol/v1/schema), [Prompt turn](https://agentclientprotocol.com/protocol/v1/prompt-turn), [Session config options](https://agentclientprotocol.com/protocol/v1/session-config-options), [Agent plan](https://agentclientprotocol.com/protocol/v1/agent-plan).

## Smoke test against a server

`bun scripts/oxbit-agent-smoke.ts <api> <model> [baseUrl]` runs one turn of the real
`LocalAgentRuntime`: the model has to call `read_file` on a fixture and answer with its
contents. The base URL defaults to a local [Ollama](https://docs.ollama.com/api/openai-compatibility),
which serves `/v1/models`, `/v1/chat/completions`, `/v1/responses` and an Anthropic-compatible
`/v1/messages` ([Anthropic compatibility](https://docs.ollama.com/api/anthropic-compatibility)). For a hosted API, pass its base URL and set `OXBIT_AGENT_KEY`.

On 2026-10-11 all three APIs passed against Ollama 0.24.0 with `qwen3:0.6b`: a tool call,
the tool result and a final answer. In one of four Anthropic runs the model put its whole
answer in thinking and the turn ended without text. The same day `openai-compatible` passed
against OpenRouter (`https://openrouter.ai/api`, `openai/gpt-oss-20b`). OpenAI's and
Anthropic's own endpoints have not been called.
