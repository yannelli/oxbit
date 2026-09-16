# Language services

The shared registry selects matching managed and local providers for each document. JavaScript/TypeScript retains TypeScript Language Server and its bundled SDK fallback in the authorized runtime. Other presets and capabilities and limits are documented in [language support](language-support.md). It negotiates capabilities, opens documents, sends edits and restarts with the server's stored documents. Browser code uses `RuntimeLanguageTransport`. A host can register `language.transport` or pass a transport to `LanguageService` to use a worker provider. The worker path sends initialize/initialized messages and uses UTF-16 positions.

The document service sends unshared document updates once per document. Mounted CodeMirror views share diagnostics and remove their view registration when destroyed. Shared files use one canonical runtime stream per attached server instance. The browser flushes shared changes before language requests.

Files containing multiple languages stay a single source document with their host language ID. For example, `.astro` files use the Astro server for TypeScript frontmatter, template expressions, HTML, scripts and styles. The framework server owns its embedded documents and maps completion edits, diagnostics and navigation back to the original file. Vue similarly uses its managed server and TypeScript companion. Support for embedded regions depends on the selected server.

Protocol-defined `data` fields are opaque server metadata and round-trip unchanged during completion, code-action, hint, link, symbol and hierarchy resolution, including diagnostics supplied with code-action requests. Virtual URIs in this metadata are not filesystem targets. Actual document, location and workspace-edit URIs still pass the runtime's path checks; notifications and server-initiated edits retain those checks too.

Requests check server capabilities. Cancellation, document changes, connection loss and server failure abort pending requests. Replies from an older document version or server instance are discarded. Server failure clears command availability; Restart starts the provider and opens current documents again. Unsupported position encodings fail startup.

Rename, code actions and formatting capture local document versions, disk revisions and canonical LSP versions separately. Applying an edit checks all three, then calls `DocumentService.applyEdits`. Resource changes check source revisions and destinations. Create-file edits open a new shared document. Unsaved buffers stay unsaved after edits.

Code actions apply returned edits, resolved edits, or advertised server commands. Server-initiated `workspace/applyEdit` requests route to the browser that initiated the action. That browser checks captured document versions and permissions, applies edits through the document service, and acknowledges success or failure. The supported TypeScript remove-unused-imports action also returns edits directly. Error messages appear in the workbench.

Workspace edit snapshots stop at 10,000 entries and exclude `.git`, `.oxbit` and `node_modules`. Binary files without text revisions are excluded from snapshots; an edit that targets an uncaptured file fails.

Contributed transports, diagnostics, completions, and code actions use public
SDK provider contracts. Providers match document languages; their results
check document versions and cancellation before reaching the editor. Removing
a contribution cancels its requests and removes its diagnostics and transport.
CodeMirror syntax providers register separately through `LanguageDefinition`.


Managed transports attach with the current document path, effective `languageServers`
configuration and `files.associations`; runtime messages carry an optional `instanceId`.
The current-document indicator filters matching providers and keeps relevant
Start/Retry/Restart/Stop actions. Processes attached to other documents are not listed.

`LanguageTransport.onRequest` optionally installs a server-request handler accepting
`(method, params, signal)`. Its disposable removes the handler and cancels owned work.
Dynamic registrations are validated and selector-scoped; unregistering a provider
immediately changes command availability. A transport without this hook does not
advertise dynamic registration or configuration-request support.

The SDK adds `SemanticTokensProvider`, `InlayHintsProvider` and `NavigationProvider`
for `semanticTokens`, `inlayHints` and `navigation` contributions. Each result retains
its provider identity and document version. Semantic/hint overlays choose the highest
priority eligible provider; navigation deduplicates eligible providers' locations.
JSON-valued settings are validated, cloned and persisted at existing configuration scopes.

`ExternalDocument` contains an opaque runtime handle, URI, display name, text, revision
and `readonly: true`. Its view does not expose an editable filesystem document or bypass
`DocumentService.applyEdits`. Runtime handles expire when the server generation ends.
