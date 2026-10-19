use crate::{
    commands::{local, runtime_resources, Desktop},
    environment,
};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader, Read},
    os::unix::process::CommandExt,
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

/// The running `oxbit remote pair` per window label.
static PAIRING: Mutex<BTreeMap<String, Child>> = Mutex::new(BTreeMap::new());

const UNAVAILABLE: &str = "Bundled runtime could not be started. Reinstall Oxbit.";

fn remote(app: &AppHandle, action: &str, extra: &[&str]) -> Result<Command, String> {
    let resource = runtime_resources(app)?;
    let mut command = Command::new(resource.join("bin/node"));
    command
        .arg(resource.join("cli.js"))
        .args(["remote", action, "--json"])
        .args(extra)
        .current_dir("/")
        .env_clear()
        .envs(&app.state::<Desktop>().environment)
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH");
    Ok(command)
}

/// The CLI prints `{"error":{"code","message"}}` on failure; `status` also exits 1 with a full object.
fn outcome(success: bool, lines: Vec<Value>) -> Result<Vec<Value>, String> {
    if let Some(message) = lines
        .iter()
        .find_map(|line| line.pointer("/error/message").and_then(Value::as_str))
    {
        return Err(message.to_string());
    }
    if lines.is_empty() && !success {
        return Err("Remote access did not respond".into());
    }
    Ok(lines)
}

fn parse(bytes: &[u8]) -> Vec<Value> {
    String::from_utf8_lossy(bytes)
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

fn once(app: &AppHandle, action: &str, extra: &[&str]) -> Result<Vec<Value>, String> {
    let command = remote(app, action, extra)?;
    let (success, bytes) = environment::capture(command, Duration::from_secs(60), 1 << 20)
        .map_err(|error| match error.as_str() {
            "Executable could not be started" => UNAVAILABLE.to_string(),
            _ => "Remote access did not respond".to_string(),
        })?;
    outcome(success, parse(&bytes))
}

fn stop(mut child: Child) {
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.wait();
}

/// Emits each line to the window as `desktop-remote-access` until the CLI exits or is cancelled.
fn pair(app: &AppHandle, label: &str, request: &str) -> Result<Vec<Value>, String> {
    let mut child = remote(app, "pair", &[])?
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .map_err(|_| UNAVAILABLE)?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Remote access output is unavailable")?;
    let id = child.id();
    if let Some(previous) = PAIRING.lock().unwrap().insert(label.into(), child) {
        stop(previous);
    }
    let mut reader = BufReader::new(stdout);
    let mut lines = Vec::new();
    loop {
        let mut bytes = Vec::new();
        match (&mut reader).take(65537).read_until(b'\n', &mut bytes) {
            Ok(0) | Err(_) => break,
            _ if bytes.len() > 65536 => break,
            _ => {}
        }
        let Ok(line) = serde_json::from_slice::<Value>(&bytes) else {
            continue;
        };
        let _ = app.emit_to(
            label,
            "desktop-remote-access",
            json!({"request": request, "line": line}),
        );
        lines.push(line);
    }
    let mut pairing = PAIRING.lock().unwrap();
    if pairing.get(label).is_some_and(|child| child.id() == id) {
        if let Some(child) = pairing.remove(label) {
            stop(child);
        }
    }
    outcome(true, lines)
}

/// Runs `oxbit remote <action> --json` with the bundled Node and returns its JSON lines.
#[tauri::command]
pub async fn desktop_remote_access(
    app: AppHandle,
    window: WebviewWindow,
    action: String,
    device: Option<String>,
    request: Option<String>,
) -> Result<Vec<Value>, String> {
    local(&window)?;
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || match action.as_str() {
        "status" => once(&app, "status", &[]),
        "enable" => once(&app, "enable", &["--no-pair"]),
        "disable" => once(&app, "disable", &[]),
        "revoke" => {
            let device = device.filter(|value| !value.is_empty() && value.len() <= 256);
            once(
                &app,
                "revoke",
                &["--", device.as_deref().ok_or("Choose a device")?],
            )
        }
        "pair" => pair(&app, &label, request.as_deref().unwrap_or_default()),
        "cancel" => {
            if let Some(child) = PAIRING.lock().unwrap().remove(&label) {
                stop(child);
            }
            Ok(Vec::new())
        }
        _ => Err("Unknown remote access action".into()),
    })
    .await
    .map_err(|_| "Remote access failed")?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reports_cli_errors_and_keeps_status_output() {
        let status = parse(b"{\"enabled\":false,\"running\":false}\nnoise\n");
        assert_eq!(outcome(false, status).unwrap().len(), 1);
        let failed = parse(b"{\"error\":{\"code\":\"NOT_FOUND\",\"message\":\"No device\"}}\n");
        assert_eq!(outcome(false, failed).unwrap_err(), "No device");
        assert!(outcome(false, Vec::new()).is_err());
    }
}
