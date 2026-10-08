//! The remote runtime's exec channel: stdout frames, the PID on stderr, heartbeats, and the
//! loopback ports for task services the runtime asks to forward.
use super::{
    runtime_frames::{self as frames, Frame, FrameReader},
    runtime_protocol::Install,
    runtime_tunnel::Tunnel,
    session::Pool,
};
use crate::fs_core::{Error, Result};
use russh::{client::Msg, ChannelMsg, ChannelReadHalf, ChannelWriteHalf};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{sync::watch, task::JoinHandle};

const HEARTBEAT: Duration = Duration::from_secs(10);
const MAX_TASK_FORWARDS: usize = 256;
const MAX_STDERR_BYTES: usize = 4096;
pub const STOPPED: &str =
    "Remote runtime stopped. Check the folder path, available disk space, and platform compatibility.";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Event {
    Progress { message: String },
    Running,
    Reconnecting { message: String },
    Failed { message: String },
}

pub type Events = Arc<dyn Fn(Event) + Send + Sync>;

pub struct Options {
    pub host_id: String,
    pub root: String,
    pub workspace_key: String,
    pub token: String,
    pub ready_timeout: Duration,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ready {
    pub root: String,
    pub open_file: Option<String>,
    #[serde(skip)]
    pub installed: Option<Install>,
}

pub type Writer = Arc<ChannelWriteHalf<Msg>>;

pub struct Stdout {
    pub reader: ChannelReadHalf,
    pub frames: FrameReader,
    /// The first stderr line is the runtime's PID.
    pub stderr: Vec<u8>,
}

impl Stdout {
    pub async fn next(&mut self, workspace_key: &str) -> Result<Vec<Frame>> {
        loop {
            match self.reader.wait().await {
                Some(ChannelMsg::Data { data }) => {
                    return self
                        .frames
                        .push(&data)?
                        .iter()
                        .map(|line| frames::parse_frame(line, workspace_key))
                        .collect();
                }
                Some(ChannelMsg::ExtendedData { data, ext: 1 }) => {
                    let room = MAX_STDERR_BYTES.saturating_sub(self.stderr.len());
                    self.stderr.extend_from_slice(&data[..data.len().min(room)]);
                }
                Some(ChannelMsg::Eof | ChannelMsg::Close) | None => {
                    return Err(Error::new("REMOTE_RUNTIME", STOPPED))
                }
                Some(_) => {}
            }
        }
    }

    pub fn pid(&self) -> Option<u32> {
        let stderr = String::from_utf8_lossy(&self.stderr);
        stderr
            .lines()
            .next()
            .and_then(|line| line.trim().parse().ok())
    }
}

pub struct Process {
    pub writer: Writer,
    pub alive: Arc<AtomicBool>,
    pub tasks: Vec<JoinHandle<()>>,
}

impl Process {
    pub fn close(self) {
        self.alive.store(false, Ordering::SeqCst);
        for task in self.tasks {
            task.abort();
        }
        tokio::spawn(async move {
            let _ = self.writer.close().await;
        });
    }
}

pub async fn heartbeat(writer: Writer, alive: Arc<AtomicBool>) {
    while alive.load(Ordering::SeqCst) {
        tokio::time::sleep(HEARTBEAT).await;
        if writer
            .data(frames::HEARTBEAT_FRAME.as_bytes())
            .await
            .is_err()
        {
            return;
        }
    }
}

/// One loopback port per `host:port` the runtime asks for, kept across relaunches.
#[derive(Default)]
pub struct TaskForwards(tokio::sync::Mutex<HashMap<String, Tunnel>>);

impl TaskForwards {
    pub async fn port(
        &self,
        pool: &Arc<Pool>,
        host_id: &str,
        host: &str,
        port: u16,
    ) -> Result<u16> {
        let mut forwards = self.0.lock().await;
        let key = format!("{host}:{port}");
        if let Some(tunnel) = forwards.get(&key) {
            return Ok(tunnel.port);
        }
        if forwards.len() >= MAX_TASK_FORWARDS {
            return Err(Error::new(
                "REMOTE_RUNTIME",
                "Too many task port forwards; reconnect the workspace",
            ));
        }
        let (_sender, target) = watch::channel(Some((host.to_string(), port)));
        let tunnel = Tunnel::open(pool.clone(), host_id.to_string(), target).await?;
        let local = tunnel.port;
        forwards.insert(key, tunnel);
        Ok(local)
    }

    pub async fn clear(&self) {
        self.0.lock().await.clear();
    }
}
