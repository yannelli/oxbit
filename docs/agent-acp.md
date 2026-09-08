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
The first `npx` connection may download the pinned adapter. Nothing is downloaded
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
- **Stop** cancels a turn and clears pending approvals. **Disconnect** ends the
  conversation. Disabling the extension, losing the client connection, revoking
  trust, or closing the runtime terminates owned agent and terminal processes.
  Late responses from an ended connection cannot change a newer conversation.
  Failed prompts leave the panel ready for another message, with the error shown.

Agents execute with the trusted runtime user's privileges. The workspace path
checks apply to Oxbit's ACP filesystem and terminal working-directory APIs;
they are not a process sandbox. An agent's own tools can edit files or execute
commands independently, according to that agent's permission policy. The review
UI applies to writes requested through Oxbit's ACP client API.

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

## Design research

This iteration reviewed Zed at revision
`6f73c7d0a4aae8e32afb5d01b0fcb89e5e3642ff`, specifically its
[ACP connection contracts](https://github.com/zed-industries/zed/blob/6f73c7d0a4aae8e32afb5d01b0fcb89e5e3642ff/crates/acp_thread/src/connection.rs),
[change review](https://github.com/zed-industries/zed/blob/6f73c7d0a4aae8e32afb5d01b0fcb89e5e3642ff/crates/acp_thread/src/diff.rs),
thread metadata, agent connection code, and message queue. No Zed code or layout
was copied. The implementation follows Oxbit's shared document, persistence,
workbench, and runtime ownership contracts.

The focus is recoverable conversations, explicit inspectable editor context,
chronological activity, and proposals that can be reviewed in the main editor and
undone without overwriting later work. Protocol behavior follows the primary
[session lifecycle](https://agentclientprotocol.com/protocol/v1/session-setup),
[session discovery](https://agentclientprotocol.com/protocol/v1/session-list), and
[content](https://agentclientprotocol.com/protocol/v1/content) specifications.

## Verification

Focused runtime and editor tests:

```sh
pnpm exec vitest run apps/runtime/tests/agent-acp.test.ts packages/features/agent-acp/src
```

Browser journeys (after `pnpm build`):

```sh
pnpm exec playwright test tests/browser/agent-acp.spec.ts tests/browser/agent-acp-workflows.spec.ts --reporter=list
```

The deterministic fixture speaks ACP over real stdio and exercises streaming,
permission responses, file edits, terminals, cancellation, and failure handling
without contacting a model provider. Real Codex, Cursor, and Amp adapters have
also completed initialization against this bridge; model prompts and account
billing were not part of that handshake check.
