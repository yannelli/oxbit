//! Tauri commands for SSH hosts, keys, host keys, and connections. Private keys and saved
//! passwords move between Rust and the Keychain plugin only.
use super::{
    connect::{Credential, Outcome, Target},
    hosts::{AuthMethod, Host, HostInput},
    keys::{self, KeyInfo, KeyMaterial, MAX_KEY_TEXT_BYTES},
    known_hosts::KnownKey,
};
use crate::{
    fs_core::{Error, Result},
    AppState,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc};
use tauri::{AppHandle, State};
use tauri_plugin_oxbit_files::OxbitFilesExt;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostView {
    #[serde(flatten)]
    pub host: Host,
    pub known_keys: Vec<KnownKey>,
}

pub(crate) async fn keychain(app: &AppHandle, request: Value) -> Result<Value> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || app.oxbit_files().ssh_keys(request))
        .await
        .map_err(|_| Error::new("SSH_KEYS", "The Keychain request did not finish."))?
        .map_err(|error| Error::new("SSH_KEYS", error.to_string()))
}

fn target(host: &Host) -> Target {
    Target {
        host_id: host.id.clone(),
        hostname: host.hostname.clone(),
        port: host.port,
        username: host.username.clone(),
    }
}

#[tauri::command]
pub async fn ios_ssh_hosts_list(state: State<'_, AppState>) -> Result<Vec<HostView>> {
    let ssh = &state.ssh;
    ssh.hosts
        .list()?
        .into_iter()
        .map(|host| {
            Ok(HostView {
                known_keys: ssh.known.keys(&host.hostname, host.port)?,
                host,
            })
        })
        .collect()
}

#[tauri::command]
pub async fn ios_ssh_host_save(
    app: AppHandle,
    state: State<'_, AppState>,
    host: HostInput,
) -> Result<Host> {
    let ssh = &state.ssh;
    let previous = host.id.as_deref().and_then(|id| ssh.hosts.get(id).ok());
    let saved = ssh.hosts.save(host)?;
    if let Some(previous) = previous {
        if target(&previous) != target(&saved)
            || previous.auth != saved.auth
            || previous.key_id != saved.key_id
        {
            ssh.pool.disconnect(&saved.id).await;
            ssh.close_host_roots(&saved.id);
        }
        if previous.password_saved && !saved.password_saved {
            keychain(
                &app,
                json!({ "operation": "forgetPassword", "hostId": saved.id }),
            )
            .await?;
        }
    }
    Ok(saved)
}

#[tauri::command]
pub async fn ios_ssh_host_remove(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<()> {
    let ssh = &state.ssh;
    let host = ssh.hosts.get(&id)?;
    ssh.pool.disconnect(&id).await;
    ssh.close_host_roots(&id);
    if host.password_saved {
        keychain(&app, json!({ "operation": "forgetPassword", "hostId": id })).await?;
    }
    ssh.hosts.remove(&id)
}

#[tauri::command]
pub async fn ios_ssh_forget_password(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<()> {
    keychain(&app, json!({ "operation": "forgetPassword", "hostId": id })).await?;
    state.ssh.hosts.set_password_saved(&id, false)
}

async fn save_key(app: &AppHandle, material: KeyMaterial) -> Result<KeyInfo> {
    let info = material.info;
    keychain(
        app,
        json!({
            "operation": "save",
            "id": info.id,
            "name": info.name,
            "algorithm": info.algorithm,
            "fingerprint": info.fingerprint,
            "publicKey": info.public_key,
            "privateKey": material.private_key,
        }),
    )
    .await?;
    Ok(info)
}

#[tauri::command]
pub async fn ios_ssh_keys_generate(app: AppHandle, name: String) -> Result<KeyInfo> {
    let material = tauri::async_runtime::spawn_blocking(move || keys::generate(&name))
        .await
        .map_err(|_| Error::new("KEY", "Key generation did not finish."))??;
    save_key(&app, material).await
}

/// Picked files are copies under the temporary directory; any other path is refused.
pub(crate) fn picked_file(path: &str) -> Result<PathBuf> {
    let temporary = std::env::temp_dir()
        .canonicalize()
        .map_err(|_| Error::new("IO", "The temporary directory is unavailable."))?;
    let path = PathBuf::from(path)
        .canonicalize()
        .map_err(|_| Error::new("NOT_FOUND", "The chosen file is no longer available."))?;
    if !path.starts_with(&temporary) || !path.is_file() {
        return Err(Error::new(
            "PATH_DENIED",
            "Choose the file again from the Files app.",
        ));
    }
    Ok(path)
}

#[tauri::command]
pub async fn ios_ssh_keys_import(
    app: AppHandle,
    name: String,
    text: Option<String>,
    path: Option<String>,
    passphrase: Option<String>,
) -> Result<KeyInfo> {
    let text = match (text, path) {
        (Some(text), None) => text,
        (None, Some(path)) => {
            let file = picked_file(&path)?;
            let bytes = std::fs::read(&file)
                .map_err(|_| Error::new("IO", "The key file could not be read."))?;
            let _ = std::fs::remove_file(&file);
            if bytes.len() > MAX_KEY_TEXT_BYTES {
                return Err(Error::invalid("The key file is too large."));
            }
            String::from_utf8(bytes)
                .map_err(|_| Error::new("KEY_INVALID", "The key file is not text."))?
        }
        _ => return Err(Error::invalid("Paste a private key or choose a key file.")),
    };
    let material = tauri::async_runtime::spawn_blocking(move || {
        keys::import(&name, &text, passphrase.as_deref())
    })
    .await
    .map_err(|_| Error::new("KEY", "Key import did not finish."))??;
    save_key(&app, material).await
}

async fn credential(
    app: &AppHandle,
    host: &Host,
    password: Option<String>,
) -> Result<Option<Credential>> {
    match host.auth {
        AuthMethod::Key => {
            let id = host
                .key_id
                .clone()
                .ok_or_else(|| Error::invalid("Choose an SSH key for this host."))?;
            let saved = keychain(app, json!({ "operation": "read", "id": id })).await?;
            let text = saved
                .get("privateKey")
                .and_then(Value::as_str)
                .ok_or_else(|| Error::new("KEY_INVALID", "The saved SSH key could not be read."))?;
            Ok(Some(Credential::Key(Arc::new(keys::decode(text)?))))
        }
        AuthMethod::Password => match password.filter(|value| !value.is_empty()) {
            Some(password) => Ok(Some(Credential::Password(password))),
            None if host.password_saved => {
                let saved = keychain(
                    app,
                    json!({ "operation": "readPassword", "hostId": host.id }),
                )
                .await?;
                Ok(saved
                    .get("password")
                    .and_then(Value::as_str)
                    .map(|password| Credential::Password(password.to_string())))
            }
            None => Ok(None),
        },
    }
}

#[tauri::command]
pub async fn ios_ssh_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    host_id: String,
    password: Option<String>,
    save_password: Option<bool>,
) -> Result<Outcome> {
    let ssh = &state.ssh;
    let host = ssh.hosts.get(&host_id)?;
    if let Some(home) = ssh.pool.connected(&target(&host)).await {
        return Ok(Outcome::Connected { home });
    }
    let typed = password.clone().filter(|value| !value.is_empty());
    let Some(credential) = credential(&app, &host, password).await? else {
        return Ok(Outcome::PasswordRequired);
    };
    let outcome = ssh.pool.connect(target(&host), credential).await?;
    if let (Outcome::Connected { .. }, Some(password), Some(true)) =
        (&outcome, typed, save_password)
    {
        keychain(
            &app,
            json!({ "operation": "savePassword", "hostId": host.id, "password": password }),
        )
        .await?;
        ssh.hosts.set_password_saved(&host.id, true)?;
    }
    Ok(outcome)
}

#[tauri::command]
pub async fn ios_ssh_trust(
    state: State<'_, AppState>,
    host_id: String,
    algorithm: String,
    fingerprint: String,
) -> Result<()> {
    let host = state.ssh.hosts.get(&host_id)?;
    state
        .ssh
        .known
        .trust(&host.hostname, host.port, &algorithm, &fingerprint)
}

#[tauri::command]
pub async fn ios_ssh_forget_host_key(state: State<'_, AppState>, host_id: String) -> Result<()> {
    let host = state.ssh.hosts.get(&host_id)?;
    state.ssh.pool.disconnect(&host_id).await;
    state.ssh.close_host_roots(&host_id);
    state.ssh.known.forget(&host.hostname, host.port)
}

#[tauri::command]
pub async fn ios_ssh_disconnect(state: State<'_, AppState>, host_id: String) -> Result<()> {
    state.ssh.pool.disconnect(&host_id).await;
    state.ssh.close_host_roots(&host_id);
    Ok(())
}
