use serde::Serialize;
use std::{
    collections::BTreeMap,
    io::Read,
    os::unix::{fs::PermissionsExt, io::AsRawFd, process::CommandExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

pub type Environment = BTreeMap<String, String>;

pub fn capture(
    mut command: Command,
    timeout: Duration,
    limit: u64,
) -> Result<(bool, Vec<u8>), String> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .map_err(|_| "Executable could not be started")?;
    let mut stdout = child.stdout.take().ok_or("Missing process output")?;
    let fd = stdout.as_raw_fd();
    // A detached descendant must not hold this reader past the deadline.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        let _ = child.kill();
        let _ = child.wait();
        return Err("Cannot configure bounded tool output".into());
    }
    let start = Instant::now();
    let mut bytes = Vec::new();
    let mut ended = None;
    let result = loop {
        if start.elapsed() > timeout {
            break Err("Tool timed out".into());
        }
        let mut chunk = [0_u8; 4096];
        match stdout.read(&mut chunk) {
            Ok(0) => {
                if let Some(status) = ended {
                    break Ok((status, bytes));
                }
            }
            Ok(size) => {
                if bytes.len() as u64 + size as u64 > limit {
                    break Err("Tool output exceeded its limit".into());
                }
                bytes.extend_from_slice(&chunk[..size]);
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(_) => break Err("Cannot read tool output".into()),
        }
        match child.try_wait() {
            Ok(Some(status)) => ended = Some(status.success()),
            Ok(None) => {}
            Err(_) => break Err("Cannot inspect process".into()),
        }
        thread::sleep(Duration::from_millis(5));
    };
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.wait();
    result
}

pub fn login_environment() -> Environment {
    let inherited: Environment = std::env::vars().collect();
    let shell = inherited
        .get("SHELL")
        .filter(|p| Path::new(p).is_absolute())
        .map(String::as_str)
        .unwrap_or("/bin/sh");
    let mut command = Command::new(shell);
    command
        .args(["-l", "-c", "/usr/bin/env -0"])
        .current_dir("/");
    let mut result = inherited.clone();
    if let Ok((true, bytes)) = capture(command, Duration::from_secs(5), 1024 * 1024) {
        for entry in bytes.split(|byte| *byte == 0) {
            if let Ok(text) = std::str::from_utf8(entry) {
                if let Some((key, value)) = text.split_once('=') {
                    if !key.is_empty()
                        && key.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
                    {
                        result.insert(key.to_owned(), value.to_owned());
                    }
                }
            }
        }
    }
    // Launch-time authentication, agents, and proxies take precedence over shell defaults.
    for (key, value) in inherited {
        if key.starts_with("GH_")
            || key.starts_with("GITHUB_")
            || key.starts_with("SSH_")
            || key.to_ascii_lowercase().ends_with("_proxy")
        {
            result.insert(key, value);
        }
    }
    let fallback = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
    result
        .entry("PATH".into())
        .and_modify(|value| {
            value.push(':');
            value.push_str(fallback);
        })
        .or_insert(fallback.into());
    result
}

pub fn executable(name: &str, configured: Option<&str>, env: &Environment) -> Option<PathBuf> {
    let candidates: Vec<PathBuf> = if let Some(value) = configured.filter(|p| !p.is_empty()) {
        vec![PathBuf::from(value)]
    } else {
        std::env::split_paths(
            env.get("PATH")
                .map(String::as_str)
                .unwrap_or("/usr/bin:/bin"),
        )
        .filter(|p| p.is_absolute())
        .map(|p| p.join(name))
        .collect()
    };
    candidates.into_iter().find(|p| {
        p.is_absolute()
            && p.metadata()
                .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub name: String,
    pub path: Option<String>,
    pub version: Option<String>,
    pub authenticated: Option<bool>,
    pub guidance: String,
}
pub fn diagnose(
    name: &str,
    configured: Option<&str>,
    env: &Environment,
    check_auth: bool,
) -> ToolStatus {
    let path = executable(name, configured, env);
    let mut status = ToolStatus { name: name.into(), path: path.as_ref().map(|p| p.display().to_string()), version: None, authenticated: None,
        guidance: match name { "git" => "Install Git (Xcode Command Line Tools on macOS or apt install git on Ubuntu).", _ => "Install GitHub CLI from https://cli.github.com. Run gh auth login in a trusted project terminal to sign in." }.into() };
    if let Some(path) = path {
        let mut command = Command::new(&path);
        command
            .arg("--version")
            .env_clear()
            .envs(env)
            .current_dir("/");
        if let Ok((true, bytes)) = capture(command, Duration::from_secs(5), 4096) {
            status.version = String::from_utf8_lossy(&bytes)
                .lines()
                .next()
                .map(|s| s.chars().take(160).collect());
        }
        if check_auth && name == "gh" {
            let mut command = Command::new(path);
            command
                .args(["auth", "status"])
                .env_clear()
                .envs(env)
                .current_dir("/");
            // Never return auth output: it may include account names, config, or credentials.
            status.authenticated = capture(command, Duration::from_secs(15), 65536)
                .ok()
                .map(|(ok, _)| ok);
        }
    }
    status
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounds_output_and_time() {
        let mut output = Command::new("/bin/sh");
        output.args(["-c", "printf '123456789'"]);
        assert!(capture(output, Duration::from_secs(1), 4).is_err());
        let mut slow = Command::new("/bin/sh");
        slow.args(["-c", "sleep 10"]);
        assert!(capture(slow, Duration::from_millis(50), 32).is_err());
    }
    #[test]
    fn skips_relative_search_directories() {
        let env = Environment::from([("PATH".into(), ".:/bin".into())]);
        assert_eq!(executable("sh", None, &env), Some(PathBuf::from("/bin/sh")));
        assert!(executable("git", Some("./git"), &env).is_none());
    }
}
