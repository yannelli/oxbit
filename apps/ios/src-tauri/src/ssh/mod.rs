//! Built-in SSH: saved hosts, Keychain keys, trust-on-first-use host keys, pooled connections,
//! SFTP workspaces, file transfers, Git over SSH, and remote runtimes.
pub mod commands;
pub mod connect;
pub mod fs_commands;
pub mod git;
pub mod git_commands;
mod git_stream;
pub mod hosts;
pub mod keys;
pub mod known_hosts;
#[cfg(test)]
mod live_git_tests;
#[cfg(test)]
mod live_lease_tests;
#[cfg(test)]
mod live_runtime_task_tests;
#[cfg(test)]
mod live_runtime_tests;
#[cfg(test)]
mod live_tests;
pub mod runtime_commands;
pub mod runtime_frames;
mod runtime_install;
mod runtime_process;
pub mod runtime_protocol;
#[cfg(test)]
mod runtime_protocol_tests;
mod runtime_reattach;
pub mod runtime_session;
mod runtime_tunnel;
pub mod session;
pub mod sftp;
pub mod transfer;

use crate::fs_core::{revision, Error, Result};
use std::{collections::HashMap, path::Path, sync::Arc, sync::Mutex};

#[derive(Debug, Clone)]
pub struct RemoteRoot {
    pub host_id: String,
    pub path: String,
}

pub struct Ssh {
    pub hosts: hosts::Hosts,
    pub known: Arc<known_hosts::KnownHosts>,
    pub pool: Arc<session::Pool>,
    pub runtimes: Mutex<HashMap<String, Arc<runtime_session::RemoteRuntime>>>,
    pub transfers: transfer::Transfers,
    roots: Mutex<HashMap<String, RemoteRoot>>,
    /// The last Git over SSH prompt per workspace root, read by the UI after a failed request.
    pub git_prompts: Mutex<HashMap<String, git::Prompt>>,
}

pub fn root_id(host_id: &str, path: &str) -> String {
    format!(
        "ios:{}",
        revision(format!("ssh\0{host_id}\0{path}").as_bytes())
    )
}

impl Ssh {
    pub fn new(directory: &Path) -> Self {
        let known = Arc::new(known_hosts::KnownHosts::new(
            directory.join("known_hosts.json"),
        ));
        Self {
            hosts: hosts::Hosts::new(directory.join("hosts.json")),
            pool: Arc::new(session::Pool::new(known.clone())),
            runtimes: Mutex::new(HashMap::new()),
            known,
            transfers: transfer::Transfers::default(),
            roots: Mutex::new(HashMap::new()),
            git_prompts: Mutex::new(HashMap::new()),
        }
    }

    pub fn open_root(&self, host_id: &str, path: &str) -> String {
        let id = root_id(host_id, path);
        self.roots.lock().unwrap().insert(
            id.clone(),
            RemoteRoot {
                host_id: host_id.to_string(),
                path: path.to_string(),
            },
        );
        id
    }

    pub fn close_root(&self, id: &str) {
        self.roots.lock().unwrap().remove(id);
    }

    pub fn root(&self, id: &str) -> Result<RemoteRoot> {
        self.roots
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| Error::new("ROOT_CLOSED", "Workspace root is not open"))
    }

    pub fn close_host_roots(&self, host_id: &str) {
        self.roots
            .lock()
            .unwrap()
            .retain(|_, root| root.host_id != host_id);
    }
}
