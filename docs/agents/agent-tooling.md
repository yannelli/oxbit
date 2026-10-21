# How Claude Code, Codex and Cursor load project agent config

Created: 2026-10-21. Last updated: 2026-10-21.

This page records how each tool finds project instructions, skills, agent definitions, hooks and MCP servers, and how to check each from a shell. Versions: Claude Code 2.1.296, Codex CLI 0.163.0, Cursor Agent CLI 2026.09.26-dd393fe (binary `agent`, also linked as `cursor-agent`) and the Cursor IDE. Docs were read on 2026-10-21; the Codex 0.163.0 notes list no loader change ([release][cx-release]).

Rows marked "probe" were also run on 2026-10-21 in a scratch git repo holding `AGENTS.md`, `CLAUDE.md` (`@AGENTS.md`), `sub/AGENTS.md`, `.agents/skills/probe-skill/SKILL.md`, `.claude/skills` as a symlink to `../.agents/skills`, `.claude/agents/probe-agent.md`, `.codex/config.toml`, `.mcp.json`, `.cursor/mcp.json` and `.cursor/rules/probe.mdc`, each with a unique marker string.

## 1. Project instructions

| Question | Claude Code | Codex | Cursor |
| --- | --- | --- | --- |
| Files read at start | `CLAUDE.md` or `.claude/CLAUDE.md`, plus `CLAUDE.local.md`, in the working directory and every parent ([memory][cc-memory]) | `AGENTS.override.md` or `AGENTS.md` in each directory from the git root down to the working directory, after `~/.codex/AGENTS.md` ([AGENTS.md][cx-agents]) | `.cursor/rules/*.mdc` and `AGENTS.md` ([rules][cu-rules]); the CLI also reads root `AGENTS.md` and `CLAUDE.md` ([CLI][cu-cli-using]) |
| Nested files | Subdirectory `CLAUDE.md` loads when Claude reads or edits a file there ([memory][cc-memory]) | Loaded at start for each directory on the path to the working directory; probe from `sub/` showed `sub/AGENTS.md` ([AGENTS.md][cx-agents]) | Nested `AGENTS.md` merges with parents in the IDE ([rules][cu-rules]); the CLI finds `.cursor/rules` in subdirectories ([CLI changelog][cu-cli-log]) |
| Reads `AGENTS.md` | Yes when no `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` sits in the working directory or above; `~/.claude/CLAUDE.md` does not count; needs v2.1.277 ([memory][cc-memory], [changelog][cc-log]); probe without `CLAUDE.md` saw the marker | Yes ([AGENTS.md][cx-agents]); probe saw the marker | Yes, root and subdirectories ([rules][cu-rules]) |
| Reads `CLAUDE.md` | Yes ([memory][cc-memory]) | Only if listed in `project_doc_fallback_filenames` and `AGENTS.md` is missing; default list is empty ([config reference][cx-ref], [sample][cx-sample]) | CLI: root `CLAUDE.md` ([CLI][cu-cli-using]); IDE: unconfirmed, see Unconfirmed |
| Import syntax | `@path`, four hops deep; an imported or symlinked `AGENTS.md` is not read twice; probe saw the imported marker ([memory][cc-memory]) | None documented ([AGENTS.md][cx-agents]) | None documented ([rules][cu-rules]) |
| Both files at once | `/config` "Project instructions" = `claude-md-and-agents-md` (user, managed or `--settings`) ([memory][cc-memory]) | No setting found; fallback names apply only when `AGENTS.md` is missing ([config reference][cx-ref]) | Reads both from the CLI ([CLI][cu-cli-using]) |
| Size limit | Target under 200 lines per file; warning at startup and in `/status` ([memory][cc-memory]) | `project_doc_max_bytes`, 32 KiB default ([AGENTS.md][cx-agents]) | "Keep rules under 500 lines" ([rules][cu-rules]) |
| Rule files with path scope | `.claude/rules/*.md` with `paths:` frontmatter ([memory][cc-memory]) | n/a ([AGENTS.md][cx-agents]) | `.mdc` frontmatter `description`, `globs`, `alwaysApply`; plain `.md` in `.cursor/rules` is ignored ([rules][cu-rules]) |

## 2. Skills and commands

| Question | Claude Code | Codex | Cursor |
| --- | --- | --- | --- |
| Project skill directory | `.claude/skills/<name>/SKILL.md` ([skills][cc-skills]) | `.agents/skills/<name>/SKILL.md`, scanned from the working directory up to the repo root ([skills][cx-skills]) | `.cursor/skills/` or `.agents/skills/` anywhere in the repo ([skills][cu-skills]) |
| Other tools' directories | Nothing under `.agents/` is read ([memory][cc-memory]); probe without the symlink logged "project: 0" skills | `.agents/skills` only in the docs ([skills][cx-skills]) | Also `.claude/skills/` and `.codex/skills/` ([skills][cu-skills]) |
| Commands | `.claude/commands/<name>.md` creates the same `/name` as a skill ([skills][cc-skills]) | Custom prompts in `~/.codex/prompts/` are deprecated for skills; no project directory ([custom prompts][cx-prompts]) | Commands convert to skills with `disable-model-invocation: true` ([skills][cu-skills]) |
| `SKILL.md` frontmatter | All optional, `description` recommended, `name` defaults to the directory; `description` plus `when_to_use` cut at 1,536 characters ([skills][cc-skills], [field list][cc-dir]) | `name` and `description` required; `agents/openai.yaml` adds UI metadata ([skills][cx-skills]) | `name` must match the folder (lowercase, digits, hyphens); `description`, `paths`, `disable-model-invocation` ([skills][cu-skills]) |
| Symlinked skill directories | Load ([skills][cc-skills]); probe loaded the skill through `.claude/skills -> ../.agents/skills` | Followed ([skills][cx-skills]) | The CLI skills menu follows them ([CLI changelog][cu-cli-log]) |

## 3. Agent definitions

| Question | Claude Code | Codex | Cursor |
| --- | --- | --- | --- |
| Project location | `.claude/agents/`, scanned recursively ([subagents][cc-agents]) | `.codex/agents/*.toml` ([subagents][cx-agents-doc]) | `.cursor/agents/`, `.claude/agents/`, `.codex/agents/`; `.cursor/` wins on a name clash ([subagents][cu-agents]) |
| Format | Markdown with YAML frontmatter; the body is the system prompt ([subagents][cc-agents]) | TOML ([subagents][cx-agents-doc]) | Markdown with YAML frontmatter ([subagents][cu-agents]) |
| Required fields | `name`, `description`; optional `tools`, `model`, `permissionMode`, `skills`, `mcpServers`, `hooks` and more ([subagents][cc-agents], [field list][cc-dir]) | `name`, `description`, `developer_instructions` ([subagents][cx-agents-doc]) | `name`, `description`, plus `model`, `readonly`, `is_background` ([subagents][cu-agents]) |
| Role and profile config | `--agents` JSON or the `agent` setting ([CLI reference][cc-cli]) | `[agents]` roles with `config_file` ([config reference][cx-ref]); profiles are `~/.codex/<name>.config.toml` since 0.134.0 ([advanced config][cx-adv]) | n/a ([subagents][cu-agents]) |

## 4. Hooks

Helper H's notes cover events and payloads. This table records where each tool reads project hooks.

| Question | Claude Code | Codex | Cursor |
| --- | --- | --- | --- |
| Project hook file | `hooks` key in `.claude/settings.json` or `.claude/settings.local.json`; no standalone hooks file ([hooks][cc-hooks], [debug config][cc-debug]) | `.codex/hooks.json` or `[hooks]` in `.codex/config.toml`, trusted projects only ([hooks][cx-hooks]) | `.cursor/hooks.json` at the project root ([hooks][cu-hooks]) |
| Event list | [hooks][cc-hooks] | [hooks][cx-hooks]; `codex features list` shows `hooks` stable and on | [hooks][cu-hooks] |

## 5. MCP servers

| Question | Claude Code | Codex | Cursor |
| --- | --- | --- | --- |
| Project file | `.mcp.json` at the repo root, servers under `mcpServers` ([MCP][cc-mcp], [debug config][cc-debug]) | `[mcp_servers.<name>]` in `.codex/config.toml` ([MCP][cx-mcp]) | `.cursor/mcp.json`, servers under `mcpServers` ([MCP][cu-mcp]); probe: a symlink to `../.mcp.json` parses |
| Approval or trust | Interactive sessions ask once per server; `-p` loads them without asking; `enableAllProjectMcpServers` or `enabledMcpjsonServers` in a committed `.claude/settings.json` is ignored until the workspace is trusted ([MCP][cc-mcp], [settings][cc-settings]) | Project config loads only when the project is trusted in `~/.codex/config.toml` ([MCP][cx-mcp], [advanced config][cx-adv]) | `agent mcp enable <name>` adds the server to the local approved list ([CLI MCP][cu-cli-mcp]); `--approve-mcps` approves all for a run ([parameters][cu-params]) |
| Probe result | `claude mcp list`: "⏸ Pending approval"; the same keys in the probe's `.claude/settings*.json` left it pending; `claude --settings '{"enableAllProjectMcpServers":true}' mcp list` approved it ([MCP][cc-mcp]) | Server listed only with `[projects."<path>"] trust_level = "trusted"` in the config file; `-c` override and a trusted parent directory did not add it; a git worktree of a trusted checkout listed it ([sample][cx-sample]) | `agent mcp list`: "needs approval"; `agent mcp enable probe` wrote `~/.cursor/projects/<path-slug>/mcp-approvals.json`; a git worktree of the same repo still needed approval ([CLI MCP][cu-cli-mcp]) |
| List command | `claude mcp list`, `claude mcp get <name>` ([MCP][cc-mcp]) | `codex mcp list --json` ([commands][cx-cmds]) | `agent mcp list`, `agent mcp list-tools <name>` ([CLI MCP][cu-cli-mcp]) |

## 6. Checking from a shell

| Check | Claude Code | Codex | Cursor |
| --- | --- | --- | --- |
| Instructions and skills | `claude -p "<prompt>" --debug-file <log>`; the log has "Loading skills from: ... project=[...]" and "Loaded N unique skills (... project: N ...)"; in a session `/context`, `/memory`, `/skills` ([debug config][cc-debug], [CLI reference][cc-cli]) | `codex debug prompt-input` prints the model-visible input with `AGENTS.md` text and the skill list ([commands][cx-cmds]); `/skills`, `/debug-config` in a session | `agent -p` with `--output-format json` ([parameters][cu-params]); needs a login, see Auth |
| Agents | `/agents` prints a reminder since v2.1.197 ([commands][cc-cmds]); probe: `claude -p` listed the agent's marker | `/subagents` ([commands][cx-cmds]) | Unconfirmed: no agent list command found in [parameters][cu-params] or [subagents][cu-agents] |
| Hooks | `/hooks`; `--debug hooks` ([debug config][cc-debug], [CLI reference][cc-cli]) | `/hooks` ([commands][cx-cmds]) | Unconfirmed: no hook list command found in [parameters][cu-params]; file format in [hooks][cu-hooks] |
| MCP | `claude mcp list` ([MCP][cc-mcp]) | `codex mcp list --json` ([commands][cx-cmds]) | `AGENT_CLI_CREDENTIAL_STORE=file agent mcp list` works with no login ([CLI MCP][cu-cli-mcp]) |
| Skip project config | `--setting-sources user`, `--safe-mode`, `--bare` ([CLI reference][cc-cli]) | No flag for the project layer found; `codex exec --ignore-user-config` skips `$CODEX_HOME/config.toml` and `--ignore-rules` skips execpolicy `.rules` files (local `--help`, [commands][cx-cmds]) | None found in [parameters][cu-params] |
| Auth in an agent shell | `claude -p` and `claude mcp list` ran in the probe ([CLI reference][cc-cli]) | `codex debug prompt-input` and `codex mcp list` ran in the probe; `codex exec` was not run ([commands][cx-cmds]) | `cursor-agent --help` and `--version` fail with "Your macOS login keychain is locked." in a Background security session. `AGENT_CLI_CREDENTIAL_STORE=file` skips the keychain ([CLI changelog][cu-cli-log], [forum][cu-forum]) and then `agent status` says "Not logged in". Log in once with that variable set from a Terminal `.command` (Aqua session), or set `CURSOR_API_KEY` ([authentication][cu-auth]) |

## Layout Oxbit uses

| Kind | Source file | Claude Code | Codex | Cursor |
| --- | --- | --- | --- | --- |
| Instructions | `AGENTS.md` | `CLAUDE.md` holds `@AGENTS.md` | Native | Native |
| Skills | `.agents/skills/<name>/SKILL.md` | `.claude/skills` symlink to `../.agents/skills` | Native | Native |
| Agents | `.claude/agents/preflight.md` | Native | `.codex/agents/preflight.toml` points at the Markdown file | Native |
| Hooks | `scripts/agent/hooks/run.mjs` | `hooks` in `.claude/settings.json` | `[hooks]` in `.codex/config.toml` | `.cursor/hooks.json` |
| MCP | `.mcp.json`, server `scripts/agent/mcp/server.mjs` | Native | `[mcp_servers.oxbit-dev]` in `.codex/config.toml` | `.cursor/mcp.json` symlink to `../.mcp.json` |

The MCP and Codex hook commands find the repo root with `git rev-parse --show-toplevel`, so a session started in a subdirectory still finds the scripts.

One-time steps per worktree path:

- Claude Code asks once to approve `oxbit-dev` in an interactive session; `claude -p` loads it without asking ([MCP][cc-mcp]).
- Codex runs each project hook only after `/hooks` review and trust ([hooks][cx-hooks]). A `codex exec` run of `git stash` on 2026-10-21 was not blocked before that review.
- Cursor needs `agent mcp enable oxbit-dev` ([CLI MCP][cu-cli-mcp]). A Cursor permission hook has to answer, and `allow` proceeds without Cursor's own approval, so `.cursor/hooks.json` matches only `stash|pr merge` and a pass answers `ask` ([hooks][cu-hooks]).

Checks run in this worktree on 2026-10-21:

| Tool | Command | Result |
| --- | --- | --- |
| Claude Code | `claude --settings '{"enableAllProjectMcpServers":true}' mcp list` | `oxbit-dev` Connected |
| Claude Code | `claude -p` asking for the heredoc rule, the project skills, and the `doctor` tool | Answered `/bin/cat`, listed the six skills (debug log "project: 6"), `doctor` returned `Background` |
| Claude Code | `claude -p` asking for the `preflight` subagent | Quoted its description |
| Codex | `codex mcp list` | `oxbit-dev` enabled |
| Codex | `codex debug prompt-input` | `AGENTS.md` text and the six skills from the worktree `.agents/skills` |
| Cursor | `AGENT_CLI_CREDENTIAL_STORE=file cursor-agent mcp list-tools oxbit-dev` | 8 tools |
| Cursor | `cursor-agent -p` from a Terminal `.command` | "Authentication required. Please run 'agent login' first" |

## Features a tool lacks

- Claude Code does not read `.agents/skills` or anything else under `.agents/` ([memory][cc-memory]). A `.claude/skills` symlink fixes it ([skills][cc-skills]).
- Claude Code skips `AGENTS.md` once any `CLAUDE.md` or `CLAUDE.local.md` exists unless that file imports it ([memory][cc-memory]).
- Claude Code has no standalone project hooks file ([debug config][cc-debug]).
- Codex documents no import syntax in `AGENTS.md` ([AGENTS.md][cx-agents]).
- Codex has no project-level custom prompts directory; prompts are deprecated ([custom prompts][cx-prompts]).
- Codex agent definitions are TOML, so the Markdown files in `.claude/agents/` do not load there ([subagents][cx-agents-doc]).
- Codex ignores project `.codex/` config, hooks and MCP in an untrusted project ([config reference][cx-ref]).
- Cursor ignores plain `.md` files in `.cursor/rules` ([rules][cu-rules]).
- Cursor keeps MCP approvals per path outside the repo, so each new worktree needs `agent mcp enable` ([CLI MCP][cu-cli-mcp]).
- The Cursor Agent CLI stores credentials in the macOS keychain by default ([authentication][cu-auth], [CLI changelog][cu-cli-log]).

## Unconfirmed

- Cursor IDE reading `CLAUDE.md`: "CLAUDE" is absent from [rules][cu-rules]; only the [CLI page][cu-cli-using] names it.
- Legacy `.cursorrules`: absent from [rules][cu-rules]; only forum and third-party pages mention it.
- `.cursor/commands/*.md` path: [skills][cu-skills] describes only the migration of commands to skills.
- Cursor with both `.agents/skills` and a `.claude/skills` symlink to it: duplicate handling is not in [skills][cu-skills], and `agent -p` needs a login this shell lacks.
- Cursor loading rules, skills and `AGENTS.md` from a shell run: `agent -p` returned "Authentication required" from both the agent shell and a Terminal `.command`; it needs `agent login` in a browser or `CURSOR_API_KEY` ([authentication][cu-auth]).
- Claude Code applying a main checkout's trust to its git worktrees: not stated on [memory][cc-memory], [MCP][cc-mcp] or [settings][cc-settings]; the probe did not edit `.claude.json`.
- Codex `.codex/skills`: absent from [skills][cx-skills]; only a third-party page calls it an older location.

## Sources

Read 2026-10-21. `developers.openai.com/codex` pages redirect to `learn.chatgpt.com`.

[cc-memory]: https://code.claude.com/docs/en/memory
[cc-log]: https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md
[cc-skills]: https://code.claude.com/docs/en/skills
[cc-dir]: https://code.claude.com/docs/en/claude-directory
[cc-agents]: https://code.claude.com/docs/en/sub-agents
[cc-hooks]: https://code.claude.com/docs/en/hooks
[cc-debug]: https://code.claude.com/docs/en/debug-your-config
[cc-mcp]: https://code.claude.com/docs/en/mcp
[cc-settings]: https://code.claude.com/docs/en/settings-reference
[cc-cli]: https://code.claude.com/docs/en/cli-reference
[cc-cmds]: https://code.claude.com/docs/en/commands
[cx-agents]: https://learn.chatgpt.com/docs/agent-configuration/agents-md
[cx-sample]: https://learn.chatgpt.com/docs/config-file/config-sample
[cx-ref]: https://learn.chatgpt.com/docs/config-file/config-reference
[cx-adv]: https://learn.chatgpt.com/docs/config-file/config-advanced
[cx-skills]: https://learn.chatgpt.com/docs/build-skills
[cx-prompts]: https://learn.chatgpt.com/docs/custom-prompts
[cx-agents-doc]: https://learn.chatgpt.com/docs/agent-configuration/subagents
[cx-hooks]: https://learn.chatgpt.com/docs/hooks
[cx-mcp]: https://learn.chatgpt.com/docs/extend/mcp?surface=cli
[cx-cmds]: https://learn.chatgpt.com/docs/developer-commands?surface=cli
[cx-release]: https://github.com/openai/codex/releases/tag/rust-v0.163.0
[cu-rules]: https://cursor.com/docs/context/rules
[cu-cli-using]: https://cursor.com/docs/cli/using
[cu-cli-log]: https://cursor.com/docs/cli/changelog
[cu-skills]: https://cursor.com/docs/context/skills
[cu-agents]: https://cursor.com/docs/context/subagents
[cu-hooks]: https://cursor.com/docs/agent/hooks
[cu-mcp]: https://cursor.com/docs/context/mcp
[cu-cli-mcp]: https://cursor.com/docs/cli/mcp
[cu-params]: https://cursor.com/docs/cli/reference/parameters
[cu-auth]: https://cursor.com/docs/cli/reference/authentication
[cu-forum]: https://forum.cursor.com/t/errsecitemnotfound-couldnt-find-your-saved-login-in-the-macos-keychain/167325
