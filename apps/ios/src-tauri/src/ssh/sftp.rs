//! Workspace filesystem operations on an SFTP root. Codes and messages match `fs_core`, which
//! `packages/documents` classifies; saves check the SHA-256 revision before replacing a file.
use super::session::CONNECTION_LOST;
use crate::fs_core::{revision, Entry, Error, Result, WriteResult, MAX_READ_BYTES};
use russh_sftp::{
    client::{error::Error as SftpError, SftpSession},
    protocol::{FileAttributes, StatusCode},
};
use tokio::io::AsyncWriteExt;

pub const TEMP_PREFIX: &str = ".oxbit-tmp-";

pub fn sftp_error(error: SftpError, path: &str) -> Error {
    match error {
        SftpError::Status(status) => match status.status_code {
            StatusCode::NoSuchFile => Error::new(
                "NOT_FOUND",
                format!("ENOENT: no such file or directory: {path}"),
            ),
            StatusCode::PermissionDenied => Error::new(
                "PERMISSION_DENIED",
                format!("EACCES: permission denied: {path}"),
            ),
            _ => Error::new("IO", format!("{}: {path}", status.error_message)),
        },
        SftpError::IO(_) | SftpError::Timeout | SftpError::UnexpectedBehavior(_) => Error::new(
            CONNECTION_LOST,
            format!("The SSH connection was lost: {path}"),
        ),
        other => Error::new("IO", format!("{other}: {path}")),
    }
}

/// Joins a normalized workspace path to the absolute remote root.
pub fn join(root: &str, relative: &str) -> String {
    match (root.trim_end_matches('/'), relative) {
        ("", "") => "/".into(),
        (base, "") => base.into(),
        (base, relative) => format!("{base}/{relative}"),
    }
}

pub(super) fn parent(path: &str) -> &str {
    match path.rfind('/') {
        Some(0) => "/",
        Some(index) => &path[..index],
        None => ".",
    }
}

fn temporary(path: &str) -> String {
    format!(
        "{}/{TEMP_PREFIX}{}",
        parent(path).trim_end_matches('/'),
        uuid::Uuid::new_v4()
    )
}

async fn stat(sftp: &SftpSession, path: &str, relative: &str) -> Result<Option<FileAttributes>> {
    match sftp.metadata(path).await {
        Ok(metadata) => Ok(Some(metadata)),
        Err(SftpError::Status(status)) if status.status_code == StatusCode::NoSuchFile => Ok(None),
        Err(error) => Err(sftp_error(error, relative)),
    }
}

pub async fn list(sftp: &SftpSession, root: &str, relative: &str) -> Result<Vec<Entry>> {
    let directory = join(root, relative);
    let mut entries = Vec::new();
    for item in sftp
        .read_dir(directory.clone())
        .await
        .map_err(|error| sftp_error(error, relative))?
    {
        let name = item.file_name();
        if name == "." || name == ".." || name.starts_with(TEMP_PREFIX) {
            continue;
        }
        let mut metadata = item.metadata();
        if metadata.file_type().is_symlink() {
            match sftp.metadata(join(&directory, &name)).await {
                Ok(target) => metadata = target,
                Err(_) => continue,
            }
        }
        let path = if relative.is_empty() {
            name.clone()
        } else {
            format!("{relative}/{name}")
        };
        let kind = match metadata.file_type() {
            file_type if file_type.is_dir() => "directory",
            file_type if file_type.is_file() => "file",
            _ => continue,
        };
        entries.push(Entry {
            path,
            name,
            kind,
            size: (kind == "file").then(|| metadata.len()),
            readonly: None,
        });
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(entries)
}

pub async fn read(sftp: &SftpSession, root: &str, relative: &str) -> Result<Vec<u8>> {
    let path = join(root, relative);
    let metadata = stat(sftp, &path, relative).await?.ok_or_else(|| {
        Error::new(
            "NOT_FOUND",
            format!("ENOENT: no such file or directory: {relative}"),
        )
    })?;
    if metadata.file_type().is_dir() {
        return Err(Error::new("NOT_FILE", format!("Not a file: {relative}")));
    }
    if metadata.len() > MAX_READ_BYTES {
        return Err(Error::new(
            "TOO_LARGE",
            format!("File exceeds 20 MiB: {relative}"),
        ));
    }
    sftp.read(path)
        .await
        .map_err(|error| sftp_error(error, relative))
}

async fn put(
    sftp: &SftpSession,
    path: &str,
    bytes: &[u8],
    mode: Option<u32>,
    relative: &str,
) -> Result<()> {
    let mut file = sftp
        .create(path)
        .await
        .map_err(|error| sftp_error(error, relative))?;
    let written = async {
        file.write_all(bytes).await?;
        file.shutdown().await
    }
    .await;
    if let Err(error) = written {
        let _ = sftp.remove_file(path).await;
        return Err(sftp_error(error.into(), relative));
    }
    if let Some(mode) = mode {
        let attributes = FileAttributes {
            permissions: Some(mode & 0o7777),
            ..FileAttributes::empty()
        };
        let _ = sftp.set_metadata(path, attributes).await;
    }
    Ok(())
}

/// Writes through a temporary file. SFTP rename refuses an existing target, so the current
/// file moves aside first and returns if the final rename fails.
pub async fn write(
    sftp: &SftpSession,
    root: &str,
    relative: &str,
    bytes: &[u8],
    expected: Option<&str>,
) -> Result<WriteResult> {
    let path = join(root, relative);
    let current = match stat(sftp, &path, relative).await? {
        Some(metadata) if metadata.file_type().is_dir() => {
            return Err(Error::new("NOT_FILE", format!("Not a file: {relative}")))
        }
        Some(metadata) => Some((read(sftp, root, relative).await?, metadata.permissions)),
        None => None,
    };
    let actual = current.as_ref().map(|(existing, _)| revision(existing));
    let result = WriteResult {
        revision: revision(bytes),
        size: bytes.len() as u64,
    };
    if actual.as_deref() == Some(result.revision.as_str()) && actual.as_deref() != expected {
        return Ok(result);
    }
    if actual.as_deref() != expected {
        return Err(Error::new(
            "CONFLICT",
            format!("File revision conflict: {relative}"),
        ));
    }
    if stat(sftp, parent(&path), relative).await?.is_none() {
        return Err(Error::new(
            "NOT_FOUND",
            format!("ENOENT: no such file or directory: {relative}"),
        ));
    }
    let staged = temporary(&path);
    put(
        sftp,
        &staged,
        bytes,
        current.as_ref().and_then(|(_, mode)| *mode),
        relative,
    )
    .await?;
    let rename = |from: String, to: String| async move { sftp.rename(from, to).await };
    if current.is_none() {
        if let Err(error) = rename(staged.clone(), path.clone()).await {
            let _ = sftp.remove_file(staged).await;
            return Err(sftp_error(error, relative));
        }
        return Ok(result);
    }
    let backup = temporary(&path);
    if let Err(error) = rename(path.clone(), backup.clone()).await {
        let _ = sftp.remove_file(staged).await;
        return Err(sftp_error(error, relative));
    }
    if let Err(error) = rename(staged.clone(), path.clone()).await {
        let _ = rename(backup, path).await;
        let _ = sftp.remove_file(staged).await;
        return Err(sftp_error(error, relative));
    }
    let _ = sftp.remove_file(backup).await;
    Ok(result)
}

pub async fn mkdir(sftp: &SftpSession, root: &str, relative: &str) -> Result<()> {
    let mut current = String::new();
    for part in relative.split('/').filter(|part| !part.is_empty()) {
        current = if current.is_empty() {
            part.to_string()
        } else {
            format!("{current}/{part}")
        };
        let path = join(root, &current);
        match stat(sftp, &path, &current).await? {
            Some(metadata) if metadata.file_type().is_dir() => {}
            Some(_) => {
                return Err(Error::new(
                    "EXISTS",
                    format!("EEXIST: already exists: {current}"),
                ))
            }
            None => sftp
                .create_dir(path)
                .await
                .map_err(|error| sftp_error(error, &current))?,
        }
    }
    Ok(())
}

pub async fn rename(sftp: &SftpSession, root: &str, relative: &str, to: &str) -> Result<()> {
    let from = join(root, relative);
    let target = join(root, to);
    if stat(sftp, &from, relative).await?.is_none() {
        return Err(Error::new(
            "NOT_FOUND",
            format!("ENOENT: no such file or directory: {relative}"),
        ));
    }
    if stat(sftp, &target, to).await?.is_some() {
        return Err(Error::new(
            "EXISTS",
            format!("EEXIST: already exists: {to}"),
        ));
    }
    if let Some((directory, _)) = to.rsplit_once('/') {
        mkdir(sftp, root, directory).await?;
    }
    sftp.rename(from, target)
        .await
        .map_err(|error| sftp_error(error, relative))
}

pub async fn delete(sftp: &SftpSession, root: &str, relative: &str) -> Result<()> {
    let mut pending = vec![(join(root, relative), false)];
    while let Some((path, visited)) = pending.pop() {
        let metadata = sftp
            .symlink_metadata(path.clone())
            .await
            .map_err(|error| sftp_error(error, relative))?;
        if !metadata.file_type().is_dir() {
            sftp.remove_file(path)
                .await
                .map_err(|error| sftp_error(error, relative))?;
        } else if visited {
            sftp.remove_dir(path)
                .await
                .map_err(|error| sftp_error(error, relative))?;
        } else {
            pending.push((path.clone(), true));
            for item in sftp
                .read_dir(path.clone())
                .await
                .map_err(|error| sftp_error(error, relative))?
            {
                let name = item.file_name();
                if name != "." && name != ".." {
                    pending.push((join(&path, &name), false));
                }
            }
        }
    }
    Ok(())
}
