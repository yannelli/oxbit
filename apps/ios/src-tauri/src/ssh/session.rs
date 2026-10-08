//! One pooled connection per saved host, shared by every SFTP root on that host. A dropped
//! connection reconnects with the credential from the last successful connect.
use super::{
    connect::{establish, Connection, Credential, Outcome, Target},
    known_hosts::KnownHosts,
};
use crate::fs_core::{Error, Result};
use russh::Disconnect;
use std::{
    collections::HashMap,
    future::Future,
    sync::{Arc, Mutex as StdMutex},
};
use tokio::sync::Mutex;

pub const CONNECTION_LOST: &str = "CONNECTION_LOST";

struct Slot {
    target: Target,
    credential: Credential,
    connection: Option<Arc<Connection>>,
}

pub struct Pool {
    known: Arc<KnownHosts>,
    slots: StdMutex<HashMap<String, Arc<Mutex<Slot>>>>,
}

impl Pool {
    pub fn new(known: Arc<KnownHosts>) -> Self {
        Self {
            known,
            slots: StdMutex::new(HashMap::new()),
        }
    }

    fn slot(&self, host_id: &str) -> Option<Arc<Mutex<Slot>>> {
        self.slots.lock().unwrap().get(host_id).cloned()
    }

    /// The home directory of a live connection to this exact target, if one is pooled.
    pub async fn connected(&self, target: &Target) -> Option<String> {
        let slot = self.slot(&target.host_id)?;
        let slot = slot.lock().await;
        let connection = slot.connection.as_ref()?;
        (slot.target == *target && !connection.is_closed()).then(|| connection.home.clone())
    }

    pub async fn connect(&self, target: Target, credential: Credential) -> Result<Outcome> {
        if let Some(home) = self.connected(&target).await {
            return Ok(Outcome::Connected { home });
        }
        let connection = match establish(self.known.clone(), &target, &credential).await? {
            Ok(connection) => connection,
            Err(outcome) => return Ok(outcome),
        };
        let home = connection.home.clone();
        let slot = Slot {
            target: target.clone(),
            credential,
            connection: Some(Arc::new(connection)),
        };
        let previous = self
            .slots
            .lock()
            .unwrap()
            .insert(target.host_id, Arc::new(Mutex::new(slot)));
        if let Some(previous) = previous {
            close(previous).await;
        }
        Ok(Outcome::Connected { home })
    }

    /// A changed or forgotten host key refuses the reconnect.
    pub async fn connection(&self, host_id: &str) -> Result<Arc<Connection>> {
        let slot = self.slot(host_id).ok_or_else(|| {
            Error::new(
                "NOT_CONNECTED",
                "Connect to this SSH host before opening its files.",
            )
        })?;
        let mut slot = slot.lock().await;
        if let Some(connection) = slot.connection.as_ref().filter(|c| !c.is_closed()) {
            return Ok(connection.clone());
        }
        slot.connection = None;
        match establish(self.known.clone(), &slot.target, &slot.credential).await? {
            Ok(connection) => {
                let connection = Arc::new(connection);
                slot.connection = Some(connection.clone());
                Ok(connection)
            }
            Err(Outcome::HostChanged { .. }) => Err(Error::new(
                "HOST_KEY_CHANGED",
                "The server's host key changed, so Oxbit refused to reconnect. Connect again to review it.",
            )),
            Err(_) => Err(Error::new(
                "HOST_UNKNOWN",
                "The server's host key is no longer trusted. Connect again to review it.",
            )),
        }
    }

    async fn invalidate(&self, host_id: &str, stale: &Arc<Connection>) {
        let Some(slot) = self.slot(host_id) else {
            return;
        };
        let mut slot = slot.lock().await;
        if slot
            .connection
            .as_ref()
            .is_some_and(|c| Arc::ptr_eq(c, stale))
        {
            slot.connection = None;
        }
    }

    /// Repeats the whole operation once on a fresh connection when the first attempt lost it.
    pub async fn run<T, F, Fut>(&self, host_id: &str, operation: F) -> Result<T>
    where
        F: Fn(Arc<Connection>) -> Fut,
        Fut: Future<Output = Result<T>>,
    {
        let connection = self.connection(host_id).await?;
        match operation(connection.clone()).await {
            Err(error) if error.code == CONNECTION_LOST || connection.is_closed() => {
                self.invalidate(host_id, &connection).await;
                operation(self.connection(host_id).await?).await
            }
            result => result,
        }
    }

    pub async fn disconnect(&self, host_id: &str) {
        let removed = self.slots.lock().unwrap().remove(host_id);
        if let Some(slot) = removed {
            close(slot).await;
        }
    }
}

async fn close(slot: Arc<Mutex<Slot>>) {
    let connection = slot.lock().await.connection.take();
    if let Some(connection) = connection {
        let _ = connection.sftp.close().await;
        let _ = connection
            .handle
            .disconnect(Disconnect::ByApplication, "", "en")
            .await;
    }
}
