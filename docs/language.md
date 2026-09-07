# Language services

The default provider runs TypeScript Language Server in the authorized runtime. It negotiates capabilities, opens documents, sends edits and restarts with the server's stored documents. Browser code uses `RuntimeLanguageTransport`. A host can register `language.transport` or pass a transport to `LanguageService` to use a worker provider. The worker path sends initialize/initialized messages and uses UTF-16 positions.

The document service sends unshared document updates once per document. Mounted CodeMirror views share diagnostics and remove their view registration when destroyed. Shared files use the runtime's canonical LSP stream. The browser flushes shared changes before language requests.

Requests check server capabilities. Cancellation, document changes, connection loss and server failure abort pending requests. Replies from an older document version or server instance are discarded. Server failure clears command availability; Restart starts the provider and opens current documents again. Unsupported position encodings fail startup.

Rename, code actions and formatting capture local document versions, disk revisions and canonical LSP versions separately. Applying an edit checks all three, then calls `DocumentService.applyEdits`. Resource changes check source revisions and destinations. Create-file edits open a new shared document. Unsaved buffers stay unsaved after edits.

Code actions apply returned edits, resolved edits, or advertised server commands. Server-initiated `workspace/applyEdit` requests route to the browser that initiated the action. That browser checks captured document versions and permissions, applies edits through the document service, and acknowledges success or failure. The supported TypeScript remove-unused-imports action also returns edits directly. Error messages appear in the workbench.

Workspace edit snapshots stop at 10,000 entries and exclude `.git`, `.oxbit` and `node_modules`. Binary files without text revisions are excluded from snapshots; an edit that targets an uncaptured file fails.

Contributed transports, diagnostics, completions, and code actions use public
SDK provider contracts. Providers match document languages; their results
check document versions and cancellation before reaching the editor. Removing
a contribution cancels its requests and removes its diagnostics and transport.
CodeMirror syntax providers register separately through `LanguageDefinition`.
