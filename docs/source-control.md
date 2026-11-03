# Source Control

Created: 2026-09-08. Last updated: 2026-11-03.

Open **Source Control** in the activity bar. Runtime workspaces use the computer’s Git installation and credential helpers, so GitHub, Gitea, and other HTTPS or SSH remotes work as they do in a terminal. Device folders on iOS use libgit2, with GitHub and Gitea credentials stored in Keychain; the iOS Source Control toolbar opens **Git Accounts and Commit Author**. See [iOS source control](ios-source-control.md) for cloning and authentication.

## Changes and commits

- The header holds the branch picker, one sync button with the ahead and behind counts, the filter and view buttons, and the overflow menu. The sync button publishes, pulls, pushes or syncs, by the branch state; the overflow menu lists the other remote actions.
- Filter changed files by path or switch between list and folder views. The **Staged** and **Unstaged** group headers show their file counts and line totals.
- Review staged changes against HEAD and saved disk changes against the index. Renames show their original paths; binary changes have a clear placeholder.
- Open a text diff and choose **Review hunks** to stage or unstage individual hunks. Each action checks the current patch against the reviewed version. Refresh after a stale-diff error.
- Stage or unstage individual files or all changes. Staging an unsaved file offers to save it or stage its saved content. Bulk staging asks once about unsaved buffers.
- Write a commit message and select **Commit** under the message box, or press Ctrl/Cmd+Enter. Only staged content is committed. With nothing staged, the button reads **Commit All** and stages every change, untracked files included, before it commits.
- After a commit, the line under the Commit button shows the short hash, the subject and **Undo** until HEAD moves. **Undo Last Commit** (also in the Commit menu, runtime workspaces only) runs `git reset --soft HEAD~1`, keeps the files staged and puts the message back in the box. It asks first when the commit is already on the upstream.
- The AI button in the message box writes a commit message. When no AI model is set, the panel shows **Open AI settings**.
- Discard actions require confirmation and preserve unsaved editor buffers.

Per-hunk actions support ordinary tracked text modifications. New/deleted files, renames, binary files, mode changes, and conflicted files use whole-file actions. Git's own patch validation protects the index if it changes during the operation. Large previews return a size-limit message; whole-file staging remains available.

## History

The **History** tab shows the current branch's commits, author, date, short hash, and branch/tag decorations. Choose another local or remote branch, search commit messages, filter by a file path, or load older commits.

Open a commit to browse its files and patches. **Revert Commit** creates an inverse commit; **Cherry-pick Commit** applies the selected change on the current branch. Both require confirmation and a clean working tree. Merge commits are displayed against their first parent; their revert/cherry-pick buttons are disabled because selecting a mainline parent is not yet supported.

## Branches and remotes

The **Branches** tab supports:

- Creating and switching to a local branch from the current HEAD, renaming local branches, and deleting merged branches. Git refuses unsafe branch deletion and branch switches that would overwrite disk changes.
- Tracking a fetched remote branch under a chosen local name.
- Merging a local or remote branch into the current branch with a clean working tree.
- Adding/removing remote configuration and publishing the current branch with upstream tracking. Removing a remote never deletes the remote repository.

The sync button in the header shows the ahead and behind counts against the upstream. **Fetch** updates all remotes and prunes deleted tracking references. **Push** targets the current branch's upstream; **Pull** uses fast-forward only, and refuses divergent histories. Fetch first to refresh counts; if histories diverged, review the remote branch in History and merge it from Branches. This follows [Git's fast-forward pull behavior](https://git-scm.com/docs/git-pull).

## Stashes

Give a stash a message and choose whether to include untracked files. **Stash changes** saves the current disk/index work and cleans those paths. Unsaved editor buffers must be saved before stashing.

Open a stash to review its patch. **Apply** restores it and keeps the stash. **Pop** restores it and removes it only on success. Both restore staged state with `--index` and require a clean working tree. If restoration conflicts, the stash is retained. **Delete** requires confirmation. Stash actions validate both the entry reference and commit ID so a stale list cannot silently target a different stash. See [Git's stash behavior](https://git-scm.com/docs/git-stash).

## Conflicts and recovery

Conflicted files appear under **Merge changes**, separately from staged/unstaged files. Review the conflict, accept current/incoming/both content or edit it manually, then **Save and Stage**. Both ordinary and diff3 conflict markers are supported; remaining conflict markers prevent the UI from staging a resolution.

An in-progress merge, rebase, cherry-pick, or revert exposes **Continue** and **Abort**. Continue requires all conflicts to be resolved and staged. Abort requires confirmation because it discards resolutions. Unsaved files are checked before worktree-changing operations.

Long Git operations expose progress and a cancel button. Mutations use the runtime's durable operation records and are never automatically replayed after reconnect. Refresh and inspect repository state after cancellation or connection loss.

## Scope

This is a single-workspace repository interface. Multi-repository selection, an interactive rebase editor, line-level staging, blame, tag management, force push, and hosting-provider pull requests are not included. External Git operations may still change the workspace; refresh on window focus and filesystem changes keeps the view current. Use **Refresh** after changing only Git metadata in a terminal.

Verification covers real temporary repositories and local bare remotes, plus browser workflows and narrow/dark/light layouts. Hosted authentication and a fresh native desktop launch are separate from these checks.
