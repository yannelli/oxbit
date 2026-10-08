//! Opens one authenticated SSH connection: TCP, host key check against the known hosts,
//! public key or password authentication, then the SFTP subsystem.
use super::known_hosts::{authority, KnownHosts, KnownKey, Verdict};
use crate::fs_core::{Error, Result};
use russh::{
    client::{self, Handle},
    keys::{HashAlg, PrivateKey, PrivateKeyWithHashAlg, PublicKeyOrCertificate},
    Preferred,
};
use russh_sftp::client::SftpSession;
use serde::Serialize;
use std::{
    borrow::Cow,
    sync::{Arc, Mutex},
    time::Duration,
};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub host_id: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
}

#[derive(Clone)]
pub enum Credential {
    Key(Arc<PrivateKey>),
    Password(String),
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostKey {
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Outcome {
    Connected {
        home: String,
    },
    HostUnknown {
        host_key: HostKey,
    },
    HostChanged {
        host_key: HostKey,
        known: Vec<KnownKey>,
    },
    PasswordRequired,
}

type Seen = Arc<Mutex<Option<(HostKey, Result<Verdict>)>>>;

pub struct Client {
    known: Arc<KnownHosts>,
    hostname: String,
    port: u16,
    seen: Seen,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> std::result::Result<bool, Self::Error> {
        let PublicKeyOrCertificate::PublicKey { key, .. } = key else {
            return Ok(false);
        };
        let host_key = HostKey {
            host: self.hostname.clone(),
            port: self.port,
            algorithm: key.algorithm().as_str().to_string(),
            fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
        };
        let verdict = self.known.check(
            &self.hostname,
            self.port,
            &host_key.algorithm,
            &host_key.fingerprint,
        );
        let trusted = matches!(verdict, Ok(Verdict::Trusted));
        *self.seen.lock().unwrap() = Some((host_key, verdict));
        Ok(trusted)
    }
}

pub struct Connection {
    pub handle: Handle<Client>,
    pub sftp: SftpSession,
    pub home: String,
}

impl Connection {
    pub fn is_closed(&self) -> bool {
        self.handle.is_closed()
    }
}

/// Offers the algorithms of saved host keys first, as OpenSSH does, so a server with several
/// host keys presents the one already trusted.
fn config(known: &[KnownKey]) -> Arc<client::Config> {
    let family = |algorithm: &russh::keys::Algorithm| match algorithm {
        russh::keys::Algorithm::Rsa { .. } => "ssh-rsa".to_string(),
        other => other.as_str().to_string(),
    };
    let mut keys = Preferred::default().key.into_owned();
    keys.sort_by_key(|algorithm| !known.iter().any(|key| key.algorithm == family(algorithm)));
    Arc::new(client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(15)),
        keepalive_max: 3,
        preferred: Preferred {
            key: Cow::Owned(keys),
            ..Preferred::default()
        },
        ..Default::default()
    })
}

fn failed(target: &Target, error: impl std::fmt::Display) -> Error {
    Error::new(
        "CONNECT_FAILED",
        format!(
            "Could not connect to {}: {error}",
            authority(&target.hostname, target.port)
        ),
    )
}

/// An untrusted host key returns the `Outcome` to show instead of a connection.
pub async fn establish(
    known: Arc<KnownHosts>,
    target: &Target,
    credential: &Credential,
) -> Result<std::result::Result<Connection, Outcome>> {
    let seen: Seen = Arc::new(Mutex::new(None));
    let client = Client {
        known: known.clone(),
        hostname: target.hostname.clone(),
        port: target.port,
        seen: seen.clone(),
    };
    let preferred = config(&known.keys(&target.hostname, target.port)?);
    let connecting = client::connect(preferred, (target.hostname.as_str(), target.port), client);
    let mut handle = match tokio::time::timeout(CONNECT_TIMEOUT, connecting).await {
        Err(_) => return Err(failed(target, "the connection timed out")),
        Ok(Ok(handle)) => handle,
        Ok(Err(error)) => {
            let presented = seen.lock().unwrap().take();
            if let Some((host_key, verdict)) = presented {
                match verdict? {
                    Verdict::Unknown => return Ok(Err(Outcome::HostUnknown { host_key })),
                    Verdict::Changed(known) => {
                        return Ok(Err(Outcome::HostChanged { host_key, known }))
                    }
                    Verdict::Trusted => {}
                }
            }
            return Err(failed(target, error));
        }
    };
    let authenticated = match credential {
        Credential::Key(key) => {
            let hash = handle
                .best_supported_rsa_hash()
                .await
                .map_err(|error| failed(target, error))?
                .flatten();
            let key = PrivateKeyWithHashAlg::new(key.clone(), hash);
            handle.authenticate_publickey(&target.username, key).await
        }
        Credential::Password(password) => {
            handle
                .authenticate_password(&target.username, password)
                .await
        }
    }
    .map_err(|error| failed(target, error))?;
    if !authenticated.success() {
        return Err(Error::new(
            "AUTH_FAILED",
            format!(
                "{} did not accept the credentials for {}.",
                authority(&target.hostname, target.port),
                target.username
            ),
        ));
    }
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|error| failed(target, error))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|error| failed(target, error))?;
    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|error| failed(target, format!("SFTP is unavailable ({error})")))?;
    sftp.set_timeout(30);
    let home = sftp
        .canonicalize(".")
        .await
        .map_err(|error| failed(target, error))?;
    Ok(Ok(Connection { handle, sftp, home }))
}
