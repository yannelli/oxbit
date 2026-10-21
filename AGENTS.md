# Oxbit agent instructions

Created: 2026-10-21. Last updated: 2026-10-21.

This file is the one source of project instructions for Claude Code, Codex and Cursor. `CLAUDE.md` imports it. [Agent tooling](docs/agents/agent-tooling.md) records how each tool loads instructions, skills, agents, hooks and MCP servers, with links.

## Repo map

| Path | Contents |
| --- | --- |
| `apps/runtime` | Node runtime and the `oxbit` CLI: files, terminals, tasks, Git, language servers |
| `apps/web` | React web UI |
| `apps/desktop` | Tauri desktop app (`src-tauri` is Rust) |
| `apps/ios` | Tauri iOS app, Swift plugins in `apps/ios/plugins` |
| `apps/agent` | `oxbit-agent` CLI, npm `@oxbit/agent` |
| `apps/push-relay` | `oxbit-push` Cloudflare Worker |
| `packages/*` | SDK, protocol, core, workbench, hosts, themes, icon themes, UI, agent core |
| `packages/features/*` | Workbench features (editor, explorer, git, tasks, agent-acp, ai, themes and more) |
| `scripts/` | Build, release, desktop, iOS, npm and agent tooling scripts |
| `tests/` | Browser (Playwright), desktop (WebdriverIO) and agent tooling tests |
| `website/` | oxbit.dev |
| `docs/` | Guides; [docs/INDEX.md](docs/INDEX.md) lists them with when to use each |

Node 24 (`.node-version`) and bun 1.4.2 (`packageManager`).

## Checks per path

Run the checks the PR workflows run for the paths you changed before you push. The `checks_for_paths` tool of the `oxbit-dev` MCP server returns them from `.github/workflows/*.yml` and `package.json`.

| Changed path | Local check | Workflow |
| --- | --- | --- |
| Any TypeScript | `bun run lint`, `bun run typecheck`, `bun run test` | `desktop.yml` |
| Theme packs, CSS, colors or font sizes | `bunx vitest run packages/themes/src/index.test.ts` (runs `scripts/theme-coverage.mjs --check`) | `desktop.yml` through `bun run test` |
| UI behavior | `bun run build`, `bun run test:browser`, `bun run test:tasks:browser` | `desktop.yml` |
| `apps/desktop/src-tauri` | `bun run desktop:check` (cargo fmt, clippy with `-D warnings`, tests) | `desktop.yml` |
| `apps/ios`, `packages/host-ios` | `bun run ios:check`, then `bun run ios:simulator` | `ios.yml` |
| Language servers (`apps/runtime/src/lsp*`, `packages/features/language`) | the vitest list in `.github/workflows/language-servers.yml` | `language-servers.yml` |
| `scripts/npm`, `packages/sdk`, package manifests | `bun run build`, `node scripts/npm/publish.mjs <sdk\|cli\|agent> --dry-run` | `npm.yml` |
| Settings schema | `bun run settings:schema:check` | `bun run test` |
| `scripts/agent`, `tests/agent` | `bunx vitest run tests/agent` | `desktop.yml` through `bun run test` |

`desktop.yml` and `ios.yml` run on every PR. `main` has no CI of its own, so a red PR check is the last warning before main breaks. Clippy on Linux has failed on code that passed on macOS (PR #93); run `desktop:check` for Rust changes.

## Docs

- Each guide has `Created:` and `Last updated:` dates under its title and a row in `docs/INDEX.md`.
- When code under a path changes, update the docs that cover it. The `docs_for_paths` MCP tool lists them.
- Research you rely on (current APIs, platform rules, terms) lands in a dated doc with links, an `INDEX.md` row, and a link from `README.md`.

## Shell on this Mac

- `cat` is aliased to `pygmentize` and writes ANSI codes into files. Use `/bin/cat`, `printf` or the editor tools.
- `find` is bfs and breaks on directory names that start with `-`. Use Python for those.
- `timeout` is not installed. Use `perl -e 'alarm N; exec @ARGV' cmd ...`.
- The git stash stack is shared by every worktree. Bare `git stash` and `git stash pop` are blocked by a hook. Use a WIP commit, or `git stash push -u -m "<tag>"` and `git stash apply <sha>`.
- Run `launchctl managername` before you conclude a credential is missing. In a `Background` session the login keychain reads as locked, so `codesign`, `xcrun notarytool`, HTTPS `git push`, GPG signing and `devicectl` device access fail. Run those through a Terminal `.command` script (`open -a Terminal /tmp/task.command`, poll its log, write a sentinel line at the end). `git push git@github.com:yannelli/oxbit.git <ref>` and `gh` work without the keychain.
- A push to the URL leaves `origin/<branch>` stale, so the Stop hook and `unpushed_work` report the commits as unpushed. Run `git fetch origin <branch>` after the push.
- Commit with `git -c commit.gpgsign=false commit`; the GPG passphrase is not cached. Run Playwright and `scripts/release.mjs` with `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false`.
- The `doctor` MCP tool reports the session type and the Node and bun versions.

## Work rules

- Push before you end. Commit and push a WIP branch before a session or subagent ends, and before a worktree is deleted. A Stop hook warns about uncommitted changes and unpushed commits. The `unpushed_work` MCP tool lists them across `~/.paseo/worktrees`.
- Merge when green. Once every PR check passes and the change is sound, check mergeable state and file overlap with other open PRs, then `gh pr merge <n> --merge`. Do not leave a green PR waiting for a merge decision. A hook blocks `gh pr merge` while checks fail or are pending. Rerun failed jobs once; if they fail again, report the failure and stop.
- Before you decline an ask as impossible, against terms, or too large, research the current terms and platform docs (search the web for the date you are in), quote the clause, and propose the closest route those rules allow. Decline only after that research finds no route.
- Record what you leave open in the [ledgers](docs/agents/ledgers/README.md) (MCP tools `ledger_list`, `ledger_add`, `ledger_update`). Follow-ups, device checks and flaky tests live in `docs/agents/ledgers/`. This repo is public, so open questions for the user and account actions live in the local ledger outside the repo. Each PR updates the rows it opens or closes. Log a flaky test with its run id.
- Keep the user's prompt text, personal items and account details out of commits, PR bodies and repo docs.
- Ask open questions again. At session start, list open questions with `ledger_list` and raise the ones that block your task.

## Releases

1. Write `docs/testflight/X.Y.Z.md` and commit it so the tree is clean.
2. `bun run release X.Y.Z --no-desktop --no-ios --commit --tag`.
3. `git push origin HEAD:main`, wait until `gh run list --workflow npm.yml --branch main` shows a run for that SHA, then push the tag. A tag pushed first can be cancelled by the main run in the `npm-publish` concurrency group; rerun a cancelled tag run.
4. The tag's Release workflow uploads to TestFlight and assigns `Internal Testing` only. Promote to `Public Beta` after the user checks the build on a device and asks for it (`node scripts/ios/distribute-testflight.mjs --build <n>`). Do not cancel the Release workflow.
5. GitHub releases are immutable. `gh release upload` on a published release fails, so a failed `linux (ubuntu-24.04-arm)` job ships in the next patch tag.
6. npm can hold a new version for up to about 2 hours. A rerun during the hold returns E409; poll `registry.npmjs.org/@oxbit%2f<name>/<version>` instead.

The `release` skill runs this sequence. [Signed releases](docs/release.md) and [npm packages](docs/npm.md) have the details.

## Subagents

- Put a long brief in a shared file and point the subagent at it. A `/goal` condition holds at most 4,000 characters, and briefs in the prompt are lost after compaction.
- Each subagent writes its notes file after every step. The coordinator checks that the file grows, nudges a stalled agent once, then replaces it, and reads the result before accepting it.
- Give concurrent subagents disjoint files. The coordinator makes the commits.

## Writing

A `concise` hook rejects text that breaks these rules, so write them right the first time:

- Comments at most 2 contiguous lines. New files at most 300 lines.
- PR and issue bodies at most 3 paragraphs and 8 sentences per paragraph; put lists in tables. Start PR bodies with `## Summary` and pass them with `gh pr create --body-file`.
- No bold lead-in labels (`**Label:**`), no `→` or `…`, no "X, not Y" contrasts, no hedges ("may", "might", "could", "typically", "note that").
- Sentence-case headings, plain words, no puffery or emoji.
- Describe the default file icons as Oxbit icons. They are original work.
