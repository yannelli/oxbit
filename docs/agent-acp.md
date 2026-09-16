# Agent ACP

Agent ACP is a bundled, **disabled-by-default** extension for Codex ACP,
Cursor ACP, and Amp Agent ACP. Open **Extensions → Agent ACP → Enable**, then
use **Agent ACP: Open Agent ACP** in the command palette or its activity icon.
Enabling and disabling persist across reloads, including workspaces created
before this extension was added. Enabling alone does not launch or install an
agent.

Connect Oxbit to a runtime workspace, grant workspace tool trust, choose a
provider, and select **Connect**. Browser and desktop use the same extension.
Only the runtime owner can launch and control agents; shared workspace grants
do not gain agent access. Browser-only workspaces show runtime connection guidance.

## Providers

| Provider | Default executable and arguments | Setup |
| --- | --- | --- |
| Codex ACP | `npx -y @agentclientprotocol/codex-acp@1.10.0` | Existing Codex credentials, or an advertised sign-in method |
| Cursor ACP | `agent acp` | Install Cursor CLI and run `agent login` |
| Amp Agent ACP | `npx -y amp-acp@0.9.0` | Install Amp CLI and run `amp login` |

Codex uses the [maintained ACP adapter](https://github.com/agentclientprotocol/codex-acp),
which bundles a compatible Codex dependency. Cursor uses its
[native ACP interface](https://cursor.com/docs/cli/acp). Amp uses the
[community Amp ACP adapter](https://github.com/tao12345666333/amp-acp).

**Setup** exposes the executable and a JSON array of arguments. These are also
available in Settings under Agent ACP, together with the default provider.
Commands launch directly without shell interpolation. For a local adapter,
replace `npx` with its absolute executable path and set arguments to `[]`.
If Cursor is installed as `cursor-agent`, use that executable with `["acp"]`.
The first `npx` connection downloads the pinned adapter if it is not cached. Nothing is downloaded
when the disabled extension is registered or when it is enabled.

Agents inherit the runtime environment and existing CLI credentials. Supply API
keys or `AMP_CLI_PATH` through that environment; the extension has no credential
fields. After a session reports an authentication error, use an advertised sign-in
button or sign in using the provider CLI, then retry the conversation.

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
  remain attributed to their sessions until those sessions finish or disconnect. **Disconnect** ends the
  conversation. Disabling the extension, losing the client connection, revoking
  trust, or closing the runtime terminates owned agent and terminal processes.
  Late responses from an ended connection cannot change a newer conversation.
  Failed prompts leave the panel ready for another message, with the error shown.

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
as successful when the provider confirms it; a lost connection is shown as
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
child messaging/cancellation controls. Adapter versions remain pinned.

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

Agent ACP uses the protocol's [session lifecycle](https://agentclientprotocol.com/protocol/v1/session-setup), [session discovery](https://agentclientprotocol.com/protocol/v1/session-list), and [content](https://agentclientprotocol.com/protocol/v1/content) contracts.

## Verification

Focused runtime and editor tests:

```sh
pnpm exec vitest run apps/runtime/tests/agent-acp.test.ts apps/runtime/tests/acp-subagents.test.ts apps/runtime/tests/acp-subagents-integration.test.ts packages/features/agent-acp/src
```

Browser journeys (after `pnpm build`):

```sh
pnpm exec playwright test tests/browser/agent-acp.spec.ts tests/browser/agent-acp-workflows.spec.ts tests/browser/agent-acp-subagents.spec.ts --reporter=list
```

The deterministic fixture speaks ACP over real stdio and exercises streaming,
permission responses, file edits, terminals, cancellation, and failure handling
without contacting a model provider. Live provider authentication, model prompts,
and billing require separate checks.
