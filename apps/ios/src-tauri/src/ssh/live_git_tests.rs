//! Live Git over SSH against the Docker sshd fixture: clone, push, fetch, pull, server errors,
//! and refusal when the saved host key differs. Run with `node scripts/ios/ssh-live.mjs`.
use super::{
    git::{GitConnector, Prompt},
    hosts::{AuthMethod, Host},
    keys,
    known_hosts::KnownHosts,
    live_tests::{env, exec, host_fingerprint},
};
use crate::{
    fs_core::{self, Error, Root},
    git_core::{self, ssh_transport, Credentials},
};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{atomic::AtomicBool, Arc, Mutex},
};

const KEY_ID: &str = "live-key";

fn connector(known: &Arc<KnownHosts>, hosts: Vec<Host>, private_key: &str) -> Arc<GitConnector> {
    let private_key = private_key.to_string();
    Arc::new(GitConnector {
        runtime: tokio::runtime::Handle::current(),
        known: known.clone(),
        hosts,
        binding: None,
        private_key: Box::new(move |id| {
            if id == KEY_ID {
                Ok(private_key.clone())
            } else {
                Err(Error::new("KEY_INVALID", "Unknown key"))
            }
        }),
        cancel: Arc::new(AtomicBool::new(false)),
        prompt: Mutex::new(None),
    })
}

fn root(path: &Path) -> Root {
    let mut roots = fs_core::Roots::default();
    let opened = roots.open(path).unwrap();
    roots.get(&opened.id).unwrap().clone()
}

struct Run {
    result: fs_core::Result<Value>,
    prompt: Option<Prompt>,
    progress: Vec<String>,
}

async fn git(root: &Root, connector: &Arc<GitConnector>, method: &str, params: Value) -> Run {
    let (root, connector, method) = (root.clone(), connector.clone(), method.to_string());
    tokio::task::spawn_blocking(move || {
        let credentials = Credentials {
            ssh: Some(connector.clone()),
            ..Credentials::default()
        };
        let progress = Mutex::new(Vec::new());
        let result = git_core::dispatch(
            &root,
            &method,
            &params,
            &credentials,
            &AtomicBool::new(false),
            &|data| progress.lock().unwrap().push(data.to_string()),
        );
        Run {
            result,
            prompt: connector.take_prompt(),
            progress: progress.into_inner().unwrap(),
        }
    })
    .await
    .unwrap()
}

fn commit(path: &Path, file: &str, message: &str) {
    let repo = git2::Repository::open(path).unwrap();
    std::fs::write(path.join(file), format!("{message}\n")).unwrap();
    let mut index = repo.index().unwrap();
    index.add_path(Path::new(file)).unwrap();
    index.write().unwrap();
    let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
    let signature = git2::Signature::now("Oxbit Live", "live@example.test").unwrap();
    let parent = repo.head().unwrap().peel_to_commit().unwrap();
    repo.commit(
        Some("HEAD"),
        &signature,
        &signature,
        message,
        &tree,
        &[&parent],
    )
    .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the Docker sshd fixture"]
async fn live_git_over_ssh() {
    ssh_transport::register().unwrap();
    let container = env("OXBIT_SSH_TEST_CONTAINER");
    let port: u16 = env("OXBIT_SSH_TEST_PORT").parse().unwrap();
    let key_text = std::fs::read_to_string(env("OXBIT_SSH_TEST_KEY")).unwrap();
    let imported =
        keys::import("Live", &key_text, Some(&env("OXBIT_SSH_TEST_PASSPHRASE"))).unwrap();
    exec(
        &container,
        "rm -rf /root/remote.git /tmp/seed && git init -q --bare -b main /root/remote.git && \
         git clone -q /root/remote.git /tmp/seed && cd /tmp/seed && echo hello > README.md && \
         git add README.md && git -c user.name=Seed -c user.email=seed@example.test commit -q -m Seed && \
         git push -q origin main",
    );
    let directory = std::env::temp_dir().join(format!("oxbit-git-live-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory).unwrap();
    let workspace = root(&directory);
    let known = Arc::new(KnownHosts::new(directory.join(".known_hosts.json")));
    let url = format!("ssh://root@127.0.0.1:{port}/root/remote.git");
    let clone = json!({ "url": url, "destination": "clone" });

    let unbound = connector(&known, Vec::new(), &imported.private_key);
    let run = git(&workspace, &unbound, "clone", clone.clone()).await;
    assert_eq!(run.result.unwrap_err().code, "SSH_KEY_REQUIRED");
    assert_eq!(
        run.prompt,
        Some(Prompt::KeyRequired {
            hostname: "127.0.0.1".into(),
            port,
            username: "root".into()
        })
    );
    assert!(!directory.join("clone").exists());
    println!("PASS key prompt without a saved host");

    let hosts = vec![Host {
        id: uuid::Uuid::new_v4().to_string(),
        label: "Fixture".into(),
        hostname: "127.0.0.1".into(),
        port,
        username: "root".into(),
        auth: AuthMethod::Key,
        key_id: Some(KEY_ID.into()),
        password_saved: false,
    }];
    let saved = connector(&known, hosts, &imported.private_key);
    let run = git(&workspace, &saved, "clone", clone.clone()).await;
    assert_eq!(run.result.unwrap_err().code, "HOST_KEY_UNKNOWN");
    let Some(Prompt::HostUnknown { host_key }) = run.prompt else {
        panic!("expected a first-use prompt");
    };
    assert_eq!(host_key.fingerprint, host_fingerprint(&container));
    known
        .trust(
            "127.0.0.1",
            port,
            &host_key.algorithm,
            &host_key.fingerprint,
        )
        .unwrap();
    println!("PASS first-use prompt shows the server fingerprint");

    let run = git(&workspace, &saved, "clone", clone.clone()).await;
    run.result.unwrap();
    let cloned = directory.join("clone");
    assert_eq!(
        std::fs::read_to_string(cloned.join("README.md")).unwrap(),
        "hello\n"
    );
    assert!(run
        .progress
        .iter()
        .all(|line| !line.contains("PRIVATE KEY")));
    println!("PASS clone over ssh://");

    let repository = root(&cloned);
    commit(&cloned, "device.txt", "From the device");
    git(&repository, &saved, "push", json!({}))
        .await
        .result
        .unwrap();
    assert_eq!(
        exec(
            &container,
            "git -C /root/remote.git log -1 --format=%s main"
        ),
        "From the device"
    );
    println!("PASS push");

    exec(
        &container,
        "cd /tmp/seed && git pull -q && echo server > server.txt && git add server.txt && \
         git -c user.name=Seed -c user.email=seed@example.test commit -q -m Server && git push -q origin main",
    );
    git(&repository, &saved, "fetch", json!({}))
        .await
        .result
        .unwrap();
    git(&repository, &saved, "pull", json!({}))
        .await
        .result
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(cloned.join("server.txt")).unwrap(),
        "server\n"
    );
    println!("PASS fetch and pull");

    let missing = json!({
        "url": format!("ssh://root@127.0.0.1:{port}/root/missing.git"),
        "destination": "missing",
    });
    let error = git(&workspace, &saved, "clone", missing)
        .await
        .result
        .unwrap_err();
    assert_eq!(error.code, "GIT_FAILED");
    assert!(error.message.contains("missing.git"), "{}", error.message);
    println!("PASS server error reaches the caller: {}", error.message);

    let stale = Arc::new(KnownHosts::new(directory.join(".stale_known_hosts.json")));
    let previous = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    stale
        .trust("127.0.0.1", port, &host_key.algorithm, previous)
        .unwrap();
    let changed_connector = connector(&stale, saved.hosts.clone(), &imported.private_key);
    let run = git(&repository, &changed_connector, "fetch", json!({})).await;
    assert_eq!(run.result.unwrap_err().code, "HOST_KEY_CHANGED");
    let Some(Prompt::HostChanged {
        host_key: changed,
        known: saved_keys,
    }) = run.prompt
    else {
        panic!("expected a changed host key");
    };
    assert_eq!(saved_keys[0].fingerprint, previous);
    assert_eq!(changed.fingerprint, host_key.fingerprint);
    println!("PASS a changed host key refuses the fetch");
    std::fs::remove_dir_all(&directory).unwrap();
}
