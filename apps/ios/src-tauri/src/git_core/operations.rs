use super::*;

pub(super) fn action(
    ctx: &Context<'_>,
    repo: &mut Repository,
    method: &str,
    params: &Value,
) -> Result<Value> {
    ctx.check_cancel()?;
    match method {
        "merge" => merge(ctx, repo, params)?,
        "cherryPick" | "revert" => apply_commit(ctx, repo, method, params)?,
        "continue" | "abort" => recover(ctx, repo, method, params)?,
        _ => {
            return Err(Error::new(
                "METHOD_NOT_FOUND",
                "Unknown repository operation",
            ))
        }
    }
    Ok(json!({"ok": true}))
}

pub(super) fn create_commit(
    ctx: &Context<'_>,
    repo: &mut Repository,
    message: &str,
    author: Option<&Signature<'_>>,
    allow_empty: bool,
) -> Result<Oid> {
    let mut parents = head(repo).into_iter().collect::<Vec<_>>();
    let operation = status::operation(repo);
    if operation == Some("merge") {
        ctx.git(repo.mergehead_foreach(|id| {
            parents.push(*id);
            true
        }))?;
    }
    let signature = signature(repo, ctx.credentials)?;
    let mut index = ctx.git(repo.index())?;
    if index.has_conflicts() {
        return Err(Error::new(
            "CONFLICT",
            "Resolve and stage all conflicted files first",
        ));
    }
    let tree_id = ctx.git(index.write_tree())?;
    if !allow_empty
        && (parents.is_empty() && index.is_empty()
            || parents.len() == 1
                && parents.first().is_some_and(|id| {
                    repo.find_commit(*id)
                        .ok()
                        .is_some_and(|commit| commit.tree_id() == tree_id)
                }))
    {
        return Err(Error::new("GIT_FAILED", "Nothing to commit"));
    }
    let parents = parents
        .into_iter()
        .map(|id| ctx.git(repo.find_commit(id)))
        .collect::<Result<Vec<_>>>()?;
    let tree = ctx.git(repo.find_tree(tree_id))?;
    let current = ctx.git(repo.find_reference("HEAD"))?;
    if let Some(reference) = ctx.git(current.symbolic_target())? {
        confine_ref(ctx, repo, reference)?;
    }
    ctx.check_cancel()?;
    let parents = parents.iter().collect::<Vec<_>>();
    let author = author.unwrap_or(&signature);
    let id = match &ctx.credentials.signer {
        None => ctx.git(repo.commit(Some("HEAD"), author, &signature, message, &tree, &parents))?,
        Some(signer) => {
            let buffer =
                ctx.git(repo.commit_create_buffer(author, &signature, message, &tree, &parents))?;
            let content = std::str::from_utf8(&buffer)
                .map_err(|_| Error::new("GIT_FAILED", "Commit content is not UTF-8"))?;
            let armored = signer
                .sign(content.as_bytes())
                .map_err(|error| Error::new("COMMIT_SIGNING", error.to_string()))?;
            let id = ctx.git(repo.commit_signed(content, &armored, None))?;
            advance_head(
                ctx,
                repo,
                id,
                parents.first().map(|parent| parent.id()),
                message,
            )?;
            id
        }
    };
    if matches!(operation, Some("merge" | "cherry-pick" | "revert")) {
        ctx.git(repo.cleanup_state())?;
    }
    Ok(id)
}

/// `commit_signed` writes only the object, so move HEAD the way `Repository::commit` does.
fn advance_head(
    ctx: &Context<'_>,
    repo: &Repository,
    id: Oid,
    parent: Option<Oid>,
    message: &str,
) -> Result<()> {
    let summary = message.lines().next().unwrap_or_default();
    let log = match parent {
        None => format!("commit (initial): {summary}"),
        Some(_) => format!("commit: {summary}"),
    };
    let head = ctx.git(repo.find_reference("HEAD"))?;
    let Some(branch) = ctx.git(head.symbolic_target())? else {
        return ctx.git(repo.set_head_detached(id));
    };
    match parent {
        Some(parent) => ctx.git(repo.reference_matching(branch, id, true, parent, &log)),
        None => ctx.git(repo.reference(branch, id, false, &log)),
    }?;
    Ok(())
}

fn merge(ctx: &Context<'_>, repo: &mut Repository, params: &Value) -> Result<()> {
    status::clean(ctx, repo, "Commit or stash disk changes before merging")?;
    let target_id = commit(repo, &params["ref"])?.id();
    let annotated = ctx.git(repo.find_annotated_commit(target_id))?;
    let (analysis, preference) = ctx.git(repo.merge_analysis(&[&annotated]))?;
    if analysis.is_up_to_date() {
        return Ok(());
    }
    let target = ctx.git(repo.find_commit(target_id))?;
    let tree = ctx.git(target.tree())?;
    confine_index(ctx, repo)?;
    confine_tree(ctx, &tree)?;
    if analysis.is_unborn() || analysis.is_fast_forward() && !preference.is_no_fast_forward() {
        let current = ctx.git(repo.find_reference("HEAD"))?;
        let reference = ctx
            .git(current.symbolic_target())?
            .ok_or_else(|| Error::invalid("Choose a local branch before merging"))?;
        confine_ref(ctx, repo, reference)?;
        let mut checkout = ctx.checkout();
        ctx.check_cancel()?;
        ctx.git(repo.checkout_tree(tree.as_object(), Some(&mut checkout)))?;
        ctx.git(repo.reference(reference, target_id, true, "merge: fast-forward"))?;
        return Ok(());
    }
    if preference.is_fastforward_only() {
        return Err(Error::new(
            "GIT_FAILED",
            "Fast-forward merge is not possible",
        ));
    }
    signature(repo, ctx.credentials)?;
    if let Some(id) = head(repo) {
        ctx.git(repo.reference("ORIG_HEAD", id, true, "merge: original head"))?;
    }
    let mut checkout = ctx.checkout();
    checkout.allow_conflicts(true).conflict_style_merge(true);
    ctx.check_cancel()?;
    ctx.git(repo.merge(&[&annotated], None, Some(&mut checkout)))?;
    drop(checkout);
    drop(tree);
    drop(target);
    drop(annotated);
    if ctx.git(repo.index())?.has_conflicts() {
        return Err(Error::new(
            "GIT_FAILED",
            "Merge conflicts require resolution",
        ));
    }
    let message = ctx.git(repo.message())?;
    create_commit(ctx, repo, &clean_message(&message), None, true)?;
    Ok(())
}

fn apply_commit(
    ctx: &Context<'_>,
    repo: &mut Repository,
    method: &str,
    params: &Value,
) -> Result<()> {
    confirmed(params, "Confirm applying this commit to the current branch")?;
    status::clean(
        ctx,
        repo,
        "Commit or stash disk changes and finish the current operation first",
    )?;
    signature(repo, ctx.credentials)?;
    let source = commit(repo, &params["ref"])?;
    if source.parent_count() > 1 {
        return Err(Error::new(
            "GIT_FAILED",
            "Applying a merge commit requires choosing a mainline parent",
        ));
    }
    let source_id = source.id();
    let author = source.author().to_owned();
    let message = source.message().unwrap_or("").to_owned();
    confine_index(ctx, repo)?;
    confine_tree(ctx, &ctx.git(source.tree())?)?;
    if source.parent_count() > 0 {
        confine_tree(
            ctx,
            &ctx.git(source.parent(0).and_then(|parent| parent.tree()))?,
        )?;
    }
    let mut checkout = ctx.checkout();
    checkout.allow_conflicts(true).conflict_style_merge(true);
    ctx.check_cancel()?;
    if method == "cherryPick" {
        let mut options = git2::CherrypickOptions::new();
        options.checkout_builder(checkout);
        ctx.git(repo.cherrypick(&source, Some(&mut options)))?;
    } else {
        let mut options = git2::RevertOptions::new();
        options.checkout_builder(checkout);
        ctx.git(repo.revert(&source, Some(&mut options)))?;
    }
    drop(source);
    if ctx.git(repo.index())?.has_conflicts() {
        return Err(Error::new(
            "GIT_FAILED",
            "Commit conflicts require resolution",
        ));
    }
    if method == "cherryPick" {
        create_commit(ctx, repo, &message, Some(&author), false)?;
    } else {
        let message = repo.message().unwrap_or_else(|_| {
            format!(
                "Revert \"{}\"\n\nThis reverts commit {source_id}.\n",
                message.lines().next().unwrap_or("")
            )
        });
        create_commit(ctx, repo, &clean_message(&message), None, false)?;
    }
    Ok(())
}

fn recover(ctx: &Context<'_>, repo: &mut Repository, method: &str, params: &Value) -> Result<()> {
    let operation = status::operation(repo).ok_or_else(stale)?;
    if params["operation"] != operation {
        return Err(stale());
    }
    if method == "abort" {
        confirmed(params, "Confirm aborting the operation")?;
    }
    if method == "continue" && ctx.git(repo.index())?.has_conflicts() {
        return Err(Error::new(
            "CONFLICT",
            "Resolve and stage all conflicted files first",
        ));
    }
    if operation == "rebase" {
        return rebase(ctx, repo, method);
    }
    if matches!(
        repo.state(),
        git2::RepositoryState::CherryPickSequence | git2::RepositoryState::RevertSequence
    ) {
        return Err(Error::new(
            "UNSUPPORTED",
            "Finish this multi-commit sequence with desktop Git",
        ));
    }
    confine_index(ctx, repo)?;
    if method == "abort" {
        let current = head(repo)
            .ok_or_else(|| Error::new("GIT_FAILED", "Repository has no commit to restore"))?;
        let original = if operation == "merge" {
            repo.find_reference("ORIG_HEAD")
                .ok()
                .and_then(|reference| reference.target())
                .unwrap_or(current)
        } else {
            current
        };
        let target = ctx.git(repo.find_commit(original))?;
        confine_tree(ctx, &ctx.git(target.tree())?)?;
        let mut checkout = ctx.checkout();
        checkout.force();
        ctx.check_cancel()?;
        ctx.git(repo.reset(
            target.as_object(),
            git2::ResetType::Hard,
            Some(&mut checkout),
        ))?;
        ctx.git(repo.cleanup_state())?;
    } else {
        let message = ctx.git(repo.message())?;
        let author = if operation == "cherry-pick" {
            let id = ctx
                .git(repo.find_reference("CHERRY_PICK_HEAD"))?
                .target()
                .ok_or_else(|| Error::new("GIT_FAILED", "Cherry-pick commit is missing"))?;
            Some(ctx.git(repo.find_commit(id))?.author().to_owned())
        } else {
            None
        };
        create_commit(
            ctx,
            repo,
            &clean_message(&message),
            author.as_ref(),
            operation == "merge",
        )?;
    }
    Ok(())
}

fn rebase(ctx: &Context<'_>, repo: &Repository, method: &str) -> Result<()> {
    confine_index(ctx, repo)?;
    let mut checkout = ctx.checkout();
    checkout.allow_conflicts(true).conflict_style_merge(true);
    let mut options = git2::RebaseOptions::new();
    options.checkout_options(checkout);
    let mut rebase = ctx.git(repo.open_rebase(Some(&mut options)))?;
    if let Some(name) = ctx.git(rebase.orig_head_name())? {
        confine_ref(ctx, repo, name)?;
    }
    if method == "abort" {
        if let Some(id) = rebase.orig_head_id() {
            confine_tree(
                ctx,
                &ctx.git(repo.find_commit(id).and_then(|commit| commit.tree()))?,
            )?;
        }
        ctx.check_cancel()?;
        return ctx.git(rebase.abort());
    }
    let signature = signature(repo, ctx.credentials)?;
    for index in 0..rebase.len() {
        let operation = rebase
            .nth(index)
            .ok_or_else(|| Error::new("GIT_FAILED", "Rebase operation is missing"))?;
        if operation.kind() != Some(git2::RebaseOperationType::Pick) {
            return Err(Error::new(
                "UNSUPPORTED",
                "Finish this interactive rebase with desktop Git",
            ));
        }
        confine_tree(
            ctx,
            &ctx.git(
                repo.find_commit(operation.id())
                    .and_then(|commit| commit.tree()),
            )?,
        )?;
    }
    if rebase.operation_current().is_some() {
        rebase_commit(ctx, &mut rebase, &signature)?;
    }
    loop {
        ctx.check_cancel()?;
        match rebase.next() {
            None => break,
            Some(operation) => {
                ctx.git(operation)?;
            }
        }
        if ctx.git(repo.index())?.has_conflicts() {
            return Err(Error::new(
                "GIT_FAILED",
                "Rebase conflicts require resolution",
            ));
        }
        rebase_commit(ctx, &mut rebase, &signature)?;
    }
    ctx.git(rebase.finish(Some(&signature)))
}

fn rebase_commit(
    ctx: &Context<'_>,
    rebase: &mut git2::Rebase<'_>,
    signature: &Signature<'_>,
) -> Result<()> {
    match rebase.commit(None, signature, None) {
        Ok(_) => Ok(()),
        Err(error) if error.code() == git2::ErrorCode::Applied => Ok(()),
        Err(error) => ctx.git::<()>(Err(error)),
    }
}

fn clean_message(message: &str) -> String {
    message
        .lines()
        .filter(|line| !line.starts_with('#'))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_owned()
}

fn stale() -> Error {
    Error::new(
        "STALE_STATE",
        "The repository operation changed. Refresh before continuing.",
    )
}
