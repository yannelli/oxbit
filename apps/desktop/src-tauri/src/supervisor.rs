use crate::environment::Environment;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    io::{BufRead, BufReader, Write},
    os::unix::process::CommandExt,
    path::Path,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Launch<'a> {
    pub version: u8,
    pub r#type: &'a str,
    pub root: &'a str,
    pub data_dir: &'a str,
    pub workspace_key: &'a str,
    pub token: &'a str,
    pub rg_path: &'a str,
    pub git_path: Option<&'a str>,
    pub development: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Frame {
    version: u8,
    r#type: String,
    port: Option<u16>,
    workspace_key: Option<String>,
    root: Option<String>,
    pid: Option<i32>,
    running: Option<bool>,
    request: Option<String>,
    message: Option<String>,
    open_file: Option<String>,
}

pub struct OwnedRuntime {
    child: Mutex<Child>,
    input: Mutex<Option<ChildStdin>>,
    groups: Mutex<HashSet<i32>>,
    replies: Mutex<HashMap<String, mpsc::Sender<()>>>,
    stopped: AtomicBool,
    pub alive: AtomicBool,
    pub port: u16,
    pub open_file: Option<String>,
}

fn terminate_groups(groups: &Mutex<HashSet<i32>>) {
    if let Ok(mut groups) = groups.lock() {
        for pid in groups.drain() {
            if pid > 1 {
                unsafe {
                    libc::kill(-pid, libc::SIGKILL);
                }
            }
        }
    }
}

impl OwnedRuntime {
    pub fn launch(
        node: &Path,
        entry: &Path,
        config: Launch<'_>,
        environment: &Environment,
        crashed: impl Fn() + Send + Sync + 'static,
        progress: impl Fn(&str),
    ) -> Result<Arc<Self>, String> {
        let timeout = if config.root.starts_with("ssh://") {
            Duration::from_secs(250)
        } else {
            Duration::from_secs(20)
        };
        Self::launch_with_timeout(node, entry, config, environment, crashed, progress, timeout)
    }

    fn launch_with_timeout(
        node: &Path,
        entry: &Path,
        config: Launch<'_>,
        environment: &Environment,
        crashed: impl Fn() + Send + Sync + 'static,
        progress: impl Fn(&str),
        timeout: Duration,
    ) -> Result<Arc<Self>, String> {
        let mut child = Command::new(node)
            .arg(entry)
            .current_dir("/")
            .env_clear()
            .envs(environment)
            // User NODE_OPTIONS can inject code before the private handshake. Project Node is unchanged.
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH")
            .env_remove("OXBIT_LSP_COMMAND")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Runtime failures reach the user as an RPC message with no stack behind it.
            // OXBIT_RUNTIME_STDERR keeps the child's diagnostics when one needs chasing.
            .stderr(if std::env::var_os("OXBIT_RUNTIME_STDERR").is_some() {
                Stdio::inherit()
            } else {
                Stdio::null()
            })
            .process_group(0)
            .spawn()
            .map_err(|_| "Bundled runtime could not be started. Reinstall Oxbit.")?;
        let mut input = child.stdin.take().ok_or("Runtime input is unavailable")?;
        let stdout = child.stdout.take().ok_or("Runtime output is unavailable")?;
        let frame = serde_json::to_vec(&config).map_err(|_| "Invalid launch configuration")?;
        if input
            .write_all(&frame)
            .and_then(|_| input.write_all(b"\n"))
            .is_err()
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Runtime launch channel closed".into());
        }
        let (send, receive) = mpsc::channel::<Frame>();
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut bytes = Vec::new();
                // A compromised extension cannot make the supervisor allocate an unbounded frame.
                match std::io::Read::take(&mut reader, 65537).read_until(b'\n', &mut bytes) {
                    Ok(0) | Err(_) => break,
                    _ if bytes.len() > 65536 => break,
                    _ => {}
                }
                let Ok(frame) = serde_json::from_slice::<Frame>(&bytes) else {
                    break;
                };
                if frame.version != 1 || send.send(frame).is_err() {
                    break;
                }
            }
        });
        let deadline = Instant::now() + timeout;
        let startup_groups = Mutex::new(HashSet::new());
        let ready = loop {
            let frame = receive.recv_timeout(deadline.saturating_duration_since(Instant::now()));
            match frame {
                Ok(frame) if frame.r#type == "progress" => {
                    if let Some(message) = frame.message.as_deref() {
                        progress(message);
                    }
                }
                Ok(frame) if frame.r#type == "process" => {
                    if let (Some(pid), Some(running)) = (frame.pid, frame.running) {
                        if pid > 1 {
                            let mut groups = startup_groups.lock().unwrap();
                            if running {
                                groups.insert(pid);
                            } else {
                                groups.remove(&pid);
                            }
                        }
                    }
                }
                result => break result,
            }
        };
        let open_file;
        let port = match ready {
            Ok(frame)
                if frame.r#type == "ready"
                    && frame.workspace_key.as_deref() == Some(config.workspace_key)
                    && frame.root.as_deref() == Some(config.root)
                    && frame.port.is_some_and(|p| p > 0) =>
            {
                open_file = frame.open_file;
                frame.port.unwrap_or_default()
            }
            failed => {
                let detail = failed
                    .ok()
                    .filter(|f| f.r#type == "error")
                    .and_then(|f| f.message);
                unsafe {
                    libc::kill(-(child.id() as i32), libc::SIGKILL);
                }
                let _ = child.wait();
                terminate_groups(&startup_groups);
                return Err(detail.unwrap_or_else(|| {
                    "Runtime startup failed or timed out. Retry or reinstall the application."
                        .into()
                }));
            }
        };
        let runtime = Arc::new(Self {
            child: Mutex::new(child),
            input: Mutex::new(Some(input)),
            groups: startup_groups,
            replies: Mutex::new(HashMap::new()),
            stopped: AtomicBool::new(false),
            alive: AtomicBool::new(true),
            port,
            open_file,
        });
        let watched = Arc::downgrade(&runtime);
        thread::spawn(move || loop {
            let Some(runtime) = watched.upgrade() else {
                return;
            };
            let received = receive.recv_timeout(Duration::from_millis(30));
            match received {
                Ok(frame) => runtime.observe(frame),
                Err(mpsc::RecvTimeoutError::Disconnected)
                    if runtime.alive.load(Ordering::SeqCst) =>
                {
                    let _ = runtime.child.lock().unwrap().kill();
                }
                _ => {}
            }
            let ended = runtime
                .child
                .lock()
                .unwrap()
                .try_wait()
                .map_or(true, |status| status.is_some());
            if ended {
                // Also reap children that inherited the runtime group before an abrupt crash.
                unsafe {
                    libc::kill(-(runtime.child.lock().unwrap().id() as i32), libc::SIGKILL);
                }
                while let Ok(frame) = receive.try_recv() {
                    runtime.observe(frame);
                }
                runtime.alive.store(false, Ordering::SeqCst);
                terminate_groups(&runtime.groups);
                if !runtime.stopped.load(Ordering::SeqCst) {
                    crashed();
                }
                break;
            }
        });
        Ok(runtime)
    }

    fn observe(&self, frame: Frame) {
        if frame.r#type == "process" {
            if let (Some(pid), Some(running)) = (frame.pid, frame.running) {
                if pid > 1 {
                    let mut groups = self.groups.lock().unwrap();
                    if running {
                        groups.insert(pid);
                    } else {
                        groups.remove(&pid);
                    }
                }
            }
        } else if frame.r#type == "rotated" {
            if let Some(request) = frame.request {
                if let Some(reply) = self.replies.lock().unwrap().remove(&request) {
                    let _ = reply.send(());
                }
            }
        }
    }
    pub fn rotate(&self, token: &str) -> Result<(), String> {
        let request = uuid::Uuid::new_v4().to_string();
        let (send, receive) = mpsc::channel();
        self.replies.lock().unwrap().insert(request.clone(), send);
        let frame = serde_json::json!({"version":1,"type":"rotate","token":token,"request":request})
            .to_string() + "\n";
        let sent = self
            .input
            .lock()
            .unwrap()
            .as_mut()
            .is_some_and(|input| input.write_all(frame.as_bytes()).is_ok());
        let result = sent && receive.recv_timeout(Duration::from_secs(5)).is_ok();
        self.replies.lock().unwrap().remove(&request);
        if result {
            Ok(())
        } else {
            self.stop();
            Err("Project transfer failed. Restart the runtime before retrying.".into())
        }
    }
    #[cfg(feature = "native-test")]
    pub fn crash_for_test(&self) {
        let _ = self.child.lock().unwrap().kill();
    }

    pub fn stop(&self) {
        if self.stopped.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Some(mut input) = self.input.lock().unwrap().take() {
            let _ = input.write_all(b"{\"version\":1,\"type\":\"shutdown\"}\n");
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let mut child = self.child.lock().unwrap();
            if child.try_wait().ok().flatten().is_some() {
                break;
            }
            if Instant::now() >= deadline {
                unsafe {
                    libc::kill(-(child.id() as i32), libc::SIGKILL);
                }
                let _ = child.wait();
                break;
            }
            drop(child);
            thread::sleep(Duration::from_millis(20));
        }
        terminate_groups(&self.groups);
        self.alive.store(false, Ordering::SeqCst);
    }
}

impl Drop for OwnedRuntime {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    struct Fixture {
        directory: std::path::PathBuf,
    }
    impl Fixture {
        fn new(body: &str) -> Self {
            let directory =
                std::env::temp_dir().join(format!("oxbit supervisor {}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&directory).unwrap();
            fs::write(
                directory.join("entry.sh"),
                format!(
                    "printf '%s' \"$$\" > '{}'\nIFS= read -r launch\n{body}\n",
                    directory.join("pid").display()
                ),
            )
            .unwrap();
            Self { directory }
        }
        fn launch(
            &self,
            crashed: impl Fn() + Send + Sync + 'static,
        ) -> Result<Arc<OwnedRuntime>, String> {
            let mut env = Environment::new();
            env.insert("PATH".into(), "/usr/bin:/bin".into());
            env.insert("NODE_OPTIONS".into(), "must be removed".into());
            OwnedRuntime::launch_with_timeout(
                Path::new("/bin/sh"),
                &self.directory.join("entry.sh"),
                Launch {
                    version: 1,
                    r#type: "launch",
                    root: "/tmp/workspace",
                    data_dir: "/tmp/state",
                    workspace_key: "project",
                    token: "private-token",
                    rg_path: "/bin/false",
                    git_path: None,
                    development: false,
                },
                &env,
                crashed,
                |_| {},
                Duration::from_millis(250),
            )
        }
        fn pid(&self) -> i32 {
            fs::read_to_string(self.directory.join("pid"))
                .unwrap()
                .parse()
                .unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.directory);
        }
    }
    const READY: &str = r#"echo '{"version":1,"type":"ready","port":12345,"workspaceKey":"project","root":"/tmp/workspace"}'"#;
    fn gone(pid: i32) -> bool {
        unsafe { libc::kill(pid, 0) != 0 }
    }
    #[test]
    fn valid_ready_and_graceful_shutdown_keep_credentials_private() {
        let fixture = Fixture::new(&format!(
            "[ -z \"${{NODE_OPTIONS+x}}\" ] || exit 1\n{READY}\nIFS= read -r shutdown"
        ));
        let runtime = fixture
            .launch(|| panic!("graceful stop must not report a crash"))
            .unwrap();
        assert_eq!(runtime.port, 12345);
        runtime.stop();
        assert!(gone(fixture.pid()));
        assert!(!runtime.alive.load(Ordering::SeqCst));
    }
    #[test]
    fn startup_process_events_do_not_replace_readiness() {
        let fixture = Fixture::new(&format!(
            "echo '{{\"version\":1,\"type\":\"process\",\"pid\":'\"$$\"',\"running\":true}}'\n\
             echo '{{\"version\":1,\"type\":\"process\",\"pid\":'\"$$\"',\"running\":false}}'\n\
             {READY}\nIFS= read -r shutdown"
        ));
        let runtime = fixture.launch(|| {}).unwrap();
        assert_eq!(runtime.port, 12345);
        assert!(runtime.groups.lock().unwrap().is_empty());
        runtime.stop();
        assert!(gone(fixture.pid()));
    }
    #[test]
    fn wrong_identity_malformed_frames_and_timeout_reap_child() {
        for body in [
            READY.replace("project", "wrong"),
            "echo not-json".into(),
            "sleep 30".into(),
        ] {
            let fixture = Fixture::new(&body);
            let start = Instant::now();
            assert!(fixture.launch(|| {}).is_err());
            assert!(start.elapsed() < Duration::from_secs(2));
            assert!(gone(fixture.pid()));
        }
    }
    #[test]
    fn abrupt_exit_reports_failure_once_and_cleans_inherited_children() {
        let fixture = Fixture::new(&format!(
            "{READY}\nsleep 30 &\nprintf '%s' \"$!\" > child-pid\nsleep 0.1\nexit 1"
        ));
        // Use a project-owned pid file without changing the supervisor's neutral working directory.
        let script = fixture.directory.join("entry.sh");
        let contents = fs::read_to_string(&script).unwrap().replace(
            "> child-pid",
            &format!("> '{}'", fixture.directory.join("child-pid").display()),
        );
        fs::write(script, contents).unwrap();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed = calls.clone();
        let runtime = fixture
            .launch(move || {
                observed.fetch_add(1, Ordering::SeqCst);
            })
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while runtime.alive.load(Ordering::SeqCst) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(!runtime.alive.load(Ordering::SeqCst));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let pid: i32 = fs::read_to_string(fixture.directory.join("child-pid"))
            .unwrap()
            .parse()
            .unwrap();
        // A killed process may briefly remain a zombie until the OS reaps it.
        let deadline = Instant::now() + Duration::from_secs(2);
        while !gone(pid) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        #[cfg(target_os = "linux")]
        let terminated = gone(pid)
            || fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|s| s.contains(") Z "));
        #[cfg(not(target_os = "linux"))]
        let terminated = gone(pid);
        assert!(terminated);
    }
}
