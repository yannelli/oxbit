# Model APIs for the built-in Oxbit agent

Created: 2026-10-10. Last updated: 2026-10-11.

The Oxbit agent in `packages/features/agent-acp/src/local/` runs in the app and sends model requests through the host's `AgentModels` service (`packages/sdk/src/agent-models.ts`). The host adds the saved key, pins the request to the API origin, and adds provider headers such as `anthropic-version`. JavaScript does not see the key. Each adapter builds the request body and turns the streamed body into text, reasoning, tool call, usage, and stop events.

| `agentACP.oxbit.api` | Adapter | Request |
| --- | --- | --- |
| `openai` | `local/openai-responses.ts` | `POST /v1/responses`, `stream: true` |
| `openai-compatible` | `local/chat-completions.ts` | `POST {baseUrl}/v1/chat/completions`, `stream: true` |
| `anthropic` | `local/anthropic-messages.ts` | `POST /v1/messages`, `stream: true` |

All three use `GET /v1/models` for the model list. Use this page when changing an adapter, the SSE parser (`local/sse.ts`), or the ACP updates the agent sends.

## Server-sent events

`local/sse.ts` joins lines split across chunks, accepts LF, CRLF and CR line endings, skips comment lines that start with `:` (OpenRouter sends `: OPENROUTER PROCESSING`), joins multi-line `data:` fields with a newline, and stops at `data: [DONE]`.

- Responses and Messages streams send an `event: <type>` line and a `data:` JSON object with the same `type`. Neither sends `[DONE]`; Messages removed it in version `2023-06-01`.
- Chat Completions sends `data:` lines only and ends with `data: [DONE]`.

## OpenAI Responses (`openai`)

Request fields the adapter sends:

- `model`, `instructions` (the system prompt), `input`, `stream: true`.
- `tools: [{type: "function", name, description, parameters, strict: false}]`. The tool schemas have optional properties, so strict mode is off.
- `reasoning: {effort, summary: "auto"}` only when the Reasoning option is set. Supported `effort` values depend on the model.
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

## ACP surface

The agent answers `initialize` with `protocolVersion: 1` and `promptCapabilities.embeddedContext`. `session/new` returns `sessionId`, `configOptions` with a `model` option (`category: "model"`) and a `reasoning` option (`category: "thought_level"`), and the legacy `models` field. ACP v1 selects models through `configOptions`; `models` comes from the unstable schema. When the model list fails, the list holds only the saved `agentACP.oxbit.model`, so a model ID typed in Agent setup still works.

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
