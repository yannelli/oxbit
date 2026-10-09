# Trust and recovery boundaries

See the [security reporting policy](../SECURITY.md) to report a vulnerability privately.

The runtime binds to loopback by default. Owner pairing creates a session token; the runtime stores a hash and issues an HttpOnly SameSite cookie. Browser reconnect also retains the token in session storage. Owner grants restrict filesystem reads/writes, collaboration, terminals, tasks, Git, language services and extension operations separately. Grants are revocable. Tool trust is a separate workspace decision.

The process boundary enforces grants before dispatch. Filesystem paths pass traversal and realpath checks, including symlink targets and write parents. Writes compare a revision derived from file bytes and use an atomic rename. Supported text formats are UTF-8, UTF-8 with BOM, UTF-16LE with BOM and Latin-1; unrepresentable conversions fail. Workspace reads and search have file/result bounds.

Terminal and task commands run with runtime user privileges after workspace trust. Git hooks and language-server tools can execute workspace code. Trusted ESM extensions share the browser or runtime process that loads them. Manifest capabilities are declarations for trusted extension code; JavaScript running in that process is not sandboxed by those declarations. The application makes no sandbox-isolation claim for trusted extensions or trusted workspace commands.

Markdown disables raw HTML, sanitizes rendered output, blocks embedded images/media and opens supported external links with opener isolation. Relative links open workspace documents. Extension artifacts execute only after the user selects a trusted URL; the production content policy restricts scripts to the application origin. The bundled example is served from the same application origin and resolves React through the documented host facade.

Runtime operation IDs retain completion/failure/interrupted status. An uncertain command or commit is inspected through operation.status; connection recovery does not start it again. Terminal replay is bounded and reports truncation. Surviving sessions reattach after socket loss; runtime process loss terminates PTYs. Shared Yjs updates persist independently of disk saves and merge on reconnect. Browser drafts remain available after failed saves and disconnected runtime services.

Revoking a grant closes its connections and terminates its owned processes. Revoking workspace trust terminates workspace tools. A runtime owner remains responsible for its operating-system account and credentials. Runtime Git uses existing credential helpers and environment configuration; secrets are not sent in browser bundles.

## Dependency audit

Created: 2026-10-09. Last updated: 2026-10-09.

Dependabot and secret scanning are off for the repository. Run these audits before a release:

| Scope | Command |
| --- | --- |
| Bun workspace (`bun.lock`) | `bun audit` |
| Managed language servers | `npm audit --package-lock-only` in `apps/runtime/src/managed/npm` |
| Cargo locks | `node scripts/osv-cargo.mjs apps/desktop/src-tauri/Cargo.lock apps/ios/src-tauri/Cargo.lock apps/ios/plugins/oxbit-files/Cargo.lock` |

`scripts/osv-cargo.mjs` sends the crates.io name and version of each locked crate to the [OSV batch API](https://google.github.io/osv.dev/post-v1-querybatch/) and prints the advisory IDs. Use `bun why <package>` to find the real dependency path; the chains printed by `bun audit` can name the wrong parent.

`bun audit fix` reports in-range transitive updates as blocked, because `bun.lock` stores each dependent's resolved version. Bun applies a nested `overrides` entry to every parent of that package, so a per-parent override cannot pin different majors. Use a top-level `overrides` entry when one version fits every parent; otherwise update the lock entry's version and integrity to the patched release inside the parent's range and confirm with `bun install --frozen-lockfile`.

### Fixed on 2026-10-09

| Package | Old | New | Advisories | Shipped in |
| --- | --- | --- | --- | --- |
| tar | 7.5.9 | 7.5.22 | GHSA-qffp-2rhf-9h96, GHSA-9ppj-qmqm-q256, GHSA-vmf3-w455-68vh, GHSA-w8wr-v893-vjvp, GHSA-23hp-3jrh-7fpw, GHSA-8x88-c5mf-7j5w, GHSA-gvwx-54wh-qm9j, GHSA-r292-9mhp-454m | Runtime (CLI, desktop, SSH remote) |
| markdown-it | 10.0.0 | 14.3.2 | GHSA-6v5v-wf23-fmfq, GHSA-6vfc-qv3f-vr6c, GHSA-253c-mchw-3w2r | Web, desktop, iOS |
| linkify-it | 2.2.0 | 5.0.2 | GHSA-22p9-wv53-3rq4, GHSA-v245-v573-v5vm | Web, desktop, iOS |
| sprintf-js | 1.0.3 | removed | GHSA-hp3w-g68c-fv3c | markdown-it now uses argparse 2 |
| dompurify | 3.4.15 | 3.4.16 | GHSA-p98j-92pf-mc4p, GHSA-6688-9rhm-gjv2 | Web, desktop, iOS |
| highlight.js | 9.18.5 | removed | GHSA-7wwv-vh3v-89cq | Dev (`@types/markdown-it` 14.2.0) |
| fast-uri | 3.1.7 | 3.1.8 | GHSA-hrr3-gc8f-f4qj | Dev (ajv) |
| vitest, @vitest/mocker | 3.2.7 | 4.1.11 | GHSA-82fw-gwwq-j7x9 | Dev |
| tinypool | 1.1.1 | removed | GHSA-5gmw-xhrv-c9v3, GHSA-85c8-ppgw-ccpr | Dev (vitest 4) |
| brace-expansion | 1.1.18, 2.1.4, 5.0.9 | 1.1.21, 2.1.7, 5.0.12 | GHSA-6j4f-fj2g-mc7p, GHSA-qhr7-859c-m2p7, GHSA-q2hr-2g5m-vwhr | Dev (eslint, typescript-eslint, mocha) |
| source-map-js | 1.2.1 | 1.2.2 | GHSA-68fv-2mgg-jv7q | Dev (postcss) |
| basic-ftp | 5.3.1 | 6.2.2 | GHSA-c475-qrg2-pj4r | Dev (wdio) |
| ip-address | 10.7.0 | 10.7.1 | GHSA-j6r3-76f7-8jcv, GHSA-h3mg-xc3c-68pw | Dev (wdio) |
| serialize-javascript | 6.0.2 | 7.0.5 | GHSA-5c6j-r48x-rmvq, GHSA-qj8w-gfj5-8c6v | Dev (mocha) |
| smol-toml | 1.8.0 | 1.9.0 | GHSA-r4xh-jqrq-34v2 | Dev (wdio Tauri plugin) |
| rustls | 0.23.43 | 0.23.45 | RUSTSEC-2026-0285 | Desktop |

The managed installer rejects archive paths with `..`, hardlinks, and symlinks that resolve outside the package directory. tar reports an exception thrown from its `filter` callback as uncaught, so `apps/runtime/src/managed/install.ts` records the first rejection and throws it after extraction.

markdown-it 14 keeps the `html: false` and `linkify: true` settings, link validation, and escaping output. Two parser changes affect rendering: a `|` inside a table code span splits the cell, as GFM specifies, and linkify keeps `*` characters inside a URL.

Managed language servers (`apps/runtime/src/managed/npm`, installed by the runtime with lock integrity checks):

| Package | Old | New | Advisories |
| --- | --- | --- | --- |
| bash-language-server | 5.6.0 | 5.8.1 | Moves editorconfig to 3.0.2 |
| minimatch | 10.0.1 | 10.2.6 | GHSA-3ppc-4f35-3m26, GHSA-7r86-cg39-jmmj, GHSA-23c5-xmqv-rm74 |
| brace-expansion | 2.1.4 | 5.0.12 | GHSA-6j4f-fj2g-mc7p, GHSA-qhr7-859c-m2p7, GHSA-q2hr-2g5m-vwhr |
| fast-uri | 3.1.7 | 3.1.8 (override) | GHSA-hrr3-gc8f-f4qj |
| source-map-js | 1.2.1 | 1.2.2 (override) | GHSA-68fv-2mgg-jv7q |
| ip-address | 10.7.0 | 10.7.3 (override) | GHSA-j6r3-76f7-8jcv, GHSA-h3mg-xc3c-68pw |
| protobufjs | 8.3.0 | 8.8.0 (override) | GHSA-94rc-8x27-4472, GHSA-wcpc-wj8m-hjx6, GHSA-f38q-mgvj-vph7, GHSA-jfj6-75fj-8934, GHSA-j3f2-48v5-ccww |
| basic-ftp | 5.3.1 | 6.2.2 (override) | GHSA-c475-qrg2-pj4r |
| @opentelemetry/core, resources, sdk-trace-base | 1.30.1 | 2.12.0 (override) | GHSA-8988-4f7v-96qf |

intelephense stays at 1.18.5, the latest release; `npm audit` suggests 1.18.2, a downgrade. `lib/intelephense.js` bundles applicationinsights, proxy-agent, and micromatch, and requires only Node built-ins, so the overridden copies in `node_modules` are downloaded and not loaded. Telemetry is off in `apps/runtime/src/managed/catalog.ts`.

### Accepted advisories

| Package | Advisory | Path | Reason |
| --- | --- | --- | --- |
| braces 3.0.3 | GHSA-vfj7-8cjw-p6xm | mocha 10 > chokidar 3.6.0 (wdio, dev) | No patched release. Mocha watch mode only; desktop WebDriver tests do not use it. |
| braces 3.0.3 | GHSA-vfj7-8cjw-p6xm | Managed lock: micromatch and fast-glob in bash-language-server and intelephense | No patched release. bash-language-server expands its `globPattern` setting (default `**/*@(.sh\|.inc\|.bash\|.command)`) with fast-glob; a nested-brace pattern needs control of the server settings. intelephense runs its bundled copy. |
| extract-zip 2.0.1 | GHSA-jmr9-qjv8-65gv, GHSA-7pqw-9j4j-h8q3 | wdio > @puppeteer/browsers 2.x (dev) | No patched release. Extracts browser driver archives during desktop WebDriver tests. @puppeteer/browsers 3 drops it and needs WebdriverIO 10. |
| rsa 0.9.10, 0.10.0-rc.18 | RUSTSEC-2023-0071 | iOS: russh 0.64.1 and ssh-key with the `rsa` feature; pgp 0.21.0 in oxbit-files | No upstream fix. New SSH and commit-signing keys are Ed25519 (`apps/ios/src-tauri/src/ssh/keys.rs`, `apps/ios/plugins/oxbit-files/src/commit_signing/keys.rs`). An imported RSA key signs SSH authentication and commits. The Marvin attack targets RSA decryption, which Oxbit does not call; russh has no RSA key exchange. |
| glib 0.18.5 | RUSTSEC-2024-0429 | gtk, wry, webkit2gtk on Linux | Linux desktop packages (AppImage, .deb) only. No crate in the tree calls `VariantStrIter`. |
| proc-macro-error 1.0.4 | RUSTSEC-2024-0370 (unmaintained) | glib-macros, gtk3-macros | Compile-time only, Linux only. |
| unic-* 0.9.0 | RUSTSEC-2025-0075, -0080, -0081, -0098, -0100 (unmaintained) | tauri-utils > urlpattern | Used to match remote URL capabilities; the desktop and iOS capability files define no remote URLs. |
