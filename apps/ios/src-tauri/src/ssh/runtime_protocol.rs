//! The desktop remote runtime contract from apps/runtime/src/ssh.ts and ssh-target.ts: platform
//! names and the shared install layout, install scripts, and launch command.
use crate::fs_core::{Error, Result};

pub fn platform(system: &str, machine: &str) -> Result<&'static str> {
    match (system.trim(), machine.trim()) {
        ("Linux", "x86_64") => Ok("linux-x64"),
        ("Linux", "aarch64") => Ok("linux-arm64"),
        ("Darwin", "arm64") => Ok("darwin-arm64"),
        _ => Err(Error::new(
            "REMOTE_UNSUPPORTED",
            "Remote SSH supports Linux x64 and arm64 (glibc) and macOS Apple Silicon.",
        )),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Downloader {
    Curl,
    Wget,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Install {
    Cached,
    HostDownload(Downloader),
    DeviceStream,
}

/// Cached first, then a download on the host, then the device streams the archive.
pub fn choose(cached: bool, downloader: Option<Downloader>) -> Install {
    match (cached, downloader) {
        (true, _) => Install::Cached,
        (false, Some(downloader)) => Install::HostDownload(downloader),
        (false, None) => Install::DeviceStream,
    }
}

pub const PROBE: &str = "uname -s; uname -m; \
    if command -v curl >/dev/null 2>&1; then echo curl; \
    elif command -v wget >/dev/null 2>&1; then echo wget; else echo none; fi";

pub fn parse_probe(output: &str) -> Result<(&'static str, Option<Downloader>)> {
    let lines: Vec<&str> = output.lines().map(str::trim).collect();
    let [system, machine, downloader, ..] = lines[..] else {
        return Err(Error::new(
            "REMOTE_UNSUPPORTED",
            "Could not detect the server's operating system.",
        ));
    };
    let downloader = match downloader {
        "curl" => Some(Downloader::Curl),
        "wget" => Some(Downloader::Wget),
        _ => None,
    };
    Ok((platform(system, machine)?, downloader))
}

pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Runs a script under `sh` whatever the login shell is.
pub fn sh(script: &str) -> String {
    format!("sh -c {}", shell_quote(script))
}

pub fn valid_digest(digest: &str) -> bool {
    digest.len() == 64
        && digest
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn remote(digest: &str) -> String {
    format!("\"$HOME/.oxbit/remote/runtimes/{digest}\"")
}

pub fn cached_command(digest: &str) -> String {
    format!(
        "if [ -f {}/.complete ]; then printf yes; fi",
        remote(digest)
    )
}

/// Byte-identical to `installScript` in apps/runtime/src/ssh-target.ts.
const INSTALL: &str = r#"set -eu
umask 077
base="$HOME/.oxbit/remote/runtimes"
mkdir -p "$base"
stage=$(mktemp -d "$base/.install-XXXXXXXX")
lock=""
trap 'rm -rf "$stage"; [ -z "$lock" ] || rmdir "$lock" 2>/dev/null || true' EXIT
trap 'exit 1' HUP INT TERM
cat > "$stage/runtime.tar.gz"
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$stage/runtime.tar.gz")
else
  actual=$(shasum -a 256 "$stage/runtime.tar.gz")
fi
[ "${actual%% *}" = '@DIGEST@' ] || { echo 'Runtime checksum mismatch' >&2; exit 1; }
mkdir "$stage/runtime"
tar -xzf "$stage/runtime.tar.gz" -C "$stage/runtime"
"$stage/runtime/bin/node" --version >/dev/null
touch "$stage/runtime/.complete"
# Serialize only the atomic publish, after the slow transfer and extraction.
attempt=0
while ! mkdir "$base/@DIGEST@.lock" 2>/dev/null; do
  if [ -f "$base/@DIGEST@/.complete" ]; then exit 0; fi
  attempt=$((attempt + 1))
  [ "$attempt" -lt 30 ] || { echo 'Another runtime install is in progress; retry shortly.' >&2; exit 1; }
  sleep 1
done
lock="$base/@DIGEST@.lock"
if [ ! -f "$base/@DIGEST@/.complete" ]; then
  mv "$stage/runtime" "$base/@DIGEST@"
fi
"#;

pub fn install_script(digest: &str) -> Result<String> {
    if !valid_digest(digest) {
        return Err(Error::invalid("Invalid runtime digest"));
    }
    Ok(INSTALL.replace("@DIGEST@", digest))
}

/// The archive arrives on stdin.
pub fn stream_install_command(digest: &str) -> Result<String> {
    Ok(sh(&install_script(digest)?))
}

/// The host fetches the archive itself; the install script checks the pinned digest.
pub fn host_install_command(digest: &str, url: &str, downloader: Downloader) -> Result<String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err(Error::invalid("Invalid runtime download URL"));
    }
    let fetch = match downloader {
        Downloader::Curl => "curl -fsSL --connect-timeout 15 --speed-limit 1024 --speed-time 30",
        Downloader::Wget => "wget -qO- -T 15",
    };
    let pipeline = format!(
        "{fetch} {} | sh -c {}",
        shell_quote(url),
        shell_quote(&install_script(digest)?)
    );
    Ok(sh(&pipeline))
}

/// Prints the runtime's PID on stderr; stdout carries only protocol frames.
pub fn launch_command(digest: &str) -> String {
    let remote = remote(digest);
    let script = format!(
        "echo $$ >&2; cd {remote} || exit 1; unset NODE_OPTIONS NODE_PATH OXBIT_LSP_COMMAND; \
         exec {remote}/bin/node {remote}/desktop.js"
    );
    sh(&script)
}

/// Stops an earlier runtime of ours that outlived its SSH connection, so its workspace lock frees.
pub fn stop_stale_command(pid: u32) -> String {
    let script = format!(
        "case \"$(ps -p {pid} -o args= 2>/dev/null)\" in *\"/.oxbit/remote/runtimes/\"*desktop.js*) \
         kill -TERM {pid}; i=0; while kill -0 {pid} 2>/dev/null && [ $i -lt 50 ]; do sleep 0.1; i=$((i + 1)); done;; esac"
    );
    sh(&script)
}

/// The dialog's folder as desktop.js expects it: absolute, or under `/~` for the home folder.
pub fn remote_root(path: &str) -> Result<String> {
    let path = path.trim();
    if path.len() > 4096 || path.chars().any(char::is_control) {
        return Err(Error::invalid(
            "Remote paths cannot contain control characters",
        ));
    }
    if path.starts_with('/') {
        return Ok(path.to_string());
    }
    let relative = path
        .strip_prefix('~')
        .unwrap_or(path)
        .trim_start_matches('/');
    let relative = relative.trim_end_matches('/');
    Ok(if relative.is_empty() {
        "/~".into()
    } else {
        format!("/~/{relative}")
    })
}

/// The workspace key's root for a resolved folder: under home it takes the `/~` form `remote_root`
/// gives, so earlier keys stay the same and every spelling of one folder shares a key.
pub fn key_root(home: &str, folder: &str) -> String {
    let home = home.trim_end_matches('/');
    if home.is_empty() {
        return folder.to_string();
    }
    if folder == home {
        return "/~".into();
    }
    match folder
        .strip_prefix(home)
        .and_then(|rest| rest.strip_prefix('/'))
    {
        Some(rest) if !rest.is_empty() => format!("/~/{}", rest.trim_end_matches('/')),
        _ => folder.to_string(),
    }
}
