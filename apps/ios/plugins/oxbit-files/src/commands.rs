use tauri::{command, AppHandle, Runtime};

use crate::{models::*, OxbitFilesExt, Result};

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
