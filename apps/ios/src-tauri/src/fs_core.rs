//! Workspace filesystem operations confined to registered roots. No Tauri dependency, so the
//! macOS host runs the tests. Error codes and messages mirror `apps/runtime/src/filesystem.ts`
//! because `packages/documents` classifies conflicts, missing files, and permissions from them.
use serde::{ser::SerializeStruct, Deserialize, Serialize, Serializer};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{self, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Component, Path, PathBuf},
    time::SystemTime,
};

pub const MAX_READ_BYTES: u64 = 20 * 1024 * 1024;
pub const WATCH_ENTRY_LIMIT: usize = 10_000;
const TEMP_PREFIX: &str = ".oxbit-tmp-";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
    pub code: &'static str,
    pub message: String,
}

impl Error {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new("INVALID_PARAMS", message)
    }
    fn io(error: io::Error, path: &str) -> Self {
        match error.kind() {
            io::ErrorKind::NotFound => Self::new(
                "NOT_FOUND",
                format!("ENOENT: no such file or directory: {path}"),
            ),
            io::ErrorKind::PermissionDenied => Self::new(
                "PERMISSION_DENIED",
                format!("EACCES: permission denied: {path}"),
            ),
            io::ErrorKind::AlreadyExists => {
                Self::new("EXISTS", format!("EEXIST: already exists: {path}"))
            }
            io::ErrorKind::ReadOnlyFilesystem => {
                Self::new("READ_ONLY", format!("EROFS: read-only file system: {path}"))
            }
            _ => Self::new("IO", format!("{error}: {path}")),
        }
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for Error {}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let mut state = serializer.serialize_struct("Error", 2)?;
        state.serialize_field("code", self.code)?;
        state.serialize_field("message", &self.message)?;
        state.end()
    }
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub path: String,
    pub name: String,
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub readonly: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub revision: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub path: String,
    pub kind: &'static str,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    pub id: String,
    pub root: String,
    pub name: String,
}

pub fn revision(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn root_id(canonical: &Path) -> String {
    format!("ios:{}", revision(canonical.as_os_str().as_encoded_bytes()))
}

/// Accepts a slash-separated workspace path with the same rules as `normalizePath` in
/// `packages/host-browser`; `""` addresses the root when `allow_root` is set.
pub fn normalize(path: &str, allow_root: bool) -> Result<String> {
    if path.contains('\0') || path.contains('\\') || path.starts_with('/') {
        return Err(Error::invalid(format!("Invalid workspace path: {path}")));
    }
    let parts: Vec<&str> = path
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect();
    if parts.contains(&"..") {
        return Err(Error::invalid(format!("Invalid workspace path: {path}")));
    }
    if parts.is_empty() && !allow_root {
        return Err(Error::invalid("A file path is required"));
    }
    Ok(parts.join("/"))
}

#[derive(Debug, Clone)]
pub struct Root {
    pub id: String,
    pub path: PathBuf,
    pub name: String,
}

#[derive(Debug, Default)]
pub struct Roots {
    roots: BTreeMap<String, Root>,
}

impl Roots {
    pub fn open(&mut self, path: &Path) -> Result<Opened> {
        let canonical = path
            .canonicalize()
            .map_err(|e| Error::io(e, &path.to_string_lossy()))?;
        if !canonical.is_dir() {
            return Err(Error::new(
                "NOT_DIRECTORY",
                format!("Not a directory: {}", canonical.display()),
            ));
        }
        let id = root_id(&canonical);
        let name = canonical
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| canonical.to_string_lossy().into_owned());
        self.roots.insert(
            id.clone(),
            Root {
                id: id.clone(),
                path: canonical.clone(),
                name: name.clone(),
            },
        );
        Ok(Opened {
            id,
            root: canonical.to_string_lossy().into_owned(),
            name,
        })
    }
    pub fn close(&mut self, id: &str) -> Option<Root> {
        self.roots.remove(id)
    }
    pub fn get(&self, id: &str) -> Result<&Root> {
        self.roots
            .get(id)
            .ok_or_else(|| Error::new("ROOT_CLOSED", "Workspace root is not open"))
    }
}

impl Root {
    /// Resolves a workspace path inside this root. The deepest existing ancestor is
    /// canonicalized so symlinks cannot escape, including for paths that do not exist yet.
    pub fn resolve(&self, relative: &str) -> Result<PathBuf> {
        let mut full = self.path.clone();
        for part in relative.split('/').filter(|part| !part.is_empty()) {
            full.push(part);
        }
        if full
            .components()
            .any(|component| matches!(component, Component::ParentDir))
        {
            return Err(Error::new(
                "PATH_DENIED",
                format!("Path escapes the workspace: {relative}"),
            ));
        }
        let mut existing = full.clone();
        while !existing.exists() {
            match existing.parent() {
                Some(parent) => existing = parent.to_path_buf(),
                None => {
                    return Err(Error::new(
                        "PATH_DENIED",
                        format!("Path escapes the workspace: {relative}"),
                    ))
                }
            }
        }
        let canonical = existing
            .canonicalize()
            .map_err(|e| Error::io(e, relative))?;
        if !canonical.starts_with(&self.path) {
            return Err(Error::new(
                "PATH_DENIED",
                format!("Path escapes the workspace: {relative}"),
            ));
        }
        Ok(full)
    }

    pub fn list(&self, relative: &str) -> Result<Vec<Entry>> {
        let directory = self.resolve(relative)?;
        let mut entries = Vec::new();
        let read = fs::read_dir(&directory).map_err(|e| Error::io(e, relative))?;
        for item in read {
            let item = item.map_err(|e| Error::io(e, relative))?;
            let name = item.file_name().to_string_lossy().into_owned();
            if name.starts_with(TEMP_PREFIX) {
                continue;
            }
            let metadata = match item.metadata() {
                Ok(metadata) => metadata,
                Err(_) => continue,
            };
            let path = if relative.is_empty() {
                name.clone()
            } else {
                format!("{relative}/{name}")
            };
            let readonly = metadata.permissions().readonly();
            if metadata.is_dir() {
                entries.push(Entry {
                    path,
                    name,
                    kind: "directory",
                    size: None,
                    readonly: None,
                });
            } else if metadata.is_file() {
                entries.push(Entry {
                    path,
                    name,
                    kind: "file",
                    size: Some(metadata.len()),
                    readonly: readonly.then_some(true),
                });
            }
        }
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(entries)
    }

    pub fn read(&self, relative: &str) -> Result<Vec<u8>> {
        let path = self.resolve(relative)?;
        let metadata = fs::metadata(&path).map_err(|e| Error::io(e, relative))?;
        if metadata.is_dir() {
            return Err(Error::new("NOT_FILE", format!("Not a file: {relative}")));
        }
        if metadata.len() > MAX_READ_BYTES {
            return Err(Error::new(
                "TOO_LARGE",
                format!("File exceeds 20 MiB: {relative}"),
            ));
        }
        fs::read(&path).map_err(|e| Error::io(e, relative))
    }

    pub fn write(
        &self,
        relative: &str,
        bytes: &[u8],
        expected: Option<&str>,
    ) -> Result<WriteResult> {
        let path = self.resolve(relative)?;
        let current = match fs::read(&path) {
            Ok(existing) => {
                if fs::metadata(&path).map(|m| m.is_dir()).unwrap_or(false) {
                    return Err(Error::new("NOT_FILE", format!("Not a file: {relative}")));
                }
                Some(existing)
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => None,
            Err(e) => return Err(Error::io(e, relative)),
        };
        let actual = current.as_deref().map(revision);
        if actual.as_deref() != expected {
            return Err(Error::new(
                "CONFLICT",
                format!("File revision conflict: {relative}"),
            ));
        }
        let parent = path
            .parent()
            .ok_or_else(|| Error::invalid("A file path is required"))?;
        let mode = fs::metadata(&path)
            .map(|m| m.permissions().mode())
            .unwrap_or(0o644);
        let temporary = parent.join(format!("{TEMP_PREFIX}{}", uuid::Uuid::new_v4()));
        let result = (|| {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(mode)
                .open(&temporary)
                .map_err(|e| Error::io(e, relative))?;
            file.write_all(bytes)
                .and_then(|_| file.sync_all())
                .map_err(|e| Error::io(e, relative))?;
            fs::rename(&temporary, &path).map_err(|e| Error::io(e, relative))
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result?;
        Ok(WriteResult {
            revision: revision(bytes),
            size: bytes.len() as u64,
        })
    }

    pub fn mkdir(&self, relative: &str) -> Result<()> {
        let path = self.resolve(relative)?;
        fs::create_dir_all(&path).map_err(|e| Error::io(e, relative))
    }

    pub fn rename(&self, relative: &str, to: &str) -> Result<()> {
        let from = self.resolve(relative)?;
        let target = self.resolve(to)?;
        if !from.exists() {
            return Err(Error::new(
                "NOT_FOUND",
                format!("ENOENT: no such file or directory: {relative}"),
            ));
        }
        if target.exists() {
            return Err(Error::new(
                "EXISTS",
                format!("EEXIST: already exists: {to}"),
            ));
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| Error::io(e, to))?;
        }
        fs::rename(&from, &target).map_err(|e| Error::io(e, relative))
    }

    pub fn delete(&self, relative: &str) -> Result<()> {
        let path = self.resolve(relative)?;
        let metadata = fs::symlink_metadata(&path).map_err(|e| Error::io(e, relative))?;
        if metadata.is_dir() {
            fs::remove_dir_all(&path).map_err(|e| Error::io(e, relative))
        } else {
            fs::remove_file(&path).map_err(|e| Error::io(e, relative))
        }
    }

    /// Modification times and sizes of every file, skipping `.git` and `node_modules`.
    pub fn snapshot(&self) -> Result<Snapshot> {
        let mut files = BTreeMap::new();
        let mut pending = vec![(self.path.clone(), String::new())];
        let mut count = 0usize;
        while let Some((directory, relative)) = pending.pop() {
            let Ok(read) = fs::read_dir(&directory) else {
                continue;
            };
            for item in read.flatten() {
                let name = item.file_name().to_string_lossy().into_owned();
                if name == ".git" || name == "node_modules" || name.starts_with(TEMP_PREFIX) {
                    continue;
                }
                let Ok(metadata) = item.metadata() else {
                    continue;
                };
                let path = if relative.is_empty() {
                    name.clone()
                } else {
                    format!("{relative}/{name}")
                };
                count += 1;
                if count > WATCH_ENTRY_LIMIT {
                    return Err(Error::new(
                        "WATCH_LIMIT",
                        "Workspace has too many entries to watch",
                    ));
                }
                if metadata.is_dir() {
                    pending.push((item.path(), path));
                } else if metadata.is_file() {
                    let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                    files.insert(path, (modified, metadata.len()));
                }
            }
        }
        Ok(Snapshot { files })
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Snapshot {
    files: BTreeMap<String, (SystemTime, u64)>,
}

impl Snapshot {
    pub fn changes(&self, next: &Snapshot) -> Vec<Change> {
        let mut changes = Vec::new();
        for (path, stamp) in &next.files {
            match self.files.get(path) {
                None => changes.push(Change {
                    path: path.clone(),
                    kind: "created",
                }),
                Some(previous) if previous != stamp => changes.push(Change {
                    path: path.clone(),
                    kind: "changed",
                }),
                Some(_) => {}
            }
        }
        for path in self.files.keys() {
            if !next.files.contains_key(path) {
                changes.push(Change {
                    path: path.clone(),
                    kind: "deleted",
                });
            }
        }
        changes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace() -> (PathBuf, Roots, String) {
        let directory = std::env::temp_dir().join(format!("oxbit-ios-fs-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(directory.join("src")).unwrap();
        fs::write(directory.join("src/a.txt"), b"hello").unwrap();
        let mut roots = Roots::default();
        let opened = roots.open(&directory).unwrap();
        (directory, roots, opened.id)
    }

    #[test]
    fn revision_matches_sha256_hex() {
        assert_eq!(
            revision(b"hello"),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    #[test]
    fn normalize_rejects_escapes_and_absolute_paths() {
        assert_eq!(normalize("./src//a.txt", false).unwrap(), "src/a.txt");
        assert_eq!(normalize("", true).unwrap(), "");
        assert!(normalize("", false).is_err());
        assert!(normalize("../x", false).is_err());
        assert!(normalize("/etc/passwd", false).is_err());
        assert!(normalize("a\\b", false).is_err());
    }

    #[test]
    fn lists_reads_writes_and_checks_revisions() {
        let (directory, roots, id) = workspace();
        let root = roots.get(&id).unwrap();
        let listed = root.list("").unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].kind, "directory");
        let files = root.list("src").unwrap();
        assert_eq!(files[0].path, "src/a.txt");
        assert_eq!(files[0].size, Some(5));
        let bytes = root.read("src/a.txt").unwrap();
        let current = revision(&bytes);
        assert_eq!(
            root.write("src/a.txt", b"stale", Some("nope"))
                .unwrap_err()
                .code,
            "CONFLICT"
        );
        assert_eq!(
            root.write("src/a.txt", b"stale", None).unwrap_err().code,
            "CONFLICT"
        );
        let written = root.write("src/a.txt", b"updated", Some(&current)).unwrap();
        assert_eq!(written.revision, revision(b"updated"));
        assert_eq!(fs::read(directory.join("src/a.txt")).unwrap(), b"updated");
        let fresh = root.write("src/new/b.txt", b"", None);
        assert_eq!(fresh.unwrap_err().code, "NOT_FOUND");
        root.mkdir("src/new").unwrap();
        root.write("src/new/b.txt", b"x", None).unwrap();
        assert!(fs::read_dir(directory.join("src")).unwrap().all(|e| !e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(TEMP_PREFIX)));
        assert_eq!(root.read("missing.txt").unwrap_err().code, "NOT_FOUND");
        assert!(root
            .read("missing.txt")
            .unwrap_err()
            .message
            .contains("ENOENT"));
        assert_eq!(root.read("src").unwrap_err().code, "NOT_FILE");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn confines_paths_to_the_root() {
        let (directory, roots, id) = workspace();
        let root = roots.get(&id).unwrap();
        assert_eq!(root.resolve("../outside").unwrap_err().code, "PATH_DENIED");
        let outside =
            std::env::temp_dir().join(format!("oxbit-ios-outside-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, directory.join("link")).unwrap();
        assert_eq!(
            root.write("link/file.txt", b"x", None).unwrap_err().code,
            "PATH_DENIED"
        );
        assert_eq!(root.list("link").unwrap_err().code, "PATH_DENIED");
        fs::remove_dir_all(outside).unwrap();
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn renames_and_deletes() {
        let (directory, roots, id) = workspace();
        let root = roots.get(&id).unwrap();
        root.rename("src/a.txt", "src/moved/b.txt").unwrap();
        assert!(directory.join("src/moved/b.txt").exists());
        root.write("src/c.txt", b"c", None).unwrap();
        assert_eq!(
            root.rename("src/c.txt", "src/moved/b.txt")
                .unwrap_err()
                .code,
            "EXISTS"
        );
        assert_eq!(
            root.rename("src/none", "src/x").unwrap_err().code,
            "NOT_FOUND"
        );
        root.delete("src/moved").unwrap();
        assert!(!directory.join("src/moved").exists());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn snapshots_detect_changes() {
        let (directory, roots, id) = workspace();
        let root = roots.get(&id).unwrap();
        let before = root.snapshot().unwrap();
        fs::write(directory.join("src/a.txt"), b"changed content").unwrap();
        fs::write(directory.join("src/b.txt"), b"new").unwrap();
        fs::create_dir_all(directory.join("node_modules/pkg")).unwrap();
        fs::write(directory.join("node_modules/pkg/index.js"), b"ignored").unwrap();
        let after = root.snapshot().unwrap();
        let mut changes = before.changes(&after);
        changes.sort_by(|a, b| a.path.cmp(&b.path));
        assert_eq!(
            changes,
            vec![
                Change {
                    path: "src/a.txt".into(),
                    kind: "changed"
                },
                Change {
                    path: "src/b.txt".into(),
                    kind: "created"
                }
            ]
        );
        fs::remove_file(directory.join("src/b.txt")).unwrap();
        let removed = after.changes(&root.snapshot().unwrap());
        assert_eq!(
            removed,
            vec![Change {
                path: "src/b.txt".into(),
                kind: "deleted"
            }]
        );
        fs::remove_dir_all(directory).unwrap();
    }
}
