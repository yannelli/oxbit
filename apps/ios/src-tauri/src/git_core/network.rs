use super::*;
use git2::{
    build::{CloneLocal, RepoBuilder},
    Cred, CredentialType, FetchOptions, FetchPrune, PushOptions, Remote, RemoteCallbacks,
    RemoteRedirect,
};

fn https_authority(url: &str) -> Result<&str> {
    let remainder = url
        .strip_prefix("https://")
        .ok_or_else(|| Error::invalid("Use an HTTPS or file repository URL"))?;
    let authority = remainder.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() || authority.contains(['@', '%', '\\']) {
        return Err(Error::invalid(
            "Repository URLs must not contain credentials",
        ));
    }
    let (host, port) = if authority.starts_with('[') {
        let end = authority
            .find(']')
            .ok_or_else(|| Error::invalid("Invalid repository host"))?;
        let host = &authority[1..end];
        host.parse::<std::net::Ipv6Addr>()
            .map_err(|_| Error::invalid("Invalid repository host"))?;
        (host, &authority[end + 1..])
    } else {
        let end = authority.find(':').unwrap_or(authority.len());
        let host = &authority[..end];
        if host.is_empty()
            || !host
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b".-".contains(&byte))
        {
            return Err(Error::invalid("Invalid repository host"));
        }
        (host, &authority[end..])
    };
    if host.is_empty()
        || (!port.is_empty()
            && !port
                .strip_prefix(':')
                .and_then(|value| value.parse::<u16>().ok())
                .is_some_and(|value| value > 0))
    {
        return Err(Error::invalid("Invalid repository port"));
    }
    Ok(authority)
}

fn decode_file_path(url: &str) -> Result<String> {
    let path = url
        .strip_prefix("file://")
        .filter(|path| path.starts_with('/'))
        .ok_or_else(|| Error::invalid("Use an HTTPS or file repository URL"))?;
    if path.contains(['?', '#']) {
        return Err(Error::invalid("Invalid file repository URL"));
    }
    let mut decoded = Vec::with_capacity(path.len());
    let mut bytes = path.bytes();
    while let Some(byte) = bytes.next() {
        decoded.push(if byte == b'%' {
            let high = bytes.next().and_then(|byte| (byte as char).to_digit(16));
            let low = bytes.next().and_then(|byte| (byte as char).to_digit(16));
            match (high, low) {
                (Some(high), Some(low)) => (high * 16 + low) as u8,
                _ => return Err(Error::invalid("Invalid file repository URL")),
            }
        } else {
            byte
        });
    }
    let path =
        String::from_utf8(decoded).map_err(|_| Error::invalid("Repository path is not UTF-8"))?;
    if path.contains(['\0', '\\']) {
        return Err(Error::invalid("Invalid file repository URL"));
    }
    Ok(path)
}

pub(super) fn validate_url(ctx: &Context<'_>, url: &str) -> Result<()> {
    if url.is_empty()
        || url.len() > 4096
        || url
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace())
    {
        return Err(Error::invalid("Use an HTTPS or file repository URL"));
    }
    if url.starts_with("https://") {
        https_authority(url)?;
        return Ok(());
    }
    let path = decode_file_path(url)?;
    let relative = Path::new(&path)
        .strip_prefix(&ctx.root.path)
        .map_err(|_| Error::new("PATH_DENIED", "File remotes must be inside the workspace"))?;
    let relative = relative
        .to_str()
        .ok_or_else(|| Error::invalid("Repository path is not UTF-8"))?;
    ctx.root.resolve(relative)?;
    Ok(())
}

pub(super) fn credentials_for(
    credentials: &Credentials,
    url: &str,
    allowed: CredentialType,
) -> std::result::Result<Cred, git2::Error> {
    let authority = if url.len() > 4096
        || url
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace())
        || !allowed.is_user_pass_plaintext()
    {
        None
    } else {
        https_authority(url).ok()
    };
    let gitea = credentials.gitea.as_ref().filter(|gitea| {
        gitea
            .host
            .as_deref()
            .zip(authority)
            .is_some_and(|(host, authority)| {
                !host.is_empty() && host.eq_ignore_ascii_case(authority)
            })
    });
    let (login, token, provider) = match (authority, gitea) {
        (Some("github.com"), _) => (
            credentials.login.as_deref(),
            credentials.token.as_deref(),
            "GitHub",
        ),
        (Some(_), Some(gitea)) => (gitea.login.as_deref(), gitea.token.as_deref(), "Gitea"),
        _ => return Err(git2::Error::from_str(
            "Authentication requires an HTTPS remote on github.com or the connected Gitea server",
        )),
    };
    match (
        login.filter(|value| !value.is_empty()),
        token.filter(|value| !value.is_empty()),
    ) {
        (Some(login), Some(token)) => Cred::userpass_plaintext(login, token),
        _ => Err(git2::Error::from_str(&format!(
            "Connect {provider} in Git Accounts and Commit Author"
        ))),
    }
}

fn cancelled(ctx: &Context<'_>) -> std::result::Result<(), git2::Error> {
    if ctx.cancel.load(Ordering::Relaxed) {
        Err(git2::Error::from_str("Operation was cancelled"))
    } else {
        Ok(())
    }
}

fn callbacks<'a>(ctx: &'a Context<'_>, repo: Option<&'a Repository>) -> RemoteCallbacks<'a> {
    let mut callbacks = RemoteCallbacks::new();
    let mut attempted = false;
    callbacks.credentials(move |url, _, allowed| {
        cancelled(ctx)?;
        if attempted {
            return Err(git2::Error::from_str("Git authentication failed"));
        }
        attempted = true;
        credentials_for(ctx.credentials, url, allowed)
    });
    callbacks.sideband_progress(|_| !ctx.cancel.load(Ordering::Relaxed));
    callbacks.transfer_progress(|progress| {
        (ctx.progress)(&format!(
            "Received {}/{} objects\n",
            progress.received_objects(),
            progress.total_objects()
        ));
        !ctx.cancel.load(Ordering::Relaxed)
    });
    callbacks.update_tips(move |reference, _, _| {
        !ctx.cancel.load(Ordering::Relaxed)
            && repo.is_none_or(|repo| confine_ref(ctx, repo, reference).is_ok())
    });
    callbacks.push_negotiation(|_| cancelled(ctx));
    callbacks.push_transfer_progress(|current, total, _| {
        (ctx.progress)(&format!("Pushed {current}/{total} objects\n"));
    });
    callbacks.push_update_reference(|_, status| {
        if status.is_some() {
            return Err(git2::Error::from_str("Remote rejected the push"));
        }
        Ok(())
    });
    callbacks
}

fn fetch_options<'a>(ctx: &'a Context<'_>, repo: Option<&'a Repository>) -> FetchOptions<'a> {
    let mut options = FetchOptions::new();
    options
        .remote_callbacks(callbacks(ctx, repo))
        .follow_redirects(RemoteRedirect::None)
        .prune(FetchPrune::On);
    options
}

fn file_repository(ctx: &Context<'_>, url: &str) -> Result<Option<Repository>> {
    if !url.starts_with("file://") {
        return Ok(None);
    }
    let repo = ctx.git(Repository::open_ext(
        decode_file_path(url)?,
        git2::RepositoryOpenFlags::NO_SEARCH,
        &[] as &[&std::ffi::OsStr],
    ))?;
    confine_metadata(ctx.root, &repo)?;
    Ok(Some(repo))
}

fn fetch(ctx: &Context<'_>, repo: &Repository, remote: &mut Remote<'_>) -> Result<()> {
    ctx.check_cancel()?;
    let url = ctx.git(remote.url())?;
    validate_url(ctx, url)?;
    file_repository(ctx, url)?;
    (ctx.progress)("Fetching repository...\n");
    ctx.git(remote.fetch(
        &[] as &[&str],
        Some(&mut fetch_options(ctx, Some(repo))),
        None,
    ))?;
    ctx.check_cancel()
}

fn find_remote<'a>(ctx: &Context<'_>, repo: &'a Repository, name: &str) -> Result<Remote<'a>> {
    if name.is_empty() || name.starts_with('-') || name.contains('\0') {
        return Err(Error::new("NOT_FOUND", "Choose an existing remote"));
    }
    match repo.find_remote(name) {
        Ok(remote) => Ok(remote),
        Err(error) if error.code() == git2::ErrorCode::NotFound => {
            Err(Error::new("NOT_FOUND", "Choose an existing remote"))
        }
        Err(error) => ctx.git(Err(error)),
    }
}

fn upstream(
    ctx: &Context<'_>,
    repo: &Repository,
    message: &str,
) -> Result<(String, String, String)> {
    let reference = repo
        .head()
        .map_err(|_| Error::new("NO_UPSTREAM", message))?;
    let branch = ctx
        .git(reference.name())?
        .strip_prefix("refs/heads/")
        .ok_or_else(|| Error::new("NO_UPSTREAM", message))?;
    let config = ctx.git(repo.config())?;
    let remote = config
        .get_string(&format!("branch.{branch}.remote"))
        .map_err(|_| Error::new("NO_UPSTREAM", message))?;
    let target = config
        .get_string(&format!("branch.{branch}.merge"))
        .map_err(|_| Error::new("NO_UPSTREAM", message))?;
    if remote.starts_with('-')
        || !target.starts_with("refs/heads/")
        || !git2::Reference::is_valid_name(&target)
    {
        return Err(Error::invalid("Invalid branch upstream"));
    }
    Ok((branch.to_owned(), remote, target))
}

fn file_url(path: &Path) -> Result<String> {
    let path = path
        .to_str()
        .ok_or_else(|| Error::invalid("Repository path is not UTF-8"))?;
    let encoded = path
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"/-._~".contains(&byte) {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect::<String>();
    Ok(format!("file://{encoded}"))
}

fn push(ctx: &Context<'_>, repo: &Repository, name: &str, refspec: &str) -> Result<()> {
    let mut remote = if name == "." {
        ctx.git(repo.remote_anonymous(&file_url(&ctx.root.path)?))?
    } else {
        find_remote(ctx, repo, name)?
    };
    let url = ctx.git(remote.pushurl())?.unwrap_or(ctx.git(remote.url())?);
    validate_url(ctx, url)?;
    if let Some(local) = file_repository(ctx, url)? {
        let target = refspec
            .split_once(':')
            .map(|(_, target)| target)
            .ok_or_else(|| Error::invalid("Invalid push reference"))?;
        confine_ref(ctx, &local, target)?;
    }
    let mut options = PushOptions::new();
    options
        .remote_callbacks(callbacks(ctx, Some(repo)))
        .follow_redirects(RemoteRedirect::None);
    ctx.check_cancel()?;
    (ctx.progress)("Pushing branch...\n");
    ctx.git(remote.push(&[refspec], Some(&mut options)))
}

fn pull(ctx: &Context<'_>, repo: &Repository) -> Result<()> {
    let (branch, remote, target_ref) =
        upstream(ctx, repo, "Publish or track a remote branch before pulling")?;
    status::clean(ctx, repo, "Commit or stash disk changes before pulling")?;
    let target = if remote == "." {
        ctx.git(repo.find_reference(&target_ref))?
            .peel_to_commit()
            .map_err(git_error)?
    } else {
        fetch(ctx, repo, &mut find_remote(ctx, repo, &remote)?)?;
        ctx.git(repo.find_branch(&branch, git2::BranchType::Local))?
            .upstream()
            .and_then(|branch| branch.get().peel_to_commit())
            .map_err(git_error)?
    };
    let current = head(repo).ok_or_else(|| {
        Error::new(
            "NO_UPSTREAM",
            "Publish or track a remote branch before pulling",
        )
    })?;
    if current == target.id() || ctx.git(repo.graph_descendant_of(current, target.id()))? {
        return Ok(());
    }
    if !ctx.git(repo.graph_descendant_of(target.id(), current))? {
        return Err(Error::new(
            "GIT_FAILED",
            "Cannot fast-forward a diverged branch",
        ));
    }
    confine_index(ctx, repo)?;
    confine_tree(ctx, &ctx.git(target.tree())?)?;
    confine_ref(ctx, repo, &format!("refs/heads/{branch}"))?;
    ctx.check_cancel()?;
    ctx.git(repo.checkout_tree(target.as_object(), Some(&mut ctx.checkout())))?;
    ctx.git(repo.reference_matching(
        &format!("refs/heads/{branch}"),
        target.id(),
        true,
        current,
        "pull: fast-forward",
    ))?;
    Ok(())
}

fn clone(ctx: &Context<'_>, params: &Value) -> Result<Value> {
    let url = required(params, "url")?;
    validate_url(ctx, url)?;
    let relative = ctx.path(required(params, "destination")?)?;
    let destination = ctx.root.resolve(&relative)?;
    ctx.check_cancel()?;
    let parent = destination
        .parent()
        .ok_or_else(|| Error::invalid("Invalid clone destination"))?;
    fs::create_dir_all(parent).map_err(|error| Error::new("IO", error.to_string()))?;
    fs::create_dir(&destination).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            Error::new("EXISTS", "Clone destination already exists")
        } else {
            Error::new("IO", error.to_string())
        }
    })?;
    let result = (|| {
        ctx.check_cancel()?;
        let clone_root = Root {
            id: String::new(),
            name: String::new(),
            path: destination
                .canonicalize()
                .map_err(|error| Error::new("IO", error.to_string()))?,
        };
        let clone_ctx = Context {
            root: &clone_root,
            ..*ctx
        };
        file_repository(ctx, url)?;
        let mut checkout = CheckoutBuilder::new();
        checkout.dry_run();
        let mut builder = RepoBuilder::new();
        builder
            .fetch_options(fetch_options(ctx, None))
            .clone_local(CloneLocal::None)
            .with_checkout(checkout);
        (ctx.progress)("Cloning repository...\n");
        let repo = ctx.git(builder.clone(url, &destination))?;
        open(&clone_root)?;
        if let Some(id) = head(&repo) {
            confine_tree(&clone_ctx, &ctx.git(ctx.git(repo.find_commit(id))?.tree())?)?;
            ctx.check_cancel()?;
            ctx.git(repo.checkout_head(Some(&mut clone_ctx.checkout())))?;
        }
        Ok(json!({"path": relative}))
    })();
    if result.is_err() {
        fs::remove_dir_all(&destination).map_err(|error| Error::new("IO", error.to_string()))?;
    }
    result
}

pub(super) fn action(
    ctx: &Context<'_>,
    repo: Option<&Repository>,
    method: &str,
    params: &Value,
) -> Result<Value> {
    ctx.check_cancel()?;
    if method == "clone" {
        return clone(ctx, params);
    }
    let repo =
        repo.ok_or_else(|| Error::new("NOT_REPOSITORY", "Workspace is not a Git repository"))?;
    match method {
        "fetch" => {
            for name in ctx.git(repo.remotes())?.iter() {
                let name = ctx
                    .git(name)?
                    .ok_or_else(|| Error::invalid("Invalid remote name"))?;
                fetch(ctx, repo, &mut find_remote(ctx, repo, name)?)?;
            }
        }
        "push" => {
            let (_, remote, target) = upstream(ctx, repo, "Publish this branch to a remote first")?;
            push(ctx, repo, &remote, &format!("HEAD:{target}"))?;
        }
        "publish" => {
            let name = params["remote"].as_str().unwrap_or("");
            find_remote(ctx, repo, name)?;
            let reference = repo
                .head()
                .ok()
                .filter(|reference| reference.is_branch())
                .ok_or_else(|| {
                    Error::invalid("Create a commit on a local branch before publishing")
                })?;
            let branch = ctx
                .git(reference.name())?
                .strip_prefix("refs/heads/")
                .ok_or_else(|| {
                    Error::invalid("Create a commit on a local branch before publishing")
                })?;
            let target = format!("refs/heads/{branch}");
            push(ctx, repo, name, &format!("{target}:{target}"))?;
            let mut config = ctx.git(repo.config())?;
            ctx.git(config.set_str(&format!("branch.{branch}.remote"), name))?;
            ctx.git(config.set_str(&format!("branch.{branch}.merge"), &target))?;
        }
        "pull" => pull(ctx, repo)?,
        _ => return Err(Error::new("METHOD_NOT_FOUND", "Unknown Git operation")),
    }
    Ok(json!({"ok": true}))
}
