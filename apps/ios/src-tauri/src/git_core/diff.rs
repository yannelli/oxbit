use super::*;
use git2::{ApplyLocation, ApplyOptions, Diff, DiffFormat, DiffOptions};

pub(super) fn options(path: Option<&str>, reverse: bool) -> DiffOptions {
    let mut options = DiffOptions::new();
    options
        .context_lines(3)
        .disable_pathspec_match(true)
        .reverse(reverse);
    if let Some(path) = path {
        options.pathspec(path);
    }
    options
}

pub(super) fn print(ctx: &Context<'_>, diff: &Diff<'_>) -> Result<String> {
    let mut text = Vec::new();
    let mut limited = false;
    let result = diff.print(DiffFormat::Patch, |_, _, line| {
        if ctx.cancel.load(Ordering::Relaxed) {
            return false;
        }
        if text.len() + line.content().len() + 1 > MAX_BYTES {
            limited = true;
            return false;
        }
        if matches!(line.origin(), ' ' | '+' | '-') {
            text.push(line.origin() as u8);
        }
        text.extend_from_slice(line.content());
        true
    });
    if limited {
        return Err(Error::new(
            "OUTPUT_LIMIT",
            "This diff is too large to preview. Use whole-file actions.",
        ));
    }
    ctx.git(result)?;
    Ok(String::from_utf8_lossy(&text).into_owned())
}

pub(super) fn tree_bytes(
    repo: &Repository,
    tree: Option<&Tree<'_>>,
    path: &str,
) -> Result<Vec<u8>> {
    let Some(tree) = tree else {
        return Ok(Vec::new());
    };
    let entry = match tree.get_path(Path::new(path)) {
        Ok(entry) => entry,
        Err(error) if error.code() == git2::ErrorCode::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(git_error(error)),
    };
    if entry.kind() != Some(git2::ObjectType::Blob) {
        return Ok(Vec::new());
    }
    let blob = repo.find_blob(entry.id()).map_err(git_error)?;
    preview_size(blob.size())?;
    Ok(blob.content().to_vec())
}

fn index_bytes(repo: &Repository, path: &str) -> Result<Vec<u8>> {
    let index = repo.index().map_err(git_error)?;
    let Some(entry) = index.get_path(Path::new(path), 0) else {
        return Ok(Vec::new());
    };
    if entry.mode == 0o160000 {
        return Ok(Vec::new());
    }
    let blob = repo.find_blob(entry.id).map_err(git_error)?;
    preview_size(blob.size())?;
    Ok(blob.content().to_vec())
}

fn preview_size(size: usize) -> Result<()> {
    if size > MAX_BYTES / 2 {
        Err(Error::new(
            "OUTPUT_LIMIT",
            "This file is too large to preview. Use whole-file actions.",
        ))
    } else {
        Ok(())
    }
}

pub(super) fn tree_diff<'a>(
    ctx: &Context<'_>,
    repo: &'a Repository,
    before: Option<&Tree<'a>>,
    after: Option<&Tree<'a>>,
    path: Option<&str>,
    original: Option<&str>,
) -> Result<Diff<'a>> {
    let mut options = options(path, false);
    if let Some(original) = original {
        options.pathspec(original);
    }
    let mut diff = ctx.git(repo.diff_tree_to_tree(before, after, Some(&mut options)))?;
    let mut find = git2::DiffFindOptions::new();
    find.renames(true);
    ctx.git(diff.find_similar(Some(&mut find)))?;
    Ok(diff)
}

fn working_diff<'a>(
    ctx: &Context<'_>,
    repo: &'a Repository,
    path: &str,
    staged: bool,
    original: Option<&str>,
    reverse: bool,
) -> Result<Diff<'a>> {
    let mut options = options(Some(path), reverse);
    if let Some(original) = original {
        options.pathspec(original);
    }
    if staged {
        let tree = head(repo)
            .map(|id| repo.find_commit(id).and_then(|commit| commit.tree()))
            .transpose()
            .map_err(git_error)?;
        let mut result =
            ctx.git(repo.diff_tree_to_index(tree.as_ref(), None, Some(&mut options)))?;
        let mut find = git2::DiffFindOptions::new();
        find.renames(true);
        ctx.git(result.find_similar(Some(&mut find)))?;
        Ok(result)
    } else {
        ctx.git(repo.diff_index_to_workdir(None, Some(&mut options)))
    }
}

pub(super) fn snapshot(before: Vec<u8>, after: Vec<u8>, patch: String) -> Value {
    let binary = before.contains(&0) || after.contains(&0) || patch.contains("Binary files ");
    json!({"before": if binary { String::new() } else { String::from_utf8_lossy(&before).into_owned() },
        "after": if binary { String::new() } else { String::from_utf8_lossy(&after).into_owned() },
        "diff": patch, "binary": binary})
}

pub(super) fn get(ctx: &Context<'_>, repo: &Repository, params: &Value) -> Result<Value> {
    let path = ctx.path(required(params, "path")?)?;
    let staged = params["staged"] == true;
    let changes = status::changes(ctx, repo)?;
    let change = changes.iter().find(|change| change["path"] == path);
    let original = change.and_then(|change| change["originalPath"].as_str());
    let diff = working_diff(ctx, repo, &path, staged, original, false)?;
    let patch = print(ctx, &diff)?;
    let before = if staged {
        let tree = head(repo)
            .map(|id| repo.find_commit(id).and_then(|commit| commit.tree()))
            .transpose()
            .map_err(git_error)?;
        tree_bytes(repo, tree.as_ref(), original.unwrap_or(&path))?
    } else {
        index_bytes(repo, &path)?
    };
    let after = if staged {
        index_bytes(repo, &path)?
    } else {
        let full = ctx.root.resolve(&path)?;
        match fs::symlink_metadata(&full) {
            Ok(metadata) => {
                preview_size(metadata.len() as usize)?;
                if metadata.file_type().is_symlink() {
                    fs::read_link(&full)
                        .map_err(|error| Error::new("GIT_FAILED", error.to_string()))?
                        .as_os_str()
                        .as_encoded_bytes()
                        .to_vec()
                } else if metadata.is_dir() {
                    Vec::new()
                } else {
                    fs::read(&full).map_err(|error| Error::new("GIT_FAILED", error.to_string()))?
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(Error::new("GIT_FAILED", error.to_string())),
        }
    };
    let mut snapshot = snapshot(before, after, patch.clone());
    snapshot["fingerprint"] = json!(fs_core::revision(patch.as_bytes()));
    let can_hunk = snapshot["binary"] != true
        && !change
            .is_some_and(|change| change["conflict"] == true || change["originalPath"].is_string())
        && !patch.lines().any(|line| {
            [
                "new file",
                "deleted file",
                "old mode",
                "new mode",
                "diff --cc",
            ]
            .iter()
            .any(|prefix| line.starts_with(prefix))
        })
        && patch
            .lines()
            .filter(|line| line.starts_with("diff --git "))
            .count()
            == 1;
    let mut hunks: Vec<Value> = Vec::new();
    if can_hunk {
        for line in patch.split_inclusive('\n') {
            if line.starts_with("@@ ") {
                hunks.push(json!({"index": hunks.len(), "header": line.trim_end_matches('\n'), "patch": line}));
            } else if let Some(hunk) = hunks.last_mut() {
                let mut text = hunk["patch"].as_str().unwrap_or("").to_owned();
                text.push_str(line);
                hunk["patch"] = json!(text);
            }
        }
    }
    snapshot["hunks"] = json!(hunks);
    bounded(snapshot)
}

pub(super) fn apply(ctx: &Context<'_>, repo: &Repository, params: &Value) -> Result<Value> {
    let snapshot = get(ctx, repo, params)?;
    if snapshot["fingerprint"] != params["fingerprint"] {
        return Err(Error::new(
            "STALE_STATE",
            "The diff changed. Refresh it before staging a hunk.",
        ));
    }
    let selected = params["hunk"]
        .as_u64()
        .and_then(|index| usize::try_from(index).ok())
        .filter(|index| {
            snapshot["hunks"]
                .as_array()
                .is_some_and(|hunks| *index < hunks.len())
        })
        .ok_or_else(|| Error::invalid("This change requires a whole-file action"))?;
    let path = ctx.path(required(params, "path")?)?;
    let staged = params["staged"] == true;
    let diff = working_diff(ctx, repo, &path, staged, None, staged)?;
    let mut index = 0;
    let mut options = ApplyOptions::new();
    options.hunk_callback(|_| {
        let apply = index == selected;
        index += 1;
        apply
    });
    ctx.check_cancel()?;
    ctx.git(repo.apply(&diff, ApplyLocation::Index, Some(&mut options)))?;
    Ok(json!({"ok": true}))
}
