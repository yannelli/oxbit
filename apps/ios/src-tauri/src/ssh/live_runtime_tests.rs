//! Live remote runtime against the Docker sshd fixture: device-stream and host-download installs,
//! the cached launch, the tunnel, relaunch after a kill, and reconnect after `docker restart`.
use super::{
    connect::{Credential, Outcome, Target},
    keys,
    known_hosts::KnownHosts,
    live_tests::{env, exec, restart},
    runtime_install::{Source, INSTALLING, STARTING},
    runtime_process::{Event, Options},
    runtime_protocol::{Downloader, Install},
    runtime_session::RemoteRuntime,
    session::Pool,
};
use crate::{fs_core::revision, remote_runtime::Download};
use std::{
    path::PathBuf,
    process::Command,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

pub(super) type Seen = Arc<Mutex<Vec<Event>>>;

pub(super) fn payload() -> (PathBuf, String) {
    let directory = PathBuf::from(env("OXBIT_SSH_TEST_PAYLOAD_DIR"));
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(directory.join("manifest.json")).unwrap()).unwrap();
    let sha256 = manifest["platforms"]["linux-x64"]["sha256"]
        .as_str()
        .unwrap()
        .to_string();
    (directory.join("linux-x64.tar.gz"), sha256)
}

/// `url` is what the host downloads; the device side copies the local archive.
pub(super) fn source(url: String, scratch: PathBuf) -> Source {
    let (archive, sha256) = payload();
    let size = std::fs::metadata(&archive).unwrap().len();
    let download = Download { url, sha256, size };
    Source {
        lookup: Arc::new(move |platform| {
            assert_eq!(platform, "linux-x64");
            Ok(download.clone())
        }),
        fetch: Arc::new(move |download| {
            let (archive, copy) = (
                archive.clone(),
                scratch.join(format!("{}.tar.gz", download.sha256)),
            );
            Box::pin(async move {
                std::fs::copy(&archive, &copy).unwrap();
                Ok(copy)
            })
        }),
    }
}

pub(super) async fn start(
    pool: &Arc<Pool>,
    host_id: &str,
    source: Source,
    seen: &Seen,
    keep_alive: Option<u64>,
) -> Arc<RemoteRuntime> {
    let root = "/~/project".to_string();
    let seen = seen.clone();
    let options = Options {
        host_id: host_id.into(),
        workspace_key: revision(format!("ssh-runtime\0{host_id}\0{root}").as_bytes()),
        root,
        token: format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        ),
        ready_timeout: Duration::from_secs(120),
        keep_alive,
    };
    let events = Arc::new(move |event| seen.lock().unwrap().push(event));
    RemoteRuntime::open(pool.clone(), source, events, options)
        .await
        .unwrap()
}

pub(super) async fn probe(runtime: &RemoteRuntime) -> String {
    let (url, token) = (runtime.url(), runtime.token().to_string());
    let script =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../scripts/ios/runtime-probe.mjs");
    let output = tokio::task::spawn_blocking(move || {
        Command::new("node")
            .args([
                script.to_str().unwrap(),
                &url,
                &token,
                "hello.ts",
                "echo oxbit-$((6*7))",
                "oxbit-42",
            ])
            .output()
            .unwrap()
    })
    .await
    .unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "probe failed: {stderr}");
    String::from_utf8(output.stdout).unwrap()
}

pub(super) fn progress(seen: &Seen) -> Vec<String> {
    let events = seen.lock().unwrap();
    events
        .iter()
        .filter_map(|event| match event {
            Event::Progress { message } => Some(message.clone()),
            _ => None,
        })
        .collect()
}

pub(super) async fn running_after(seen: &Seen, from: usize, limit: Duration) -> bool {
    let deadline = Instant::now() + limit;
    while Instant::now() < deadline {
        if seen.lock().unwrap()[from..].contains(&Event::Running) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    false
}

pub(super) fn remote_runtimes(container: &str) -> String {
    exec(
        container,
        // The brackets keep the pattern from matching the `sh -c` running pgrep.
        "pgrep -f '[.]oxbit/remote/runtimes/.*/desktop[.]js' || true",
    )
}

pub(super) struct Live {
    pub container: String,
    pub port: u16,
    pub served: String,
    pub pool: Arc<Pool>,
    pub scratch: PathBuf,
}

/// Connects host "live" to the fixture with a trusted host key and removes `~/.oxbit`.
pub(super) async fn live() -> Live {
    let container = env("OXBIT_SSH_TEST_CONTAINER");
    let port: u16 = env("OXBIT_SSH_TEST_PORT").parse().unwrap();
    let served = env("OXBIT_SSH_TEST_PAYLOAD_URL");
    let key_text = std::fs::read_to_string(env("OXBIT_SSH_TEST_KEY")).unwrap();
    let imported =
        keys::import("Live", &key_text, Some(&env("OXBIT_SSH_TEST_PASSPHRASE"))).unwrap();
    let scratch = std::env::temp_dir().join(format!("oxbit-runtime-live-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&scratch).unwrap();
    let known = Arc::new(KnownHosts::new(scratch.join("known_hosts.json")));
    let pool = Arc::new(Pool::new(known.clone()));
    let target = Target {
        host_id: "live".into(),
        hostname: "127.0.0.1".into(),
        port,
        username: "root".into(),
    };
    let credential = Credential::Key(Arc::new(keys::decode(&imported.private_key).unwrap()));
    if let Outcome::HostUnknown { host_key } = pool
        .connect(target.clone(), credential.clone())
        .await
        .unwrap()
    {
        known
            .trust(
                "127.0.0.1",
                port,
                &host_key.algorithm,
                &host_key.fingerprint,
            )
            .unwrap();
    }
    assert!(matches!(
        pool.connect(target, credential).await.unwrap(),
        Outcome::Connected { .. }
    ));
    exec(&container, "rm -rf /root/.oxbit");
    Live {
        container,
        port,
        served,
        pool,
        scratch,
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the Docker sshd fixture"]
async fn live_remote_runtime() {
    let Live {
        container,
        port,
        served,
        pool,
        scratch,
    } = live().await;
    let seen: Seen = Arc::default();
    let missing = source(format!("{served}/missing.tar.gz"), scratch.clone());
    let runtime = start(&pool, "live", missing, &seen, None).await;
    let ready = runtime.ensure(true).await.unwrap();
    assert_eq!(ready.installed, Some(Install::DeviceStream));
    assert_eq!(ready.root, "/root/project");
    assert_eq!(progress(&seen), [INSTALLING, STARTING]);
    let result = probe(&runtime).await;
    assert!(result.contains("export const message"), "{result}");
    println!(
        "PASS device-stream install after the host download failed, fs.read and terminal: {}",
        result.trim()
    );
    runtime.stop().await;
    let deadline = Instant::now() + Duration::from_secs(10);
    while !remote_runtimes(&container).is_empty() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert_eq!(remote_runtimes(&container), "");
    println!("PASS stop ends the remote process");

    exec(&container, "rm -rf /root/.oxbit/remote/runtimes");
    let seen: Seen = Arc::default();
    let hosted = source(format!("{served}/linux-x64.tar.gz"), scratch.clone());
    let runtime = start(&pool, "live", hosted.clone(), &seen, None).await;
    let ready = runtime.ensure(true).await.unwrap();
    assert_eq!(
        ready.installed,
        Some(Install::HostDownload(Downloader::Curl))
    );
    probe(&runtime).await;
    runtime.stop().await;
    println!("PASS host-download install with curl");

    let seen: Seen = Arc::default();
    let runtime = start(&pool, "live", hosted, &seen, None).await;
    let ready = runtime.ensure(true).await.unwrap();
    assert_eq!(ready.installed, Some(Install::Cached));
    assert_eq!(progress(&seen), [STARTING]);
    let url = runtime.url();
    println!("PASS cached launch skips the install");

    let pid = runtime.pid().await.expect("the launch reports its PID");
    let mark = seen.lock().unwrap().len();
    exec(&container, &format!("kill -9 {pid}"));
    assert!(
        running_after(&seen, mark, Duration::from_secs(120)).await,
        "no relaunch: {:?}",
        seen.lock().unwrap()
    );
    assert_ne!(runtime.pid().await, Some(pid));
    assert_eq!(runtime.url(), url);
    probe(&runtime).await;
    println!("PASS relaunch after the remote process was killed, same local URL");

    let mark = seen.lock().unwrap().len();
    restart(&container, port).await;
    exec(
        &container,
        "/usr/sbin/sshd -p 2222 -o PasswordAuthentication=yes -o UsePAM=no -o PermitRootLogin=yes",
    );
    let automatic = running_after(&seen, mark, Duration::from_secs(60)).await;
    if !automatic {
        runtime.ensure(true).await.unwrap();
    }
    probe(&runtime).await;
    println!(
        "PASS reconnect after docker restart ({})",
        if automatic { "automatic" } else { "resume" }
    );

    runtime.stop().await;
    std::fs::remove_dir_all(&scratch).unwrap();
}
