use crate::fs_core::{self, Error, Result, Root};
use git2::{build::CheckoutBuilder, Commit, Oid, Repository, Signature, Tree};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};

mod actions;
mod diff;
mod history;
mod network;
#[cfg(test)]
mod network_tests;
#[cfg(test)]
mod operation_tests;
mod operations;
#[cfg(test)]
mod security_tests;
#[cfg(test)]
mod signing_tests;
mod status;
#[cfg(test)]
mod tests;

const MAX_BYTES: usize = 2 * 1024 * 1024;

#[derive(Default, Deserialize)]
pub struct Credentials {
    pub name: Option<String>,
    pub email: Option<String>,
    #[serde(default)]
    pub accounts: Vec<Account>,
    /// The account ID chosen for this workspace in Git Accounts and Commit Author.
    #[serde(skip)]
    pub binding: Option<String>,
    #[serde(skip)]
    pub signer: Option<tauri_plugin_oxbit_files::CommitSigner>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub host: String,
    pub login: String,
    pub token: String,
    pub is_default: bool,
}

impl Credentials {
    pub fn tokens(&self) -> Vec<&str> {
        self.accounts
            .iter()
            .map(|account| account.token.as_str())
            .collect()
    }
}

/// Methods that reach `operations::create_commit`, so the host loads the signing key only for them.
pub fn creates_commit(method: &str) -> bool {
    matches!(
        method.strip_prefix("git.").unwrap_or(method),
        "commit" | "merge" | "cherryPick" | "revert" | "continue"
    )
}

struct Context<'a> {
    root: &'a Root,
    credentials: &'a Credentials,
    cancel: &'a AtomicBool,
    progress: &'a dyn Fn(&str),
}

pub fn dispatch(
    root: &Root,
    method: &str,
    params: &Value,
    credentials: &Credentials,
    cancel: &AtomicBool,
    progress: &dyn Fn(&str),
) -> Result<Value> {
    let ctx = Context {
        root,
        credentials,
        cancel,
        progress,
    };
    ctx.check_cancel()?;
    if !params.is_object() {
        return Err(Error::invalid("Git parameters must be an object"));
    }
    let method = method.strip_prefix("git.").unwrap_or(method);
    let result = match method {
        "status" => match open(root) {
            Ok(repo) => status::get(&ctx, &repo),
            Err(error) if error.code == "NOT_REPOSITORY" => Ok(status::empty()),
            Err(error) => Err(error),
        },
        "init" => {
            root.resolve(".git")?;
            if root.path.join(".git").exists() {
                open(root)?;
            }
            let mut opts = git2::RepositoryInitOptions::new();
            opts.initial_head("main");
            ctx.git(Repository::init_opts(&root.path, &opts))?;
            Ok(json!({"ok": true}))
        }
        "clone" => network::action(&ctx, None, method, params),
        _ => {
            let mut repo = open(root)?;
            match method {
                "diff" => diff::get(&ctx, &repo, params),
                "hunk" => diff::apply(&ctx, &repo, params),
                "log" | "show" | "commitDiff" | "stashes" | "stashDiff" => {
                    history::read(&ctx, &mut repo, method, params)
                }
                "fetch" | "push" | "publish" | "pull" => {
                    network::action(&ctx, Some(&repo), method, params)
                }
                "merge" | "continue" | "abort" | "cherryPick" | "revert" => {
                    operations::action(&ctx, &mut repo, method, params)
                }
                _ => actions::action(&ctx, &mut repo, method, params),
            }
        }
    }?;
    bounded(result)
}

impl Context<'_> {
    fn check_cancel(&self) -> Result<()> {
        if self.cancel.load(Ordering::Relaxed) {
            Err(Error::new("CANCELLED", "Operation was cancelled"))
        } else {
            Ok(())
        }
    }

    fn git<T>(&self, result: std::result::Result<T, git2::Error>) -> Result<T> {
        match result {
            Ok(value) => Ok(value),
            Err(_) if self.cancel.load(Ordering::Relaxed) => {
                Err(Error::new("CANCELLED", "Operation was cancelled"))
            }
            Err(error) => Err(git_error(error)),
        }
    }

    fn path(&self, relative: &str) -> Result<String> {
        if relative.split('/').any(|part| part == "..") {
            return Err(Error::new("PATH_DENIED", "Path escapes the workspace"));
        }
        let path = fs_core::normalize(relative, false)?;
        if path
            .split('/')
            .any(|part| part.eq_ignore_ascii_case(".git"))
        {
            return Err(Error::new(
                "PATH_DENIED",
                "Git metadata is not a file action target",
            ));
        }
        self.root.resolve(&path)?;
        Ok(path)
    }

    fn checkout(&self) -> CheckoutBuilder<'_> {
        let mut options = CheckoutBuilder::new();
        options
            .safe()
            .notify_on(git2::CheckoutNotificationType::all());
        options.notify(|_, path, _, _, _| {
            !self.cancel.load(Ordering::Relaxed)
                && path
                    .and_then(Path::to_str)
                    .is_some_and(|path| self.path(path).is_ok())
        });
        options
    }
}

fn required<'a>(params: &'a Value, key: &str) -> Result<&'a str> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 4096 && !value.contains('\0'))
        .ok_or_else(|| Error::invalid(format!("Invalid {key}")))
}

fn confirmed(params: &Value, message: &str) -> Result<()> {
    if params["confirm"] == true {
        Ok(())
    } else {
        Err(Error::new("CONFIRM_REQUIRED", message))
    }
}

fn git_error(error: git2::Error) -> Error {
    Error::new("GIT_FAILED", error.message())
}

fn open(root: &Root) -> Result<Repository> {
    root.resolve(".git")?;
    let repo = Repository::open_ext(
        &root.path,
        git2::RepositoryOpenFlags::NO_SEARCH,
        &[] as &[&std::ffi::OsStr],
    )
    .map_err(|error| {
        if error.code() == git2::ErrorCode::NotFound {
            Error::new("NOT_REPOSITORY", "Workspace is not a Git repository")
        } else {
            git_error(error)
        }
    })?;
    confine_metadata(root, &repo)?;
    if repo.workdir().is_none() {
        return Err(Error::new(
            "NOT_REPOSITORY",
            "Bare repositories have no workspace files",
        ));
    }
    if repo
        .workdir()
        .and_then(|path| path.canonicalize().ok())
        .as_deref()
        != Some(root.path.as_path())
    {
        return Err(Error::new(
            "PATH_DENIED",
            "Repository working directory must match the workspace",
        ));
    }
    Ok(repo)
}

fn confine_metadata(root: &Root, repo: &Repository) -> Result<()> {
    for directory in [Some(repo.path()), Some(repo.commondir()), repo.workdir()]
        .into_iter()
        .flatten()
    {
        let canonical = directory
            .canonicalize()
            .map_err(|error| Error::new("GIT_FAILED", error.to_string()))?;
        if !canonical.starts_with(&root.path) {
            return Err(Error::new(
                "PATH_DENIED",
                "Repository metadata escapes the workspace",
            ));
        }
    }
    for directory in [
        "objects",
        "objects/pack",
        "objects/info",
        "refs",
        "refs/heads",
        "refs/remotes",
        "refs/tags",
        "logs",
        "logs/refs",
        "config",
        "index",
        "HEAD",
        "ORIG_HEAD",
        "MERGE_HEAD",
        "MERGE_MSG",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "rebase-merge",
        "rebase-apply",
    ] {
        let target = repo.path().join(directory);
        let relative = target
            .strip_prefix(&root.path)
            .map_err(|_| Error::new("PATH_DENIED", "Repository metadata escapes the workspace"))?;
        root.resolve(
            relative
                .to_str()
                .ok_or_else(|| Error::invalid("Invalid repository path"))?,
        )?;
    }
    let mut pending = vec![
        repo.path().join("refs"),
        repo.path().join("logs"),
        repo.path().join("objects"),
    ];
    let mut seen = std::collections::BTreeSet::new();
    while let Some(directory) = pending.pop() {
        if !directory.exists() {
            continue;
        }
        let canonical = directory
            .canonicalize()
            .map_err(|error| Error::new("GIT_FAILED", error.to_string()))?;
        if !seen.insert(canonical) {
            continue;
        }
        for entry in
            fs::read_dir(&directory).map_err(|error| Error::new("GIT_FAILED", error.to_string()))?
        {
            let entry = entry.map_err(|error| Error::new("GIT_FAILED", error.to_string()))?;
            let kind = entry
                .file_type()
                .map_err(|error| Error::new("GIT_FAILED", error.to_string()))?;
            if kind.is_symlink() {
                let path = entry.path();
                let relative = path.strip_prefix(&root.path).map_err(|_| {
                    Error::new("PATH_DENIED", "Repository metadata escapes the workspace")
                })?;
                root.resolve(
                    relative
                        .to_str()
                        .ok_or_else(|| Error::invalid("Invalid repository path"))?,
                )?;
            }
            if kind.is_dir() {
                pending.push(entry.path());
            }
        }
    }
    Ok(())
}

fn confine_ref(ctx: &Context<'_>, repo: &Repository, reference: &str) -> Result<()> {
    if !reference.starts_with("refs/") || !git2::Reference::is_valid_name(reference) {
        return Err(Error::invalid("Invalid Git reference"));
    }
    for path in [
        repo.commondir().join(reference),
        repo.commondir().join("logs").join(reference),
    ] {
        let relative = path
            .strip_prefix(&ctx.root.path)
            .map_err(|_| Error::new("PATH_DENIED", "Repository metadata escapes the workspace"))?;
        ctx.root.resolve(
            relative
                .to_str()
                .ok_or_else(|| Error::invalid("Invalid Git reference path"))?,
        )?;
    }
    Ok(())
}

fn head(repo: &Repository) -> Option<Oid> {
    repo.head().ok().and_then(|reference| reference.target())
}

fn commit<'a>(repo: &'a Repository, value: &Value) -> Result<Commit<'a>> {
    let reference = value
        .as_str()
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 1024
                && !value.starts_with('-')
                && !value.contains('\0')
        })
        .ok_or_else(|| Error::invalid("Choose a valid commit or branch"))?;
    repo.revparse_single(reference)
        .and_then(|object| object.peel_to_commit())
        .map_err(git_error)
}

fn branch_name(value: &Value) -> Result<&str> {
    let name = value
        .as_str()
        .filter(|name| {
            !name.is_empty()
                && name.len() <= 240
                && !name.starts_with('-')
                && !name.starts_with("refs/")
                && !name.contains("@{")
                && git2::Reference::is_valid_name(&format!("refs/heads/{name}"))
        })
        .ok_or_else(|| Error::invalid("Enter a valid branch name"))?;
    Ok(name)
}

fn signature<'a>(repo: &Repository, credentials: &Credentials) -> Result<Signature<'a>> {
    if let Ok(signature) = repo.signature() {
        return Ok(signature);
    }
    if let (Some(name), Some(email)) = (&credentials.name, &credentials.email) {
        if !name.trim().is_empty() && !email.trim().is_empty() {
            return Signature::now(name.trim(), email.trim()).map_err(git_error);
        }
    }
    Err(Error::new(
        "IDENTITY_REQUIRED",
        "Set your Git name and email in Git Accounts and Commit Author from the Source Control toolbar",
    ))
}

fn confine_index(ctx: &Context<'_>, repo: &Repository) -> Result<()> {
    let index = ctx.git(repo.index())?;
    for entry in index.iter() {
        let path = std::str::from_utf8(&entry.path)
            .map_err(|_| Error::invalid("Git file path is not UTF-8"))?;
        ctx.path(path)?;
    }
    Ok(())
}

fn confine_tree(ctx: &Context<'_>, tree: &Tree<'_>) -> Result<()> {
    let mut failure = None;
    let result = tree.walk(git2::TreeWalkMode::PreOrder, |base, entry| {
        let result = entry
            .name()
            .map_err(git_error)
            .and_then(|name| ctx.path(&format!("{base}{name}")));
        match result {
            Ok(_) => git2::TreeWalkResult::Ok,
            Err(error) => {
                failure = Some(error);
                git2::TreeWalkResult::Abort
            }
        }
    });
    if let Some(error) = failure {
        return Err(error);
    }
    ctx.git(result)
}

fn bounded(value: Value) -> Result<Value> {
    let bytes =
        serde_json::to_vec(&value).map_err(|error| Error::new("GIT_FAILED", error.to_string()))?;
    if bytes.len() > MAX_BYTES - 4096 {
        return Err(Error::new("OUTPUT_LIMIT", "This Git result is too large to preview. Narrow the history filter or use whole-file actions."));
    }
    Ok(value)
}
