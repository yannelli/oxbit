//! `ssh://` and scp-style remotes through a custom git2 smart subtransport. The host supplies an
//! `SshConnector` that opens an exec channel running `git-upload-pack` or `git-receive-pack`.
use crate::fs_core::{Error, Result};
use git2::transport::{Service, SmartSubtransport, SmartSubtransportStream, Transport};
use std::{
    cell::RefCell,
    io::{Read, Write},
    sync::{Arc, OnceLock},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshUrl {
    pub user: Option<String>,
    pub host: String,
    pub port: u16,
    pub path: String,
}

pub trait SshStream: Read + Write + Send {}
impl<T: Read + Write + Send> SshStream for T {}

pub trait SshConnector: Send + Sync {
    /// Runs `command` on the server and returns its stdin and stdout.
    fn exec(&self, url: &SshUrl, command: &str) -> Result<Box<dyn SshStream>>;
}

thread_local! {
    static CONNECTOR: RefCell<Option<Arc<dyn SshConnector>>> = const { RefCell::new(None) };
    static FAILURE: RefCell<Option<Error>> = const { RefCell::new(None) };
}

fn invalid() -> Error {
    Error::invalid("Invalid SSH repository URL")
}

fn valid_host(host: &str) -> bool {
    if let Some(address) = host
        .strip_prefix('[')
        .and_then(|host| host.strip_suffix(']'))
    {
        return address.parse::<std::net::Ipv6Addr>().is_ok();
    }
    !host.is_empty()
        && host.len() <= 253
        && !host.starts_with(['-', '.'])
        && host
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".-".contains(&byte))
}

fn valid_user(user: &str) -> bool {
    !user.is_empty()
        && user.len() <= 64
        && !user.starts_with('-')
        && user
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
}

fn split_user(authority: &str) -> Result<(Option<String>, &str)> {
    match authority.rsplit_once('@') {
        Some((user, host)) if valid_user(user) => Ok((Some(user.to_string()), host)),
        Some(_) => Err(invalid()),
        None => Ok((None, authority)),
    }
}

/// scp-style remotes have no scheme and a `host:` before any `/`.
pub fn is_ssh_url(url: &str) -> bool {
    if url.starts_with("ssh://") {
        return true;
    }
    !url.contains("://")
        && url
            .find(':')
            .is_some_and(|colon| colon > 0 && !url[..colon].contains('/'))
}

pub fn parse_ssh_url(url: &str) -> Result<SshUrl> {
    if url.len() > 4096
        || url
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte == b' ')
    {
        return Err(invalid());
    }
    let (user, host, port, path) = if let Some(rest) = url.strip_prefix("ssh://") {
        let slash = rest.find('/').ok_or_else(invalid)?;
        let (authority, path) = rest.split_at(slash);
        if authority.contains('%') {
            return Err(invalid());
        }
        let (user, address) = split_user(authority)?;
        let (host, port) = match address.rfind(':') {
            Some(colon) if !address[colon..].contains(']') => {
                let port = address[colon + 1..]
                    .parse::<u16>()
                    .ok()
                    .filter(|port| *port > 0)
                    .ok_or_else(invalid)?;
                (&address[..colon], port)
            }
            _ => (address, 22),
        };
        // Git sends `ssh://host/~/repo` as `~/repo`, relative to the login's home folder.
        let path = path
            .strip_prefix('/')
            .filter(|path| path.starts_with('~'))
            .unwrap_or(path);
        (user, host, port, path)
    } else {
        let (authority, path) = if url.starts_with('[') || url.contains("@[") {
            let end = url.find("]:").ok_or_else(invalid)?;
            (&url[..=end], &url[end + 2..])
        } else {
            url.split_once(':').ok_or_else(invalid)?
        };
        let (user, host) = split_user(authority)?;
        (user, host, 22, path)
    };
    if !valid_host(host) || path.is_empty() || path == "/" || path.contains('\0') {
        return Err(invalid());
    }
    Ok(SshUrl {
        user,
        host: host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .to_string(),
        port,
        path: path.to_string(),
    })
}

/// Quotes the repository path the way Git's own SSH transport does.
pub fn command(service: &str, path: &str) -> String {
    format!("{service} '{}'", path.replace('\'', "'\\''"))
}

/// Keeps a structured error (host key prompt, server stderr) for `Context::git` to return.
pub fn record_failure(error: Error) {
    FAILURE.with(|failure| *failure.borrow_mut() = Some(error));
}

pub(super) fn take_failure() -> Option<Error> {
    FAILURE.with(|failure| failure.borrow_mut().take())
}

struct Scope(Option<Arc<dyn SshConnector>>);

impl Drop for Scope {
    fn drop(&mut self) {
        CONNECTOR.with(|connector| *connector.borrow_mut() = self.0.take());
        FAILURE.with(|failure| failure.borrow_mut().take());
    }
}

/// libgit2 builds transports on the calling thread, so the connector is thread-local for `run`.
pub(super) fn scoped<T>(connector: Option<Arc<dyn SshConnector>>, run: impl FnOnce() -> T) -> T {
    let previous = CONNECTOR.with(|current| current.replace(connector));
    FAILURE.with(|failure| failure.borrow_mut().take());
    let _scope = Scope(previous);
    run()
}

/// Registers the `ssh://` transport once; libgit2 also routes scp-style URLs to it.
pub fn register() -> Result<()> {
    static REGISTERED: OnceLock<std::result::Result<(), String>> = OnceLock::new();
    REGISTERED
        .get_or_init(|| {
            // SAFETY: runs once, at startup or before the first SSH remote; the factory is 'static.
            unsafe { git2::transport::register("ssh", factory) }
                .map_err(|error| error.message().to_string())
        })
        .clone()
        .map_err(|message| Error::new("GIT_FAILED", message))
}

fn factory(remote: &git2::Remote<'_>) -> std::result::Result<Transport, git2::Error> {
    let connector = CONNECTOR
        .with(|connector| connector.borrow().clone())
        .ok_or_else(|| git2::Error::from_str("SSH remotes are not available here"))?;
    Transport::smart(remote, false, Subtransport(connector))
}

struct Subtransport(Arc<dyn SshConnector>);

struct Stream(Box<dyn SshStream>);

impl Read for Stream {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        self.0.read(buffer)
    }
}

impl Write for Stream {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        self.0.write(buffer)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.0.flush()
    }
}

impl SmartSubtransport for Subtransport {
    fn action(
        &self,
        url: &str,
        action: Service,
    ) -> std::result::Result<Box<dyn SmartSubtransportStream>, git2::Error> {
        let service = match action {
            Service::UploadPackLs | Service::UploadPack => "git-upload-pack",
            Service::ReceivePackLs | Service::ReceivePack => "git-receive-pack",
        };
        let opened =
            parse_ssh_url(url).and_then(|url| self.0.exec(&url, &command(service, &url.path)));
        match opened {
            Ok(stream) => Ok(Box::new(Stream(stream))),
            Err(error) => {
                let message = error.message.clone();
                record_failure(error);
                Err(git2::Error::from_str(&message))
            }
        }
    }

    fn close(&self) -> std::result::Result<(), git2::Error> {
        Ok(())
    }
}
