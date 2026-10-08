//! Trust-on-first-use host keys in `ssh/known_hosts.json`, keyed by `host:port` with one
//! SHA256 fingerprint per key algorithm.
use crate::{
    fs_core::{Error, Result},
    storage::atomic_json,
};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, path::PathBuf, sync::Mutex};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KnownKey {
    pub algorithm: String,
    pub fingerprint: String,
    pub added: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Trusted,
    Unknown,
    Changed(Vec<KnownKey>),
}

type Entries = BTreeMap<String, Vec<KnownKey>>;

pub struct KnownHosts {
    path: PathBuf,
    cache: Mutex<Option<Entries>>,
}

pub fn authority(hostname: &str, port: u16) -> String {
    let host = hostname.to_ascii_lowercase();
    if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

impl KnownHosts {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            cache: Mutex::new(None),
        }
    }

    fn with<T>(&self, operation: impl FnOnce(&mut Entries) -> Result<T>) -> Result<T> {
        let mut cache = self.cache.lock().unwrap();
        if cache.is_none() {
            *cache = Some(match fs::read(&self.path) {
                Ok(bytes) => serde_json::from_slice(&bytes)
                    .map_err(|_| Error::new("IO", "Saved SSH host keys are unreadable"))?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Entries::new(),
                Err(_) => return Err(Error::new("IO", "Saved SSH host keys could not be read")),
            });
        }
        operation(cache.as_mut().unwrap())
    }

    pub fn keys(&self, hostname: &str, port: u16) -> Result<Vec<KnownKey>> {
        self.with(|entries| {
            Ok(entries
                .get(&authority(hostname, port))
                .cloned()
                .unwrap_or_default())
        })
    }

    /// A host with any saved key is `Changed` when the presented algorithm has no saved key,
    /// so swapping key types cannot trigger a new first-use prompt.
    pub fn check(
        &self,
        hostname: &str,
        port: u16,
        algorithm: &str,
        fingerprint: &str,
    ) -> Result<Verdict> {
        let known = self.keys(hostname, port)?;
        if known.is_empty() {
            return Ok(Verdict::Unknown);
        }
        let trusted = known
            .iter()
            .any(|key| key.algorithm == algorithm && key.fingerprint == fingerprint);
        Ok(if trusted {
            Verdict::Trusted
        } else {
            Verdict::Changed(known)
        })
    }

    pub fn trust(
        &self,
        hostname: &str,
        port: u16,
        algorithm: &str,
        fingerprint: &str,
    ) -> Result<()> {
        if !fingerprint.starts_with("SHA256:") || algorithm.is_empty() || algorithm.len() > 64 {
            return Err(Error::invalid("Invalid host key"));
        }
        let path = self.path.clone();
        self.with(|entries| {
            let key = authority(hostname, port);
            if entries.get(&key).is_some_and(|keys| !keys.is_empty()) {
                return Err(Error::new(
                    "HOST_KEY_CHANGED",
                    "This server already has a saved host key. Forget it before trusting a new one.",
                ));
            }
            let mut next = entries.clone();
            next.insert(
                key,
                vec![KnownKey {
                    algorithm: algorithm.to_string(),
                    fingerprint: fingerprint.to_string(),
                    added: now(),
                }],
            );
            atomic_json(&path, &next)?;
            *entries = next;
            Ok(())
        })
    }

    pub fn forget(&self, hostname: &str, port: u16) -> Result<()> {
        let path = self.path.clone();
        self.with(|entries| {
            let mut next = entries.clone();
            if next.remove(&authority(hostname, port)).is_some() {
                atomic_json(&path, &next)?;
                *entries = next;
            }
            Ok(())
        })
    }
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trusts_on_first_use_and_refuses_changed_keys() {
        let directory =
            std::env::temp_dir().join(format!("oxbit-ios-known-{}", uuid::Uuid::new_v4()));
        let known = KnownHosts::new(directory.join("known_hosts.json"));
        let fingerprint = "SHA256:abc";
        assert_eq!(
            known
                .check("Example.test", 22, "ssh-ed25519", fingerprint)
                .unwrap(),
            Verdict::Unknown
        );
        known
            .trust("Example.test", 22, "ssh-ed25519", fingerprint)
            .unwrap();
        assert_eq!(
            known
                .check("example.test", 22, "ssh-ed25519", fingerprint)
                .unwrap(),
            Verdict::Trusted
        );
        assert_eq!(
            known
                .check("example.test", 2222, "ssh-ed25519", fingerprint)
                .unwrap(),
            Verdict::Unknown
        );
        let Verdict::Changed(saved) = known
            .check("example.test", 22, "ssh-ed25519", "SHA256:other")
            .unwrap()
        else {
            panic!("a different fingerprint must be refused");
        };
        assert_eq!(saved[0].fingerprint, fingerprint);
        assert!(matches!(
            known
                .check("example.test", 22, "ecdsa-sha2-nistp256", fingerprint)
                .unwrap(),
            Verdict::Changed(_)
        ));
        assert_eq!(
            known
                .trust("example.test", 22, "ecdsa-sha2-nistp256", "SHA256:new")
                .unwrap_err()
                .code,
            "HOST_KEY_CHANGED"
        );
        let reopened = KnownHosts::new(directory.join("known_hosts.json"));
        assert_eq!(
            reopened
                .check("example.test", 22, "ssh-ed25519", fingerprint)
                .unwrap(),
            Verdict::Trusted
        );
        reopened.forget("example.test", 22).unwrap();
        assert_eq!(
            reopened
                .check("example.test", 22, "ssh-ed25519", "SHA256:other")
                .unwrap(),
            Verdict::Unknown
        );
        assert_eq!(authority("::1", 22), "[::1]:22");
        assert!(known.trust("h", 22, "ssh-ed25519", "MD5:x").is_err());
        fs::remove_dir_all(directory).unwrap();
    }
}
