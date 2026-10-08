//! Uploads from device files into an SFTP root and downloads from it into a device folder.
//! Both stage under a temporary name, so a cancelled or failed transfer leaves no partial file.
use super::sftp::{join, sftp_error, TEMP_PREFIX};
use crate::fs_core::{Error, Result};
use russh_sftp::client::SftpSession;
use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const CHUNK: usize = 256 * 1024;
const MAX_ENTRIES: usize = 10_000;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub transferred: u64,
    pub total: u64,
    pub file: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub files: usize,
    pub bytes: u64,
}

#[derive(Default)]
pub struct Transfers {
    active: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

pub struct Active<'a> {
    transfers: &'a Transfers,
    id: String,
    pub cancelled: Arc<AtomicBool>,
}

impl Drop for Active<'_> {
    fn drop(&mut self) {
        self.transfers.active.lock().unwrap().remove(&self.id);
    }
}

impl Transfers {
    pub fn begin(&self, id: &str) -> Result<Active<'_>> {
        if id.is_empty() || id.len() > 64 {
            return Err(Error::invalid("Invalid transfer"));
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        let mut active = self.active.lock().unwrap();
        if active.contains_key(id) {
            return Err(Error::invalid("This transfer is already running"));
        }
        active.insert(id.to_string(), cancelled.clone());
        Ok(Active {
            transfers: self,
            id: id.to_string(),
            cancelled,
        })
    }

    pub fn cancel(&self, id: &str) {
        if let Some(flag) = self.active.lock().unwrap().get(id) {
            flag.store(true, Ordering::SeqCst);
        }
    }
}

fn cancelled_error() -> Error {
    Error::new("CANCELLED", "The transfer was cancelled.")
}

fn local_error(error: std::io::Error, path: &str) -> Error {
    match error.kind() {
        std::io::ErrorKind::AlreadyExists => {
            Error::new("EXISTS", format!("EEXIST: already exists: {path}"))
        }
        std::io::ErrorKind::NotFound => Error::new(
            "NOT_FOUND",
            format!("ENOENT: no such file or directory: {path}"),
        ),
        _ => Error::new("IO", format!("{error}: {path}")),
    }
}

fn file_name(path: &Path) -> Result<String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.starts_with(TEMP_PREFIX) && *name != "." && *name != "..")
        .map(str::to_string)
        .ok_or_else(|| Error::invalid("Invalid file name"))
}

async fn copy<R, W>(
    mut reader: R,
    mut writer: W,
    name: &str,
    done: &mut u64,
    total: u64,
    cancelled: &AtomicBool,
    progress: &impl Fn(Progress),
) -> std::io::Result<bool>
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    let mut buffer = vec![0u8; CHUNK];
    loop {
        if cancelled.load(Ordering::SeqCst) {
            return Ok(false);
        }
        let read = reader.read(&mut buffer).await?;
        if read == 0 {
            writer.shutdown().await?;
            return Ok(true);
        }
        writer.write_all(&buffer[..read]).await?;
        *done += read as u64;
        progress(Progress {
            transferred: *done,
            total,
            file: name.to_string(),
        });
    }
}

pub async fn upload(
    sftp: &SftpSession,
    root: &str,
    directory: &str,
    files: &[PathBuf],
    cancelled: &AtomicBool,
    progress: impl Fn(Progress),
) -> Result<Summary> {
    let mut planned = Vec::with_capacity(files.len());
    let mut total = 0;
    for file in files {
        let name = file_name(file)?;
        let relative = if directory.is_empty() {
            name.clone()
        } else {
            format!("{directory}/{name}")
        };
        let size = tokio::fs::metadata(file)
            .await
            .map_err(|error| local_error(error, &name))?
            .len();
        if sftp
            .try_exists(join(root, &relative))
            .await
            .unwrap_or(false)
        {
            return Err(Error::new(
                "EXISTS",
                format!("EEXIST: already exists: {relative}"),
            ));
        }
        total += size;
        planned.push((file, name, relative));
    }
    let mut done = 0;
    for (file, name, relative) in &planned {
        let target = join(root, relative);
        let staged = join(
            root,
            &format!("{}{TEMP_PREFIX}{}", prefix(relative), uuid::Uuid::new_v4()),
        );
        let local = tokio::fs::File::open(file)
            .await
            .map_err(|error| local_error(error, name))?;
        let remote = sftp
            .create(staged.clone())
            .await
            .map_err(|error| sftp_error(error, relative))?;
        let copied = copy(local, remote, name, &mut done, total, cancelled, &progress).await;
        let finished = match copied {
            Ok(true) => sftp
                .rename(staged.clone(), target)
                .await
                .map_err(|error| sftp_error(error, relative)),
            Ok(false) => Err(cancelled_error()),
            Err(error) => Err(sftp_error(error.into(), relative)),
        };
        if let Err(error) = finished {
            let _ = sftp.remove_file(staged).await;
            return Err(error);
        }
    }
    Ok(Summary {
        files: planned.len(),
        bytes: done,
    })
}

fn prefix(relative: &str) -> String {
    relative
        .rsplit_once('/')
        .map(|(directory, _)| format!("{directory}/"))
        .unwrap_or_default()
}

/// Remote files and directories under `relative`, as paths relative to it.
async fn plan(sftp: &SftpSession, root: &str, relative: &str) -> Result<Vec<(String, bool, u64)>> {
    let metadata = sftp
        .metadata(join(root, relative))
        .await
        .map_err(|error| sftp_error(error, relative))?;
    if !metadata.file_type().is_dir() {
        return Ok(vec![(String::new(), false, metadata.len())]);
    }
    let mut entries = vec![(String::new(), true, 0)];
    let mut pending = vec![String::new()];
    while let Some(inner) = pending.pop() {
        let path = join(&join(root, relative), &inner);
        for item in sftp
            .read_dir(path)
            .await
            .map_err(|error| sftp_error(error, relative))?
        {
            let name = item.file_name();
            if name == "." || name == ".." || name.starts_with(TEMP_PREFIX) {
                continue;
            }
            let child = if inner.is_empty() {
                name
            } else {
                format!("{inner}/{name}")
            };
            let file_type = item.metadata().file_type();
            if file_type.is_dir() {
                pending.push(child.clone());
                entries.push((child, true, 0));
            } else if file_type.is_file() {
                entries.push((child, false, item.metadata().len()));
            }
            if entries.len() > MAX_ENTRIES {
                return Err(Error::new(
                    "TOO_LARGE",
                    "The folder has too many entries to download.",
                ));
            }
        }
    }
    Ok(entries)
}

pub async fn download(
    sftp: &SftpSession,
    root: &str,
    relative: &str,
    destination: &Path,
    cancelled: &AtomicBool,
    progress: impl Fn(Progress),
) -> Result<Summary> {
    let name = file_name(Path::new(&join(root, relative)))?;
    let target = destination.join(&name);
    if tokio::fs::symlink_metadata(&target).await.is_ok() {
        return Err(Error::new(
            "EXISTS",
            format!("EEXIST: already exists: {name}"),
        ));
    }
    let entries = plan(sftp, root, relative).await?;
    let total = entries.iter().map(|(_, _, size)| size).sum();
    let staging = destination.join(format!("{TEMP_PREFIX}{}", uuid::Uuid::new_v4()));
    let mut done = 0;
    let result = async {
        for (inner, directory, _) in &entries {
            let local = if inner.is_empty() {
                staging.clone()
            } else {
                staging.join(inner)
            };
            if *directory {
                tokio::fs::create_dir_all(&local)
                    .await
                    .map_err(|error| local_error(error, &name))?;
                continue;
            }
            let remote_relative = join(relative, inner).trim_start_matches('/').to_string();
            let remote = sftp
                .open(join(root, &remote_relative))
                .await
                .map_err(|error| sftp_error(error, &remote_relative))?;
            let file = tokio::fs::File::create(&local)
                .await
                .map_err(|error| local_error(error, &name))?;
            let label = Path::new(inner)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(&name)
                .to_string();
            match copy(remote, file, &label, &mut done, total, cancelled, &progress).await {
                Ok(true) => {}
                Ok(false) => return Err(cancelled_error()),
                Err(error) => return Err(sftp_error(error.into(), &remote_relative)),
            }
        }
        tokio::fs::rename(&staging, &target)
            .await
            .map_err(|error| local_error(error, &name))
    }
    .await;
    if let Err(error) = result {
        let _ = tokio::fs::remove_dir_all(&staging).await;
        let _ = tokio::fs::remove_file(&staging).await;
        return Err(error);
    }
    Ok(Summary {
        files: entries
            .iter()
            .filter(|(_, directory, _)| !directory)
            .count(),
        bytes: done,
    })
}
