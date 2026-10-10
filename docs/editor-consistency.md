# Editor consistency contracts

Created: 2026-10-10. Last updated: 2026-10-10.

Use this guide when changing document lifecycle, file operations, tab navigation,
search replacement, or the Settings screen. These contracts were checked against
Zed's official documentation and source at
[`f16f965`](https://github.com/zed-industries/zed/tree/f16f9652ec57bf806e65b2a0d51bb92a63644914).
Source comparisons describe implementation structure; browser and native tests
establish Oxbit's behavior.

## Documents and views

- An open document occupies its path after the file is deleted on disk. Rename
  validation checks open destination documents and their descendants before I/O.
- External reads apply to the document that started them, provided no newer
  external event has superseded the read. Stale errors follow the same rule.
- Explicit discard uses `DocumentService.discard`, including encoding and line
  endings. It accepts drafts whose files have become read-only.
- Session persistence completes before listeners and resources are removed.
  A persistence failure leaves the live session available for recovery.
- Rename preserves distinct editor, preview, and diff identities. Path-bearing
  view props and active-tab references follow the rename.
- File opens capture their destination pane before loading. A superseded preview
  request does not replace a newer selection. Explicit permanent opens retain
  their tabs without taking focus from a newer request.

Zed documents [dirty-buffer retention and session recovery](https://zed.dev/docs/reference/all-settings).
Its [reload task](https://github.com/zed-industries/zed/blob/f16f9652ec57bf806e65b2a0d51bb92a63644914/crates/language/src/buffer.rs#L1764),
[preview editor reference](https://github.com/zed-industries/zed/blob/f16f9652ec57bf806e65b2a0d51bb92a63644914/crates/markdown_preview/src/markdown_preview_view.rs#L552-L601),
[close preparation](https://github.com/zed-industries/zed/blob/f16f9652ec57bf806e65b2a0d51bb92a63644914/crates/workspace/src/workspace.rs#L3626),
and [pane selection before loading](https://github.com/zed-industries/zed/blob/f16f9652ec57bf806e65b2a0d51bb92a63644914/crates/workspace/src/workspace.rs#L5069-L5081)
provide reference patterns for these contracts.

## Search, settings, and encoding

Literal replacement returns the supplied text after checking that the matched
range is still current. Regex replacement keeps `$0` for the entire match and
expands an existing, unmatched numeric capture to an empty string. Other existing
replacement syntax remains unchanged.

Zed [returns literal replacements unchanged](https://github.com/zed-industries/zed/blob/f16f9652ec57bf806e65b2a0d51bb92a63644914/crates/project/src/search.rs#L440-L447)
and [documents `$0` and numbered captures](https://zed.dev/docs/vim#regex-differences).
The [ECMAScript substitution algorithm](https://tc39.es/ecma262/multipage/text-processing.html#sec-getsubstitution)
defines empty substitution for a capture that did not participate in the match.

The Settings screen uses `configuration.inspect(id, language, scope)` for core
validation, merging, and language aliases. User scope excludes workspace layers.
The Modified indicator reflects the selected layer's own key. Theme typography
provides defaults when no valid explicit setting is present. Zed's
[UI checklist](https://zed.dev/docs/development/ui-checklist) covers consistent
interactions and delayed, missing, or invalid data.

iOS file renames move known encoding hints for the affected path prefix. Deletion
removes those hints after native success. This preserves existing session
knowledge; it does not add encoding detection or a new reopen command. Zed's
[reload preserves the buffer encoding](https://github.com/zed-industries/zed/blob/f16f9652ec57bf806e65b2a0d51bb92a63644914/crates/language/src/buffer.rs#L1701).

## Runtime file operations

Rename and delete reject paths that contain configured protected roots. Reads and
directory listing retain their existing behavior. This is a path invariant and
adds no trust prompt. Zed's [worktree trust](https://zed.dev/docs/worktree-trust)
covers project configuration and code execution; Oxbit's protected storage check
is a separate filesystem contract.

Text files retain the existing 20 MiB limit. File-save messages allow the JSON
representation of that content plus the request envelope. Collaboration updates
allow a base64-encoded full document and update overhead. The client, parser,
and WebSocket transport share these limits; unrelated requests keep their 2 MiB
budget. The response backlog permits one maximum-size file message.
Zed's [UI checklist](https://zed.dev/docs/development/ui-checklist) includes
large files and actionable failure states.

Durable operation history retains the current and previous ID epochs, with 128
admissions per epoch and up to 64 running operations. Retained result bodies share
a 1 MiB budget. Results beyond that budget expire without changing the operation's
recorded outcome or the full response sent to its original caller.

`RuntimeClient` obtains the current epoch during authentication and follows epoch
events. Its default durable IDs include that epoch. Call `createOperationId()`
when an intentional retry needs the same ID. An unknown retired ID returns
`OPERATION_EXPIRED`; replay of a completed operation whose body was removed returns
`OPERATION_RESULT_EXPIRED`. Neither response executes the operation again.
Recovery checks status instead of automatically retrying mutations.

Clients before 0.6.2 send plain IDs without an epoch. The runtime keeps
accepting them. Each rotation keeps the newest 128 finished records, so plain-ID
records stay bounded with the epoch-qualified ones. A plain ID whose record was
dropped reads as unknown, and a retry with it executes again. Updated clients
should use generated epoch-qualified IDs. Running requests retain their records
until completion; restart-interrupted operations remain unreplayable.

[Stripe's idempotency contract](https://docs.stripe.com/api/idempotent_requests)
documents both retention and the behavior of reused expired keys. Oxbit rejects
expired IDs to preserve its existing rule against repeating uncertain mutations;
its retention is bounded by count and bytes.
