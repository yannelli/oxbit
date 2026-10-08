//! The newline-delimited JSON frames between the device and `desktop.js`, version 1, capped at
//! 64 KiB per line as on desktop.
use crate::fs_core::{Error, Result};
use serde::Deserialize;
use serde_json::json;
use std::net::IpAddr;

pub const MAX_FRAME_BYTES: usize = 65536;

fn invalid_response() -> Error {
    Error::new("REMOTE_RUNTIME", "Invalid remote runtime response")
}

pub fn launch_frame(root: &str, workspace_key: &str, token: &str) -> String {
    let frame = json!({
        "version": 1, "type": "launch", "remoteRuntime": true, "root": root,
        "workspaceKey": workspace_key, "token": token, "development": false,
    });
    frame.to_string() + "\n"
}

pub const HEARTBEAT_FRAME: &str = "{\"version\":1,\"type\":\"heartbeat\"}\n";
pub const SHUTDOWN_FRAME: &str = "{\"version\":1,\"type\":\"shutdown\"}\n";

pub fn task_forwarded_frame(request: &str, port: Option<u16>) -> String {
    let frame = match port {
        Some(port) => {
            json!({ "version": 1, "type": "taskForwarded", "request": request, "port": port })
        }
        None => json!({
            "version": 1, "type": "taskForwarded", "request": request,
            "error": "Could not forward the service port over SSH",
        }),
    };
    frame.to_string() + "\n"
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    Ready {
        port: u16,
        root: String,
        open_file: Option<String>,
    },
    Rotated {
        request: String,
    },
    TaskForward {
        request: String,
        host: String,
        port: u16,
    },
    Error {
        message: String,
    },
    Progress {
        message: String,
    },
    Other,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Raw {
    version: u8,
    r#type: String,
    port: Option<u64>,
    workspace_key: Option<String>,
    root: Option<String>,
    open_file: Option<String>,
    request: Option<String>,
    host: Option<String>,
    message: Option<String>,
}

fn port(value: Option<u64>) -> Option<u16> {
    value
        .and_then(|port| u16::try_from(port).ok())
        .filter(|port| *port > 0)
}

pub fn parse_frame(line: &[u8], workspace_key: &str) -> Result<Frame> {
    let raw: Raw = serde_json::from_slice(line).map_err(|_| invalid_response())?;
    if raw.version != 1 {
        return Err(invalid_response());
    }
    Ok(match raw.r#type.as_str() {
        "ready" => match (port(raw.port), raw.root) {
            (Some(port), Some(root))
                if raw.workspace_key.as_deref() == Some(workspace_key) && root.starts_with('/') =>
            {
                Frame::Ready {
                    port,
                    root,
                    open_file: raw.open_file,
                }
            }
            _ => {
                return Err(Error::new(
                    "REMOTE_RUNTIME",
                    "Remote workspace identity did not match the connection",
                ))
            }
        },
        "rotated" => Frame::Rotated {
            request: raw.request.unwrap_or_default(),
        },
        "taskForward" => match (raw.request, raw.host, port(raw.port)) {
            (Some(request), Some(host), Some(port))
                if request.len() <= 128
                    && (host == "localhost" || host.parse::<IpAddr>().is_ok()) =>
            {
                Frame::TaskForward {
                    request,
                    host,
                    port,
                }
            }
            _ => return Err(invalid_response()),
        },
        "error" => Frame::Error {
            message: raw
                .message
                .unwrap_or_else(|| "Remote startup failed".into()),
        },
        "progress" => Frame::Progress {
            message: raw.message.unwrap_or_default(),
        },
        _ => Frame::Other,
    })
}

/// Splits stdout into frames and refuses a line longer than the desktop's 64 KiB cap.
#[derive(Default)]
pub struct FrameReader {
    buffer: Vec<u8>,
}

impl FrameReader {
    pub fn push(&mut self, data: &[u8]) -> Result<Vec<Vec<u8>>> {
        self.buffer.extend_from_slice(data);
        let mut lines = Vec::new();
        while let Some(end) = self.buffer.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = self.buffer.drain(..=end).take(end).collect();
            if line.len() > MAX_FRAME_BYTES {
                return Err(invalid_response());
            }
            if !line.iter().all(u8::is_ascii_whitespace) {
                lines.push(line);
            }
        }
        if self.buffer.len() > MAX_FRAME_BYTES {
            return Err(invalid_response());
        }
        Ok(lines)
    }
}
