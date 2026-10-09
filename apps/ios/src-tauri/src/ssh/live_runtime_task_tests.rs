//! Live remote runtime cases on the Docker sshd fixture: the wget install, a task service reached
//! through `taskForward`, and the relaunch budget after repeated failures.
use super::{
    live_runtime_tests::{live, payload, probe, remote_platform, source, start, Live, Seen},
    live_tests::{docker, exec},
    runtime_process::Event,
    runtime_protocol::{Downloader, Install},
    runtime_session::{RemoteRuntime, GAVE_UP},
};
use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
    time::{Duration, Instant},
};

const TASK_PORT: u16 = 4170;
const TASK_BODY: &str = "hello from the server task";

/// A service task that runs the runtime's own Node, since the fixture has no other.
fn write_task(container: &str, scratch: &Path, node: &str) {
    let script = format!(
        "require('http').createServer((q,r)=>r.end('{TASK_BODY}')).listen(Number(process.env.OXBIT_PORT),\
         process.env.OXBIT_HOST,()=>console.log('ready http://'+process.env.OXBIT_HOST+':'+process.env.OXBIT_PORT+'/'))"
    );
    let tasks = serde_json::json!({ "version": 1, "tasks": { "web": {
        "type": "service", "execution": "process", "command": node, "args": ["-e", script],
        "host": "127.0.0.1", "port": TASK_PORT,
    } } });
    let file = scratch.join("tasks.json");
    std::fs::write(&file, tasks.to_string()).unwrap();
    exec(container, "mkdir -p /root/project/.oxbit");
    let target = format!("{container}:/root/project/.oxbit/tasks.json");
    docker(&["cp", file.to_str().unwrap(), &target]);
}

async fn task_probe(runtime: &RemoteRuntime) -> serde_json::Value {
    let (url, token) = (runtime.url(), runtime.token().to_string());
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../scripts/ios/runtime-task-probe.mjs");
    let output = tokio::task::spawn_blocking(move || {
        Command::new("node")
            .args([script.to_str().unwrap(), &url, &token, "web"])
            .output()
            .unwrap()
    })
    .await
    .unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "task probe failed: {stderr}");
    serde_json::from_slice(&output.stdout).unwrap()
}

fn port_of(link: &str) -> u16 {
    let rest = link.strip_prefix("http://127.0.0.1:").unwrap();
    rest.split('/').next().unwrap().parse().unwrap()
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the Docker sshd fixture"]
async fn live_runtime_wget_tasks_and_budget() {
    let Live {
        container,
        served,
        pool,
        scratch,
        ..
    } = live().await;
    let (_, sha256) = payload();
    let node = format!("/root/.oxbit/remote/runtimes/{sha256}/bin/node");
    let hosted = || {
        source(
            format!("{served}/{}.tar.gz", remote_platform()),
            scratch.clone(),
        )
    };

    exec(&container, "mv /usr/bin/curl /usr/bin/curl.off");
    let seen: Seen = Arc::default();
    let runtime = start(&pool, "live", hosted(), &seen, None).await;
    let ready = runtime.ensure(true).await;
    exec(&container, "mv /usr/bin/curl.off /usr/bin/curl");
    assert_eq!(
        ready.unwrap().installed,
        Some(Install::HostDownload(Downloader::Wget))
    );
    probe(&runtime).await;
    println!("PASS host-download install with wget when the host has no curl");

    write_task(&container, &scratch, &node);
    let result = task_probe(&runtime).await;
    let link = result["link"].as_str().unwrap();
    let local = port_of(link);
    assert_ne!(local, TASK_PORT, "the link points at the device listener");
    assert_eq!(result["body"], TASK_BODY, "{result}");
    assert_eq!(result["after"], "closed", "{result}");
    runtime.stop().await;
    assert!(tokio::net::TcpStream::connect(("127.0.0.1", local))
        .await
        .is_err());
    println!(
        "PASS taskForward: {link} served the task, closed connections after the task stopped, and stopped listening when the workspace closed"
    );

    let seen: Seen = Arc::default();
    let runtime = start(&pool, "live", hosted(), &seen, None).await;
    runtime.ensure(true).await.unwrap();
    let pid = runtime.pid().await.unwrap();
    let mark = seen.lock().unwrap().len();
    exec(
        &container,
        &format!("mv {node} {node}.off && kill -9 {pid}"),
    );
    let gave_up = Event::Failed {
        message: GAVE_UP.into(),
    };
    let deadline = Instant::now() + Duration::from_secs(60);
    while !seen.lock().unwrap()[mark..].contains(&gave_up) && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let after = seen.lock().unwrap()[mark..].to_vec();
    let reconnects = after
        .iter()
        .filter(|event| matches!(event, Event::Reconnecting { .. }))
        .count();
    let failures = after
        .iter()
        .filter(|event| matches!(event, Event::Failed { message } if message != GAVE_UP))
        .count();
    assert_eq!((reconnects, failures), (3, 3), "{after:?}");
    assert_eq!(after.last(), Some(&gave_up), "{after:?}");
    let count = seen.lock().unwrap().len();
    assert_eq!(runtime.ensure(false).await.unwrap_err().message, GAVE_UP);
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(
        seen.lock().unwrap().len(),
        count,
        "no attempt after giving up"
    );
    exec(&container, &format!("mv {node}.off {node}"));
    runtime.ensure(true).await.unwrap();
    probe(&runtime).await;
    println!("PASS 3 automatic relaunches failed, the 4th waited, and Reconnect relaunched");

    runtime.stop().await;
    std::fs::remove_dir_all(&scratch).unwrap();
}
