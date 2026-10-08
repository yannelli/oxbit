use crate::{
    fs_core::{Error, Result},
    git_core,
    git_requests::{safe_output, validate_request, validate_request_id},
    AppState,
};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_oxbit_files::OxbitFilesExt;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    request_id: &'a str,
    data: String,
}

#[tauri::command]
pub async fn ios_git_request(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    request_id: String,
    method: String,
    params: Value,
) -> Result<Value> {
    validate_request_id(&request_id)?;
    validate_request(&method, &params)?;
    let (root, operation) = {
        let roots = state
            .roots
            .lock()
            .map_err(|_| Error::new("IO", "Workspace roots are unavailable"))?;
        let root = roots.get(&id)?.clone();
        let operation = state.git.register(&id, &request_id)?;
        (root, operation)
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = operation.lock();
        if operation.is_cancelled() {
            return Err(Error::new("CANCELLED", "Git operation cancelled"));
        }
        let response = app
            .oxbit_files()
            .read_git_credentials()
            .map_err(|_| Error::new("AUTH", "Could not read Git credentials"))?;
        let mut credentials: git_core::Credentials = serde_json::from_value(response)
            .map_err(|_| Error::new("AUTH", "Invalid native Git credentials"))?;
        if git_core::creates_commit(&method) {
            credentials.signer = app
                .oxbit_files()
                .commit_signer()
                .map_err(|error| Error::new("COMMIT_SIGNING", error.to_string()))?;
        }
        if operation.is_cancelled() {
            return Err(Error::new("CANCELLED", "Git operation cancelled"));
        }
        let event = format!("ios-git-progress:{id}");
        let progress = |data: &str| {
            let data = safe_output(data, &credentials.tokens());
            if !data.is_empty() {
                let _ = app.emit(
                    &event,
                    Progress {
                        request_id: &request_id,
                        data,
                    },
                );
            }
        };
        git_core::dispatch(
            &root,
            &method,
            &params,
            &credentials,
            operation.cancellation(),
            &progress,
        )
        .map_err(|error| {
            Error::new(
                error.code,
                safe_output(&error.message, &credentials.tokens()),
            )
        })
    })
    .await
    .map_err(|_| Error::new("IO", "Native Git operation failed"))?
}

#[tauri::command]
pub fn ios_git_cancel(state: State<'_, AppState>, id: String, request_id: String) -> Result<()> {
    validate_request_id(&request_id)?;
    let roots = state
        .roots
        .lock()
        .map_err(|_| Error::new("IO", "Workspace roots are unavailable"))?;
    roots.get(&id)?;
    state.git.cancel(&id, &request_id)
}
