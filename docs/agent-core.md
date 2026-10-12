# Oxbit agent core

Created: 2026-10-11. Last updated: 2026-10-11.

`@oxbit/agent-core` (`packages/agent-core`) holds the Oxbit agent loop, the model adapters, the tools, and the extension seams. It imports only `@oxbit/sdk` types and runs in the app, the runtime, and the `oxbit-agent` CLI. It has no `node:*` imports, no DOM use, and no console output.

## Host

`Agent` takes an `AgentHost` (`src/host.ts`):

| Member | Use |
| --- | --- |
| `models()`, `endpoint()` | Model transport and the provider's `api`/`baseUrl`. |
| `catalog?()`, `model?()`, `saveModel?()` | Model list (else `GET /v1/models`), the saved model for new sessions, and where `session/set_model` saves it. |
| `capabilities` | `fs: true` adds the write review line to the system prompt; `terminal: true` adds the `bash` tool. |
| `filesystem`, `filesystemFor?(cwd)`, `root` | Listing and search. A `session/new` `cwd` other than `root` needs `filesystemFor`. |
| `update`, `request` | ACP `session/update` notifications and client requests (`fs/*`, `terminal/*`, `session/request_permission`, `oxbit/diagnostics`). |
| `generateTitles` | `false` turns off model-written session titles. The in-app host sets it. |
| `extensions` | Tool, context, command, hook, continuation, compaction, snapshot, and session store seams (`src/extensions.ts`). |

`LocalAgentRuntime` (`packages/features/agent-acp/src/local/runtime.ts`) is the in-app host: `capabilities {fs: true, terminal: false}`, endpoint and model from `agentACP.oxbit.*`.

## ACP surface

`Agent.handle(method, params)` serves `initialize`, `session/new`, `session/load`, `session/list`, `session/fork`, `session/prompt`, `session/set_model`, `session/set_mode`, `session/set_config_option`, and `session/cancel`.

- `session/new` keeps `cwd` and stores `mcpServers` in session meta.
- `session/load` and `session/list` exist when `extensions.sessions` is set; `initialize` then reports `loadSession: true` and `sessionCapabilities.list`. Load replays the turns as `user_message_chunk`, `agent_message_chunk`, `tool_call`, and `tool_call_update` before it responds.
- Modes `ask`, `accept-edits`, `full-auto` appear as `modes` and as a `mode` config option. `ask` keeps the write review and asks before `execute` tools through `session/request_permission`; `accept-edits` adds `_meta: { oxbit: { mode } }` to `fs/write_text_file` so the client applies the write; `full-auto` asks only when a PreToolUse hook returns `ask`. A change sends `current_mode_update`. The mode lives in `meta.mode`.
- After the first finished turn the agent asks the session model for a 3 to 7 word title (no tools, `maxTokens: 30`; the OpenAI adapters do not send a token cap), stores it in `meta.title`, and sends `session_info_update`. Failures leave no title.
- A prompt whose first text block starts with `/name` of a provided command runs that command. Commands are advertised with `available_commands_update` after session creation and after each turn when the list changes.
- `bash` sends `terminal/create` with `command: "bash"`, `args: ["-c", command]`, an absolute `cwd`, and `outputByteLimit: 100000`, embeds `{type: "terminal", terminalId}` in the tool call, then calls `terminal/wait_for_exit`, `terminal/output`, and `terminal/release`; it sends `terminal/kill` on cancel or after `timeout_ms` (default 120000, at most 600000).

## Hooks

Hook input uses Claude Code field names: `session_id`, `cwd`, `hook_event_name`, plus `tool_name`, `tool_input`, `tool_use_id`, `tool_response` or `error`, `prompt`, `stop_hook_active`, `last_assistant_message`, `trigger`, `source`, and `reason` by event.

## References

- ACP terminals: https://agentclientprotocol.com/protocol/terminals
- ACP session modes: https://agentclientprotocol.com/protocol/session-modes
- ACP session config options: https://agentclientprotocol.com/protocol/session-config-options
