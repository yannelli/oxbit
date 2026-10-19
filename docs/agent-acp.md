# Agent ACP

Created: 2026-10-10. Last updated: 2026-10-12.

Agent ACP is a bundled, **disabled-by-default** extension that runs agents
speaking the [Agent Client Protocol](https://agentclientprotocol.com). Open
**Extensions → Agent ACP → Enable**, then use **Agent ACP: Open Agent ACP** in the
command palette, its activity icon, or the **Agent** tab on a phone.
Enabling and disabling persist across reloads, including workspaces created
before this extension was added. Enabling alone does not launch or install an
agent.

Connect Oxbit to a runtime workspace and grant workspace tool trust. Browser,
desktop and iOS use the same extension. Only the runtime owner can launch and
control agents; shared workspace grants do not gain agent access. Browser-only
workspaces show runtime connection guidance.

## Starting an agent

A new conversation shows an agent picker. Choose an agent and select **Start**
(the panel's only start control until the conversation has messages),
or type a message and send it: the panel starts the chosen agent and sends the
message once the session is ready. The choice is saved as `agentACP.provider`.

The picker, the registry browser, the header, thread chips, runtime sessions and
history show each agent's ACP Registry icon in the current text color. The icons
are vendored in `packages/features/agent-acp/src/agent-logos.ts`;
`node scripts/agent-logos.mjs [commit]` refreshes them from the registry repository.
Custom agents and registry agents added after that commit use the generic agent icon.

- **Built-in agents** are listed below.
- **More agents…** browses the [ACP Registry](https://agentclientprotocol.com/get-started/registry)
  through the runtime, with search by name, ID or description. Agents the runtime cannot
  launch stay listed with the reason: no build for its platform, no published checksum,
  or an archive format Oxbit cannot extract.
- **Custom agent…** runs any ACP executable. Enter the name, executable, and
  arguments as a shell-style line; quotes group words. They are saved as
  `agentACP.custom.name`, `agentACP.custom.command`, and `agentACP.custom.args`.

Runtimes from 0.7.1 and earlier accept only Codex, Cursor and Amp. Starting another agent on
such a runtime shows "This runtime does not support … Update Oxbit on the runtime host."

## Providers

| Provider | Default executable and arguments | Setup |
| --- | --- | --- |
| Codex ACP | `npx -y @agentclientprotocol/codex-acp@2.2.2` | Existing Codex credentials, or an advertised sign-in method |
| Claude Agent | `npx -y @agentclientprotocol/claude-agent-acp@0.89.1` | Claude Code sign-in on the runtime host, including a Claude plan (see [Claude plans](#claude-plans)) |
| Gemini CLI | `npx -y @google/gemini-cli@0.63.0 --acp` | Sign in with the Gemini CLI or set `GEMINI_API_KEY` |
| GitHub Copilot | `npx -y @github/copilot@1.0.95 --acp` | Sign in with GitHub through the Copilot CLI |
| Cursor ACP | `agent acp` | Install Cursor CLI and run `agent login` |
| Amp Agent ACP | `npx -y amp-acp@0.10.0` | Install Amp CLI and run `amp login` |

Codex uses the [maintained ACP adapter](https://github.com/agentclientprotocol/codex-acp),
which bundles a compatible Codex dependency. Cursor uses its
[native ACP interface](https://cursor.com/docs/cli/acp). Amp uses the
[community Amp ACP adapter](https://github.com/tao12345666333/amp-acp). The Claude,
Gemini and Copilot versions match the ACP Registry entries fetched on 2026-10-10.

**Agent setup** in the panel's **More agent actions** menu exposes the executable
and arguments. These are also available in Settings under Agent ACP, together with
the default agent. Commands launch directly without shell interpolation. For a
local adapter, replace `npx` with its absolute executable path and clear the
arguments. If Cursor is installed as `cursor-agent`, use that executable with `acp`.
The first `npx` connection downloads the pinned adapter if it is not cached. Nothing is downloaded
when the disabled extension is registered or when it is enabled.

### Claude plans

Added 2026-10-12. A Claude Pro, Max or Team plan reaches the panel through **Claude Agent**,
which runs the unmodified Claude Code on the runtime host. Sign in on that computer with
Claude Code's own flow: `claude auth login` in a terminal, or `/login` inside `claude`. Oxbit
does not read, store or relay Claude credentials and has no Claude sign-in of its own.

- iOS runs Claude Agent on a connected runtime (LAN or SSH). In a device folder, the
  picker marks it "Needs a runtime workspace", and **Agent setup → API → Claude plan**
  shows that guidance with a **Runtime connection** button. The choice changes no setting.
- Claude Agent 0.89.1 advertises no sign-in methods. While Claude Code is signed out, a
  prompt fails with JSON-RPC `-32000` "Authentication required", and the panel shows
  "Claude Code on this runtime is not signed in. Run `claude auth login` in a terminal on
  that computer, then retry." (`agentErrorText` in `launch.ts`).

### Oxbit Agent without a runtime

Added 2026-10-11. In iOS device folders, which have no runtime, the picker offers
**Oxbit Agent** and marks the other agents "Needs a runtime workspace" (Claude Agent adds
that it uses the Claude plan through Claude Code's sign-in on the runtime). The agent
runs in the app (`packages/features/agent-acp/src/local/runtime.ts` hosts the
`@oxbit/agent-core` loop) and calls a model API
with the user's key:

| `agentACP.oxbit.api` | API |
| --- | --- |
| `openai` (default) | OpenAI Responses |
| `anthropic` | Anthropic Messages |
| `openai-compatible` | Chat Completions at `agentACP.oxbit.baseUrl` |
| `chatgpt` | Codex Responses of the ChatGPT plan, signed in with a device code |

- **Agent setup** saves the key in the iOS Keychain; settings hold only the API,
  base URL and model. Start without a key shows "Add an API key in Agent setup".
- **ChatGPT plan** (when the host offers it) has no key field. **Sign in with ChatGPT**
  shows a code and a link to the sign-in page, and polls until the sign-in completes
  or the code expires. Start without a sign-in shows "Sign in with ChatGPT in Agent setup".
- The model list comes from `GET /v1/models` (`GET /codex/models` for the ChatGPT plan); the model and reasoning controls are
  session settings, and the chosen model is saved to `agentACP.oxbit.model`.
- Tools: list, search, read, write and edit files, `find_files` (quick-open path matching,
  where the folder supports it), diagnostics, a plan, and `task`, which runs a subagent with a
  fresh context (see [Dispatched subagents](#dispatched-subagents)).
  Writes and edits, including a subagent's, open the same review card as other agents.
  There is no shell, and the system prompt tells the model so. `diagnostics` returns a reason
  when no language service runs in the workspace, or when no file is open and no path is given.
- `agentACP.oxbit.instructions` adds instructions to every in-app session, after the workspace's
  AGENTS.md and CLAUDE.md files.
- From the second prompt on, the model gets the last request's token count, the context window
  and the auto-compaction threshold in a `<context-usage>` note at the end of the prompt. Replays
  of a saved conversation leave the note out.
- Commands and settings are listed under [In-app commands and sessions](#in-app-commands-and-sessions).
- **Attach changes** sends `git.status` and `git.diff` to the device folder's Git client.
  `@` commits use `git.log`, `git.show` and `git.commitDiff` from the same client.
- The registry, runtime sessions, checkpoints and `@` **Branch diff** need a runtime workspace.
- API details: [Model APIs for the built-in Oxbit agent](agent-model-apis.md).
  Keychain and request handling on iOS: [In-app agent on iOS](ios.md#in-app-agent-on-ios).
- Checks: `local/*.test.ts`, `tests/browser/agent-acp-local.spec.ts` (a turn with a
  file write through a scripted model), `tests/ios/agent-models.spec.ts`, and
  `scripts/oxbit-agent-smoke.ts` against a local Ollama for all three APIs and against
  OpenRouter for `openai-compatible`. On 2026-10-11 one turn ran in the iOS 26.5
  simulator through the Swift `AgentModels` path (OpenRouter, `openai/gpt-oss-20b`): Keychain
  save and `has` after relaunch, three URLSession requests answered 200, and base URLs and
  paths outside the endpoint rejected. No physical device run yet.

#### In-app commands and sessions

Added 2026-10-12. `local/extensions.ts` gives the in-app agent the `@oxbit/agent-core`
extensions that need no process or network access beyond the model API. The composer's
slash menu lists them from `available_commands_update`:

| Command | Does |
| --- | --- |
| `/compact [focus]` | Summarizes older turns. Auto-compaction uses the same summary. |
| `/context` | Shows context window usage. |
| `/goal` | Sets a goal the agent works toward across turns, or shows, pauses, resumes or clears it. |
| `/loop [30s\|5m\|1h] <prompt>` | Runs a prompt again on an interval, or when the model schedules the next run; `/loop stop` ends it. |
| `/config [setting value]` | Lists or sets `mode`, `auto-compact` (on, off) and `compact-at` (default, 50 to 90). |
| `/skills`, `/<skill> [args]` | Lists skills and runs one. |
| `/undo` | The panel undoes the applied edits of the latest turn that has any, newest first, through the review card's undo. Run it again for the turn before. Created files stay; review them in Source Control. |

- Instructions come from `AGENTS.override.md`, `AGENTS.md` and `CLAUDE.md` in the workspace
  folder. Skills come from `.agents/skills/<name>/SKILL.md` and `.claude/skills/<name>/SKILL.md`
  in the same folder. Both are read through the workspace `FileSystem`, so parent folders and
  the user's home folder are not read.
- The in-app agent runs in the app and has no process to exit. When the app reloads with an
  in-app conversation open, for example after iOS ends the web view process, the panel starts
  the agent again, loads that conversation and shows "The app reloaded. The agent restarted and
  loaded this conversation." A conversation that does not load stays read-only.
- Auto-compaction follows `agentACP.oxbit.autoCompact` (default on) and `agentACP.oxbit.compactAt`.
  The session controls **Auto-compact** and **Compact at** and `/config` change the same settings.
  It runs when the model has a known context window: from the model list (`max_input_tokens`,
  `context_length` or `context_window`, and 272,000 tokens for the ChatGPT plan), then the built-in
  table of current OpenAI and Anthropic models. When the OpenAI or Anthropic model list fails to load,
  the built-in table supplies the models.
- Sessions are saved in the workbench's host storage (`ui.json` per workspace on iOS) under
  `oxbit-agent-session:<folder id>:<session id>`, with an index under
  `oxbit-agent-sessions:<folder id>`. A workspace keeps its 16 newest sessions. A session over
  2 MiB of JSON drops old tool outputs; when it is still too large the turn ends with
  "The session was not saved" and `/compact` makes it fit. The agent advertises `loadSession` and `sessionCapabilities.list`, so
  **Find provider conversations** lists saved sessions and **Open conversation** replays one
  after the app relaunches.
- A model request that fails before any of its output streamed is retried 4 times, 1, 2, 4 and
  8 s apart, for HTTP 408, 409, 429 and 5xx other than 501 and 505, overloaded or rate limit
  messages, and network failures. Quota errors are not retried. Each retry adds a line to the
  reply. Stop ends the wait. The iOS `AgentModels` error has no headers, so iOS waits the
  backoff in place of `Retry-After`.
- A failed or stopped turn pauses the queue. Sending a message resumes it.

Not in the app, and why:

- Command hooks, stdio MCP servers and `bash` start processes, and the app has no process API.
- HTTP MCP servers: the iOS content security policy limits `connect-src` to the app, IPC and
  the push relay, and model requests go through the Swift plugin.
- `/redo` needs the snapshot store that `oxbit-agent` keeps under its agent home.
- `/new` and `/resume` are terminal commands of `oxbit-agent`; the panel's **New conversation**
  and **History** do the same.

Runtime workspaces, including iOS workspaces on a LAN or SSH runtime, offer Oxbit Agent CLI. It
runs on the runtime with command hooks, MCP servers, `bash` and `/undo`.

### ACP Registry agents

The runtime fetches the registry when **More agents…** opens, when the chosen
agent is a registry agent, or when a registry agent starts. It caches the listing in its data directory for 5 minutes. When a
fetch fails, the cached listing is shown with the error.

- `npx` and `uvx` agents run `npx -y <package>` or `uvx <package>` with the
  registry's arguments and environment.
- Binary agents download once per version into `<dataDir>/acp-agents/<id>/<version>`.
  The runtime requires the registry's SHA-256 checksum, rejects archives over
  512 MiB, extracts `.tar.gz`, `.tgz`, `.tar.bz2`, `.tar.xz` and `.zip` with the
  system `tar` or `unzip`, and launches the command only if it resolves inside the
  install directory.

Agents inherit the runtime environment and existing CLI credentials. Supply API
keys or `AMP_CLI_PATH` through that environment; the extension has no credential
fields. After a session reports an authentication error, use an advertised sign-in
button or sign in using the provider CLI, then retry the conversation.

### Threads

Several agents run on the runtime at once, from the same provider or different
ones. **New thread** in **More agent actions**, or **+** in the thread strip,
saves the conversation to History, releases the panel from its agent with
`acp.detach`, and shows the agent picker. The released agent keeps its running
turn. **New thread** asks you to resolve pending requests, run or remove queued
messages, and wait for active subagents first.

The thread strip at the top of the panel shows one chip per live agent when the
runtime has two or more, or when the panel has no agent and one still runs. A
chip shows the title, the state (**Working…**, **Needs input (n)** or **Ready**)
and the agent name. The shown thread's chip has `aria-current`. Selecting another
chip attaches the panel to that agent and replays its recent timeline. On phones
the strip scrolls horizontally and its controls are 44 px tall.

The runtime sends no event when its agent list changes. The panel calls
`acp.list` every 4 seconds while it is visible or other threads run, and when it
gains focus. The Agent button count includes pending requests from other threads.

Each chip has a stop button. After confirmation it calls `acp.stop`; the runtime
owner can stop any of its agents without attaching first. Stopping the shown
thread works like **Disconnect**. A released thread with no work is detached, so
at the 3-agent device limit starting another agent stops the oldest such thread. When
every agent has work, the start fails with the runtime's message, the status
reads **Agent limit reached**, and the strip lists the threads to stop.

Runtimes from 0.7.1 and earlier lack `acp.detach` and accept `acp.stop` only for
an attached agent. With those runtimes a released thread stays bound to the
window until another thread opens, and a chip's stop button fails until that
thread is opened.

## Composer

- **Enter** sends and **Shift+Enter** adds a new line. With
  `agentACP.useModifierToSend`, Enter adds a new line and **Ctrl/Cmd+Enter** sends.
  On touch screens the Return key adds a new line and the send button sends.
  Ctrl/Cmd+Enter sends in every mode. **Escape** stops the running turn.
- Type `@` to mention a workspace file, the selection, the active file's diagnostics,
  or **Changes**. A file is attached as a snapshot. **Changes** (also in **Add context**)
  attaches the staged and unstaged diff of up to 50 changed files, with untracked
  files in full, up to 200,000 characters.
- After two characters, `@` also lists up to 10 workspace symbols from running
  language servers that support `workspace/symbol`. A symbol is attached as the
  lines of its range, like a selection.
- `@` also lists up to 5 saved conversations whose title contains the text after
  `@`, from the connected workspace root, without the open conversation. Choosing
  one attaches its user and agent messages as **Thread: <title>**, without thoughts
  or tool calls, keeping the latest 200,000 characters.
- `@` **Branch diff** attaches **Branch diff: <base>...<head>**: the committed, staged,
  unstaged and untracked changes since the merge base of `HEAD` and the base branch,
  up to 50 files and 200,000 characters. The base is the upstream remote's default
  branch (`refs/remotes/<remote>/HEAD`), then `origin/HEAD`, then `main`, then `master`.
  The item is hidden after `git.branchDiff` fails with `METHOD_NOT_FOUND` (an older
  runtime) or "needs a runtime workspace" (the in-app Oxbit Agent). The panel asks once,
  with `{ limit: 0 }`, when `@` first opens the list.
- `@` also lists up to 5 of the latest 100 commits whose subject or author contains the
  text after `@`, or whose hash starts with it. Choosing one attaches
  **Commit <short hash>: <subject>** with the message and the diff of up to 50 files,
  up to 200,000 characters.
- `@` also lists up to 5 folders above the matched files. Choosing one inserts
  `@<folder>/` and attaches **Folder: <path>**: up to 500 file paths, then the text of
  each file that fits in 200,000 characters. Binary files, `.git` and `node_modules`
  are skipped.
- Paste, drop or attach up to 4 PNG, JPEG, GIF or WebP images (5 MB each) when
  the agent advertises image prompts. An image over about 165 KB is scaled down
  and re-encoded as WebP or JPEG so the message fits the 2 MiB request limit.
- **/** opens the agent's slash commands. Messages sent during a turn are queued
  and can be edited, removed or moved. **Send queued message now** stops the running
  turn and sends that message next. **Move queued message up** and **down**, or
  Alt+Up and Alt+Down while one of a queued message's buttons has focus, change
  the order in which queued messages run.
- **Dictate** (the microphone button) appends speech to the draft as you talk.
  Select it again to finish. Editing or sending the draft stops dictation. See
  [Dictation](#dictation).
- Tool calls show an icon for their kind and their status. A **Working** row
  shows the elapsed time of the current turn.
- When the agent reports context usage, a ring below the composer shows the
  percent of the context window in use, with token counts. It turns to the
  warning color from 85%. Permission requests that edit
  files show the proposed diff.

## Attention and placement

- On desktop the panel opens in the right dock in new layouts. On phones,
  **Agent** has its own tab in the bottom bar.
- The Agent button shows a count while requests in any thread wait for an answer, and a dot
  when a turn ends while the panel is hidden. The status bar shows the agent
  state; selecting it opens the panel.
- When a turn ends or a request arrives while the panel is hidden, a toast
  offers **Open Agent**. When Oxbit's window is hidden or, with a mouse, another
  app has focus, Oxbit also shows a system notification once permission is granted.
  On a touch screen only a hidden window counts, because the phone web view can lose
  focus while it is on screen. Use
  **Enable notifications** in **More agent actions** to grant it. Set
  `agentACP.notifications` to `never` to turn system notifications off.
- Applying an agent edit opens the file in the editor when the panel sits beside it.
  Below 1100px the panel covers the editor, so it stays open and the file only refreshes.

### System notifications

Checked 2026-10-10 against `tauri-plugin-notification` 2.4.0
([plugin guide](https://v2.tauri.app/plugin/notification/),
[crate](https://crates.io/crates/tauri-plugin-notification/2.4.0)) and Apple's
[UNUserNotificationCenterDelegate](https://developer.apple.com/documentation/usernotifications/unusernotificationcenterdelegate).

- The bundled macOS app posts through `UNUserNotificationCenter`
  (`apps/desktop/src-tauri/src/notifications.rs`, `objc2-user-notifications` `=0.3.2`)
  and is the center's delegate. `installNotifications`
  (`packages/host-desktop/src/notifications.ts`) installs the `Notification` the
  panel uses. Selecting a notification opens the agent panel in the window that
  posted it; a selection that launches Oxbit runs `agentACP.open` once the workspace loads.
- Builds without a bundle id (`bun run desktop:dev`, the WDIO debug binary) register
  `tauri-plugin-notification` `=2.4.0` instead. Versions 2.5.0 and later require
  `tauri` 2.12; Oxbit pins `tauri` 2.11.5. The plugin reports no actions, so
  selecting its notification does nothing.
- `tests/desktop/agent.e2e.mjs` checks the plugin path in the debug binary and the
  native path in a bundled app. On 2026-10-11 `usernoted` logged the bundled test
  app's notifications as delivered with authorization denied, so no banner showed
  and the selection handler has not run.
- The iOS app does not use the plugin: its 2.4.0 iOS code force-unwraps an
  in-memory map when a notification is tapped, so a tap after iOS terminated the
  app crashes it ([plugins-workspace#3533](https://github.com/tauri-apps/plugins-workspace/issues/3533)),
  and a tap that launches the app reaches no listener
  ([#3534](https://github.com/tauri-apps/plugins-workspace/issues/3534)).
- In the iOS app `installNotifications` (`packages/host-ios/src/notifications.ts`)
  installs a `Notification` that posts through the oxbit-files plugin
  (`Notifications.swift`). Permission starts at "default" until **Enable
  notifications** asks, and refreshes when the app returns to the foreground.
- `Notifications.swift` becomes the notification center's delegate when the
  plugin loads, before launch finishes, so iOS also hands it the tap that
  launched the app. It keeps that tap until a workspace subscribes. Each
  workspace session runs `agentACP.open` on a tap when Agent ACP is enabled
  there; `tests/ios/ssh-runtime.spec.ts` covers a tap that relaunched the app and
  a later tap.
- iOS suspends the app shortly after it leaves the foreground. Turns that end
  while it is suspended arrive as push notifications (see below).

### Push to a suspended phone

Added 2026-10-11. Built and unit tested; push delivery has not run on a device
because the relay has no APNs key yet.

- The iOS app registers for remote notifications and for a Live Activity push
  token, sends each token to the relay's `POST /v1/devices`, and passes the
  returned handles to the runtime with `push.register` on every connection. It
  reports `push.state` with `active: false` when it leaves the foreground.
- The runtime (`apps/runtime/src/push.ts`) keeps up to 16 devices in
  `push-devices.json` for 30 days. Each device belongs to the session that
  registered it. When that session's agent finishes, fails or needs input while
  the device is inactive or disconnected, the runtime sends an alert, and it
  updates or ends the Live Activity, through `POST /v1/push`.
- The relay (`apps/push-relay`, Cloudflare Worker `oxbit-push`) seals tokens into
  AES-GCM handles and holds the APNs key. Pushes use the collapse id
  `oxbit-agent-acp`. A gone token answers `{gone: true}` and the runtime drops it;
  without the APNs secrets the relay answers 503 `RelayNotConfigured`.
- On 2026-10-11 the chain ran in the iOS 26.5 simulator with a sandbox APNs key and a
  `wrangler dev --remote` relay. A turn that ended while Oxbit was suspended showed a
  banner that opened the Agent panel, and the 128-byte Live Activity token ended the
  activity as **Finished**. A device needs the production key in the deployed relay.
- Runtimes without `push.*` answer `METHOD_NOT_FOUND`; the app then skips push
  for that connection. `OXBIT_PUSH_RELAY` points the runtime at another relay.
- Apple references: [registering with APNs](https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns),
  [sending requests](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns),
  [token-based connection](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns),
  [APNs responses](https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns),
  [Live Activity push](https://developer.apple.com/documentation/activitykit/starting-and-updating-live-activities-with-activitykit-push-notifications).
  Relay secrets and deploy: `apps/push-relay/README.md`.

### Live Activity

Added 2026-10-10.

- In the iOS app a connected agent thread shows a Live Activity on the Lock Screen
  and in the Dynamic Island: **Working** with the elapsed time and the latest tool
  call, **Needs input** with the number of waiting requests, then **Finished** or
  **Failed**. A finished or failed activity is dismissed 15 minutes after the turn
  ends. Disconnecting the thread, disabling Agent ACP or closing the workspace ends
  it at once.
- The app updates the activity itself and re-sends a working or waiting state
  every 5 minutes while it runs. Once iOS suspends Oxbit, the activity keeps its
  last state and shows **Open Oxbit to refresh** 15 minutes after the last update.
  While suspended, the runtime updates it through the push relay.
- The `OxbitLiveActivity` widget extension (`com.yannelli.oxbit.LiveActivity`)
  draws the activity; `docs/release.md` covers its signing profile.
- The panel calls the `agentActivity` kernel service (`AGENT_ACTIVITY_SERVICE` in
  `@oxbit/sdk`) on each state change. The iOS app registers it per workspace
  (`apps/ios/src/main.tsx`); other hosts register none, so nothing is sent.
- On 2026-10-10 the widget ran in the iOS 26.5 simulator on an iPhone 17 Pro. The
  compact timer shrinks to fit past one hour, the expanded view moves the agent
  name below the title when it does not fit, and a stale activity has a gray
  outline. The Lock Screen layout was checked with `ImageRenderer` on 2026-10-10 and
  on a locked simulator through XCUITest on 2026-10-11.

### Dictation

Checked 2026-10-10.

- The composer uses the Web Speech API: `SpeechRecognition`, or
  `webkitSpeechRecognition` when only the prefixed constructor exists
  ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition),
  modified 2026-08-19). It sets `continuous` and `interimResults` and uses
  `navigator.language`. The button is hidden when the WebView has neither constructor.
- The macOS app's WebView exposes `webkitSpeechRecognition`
  (`tests/desktop/agent.e2e.mjs`). WebKit's recognizer uses Apple's Speech framework
  ([WebKit bug 239816](https://bugs.webkit.org/show_bug.cgi?id=239816)), so the app
  declares `NSMicrophoneUsageDescription`, `NSSpeechRecognitionUsageDescription` and
  the hardened-runtime entitlement `com.apple.security.device.audio-input`. Starting
  dictation in the macOS app needs a person to answer the permission prompts and has
  not been run.
- The iOS app defines `SpeechRecognition` on top of Apple's Speech framework
  (`packages/host-ios/src/speech.ts`, `apps/ios/plugins/oxbit-files/ios/Sources/Dictation.swift`).
  It recognizes on the device when the recognizer supports that, and declares the
  same two usage descriptions. On 2026-10-11 the iOS 26.5 simulator granted both
  permissions, its recognizer failed to start, and the composer showed "Dictation
  failed: Failed to initialize recognizer". Recognition has not run on a device.
- MDN states that Chrome sends the audio to a web service for recognition, so
  dictation in Chrome does not work offline.

## In-app tools

- A chronological conversation with Markdown, code blocks, tables, file links,
  copy actions, and collapsible thinking. Tool calls keep their position between
  messages as their status changes. Scroll up without losing your place; use
  **Jump to latest** to return. Pending input has a visible shortcut to its controls.
- **Attach file** and **Attach selection** include a snapshot of current editor
  text, including unsaved changes. Attachments can be removed before sending.
- **Add context** browses workspace files without changing the active editor.
  Every attachment has an expandable snapshot, character count, and, for
  selections, line range. **Attach diagnostics** includes the active file's
  current language diagnostics. Providers supporting embedded context receive
  separate ACP resources with file URIs; other providers receive separate text
  blocks. Snapshots remain the version you attached, even if you keep editing.
- Provider-advertised modes, models, configuration options, and slash commands.
  Session settings have visible labels and preserve the provider's ordering.
  When configuration options are advertised, they replace the legacy mode/model
  selectors. Changes wait for confirmation and update dependent options together;
  rejected changes retain the last confirmed values.
- ACP permission requests with the provider's actual choices; no automatic
  approval. Cursor questions and plan approvals are also handled in the panel.
- ACP file reads see open editor buffers. Writes through the client filesystem
  API are held for review with a unified diff, Apply, and Reject. **Review in
  editor** opens the proposal in the main work area; both surfaces share the
  same approval and expire together. Large changes offer complete snapshots
  instead of blocking the UI while computing an expensive diff.
  Dirty documents are protected; changes made while a review is open require a
  fresh read and proposal. Disk saves check the original file revision.
  Apply and Undo save the reviewed snapshot exactly, bypassing formatting hooks;
  ordinary editor saves retain their configured hooks.
- With two or more file changes pending, **Apply all** and **Reject all** sit above
  the reviews. Apply all applies each change in order with the same checks as
  **Apply change**. It stops at the first change that fails, shows its error and
  leaves the rest pending. Reject all sends each change the same answer as **Reject**.
- **Reviewed agent edits** records client-API edits for the current conversation.
  **Undo this edit** restores an existing file only when its buffer and disk
  still match the applied edit. Undo is unavailable during agent work or pending
  approvals. New files and files changed again belong in Source Control review.
  With two or more edits to undo, **Undo all** undoes them newest first through
  Undo this edit and stops at the first edit it cannot undo.
- Tool file locations open in the editor. **Review changes** opens source control.
- Agent terminal commands run in the workspace, show bounded output, and support
  output, wait, kill, and release through ACP.
- **Stop** cancels the parent turn and clears its pending approvals. Child requests
  remain attributed to their sessions until those sessions finish or disconnect.
  **Disconnect** ends the conversation. Disabling the extension, revoking trust,
  or closing the runtime terminates owned agent and terminal processes.
  Late responses from an ended connection cannot change a newer conversation.
  Failed prompts leave the panel ready for another message, with the error shown.

## Runtime hosting and native tools

The runtime hosts agents for desktop and browser clients. Desktop bundles the
runtime; a browser connects to a running daemon. An agent continues through a
client WebSocket drop. Reattach from **Runtime sessions** to recover its recent
timeline, queued messages, and pending approval. Replayed events are bounded to
2,000 entries and 2 MiB. The daemon has one editor controller per agent; runtime
owner authentication keeps other workspace clients from attaching or calling
agent tools. A running agent ends when it is explicitly disconnected, the
extension is disabled, workspace trust is revoked, or the runtime shuts down.
Each paired device runs at most 3 agents. At that limit, starting an agent stops
the oldest detached agent with no running turn, pending request, or queued
message. When every agent is attached or has work, the start fails and names
**Runtime sessions** as the place to stop one.
Running processes and pending reviews do not survive runtime shutdown. Saved
provider history remains available through the provider's resume support.

When the agent advertises HTTP MCP support, Oxbit passes a local authenticated
MCP server at session creation. Otherwise it passes a Node stdio proxy to the
same server. The runtime binds the MCP endpoint to localhost and issues a
per-agent bearer secret. Both transports expose:

| Tool | Behavior |
| --- | --- |
| `oxbit_get_workspace` | Return workspace context, active editor, and selection when attached. |
| `oxbit_list_files` | List a directory within the runtime workspace. |
| `oxbit_read_file` | Read bounded lines from an unsaved editor buffer while attached, or from disk while detached. |
| `oxbit_get_diagnostics` | Read live editor diagnostics; headless sessions need an attached editor. |
| `oxbit_open_file` | Open a file and optional line in the attached editor. |
| `oxbit_propose_edit` | Submit replacement content and wait for engineer review. |
| `oxbit_update_plan` | Publish up to 50 plan entries. |

Paths are workspace relative or absolute within the workspace. The runtime
validates their workspace boundary. File review and permission requests wait for
the next attach if the controller drops. Tools that require an editor report
that requirement while headless. Clients declare editor tool support with
`clientCapabilities: { editorTools: true }` on `acp.start` and `acp.attach`.
While an attached client has not declared it, `oxbit_get_workspace`,
`oxbit_get_diagnostics`, and `oxbit_open_file` return a tool error that asks the
user to update Oxbit. MCP tools use the agent's existing permission
policy; the Oxbit review applies to proposed edits through the Oxbit client.

Messages sent during a turn enter a queue of at most 16 messages and 1 MiB.
They run in order after a successful turn. A stopped or failed turn pauses the
queue. **Interrupt and send** cancels the current turn and sends the correction
after cancellation is acknowledged. `acp.moveQueued {id, promptId, index}` moves a
message that has not started to `index`, clamped to the queue, and publishes
`acp.queue`; a message that started or was removed is rejected. The runtime and
the Oxbit Agent both serve it. A runtime from before this method answers
`METHOD_NOT_FOUND`; the panel then shows the error once and hides the move
buttons for that connection. Providers report plans and token usage only
when they expose those events.

Agents execute with the trusted runtime user's privileges. The workspace path
checks apply to Oxbit's ACP filesystem and terminal working-directory APIs;
they are not a process sandbox. An agent's own tools can edit files or execute
commands independently, according to that agent's permission policy. The review
UI applies to writes requested through Oxbit's ACP client API.

## Dispatched subagents

**Subagents** inside the conversation and **Agent ACP: Open Agents** in the command
palette show the same agent tree. The dedicated **Agents** activity view is
registered only while Agent ACP is enabled. It follows the selected conversation;
it does not launch additional agents. Select a child to inspect its task, reported
model, latest observed activity, available messages/tools, and returned result.
Delegation entries in the parent timeline open the corresponding child.

Arrow keys navigate the tree; Right/Left expand and collapse children, Home/End
move to its ends, and Enter/Space select. Selection and expansion are shared by
both surfaces. Requests expand their ancestor path without stealing focus.

| Adapter | Tracking available |
| --- | --- |
| Codex ACP 1.10.0 | Negotiated native child sessions, nested descendants, child messages/thinking/tools, lifecycle outcomes, and reopened generations; structured collaboration metadata is retained as a fallback. |
| Cursor ACP | `cursor/task` metadata correlated with tool calls, including agent identity, task, model, duration, returned output, and explicit outcomes when provided. |
| Amp ACP 0.9.0 | Adapter-specific `Task` tool recognition, task inputs, tool status and returned output. |
| Oxbit Agent (in-app) and Oxbit Agent CLI | `task` tool calls with `_meta.oxbit.subagent`, negotiated native child sessions with child messages, tools and requests, and lifecycle outcomes. Up to 4 subagents run at once; subagents do not start their own. See [Subagents](oxbit-agent.md#subagents). |

The UI distinguishes native child events, provider metadata, and delegation-tool
observations. Cursor and Amp usually provide **Limited visibility**: tool
completion or receiving a task notification alone never confirms that a background
child finished. Unreported state stays **Unknown**. Silence never indicates a
failure, and no synthetic heartbeat is displayed.

Lifecycle states are pending, running, completed, failed, cancelled, disconnected,
and unknown. Thinking, executing tools, responding, and awaiting input are separate
activity phases derived from events. The counts of active children come from live
lifecycle tracking, not saved transcript previews.

Child filesystem requests, permissions, questions, and terminals retain session
identity and use the existing review workflow. Reviews identify the requesting
child, including in the main editor. Concurrent proposals for the same file still
check the shared document version and disk revision. Terminals cannot be accessed
by sibling sessions. Only children registered by a known parent receive access to
client APIs; tool-derived identities never grant access.

The parent may finish while its children are running or waiting for approval.
Their tracking and requests remain active. New/Read/Resume wait for confirmed
active children and pending requests; **Disconnect** remains available. The Stop
command disconnects when only children are active. Cancellation is only reported
as successful when the provider confirms it; a lost provider connection is shown as
disconnected. Unresponsive cancellation remains bounded by the runtime timeout.

History saves bounded child summaries and activity with each conversation. Old
history records without children remain compatible. **Historical** rows never
claim to be live. Resume reconciles the provider replay with existing records and
preserves the draft without dispatching children or replaying prompts.

Display retention is capped at 256 children and 32 activity entries per child,
with a shared 512,000-character serialized activity budget. Saved child previews
use at most approximately 750,000 serialized characters inside the existing
4 MiB conversation-history budget. Truncation is visible. Live native-session
registration and fallback lifecycle tracking are separate from display pruning;
each is capped at 1,024 identities per connection/conversation. Unknown-session
updates have a small bounded buffer and never authorize requests.

This feature observes provider dispatch. It does not install provider hooks,
monitor externally launched agents, provide manual dispatch, or expose individual
child messaging/cancellation controls. Adapter defaults remain pinned. The
subagent mapping references below describe the releases tested when that
tracking was added; current defaults require their own live provider checks.

Adapter references:
[Codex child-session interfaces](https://github.com/agentclientprotocol/codex-acp/blob/v1.10.0/src/subagents/AcpSubagents.ts),
[Codex collaboration mappings](https://github.com/agentclientprotocol/codex-acp/blob/v1.10.0/src/CodexToolCallMapper.ts),
[Cursor ACP extensions](https://cursor.com/docs/cli/acp), and
[Amp tool mapping](https://github.com/tao12345666333/amp-acp/blob/v0.9.0/src/to-acp.ts).

## Conversation history

**New conversation** starts a separate session without restarting the adapter.
**History** searches locally saved conversations by title, provider, or transcript.
Drafts and attached snapshots are saved with their conversation. **Read** opens a
saved transcript without launching an agent. **Resume** explicitly reconnects and
loads the provider session when supported. Loading replaces the local preview with
the provider's replay, retaining the unsent draft; agents supporting only resume
keep the local preview. Unsupported providers show an explanation and still allow
reading local history. Prompts are never automatically resent after a failure.

When an agent process exits, times out or breaks the protocol, the runtime marks `acp.exit`
`unexpected`. If the agent advertised `loadSession`, the panel starts it again and loads the
open conversation, at most 3 times a minute. A prompt that was running and is missing from
the replay returns to an empty composer.

For providers advertising session discovery, **Find provider conversations** lists
sessions for the current runtime workspace, with pagination. Opening a known
session reuses its local draft. Agent-provided conversation titles stay in sync.
Capabilities are checked in the runtime, including calls made outside the UI.

History uses the host's local persistence, scoped to the workspace. It retains up
to 30 conversations within an approximate 4 MiB budget. Long previews are visibly
marked as trimmed; loading can recover the provider history. Transcript, draft,
and context snapshots are persisted; permissions, terminal processes, and undo
handles are not. **Forget** removes local history and does not delete the provider
session. Enabling the extension or opening history does not launch an agent.

Markdown never executes HTML or loads remote images. Relative file links open
inside the workspace; external HTTP(S) links open only when clicked. Multimodal
attachments and arbitrary MCP server configuration remain outside this extension.

### Checkpoints

When the workspace root is the root of a git work tree, each user message stores a
checkpoint: a git tree of the workspace files taken before the prompt is sent. The
runtime copies the real index (`git rev-parse --git-path index`, which resolves
linked worktrees whose `.git` is a file) to a temporary file, runs `git add -A` and
`git write-tree` against the copy, and deletes it. Ignored files are not in the
tree. If creation fails or takes longer than 5 seconds, the message still sends
without a checkpoint. Queued messages are captured when the runtime starts their
turn, after the prompt reaches the agent. Outside a repository, or when the
workspace root is a subdirectory of one, no checkpoints are taken and the action is
hidden.

**Restore checkpoint** appears on a user message whose checkpoint differs from the
current files. Restore is refused while the agent is working or has pending
requests, and when a file it would change has unsaved editor edits. The runtime
computes the current tree the same way, compares it with `git diff-tree -r`, writes
the changed paths from the checkpoint through a temporary index (`git read-tree`,
then `git checkout-index -f`), and deletes paths that exist now and are absent from
the checkpoint. Ignored files, the real index, `HEAD`, and refs are unchanged;
submodule entries are skipped. A note in the conversation names the message the
files were restored to. The agent's context is unchanged: it keeps the later turns
and is not told about the restore.

Checkpoint trees are saved on user messages in history, so restore works after a
reload. Loading a provider session matches replayed user messages to saved ones by
text; attaching a live session replays messages without checkpoints. Checkpoints
write git objects and no refs. Unreferenced objects follow git's `gc.pruneExpire`
window (two weeks by default), after which `git gc` deletes them and restore
reports that the checkpoint is no longer available.

**Message actions** (the **…** button on a user message) offers **Fork from here**:
it starts a new conversation with the same agent, attaches the earlier messages as
**Thread: <title>** (the forked message excluded) and puts that message's text in the
draft. On a message with a checkpoint, **Restore files and fork** restores the
checkpoint first, then forks; the fork starts with the restore note. The original
conversation stays in history unchanged. Forking needs a connected agent and is
refused while the agent is working or has pending requests or queued messages.

**Fork conversation** in **More agent actions** forks the agent session itself when
the agent advertises the unstable ACP `session/fork`
(`agentCapabilities.sessionCapabilities.fork`). The runtime sends
`session/fork` `{ sessionId, cwd }` for the current session; the agent returns a new
session that keeps the whole context. The panel copies the transcript into a new
conversation and adds the note "Forked from “<title>”". The original conversation
stays in history. The Oxbit Agent forks by copying its turns. Agents without the
capability do not show the item, and a runtime older than this feature answers
"Update the runtime to fork conversations". ACP forks the whole session, so forking
from an earlier message still uses **Fork from here**. Schema checked 2026-10-11 at
[schema.unstable.json](https://raw.githubusercontent.com/agentclientprotocol/agent-client-protocol/main/schema/v1/schema.unstable.json).

Checked 2026-10-11: Claude Agent ACP 0.55.0, Codex ACP 1.10.0 and OpenCode 1.18.18
advertise `fork` in `initialize`. OpenCode 1.18.18 with Ollama `qwen3:0.6b` forked
through the panel on desktop Chrome and the phone profile, and the fork answered
with a word that only the original session had seen. The fork with Claude Agent
and Codex has not run, because it needs their accounts.

Runtime methods: `acp.checkpoint.create` `{}` returns `{ tree }` or
`{ unavailable }`; `acp.checkpoint.diff` `{ tree }` returns the current `tree` and
the changed paths; `acp.checkpoint.restore` `{ tree, paths }` restores and refuses
when files outside `paths` changed since the diff.

`git.branchDiff` `{ limit? }` (0 to 50 files, default 50) returns
`{ base, head, files: [{ path, diff, binary }], truncated }` or `{ repository: false }`.
`diff` is empty for a file whose diff exceeds the 2 MiB output limit. It fails with
`NOT_FOUND` when `HEAD` has no commits, no base branch exists, or the histories share no
commit.

## Protocol references

Agent ACP uses the protocol's [session lifecycle](https://agentclientprotocol.com/protocol/v1/session-setup), [session discovery](https://agentclientprotocol.com/protocol/v1/session-list), and [content](https://agentclientprotocol.com/protocol/v1/content) contracts. The native tool server follows [MCP Streamable HTTP and stdio transport rules](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports). Adapter defaults are checked against the [Codex ACP package](https://registry.npmjs.org/@agentclientprotocol%2Fcodex-acp/2.2.2) and [Amp ACP package](https://registry.npmjs.org/amp-acp/0.10.0).

Design references: [Zed's agent panel](https://zed.dev/docs/ai/agent-panel) documents queues, context, and review; [VS Code sessions](https://code.visualstudio.com/docs/agents/run/sessions/manage-sessions) document session recovery and context usage; [OpenCode web](https://docs.opencode.ai/docs/web/) documents shared browser and terminal sessions; [Paseo CLI](https://github.com/getpaseo/paseo/blob/main/public-docs/cli.md) documents daemon-managed agents; [Oh My Pi RPC](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md) documents headless client integration. Oxbit's provider behavior depends on each advertised ACP capability.

## Verification

Focused runtime and editor tests:

```sh
bunx vitest run apps/runtime/tests/agent-acp.test.ts apps/runtime/tests/acp-registry.test.ts apps/runtime/tests/agent-mcp.test.ts apps/runtime/tests/acp-subagents.test.ts apps/runtime/tests/acp-subagents-integration.test.ts apps/runtime/tests/acp-checkpoints.test.ts apps/runtime/tests/git-branch-diff.test.ts packages/features/agent-acp/src
```

Browser journeys (after `bun run build`):

```sh
bunx playwright test tests/browser/agent-acp*.spec.ts --reporter=list
```

macOS app checks for system notifications and speech recognition:

```sh
bun run desktop:test:build
bunx wdio run tests/desktop/agent.conf.mjs
```

The deterministic fixture speaks ACP over real stdio and exercises streaming,
permission responses, file edits, terminals, cancellation, and failure handling
without contacting a model provider. Live provider authentication, model prompts,
and billing require separate checks.
