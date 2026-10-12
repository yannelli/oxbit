# Oxbit Agent

A terminal coding agent with a TUI, a print mode and an
[Agent Client Protocol](https://agentclientprotocol.com) server. It is part of
[Oxbit](https://github.com/yannelli/oxbit).

```sh
npm install -g @oxbit/agent
oxbit-agent
```

Node 24 is required.

## Usage

```sh
oxbit-agent                          # TUI in the current directory
oxbit-agent "Fix the failing test"   # TUI with a first prompt
oxbit-agent -p "Summarize src/"      # print the reply and exit
oxbit-agent acp                      # ACP agent on stdin/stdout
oxbit-agent -c                       # continue the latest session here
oxbit-agent login chatgpt            # use a ChatGPT plan
oxbit-agent login claude             # use a Claude plan through Claude Code's sign-in
oxbit-agent models                   # list the provider's models
```

Options: `--provider`, `-m/--model`, `--mode ask|accept-edits|full-auto`,
`-r/--resume <id>`.

## Providers

OpenAI (API key or Sign in with ChatGPT), Anthropic (API key), OpenRouter, Ollama,
and any OpenAI-compatible server. Keys come from `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY` and `OPENROUTER_API_KEY`, or from `oxbit-agent login`.
`--provider claude` uses a Claude plan: it runs the Claude Agent ACP adapter,
which runs Claude Code under your own Claude Code sign-in.

## Features

- `AGENTS.md` and `CLAUDE.md` instructions, global and per directory
- Agent Skills from `~/.oxbit/agent/skills`, `~/.claude/skills` and `.agents/skills`
- Claude Code and Codex compatible command hooks
- `/goal`, `/loop`, `/compact` and automatic compaction
- MCP servers over stdio and HTTP
- Git snapshots with `/undo` and `/redo`
- Saved sessions with resume and fork

Settings live in `~/.oxbit/agent/settings.json`. See the
[Oxbit Agent guide](https://github.com/yannelli/oxbit/blob/main/docs/oxbit-agent.md).

## License

MIT
