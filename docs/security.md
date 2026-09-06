# Trust and recovery boundaries

The runtime binds to loopback by default. Owner pairing creates a session token; the runtime stores a hash and issues an HttpOnly SameSite cookie. Browser reconnect also retains the token in session storage. Owner grants restrict filesystem reads/writes, collaboration, terminals, tasks, Git, language services and extension operations separately. Grants are revocable. Tool trust is a separate workspace decision.

The process boundary enforces grants before dispatch. Filesystem paths pass traversal and realpath checks, including symlink targets and write parents. Writes compare a revision derived from file bytes and use an atomic rename. Supported text formats are UTF-8, UTF-8 with BOM, UTF-16LE with BOM and Latin-1; unrepresentable conversions fail. Workspace reads and search have file/result bounds.

Terminal and task commands run with runtime user privileges after workspace trust. Git hooks and language-server tools can execute workspace code. Trusted ESM extensions share the browser or runtime process that loads them. Manifest capabilities are declarations for trusted extension code; JavaScript running in that process is not sandboxed by those declarations. The application makes no sandbox-isolation claim for trusted extensions or trusted workspace commands.

Markdown disables raw HTML, sanitizes rendered output, blocks embedded images/media and opens supported external links with opener isolation. Relative links open workspace documents. Extension artifacts execute only after the user selects a trusted URL; the production content policy restricts scripts to the application origin. The bundled example is served from the same application origin and resolves React through the documented host facade.

Runtime operation IDs retain completion/failure/interrupted status. An uncertain command or commit is inspected through operation.status; connection recovery does not start it again. Terminal replay is bounded and reports truncation. Surviving sessions reattach after socket loss; runtime process loss terminates PTYs. Shared Yjs updates persist independently of disk saves and merge on reconnect. Browser drafts remain available after failed saves and disconnected runtime services.

Revoking a grant closes its connections and terminates its owned processes. Revoking workspace trust terminates workspace tools. A runtime owner remains responsible for its operating-system account and credentials. Runtime Git uses existing credential helpers and environment configuration; secrets are not sent in browser bundles.
