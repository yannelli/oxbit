# Runtime features on iOS local workspaces

Created: 2026-10-09. Last updated: 2026-10-09.

This page compares the computer runtime (`apps/runtime`) with device folders on iOS and records how each runtime feature reaches iOS. A connected runtime gives iOS every runtime feature; the table covers folders on the device, where no runtime runs. The Runtime page connects to an `oxbit --lan` runtime found over Bonjour, a runtime entered by address, or a runtime iOS starts over [SSH](ios-ssh.md) ([iOS setup](ios.md)).

## Feature table

| Runtime feature | Runtime implementation | iOS device folder today | Port path | Verdict |
| --- | --- | --- | --- | --- |
| Files: list, read, write, rename, delete | `fs.*` in `apps/runtime/src/runtime.ts`, `apps/runtime/src/filesystem.ts` | `fs_core.rs` through `ios_fs_*`; same error codes, SHA-256 revisions, 20 MiB limit | Done | Shipped before this branch |
| File watching | `fs.watch` with chokidar (`runtime.ts`) | `watch.rs` polls every 2 s, up to 10,000 entries | Per-directory `DispatchSource` vnode sources or `NSFilePresenter` for coordinated Files app folders | Later |
| Git | 37 `git.*` methods (`apps/runtime/src/git.ts`) | libgit2 in `git_core*`; all 37 methods have dispatch arms (`git.progress` is an event) | No method gaps | Shipped before this branch |
| Content search | `search.query` runs ripgrep (`runtime.ts`) | Rust `search_core.rs` with the `ignore` walker and `grep-regex` matcher, through `FileSystem.search` | Done; rules below | Shipped in this branch |
| Quick open | No RPC; the workbench walks `fs.list` (`packages/workbench/src/files.ts`) | Rust `find_files` through `FileSystem.findFiles`, filtered natively | Done; rules below | Shipped in this branch |
| Language servers | `lsp-manager.ts` starts server processes | TypeScript, JavaScript, JSON, JSONC in JavaScriptCore ([iOS language servers](ios-language-servers.md)) | YAML, Dockerfile, shell, zsh, Python servers in JavaScriptCore | In progress on `p2/ios-language-extensions`. Native-binary servers (gopls, rust-analyzer) need process execution: not possible on iOS |
| JSON and YAML schema download | `json-schemas.ts` fetches the SchemaStore catalog | Schemas from workspace files only | Shared schema cache with downloads | In progress on `p2/ios-language-extensions` |
| Formatters | Workbench formatter workers; runtime adds tool formatters | Prettier and the TypeScript formatter run in the web view | ruff and shfmt builds that run without a process | In progress on `p2/ios-language-extensions` |
| Project intelligence | `projects.ts`: `typescript` and `ignore` npm packages over Node `fs` | None | Run the same module in the web view or the language JavaScriptCore context over `FileSystem.list`, `read`, and `findFiles`; both packages run without Node | Later |
| Terminals | `terminal.*` with node-pty | None | See [Terminals and tasks](#terminals-and-tasks) | Later: in-process Rust shell (brush + uutils) is the chosen path; not started |
| Tasks | `apps/runtime/src/tasks` starts processes and Git worktrees | None | Worktree operations through libgit2; task commands depend on terminals | Later, after terminals |
| Agents (ACP) | `agent-acp.ts` starts agent CLIs over stdio | Through a connected runtime | Agent CLIs are Node or native processes | Not possible on device: no process execution |
| Collaboration | `collaboration.ts` hosts Yjs rooms and writes shared files | Through a connected runtime | The device would have to host rooms for other clients | Later; needs a reachable host |
| Previews | HTML preview in the web view (`packages/features/previews`) | HTML/CSS preview works on device folders ([iOS](ios.md)) | Dev-server previews need a server process | Shipped (HTML/CSS); dev servers not possible on device |
| Runtime extensions | `extensions.ts` imports ESM modules into Node | Browser-environment extensions and icon packs | Runtime extensions are downloaded executable code | Not possible: App Store guideline 2.5.2 |
| Runtime over SSH | `ssh.ts`, `ssh-workspace.ts`; payloads for `darwin-arm64`, `linux-x64`, `linux-arm64` | iOS starts and tunnels a runtime over SSH; the `runtime.keepAlive` lease keeps it running while iOS suspends the app, and the app reattaches to the same process | Done | Shipped ([iOS SSH](ios-ssh.md), [remote runtimes](remote-ssh.md)) |
| Runtime discovery | `oxbit --lan` advertises `_oxbit._tcp` over Bonjour ([runtime](runtime.md)) | Runtime page lists found runtimes through `NWBrowser` in `oxbit-files` | Done | Shipped ([iOS setup](ios.md)) |

## Search parity rules

`apps/ios/src-tauri/src/search_core.rs` follows the runtime's `rg` call in `runtime.ts` (`search.query`):

| Rule | Runtime (`rg`) | iOS native |
| --- | --- | --- |
| Ignore files | `.gitignore`, `.ignore`, `.rgignore`, `.git/info/exclude`, global excludes; `.gitignore` applies inside a Git repository | `WalkBuilder` defaults, the same set and the same repository requirement |
| Hidden files | Skipped | Skipped |
| `.git`, `node_modules` | `!.git/**` and `!node_modules/**` globs; a nested `node_modules` outside `.gitignore` is searched | Skipped at every depth, as in the worker walk and the watcher |
| Symlinks | Not followed | Not followed; symlinked files are skipped, so results stay inside the root |
| File size | `--max-filesize 20M` | Files over 20 MiB skipped |
| Matching | `--fixed-strings` unless regex, `--ignore-case` unless case-sensitive, `--word-regexp` | `grep-regex` with the same three options and the Rust `regex` syntax |
| Include and exclude | Comma-separated `--glob` values, `!` for excludes | `OverrideBuilder` with the same globs |
| Per-file limit | `--max-count 1000` matched lines | 1000 matched lines; every match on those lines is a row |
| Total limit | 10,000 rows | 10,000 rows, `truncated: true` |
| Decoding | ripgrep decodes, then the runtime rereads the file | `decode` follows `decodeText`: UTF-16LE and UTF-8 BOMs, strict UTF-8, UTF-16BE, NUL, and invalid UTF-8 files skipped, CRLF folded to LF |
| Offsets | Byte offsets converted to string offsets | `column`, `from`, `to` count UTF-16 code units in the decoded text |
| Revision | SHA-256 of the file the runtime reread | `fs_core::revision` of the bytes searched; the write path accepts it as `expectedRevision` |
| Stale lines | Rows whose line changed between `rg` and the reread are dropped | One read per file, so no stale rows |

Differences from the runtime:

- Files that `decodeText` rejects (Latin-1 without an encoding hint, UTF-16BE) are skipped. The editor cannot open them without an explicit encoding either.
- Whole-word mode uses `grep-regex` word semantics (one side of the match must be a non-word character); the worker's `\b` pattern, used for unsaved documents, needs a word character on one side.
- `grep-searcher` is not used. It depends on `encoding_rs`, licensed `(Apache-2.0 OR MIT) AND BSD-3-Clause`, and its streaming reader adds nothing once the whole file is decoded in memory.

`SearchService` uses the runtime when connected, then `FileSystem.search`, then the worker walk. With all three, unsaved documents are searched in the worker and replace the disk rows for their path.

## Quick-open rules

`find_files` walks with `.gitignore` applied (in Git repositories), hidden files included (`.github`, `.env.example`), `.git`, `node_modules`, and `.oxbit-tmp-*` skipped, and symlinks skipped. The walk runs in parallel. It keeps paths whose lowercase form contains the trimmed, lowercased query as a subsequence, the test `findWorkspaceFiles` applies, sorts them, and returns the first 1000. The worker walk it replaces did not apply `.gitignore` and returned the first 1000 matches in walk order.

The filter runs natively, so each keystroke crosses the bridge once with at most 1000 paths. The first native version walked sequentially in file-name order and took 499 ms on the macOS host for a whole-tree query on the repository below; the parallel walk takes 61 ms there.

## Cancellation

Each request carries a UUID. `ios_search_cancel` sets the flag for that root and request through the `Operations` registry that Git uses (`git_operations.rs`), including cancels that arrive before the request registers. The walk checks the flag per entry and returns `CANCELLED`. Searches run on blocking threads and do not wait for Git operations on the same root. `IosFileSystem` provides `search` and `findFiles` only for device roots; SFTP roots (`SshFileSystem`) keep the worker walk.

## Measurements

Measured 2026-10-09 on the "iPhone 17 Pro" simulator (iOS 27.0) on an Apple Silicon Mac, release build, with a clone of flutter/flutter 3.29.0 (14,699 tracked files, 177 MB working tree) in the app's Documents folder. Before is the worker walk (`fs.list` and `fs.read` per directory and file over the bridge); after is the native command. Times are milliseconds per call: the first call, then the later runs. Other builds ran on the same Mac during the walk runs.

| Operation | Before (worker walk) | After (native) | Results |
| --- | --- | --- | --- |
| Content search `TODO` | 21,623; 16,378 | 813; 514, 475 | 2,952 before (hidden files included, 718 unreadable-file warnings); 2,937 after, equal to `rg` with the runtime flags |
| Content search `StatelessWidget`, whole word | 14,843; 13,572 | 358; 360, 342 | 1,706 both |
| Quick open `scaffold` (whole tree) | 4,644; 10,558 | 244; 86, 75 | 277 both |
| Quick open `mdart` (stops at 1000) | 513; 548 | 126; 99, 75 | 1000 both |

Binary size: the release simulator executable (`Oxbit.app/Oxbit`, arm64, LTO) is 31,065,840 bytes with the Rust host from `012190d` and 32,660,672 bytes with this branch, 1,594,832 bytes (5.1%) larger. Both builds embed the same frontend.

## Terminals and tasks

iOS apps cannot `fork` or `exec`, so node-pty and `std::process::Command` are unavailable. Three in-process options exist:

| Option | What it is | Effort in the Tauri host | App Store fit |
| --- | --- | --- | --- |
| ios_system | C library that runs each command as a thread in the app; BSD-3-Clause, v3.0.7 (2026-10-02). a-Shell and Blink ship it | xcframework linked into the iOS target, Rust FFI to `ios_system()`, stdio plumbing to the xterm view. Ported commands make globals thread-local | Bundled commands are self-contained; downloading command packages falls under 2.5.2 |
| brush + uutils | Bash-compatible shell in Rust (`brush-core` 0.5.0, MIT, 2026-05-03) and coreutils crates (0.12.0, MIT, 2026-09-17) whose `uumain` runs a utility as a function | Embed `brush-core`, route command names to an in-process `uumain` registry instead of `std::process::Command`, and give each command its own stdio for pipes. brush lists no iOS target; the iOS build has not been tried | All code compiled into the app; no downloads |
| WASI commands | Commands compiled to WebAssembly and run by an interpreter: WasmKit 0.4.1 (Swift, MIT, iOS 18+, WASI 0.1), or wasmtime's Pulley interpreter (Tier 3 on `aarch64-apple-ios`) | Swift package and FFI for WasmKit, or a Tier 3 Rust target; map WASI preopens to the workspace root | Bundled `.wasm` files are self-contained. 4.7 permits outside software only for HTML5 and JavaScript mini apps, so downloaded `.wasm` commands fall under 2.5.2 |

Guideline 2.5.2 (last updated 2026-06-08) bars apps from downloading or executing code "which introduces or changes features or functionality of the app". Its only exception covers educational apps. Apple declined JIT for a non-browser terminal app in April 2026 (FSFE), so any option runs as an interpreter or as compiled-in code.

Verdict: brush + uutils, because it stays in the existing Rust host and ships no downloadable code. The first step is an iOS build of `brush-core` with a builtin registry and per-command stdio, shown in the existing terminal panel. Tasks follow on the same shell; task commands that need Node, Python, or compilers stay runtime-only. Estimated effort: two to three weeks for the shell and terminal panel, before porting individual tools.

## Crates

| Crate | Version | License | Role |
| --- | --- | --- | --- |
| `ignore` | 0.4.33 | Unlicense OR MIT | Directory walk with ignore files and globs |
| `grep-regex` | 0.1.14 | Unlicense OR MIT | Line-oriented regex matcher |
| `grep-matcher` | 0.1.9 | Unlicense OR MIT | Matcher trait |
| `globset` | 0.4.20 | Unlicense OR MIT | Dependency of `ignore` |
| `bstr` | 1.13.1 | MIT OR Apache-2.0 | Dependency of `globset` and `grep-regex` |
| `crossbeam-deque` | 0.8.8 | MIT OR Apache-2.0 | Dependency of the parallel walker |
| `crossbeam-epoch` | 0.9.21 | MIT OR Apache-2.0 | Dependency of `crossbeam-deque` |

License texts ship in `apps/web/public/licenses/ios-search-crates.txt`.

## References

Accessed 2026-10-09.

- [`ignore` 0.4.33 `WalkBuilder`](https://docs.rs/ignore/0.4.33/ignore/struct.WalkBuilder.html): ignore-file rules, `require_git`, `hidden`, `max_filesize`, `follow_links`, parallel walking.
- [`ignore` 0.4.33 `OverrideBuilder`](https://docs.rs/ignore/0.4.33/ignore/overrides/struct.OverrideBuilder.html): `--glob` semantics.
- [`grep-regex` 0.1.14 `RegexMatcherBuilder`](https://docs.rs/grep-regex/0.1.14/grep_regex/struct.RegexMatcherBuilder.html): `line_terminator`, `word`, `fixed_strings`, `case_insensitive`.
- [`grep-matcher` 0.1.9 `Matcher`](https://docs.rs/grep-matcher/0.1.9/grep_matcher/trait.Matcher.html): `find_iter`.
- [ripgrep user guide, automatic filtering](https://github.com/BurntSushi/ripgrep/blob/master/GUIDE.md#automatic-filtering): which ignore files apply and the Git repository requirement.
- [App Store Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) (last updated 2026-06-08): 2.5.2 self-contained apps; 4.7 software outside the binary.
- [ios_system](https://github.com/holzschu/ios_system) v3.0.7, 2026-10-02.
- [a-Shell](https://github.com/holzschu/a-shell): ios_system commands and WebAssembly commands on iOS; App Store 2.2.2, 2026-09-21.
- [brush](https://github.com/reubeno/brush): `brush-core` 0.5.0 and `brush-coreutils-builtins` 0.1.0, 2026-05-03.
- [uutils coreutils releases](https://github.com/uutils/coreutils/releases): 0.12.0, 2026-09-17; [`uu_cat::uumain`](https://docs.rs/uu_cat/latest/uu_cat/fn.uumain.html).
- [WasmKit](https://github.com/swiftwasm/WasmKit) 0.4.1, 2026-09-29; [Swift SDKs for WebAssembly](https://forums.swift.org/t/swift-sdks-for-webassembly-now-available-on-swift-org/80405).
- [Wasmtime stability tiers](https://docs.wasmtime.dev/stability-tiers.html): `aarch64-apple-ios` is Tier 3.
- [FSFE, 2026-04-20](https://fsfe.org/news/2026/news-20260420-01.en.html): Apple's answer on JIT for a non-browser terminal app.
