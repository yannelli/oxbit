//! Tauri commands that start, resume, and stop an Oxbit runtime on a connected SSH host. The
//! WebView reaches it through a loopback tunnel with the token from the launch frame.
use super::{
    fs_commands::absolute,
    runtime_install::{self, Fetch, Source},
    runtime_process::{Event, Options, Ready},
    runtime_protocol::{key_root, remote_root},
    runtime_session::RemoteRuntime,
    sftp,
};
use crate::{
    fs_core::{revision, Error, Result},
    AppState,
};
use serde::Serialize;
use serde_json::Value;
use std::{path::PathBuf, sync::Arc, time::Duration};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_oxbit_files::OxbitFilesExt;

const READY_TIMEOUT: Duration = Duration::from_secs(25);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    pub url: String,
    pub token: String,
    pub workspace_key: String,
    #[serde(flatten)]
    pub ready: Ready,
}

fn started(runtime: &RemoteRuntime, ready: Ready) -> Started {
    Started {
        url: runtime.url(),
        token: runtime.token().to_string(),
        workspace_key: runtime.workspace_key().to_string(),
        ready,
    }
}

/// `id` is the runtime's ID, so stopping the runtime cancels its download.
fn device_fetch(app: AppHandle, id: String) -> Fetch {
    Arc::new(move |download| {
        let (app, id) = (app.clone(), id.clone());
        Box::pin(async move {
            let saved = tauri::async_runtime::spawn_blocking(move || {
                app.oxbit_files().download_runtime(
                    &id,
                    &download.url,
                    &download.sha256,
                    download.size,
                )
            })
            .await
            .map_err(|_| Error::new("REMOTE_RUNTIME", "The download did not finish."))?
            .map_err(|error| Error::new("REMOTE_RUNTIME", error.to_string()))?;
            saved
                .get("path")
                .and_then(Value::as_str)
                .map(PathBuf::from)
                .ok_or_else(|| Error::new("REMOTE_RUNTIME", "The download did not finish."))
        })
    })
}

/// The folder the host resolves `path` to (a file's folder), in `key_root` form. `None` leaves
/// the launch root as the key, and the runtime reports the missing folder.
async fn resolved_root(state: &AppState, host_id: &str, path: &str) -> Option<String> {
    let connection = state.ssh.pool.connection(host_id).await.ok()?;
    let requested = absolute(&connection.home, path).ok()?;
    let canonical = connection.sftp.canonicalize(requested).await.ok()?;
    let metadata = connection.sftp.metadata(canonical.clone()).await.ok()?;
    let folder = if metadata.file_type().is_dir() {
        canonical.as_str()
    } else {
        sftp::parent(&canonical)
    };
    Some(key_root(&connection.home, folder))
}

fn runtime(state: &AppState, id: &str) -> Result<Arc<RemoteRuntime>> {
    state
        .ssh
        .runtimes
        .lock()
        .unwrap()
        .get(id)
        .cloned()
        .ok_or_else(|| {
            Error::new(
                "REMOTE_RUNTIME",
                "This remote workspace is closed. Start it again.",
            )
        })
}

/// `id` names the progress events (`ios-ssh-runtime:<id>`) and the later resume and stop calls.
#[tauri::command]
pub async fn ios_ssh_runtime_start(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    host_id: String,
    path: String,
    keep_alive: Option<u64>,
) -> Result<Started> {
    if id.is_empty() || id.len() > 64 || state.ssh.runtimes.lock().unwrap().contains_key(&id) {
        return Err(Error::invalid("Invalid remote workspace ID"));
    }
    state.ssh.hosts.get(&host_id)?;
    let root = remote_root(&path)?;
    let key = resolved_root(&state, &host_id, &path)
        .await
        .unwrap_or_else(|| root.clone());
    let workspace_key = revision(format!("ssh-runtime\0{host_id}\0{key}").as_bytes());
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let (emitter, channel) = (app.clone(), format!("ios-ssh-runtime:{id}"));
    let events = Arc::new(move |event: Event| {
        let _ = emitter.emit(&channel, event);
    });
    let source = Source {
        lookup: Arc::new(runtime_install::pinned),
        fetch: device_fetch(app, id.clone()),
    };
    let options = Options {
        host_id,
        root,
        workspace_key,
        token,
        ready_timeout: READY_TIMEOUT,
        keep_alive,
    };
    let runtime = RemoteRuntime::open(state.ssh.pool.clone(), source, events, options).await?;
    state
        .ssh
        .runtimes
        .lock()
        .unwrap()
        .insert(id.clone(), runtime.clone());
    match runtime.ensure(true).await {
        Ok(ready) => Ok(started(&runtime, ready)),
        Err(error) => {
            state.ssh.runtimes.lock().unwrap().remove(&id);
            runtime.stop().await;
            Err(error)
        }
    }
}

/// After the app returns to the foreground or the user asks to reconnect.
#[tauri::command]
pub async fn ios_ssh_runtime_resume(state: State<'_, AppState>, id: String) -> Result<Started> {
    let runtime = runtime(&state, &id)?;
    let ready = runtime.ensure(true).await?;
    Ok(started(&runtime, ready))
}

#[tauri::command]
pub async fn ios_ssh_runtime_stop(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<()> {
    let removed = state.ssh.runtimes.lock().unwrap().remove(&id);
    if let Some(runtime) = removed {
        // A running install holds the launch lock until its download ends.
        let _ = app.oxbit_files().cancel_runtime_download(&id);
        runtime.stop().await;
    }
    Ok(())
}
