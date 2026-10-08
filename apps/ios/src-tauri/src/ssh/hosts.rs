//! Saved SSH hosts in `ssh/hosts.json`. Passwords live in the Keychain; this file records only
//! whether one is saved.
use crate::{
    fs_core::{Error, Result},
    storage::atomic_json,
};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, sync::Mutex};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AuthMethod {
    Key,
    Password,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    pub id: String,
    pub label: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_id: Option<String>,
    #[serde(default)]
    pub password_saved: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInput {
    pub id: Option<String>,
    pub label: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    pub key_id: Option<String>,
}

pub struct Hosts {
    path: PathBuf,
    cache: Mutex<Option<Vec<Host>>>,
}

fn valid_hostname(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 253
        && !value.starts_with(['-', '.'])
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_' | b':'))
}

fn valid_username(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && !value.starts_with('-')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_graphic() && !matches!(byte, b'@' | b':' | b'/'))
}

pub fn validate(input: HostInput) -> Result<Host> {
    let hostname = input.hostname.trim().to_string();
    if !valid_hostname(&hostname) {
        return Err(Error::invalid("Enter a host name or IP address."));
    }
    if input.port == 0 {
        return Err(Error::invalid("Enter a port from 1 to 65535."));
    }
    let username = input.username.trim().to_string();
    if !valid_username(&username) {
        return Err(Error::invalid("Enter the user name to sign in as."));
    }
    let label = match input.label.trim() {
        "" => hostname.clone(),
        label if label.chars().count() > 64 || label.chars().any(char::is_control) => {
            return Err(Error::invalid("Enter a name of up to 64 characters."))
        }
        label => label.to_string(),
    };
    let key_id = input.key_id.filter(|id| !id.is_empty());
    if input.auth == AuthMethod::Key
        && !key_id
            .as_deref()
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
    {
        return Err(Error::invalid("Choose an SSH key for this host."));
    }
    let id = match input.id {
        Some(id) if uuid::Uuid::parse_str(&id).is_ok() => id,
        Some(_) => return Err(Error::invalid("Invalid host")),
        None => uuid::Uuid::new_v4().to_string(),
    };
    Ok(Host {
        id,
        label,
        hostname,
        port: input.port,
        username,
        auth: input.auth,
        key_id: (input.auth == AuthMethod::Key).then_some(key_id).flatten(),
        password_saved: false,
    })
}

impl Hosts {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            cache: Mutex::new(None),
        }
    }

    fn with<T>(&self, operation: impl FnOnce(&mut Vec<Host>) -> Result<T>) -> Result<T> {
        let mut cache = self.cache.lock().unwrap();
        if cache.is_none() {
            *cache = Some(match fs::read(&self.path) {
                Ok(bytes) => serde_json::from_slice(&bytes)
                    .map_err(|_| Error::new("IO", "Saved SSH hosts are unreadable"))?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
                Err(_) => return Err(Error::new("IO", "Saved SSH hosts could not be read")),
            });
        }
        operation(cache.as_mut().unwrap())
    }

    fn update(&self, change: impl FnOnce(&mut Vec<Host>) -> Result<()>) -> Result<()> {
        let path = self.path.clone();
        self.with(|hosts| {
            let mut next = hosts.clone();
            change(&mut next)?;
            atomic_json(&path, &next)?;
            *hosts = next;
            Ok(())
        })
    }

    pub fn list(&self) -> Result<Vec<Host>> {
        self.with(|hosts| Ok(hosts.clone()))
    }

    pub fn get(&self, id: &str) -> Result<Host> {
        self.with(|hosts| {
            hosts
                .iter()
                .find(|host| host.id == id)
                .cloned()
                .ok_or_else(|| Error::new("NOT_FOUND", "This SSH host is no longer saved."))
        })
    }

    /// Saves a host; a changed address or user name keeps the saved password only when the
    /// method stays password.
    pub fn save(&self, input: HostInput) -> Result<Host> {
        let mut host = validate(input)?;
        self.update(|hosts| {
            let count = hosts.len();
            match hosts.iter_mut().find(|saved| saved.id == host.id) {
                Some(saved) => {
                    host.password_saved = saved.password_saved && host.auth == AuthMethod::Password;
                    *saved = host.clone();
                }
                None if count >= 100 => {
                    return Err(Error::invalid("Remove a saved host before adding another."))
                }
                None => hosts.push(host.clone()),
            }
            Ok(())
        })?;
        Ok(host)
    }

    pub fn remove(&self, id: &str) -> Result<()> {
        self.update(|hosts| {
            hosts.retain(|host| host.id != id);
            Ok(())
        })
    }

    pub fn set_password_saved(&self, id: &str, saved: bool) -> Result<()> {
        self.update(|hosts| {
            if let Some(host) = hosts.iter_mut().find(|host| host.id == id) {
                host.password_saved = saved;
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(auth: AuthMethod, key_id: Option<&str>) -> HostInput {
        HostInput {
            id: None,
            label: " ".into(),
            hostname: " build.example.test ".into(),
            port: 22,
            username: "deploy".into(),
            auth,
            key_id: key_id.map(Into::into),
        }
    }

    #[test]
    fn validates_and_persists_hosts() {
        let directory =
            std::env::temp_dir().join(format!("oxbit-ios-hosts-{}", uuid::Uuid::new_v4()));
        let hosts = Hosts::new(directory.join("hosts.json"));
        let key = uuid::Uuid::new_v4().to_string();
        let saved = hosts.save(input(AuthMethod::Key, Some(&key))).unwrap();
        assert_eq!(saved.label, "build.example.test");
        assert_eq!(saved.hostname, "build.example.test");
        assert!(hosts.save(input(AuthMethod::Key, None)).is_err());
        let mut password = input(AuthMethod::Password, Some(&key));
        password.id = Some(saved.id.clone());
        let updated = hosts.save(password).unwrap();
        assert_eq!(updated.key_id, None);
        hosts.set_password_saved(&saved.id, true).unwrap();
        let reopened = Hosts::new(directory.join("hosts.json"));
        assert!(reopened.get(&saved.id).unwrap().password_saved);
        reopened.remove(&saved.id).unwrap();
        assert_eq!(reopened.get(&saved.id).unwrap_err().code, "NOT_FOUND");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_unsafe_fields() {
        for hostname in ["", "-oProxyCommand=x", "a b", "host/path"] {
            let mut host = input(AuthMethod::Password, None);
            host.hostname = hostname.into();
            assert!(validate(host).is_err(), "{hostname}");
        }
        for username in ["", "-l", "a@b", "a b"] {
            let mut host = input(AuthMethod::Password, None);
            host.username = username.into();
            assert!(validate(host).is_err(), "{username}");
        }
        let mut host = input(AuthMethod::Password, None);
        host.port = 0;
        assert!(validate(host).is_err());
        let mut host = input(AuthMethod::Password, None);
        host.id = Some("../x".into());
        assert!(validate(host).is_err());
    }
}
