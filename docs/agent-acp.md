# Agent ACP

Created: 2026-10-10. Last updated: 2026-10-10.

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

A new conversation shows an agent picker. Choose an agent and select **Start**,
or type a message and send it: the panel starts the chosen agent and sends the
message once the session is ready. The choice is saved as `agentACP.provider`.

- **Built-in agents** are listed below.
- **More agents…** browses the [ACP Registry](https://agentclientprotocol.com/get-started/registry)
  through the runtime, with search by name, ID or description. Agents the runtime cannot
  launch stay listed with the reason: no build for its platform, no published checksum,
  or an archive format Oxbit cannot extract.
- **Custom agent…** runs any ACP executable. Enter the name, executable, and
  arguments as a shell-style line; quotes group words. They are saved as
  `agentACP.custom.name`, `agentACP.custom.command`, and `agentACP.custom.args`.

Runtimes before 0.8.0 accept only Codex, Cursor and Amp. Starting another agent on
such a runtime shows "This runtime does not support … Update Oxbit on the runtime host."

## Providers

| Provider | Default executable and arguments | Setup |
| --- | --- | --- |
| Codex ACP | `npx -y @agentclientprotocol/codex-acp@2.2.2` | Existing Codex credentials, or an advertised sign-in method |
| Claude Agent | `npx -y @agentclientprotocol/claude-agent-acp@0.89.1` | Existing Claude Code sign-in |
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

## Composer

- **Enter** sends and **Shift+Enter** adds a new line. With
  `agentACP.useModifierToSend`, Enter adds a new line and **Ctrl/Cmd+Enter** sends.
  On touch screens the Return key adds a new line and the send button sends.
  Ctrl/Cmd+Enter sends in every mode. **Escape** stops the running turn.
- Type `@` to mention a workspace file. The file is attached as a snapshot.
- Paste, drop or attach up to 4 PNG, JPEG, GIF or WebP images (5 MB each) when
  the agent advertises image prompts. An image over about 165 KB is scaled down
  and re-encoded as WebP or JPEG so the message fits the 2 MiB request limit.
- **/** opens the agent's slash commands. Messages sent during a turn are queued
  and can be edited or removed.
- Tool calls show an icon for their kind and their status. A **Working** row
  shows the elapsed time of the current turn. Permission requests that edit
  files show the proposed diff.

## Attention and placement

- On desktop the panel opens in the right dock in new layouts. On phones,
  **Agent** has its own tab in the bottom bar.
- The Agent button shows a count while requests wait for an answer, and a dot
  when a turn ends while the panel is hidden. The status bar shows the agent
  state; selecting it opens the panel.
- When a turn ends or a request arrives while the panel is hidden, a toast
  offers **Open Agent**. When Oxbit is in the background, the browser shows a
  system notification if notification permission was granted. Set
  `agentACP.notifications` to `never` to turn these off.
- Native macOS and iOS notifications, checkpoints, parallel threads, voice input
  and a context-usage meter are not supported yet.

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
- **Reviewed agent edits** records client-API edits for the current conversation.
  **Undo this edit** restores an existing file only when its buffer and disk
  still match the applied edit. Undo is unavailable during agent work or pending
  approvals. New files and files changed again belong in Source Control review.
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
after cancellation is acknowledged. Providers report plans and token usage only
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

## Protocol references

Agent ACP uses the protocol's [session lifecycle](https://agentclientprotocol.com/protocol/v1/session-setup), [session discovery](https://agentclientprotocol.com/protocol/v1/session-list), and [content](https://agentclientprotocol.com/protocol/v1/content) contracts. The native tool server follows [MCP Streamable HTTP and stdio transport rules](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports). Adapter defaults are checked against the [Codex ACP package](https://registry.npmjs.org/@agentclientprotocol%2Fcodex-acp/2.2.2) and [Amp ACP package](https://registry.npmjs.org/amp-acp/0.10.0).

Design references: [Zed's agent panel](https://zed.dev/docs/ai/agent-panel) documents queues, context, and review; [VS Code sessions](https://code.visualstudio.com/docs/agents/run/sessions/manage-sessions) document session recovery and context usage; [OpenCode web](https://docs.opencode.ai/docs/web/) documents shared browser and terminal sessions; [Paseo CLI](https://github.com/getpaseo/paseo/blob/main/public-docs/cli.md) documents daemon-managed agents; [Oh My Pi RPC](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md) documents headless client integration. Oxbit's provider behavior depends on each advertised ACP capability.

## Verification

Focused runtime and editor tests:

```sh
bunx vitest run apps/runtime/tests/agent-acp.test.ts apps/runtime/tests/acp-registry.test.ts apps/runtime/tests/agent-mcp.test.ts apps/runtime/tests/acp-subagents.test.ts apps/runtime/tests/acp-subagents-integration.test.ts packages/features/agent-acp/src
```

Browser journeys (after `bun run build`):

```sh
bunx playwright test tests/browser/agent-acp*.spec.ts --reporter=list
```

The deterministic fixture speaks ACP over real stdio and exercises streaming,
permission responses, file edits, terminals, cancellation, and failure handling
without contacting a model provider. Live provider authentication, model prompts,
and billing require separate checks.
