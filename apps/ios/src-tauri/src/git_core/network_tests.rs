use super::*;
use std::cell::RefCell;
use std::sync::{Arc, Barrier};
use std::thread;

struct Fixture {
    root: Root,
    repo: Repository,
    remote: Repository,
    credentials: Credentials,
    cancel: AtomicBool,
    progress: RefCell<Vec<String>>,
}

impl Fixture {
    fn new() -> Self {
        let directory =
            std::env::temp_dir().join(format!("oxbit-ios-network-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(directory.join(".fixtures")).unwrap();
        let path = directory.canonicalize().unwrap();
        let root = Root {
            id: fs_core::root_id(&path),
            path,
            name: "Git network test".into(),
        };
        let mut options = git2::RepositoryInitOptions::new();
        options.initial_head("main");
        let repo = Repository::init_opts(&root.path, &options).unwrap();
        options.bare(true);
        let remote =
            Repository::init_opts(root.path.join(".fixtures/remote.git"), &options).unwrap();
        let url = format!("file://{}", remote.path().display());
        repo.remote("origin", &url).unwrap();
        fs::write(root.path.join(".gitignore"), ".fixtures/\n").unwrap();
        let fixture = Self {
            root,
            repo,
            remote,
            credentials: Credentials {
                login: Some("octocat".into()),
                token: Some("credential-fixture".into()),
                name: Some("Oxbit Test".into()),
                email: Some("oxbit@example.test".into()),
                gitea: None,
                signer: None,
            },
            cancel: AtomicBool::new(false),
            progress: RefCell::new(Vec::new()),
        };
        fixture.commit_file("file.txt", "first\n");
        fixture
    }

    fn commit_file(&self, path: &str, content: &str) -> Oid {
        fs::write(self.root.path.join(path), content).unwrap();
        let mut index = self.repo.index().unwrap();
        index.add_path(Path::new(".gitignore")).unwrap();
        index.add_path(Path::new(path)).unwrap();
        index.write().unwrap();
        let tree = self.repo.find_tree(index.write_tree().unwrap()).unwrap();
        let author = Signature::now("Oxbit Test", "oxbit@example.test").unwrap();
        let parents = head(&self.repo).map(|id| self.repo.find_commit(id).unwrap());
        self.repo
            .commit(
                Some("HEAD"),
                &author,
                &author,
                "test: update file",
                &tree,
                &parents.iter().collect::<Vec<_>>(),
            )
            .unwrap()
    }

    fn remote_commit(&self, path: &str, content: &str) -> Oid {
        let parent = self.remote.head().unwrap().peel_to_commit().unwrap();
        let tree = parent.tree().unwrap();
        let mut builder = self.remote.treebuilder(Some(&tree)).unwrap();
        let blob = self.remote.blob(content.as_bytes()).unwrap();
        builder.insert(path, blob, 0o100644).unwrap();
        let tree = self.remote.find_tree(builder.write().unwrap()).unwrap();
        let author = Signature::now("Remote Author", "remote@example.test").unwrap();
        self.remote
            .commit(
                Some("HEAD"),
                &author,
                &author,
                "test: remote change",
                &tree,
                &[&parent],
            )
            .unwrap()
    }

    fn call(&self, method: &str, params: Value) -> Result<Value> {
        let progress = |value: &str| self.progress.borrow_mut().push(value.to_owned());
        let ctx = Context {
            root: &self.root,
            credentials: &self.credentials,
            cancel: &self.cancel,
            progress: &progress,
        };
        network::action(
            &ctx,
            if method == "clone" {
                None
            } else {
                Some(&self.repo)
            },
            method,
            &params,
        )
    }

    fn clone_params(&self, destination: &str) -> Value {
        json!({"url": format!("file://{}", self.remote.path().display()), "destination": destination})
    }

    fn error(&self, method: &str, params: Value) -> &'static str {
        self.call(method, params).unwrap_err().code
    }

    fn publish(&self) {
        assert_eq!(
            self.call("publish", json!({"remote": "origin"})).unwrap(),
            json!({"ok": true})
        );
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root.path);
    }
}

#[test]
fn publishes_and_pushes_to_confined_bare_remote() {
    let fixture = Fixture::new();
    fixture.publish();
    assert_eq!(head(&fixture.remote), head(&fixture.repo));
    let config = fixture.repo.config().unwrap();
    assert_eq!(config.get_string("branch.main.remote").unwrap(), "origin");
    assert_eq!(
        config.get_string("branch.main.merge").unwrap(),
        "refs/heads/main"
    );
    let updated = fixture.commit_file("file.txt", "second\n");
    fixture.call("push", json!({})).unwrap();
    assert_eq!(head(&fixture.remote), Some(updated));
    let progress = fixture.progress.borrow().join("");
    assert!(progress.contains("Pushing"));
    assert!(!progress.contains("credential-fixture"));
    assert!(!progress.contains("file://"));
}

#[test]
fn fetches_and_prunes_remote_tracking_branches() {
    let fixture = Fixture::new();
    fixture.publish();
    let incoming = fixture.remote_commit("incoming.txt", "remote\n");
    fixture
        .remote
        .reference("refs/heads/feature", incoming, false, "test: create branch")
        .unwrap();
    fixture.call("fetch", json!({})).unwrap();
    assert_eq!(
        fixture
            .repo
            .find_reference("refs/remotes/origin/main")
            .unwrap()
            .target(),
        Some(incoming)
    );
    assert!(fixture
        .repo
        .find_reference("refs/remotes/origin/feature")
        .is_ok());
    fixture
        .remote
        .find_reference("refs/heads/feature")
        .unwrap()
        .delete()
        .unwrap();
    fixture.call("fetch", json!({})).unwrap();
    assert!(fixture
        .repo
        .find_reference("refs/remotes/origin/feature")
        .is_err());
    assert_eq!(
        fs::read_to_string(fixture.root.path.join("file.txt")).unwrap(),
        "first\n"
    );
}

#[test]
fn pulls_fast_forward_and_preserves_ahead_or_diverged_branches() {
    let fixture = Fixture::new();
    fixture.publish();
    let incoming = fixture.remote_commit("incoming.txt", "incoming\n");
    fixture.call("pull", json!({})).unwrap();
    assert_eq!(head(&fixture.repo), Some(incoming));
    assert_eq!(
        fs::read_to_string(fixture.root.path.join("incoming.txt")).unwrap(),
        "incoming\n"
    );
    let local = fixture.commit_file("local.txt", "local\n");
    fixture.call("pull", json!({})).unwrap();
    assert_eq!(head(&fixture.repo), Some(local));
    fixture.remote_commit("diverged.txt", "remote\n");
    assert_eq!(fixture.error("pull", json!({})), "GIT_FAILED");
    assert_eq!(head(&fixture.repo), Some(local));
    assert!(!fixture.root.path.join("diverged.txt").exists());
    assert_eq!(
        fs::read_to_string(fixture.root.path.join("local.txt")).unwrap(),
        "local\n"
    );
}

#[test]
fn refuses_pull_with_disk_changes_or_an_operation() {
    let fixture = Fixture::new();
    fixture.publish();
    let initial = head(&fixture.repo).unwrap();
    fs::write(fixture.root.path.join("file.txt"), "unsaved\n").unwrap();
    assert_eq!(fixture.error("pull", json!({})), "DIRTY_WORKTREE");
    assert_eq!(
        fs::read_to_string(fixture.root.path.join("file.txt")).unwrap(),
        "unsaved\n"
    );
    assert_eq!(head(&fixture.repo), Some(initial));
    fs::write(fixture.root.path.join("file.txt"), "first\n").unwrap();
    fs::write(
        fixture.repo.path().join("MERGE_HEAD"),
        format!("{initial}\n"),
    )
    .unwrap();
    assert_eq!(fixture.error("pull", json!({})), "DIRTY_WORKTREE");
}

#[test]
fn refuses_unpublished_or_rejected_pushes() {
    let fixture = Fixture::new();
    assert_eq!(fixture.error("push", json!({})), "NO_UPSTREAM");
    assert_eq!(fixture.error("pull", json!({})), "NO_UPSTREAM");
    fixture.publish();
    fixture.commit_file("local.txt", "local\n");
    let remote = fixture.remote_commit("remote.txt", "remote\n");
    assert_eq!(fixture.error("push", json!({})), "GIT_FAILED");
    assert_eq!(head(&fixture.remote), Some(remote));
}

#[test]
fn clones_to_normalized_path_and_preserves_existing_destination() {
    let fixture = Fixture::new();
    fixture.publish();
    assert_eq!(
        fixture
            .call("clone", fixture.clone_params(".fixtures//clones/./project"))
            .unwrap(),
        json!({"path": ".fixtures/clones/project"})
    );
    let destination = fixture.root.path.join(".fixtures/clones/project");
    assert_eq!(
        fs::read_to_string(destination.join("file.txt")).unwrap(),
        "first\n"
    );
    assert_eq!(
        head(&Repository::open(&destination).unwrap()),
        head(&fixture.remote)
    );
    assert_eq!(
        fixture.error("clone", fixture.clone_params(".fixtures/clones/project")),
        "EXISTS"
    );
    assert_eq!(
        fs::read_to_string(destination.join("file.txt")).unwrap(),
        "first\n"
    );
    assert!(fixture.progress.borrow().join("").contains("Cloning"));
}

#[test]
fn clone_reservation_preserves_the_successful_clone() {
    let fixture = Fixture::new();
    fixture.publish();
    let barrier = Arc::new(Barrier::new(2));
    let mut workers = Vec::new();
    for _ in 0..2 {
        let root = fixture.root.clone();
        let params = fixture.clone_params(".fixtures/same");
        let barrier = barrier.clone();
        workers.push(thread::spawn(move || {
            let credentials = Credentials::default();
            let cancel = AtomicBool::new(false);
            let ctx = Context {
                root: &root,
                credentials: &credentials,
                cancel: &cancel,
                progress: &|_| {},
            };
            barrier.wait();
            network::action(&ctx, None, "clone", &params)
        }));
    }
    let results = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter_map(|result| result.as_ref().err())
            .next()
            .unwrap()
            .code,
        "EXISTS"
    );
    assert_eq!(
        fs::read_to_string(fixture.root.path.join(".fixtures/same/file.txt")).unwrap(),
        "first\n"
    );
}

#[test]
fn removes_failed_and_cancelled_clone_destinations() {
    let fixture = Fixture::new();
    fixture.publish();
    let mut params = fixture.clone_params(".fixtures/failed");
    params["url"] = json!(format!(
        "file://{}/missing.git",
        fixture.root.path.display()
    ));
    assert_eq!(fixture.error("clone", params), "GIT_FAILED");
    assert!(!fixture.root.path.join(".fixtures/failed").exists());
    fixture.cancel.store(true, Ordering::Relaxed);
    assert_eq!(
        fixture.error("clone", fixture.clone_params(".fixtures/pre-cancelled")),
        "CANCELLED"
    );
    assert!(!fixture.root.path.join(".fixtures/pre-cancelled").exists());
    fixture.cancel.store(false, Ordering::Relaxed);
    let progress = |value: &str| {
        if value.starts_with("Received") {
            fixture.cancel.store(true, Ordering::Relaxed);
        }
    };
    let ctx = Context {
        root: &fixture.root,
        credentials: &fixture.credentials,
        cancel: &fixture.cancel,
        progress: &progress,
    };
    assert_eq!(
        network::action(
            &ctx,
            None,
            "clone",
            &fixture.clone_params(".fixtures/cancelled")
        )
        .unwrap_err()
        .code,
        "CANCELLED"
    );
    assert!(!fixture.root.path.join(".fixtures/cancelled").exists());
}

#[test]
fn refuses_file_remotes_and_destinations_outside_workspace() {
    let fixture = Fixture::new();
    let outside = Fixture::new();
    let ctx = Context {
        root: &fixture.root,
        credentials: &fixture.credentials,
        cancel: &fixture.cancel,
        progress: &|_| {},
    };
    let external_url = format!("file://{}", outside.remote.path().display());
    assert_eq!(
        network::validate_url(&ctx, &external_url).unwrap_err().code,
        "PATH_DENIED"
    );
    std::os::unix::fs::symlink(
        &outside.root.path,
        fixture.root.path.join(".fixtures/escape"),
    )
    .unwrap();
    let escaped_url = format!("file://{}/.fixtures/escape", fixture.root.path.display());
    assert_eq!(
        network::validate_url(&ctx, &escaped_url).unwrap_err().code,
        "PATH_DENIED"
    );
    assert_eq!(
        fixture.error("clone", fixture.clone_params(".fixtures/escape/project")),
        "PATH_DENIED"
    );
    assert!(!outside.root.path.join("project").exists());
}

#[test]
fn confines_file_remote_metadata_before_fetch_push_and_clone() {
    let fixture = Fixture::new();
    fixture.publish();
    let outside = Fixture::new();
    std::os::unix::fs::symlink(
        &outside.root.path,
        fixture.remote.path().join("refs/heads/escape"),
    )
    .unwrap();
    assert_eq!(fixture.error("fetch", json!({})), "PATH_DENIED");
    assert_eq!(fixture.error("push", json!({})), "PATH_DENIED");
    assert_eq!(
        fixture.error("clone", fixture.clone_params(".fixtures/unsafe")),
        "PATH_DENIED"
    );
    assert!(!fixture.root.path.join(".fixtures/unsafe").exists());
}

#[test]
fn validates_repository_urls_and_confines_github_credentials() {
    let fixture = Fixture::new();
    let ctx = Context {
        root: &fixture.root,
        credentials: &fixture.credentials,
        cancel: &fixture.cancel,
        progress: &|_| {},
    };
    for url in [
        "https://github.com/owner/repo.git",
        "https://example.test/repo.git",
        "https://example.test:8443/repo.git",
        "https://[::1]:8443/repo.git",
    ] {
        assert!(network::validate_url(&ctx, url).is_ok(), "{url}");
    }
    let encoded_file = format!(
        "file://{}/.fixtures/space%20remote.git",
        fixture.root.path.display()
    );
    assert!(network::validate_url(&ctx, &encoded_file).is_ok());
    for url in [
        "http://github.com/owner/repo.git",
        "ssh://git@github.com/owner/repo.git",
        "git@github.com:owner/repo.git",
        "https://octocat:token@github.com/owner/repo.git",
        "https://github.com%40example.test/repo.git",
        "https://github.com\\@example.test/repo.git",
        "https://github.com:bad/repo.git",
        "https://github.com/\0",
        "file://localhost/tmp/repo.git",
    ] {
        assert_eq!(
            network::validate_url(&ctx, url).unwrap_err().code,
            "INVALID_PARAMS"
        );
    }
    assert_eq!(
        network::validate_url(&ctx, &format!("https://github.com/{}", "a".repeat(4096)))
            .unwrap_err()
            .code,
        "INVALID_PARAMS"
    );
    let allowed = git2::CredentialType::USER_PASS_PLAINTEXT;
    assert!(network::credentials_for(
        &fixture.credentials,
        "https://github.com/owner/repo.git",
        allowed
    )
    .unwrap()
    .has_username());
    for url in [
        "https://example.test/repo.git",
        "https://github.com:443/repo.git",
        "https://github.com./repo.git",
        "https://github.com.example.test/repo.git",
        "https://github.com@example.test/repo.git",
        "http://github.com/repo.git",
        "ssh://git@github.com/repo.git",
    ] {
        assert!(
            network::credentials_for(&fixture.credentials, url, allowed).is_err(),
            "{url}"
        );
    }
    assert!(network::credentials_for(
        &fixture.credentials,
        "https://github.com/repo.git",
        git2::CredentialType::SSH_KEY
    )
    .is_err());
    assert!(network::credentials_for(
        &Credentials::default(),
        "https://github.com/repo.git",
        allowed
    )
    .is_err());
}

#[test]
fn confines_gitea_credentials_to_the_connected_server() {
    let credentials = Credentials {
        login: Some("octocat".into()),
        token: Some("github-fixture".into()),
        gitea: Some(GiteaCredentials {
            host: Some("git.example.test:3000".into()),
            login: Some("gitea.user_1".into()),
            token: Some("gitea-fixture".into()),
        }),
        ..Credentials::default()
    };
    let allowed = git2::CredentialType::USER_PASS_PLAINTEXT;
    for url in [
        "https://git.example.test:3000/owner/repo.git",
        "https://GIT.example.test:3000/owner/repo.git",
    ] {
        assert!(
            network::credentials_for(&credentials, url, allowed).is_ok(),
            "{url}"
        );
    }
    assert!(
        network::credentials_for(&credentials, "https://github.com/owner/repo.git", allowed)
            .is_ok()
    );
    let default_port = Credentials {
        gitea: Some(GiteaCredentials {
            host: Some("git.example.test".into()),
            login: Some("gitea-user".into()),
            token: Some("gitea-fixture".into()),
        }),
        ..Credentials::default()
    };
    for url in [
        "https://git.example.test/owner/repo.git",
        "https://git.example.test:443/owner/repo.git",
    ] {
        assert!(
            network::credentials_for(&default_port, url, allowed).is_ok(),
            "{url}"
        );
    }
    assert!(network::credentials_for(
        &default_port,
        "https://git.example.test:8443/owner/repo.git",
        allowed
    )
    .is_err());
    for url in [
        "https://git.example.test/owner/repo.git",
        "https://git.example.test:3001/owner/repo.git",
        "https://git.example.test.evil.test:3000/repo.git",
        "https://evil.git.example.test:3000/repo.git",
        "https://user@git.example.test:3000/repo.git",
        "https://git.example.test%3A3000/repo.git",
        "http://git.example.test:3000/repo.git",
        "ssh://git@git.example.test:3000/repo.git",
    ] {
        assert!(
            network::credentials_for(&credentials, url, allowed).is_err(),
            "{url}"
        );
    }
    assert!(network::credentials_for(
        &credentials,
        "https://git.example.test:3000/repo.git",
        git2::CredentialType::SSH_KEY
    )
    .is_err());
    let github_only = Credentials {
        gitea: Some(GiteaCredentials {
            host: Some("git.example.test:3000".into()),
            ..GiteaCredentials::default()
        }),
        ..Credentials::default()
    };
    let error = network::credentials_for(
        &github_only,
        "https://git.example.test:3000/repo.git",
        allowed,
    )
    .err()
    .unwrap();
    assert!(error.message().contains("Connect Gitea"));
    assert_eq!(
        credentials.tokens(),
        vec!["github-fixture", "gitea-fixture"]
    );
}
