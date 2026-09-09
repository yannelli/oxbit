use crate::{
    fs_core::{self, Entry, Error, Opened, Result, WriteResult},
    icon_packs, AppState,
};
use serde_json::Value;
use std::path::PathBuf;
use tauri::{
    ipc::{InvokeBody, Request, Response},
    AppHandle, Emitter, Manager, State,
};
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub fn ios_storage_get(
    state: State<'_, AppState>,
    scope: String,
    key: String,
) -> Result<Option<Value>> {
    state.storage.get(&scope, &key)
}

#[tauri::command]
pub fn ios_storage_set(
    state: State<'_, AppState>,
    scope: String,
    key: String,
    value: Option<Value>,
) -> Result<()> {
    state.storage.set(&scope, &key, value)
}

#[tauri::command]
pub fn ios_documents_path(app: AppHandle) -> Result<String> {
    let path = app
        .path()
        .document_dir()
        .map_err(|e| Error::new("IO", e.to_string()))?;
    std::fs::create_dir_all(&path).map_err(|e| Error::new("IO", e.to_string()))?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn ios_fs_open_root(state: State<'_, AppState>, path: String) -> Result<Opened> {
    state.roots.lock().unwrap().open(&PathBuf::from(path))
}

#[tauri::command]
pub fn ios_fs_close_root(state: State<'_, AppState>, id: String) -> Result<()> {
    state.watchers.stop(&id);
    state.roots.lock().unwrap().close(&id);
    Ok(())
}

fn root(state: &AppState, id: &str) -> Result<fs_core::Root> {
    state.roots.lock().unwrap().get(id).cloned()
}

#[tauri::command]
pub async fn ios_fs_list(
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> Result<Vec<Entry>> {
    let relative = fs_core::normalize(&path, true)?;
    root(&state, &id)?.list(&relative)
}

#[tauri::command]
pub async fn ios_fs_read(state: State<'_, AppState>, id: String, path: String) -> Result<Response> {
    let relative = fs_core::normalize(&path, false)?;
    root(&state, &id)?.read(&relative).map(Response::new)
}

fn header<'a>(request: &'a Request<'_>, name: &str) -> Result<&'a str> {
    request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| Error::invalid(format!("Missing {name} header")))
}

fn percent_decode(input: &str) -> Result<String> {
    let bytes = input.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok();
            match hex.and_then(|hex| u8::from_str_radix(hex, 16).ok()) {
                Some(byte) => {
                    output.push(byte);
                    index += 3;
                    continue;
                }
                None => return Err(Error::invalid("Invalid percent encoding")),
            }
        }
        output.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(output).map_err(|_| Error::invalid("Path is not UTF-8"))
}

/// Raw-body command: bytes travel unencoded; root, path, and expected revision ride in headers.
#[tauri::command]
pub fn ios_fs_write(state: State<'_, AppState>, request: Request<'_>) -> Result<WriteResult> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(Error::invalid("Write expects a binary body"));
    };
    let id = header(&request, "x-oxbit-root")?.to_string();
    let path = percent_decode(header(&request, "x-oxbit-path")?)?;
    let expected = header(&request, "x-oxbit-expected")?.to_string();
    let relative = fs_core::normalize(&path, false)?;
    root(&state, &id)?.write(
        &relative,
        bytes,
        (!expected.is_empty()).then_some(expected.as_str()),
    )
}

#[tauri::command]
pub async fn ios_fs_mkdir(state: State<'_, AppState>, id: String, path: String) -> Result<()> {
    root(&state, &id)?.mkdir(&fs_core::normalize(&path, false)?)
}

#[tauri::command]
pub async fn ios_fs_rename(
    state: State<'_, AppState>,
    id: String,
    path: String,
    to: String,
) -> Result<()> {
    root(&state, &id)?.rename(
        &fs_core::normalize(&path, false)?,
        &fs_core::normalize(&to, false)?,
    )
}

#[tauri::command]
pub async fn ios_fs_delete(state: State<'_, AppState>, id: String, path: String) -> Result<()> {
    root(&state, &id)?.delete(&fs_core::normalize(&path, false)?)
}

#[tauri::command]
pub fn ios_fs_watch(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<()> {
    let root = root(&state, &id)?;
    state.watchers.start(app, root)
}

#[tauri::command]
pub fn ios_fs_unwatch(state: State<'_, AppState>, id: String) -> Result<()> {
    state.watchers.stop(&id);
    Ok(())
}

#[tauri::command]
pub fn ios_icon_packs_read(state: State<'_, AppState>) -> Result<Vec<Value>> {
    icon_packs::read(&state.storage.directory().join("icon-packs-v1"))
}

#[tauri::command]
pub fn ios_icon_packs_mutate(
    app: AppHandle,
    state: State<'_, AppState>,
    operation: String,
    id: String,
    pack: Option<Value>,
    enabled: Option<bool>,
) -> Result<()> {
    icon_packs::mutate(
        &state.storage.directory().join("icon-packs-v1"),
        &operation,
        &id,
        pack,
        enabled,
    )?;
    let _ = app.emit("icon-packs-changed", ());
    Ok(())
}

#[tauri::command]
pub fn ios_open_external(app: AppHandle, url: String) -> Result<()> {
    let parsed = tauri::Url::parse(&url).map_err(|_| Error::invalid("Invalid URL"))?;
    if !["http", "https", "mailto"].contains(&parsed.scheme()) {
        return Err(Error::invalid(
            "This URL scheme cannot be opened externally",
        ));
    }
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|_| Error::new("IO", "Could not open the system browser"))
}

#[cfg(test)]
mod tests {
    use super::percent_decode;
    #[test]
    fn decodes_percent_sequences() {
        assert_eq!(
            percent_decode("src%2Fna%C3%AFve%20file.ts").unwrap(),
            "src/naïve file.ts"
        );
        assert_eq!(percent_decode("plain").unwrap(), "plain");
        assert!(percent_decode("bad%zz").is_err());
    }
}
