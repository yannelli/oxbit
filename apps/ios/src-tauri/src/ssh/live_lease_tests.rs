//! Live keep-alive lease on the Docker sshd fixture: after the SSH session drops, a runtime with
//! lease 0 keeps running and one with a short lease exits once it expires.
use super::{
    live_runtime_tests::{live, remote_platform, remote_runtimes, source, start, Live, Seen},
    live_tests::exec,
    runtime_process::Event,
    runtime_session::RemoteRuntime,
};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

/// Longer than the 10 s heartbeat, so only a dropped connection lets it expire.
const LEASE: u64 = 15_000;
/// Per-connection sshd on port 22: retitled `sshd: root@notty`, or the `-R` child under qemu.
const SESSION: &str = "'sshd: [r]oot|sshd -D.* -[R]$'";

fn processes(container: &str) -> String {
    exec(container, "ps -eo pid,args")
}

fn sessions(container: &str) -> String {
    exec(container, &format!("pgrep -f {SESSION} || true"))
}

/// Drops the last handle first so the closed channel finds no runtime to relaunch, then kills the
/// fixture's SSH sessions so no heartbeat or client remains.
async fn sever(container: &str, runtime: Arc<RemoteRuntime>) -> u32 {
    let pid = runtime.pid().await.expect("the launch reports its PID");
    drop(runtime);
    assert_ne!(sessions(container), "", "{}", processes(container));
    exec(container, &format!("pkill -9 -f {SESSION}"));
    let deadline = Instant::now() + Duration::from_secs(5);
    while !sessions(container).is_empty() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(sessions(container), "", "{}", processes(container));
    pid
}

async fn gone_within(container: &str, limit: Duration) -> Option<Duration> {
    let started = Instant::now();
    while started.elapsed() < limit {
        if remote_runtimes(container).is_empty() {
            return Some(started.elapsed());
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    None
}

fn reconnected(seen: &Seen) -> bool {
    seen.lock()
        .unwrap()
        .iter()
        .any(|event| matches!(event, Event::Reconnecting { .. }))
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the Docker sshd fixture"]
async fn live_remote_runtime_lease() {
    let Live {
        container,
        served,
        pool,
        scratch,
        ..
    } = live().await;
    let hosted = source(format!("{served}/{}.tar.gz", remote_platform()), scratch.clone());

    let seen: Seen = Arc::default();
    let runtime = start(&pool, "live", hosted.clone(), &seen, Some(0)).await;
    runtime.ensure(true).await.unwrap();
    let pid = sever(&container, runtime).await;
    tokio::time::sleep(Duration::from_secs(15)).await;
    assert_eq!(
        remote_runtimes(&container),
        pid.to_string(),
        "{}",
        processes(&container)
    );
    assert!(!reconnected(&seen), "{:?}", seen.lock().unwrap());
    println!("PASS lease 0 keeps pid {pid} running 15 s after the SSH session dropped");
    exec(&container, &format!("kill -TERM {pid}"));
    assert!(
        gone_within(&container, Duration::from_secs(10))
            .await
            .is_some(),
        "{}",
        processes(&container)
    );

    let seen: Seen = Arc::default();
    let runtime = start(&pool, "live", hosted, &seen, Some(LEASE)).await;
    runtime.ensure(true).await.unwrap();
    let pid = runtime.pid().await.expect("the launch reports its PID");
    tokio::time::sleep(Duration::from_millis(LEASE + 5000)).await;
    assert_eq!(
        remote_runtimes(&container),
        pid.to_string(),
        "{}",
        processes(&container)
    );
    println!("PASS heartbeats hold a {LEASE} ms lease past its length while connected");
    sever(&container, runtime).await;
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(remote_runtimes(&container), pid.to_string());
    let gone = gone_within(&container, Duration::from_secs(30)).await;
    assert!(gone.is_some(), "{}", processes(&container));
    assert!(!reconnected(&seen), "{:?}", seen.lock().unwrap());
    println!(
        "PASS a {LEASE} ms lease ends pid {pid} {:.1} s after the SSH session dropped",
        1.0 + gone.unwrap().as_secs_f64()
    );
    std::fs::remove_dir_all(&scratch).unwrap();
}
