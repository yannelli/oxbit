# Documents and recovery

`DocumentService` owns Yjs documents independently of React views. Files have persisted UUIDs that survive rename. `content` stores LF text. Transactions increment document versions. Saved revisions, disk content, encoding and line endings are separate fields. Views keep separate selections and scroll positions.

`LOCAL_ORIGIN` edits enter the undo manager. `REMOTE_ORIGIN` and `DISK_ORIGIN` edits do not. CodeMirror's binding adds its local binding origin. Undo keeps remote edits. Closing a dirty document requires save or discard; removing a view does not close the document.

Recovery stores Yjs state, IDs, versions, saved text, revisions, format and view state in IndexedDB. Changes schedule storage after 75 ms. Save and `persist()` wait for storage. Layout is stored by the host. Browser exit during the debounce window can lose the final unpersisted change.

Restore applies saved Yjs state to an empty document, then merges server updates. If disk changed while a dirty draft was offline, the draft enters conflict state. Clean drafts import newer disk text. Missing files and permission errors keep draft content.

## Save behavior

Writes check `expectedRevision`. Edits during save hooks reject saving. Edits during disk writing stay dirty after the submitted version is saved. Watch events during save run after its revision is recorded.

Clean external changes update the document. External changes against dirty text enter conflict state. `reload(path)` discards local text and reads disk. `overwriteConflict(path)` reads the current revision, then saves local text. Deleted files enter missing state. Permission errors enter readonly state. Other errors keep text and expose the error message.

Multi-file edits check document versions, disk revisions, permissions and text ranges before changes. Resource edits check destinations and reject deletion of dirty files. Resource operations run sequentially; an I/O failure keeps earlier completed operations. The host must report partial failure.

The runtime writes shared documents to disk. Shared Yjs updates are stored separately from file saves. `markSaved` records the writer's disk snapshot without changing concurrent buffer edits.

## Browser files

`IndexedDBPersistence` uses the `data` object store. `BrowserFileSystem` supports revision checks and watching. Web Locks serialize writes across tabs; BroadcastChannel reports changes. Import checks the archive before writing. JSON archives contain `version: 1`, `files: [{path,text,encoding,eol}]` and optional directories.

`pickDirectory` opens a supported browser picker after a user action. Unsupported browsers use IndexedDB. Cancellation rejects with the browser error and keeps the current workspace. Startup reuses stored directory handles with permission and falls back to IndexedDB otherwise.

Directory writes check SHA-256 revisions. The browser API has no atomic compare-and-swap, so external edits between the revision check and commit can be overwritten. Directory rename copies before removing the source and removes partial copies on copy failure. Watching polls every 2 seconds, skips `.git` and `node_modules`, and stops after 10,000 entries.

## File formats

Supported formats are UTF-8, UTF-8 BOM, UTF-16LE BOM and explicit Latin-1. Files without BOMs default to UTF-8. Invalid byte sequences, binary NUL, UTF-16BE and unpaired UTF-16 surrogates fail conversion. Latin-1 rejects characters above U+00FF.

The editor uses LF text. Save converts to LF or CRLF. Format changes mark the document dirty. Mixed LF/CRLF input defaults to CRLF output.

Reselecting a native directory reuses its saved workspace ID. Directory renames
copy raw bytes, including binary files. Explicit encoding choices persist with
that directory so a Latin-1 save can be decoded again after refresh.

Runtime workspace settings cache pending writes and their disk revision across
refresh. Conflicting disk changes preserve the local settings. Use **Reload
Workspace Settings from Disk** to discard the local overrides, or **Save
Workspace Settings to Disk** to write them after confirmation. Deleting the
disk settings file removes clean workspace overrides. User settings remain in
the browser profile.

Search replacement previews retain per-file selection and document versions.
Applying a preview changes unsaved documents and reports failures per file.
Browser searches use worker batches, stop at 10,000 results, and report
unreadable files. The Explorer shows up to 20,000 entries. Editors above 1,048,576 UTF-16 code units
use a reduced feature set with an explicit notice; filesystem reads stop at
20 MiB.
