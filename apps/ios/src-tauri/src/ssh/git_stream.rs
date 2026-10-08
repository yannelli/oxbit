//! Blocking reads and writes over one SSH exec channel for libgit2, which calls the transport
//! from the Git operation's thread.
use super::connect::Client;
use crate::{fs_core::Error, git_core::ssh_transport::record_failure};
use russh::{client::Handle, ChannelMsg, Disconnect};
use std::{
    io::{self, Read, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

const POLL: Duration = Duration::from_millis(250);
const IDLE_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_STDERR_BYTES: usize = 4096;

pub(super) struct ExecStream {
    runtime: tokio::runtime::Handle,
    handle: Option<Handle<Client>>,
    channel: russh::Channel<russh::client::Msg>,
    pending: Vec<u8>,
    offset: usize,
    stderr: Vec<u8>,
    exit: Option<u32>,
    closed: bool,
    cancel: Arc<AtomicBool>,
}

fn cancelled() -> io::Error {
    io::Error::other("Operation was cancelled")
}

impl ExecStream {
    pub(super) fn new(
        runtime: tokio::runtime::Handle,
        handle: Handle<Client>,
        channel: russh::Channel<russh::client::Msg>,
        cancel: Arc<AtomicBool>,
    ) -> Self {
        Self {
            runtime,
            handle: Some(handle),
            channel,
            pending: Vec::new(),
            offset: 0,
            stderr: Vec::new(),
            exit: None,
            closed: false,
            cancel,
        }
    }

    /// A failed server command leaves its stderr as the operation's error message.
    fn finish(&mut self) {
        self.closed = true;
        if let Some(status) = self.exit.filter(|status| *status != 0) {
            let stderr = String::from_utf8_lossy(&self.stderr).trim().to_string();
            record_failure(Error::new(
                "GIT_FAILED",
                if stderr.is_empty() {
                    format!("The server's Git command exited with status {status}.")
                } else {
                    stderr
                },
            ));
        }
    }
}

impl Read for ExecStream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let mut idle = Duration::ZERO;
        while self.offset == self.pending.len() {
            if self.closed {
                return Ok(0);
            }
            if self.cancel.load(Ordering::Relaxed) {
                return Err(cancelled());
            }
            let channel = &mut self.channel;
            match self
                .runtime
                .block_on(async { tokio::time::timeout(POLL, channel.wait()).await })
            {
                Err(_) => {
                    idle += POLL;
                    if idle >= IDLE_TIMEOUT {
                        return Err(io::Error::new(
                            io::ErrorKind::TimedOut,
                            "The server stopped responding.",
                        ));
                    }
                }
                Ok(Some(ChannelMsg::Data { data })) => {
                    self.pending = data.to_vec();
                    self.offset = 0;
                }
                Ok(Some(ChannelMsg::ExtendedData { data, ext: 1 })) => {
                    let room = MAX_STDERR_BYTES.saturating_sub(self.stderr.len());
                    self.stderr.extend_from_slice(&data[..data.len().min(room)]);
                }
                Ok(Some(ChannelMsg::ExitStatus { exit_status })) => self.exit = Some(exit_status),
                Ok(Some(ChannelMsg::Close) | None) => self.finish(),
                Ok(Some(_)) => {}
            }
        }
        let count = buffer.len().min(self.pending.len() - self.offset);
        buffer[..count].copy_from_slice(&self.pending[self.offset..self.offset + count]);
        self.offset += count;
        Ok(count)
    }
}

impl Write for ExecStream {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err(cancelled());
        }
        let channel = &self.channel;
        self.runtime
            .block_on(async { tokio::time::timeout(IDLE_TIMEOUT, channel.data(buffer)).await })
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "The server stopped reading."))?
            .map_err(io::Error::other)?;
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Drop for ExecStream {
    fn drop(&mut self) {
        if let Some(handle) = self.handle.take() {
            self.runtime.spawn(async move {
                let _ = handle.disconnect(Disconnect::ByApplication, "", "en").await;
            });
        }
    }
}
