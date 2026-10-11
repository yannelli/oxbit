# Agent panel research (2026)

Created: 2026-10-10. Last updated: 2026-10-11.

This survey compares Oxbit's Agent ACP panel with other editors and mobile
agent clients. It records the patterns Oxbit adopted and the ones it defers.
Zed documentation pages carry no date; they are cited as accessed on 2026-10-10.

## ACP Registry

- Registry JSON: `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`
  ([schema](https://github.com/agentclientprotocol/registry/blob/main/agent.schema.json), last commit 2026-09-28).
  The top level has `version`, `agents[]` and `extensions[]`. The CDN sends `cache-control: max-age=300`.
- Each agent has `id`, `name`, `version`, `description` and `distribution`. Optional fields are
  `repository`, `website`, `authors`, `license` and `icon`.
- Distributions:
  - `npx` or `uvx`: `{ package, args?, env? }`.
  - `binary`: a map keyed by `darwin|linux|windows` × `aarch64|x86_64`, each with
    `{ archive, cmd, args?, env?, sha256? }`.
- On 2026-10-10 the registry listed 41 agents. Among them: Claude Agent
  (`@agentclientprotocol/claude-agent-acp@0.89.1`), Codex (`@agentclientprotocol/codex-acp@2.2.2`),
  Gemini CLI (`@google/gemini-cli@0.63.0 --acp`), GitHub Copilot (`@github/copilot@1.0.95 --acp`),
  Cursor, OpenCode, goose, Amp, Junie, Qwen Code, Cline, Auggie, Factory Droid and Kimi.
- Zed installs from an in-editor registry page, and registry entries replace agent extensions
  ([Zed blog](https://zed.dev/blog/acp-registry), 2026-01-28). JetBrains installs through
  "Install From ACP Registry…" in the agent picker
  ([JetBrains blog](https://blog.jetbrains.com/ai/2026/01/acp-agent-registry/), 2026-01).

## Desktop editors

**Zed** ([agent panel](https://zed.dev/docs/ai/agent-panel), [external agents](https://zed.dev/docs/ai/external-agents), [parallel agents](https://zed.dev/blog/parallel-agents) 2026-04-22)
- Enter sends. Escape stops. A new thread can use any agent, from the `+` menu or the empty-state selector.
- `@` mentions files, symbols, threads, diagnostics, the selection and the branch diff. Images can be pasted, dropped or mentioned.
- A ring shows token usage and turns to the warning color at 85%.
- An accordion above the composer shows changed files, with Review Changes, Keep All and Reject All. Restore Checkpoint sits on the user message.
- Queued messages can be edited, removed or sent now.
- Settings: `agent.notify_when_agent_waiting` and `agent.play_sound_when_agent_done` ([default settings](https://github.com/zed-industries/zed/blob/main/assets/settings/default.json), 2026-10-06).

**JetBrains AI Assistant** ([agents](https://www.jetbrains.com/help/ai-assistant/agents.html) 2026-08-03, [ACP](https://www.jetbrains.com/help/ai-assistant/acp.html) 2026-07-22, [Claude Agent](https://www.jetbrains.com/help/ai-assistant/claude-agent.html) 2026-08-05)
- The agent picker lists Junie, Claude Agent, Codex, Copilot and registry agents. "Add Custom Agent" edits `~/.jetbrains/acp.json`.
- Approvals offer Allow once, Always allow and Deny. A changed-files pane has per-file revert.
- `@` adds files. Attachments can be files, folders, images, symbols or commits. A context-window indicator shows a percentage.

**VS Code** ([chat sessions](https://code.visualstudio.com/docs/copilot/chat/chat-sessions), [approvals](https://code.visualstudio.com/docs/agents/run/approvals), [checkpoints](https://code.visualstudio.com/docs/copilot/chat/chat-checkpoints), all 2026-10-07)
- A sessions list shows status and file-change stats. A target picker chooses Copilot, Claude, Codex or Cloud.
- Badges mark unread and waiting sessions. OS toasts fire on responses and on pending confirmations.
- Checkpoints support restore and fork. Approvals apply to once, session, workspace or always.

**Cursor 3** ([Cursor 3](https://cursor.com/blog/cursor-3) 2026-04-02, [mentions](https://cursor.com/docs/context/mentions), [1.5 changelog](https://cursor.com/changelog/1-5) 2025-08-21)
- An Agents window shows parallel local and cloud agents.
- `@` covers files, terminals, chats and git diffs. Images can be pasted or dragged.
- OS notifications fire when a run finishes or needs input. Messages can be queued and reordered.

## Mobile clients

- **Claude Code** ([remote control](https://code.claude.com/docs/en/remote-control)): a session list with online state, photo and file attachments, `@` autocomplete, a diff pane and model controls. Permission prompts persist until answered. Push notifications fire on finish and on decisions.
- **ChatGPT Codex** ([remote connections](https://learn.chatgpt.com/docs/remote-connections), [changelog](https://learn.chatgpt.com/docs/changelog) 2026-05-14 to 2026-10-07): QR pairing with a host. From the phone: approvals, diffs, terminal output, notifications that open the task, voice in the composer, a Live Activity and iPad split view.
- **GitHub Mobile** ([remote control GA](https://github.blog/changelog/2026-05-18-remote-control-for-copilot-cli-sessions-now-generally-available-on-mobile-web-and-vs-code/) 2026-05-18, [live notifications](https://github.blog/changelog/2026-07-08-github-mobile-live-notifications-for-copilot-cli-sessions) 2026-07-08): steer or queue messages, approve permissions, switch modes, and Live Activities for session state.
- **Cursor iOS** ([mobile docs](https://cursor.com/docs/cloud-agent/mobile), [iOS app](https://cursor.com/blog/ios-mobile-app) 2026-06-29): an agent inbox, photo attachments, voice, diff review, and push on finish or when input is needed.
- **Happy** ([mobile](https://happy.engineering/desktop/docs/mobile/)): QR pairing, an encrypted relay, permission answers and push when input is needed.
- **Paseo** ([repository](https://github.com/getpaseo/paseo), checked 2026-10-10): vendors the ACP Registry agent icons in `packages/app/src/assets/acp-provider-icons.ts` for its provider list.

## Patterns most tools share

| Pattern | Tools | Oxbit | Checked by |
| --- | --- | --- | --- |
| Install agents from the ACP Registry, plus custom agents | Zed, JetBrains | Registry browser, Claude Agent, Gemini CLI, GitHub Copilot and custom agents | `agent-acp-start`: registry browser, registry binary install, custom agent |
| Type and send without a separate connect step | Zed, VS Code, Cursor | Sending starts the chosen agent | `agent-acp-composer`: sends before connect |
| Enter sends, Shift+Enter adds a newline | Zed, VS Code, Cursor, Claude, ChatGPT | Yes, with `agentACP.useModifierToSend` | `agent-acp-composer`: sends on Enter |
| `@` mentions | All | Files, workspace symbols from running language servers, selection, diagnostics, uncommitted changes and earlier threads | `agent-acp-composer`: mentions, `@Changes`, workspace symbol, earlier thread |
| Image paste and drop | All | Yes, when the agent advertises image prompts | `agent-acp-composer`: paste, drop and resize |
| Badges and in-app alerts when an agent waits or finishes | VS Code, Zed, Cursor | Activity and phone tab badges, status item, toast | `agent-acp-start`: status item and toast, request badge |
| OS or push notifications | VS Code, Cursor, Claude, Codex, GitHub | System notifications when the window is hidden or unfocused: native in the macOS and iOS apps, Web Notification in browsers. Selecting a macOS or iOS notification opens the agent panel, also when it launches Oxbit. The runtime pushes to a suspended iOS app through the Oxbit push relay; device delivery unchecked | `agent-acp-start`: system notification; `tests/desktop/agent.e2e.mjs`: plugin and native paths; `ssh-runtime` (iOS): notification tap after relaunch; `tests/ios/push.spec.ts`, `apps/runtime/tests/push.test.ts`, `apps/push-relay/tests` |
| Agent panel docked right | Zed, VS Code, Cursor | Yes, for new layouts | `panel-docking`: right-dock view |
| Agent in the phone tab bar | Claude, Codex, GitHub, Cursor | Yes | `mobile`: phoneBar slot with a badge |
| Checkpoints and restore | Zed, VS Code, Cursor | Git checkpoint per message with Restore checkpoint; files only, the agent's context is unchanged | `agent-acp-checkpoints` |
| Parallel threads in tabs | Zed, VS Code, Cursor | Thread strip with status per thread, up to 3 agents per device; background requests badge the Agent button | `agent-acp-threads` |
| Context-usage meter | Zed, VS Code, JetBrains, Cursor | Ring with percent and token counts; warning color from 85% | `agent-acp-workflows`: 85% of context used |
| Voice input | Cursor, Codex, Happy | Microphone button in the composer: Web Speech API in browsers and the macOS app, Apple's Speech framework in the iOS app. Recognition in the apps has not run past the permission prompts | `agent-acp-composer`: microphone; `tests/desktop/agent.e2e.mjs`: speech recognition; `packages/host-ios/src/speech.test.ts` |
| Live Activities | Codex, GitHub | Lock Screen and Dynamic Island activity for the connected thread: working with elapsed time, needs input, finished or failed. Updated by the app while it runs and by push while iOS suspends it; push delivery unchecked on a device | `agent-acp-start`: activity service; `attention.test.ts`: 5-minute refresh; `apps/runtime/tests/push.test.ts`: activity pushes |
| Agent icons from the ACP Registry | Paseo | Picker, registry browser, header, thread chips, runtime sessions and history | `agent-acp-start`: picker and registry icons |

## Side by side

Each cell records what the cited source documents. "–" means the source does not
mention the capability; "n/a" means it does not apply to that client. The specs in
the table above check the Oxbit cells, the iOS column with phone-viewport browser
specs, `tests/ios` and `packages/host-ios` unit tests.

| Capability | Zed | JetBrains | VS Code | Cursor | Claude Code phone | Codex phone | GitHub Mobile | Cursor iOS | Oxbit desktop | Oxbit iOS |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Agents | ACP Registry, custom | ACP Registry, custom | Copilot, Claude, Codex, Cloud | Cursor | Claude Code | Codex | Copilot CLI | Cursor | ACP Registry, custom | ACP Registry, custom |
| Send without a connect step | Yes | – | Yes | Yes | – | – | – | – | Yes | Yes |
| `@` files | Yes | Yes | – | Yes | Yes | – | – | – | Yes | Yes |
| `@` symbols | Yes | Yes | – | – | – | – | – | – | Yes | Yes |
| `@` earlier threads | Yes | – | – | Yes | – | – | – | – | Yes | Yes |
| `@` diff or commits | Branch diff | Commits | – | Git diffs | – | – | – | – | Uncommitted changes | Uncommitted changes |
| Images | Yes | Yes | – | Yes | Yes | – | – | Yes | Yes | Yes |
| Approve tool calls | – | Yes | Yes | – | Yes | Yes | Yes | – | Yes | Yes |
| Review agent edits | Keep All, Reject All | Per-file revert | – | – | Diff pane | Diffs | – | Diff review | Per edit, with Undo | Per edit, with Undo |
| Checkpoints | Yes | – | Restore and fork | – | – | – | – | – | Restore, files only | Restore, files only |
| Queued messages | Edit, remove, send now | – | – | Queue, reorder | – | – | Queue | – | Edit, remove, send now | Edit, remove, send now |
| Parallel threads | Yes | – | Sessions list | Agents window | Session list | – | – | Agent inbox | Thread strip | Thread strip |
| Context meter | Ring, 85% warning | Percentage | – | – | – | – | – | – | Ring, 85% warning | Ring, 85% warning |
| Badges for waiting agents | – | – | Yes | – | – | – | – | – | Yes | Yes |
| OS notification while the app runs | Setting | – | Yes | Yes | – | – | – | – | Yes | Yes |
| Selecting the notification opens the agent | – | – | – | – | – | Yes | – | – | macOS app (selection unchecked) | Yes |
| Push while the phone app is suspended | n/a | n/a | n/a | n/a | Yes | Yes | Yes | Yes | n/a | Built; device delivery unchecked |
| Voice input | – | – | – | – | – | Yes | – | Yes | Yes | Yes |
| Live Activity | n/a | n/a | n/a | n/a | – | Yes | Yes | – | n/a | Yes; push updates unchecked on a device |

Rows where another client documents more than Oxbit are listed under the gaps below.

## Gaps against other tools

- Push to a suspended phone and Live Activity push updates have not run on a device:
  the relay needs an APNs key and the app needs a TestFlight build with the push entitlement.
- Selecting a macOS notification has not run with notifications allowed.
- Zed keeps or rejects all of an agent's edits at once; Oxbit reviews and undoes each edit.
- VS Code forks a conversation from a checkpoint; Oxbit restores files only.
- Zed mentions the branch diff and JetBrains attaches commits and folders; Oxbit attaches uncommitted changes and files.
- Cursor reorders queued messages; Oxbit does not.
- Dictation, iOS notification taps and the Live Activity have not run on a physical device.
