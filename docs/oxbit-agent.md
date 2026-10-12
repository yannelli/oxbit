# Oxbit Agent CLI

Created: 2026-10-11. Last updated: 2026-10-12.

`oxbit-agent` (`apps/agent`, npm `@oxbit/agent`) is a terminal coding agent built
on [`@oxbit/agent-core`](agent-core.md). It runs as a terminal UI, as a one-shot
print command, and as an ACP agent on stdin/stdout. The Oxbit runtime starts the
copy bundled with the desktop app and `@oxbit/cli` for the **Oxbit Agent CLI**
entry in the agent picker.

## Modes

| Command | What it does |
| --- | --- |
| `oxbit-agent [prompt]` | Terminal UI (Ink 8, React 19.3) when stdout is a TTY |
| `oxbit-agent -p <prompt>` | Prints the reply to stdout, tool lines to stderr; exit 0, 1, or 130 when cancelled. `-p -` reads the prompt from stdin |
| `oxbit-agent acp` | ACP agent over NDJSON JSON-RPC; stdout carries only protocol lines, logs go to stderr |
| `oxbit-agent models` | Lists the provider's models with context windows |
| `oxbit-agent login [chatgpt]` | Lists sign-in methods, or signs in with ChatGPT |
| `oxbit-agent login --provider <id>` | Saves an API key read from stdin |
| `oxbit-agent logout [provider\|chatgpt]` | Removes saved keys, or signs out of ChatGPT; no argument does both |

Options: `-m/--model`, `--provider`, `--mode ask|accept-edits|full-auto`,
`-c/--continue` (latest session in this directory), `-r/--resume <id>`.

Print mode starts in `ask` and denies permission prompts; pass
`--mode accept-edits` or `--mode full-auto` for unattended edits or commands.

## Terminal UI

| Key | Action |
| --- | --- |
| Enter | Send; while the agent works, queue the message |
| Shift+Enter, Alt+Enter, Ctrl+J | New line (Shift+Enter needs the kitty keyboard protocol) |
| Esc | Close completion, else stop the turn |
| Ctrl+C | Stop the turn, close a menu, or clear the input; twice within 2 s exits |
| Shift+Tab | Cycle ask, accept-edits, full-auto |
| Ctrl+P | Model and reasoning picker |
| Ctrl+O | Details viewer for thinking, tool output and diffs |
| `/` and `@` | Complete commands and files |

Local commands: `/model`, `/new`, `/resume`, `/help`, `/exit`, and the settings
panels below. `/context` draws the context window as a colored grid. The status line shows
the mode, goal and loop state, title, model, provider and context use. On exit the
TUI prints the `oxbit-agent -r <id>` command that resumes the session.

## Files

Everything lives in `~/.oxbit/agent` (`OXBIT_AGENT_HOME` overrides it):

| Path | Contents |
| --- | --- |
| `settings.json` | Provider, model, mode, hooks and the keys below |
| `auth.json` | API keys and ChatGPT tokens, mode 0600 |
| `mcp.json` | MCP servers in the Claude `.mcp.json` format |
| `AGENTS.md` | Global instructions |
| `skills/` | User skills |
| `sessions/<cwd-hash>/<id>.jsonl` | Saved sessions |
| `history.jsonl` | TUI prompt history |
| `snapshots/<cwd-hash>/` | Git object store for `/undo` and `/redo` |
| `cache/` | models.dev context windows, one day |

`settings.json` keys read by the agent:

| Key | Default | Effect |
| --- | --- | --- |
| `provider`, `model`, `mode` | detected, saved model, `ask` | Startup choices |
| `providers.<id>.baseUrl`, `.model`, `.method` | | Per-provider base URL, model, and sign-in method (`api-key`, `chatgpt`, `none`) |
| `appendSystemPrompt` | | Text added after the instruction files |
| `claudeInstructions` | `false` | Also load `~/.claude/CLAUDE.md` |
| `claudeHooks`, `codexHooks` | `false` | Also run hooks from Claude Code and Codex files |
| `autoCompact` | `true` | `false` leaves compaction to `/compact` |
| `autoCompactAt` | | Compact at this percent of the context window (50 to 95) |
| `disabledSkills` | `[]` | Skill names left out of prompts, the skill tool and slash commands |
| `disabledInstructions` | `[]` | Instruction file paths that are not loaded |
| `disabledHooks` | `[]` | Hook ids (`<dialect>\|<file>\|<event>\|<matcher>\|<command>`) that do not run |
| `disabledMcpServers` | `[]` | MCP server names left out of every session |
| `disabledProviders` | `[]` | Provider ids that automatic selection skips |
| `trustedProjects`, `trustProjectMcp` | `[]`, `false` | Which project `.mcp.json` files may start servers |
| `hooks` | | Claude Code hook format, below |

## Settings commands

`/config`, `/skills`, `/hooks`, `/mcp`, `/instructions` and `/providers` change
`settings.json`, `mcp.json` and `auth.json`. Changes apply on the next turn. In the
terminal UI, switching the provider rebuilds the agent and keeps the open session.

In the terminal UI the bare command opens a panel: arrows move, space turns a
row on or off, left and right change a choice, Enter runs a row's action (set an
API key, sign in with ChatGPT, add an MCP server, create or import a skill, edit
the global prompt). A command with arguments goes to the agent as below.

Over ACP (`oxbit-agent acp`, the Oxbit panel, Zed) the same commands are agent
slash commands. The bare command lists numbered rows; arguments change them:

| Command | Effect |
| --- | --- |
| `/config <setting> <value>` | `auto-compact off`, `compact-at 80`, `mode full-auto`, `claude-hooks on`, `codex-hooks on`, `claude-instructions on` |
| `/skills enable\|disable <name\|number>` | Turn a skill on or off |
| `/skills new <name> <description>`, `/skills import <folder>` | Create `skills/<name>/SKILL.md`, or copy a folder with a `SKILL.md` |
| `/hooks enable\|disable <number>` | Turn one hook on or off |
| `/instructions enable\|disable <number\|path>`, `/instructions prompt [text]` | Instruction files; set or clear `appendSystemPrompt` |
| `/mcp add <name> <url or command line>`, `/mcp remove <name>` | Edit `mcp.json` |
| `/mcp enable\|disable <name>`, `/mcp reload` | Turn a server on or off; reconnect |
| `/providers use\|enable\|disable <id>` | Default provider (applies on the next start over ACP); automatic selection |
| `/providers login chatgpt`, `/providers signout` | ChatGPT sign-in |

API keys are not accepted in chat; use `oxbit-agent login --provider <id>` or the
terminal UI panel. ACP sessions also expose `auto-compact` and `compact-at` as
session config options.

## Providers

| Provider | Credentials | Notes |
| --- | --- | --- |
| `openai` | `OPENAI_API_KEY`, a saved key, or a ChatGPT plan | Responses API with `store: false` |
| `anthropic` | `ANTHROPIC_API_KEY` or a saved key | Claude Max and Team monthly API credits are spent through a Claude Console API key |
| `openrouter` | `OPENROUTER_API_KEY` or a saved key | Chat Completions |
| `ollama` | none | `http://127.0.0.1:11434`, or `OLLAMA_HOST` |
| `openai-compatible` | optional key per origin | `providers["openai-compatible"].baseUrl` or `OXBIT_AGENT_BASE_URL` |

Selection order: `--provider`, then `settings.json`, then the first provider with
a key in `auth.json` or the environment, then Ollama. A saved key wins over the
environment variable. Without `providers.<id>.method`, an active ChatGPT sign-in
wins over an API key. Base URLs must be https, or http on a loopback host.

Model context windows come from the provider's model list, then a built-in
table for current OpenAI and Anthropic models, then
[models.dev](https://models.dev/api.json).

### Sign in with ChatGPT

`oxbit-agent login chatgpt` runs OpenAI's
[Sign in with ChatGPT for open-source apps](https://developers.openai.com/siwc/token-sharing-open-source)
flow: the first sign-in registers through `dynamic_agent_client` with
`agent_name_hint` "Oxbit Agent" and stores the issued `oaiapp_` client, PKCE
S256 with state and nonce, a loopback redirect on `127.0.0.1:1455` (another free
port when 1455 is taken), and an RS256 ID token checked against OpenAI's JWKS.
The sign-in URL is also printed to stderr; when no browser opens (SSH, Linux
without a display), paste the callback URL into the terminal. Refresh tokens
rotate; `logout chatgpt` revokes the refresh token. Requests go
to `api.openai.com/v1/responses` with `store: false`. The UI shows "Continue with
ChatGPT", "Using ChatGPT plan", and links "Manage usage" to
https://chatgpt.com/settings/usage. The Codex CLI client ID is not used.

### Claude subscriptions

The agent does not sign in with Claude.ai accounts. Anthropic's
[legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance)
limits Claude.ai subscription OAuth to Claude Code and Anthropic apps. Claude
subscribers can use Claude Code through the **Claude Agent** entry in the agent
picker, or a Console API key here.

## Instructions

The system prompt adds, in order: `~/.oxbit/agent/AGENTS.md`;
`~/.claude/CLAUDE.md` when `claudeInstructions` is on; for each directory from
the git root (or cwd) down to cwd, the first non-empty of `AGENTS.override.md`,
`AGENTS.md`, `CLAUDE.md`; then `appendSystemPrompt`. Each file is wrapped in
`<instructions path="...">`, capped at 32 KiB, with 64 KiB in total. The
per-directory walk and cap follow Codex's
[AGENTS.md rules](https://learn.chatgpt.com/docs/agent-configuration/agents-md.md);
the `CLAUDE.md` fallback follows pi and
[Claude Code memory](https://code.claude.com/docs/en/memory.md).

## Skills

Skills follow the [Agent Skills specification](https://agentskills.io/specification.md):
`<name>/SKILL.md` folders in `~/.oxbit/agent/skills`, `~/.agents/skills`,
`~/.claude/skills`, then `.agents/skills` and `.claude/skills` from cwd up to the
git root. The first skill with a name wins; `/skills` lists the rest as warnings.

- Frontmatter: `name` (defaults to the folder name), `description` (required),
  `disable-model-invocation`, `user-invocable`, `argument-hint`; `allowed-tools`
  is read but not enforced.
- The model sees an `<available_skills>` catalog and loads a skill with the
  `skill` tool, which also returns bundled files.
- `/<name> args` runs a skill as a prompt, replacing `$ARGUMENTS` or appending
  `ARGUMENTS: args`.

## Hooks

Command hooks use the [Claude Code hooks format](https://code.claude.com/docs/en/hooks.md)
under `hooks` in `~/.oxbit/agent/settings.json` and `<project>/.oxbit/settings.json`.
`claudeHooks` adds `~/.claude/settings.json`, `.claude/settings.json` and
`.claude/settings.local.json`; `codexHooks` adds
[Codex hooks](https://learn.chatgpt.com/docs/hooks.md) from `~/.codex/hooks.json`
and `.codex/hooks.json`.

- Events: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse,
  PostToolUseFailure, Stop, PreCompact, PostCompact, SessionEnd.
- Matchers: `*` or empty matches all; names made of letters, digits, `_`, `-`,
  spaces, commas and `|` are an exact list; anything else is a regex. Tool events
  match the Oxbit tool name or its Claude name:

  | Oxbit tool | Claude names |
  | --- | --- |
  | `read_file` | Read |
  | `write_file` | Write |
  | `edit_file` | Edit |
  | `bash` | Bash |
  | `search` | Grep |
  | `list_files` | LS, Glob |
  | `update_plan` | TodoWrite |

- Stdin JSON carries `session_id`, `transcript_path`, `cwd`, `hook_event_name`,
  `permission_mode` (`default`, `acceptEdits`, `bypassPermissions`),
  `oxbit_tool_name` and the event fields. `CLAUDE_PROJECT_DIR` and
  `OXBIT_PROJECT_DIR` hold the session cwd.
- Exit 2 blocks PreToolUse, UserPromptSubmit, Stop and PreCompact with stderr as
  the reason. Exit 0 with a JSON object maps `continue`, `stopReason`,
  `systemMessage`, `decision`, and `hookSpecificOutput` fields
  (`permissionDecision`, `updatedInput`, `additionalContext`). Other codes and
  timeouts (600 s default) are warnings.
- Matching hooks run in parallel: deny beats ask beats allow, any block denies.
  `disableAllHooks: true` turns hooks off.

## Goal and loop

- `/goal <objective>` stores a goal and starts working on it. While it is
  active, the agent continues after each stop with the
  [Codex goal continuation](https://github.com/openai/codex/blob/a9b0815167c27ab13719dd12d13b63e02b70d221/codex-rs/ext/goal/templates/goals/continuation.md)
  prompt and its completion audit, up to 50 times per prompt, until the model
  calls `update_goal` with `complete`, `blocked` or `paused`. `/goal`,
  `/goal pause`, `/goal resume` and `/goal clear` manage it.
- `/loop [30s|5m|1h] <prompt>` repeats a prompt in the same turn up to 100
  times. Without an interval the model schedules the next run with
  `schedule_next` (1 s to 1 h) and the loop ends when it does not. `/loop stop`
  or cancelling the turn ends it.
- Each continuation gets a fresh budget of 64 model steps.

## Compaction

Auto compaction runs when input plus output tokens reach the context window
minus `min(20000, max output or 32000, window / 4)`. It first clears tool outputs
older than the newest 40k tokens outside the last two user turns (OpenCode's
values), then summarizes older turns (goal, decisions, files touched, open work,
user preferences) and keeps the newest turns that fit in 20k tokens without
splitting a tool call from its result. `/compact [focus]` runs it on demand.
`autoCompactAt` replaces the reserve rule with a percent of the window.

`/context` estimates tokens (4 characters per token) for the system prompt,
instructions, skills, other context, built-in tools, MCP tools and messages, and
shows free space, the auto-compact threshold and buffer, and the provider's count
for the last request. ACP clients get a text grid; the chunk carries the numbers in
`_meta.oxbit.context`.

## MCP servers

The agent is an MCP client for stdio, Streamable HTTP and legacy HTTP+SSE
servers ([MCP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28),
with a fallback to `initialize` for 2025-11-25 servers). Servers come from
`~/.oxbit/agent/mcp.json`, a trusted project's `.mcp.json`, and ACP
`session/new` `mcpServers`. Tools appear as `mcp__<server>__<tool>`. `/mcp` shows
server status and `/mcp reload` reconnects. Servers that answer 401 are reported;
MCP OAuth is not supported.

## Snapshots and sessions

Before the first file change of each step, the agent records a git tree of the
session cwd in a separate `GIT_DIR` (the project's own repository is untouched,
`.gitignore` applies). `/undo` restores the files from before the last prompt
that changed them and drops that prompt; `/redo` brings both back. Without git,
snapshots are off. Sessions save as JSONL after each prompt; `-c` and `-r` resume
them, and ACP clients use `session/list`, `session/load` and `session/fork`.

## Permission modes

| Mode | Writes | Shell commands |
| --- | --- | --- |
| `ask` | Ask, with a diff | Ask |
| `accept-edits` | Apply | Ask |
| `full-auto` | Apply | Run |

PreToolUse hooks can allow, ask or deny in every mode. In ACP mode the client
decides how to show writes; Oxbit marks writes in `accept-edits` and `full-auto`
with `_meta.oxbit.mode`.

## Packaging

- npm: `node scripts/npm/publish.mjs agent` stages `apps/agent/dist` with `ink`
  and `react` pinned; see [npm packages](npm.md).
- Desktop: `scripts/desktop/prepare.mjs` copies the bundle to
  `resources/runtime/agent/`; `@oxbit/cli` carries it in `agent/dist/`. The
  runtime starts it with its own Node when the Oxbit Agent CLI command is the
  default `oxbit-agent`.
- The ACP path loads no TUI packages, so the bundled copies need only Node.

## Development

```sh
bun run --cwd apps/agent build
node apps/agent/dist/index.js -p "Reply with OK" --provider ollama --model qwen3:0.6b
bunx vitest run apps/agent packages/agent-core
```

## Sources

Accessed 2026-10-11:

- [Agent Client Protocol](https://agentclientprotocol.com/protocol/overview): terminals, file system, tool calls, session modes
- [Model Context Protocol 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28)
- [Sign in with ChatGPT, open-source apps](https://developers.openai.com/siwc/token-sharing-open-source)
- [OpenAI models](https://developers.openai.com/api/docs/models), [Anthropic models](https://platform.claude.com/docs/en/about-claude/models/overview)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks.md), [skills](https://code.claude.com/docs/en/skills.md), [memory](https://code.claude.com/docs/en/memory.md), [legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- [Codex hooks](https://learn.chatgpt.com/docs/hooks.md), [AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md.md)
- [Agent Skills specification](https://agentskills.io/specification.md)
- [Ink 8](https://github.com/vadimdemedes/ink)
