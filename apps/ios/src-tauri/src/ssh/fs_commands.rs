//! Tauri commands for SFTP workspace roots and transfers. Paths use the same normalization as
//! device folders; each operation runs on the host's pooled connection.
use super::{
    commands::picked_file,
    sftp,
    transfer::{self, Progress, Summary},
    RemoteRoot,
};
use crate::{
    commands::{header, percent_decode},
    fs_core::{normalize, Entry, Error, Opened, Result, WriteResult},
    AppState,
};
use std::path::PathBuf;
use tauri::{
    ipc::{InvokeBody, Request, Response},
    AppHandle, Emitter, State,
};

fn absolute(home: &str, requested: &str) -> Result<String> {
    let requested = requested.trim();
    if requested.contains('\0') || requested.len() > 4096 {
        return Err(Error::invalid("Invalid remote folder"));
    }
    Ok(match requested {
        "" | "~" => home.to_string(),
        path if path.starts_with('/') => path.to_string(),
        path => format!(
            "{}/{}",
            home.trim_end_matches('/'),
            path.strip_prefix("~/").unwrap_or(path)
        ),
    })
}

#[tauri::command]
pub async fn ios_ssh_open_root(
    state: State<'_, AppState>,
    host_id: String,
    path: String,
) -> Result<Opened> {
    let ssh = &state.ssh;
    let connection = ssh.pool.connection(&host_id).await?;
    let requested = absolute(&connection.home, &path)?;
    let canonical = connection
        .sftp
        .canonicalize(requested.clone())
        .await
        .map_err(|error| sftp::sftp_error(error, &requested))?;
    let metadata = connection
        .sftp
        .metadata(canonical.clone())
        .await
        .map_err(|error| sftp::sftp_error(error, &canonical))?;
    if !metadata.file_type().is_dir() {
        return Err(Error::new(
            "NOT_DIRECTORY",
            format!("Not a directory: {canonical}"),
        ));
    }
    let name = canonical
        .rsplit('/')
        .find(|part| !part.is_empty())
        .unwrap_or("/")
        .to_string();
    Ok(Opened {
        id: ssh.open_root(&host_id, &canonical),
        root: canonical,
        name,
    })
}

#[tauri::command]
pub async fn ios_ssh_close_root(state: State<'_, AppState>, id: String) -> Result<()> {
    state.ssh.close_root(&id);
    Ok(())
}

async fn on_root<T, F, Fut>(state: &AppState, id: &str, operation: F) -> Result<T>
where
    F: Fn(std::sync::Arc<super::connect::Connection>, RemoteRoot) -> Fut,
    Fut: std::future::Future<Output = Result<T>>,
{
    let root = state.ssh.root(id)?;
    let host_id = root.host_id.clone();
    state
        .ssh
        .pool
        .run(&host_id, |connection| operation(connection, root.clone()))
        .await
}

#[tauri::command]
pub async fn ios_ssh_fs_list(
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> Result<Vec<Entry>> {
    let relative = normalize(&path, true)?;
    on_root(&state, &id, |c, root| {
        let relative = relative.clone();
        async move { sftp::list(&c.sftp, &root.path, &relative).await }
    })
    .await
}

#[tauri::command]
pub async fn ios_ssh_fs_read(
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> Result<Response> {
    let relative = normalize(&path, false)?;
    on_root(&state, &id, |c, root| {
        let relative = relative.clone();
        async move { sftp::read(&c.sftp, &root.path, &relative).await }
    })
    .await
    .map(Response::new)
}

/// Raw-body command like `ios_fs_write`: bytes travel unencoded, metadata rides in headers.
#[tauri::command]
pub async fn ios_ssh_fs_write(
    state: State<'_, AppState>,
    request: Request<'_>,
) -> Result<WriteResult> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(Error::invalid("Write expects a binary body"));
    };
    let id = header(&request, "x-oxbit-root")?.to_string();
    let relative = normalize(&percent_decode(header(&request, "x-oxbit-path")?)?, false)?;
    let expected = header(&request, "x-oxbit-expected")?.to_string();
    let expected = (!expected.is_empty()).then_some(expected);
    on_root(&state, &id, |c, root| {
        let (relative, expected) = (relative.clone(), expected.clone());
        async move { sftp::write(&c.sftp, &root.path, &relative, bytes, expected.as_deref()).await }
    })
    .await
}

#[tauri::command]
pub async fn ios_ssh_fs_mkdir(state: State<'_, AppState>, id: String, path: String) -> Result<()> {
    let relative = normalize(&path, false)?;
    on_root(&state, &id, |c, root| {
        let relative = relative.clone();
        async move { sftp::mkdir(&c.sftp, &root.path, &relative).await }
    })
    .await
}

#[tauri::command]
pub async fn ios_ssh_fs_rename(
    state: State<'_, AppState>,
    id: String,
    path: String,
    to: String,
) -> Result<()> {
    let (relative, to) = (normalize(&path, false)?, normalize(&to, false)?);
    on_root(&state, &id, |c, root| {
        let (relative, to) = (relative.clone(), to.clone());
        async move { sftp::rename(&c.sftp, &root.path, &relative, &to).await }
    })
    .await
}

#[tauri::command]
pub async fn ios_ssh_fs_delete(state: State<'_, AppState>, id: String, path: String) -> Result<()> {
    let relative = normalize(&path, false)?;
    on_root(&state, &id, |c, root| {
        let relative = relative.clone();
        async move { sftp::delete(&c.sftp, &root.path, &relative).await }
    })
    .await
}

fn reporter(app: &AppHandle, transfer_id: &str) -> impl Fn(Progress) + Clone {
    let (app, event) = (app.clone(), format!("ios-ssh-transfer:{transfer_id}"));
    move |progress| {
        let _ = app.emit(&event, progress);
    }
}

#[tauri::command]
pub async fn ios_ssh_upload(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    transfer_id: String,
    directory: String,
    files: Vec<String>,
) -> Result<Summary> {
    let directory = normalize(&directory, true)?;
    let files = files
        .iter()
        .map(|file| picked_file(file))
        .collect::<Result<Vec<_>>>()?;
    let active = state.ssh.transfers.begin(&transfer_id)?;
    let report = reporter(&app, &transfer_id);
    let result = on_root(&state, &id, |c, root| {
        let (directory, files, cancelled, report) = (
            directory.clone(),
            files.clone(),
            active.cancelled.clone(),
            report.clone(),
        );
        async move {
            transfer::upload(&c.sftp, &root.path, &directory, &files, &cancelled, report).await
        }
    })
    .await;
    for file in &files {
        let _ = std::fs::remove_file(file);
    }
    result
}

#[tauri::command]
pub async fn ios_ssh_download(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    transfer_id: String,
    path: String,
    destination: String,
) -> Result<Summary> {
    let relative = normalize(&path, true)?;
    let destination = PathBuf::from(destination)
        .canonicalize()
        .map_err(|_| Error::new("NOT_FOUND", "The destination folder is unavailable."))?;
    if !destination.is_dir() {
        return Err(Error::new(
            "NOT_DIRECTORY",
            "Choose a folder to download into.",
        ));
    }
    let active = state.ssh.transfers.begin(&transfer_id)?;
    let report = reporter(&app, &transfer_id);
    on_root(&state, &id, |c, root| {
        let (relative, destination, cancelled, report) = (
            relative.clone(),
            destination.clone(),
            active.cancelled.clone(),
            report.clone(),
        );
        async move {
            transfer::download(
                &c.sftp,
                &root.path,
                &relative,
                &destination,
                &cancelled,
                report,
            )
            .await
        }
    })
    .await
}

#[tauri::command]
pub fn ios_ssh_transfer_cancel(state: State<'_, AppState>, transfer_id: String) {
    state.ssh.transfers.cancel(&transfer_id);
}
