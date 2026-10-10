use super::{
    runtime_frames::*, runtime_process::Budget, runtime_protocol::*, runtime_tunnel::health_body,
};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

const KEY: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn frame(value: Value) -> Vec<u8> {
    value.to_string().into_bytes()
}

#[test]
fn maps_uname_to_the_desktop_platform_names() {
    assert_eq!(platform("Linux", "x86_64").unwrap(), "linux-x64");
    assert_eq!(platform("Linux", "aarch64").unwrap(), "linux-arm64");
    assert_eq!(platform("Darwin\n", "arm64\n").unwrap(), "darwin-arm64");
    for (system, machine) in [
        ("Linux", "armv7l"),
        ("Darwin", "x86_64"),
        ("FreeBSD", "amd64"),
    ] {
        let error = platform(system, machine).unwrap_err();
        assert_eq!(
            error.message,
            "Remote SSH supports Linux x64 and arm64 (glibc) and macOS Apple Silicon."
        );
    }
    assert_eq!(
        parse_probe("Linux\nx86_64\ncurl\n").unwrap(),
        ("linux-x64", Some(Downloader::Curl))
    );
    assert_eq!(
        parse_probe("Darwin\narm64\nwget\n").unwrap(),
        ("darwin-arm64", Some(Downloader::Wget))
    );
    assert_eq!(
        parse_probe("Linux\naarch64\ncurl\n").unwrap(),
        ("linux-arm64", Some(Downloader::Curl))
    );
    assert_eq!(
        parse_probe("Linux\nx86_64\nnone\n").unwrap(),
        ("linux-x64", None)
    );
    assert!(parse_probe("Linux\n").is_err());
}

#[test]
fn selects_the_cache_then_the_host_download_then_the_device_stream() {
    assert_eq!(choose(true, Some(Downloader::Curl)), Install::Cached);
    assert_eq!(choose(true, None), Install::Cached);
    assert_eq!(
        choose(false, Some(Downloader::Wget)),
        Install::HostDownload(Downloader::Wget)
    );
    assert_eq!(choose(false, None), Install::DeviceStream);
}

#[test]
fn install_script_matches_the_desktop_script() {
    let source = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../runtime/src/ssh-target.ts"),
    )
    .unwrap();
    let start = source.find("return `set -eu").unwrap() + "return `".len();
    let end = start + source[start..].find("`;\n}").unwrap();
    let desktop = source[start..end]
        .replace("\\${", "${")
        .replace("${digest}", KEY);
    assert_eq!(install_script(KEY).unwrap(), desktop);
    assert!(install_script("ABC").is_err());
    assert!(install_script(&KEY.to_uppercase()).is_err());
}

#[test]
fn builds_the_shared_remote_commands() {
    assert_eq!(shell_quote("it's"), "'it'\\''s'");
    assert_eq!(
        cached_command(KEY),
        format!("if [ -f \"$HOME/.oxbit/remote/runtimes/{KEY}\"/.complete ]; then printf yes; fi")
    );
    let url = "https://github.com/yannelli/oxbit/releases/download/v0.3.4/remote-runtime-linux-x64.tar.gz";
    let curl = host_install_command(KEY, url, Downloader::Curl).unwrap();
    assert!(
        curl.starts_with("sh -c 'curl -fsSL --connect-timeout 15 --speed-limit 1024 --speed-time 30 '\\''https://github.com/"),
        "{curl}"
    );
    assert!(curl.contains(KEY));
    let wget = host_install_command(KEY, url, Downloader::Wget).unwrap();
    assert!(wget.starts_with("sh -c 'wget -qO- -T 15 "), "{wget}");
    assert!(host_install_command(KEY, "file:///etc/passwd", Downloader::Curl).is_err());
    let launch = launch_command(KEY);
    assert!(launch.starts_with("sh -c 'echo $$ >&2; cd \"$HOME/.oxbit/remote/runtimes/"));
    assert!(launch.contains("unset NODE_OPTIONS NODE_PATH OXBIT_LSP_COMMAND; exec \"$HOME"));
    assert!(launch.ends_with("/desktop.js'"));
    let stop = stop_stale_command(4242);
    assert!(
        stop.contains("ps -p 4242 -o args=") && stop.contains("kill -TERM 4242"),
        "{stop}"
    );
}

#[test]
fn maps_the_folder_field_to_a_launch_root() {
    for (input, root) in [
        ("", "/~"),
        ("~", "/~"),
        ("~/", "/~"),
        ("~/project", "/~/project"),
        ("project/app/", "/~/project/app"),
        ("/srv/app", "/srv/app"),
    ] {
        assert_eq!(remote_root(input).unwrap(), root, "{input}");
    }
    assert!(remote_root("bad\npath").is_err());
}

#[test]
fn keys_a_resolved_folder_like_its_home_relative_launch_root() {
    for (folder, root) in [
        ("/home/dev", "/~"),
        ("/home/dev/project", "/~/project"),
        ("/home/dev/project/app", "/~/project/app"),
        ("/home/devops", "/home/devops"),
        ("/srv/app", "/srv/app"),
        ("/", "/"),
    ] {
        assert_eq!(key_root("/home/dev", folder), root, "{folder}");
        assert_eq!(key_root("/home/dev/", folder), root, "{folder}");
    }
    for typed in ["project", "~/project", "~/project/"] {
        assert_eq!(
            remote_root(typed).unwrap(),
            key_root("/home/dev", "/home/dev/project")
        );
    }
    assert_eq!(key_root("/", "/srv/app"), "/srv/app");
}

#[test]
fn writes_launch_heartbeat_and_task_frames() {
    let launch: Value = serde_json::from_str(&launch_frame("/~/app", KEY, "token", None)).unwrap();
    assert_eq!(
        launch,
        json!({ "version": 1, "type": "launch", "remoteRuntime": true, "root": "/~/app",
            "workspaceKey": KEY, "token": "token", "development": false })
    );
    assert!(launch_frame("/", KEY, "t", None).ends_with("}\n"));
    for keep_alive in [0, 75000, 3_600_000] {
        let launch: Value =
            serde_json::from_str(&launch_frame("/", KEY, "t", Some(keep_alive))).unwrap();
        assert_eq!(launch["keepAlive"], json!(keep_alive));
    }
    assert_eq!(HEARTBEAT_FRAME, "{\"version\":1,\"type\":\"heartbeat\"}\n");
    let forwarded: Value = serde_json::from_str(&task_forwarded_frame("r1", Some(4100))).unwrap();
    assert_eq!(
        forwarded,
        json!({ "version": 1, "type": "taskForwarded", "request": "r1", "port": 4100 })
    );
    let failed: Value = serde_json::from_str(&task_forwarded_frame("r1", None)).unwrap();
    assert_eq!(
        failed["error"],
        "Could not forward the service port over SSH"
    );
}

#[test]
fn parses_and_validates_runtime_frames() {
    let ready = json!({ "version": 1, "type": "ready", "port": 41234, "workspaceKey": KEY, "root": "/root/project" });
    assert_eq!(
        parse_frame(&frame(ready.clone()), KEY).unwrap(),
        Frame::Ready {
            port: 41234,
            root: "/root/project".into(),
            open_file: None
        }
    );
    for (field, value) in [
        ("workspaceKey", json!("other")),
        ("port", json!(0)),
        ("port", json!(70000)),
        ("root", json!("relative")),
    ] {
        let mut wrong = ready.clone();
        wrong[field] = value;
        let error = parse_frame(&frame(wrong), KEY).unwrap_err();
        assert_eq!(
            error.message, "Remote workspace identity did not match the connection",
            "{field}"
        );
    }
    let forward =
        json!({ "version": 1, "type": "taskForward", "request": "r", "host": "::1", "port": 3000 });
    assert_eq!(
        parse_frame(&frame(forward.clone()), KEY).unwrap(),
        Frame::TaskForward {
            request: "r".into(),
            host: "::1".into(),
            port: 3000
        }
    );
    for (field, value) in [
        ("host", json!("example.com")),
        ("request", json!("x".repeat(129))),
        ("port", json!(0)),
    ] {
        let mut wrong = forward.clone();
        wrong[field] = value;
        assert_eq!(
            parse_frame(&frame(wrong), KEY).unwrap_err().message,
            "Invalid remote runtime response"
        );
    }
    assert_eq!(
        parse_frame(
            &frame(json!({ "version": 1, "type": "error", "message": "busy" })),
            KEY
        )
        .unwrap(),
        Frame::Error {
            message: "busy".into()
        }
    );
    assert_eq!(
        parse_frame(
            &frame(json!({ "version": 1, "type": "rotated", "request": "q" })),
            KEY
        )
        .unwrap(),
        Frame::Rotated {
            request: "q".into()
        }
    );
    let process = json!({ "version": 1, "type": "process", "pid": 7, "running": true });
    assert_eq!(parse_frame(&frame(process), KEY).unwrap(), Frame::Other);
    assert!(parse_frame(&frame(json!({ "version": 2, "type": "ready" })), KEY).is_err());
    assert!(parse_frame(b"not json", KEY).is_err());
}

#[test]
fn splits_frames_across_reads_and_caps_a_line_at_64_kib() {
    let mut reader = FrameReader::default();
    assert!(reader.push(b"{\"a\":1}\n{\"b\"").unwrap() == vec![b"{\"a\":1}".to_vec()]);
    assert_eq!(
        reader.push(b":2}\n\n").unwrap(),
        vec![b"{\"b\":2}".to_vec()]
    );
    let mut exact = vec![b'x'; MAX_FRAME_BYTES];
    exact.push(b'\n');
    assert_eq!(
        FrameReader::default().push(&exact).unwrap()[0].len(),
        MAX_FRAME_BYTES
    );
    assert!(FrameReader::default()
        .push(&vec![b'x'; MAX_FRAME_BYTES + 1])
        .is_err());
    let mut long = vec![b'x'; MAX_FRAME_BYTES + 1];
    long.push(b'\n');
    assert!(FrameReader::default().push(&long).is_err());
}

fn healthy(response: &str) -> bool {
    health_body(response).is_some()
}

#[test]
fn accepts_only_a_protocol_1_health_response() {
    let ok =
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{\"ok\":true,\"protocol\":1}";
    assert!(healthy(ok));
    assert!(healthy("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n19\r\n{\"ok\":true,\"protocol\":1}\r\n0\r\n\r\n"));
    assert!(!healthy(
        "HTTP/1.1 200 OK\r\n\r\n{\"ok\":true,\"protocol\":2}"
    ));
    assert!(!healthy(
        "HTTP/1.1 403 Forbidden\r\n\r\n{\"ok\":true,\"protocol\":1}"
    ));
    assert!(!healthy("garbage"));
    let identified = "HTTP/1.1 200 OK\r\n\r\n{\"ok\":true,\"protocol\":1,\"id\":\"runtime-0123\"}";
    assert_eq!(health_body(identified).unwrap()["id"], "runtime-0123");
    assert!(health_body(ok).unwrap()["id"].is_null());
}

#[test]
fn allows_three_automatic_relaunches_a_minute_until_the_user_reconnects() {
    let start = Instant::now();
    let at = |seconds| start + Duration::from_secs(seconds);
    let mut budget = Budget::default();
    assert!(
        budget.admit(true, start),
        "the user's start does not use the budget"
    );
    for second in [1, 5, 15] {
        assert!(
            budget.admit(false, at(second)),
            "automatic attempt at {second} s"
        );
    }
    assert!(
        !budget.admit(false, at(20)),
        "the 4th automatic attempt waits"
    );
    assert!(!budget.admit(false, at(60)));
    assert!(
        budget.admit(false, at(61)),
        "attempts older than a minute expire"
    );
    assert!(budget.admit(true, at(62)), "Reconnect bypasses the budget");
    for second in [63, 64, 65] {
        assert!(
            budget.admit(false, at(second)),
            "Reconnect starts a new budget"
        );
    }
    assert!(!budget.admit(false, at(66)));
}
