//! Application-wide declarative packs. No extension code reaches the runtime loader.
use crate::{
    commands::{local, Desktop},
    model::atomic_json,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, fs, path::Path};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
#[derive(Clone, Serialize, Deserialize)]
struct Installed {
    revision: String,
    enabled: bool,
}
type Index = BTreeMap<String, Installed>;
fn revision(value: &str) -> Result<(), String> {
    uuid::Uuid::parse_str(value)
        .map(|_| ())
        .map_err(|_| "Invalid icon revision".into())
}
fn index(directory: &Path) -> Result<Index, String> {
    match fs::read(directory.join("index.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|_| "Icon pack index is corrupt; preserve it before recovery".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(_) => Err("Cannot read icon pack index".into()),
    }
}
fn read(directory: &Path) -> Result<Vec<Value>, String> {
    let mut packs = Vec::new();
    for (id, item) in index(directory)? {
        revision(&item.revision)?;
        let path = directory
            .join("revisions")
            .join(format!("{}.json", item.revision));
        // A corrupt/missing revision leaves its index entry and configured selection intact.
        let Ok(bytes) = fs::read(path) else { continue };
        let Ok(mut pack) = serde_json::from_slice::<Value>(&bytes) else {
            continue;
        };
        if pack.get("id").and_then(Value::as_str) != Some(&id) {
            continue;
        }
        pack["enabled"] = Value::Bool(item.enabled);
        packs.push(pack);
    }
    Ok(packs)
}
fn mutate(
    directory: &Path,
    operation: &str,
    id: &str,
    pack: Option<Value>,
    enabled: Option<bool>,
) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 512
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
    {
        return Err("Invalid icon pack ID".into());
    }
    let mut next = index(directory)?;
    match operation {
        "put" => {
            let pack = pack.ok_or("Missing icon pack")?;
            if pack.get("id").and_then(Value::as_str) != Some(id)
                || pack.get("formatVersion").and_then(Value::as_u64) != Some(1)
            {
                return Err("Invalid icon pack metadata".into());
            }
            let rev = pack
                .get("revision")
                .and_then(Value::as_str)
                .ok_or("Missing icon revision")?;
            revision(rev)?;
            if serde_json::to_vec(&pack)
                .map_err(|_| "Invalid icon pack")?
                .len()
                > 300 * 1024 * 1024
            {
                return Err("Icon pack exceeds storage limit".into());
            }
            let path = directory.join("revisions").join(format!("{}.json", rev));
            if path.exists() {
                return Err("Icon revisions are immutable".into());
            }
            atomic_json(&path, &pack)?;
            let enabled = next.get(id).map(|item| item.enabled).unwrap_or(true);
            next.insert(
                id.into(),
                Installed {
                    revision: rev.into(),
                    enabled,
                },
            );
        }
        "remove" => {
            next.remove(id);
        }
        "enable" => {
            if let Some(item) = next.get_mut(id) {
                item.enabled = enabled.ok_or("Missing enabled state")?;
            }
        }
        _ => return Err("Invalid icon pack operation".into()),
    }
    // The old index remains valid if persisting the new revision or index fails.
    atomic_json(&directory.join("index.json"), &next)?;
    if let Ok(entries) = fs::read_dir(directory.join("revisions")) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(rev) = path.file_stem().and_then(|n| n.to_str()) else {
                continue;
            };
            if revision(rev).is_ok() && !next.values().any(|item| item.revision == rev) {
                let _ = fs::remove_file(path);
            }
        }
    }
    Ok(())
}
#[tauri::command]
pub fn desktop_icon_packs_read(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Vec<Value>, String> {
    local(&window)?;
    let desktop = app.state::<Desktop>();
    let _guard = desktop.storage.lock().unwrap();
    read(&desktop.directory.join("icon-packs-v1"))
}
#[tauri::command]
pub fn desktop_icon_packs_mutate(
    app: AppHandle,
    window: WebviewWindow,
    operation: String,
    id: String,
    pack: Option<Value>,
    enabled: Option<bool>,
) -> Result<(), String> {
    local(&window)?;
    let desktop = app.state::<Desktop>();
    let _guard = desktop.storage.lock().unwrap();
    mutate(
        &desktop.directory.join("icon-packs-v1"),
        &operation,
        &id,
        pack,
        enabled,
    )?;
    let _ = app.emit("icon-packs-changed", ());
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn revisions_are_atomic_and_shared_across_projects() {
        let directory =
            std::env::temp_dir().join(format!("oxbit-icon-test-{}", uuid::Uuid::new_v4()));
        let rev = uuid::Uuid::new_v4().to_string();
        let pack = serde_json::json!({"id":"test.icons","revision":rev,"formatVersion":1});
        mutate(&directory, "put", "test.icons", Some(pack.clone()), None).unwrap();
        assert!(mutate(&directory, "put", "test.icons", Some(pack), None).is_err());
        assert_eq!(read(&directory).unwrap().len(), 1);
        mutate(&directory, "enable", "test.icons", None, Some(false)).unwrap();
        assert_eq!(read(&directory).unwrap()[0]["enabled"], false);
        let bad =
            serde_json::json!({"id":"test.icons","revision":"../../escape","formatVersion":1});
        assert!(mutate(&directory, "put", "test.icons", Some(bad), None).is_err());
        assert_eq!(read(&directory).unwrap()[0]["revision"], rev);
        mutate(&directory, "remove", "test.icons", None, None).unwrap();
        assert!(read(&directory).unwrap().is_empty());
        assert_eq!(
            fs::read_dir(directory.join("revisions")).unwrap().count(),
            0
        );
        fs::remove_dir_all(directory).unwrap();
    }
}
