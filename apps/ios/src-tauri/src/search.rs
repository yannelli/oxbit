use crate::{
    fs_core::{Error, Result},
    git_operations::Operations,
    search_core::{self, SearchOptions},
    AppState,
};
use serde::Deserialize;
use serde_json::Value;
use std::sync::LazyLock;
use tauri::State;

/// Cancellation flags keyed by root and request; searches on one root run concurrently.
static SEARCHES: LazyLock<Operations> = LazyLock::new(Operations::default);

#[derive(Deserialize)]
struct FilesParams {
    query: String,
}

fn validate_request_id(request_id: &str) -> Result<()> {
    if request_id.len() != 36 || uuid::Uuid::parse_str(request_id).is_err() {
        return Err(Error::invalid("Search request ID must be a UUID"));
    }
    Ok(())
}

fn parse<T: for<'de> Deserialize<'de>>(params: Value) -> Result<T> {
    serde_json::from_value(params).map_err(|error| Error::invalid(error.to_string()))
}

/// `method` is `search` (content search) or `files` (quick-open paths).
#[tauri::command]
pub async fn ios_search_request(
    state: State<'_, AppState>,
    id: String,
    request_id: String,
    method: String,
    params: Value,
) -> Result<Value> {
    validate_request_id(&request_id)?;
    let root = state.roots.lock().unwrap().get(&id)?.clone();
    let operation = SEARCHES.register(&id, &request_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let cancel = operation.cancellation();
        let result = match method.as_str() {
            "search" => serde_json::to_value(search_core::search(
                &root,
                &parse::<SearchOptions>(params)?,
                cancel,
            )?),
            "files" => serde_json::to_value(search_core::find_files(
                &root,
                &parse::<FilesParams>(params)?.query,
                cancel,
            )?),
            _ => return Err(Error::invalid("Unknown search method")),
        };
        result.map_err(|error| Error::new("IO", error.to_string()))
    })
    .await
    .map_err(|_| Error::new("IO", "Native search failed"))?
}

#[tauri::command]
pub fn ios_search_cancel(state: State<'_, AppState>, id: String, request_id: String) -> Result<()> {
    validate_request_id(&request_id)?;
    state.roots.lock().unwrap().get(&id)?;
    SEARCHES.cancel(&id, &request_id)
}
