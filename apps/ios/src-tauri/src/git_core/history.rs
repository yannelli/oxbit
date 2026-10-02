use super::*;

pub(super) fn read(
    ctx: &Context<'_>,
    repo: &mut Repository,
    method: &str,
    params: &Value,
) -> Result<Value> {
    match method {
        "log" => log(ctx, repo, params),
        "show" => show(ctx, repo, &params["ref"]),
        "commitDiff" => commit_diff(ctx, repo, params),
        "stashes" => stashes(ctx, repo),
        "stashDiff" => {
            let (_, id) = stash(ctx, repo, params)?;
            let commit = ctx.git(repo.find_commit(id))?;
            let base = ctx.git(commit.parent(0).and_then(|parent| parent.tree()))?;
            let tree = ctx.git(commit.tree())?;
            let changes = diff::tree_diff(ctx, repo, Some(&base), Some(&tree), None, None)?;
            let mut patch = diff::print(ctx, &changes)?;
            if commit.parent_count() > 2 {
                let untracked = ctx.git(commit.parent(2).and_then(|parent| parent.tree()))?;
                let changes = diff::tree_diff(ctx, repo, None, Some(&untracked), None, None)?;
                patch.push_str(&diff::print(ctx, &changes)?);
            }
            bounded(json!({"diff": patch}))
        }
        _ => Err(Error::new("METHOD_NOT_FOUND", "Unknown Git read operation")),
    }
}

fn page(params: &Value, key: &str, default: u64, max: u64) -> Result<usize> {
    let value = match params.get(key) {
        None => default,
        Some(value) => value
            .as_u64()
            .ok_or_else(|| Error::invalid("Invalid history page"))?,
    };
    if value > max || key == "limit" && value == 0 {
        return Err(Error::invalid("Invalid history page"));
    }
    Ok(value as usize)
}

fn log(ctx: &Context<'_>, repo: &Repository, params: &Value) -> Result<Value> {
    let limit = page(params, "limit", 40, 100)?;
    let skip = page(params, "skip", 0, 100000)?;
    let start = match params.get("ref") {
        Some(reference) if reference != "" && !reference.is_null() => {
            Some(commit(repo, reference)?.id())
        }
        _ => head(repo),
    };
    let Some(start) = start else {
        return Ok(json!({"commits": [], "hasMore": false}));
    };
    let path = params
        .get("path")
        .map(|value| {
            value
                .as_str()
                .ok_or_else(|| Error::invalid("Invalid path"))
                .and_then(|path| ctx.path(path))
        })
        .transpose()?;
    let search = match params.get("search") {
        None => String::new(),
        Some(value) => value
            .as_str()
            .filter(|search| search.len() <= 1024)
            .ok_or_else(|| Error::invalid("Invalid search"))?
            .to_lowercase(),
    };
    let mut walk = ctx.git(repo.revwalk())?;
    ctx.git(walk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME))?;
    ctx.git(walk.push(start))?;
    let mut found = 0;
    let mut commits = Vec::new();
    for id in walk {
        ctx.check_cancel()?;
        let commit = ctx.git(repo.find_commit(ctx.git(id)?))?;
        if !search.is_empty()
            && !commit
                .message()
                .unwrap_or("")
                .to_lowercase()
                .contains(&search)
        {
            continue;
        }
        if let Some(path) = &path {
            let tree = ctx.git(commit.tree())?;
            let parent = if commit.parent_count() > 0 {
                Some(ctx.git(commit.parent(0).and_then(|parent| parent.tree()))?)
            } else {
                None
            };
            let changes =
                diff::tree_diff(ctx, repo, parent.as_ref(), Some(&tree), Some(path), None)?;
            if changes.deltas().len() == 0 {
                continue;
            }
        }
        found += 1;
        if found <= skip {
            continue;
        }
        commits.push(row(repo, &commit)?);
        if commits.len() > limit {
            break;
        }
    }
    let more = commits.len() > limit;
    commits.truncate(limit);
    bounded(json!({"commits": commits, "hasMore": more}))
}

pub(super) fn row(repo: &Repository, commit: &Commit<'_>) -> Result<Value> {
    let author = commit.author();
    let current = repo.head().ok();
    let mut refs = Vec::new();
    for reference in repo.references().map_err(git_error)? {
        let reference = reference.map_err(git_error)?;
        if reference.symbolic_target().map_err(git_error)?.is_some() {
            continue;
        }
        if reference
            .peel_to_commit()
            .ok()
            .is_some_and(|item| item.id() == commit.id())
        {
            let name = reference.shorthand().map_err(git_error)?;
            let label = if reference.is_tag() {
                format!("tag: {name}")
            } else if current
                .as_ref()
                .is_some_and(|head| head.name().ok() == reference.name().ok())
            {
                format!("HEAD -> {name}")
            } else {
                name.to_owned()
            };
            refs.push(label);
        }
    }
    if repo.head_detached().unwrap_or(false) && head(repo) == Some(commit.id()) {
        refs.push("HEAD".into());
    }
    refs.sort();
    Ok(json!({"id": commit.id().to_string(),
        "parents": commit.parent_ids().map(|id| id.to_string()).collect::<Vec<_>>(),
        "author": author.name().map_err(git_error)?, "date": date(author.when()),
        "subject": commit.summary().map_err(git_error)?.unwrap_or(""), "body": commit.body().map_err(git_error)?.unwrap_or("").trim(),
        "refs": refs.join(", ")}))
}

pub(super) fn date(time: git2::Time) -> String {
    let offset = time.offset_minutes();
    let seconds = time.seconds() + i64::from(offset) * 60;
    let days = seconds.div_euclid(86400);
    let clock = seconds.rem_euclid(86400);
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    if month <= 2 {
        year += 1;
    }
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}{}{:02}:{:02}",
        clock / 3600,
        clock / 60 % 60,
        clock % 60,
        if offset < 0 { '-' } else { '+' },
        offset.abs() / 60,
        offset.abs() % 60
    )
}

pub(super) fn files(changes: &git2::Diff<'_>) -> Result<Vec<Value>> {
    let mut statuses = Vec::new();
    changes
        .print(git2::DiffFormat::NameStatus, |_, _, line| {
            let text = String::from_utf8_lossy(line.content());
            statuses.push(text.split_whitespace().next().unwrap_or("").to_owned());
            true
        })
        .map_err(git_error)?;
    Ok(changes.deltas().enumerate().filter_map(|(index, delta)| {
        let path = delta.new_file().path().or_else(|| delta.old_file().path())?.to_str()?;
        let code = match delta.status() {
            git2::Delta::Added => "A", git2::Delta::Deleted => "D", git2::Delta::Modified => "M",
            git2::Delta::Renamed => "R", git2::Delta::Copied => "C", git2::Delta::Typechange => "T",
            _ => "M",
        };
        let mut file = json!({"path": path, "status": statuses.get(index).map(String::as_str).unwrap_or(code)});
        if matches!(delta.status(), git2::Delta::Renamed | git2::Delta::Copied) {
            if let Some(original) = delta.old_file().path().and_then(Path::to_str) {
                file["originalPath"] = json!(original);
            }
        }
        Some(file)
    }).collect())
}

fn show(ctx: &Context<'_>, repo: &Repository, reference: &Value) -> Result<Value> {
    let commit = commit(repo, reference)?;
    let tree = ctx.git(commit.tree())?;
    let parent = if commit.parent_count() > 0 {
        Some(ctx.git(commit.parent(0).and_then(|parent| parent.tree()))?)
    } else {
        None
    };
    let changes = diff::tree_diff(ctx, repo, parent.as_ref(), Some(&tree), None, None)?;
    bounded(json!({"commit": row(repo, &commit)?, "files": files(&changes)?}))
}

fn commit_diff(ctx: &Context<'_>, repo: &Repository, params: &Value) -> Result<Value> {
    let path = ctx.path(required(params, "path")?)?;
    let detail = show(ctx, repo, &params["ref"])?;
    let file = detail["files"]
        .as_array()
        .and_then(|files| files.iter().find(|file| file["path"] == path))
        .ok_or_else(|| Error::new("NOT_FOUND", "File is not part of this commit"))?;
    let commit = commit(repo, &params["ref"])?;
    let tree = ctx.git(commit.tree())?;
    let parent = if commit.parent_count() > 0 {
        Some(ctx.git(commit.parent(0).and_then(|parent| parent.tree()))?)
    } else {
        None
    };
    let original = file["originalPath"].as_str();
    let before = diff::tree_bytes(repo, parent.as_ref(), original.unwrap_or(&path))?;
    let after = diff::tree_bytes(repo, Some(&tree), &path)?;
    let changes = diff::tree_diff(
        ctx,
        repo,
        parent.as_ref(),
        Some(&tree),
        Some(&path),
        original,
    )?;
    bounded(diff::snapshot(before, after, diff::print(ctx, &changes)?))
}

pub(super) fn stashes(ctx: &Context<'_>, repo: &mut Repository) -> Result<Value> {
    let mut entries = Vec::new();
    ctx.git(repo.stash_foreach(|index, message, id| {
        entries.push((index, message.to_owned(), *id));
        !ctx.cancel.load(Ordering::Relaxed)
    }))?;
    let mut stashes = Vec::new();
    for (index, message, id) in entries {
        let commit = ctx.git(repo.find_commit(id))?;
        stashes.push(
            json!({"id": id.to_string(), "ref": format!("stash@{{{index}}}"),
            "message": message, "date": date(commit.author().when())}),
        );
    }
    bounded(json!(stashes))
}

pub(super) fn stash(
    ctx: &Context<'_>,
    repo: &mut Repository,
    params: &Value,
) -> Result<(usize, Oid)> {
    let entries = stashes(ctx, repo)?;
    entries
        .as_array()
        .and_then(|stashes| {
            stashes
                .iter()
                .enumerate()
                .find(|(_, stash)| stash["ref"] == params["ref"] && stash["id"] == params["id"])
        })
        .map(|(index, stash)| {
            Oid::from_str(stash["id"].as_str().unwrap_or(""))
                .map(|id| (index, id))
                .map_err(git_error)
        })
        .unwrap_or_else(|| {
            Err(Error::new(
                "STALE_STATE",
                "The stash list changed. Refresh it before retrying.",
            ))
        })
}
