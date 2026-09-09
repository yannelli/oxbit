//! Native JSON persistence: `profile.json` for user settings, `session.json` for recents, and
//! `workspaces/<id>/ui.json` per workspace. Mirrors the desktop `ui.json` store.
use crate::fs_core::{Error, Result};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    sync::Mutex,
};

pub const MAX_STORAGE_BYTES: usize = 64 * 1024 * 1024;
const MAX_KEY_LENGTH: usize = 4096;

pub fn atomic_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| Error::new("IO", "Invalid state path"))?;
    fs::create_dir_all(parent)
        .map_err(|_| Error::new("IO", "Cannot create application state directory"))?;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let bytes = serde_json::to_vec(value)
            .map_err(|_| Error::new("IO", "Cannot serialize application state"))?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)
            .map_err(|_| Error::new("IO", "Cannot write application state"))?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| Error::new("IO", "Cannot flush application state"))?;
        fs::rename(&temporary, path)
            .map_err(|_| Error::new("IO", "Cannot replace application state"))?;
        fs::File::open(parent)
            .and_then(|dir| dir.sync_all())
            .map_err(|_| Error::new("IO", "Cannot flush state directory"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

type Entries = BTreeMap<String, Value>;

pub struct Storage {
    directory: PathBuf,
    cache: Mutex<BTreeMap<String, Entries>>,
}

impl Storage {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            cache: Mutex::new(BTreeMap::new()),
        }
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }

    fn file(&self, scope: &str) -> Result<PathBuf> {
        match scope {
            "profile" => Ok(self.directory.join("profile.json")),
            "session" => Ok(self.directory.join("session.json")),
            _ => {
                let hex = scope
                    .strip_prefix("ios:")
                    .filter(|hex| hex.len() == 64 && hex.chars().all(|c| c.is_ascii_hexdigit()));
                match hex {
                    Some(hex) => Ok(self.directory.join("workspaces").join(hex).join("ui.json")),
                    None => Err(Error::invalid(format!("Invalid storage scope: {scope}"))),
                }
            }
        }
    }

    fn load(&self, scope: &str) -> Result<Entries> {
        match fs::read(self.file(scope)?) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| {
                Error::new(
                    "IO",
                    "Recovery data is unreadable; preserve ui.json before resetting it",
                )
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Entries::new()),
            Err(_) => Err(Error::new("IO", "Recovery data could not be read")),
        }
    }

    pub fn get(&self, scope: &str, key: &str) -> Result<Option<Value>> {
        let mut cache = self.cache.lock().unwrap();
        if !cache.contains_key(scope) {
            let entries = self.load(scope)?;
            cache.insert(scope.to_string(), entries);
        }
        Ok(cache[scope].get(key).cloned())
    }

    pub fn set(&self, scope: &str, key: &str, value: Option<Value>) -> Result<()> {
        if key.len() > MAX_KEY_LENGTH {
            return Err(Error::invalid("Storage key is too large"));
        }
        let path = self.file(scope)?;
        self.get(scope, key)?;
        let mut cache = self.cache.lock().unwrap();
        let entries = cache
            .get_mut(scope)
            .ok_or_else(|| Error::new("IO", "Storage is unavailable"))?;
        let mut next = entries.clone();
        match value {
            Some(value) => {
                next.insert(key.to_string(), value);
            }
            None => {
                next.remove(key);
            }
        }
        if serde_json::to_vec(&next)
            .map_err(|_| Error::invalid("Invalid recovery data"))?
            .len()
            > MAX_STORAGE_BYTES
        {
            return Err(Error::new(
                "TOO_LARGE",
                "Recovery data exceeds 64 MiB. Save large documents before closing.",
            ));
        }
        atomic_json(&path, &next)?;
        *entries = next;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_scopes_and_rejects_bad_ones() {
        let directory =
            std::env::temp_dir().join(format!("oxbit-ios-storage-{}", uuid::Uuid::new_v4()));
        let storage = Storage::new(directory.clone());
        let scope = format!("ios:{}", "a".repeat(64));
        storage
            .set(&scope, "layout", Some(serde_json::json!({ "panel": true })))
            .unwrap();
        storage
            .set(
                "profile",
                "profile-settings",
                Some(serde_json::json!({ "user": {} })),
            )
            .unwrap();
        assert_eq!(
            storage.get(&scope, "layout").unwrap(),
            Some(serde_json::json!({ "panel": true }))
        );
        assert!(directory
            .join("workspaces")
            .join("a".repeat(64))
            .join("ui.json")
            .exists());
        assert!(directory.join("profile.json").exists());
        let reopened = Storage::new(directory.clone());
        assert_eq!(
            reopened.get(&scope, "layout").unwrap(),
            Some(serde_json::json!({ "panel": true }))
        );
        reopened.set(&scope, "layout", None).unwrap();
        assert_eq!(reopened.get(&scope, "layout").unwrap(), None);
        assert_eq!(
            storage.get("bogus", "x").unwrap_err().code,
            "INVALID_PARAMS"
        );
        assert_eq!(
            storage.get("ios:../escape", "x").unwrap_err().code,
            "INVALID_PARAMS"
        );
        fs::remove_dir_all(directory).unwrap();
    }
}
