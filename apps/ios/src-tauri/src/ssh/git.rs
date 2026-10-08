//! Git over SSH: picks the key for a remote, checks the server against the known hosts, and runs
//! `git-upload-pack` or `git-receive-pack` on an exec channel for the git2 transport.
use super::{
    connect::{self, Credential, HostKey, Outcome, Target},
    git_stream::ExecStream,
    hosts::{AuthMethod, Host},
    keys,
    known_hosts::{authority, KnownHosts, KnownKey},
};
use crate::{
    fs_core::{Error, Result},
    git_core::ssh_transport::{SshConnector, SshStream, SshUrl},
};
use serde::Serialize;
use std::sync::{atomic::AtomicBool, Arc, Mutex};

/// Workspace storage key for the SSH key ID bound to a repository.
pub const GIT_SSH_KEY: &str = "git-ssh-key";
/// Hosting services expect `git` when the remote URL names no user.
const DEFAULT_USER: &str = "git";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Prompt {
    HostUnknown {
        host_key: HostKey,
    },
    HostChanged {
        host_key: HostKey,
        known: Vec<KnownKey>,
    },
    KeyRequired {
        hostname: String,
        port: u16,
        username: String,
    },
}

impl Prompt {
    fn error(&self) -> Error {
        match self {
            Prompt::HostUnknown { host_key } => Error::new(
                "HOST_KEY_UNKNOWN",
                format!(
                    "Confirm the host key for {} before using this remote.",
                    authority(&host_key.host, host_key.port)
                ),
            ),
            Prompt::HostChanged { host_key, .. } => Error::new(
                "HOST_KEY_CHANGED",
                format!(
                    "The host key for {} does not match the saved key. Oxbit did not connect.",
                    authority(&host_key.host, host_key.port)
                ),
            ),
            Prompt::KeyRequired {
                hostname,
                port,
                username,
            } => Error::new(
                "SSH_KEY_REQUIRED",
                format!(
                    "Choose an SSH key for {username}@{}.",
                    authority(hostname, *port)
                ),
            ),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct Selection {
    pub key_id: String,
    pub username: String,
    pub host_id: String,
}

/// The repository's bound key first, then the key of a saved host for the same server.
pub fn select(
    binding: Option<&str>,
    hosts: &[Host],
    url: &SshUrl,
) -> std::result::Result<Selection, Prompt> {
    let saved: Vec<&Host> = hosts
        .iter()
        .filter(|host| {
            host.hostname.eq_ignore_ascii_case(&url.host)
                && host.port == url.port
                && host.auth == AuthMethod::Key
                && host.key_id.is_some()
        })
        .collect();
    let host = saved
        .iter()
        .find(|host| url.user.as_deref().is_none_or(|user| user == host.username))
        .or(saved.first());
    let username = url
        .user
        .clone()
        .or_else(|| host.map(|host| host.username.clone()))
        .unwrap_or_else(|| DEFAULT_USER.to_string());
    let host_id = host.map(|host| host.id.clone()).unwrap_or_default();
    match binding.or_else(|| host.and_then(|host| host.key_id.as_deref())) {
        Some(key_id) => Ok(Selection {
            key_id: key_id.to_string(),
            username,
            host_id,
        }),
        None => Err(Prompt::KeyRequired {
            hostname: url.host.clone(),
            port: url.port,
            username,
        }),
    }
}

pub type KeyLoader = Box<dyn Fn(&str) -> Result<String> + Send + Sync>;

pub struct GitConnector {
    pub runtime: tokio::runtime::Handle,
    pub known: Arc<KnownHosts>,
    pub hosts: Vec<Host>,
    pub binding: Option<String>,
    /// Returns the OpenSSH private key text for a key ID from the Keychain.
    pub private_key: KeyLoader,
    pub cancel: Arc<AtomicBool>,
    pub prompt: Mutex<Option<Prompt>>,
}

impl GitConnector {
    fn ask(&self, prompt: Prompt) -> Error {
        let error = prompt.error();
        *self.prompt.lock().unwrap() = Some(prompt);
        error
    }

    pub fn take_prompt(&self) -> Option<Prompt> {
        self.prompt.lock().unwrap().take()
    }
}

impl SshConnector for GitConnector {
    fn exec(&self, url: &SshUrl, command: &str) -> Result<Box<dyn SshStream>> {
        let selection =
            select(self.binding.as_deref(), &self.hosts, url).map_err(|prompt| self.ask(prompt))?;
        let key = keys::decode(&(self.private_key)(&selection.key_id)?)?;
        let target = Target {
            host_id: selection.host_id,
            hostname: url.host.clone(),
            port: url.port,
            username: selection.username,
        };
        let credential = Credential::Key(Arc::new(key));
        let handle = match self.runtime.block_on(connect::authenticate(
            self.known.clone(),
            &target,
            &credential,
        ))? {
            Ok(handle) => handle,
            Err(Outcome::HostUnknown { host_key }) => {
                return Err(self.ask(Prompt::HostUnknown { host_key }))
            }
            Err(Outcome::HostChanged { host_key, known }) => {
                return Err(self.ask(Prompt::HostChanged { host_key, known }))
            }
            Err(_) => return Err(connect::failed(&target, "authentication did not finish")),
        };
        let channel = self
            .runtime
            .block_on(async {
                let channel = handle.channel_open_session().await?;
                channel.exec(true, command).await?;
                Ok::<_, russh::Error>(channel)
            })
            .map_err(|error| connect::failed(&target, error))?;
        Ok(Box::new(ExecStream::new(
            self.runtime.clone(),
            handle,
            channel,
            self.cancel.clone(),
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::{select, Prompt, Selection};
    use crate::{
        git_core::ssh_transport::parse_ssh_url,
        ssh::hosts::{AuthMethod, Host},
    };

    fn host(id: &str, hostname: &str, port: u16, username: &str, key: Option<&str>) -> Host {
        Host {
            id: id.into(),
            label: id.into(),
            hostname: hostname.into(),
            port,
            username: username.into(),
            auth: if key.is_some() {
                AuthMethod::Key
            } else {
                AuthMethod::Password
            },
            key_id: key.map(str::to_string),
            password_saved: false,
        }
    }

    fn chosen(key_id: &str, username: &str, host_id: &str) -> Selection {
        Selection {
            key_id: key_id.into(),
            username: username.into(),
            host_id: host_id.into(),
        }
    }

    #[test]
    fn selects_the_bound_key_then_the_saved_host_key_then_asks() {
        let hosts = [
            host("password", "github.com", 22, "git", None),
            host("other-port", "github.com", 2222, "git", Some("key-port")),
            host("dev", "GitHub.com", 22, "dev", Some("key-dev")),
            host("git", "github.com", 22, "git", Some("key-git")),
        ];
        let scp = parse_ssh_url("git@github.com:owner/repo.git").unwrap();
        assert_eq!(
            select(Some("bound"), &hosts, &scp),
            Ok(chosen("bound", "git", "git"))
        );
        assert_eq!(
            select(None, &hosts, &scp),
            Ok(chosen("key-git", "git", "git"))
        );
        let no_user = parse_ssh_url("ssh://github.com/owner/repo.git").unwrap();
        assert_eq!(
            select(None, &hosts, &no_user),
            Ok(chosen("key-dev", "dev", "dev"))
        );
        let other_user = parse_ssh_url("deploy@github.com:owner/repo.git").unwrap();
        assert_eq!(
            select(None, &hosts, &other_user),
            Ok(chosen("key-dev", "deploy", "dev"))
        );
        let port = parse_ssh_url("ssh://git@github.com:2222/owner/repo.git").unwrap();
        assert_eq!(
            select(None, &hosts, &port),
            Ok(chosen("key-port", "git", "other-port"))
        );
        let unknown = parse_ssh_url("gitea.example:owner/repo.git").unwrap();
        assert_eq!(
            select(None, &hosts[..1], &unknown),
            Err(Prompt::KeyRequired {
                hostname: "gitea.example".into(),
                port: 22,
                username: "git".into(),
            })
        );
        assert_eq!(
            select(None, &hosts[..1], &scp),
            Err(Prompt::KeyRequired {
                hostname: "github.com".into(),
                port: 22,
                username: "git".into(),
            })
        );
        assert_eq!(
            select(Some("bound"), &[], &unknown),
            Ok(chosen("bound", "git", ""))
        );
    }
}
