//! Puts the runtime payload on the host: reuse the cached install, let the host download the
//! pinned archive, or stream the archive from the device over an exec channel.
use super::{
    connect::Client,
    runtime_protocol::{self as protocol, Install},
    session::CONNECTION_LOST,
};
use crate::{
    fs_core::{Error, Result},
    remote_runtime::Download,
};
use russh::{client::Handle, ChannelMsg};
use sha2::{Digest, Sha256};
use std::{future::Future, path::PathBuf, pin::Pin, sync::Arc, time::Duration};
use tokio::io::AsyncReadExt;

pub const INSTALLING: &str = "Installing the remote runtime…";
pub const STARTING: &str = "Starting the remote workspace…";
const INSTALL_TIMEOUT: Duration = Duration::from_secs(180);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_OUTPUT_BYTES: usize = 8192;

/// The payload a platform gets: the manifest pinned into this build.
pub fn pinned(platform: &str) -> Result<Download> {
    crate::remote_runtime::pinned_download(platform)
        .map_err(|message| Error::new("REMOTE_RUNTIME", message))?
        .ok_or_else(|| {
            Error::new(
                "REMOTE_RUNTIME",
                "This build of Oxbit has no remote runtime. Use a TestFlight or App Store build.",
            )
        })
}

pub type Lookup = Arc<dyn Fn(&str) -> Result<Download> + Send + Sync>;
/// Downloads the archive to a file on the device.
pub type Fetch =
    Arc<dyn Fn(Download) -> Pin<Box<dyn Future<Output = Result<PathBuf>> + Send>> + Send + Sync>;

#[derive(Clone)]
pub struct Source {
    pub lookup: Lookup,
    pub fetch: Fetch,
}

pub struct Output {
    pub status: Option<u32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

pub(super) fn lost(error: impl std::fmt::Display) -> Error {
    Error::new(
        CONNECTION_LOST,
        format!("The SSH connection closed: {error}"),
    )
}

/// Runs one command, writing `input` to its stdin, and collects bounded output.
pub async fn exec(
    handle: &Handle<Client>,
    command: &str,
    input: Option<PathBuf>,
    timeout: Duration,
) -> Result<Output> {
    let run = async {
        let mut channel = handle.channel_open_session().await.map_err(lost)?;
        channel.exec(true, command).await.map_err(lost)?;
        if let Some(path) = input {
            let file = tokio::fs::File::open(&path)
                .await
                .map_err(|error| Error::new("REMOTE_RUNTIME", error.to_string()))?;
            channel.data(file).await.map_err(lost)?;
            channel.eof().await.map_err(lost)?;
        }
        let mut output = Output {
            status: None,
            stdout: Vec::new(),
            stderr: Vec::new(),
        };
        while let Some(message) = channel.wait().await {
            let (target, data) = match message {
                ChannelMsg::Data { data } => (&mut output.stdout, data),
                ChannelMsg::ExtendedData { data, ext: 1 } => (&mut output.stderr, data),
                ChannelMsg::ExitStatus { exit_status } => {
                    output.status = Some(exit_status);
                    continue;
                }
                ChannelMsg::Close => break,
                _ => continue,
            };
            let room = MAX_OUTPUT_BYTES.saturating_sub(target.len());
            target.extend_from_slice(&data[..data.len().min(room)]);
        }
        Ok(output)
    };
    tokio::time::timeout(timeout, run)
        .await
        .map_err(|_| Error::new("REMOTE_RUNTIME", "The server stopped responding."))?
}

fn failure(output: &Output, fallback: &str) -> Error {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Error::new(
        "REMOTE_RUNTIME",
        if stderr.is_empty() {
            fallback.to_string()
        } else {
            stderr
        },
    )
}

/// The device checks the pinned digest before any byte reaches the server.
pub async fn verify(path: &PathBuf, download: &Download) -> Result<()> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|error| Error::new("REMOTE_RUNTIME", error.to_string()))?;
    let (mut hasher, mut size, mut buffer) = (Sha256::new(), 0u64, vec![0u8; 64 * 1024]);
    loop {
        let count = file
            .read(&mut buffer)
            .await
            .map_err(|error| Error::new("REMOTE_RUNTIME", error.to_string()))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
        size += count as u64;
    }
    let actual: String = hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    if actual != download.sha256 || size != download.size {
        return Err(Error::new(
            "REMOTE_RUNTIME",
            "The downloaded remote runtime did not match this build's checksum.",
        ));
    }
    Ok(())
}

pub struct Installed {
    pub digest: String,
    pub method: Install,
}

pub async fn install(
    handle: &Handle<Client>,
    source: &Source,
    progress: &(dyn Fn(&str) + Send + Sync),
) -> Result<Installed> {
    let probe = exec(
        handle,
        &protocol::sh(protocol::PROBE),
        None,
        COMMAND_TIMEOUT,
    )
    .await?;
    let (platform, downloader) = protocol::parse_probe(&String::from_utf8_lossy(&probe.stdout))?;
    let download = (source.lookup)(platform)?;
    let digest = download.sha256.clone();
    let cached = exec(
        handle,
        &protocol::sh(&protocol::cached_command(&digest)),
        None,
        COMMAND_TIMEOUT,
    )
    .await?
    .stdout
        == b"yes";
    let method = protocol::choose(cached, downloader);
    if method == Install::Cached {
        return Ok(Installed { digest, method });
    }
    progress(INSTALLING);
    if let Install::HostDownload(downloader) = method {
        let command = protocol::host_install_command(&digest, &download.url, downloader)?;
        if exec(handle, &command, None, INSTALL_TIMEOUT).await?.status == Some(0) {
            return Ok(Installed { digest, method });
        }
    }
    let file = (source.fetch)(download.clone()).await?;
    if let Err(error) = verify(&file, &download).await {
        let _ = tokio::fs::remove_file(&file).await;
        return Err(error);
    }
    let command = protocol::stream_install_command(&digest)?;
    let output = exec(handle, &command, Some(file), INSTALL_TIMEOUT).await?;
    if output.status != Some(0) {
        return Err(failure(
            &output,
            "The remote runtime could not be installed.",
        ));
    }
    Ok(Installed {
        digest,
        method: Install::DeviceStream,
    })
}
