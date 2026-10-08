use tauri::{command, AppHandle, Runtime};

use crate::{
    commit_signing::validate_commit_signing_request,
    git_credentials::{git_credential_metadata, validate_git_credential_request},
    models::*,
    ssh_keys::{ssh_key_metadata, validate_ssh_key_request},
    OxbitFilesExt, Result,
};

#[command]
pub(crate) async fn pick_folder<R: Runtime>(app: AppHandle<R>) -> Result<Folder> {
    app.oxbit_files().pick_folder()
}

#[command]
pub(crate) async fn open_folder<R: Runtime>(app: AppHandle<R>, id: String) -> Result<Folder> {
    app.oxbit_files().open_folder(id)
}

#[command]
pub(crate) async fn close_folder<R: Runtime>(app: AppHandle<R>, id: String) -> Result<()> {
    app.oxbit_files().close_folder(id)
}

#[command]
pub(crate) async fn forget_folder<R: Runtime>(app: AppHandle<R>, id: String) -> Result<()> {
    app.oxbit_files().forget_folder(id)
}

#[command]
pub(crate) async fn documents_path<R: Runtime>(app: AppHandle<R>) -> Result<DocumentsPath> {
    app.oxbit_files().documents_path()
}

#[command]
pub(crate) async fn runtime_credentials<R: Runtime>(
    app: AppHandle<R>,
    request: serde_json::Value,
) -> Result<serde_json::Value> {
    app.oxbit_files().runtime_credentials(request)
}

#[command]
pub(crate) async fn git_credentials<R: Runtime>(
    app: AppHandle<R>,
    request: serde_json::Value,
) -> Result<serde_json::Value> {
    validate_git_credential_request(&request)?;
    git_credential_metadata(app.oxbit_files().git_credentials(request)?)
}

#[command]
pub(crate) async fn ssh_keys<R: Runtime>(
    app: AppHandle<R>,
    request: serde_json::Value,
) -> Result<serde_json::Value> {
    validate_ssh_key_request(&request)?;
    ssh_key_metadata(app.oxbit_files().ssh_keys(request)?)
}

#[command]
pub(crate) async fn pick_files<R: Runtime>(
    app: AppHandle<R>,
    multiple: Option<bool>,
) -> Result<PickedFiles> {
    app.oxbit_files().pick_files(multiple.unwrap_or(false))
}

#[command]
pub(crate) async fn commit_signing<R: Runtime>(
    app: AppHandle<R>,
    request: serde_json::Value,
) -> Result<serde_json::Value> {
    let request = validate_commit_signing_request(request)?;
    crate::commit_signing::commit_signing(request, |stored| {
        app.oxbit_files().commit_signing(stored)
    })
}
