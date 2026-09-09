//! Application-wide icon packs, shared by every workspace. Same layout as the desktop store.
use crate::{
    fs_core::{Error, Result},
    storage::atomic_json,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, fs, path::Path};

#[derive(Clone, Serialize, Deserialize)]
struct Installed {
    revision: String,
    enabled: bool,
}
type Index = BTreeMap<String, Installed>;

fn revision(value: &str) -> Result<()> {
    uuid::Uuid::parse_str(value)
        .map(|_| ())
        .map_err(|_| Error::invalid("Invalid icon revision"))
}

fn index(directory: &Path) -> Result<Index> {
    match fs::read(directory.join("index.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| {
            Error::new(
                "IO",
                "Icon pack index is corrupt; preserve it before recovery",
            )
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(_) => Err(Error::new("IO", "Cannot read icon pack index")),
    }
}

pub fn read(directory: &Path) -> Result<Vec<Value>> {
    let mut packs = Vec::new();
    for (id, item) in index(directory)? {
        revision(&item.revision)?;
        let path = directory
            .join("revisions")
            .join(format!("{}.json", item.revision));
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

pub fn mutate(
    directory: &Path,
    operation: &str,
    id: &str,
    pack: Option<Value>,
    enabled: Option<bool>,
) -> Result<()> {
    if id.is_empty()
        || id.len() > 512
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
    {
        return Err(Error::invalid("Invalid icon pack ID"));
    }
    let mut next = index(directory)?;
    match operation {
        "put" => {
            let pack = pack.ok_or_else(|| Error::invalid("Missing icon pack"))?;
            if pack.get("id").and_then(Value::as_str) != Some(id)
                || pack.get("formatVersion").and_then(Value::as_u64) != Some(1)
            {
                return Err(Error::invalid("Invalid icon pack metadata"));
            }
            let rev = pack
                .get("revision")
                .and_then(Value::as_str)
                .ok_or_else(|| Error::invalid("Missing icon revision"))?;
            revision(rev)?;
            if serde_json::to_vec(&pack)
                .map_err(|_| Error::invalid("Invalid icon pack"))?
                .len()
                > 300 * 1024 * 1024
            {
                return Err(Error::new("TOO_LARGE", "Icon pack exceeds storage limit"));
            }
            let path = directory.join("revisions").join(format!("{rev}.json"));
            if path.exists() {
                return Err(Error::new("EXISTS", "Icon revisions are immutable"));
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
                item.enabled = enabled.ok_or_else(|| Error::invalid("Missing enabled state"))?;
            }
        }
        _ => return Err(Error::invalid("Invalid icon pack operation")),
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn revisions_are_atomic_and_shared() {
        let directory =
            std::env::temp_dir().join(format!("oxbit-ios-icons-{}", uuid::Uuid::new_v4()));
        let rev = uuid::Uuid::new_v4().to_string();
        let pack = serde_json::json!({"id":"test.icons","revision":rev,"formatVersion":1});
        mutate(&directory, "put", "test.icons", Some(pack.clone()), None).unwrap();
        assert!(mutate(&directory, "put", "test.icons", Some(pack), None).is_err());
        assert_eq!(read(&directory).unwrap().len(), 1);
        mutate(&directory, "enable", "test.icons", None, Some(false)).unwrap();
        assert_eq!(read(&directory).unwrap()[0]["enabled"], false);
        mutate(&directory, "remove", "test.icons", None, None).unwrap();
        assert!(read(&directory).unwrap().is_empty());
        fs::remove_dir_all(directory).unwrap();
    }
}
