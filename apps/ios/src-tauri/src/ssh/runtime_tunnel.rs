//! Loopback listeners for the WebView. Each accepted connection becomes a `direct-tcpip` channel
//! to a port on the server, over the host's pooled SSH connection.
use super::{runtime_install::lost, session::Pool};
use crate::fs_core::{Error, Result};
use std::{sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::watch,
    task::JoinHandle,
};

const HEALTH_TIMEOUT: Duration = Duration::from_secs(10);

/// Where accepted connections go on the server; `None` refuses them while the runtime restarts.
pub type Target = watch::Receiver<Option<(String, u16)>>;

pub struct Tunnel {
    pub port: u16,
    task: JoinHandle<()>,
}

impl Tunnel {
    pub async fn open(pool: Arc<Pool>, host_id: String, target: Target) -> Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|error| {
            Error::new("TUNNEL", format!("Could not open a local port: {error}"))
        })?;
        let port = listener
            .local_addr()
            .map_err(|error| Error::new("TUNNEL", error.to_string()))?
            .port();
        let task = tokio::spawn(async move {
            while let Ok((socket, peer)) = listener.accept().await {
                let Some((host, remote)) = target.borrow().clone() else {
                    continue;
                };
                let (pool, host_id) = (pool.clone(), host_id.clone());
                tokio::spawn(async move {
                    let _ = forward(&pool, &host_id, socket, &host, remote, peer.port()).await;
                });
            }
        });
        Ok(Self { port, task })
    }
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn forward(
    pool: &Pool,
    host_id: &str,
    mut socket: TcpStream,
    host: &str,
    port: u16,
    origin: u16,
) -> Result<()> {
    let connection = pool.connection(host_id).await?;
    let channel = connection
        .handle
        .channel_open_direct_tcpip(host, port.into(), "127.0.0.1", origin.into())
        .await
        .map_err(lost)?;
    let mut stream = channel.into_stream();
    let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
    Ok(())
}

/// The desktop's readiness check: `/api/health` answers protocol 1 through the server's loopback.
/// Returns the runtime's `id` when it reports one.
pub async fn health(pool: &Pool, host_id: &str, port: u16) -> Result<Option<String>> {
    let check = async {
        let connection = pool.connection(host_id).await?;
        let channel = connection
            .handle
            .channel_open_direct_tcpip("127.0.0.1", port.into(), "127.0.0.1", 0)
            .await
            .map_err(lost)?;
        let mut stream = channel.into_stream();
        stream
            .write_all(b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
            .await
            .map_err(lost)?;
        let mut response = Vec::new();
        let _ = (&mut stream).take(4096).read_to_end(&mut response).await;
        Ok::<_, Error>(String::from_utf8_lossy(&response).into_owned())
    };
    let response = tokio::time::timeout(HEALTH_TIMEOUT, check)
        .await
        .map_err(|_| Error::new("REMOTE_RUNTIME", "The remote runtime did not answer."))??;
    let body = health_body(&response)
        .ok_or_else(|| Error::new("REMOTE_RUNTIME", "Remote runtime health check failed"))?;
    Ok(body["id"].as_str().map(str::to_string))
}

/// The JSON body of a protocol 1 health response.
pub fn health_body(response: &str) -> Option<serde_json::Value> {
    let (head, body) = response.split_once("\r\n\r\n")?;
    let ok = head
        .lines()
        .next()
        .is_some_and(|status| status.split(' ').nth(1) == Some("200"));
    let body = body.trim();
    let body = body.find('{').map_or(body, |start| &body[start..]);
    let body = body.rfind('}').map_or(body, |end| &body[..=end]);
    let value = serde_json::from_str::<serde_json::Value>(body).ok()?;
    (ok && value["ok"] == serde_json::json!(true) && value["protocol"] == serde_json::json!(1))
        .then_some(value)
}
