//! Built-in SSH: saved hosts, Keychain keys, trust-on-first-use host keys, pooled connections,
//! SFTP workspaces, and file transfers.
pub mod commands;
pub mod connect;
pub mod fs_commands;
pub mod hosts;
pub mod keys;
pub mod known_hosts;
#[cfg(test)]
mod live_tests;
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
    pub pool: session::Pool,
    pub transfers: transfer::Transfers,
    roots: Mutex<HashMap<String, RemoteRoot>>,
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
            pool: session::Pool::new(known.clone()),
            known,
            transfers: transfer::Transfers::default(),
            roots: Mutex::new(HashMap::new()),
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
