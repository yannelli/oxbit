use super::*;
use git2::{BranchType, Status, StatusOptions};

pub(super) fn empty() -> Value {
    json!({"repository": false, "branch": "", "branches": [], "refs": [],
        "changes": [], "remotes": [], "ahead": 0, "behind": 0})
}

pub(super) fn changes(ctx: &Context<'_>, repo: &Repository) -> Result<Vec<Value>> {
    let mut options = StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true)
        .renames_index_to_workdir(false);
    let entries = ctx.git(repo.statuses(Some(&mut options)))?;
    let index = ctx.git(repo.index())?;
    let mut changes = Vec::new();
    for entry in entries.iter() {
        ctx.check_cancel()?;
        let flags = entry.status();
        let delta = entry.head_to_index().or_else(|| entry.index_to_workdir());
        let path = delta
            .as_ref()
            .and_then(|delta| delta.new_file().path())
            .and_then(Path::to_str)
            .map(str::to_owned)
            .unwrap_or(ctx.git(entry.path())?.to_owned());
        let (index_status, working) = if flags.contains(Status::CONFLICTED) {
            let conflict = ctx.git(index.conflict_get(Path::new(&path)))?;
            match (
                conflict.ancestor.is_some(),
                conflict.our.is_some(),
                conflict.their.is_some(),
            ) {
                (true, false, false) => ("D", "D"),
                (false, true, false) => ("A", "U"),
                (true, true, false) => ("U", "D"),
                (false, false, true) => ("U", "A"),
                (true, false, true) => ("D", "U"),
                (false, true, true) => ("A", "A"),
                _ => ("U", "U"),
            }
        } else if flags.contains(Status::WT_NEW)
            && !flags.intersects(
                Status::INDEX_NEW
                    | Status::INDEX_MODIFIED
                    | Status::INDEX_RENAMED
                    | Status::INDEX_TYPECHANGE,
            )
        {
            ("?", "?")
        } else {
            (code(flags, true), code(flags, false))
        };
        let mut change = json!({"path": path, "index": index_status, "working": working,
            "conflict": flags.contains(Status::CONFLICTED)});
        if flags.contains(Status::INDEX_RENAMED) {
            if let Some(original) = entry
                .head_to_index()
                .and_then(|delta| delta.old_file().path())
                .and_then(Path::to_str)
            {
                change["originalPath"] = json!(original);
            }
        }
        changes.push(change);
    }
    changes.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
    Ok(changes)
}

fn code(flags: Status, staged: bool) -> &'static str {
    let mapping = if staged {
        [
            (Status::INDEX_NEW, "A"),
            (Status::INDEX_DELETED, "D"),
            (Status::INDEX_RENAMED, "R"),
            (Status::INDEX_TYPECHANGE, "T"),
            (Status::INDEX_MODIFIED, "M"),
        ]
    } else {
        [
            (Status::WT_NEW, "?"),
            (Status::WT_DELETED, "D"),
            (Status::WT_RENAMED, "R"),
            (Status::WT_TYPECHANGE, "T"),
            (Status::WT_MODIFIED, "M"),
        ]
    };
    mapping
        .into_iter()
        .find(|(flag, _)| flags.contains(*flag))
        .map(|(_, code)| code)
        .unwrap_or(" ")
}

pub(super) fn operation(repo: &Repository) -> Option<&'static str> {
    use git2::RepositoryState::*;
    match repo.state() {
        Merge => Some("merge"),
        CherryPick | CherryPickSequence => Some("cherry-pick"),
        Revert | RevertSequence => Some("revert"),
        Rebase | RebaseInteractive | RebaseMerge | ApplyMailboxOrRebase => Some("rebase"),
        _ => None,
    }
}

pub(super) fn get(ctx: &Context<'_>, repo: &Repository) -> Result<Value> {
    let head_id = head(repo);
    let current = repo.find_reference("HEAD").ok().and_then(|reference| {
        reference
            .symbolic_target()
            .ok()
            .flatten()
            .map(str::to_owned)
    });
    let branch = current
        .as_deref()
        .and_then(|name| name.strip_prefix("refs/heads/"))
        .map(str::to_owned)
        .unwrap_or_else(|| {
            format!(
                "(detached {})",
                head_id
                    .map(|id| id.to_string()[..7].to_owned())
                    .unwrap_or_else(|| "HEAD".into())
            )
        });
    let mut refs = Vec::new();
    let mut branches = Vec::new();
    let mut upstream = None;
    let mut ahead = 0;
    let mut behind = 0;
    for item in ctx.git(repo.branches(None))? {
        let (item, kind) = ctx.git(item)?;
        let reference = item.get();
        if ctx.git(reference.symbolic_target())?.is_some() {
            continue;
        }
        let name = ctx
            .git(item.name())?
            .ok_or_else(|| Error::invalid("Branch name is not UTF-8"))?;
        let remote = kind == BranchType::Remote;
        let commit = ctx.git(reference.peel_to_commit())?;
        let is_current = current.as_deref() == Some(ctx.git(reference.name())?);
        let mut row = json!({"name": name, "ref": ctx.git(reference.name())?,
            "remote": remote, "current": is_current, "commit": commit.id().to_string(),
            "subject": ctx.git(commit.summary())?.unwrap_or("")});
        if !remote {
            branches.push(name.to_owned());
            if let Ok(tracking) = item.upstream() {
                if let Ok(tracking_name) = tracking.get().shorthand() {
                    row["upstream"] = json!(tracking_name);
                    if is_current {
                        upstream = Some(tracking_name.to_owned());
                        if let (Some(local), Some(target)) = (head_id, tracking.get().target()) {
                            if let Ok(counts) = repo.graph_ahead_behind(local, target) {
                                (ahead, behind) = counts;
                            }
                        }
                    }
                }
            }
        }
        refs.push(row);
    }
    refs.sort_by(|a, b| a["ref"].as_str().cmp(&b["ref"].as_str()));
    branches.sort();
    let mut remotes = Vec::new();
    for name in ctx.git(repo.remotes())?.iter() {
        let name = ctx
            .git(name)?
            .ok_or_else(|| Error::invalid("Invalid remote name"))?;
        let remote = ctx.git(repo.find_remote(name))?;
        let fetch = ctx.git(remote.url())?;
        let push = ctx.git(remote.pushurl())?.unwrap_or(fetch);
        remotes.push(json!({"name": name, "fetchUrl": fetch, "pushUrl": push}));
    }
    let mut result = json!({"repository": true, "branch": branch, "branches": branches,
        "refs": refs, "changes": changes(ctx, repo)?, "remotes": remotes,
        "ahead": ahead, "behind": behind});
    if let Some(id) = head_id {
        result["head"] = json!(id.to_string());
    }
    if let Some(name) = upstream {
        result["upstream"] = json!(name);
    }
    if let Some(operation) = operation(repo) {
        result["operation"] = json!(operation);
    }
    Ok(result)
}

pub(super) fn clean(ctx: &Context<'_>, repo: &Repository, message: &str) -> Result<()> {
    if !changes(ctx, repo)?.is_empty() || operation(repo).is_some() {
        return Err(Error::new("DIRTY_WORKTREE", message));
    }
    Ok(())
}
