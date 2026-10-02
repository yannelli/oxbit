use super::*;
use git2::{BranchType, Index, IndexEntry, IndexTime};
use std::collections::BTreeSet;

pub(super) fn action(
    ctx: &Context<'_>,
    repo: &mut Repository,
    method: &str,
    params: &Value,
) -> Result<Value> {
    ctx.check_cancel()?;
    match method {
        "stage" | "stageAll" => stage(ctx, repo, params, method == "stageAll")?,
        "unstage" | "unstageAll" => unstage(ctx, repo, params, method == "unstageAll")?,
        "discard" => {
            confirmed(params, "Confirm discarding disk changes")?;
            let path = ctx.path(required(params, "path")?)?;
            let index = ctx.git(repo.index())?;
            if index.get_path(Path::new(&path), 0).is_none() {
                ctx.root.delete(&path)?;
            } else {
                let mut options = ctx.checkout();
                options.force().path(&path).disable_pathspec_match(true);
                ctx.git(repo.checkout_index(None, Some(&mut options)))?;
            }
        }
        "restore" => {
            let path = ctx.path(required(params, "path")?)?;
            let tree = ctx.git(repo.head().and_then(|head| head.peel_to_tree()))?;
            let entry = ctx.git(tree.get_path(Path::new(&path)))?;
            let blob = ctx.git(repo.find_blob(entry.id()))?;
            if blob.size() > fs_core::MAX_READ_BYTES as usize {
                return Err(Error::new("TOO_LARGE", "File exceeds 20 MiB"));
            }
            if let Some(parent) = Path::new(&path)
                .parent()
                .and_then(Path::to_str)
                .filter(|parent| !parent.is_empty())
            {
                ctx.root.mkdir(parent)?;
            }
            let result = ctx.root.write(&path, blob.content(), None)?;
            return serde_json::to_value(result)
                .map_err(|error| Error::new("GIT_FAILED", error.to_string()));
        }
        "commit" => {
            let message = required(params, "message")?;
            if message.trim().is_empty() {
                return Err(Error::invalid("Commit message is required"));
            }
            let id = operations::create_commit(ctx, repo, message, None, false)?;
            return Ok(json!({"commit": id.to_string()}));
        }
        "checkout" => {
            let name = branch_name(&params["branch"])?;
            let branch = ctx.git(repo.find_branch(name, BranchType::Local))?;
            let target = ctx.git(branch.get().peel_to_commit())?;
            switch(ctx, repo, &format!("refs/heads/{name}"), &target)?;
        }
        "branchCreate" | "branchTrack" => create_branch(ctx, repo, method, params)?,
        "branchRename" => {
            let old = branch_name(&params["branch"])?;
            let name = branch_name(&params["name"])?;
            confine_ref(ctx, repo, &format!("refs/heads/{old}"))?;
            confine_ref(ctx, repo, &format!("refs/heads/{name}"))?;
            let mut branch = ctx.git(repo.find_branch(old, BranchType::Local))?;
            ctx.git(branch.rename(name, false))?;
        }
        "branchDelete" => {
            confirmed(params, "Confirm deleting the local branch")?;
            let name = branch_name(&params["branch"])?;
            confine_ref(ctx, repo, &format!("refs/heads/{name}"))?;
            let mut branch = ctx.git(repo.find_branch(name, BranchType::Local))?;
            if branch.is_head() {
                return Err(Error::new("GIT_FAILED", "Cannot delete the current branch"));
            }
            let target = ctx.git(branch.get().peel_to_commit())?.id();
            let merged_into = branch
                .upstream()
                .ok()
                .and_then(|upstream| upstream.get().target())
                .or_else(|| head(repo));
            if !merged_into.is_some_and(|base| {
                base == target || repo.graph_descendant_of(base, target).unwrap_or(false)
            }) {
                return Err(Error::new("GIT_FAILED", "Branch is not fully merged"));
            }
            ctx.git(branch.delete())?;
        }
        "remoteAdd" => {
            let name = required(params, "name")?;
            if !valid_remote(name) {
                return Err(Error::invalid(
                    "Enter a remote name using letters, numbers, dots, hyphens, or underscores",
                ));
            }
            let url = required(params, "url")?;
            network::validate_url(ctx, url)?;
            ctx.git(repo.remote(name, url))?;
        }
        "remoteRemove" => {
            confirmed(params, "Confirm removing the remote")?;
            let name = required(params, "remote")?;
            if !valid_remote(name) {
                return Err(Error::new("NOT_FOUND", "Choose an existing remote"));
            }
            ctx.git(repo.find_remote(name))?;
            ctx.git(repo.remote_delete(name))?;
        }
        "stashSave" | "stashApply" | "stashPop" | "stashDrop" => stash(ctx, repo, method, params)?,
        _ => return Err(Error::new("METHOD_NOT_FOUND", "Unknown Git operation")),
    }
    Ok(json!({"ok": true}))
}

fn valid_remote(name: &str) -> bool {
    let mut characters = name.chars();
    characters
        .next()
        .is_some_and(|first| first.is_ascii_alphanumeric())
        && characters.all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        })
}

fn matches(path: &str, target: &str) -> bool {
    path == target
        || path
            .strip_prefix(target)
            .is_some_and(|rest| rest.starts_with('/'))
}

fn targets(
    ctx: &Context<'_>,
    repo: &Repository,
    relative: Option<&str>,
) -> Result<BTreeSet<String>> {
    let mut targets = BTreeSet::new();
    for change in status::changes(ctx, repo)? {
        let path = change["path"]
            .as_str()
            .ok_or_else(|| Error::invalid("Invalid Git file path"))?;
        if relative.is_none_or(|target| matches(path, target)) {
            targets.insert(ctx.path(path)?);
            if let Some(original) = change["originalPath"].as_str() {
                targets.insert(ctx.path(original)?);
            }
        }
    }
    if let Some(relative) = relative {
        targets.insert(relative.to_owned());
    }
    Ok(targets)
}

fn stage(ctx: &Context<'_>, repo: &Repository, params: &Value, all: bool) -> Result<()> {
    let relative = if all {
        None
    } else {
        Some(ctx.path(required(params, "path")?)?)
    };
    if all
        && status::changes(ctx, repo)?
            .iter()
            .any(|change| change["conflict"] == true)
    {
        return Err(Error::new(
            "CONFLICT",
            "Resolve and stage conflicted files individually first",
        ));
    }
    if all {
        confine_index(ctx, repo)?;
    }
    let paths = targets(ctx, repo, relative.as_deref())?;
    let mut index = ctx.git(repo.index())?;
    for path in paths {
        ctx.check_cancel()?;
        let full = ctx.root.resolve(&path)?;
        match fs::symlink_metadata(&full) {
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) => {
                ctx.git(index.add_path(Path::new(&path)))?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                remove(ctx, &mut index, &path)?;
            }
            Err(error) => return Err(Error::new("GIT_FAILED", error.to_string())),
        }
    }
    ctx.check_cancel()?;
    ctx.git(index.write())
}

fn remove(ctx: &Context<'_>, index: &mut Index, path: &str) -> Result<()> {
    match index.remove_path(Path::new(path)) {
        Ok(()) => Ok(()),
        Err(error) if error.code() == git2::ErrorCode::NotFound => Ok(()),
        Err(error) => ctx.git::<()>(Err(error)),
    }
}

fn unstage(ctx: &Context<'_>, repo: &Repository, params: &Value, all: bool) -> Result<()> {
    let relative = if all {
        None
    } else {
        Some(ctx.path(required(params, "path")?)?)
    };
    let tree = head(repo)
        .map(|id| repo.find_commit(id).and_then(|commit| commit.tree()))
        .transpose()
        .map_err(git_error)?;
    let mut index = ctx.git(repo.index())?;
    if all {
        if let Some(tree) = tree {
            ctx.git(index.read_tree(&tree))?;
        } else {
            ctx.git(index.clear())?;
        }
    } else {
        let requested = relative.as_deref().unwrap_or("");
        let paths = targets(ctx, repo, Some(requested))?;
        let indexed: Vec<String> = index
            .iter()
            .filter_map(|entry| String::from_utf8(entry.path).ok())
            .filter(|path| paths.iter().any(|target| matches(path, target)))
            .collect();
        for path in indexed {
            remove(ctx, &mut index, &path)?;
        }
        if let Some(tree) = tree {
            let mut entries = Vec::new();
            ctx.git(tree.walk(git2::TreeWalkMode::PreOrder, |base, entry| {
                if entry.kind() != Some(git2::ObjectType::Tree) {
                    if let Ok(name) = entry.name() {
                        let path = format!("{base}{name}");
                        if paths.iter().any(|target| matches(&path, target)) {
                            entries.push((path, entry.id(), entry.filemode() as u32));
                        }
                    }
                }
                git2::TreeWalkResult::Ok
            }))?;
            for (path, id, mode) in entries {
                ctx.path(&path)?;
                let entry = IndexEntry {
                    ctime: IndexTime::new(0, 0),
                    mtime: IndexTime::new(0, 0),
                    dev: 0,
                    ino: 0,
                    mode,
                    uid: 0,
                    gid: 0,
                    file_size: 0,
                    id,
                    flags: 0,
                    flags_extended: 0,
                    path: path.into_bytes(),
                };
                ctx.git(index.add(&entry))?;
            }
        }
    }
    ctx.check_cancel()?;
    ctx.git(index.write())
}

pub(super) fn switch(
    ctx: &Context<'_>,
    repo: &Repository,
    reference: &str,
    target: &Commit<'_>,
) -> Result<()> {
    if status::operation(repo).is_some() {
        return Err(Error::new(
            "CONFLICT",
            "Finish the current operation before switching branches",
        ));
    }
    confine_ref(ctx, repo, reference)?;
    confine_index(ctx, repo)?;
    let tree = ctx.git(target.tree())?;
    confine_tree(ctx, &tree)?;
    let mut checkout = ctx.checkout();
    ctx.check_cancel()?;
    ctx.git(repo.checkout_tree(tree.as_object(), Some(&mut checkout)))?;
    ctx.git(repo.set_head(reference))
}

fn create_branch(ctx: &Context<'_>, repo: &Repository, method: &str, params: &Value) -> Result<()> {
    let name = branch_name(&params["name"])?;
    let reference = format!("refs/heads/{name}");
    confine_ref(ctx, repo, &reference)?;
    let (base, upstream) = if method == "branchTrack" {
        let remote_ref = required(params, "ref")?;
        if !remote_ref.starts_with("refs/remotes/") {
            return Err(Error::new("NOT_FOUND", "Remote branch does not exist"));
        }
        let branch = ctx.git(repo.find_reference(remote_ref))?;
        if ctx.git(branch.symbolic_target())?.is_some() {
            return Err(Error::new("NOT_FOUND", "Remote branch does not exist"));
        }
        (
            ctx.git(branch.peel_to_commit())?,
            Some(ctx.git(branch.shorthand())?.to_owned()),
        )
    } else if params
        .get("startPoint")
        .is_some_and(|value| !value.is_null() && value != "")
    {
        (commit(repo, &params["startPoint"])?, None)
    } else if let Some(id) = head(repo) {
        (ctx.git(repo.find_commit(id))?, None)
    } else {
        if status::operation(repo).is_some() {
            return Err(Error::new(
                "CONFLICT",
                "Finish the current operation before switching branches",
            ));
        }
        ctx.git(repo.set_head(&reference))?;
        return Ok(());
    };
    let mut branch = ctx.git(repo.branch(name, &base, false))?;
    let result = switch(ctx, repo, &reference, &base);
    if result.is_err() {
        let _ = branch.delete();
    }
    result?;
    if let Some(upstream) = upstream {
        ctx.git(branch.set_upstream(Some(&upstream)))?;
    }
    Ok(())
}

fn stash(ctx: &Context<'_>, repo: &mut Repository, method: &str, params: &Value) -> Result<()> {
    confine_ref(ctx, repo, "refs/stash")?;
    match method {
        "stashSave" => {
            let message = required(params, "message")?;
            if message.trim().is_empty() {
                return Err(Error::invalid("A stash message is required"));
            }
            let changes = status::changes(ctx, repo)?;
            if status::operation(repo).is_some()
                || changes.iter().any(|change| change["conflict"] == true)
            {
                return Err(Error::new(
                    "CONFLICT",
                    "Finish the current operation before stashing",
                ));
            }
            if changes.is_empty()
                || params["includeUntracked"] != true
                    && changes
                        .iter()
                        .all(|change| change["index"] == "?" && change["working"] == "?")
            {
                return Ok(());
            }
            confine_index(ctx, repo)?;
            for change in changes {
                ctx.path(change["path"].as_str().unwrap_or(""))?;
            }
            let signature = signature(repo, ctx.credentials)?;
            let flags = if params["includeUntracked"] == true {
                git2::StashFlags::INCLUDE_UNTRACKED
            } else {
                git2::StashFlags::empty()
            };
            ctx.check_cancel()?;
            ctx.git(repo.stash_save(&signature, message, Some(flags)))?;
        }
        "stashDrop" => {
            let (index, _) = history::stash(ctx, repo, params)?;
            confirmed(params, "Confirm deleting this stash")?;
            ctx.git(repo.stash_drop(index))?;
        }
        "stashApply" | "stashPop" => {
            let (index, id) = history::stash(ctx, repo, params)?;
            status::clean(
                ctx,
                repo,
                "Commit or stash disk changes before restoring a stash",
            )?;
            confine_index(ctx, repo)?;
            {
                let stash = ctx.git(repo.find_commit(id))?;
                confine_tree(ctx, &ctx.git(stash.tree())?)?;
                if stash.parent_count() > 2 {
                    confine_tree(
                        ctx,
                        &ctx.git(stash.parent(2).and_then(|parent| parent.tree()))?,
                    )?;
                }
            }
            let mut options = git2::StashApplyOptions::new();
            options
                .reinstantiate_index()
                .checkout_options(ctx.checkout());
            options.progress_cb(|_| !ctx.cancel.load(Ordering::Relaxed));
            ctx.check_cancel()?;
            ctx.git(repo.stash_apply(index, Some(&mut options)))?;
            if ctx.git(repo.index())?.has_conflicts() {
                return Err(Error::new(
                    "GIT_FAILED",
                    "Stash conflicts require resolution",
                ));
            }
            if method == "stashPop" {
                ctx.git(repo.stash_drop(index))?;
            }
        }
        _ => return Err(Error::new("METHOD_NOT_FOUND", "Unknown stash operation")),
    }
    Ok(())
}
