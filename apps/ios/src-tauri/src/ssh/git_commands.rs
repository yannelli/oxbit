//! Commands for the prompt a Git over SSH request leaves for its workspace root.
use super::git::Prompt;
use crate::{
    fs_core::{Error, Result},
    AppState,
};
use tauri::State;

fn stale() -> Error {
    Error::new(
        "NOT_FOUND",
        "Run the Git request again to review the server.",
    )
}

#[tauri::command]
pub fn ios_ssh_git_prompt(state: State<'_, AppState>, id: String) -> Result<Option<Prompt>> {
    Ok(state.ssh.git_prompts.lock().unwrap().get(&id).cloned())
}

/// Trusts the host key that the request presented and the user compared.
#[tauri::command]
pub fn ios_ssh_git_trust(
    state: State<'_, AppState>,
    id: String,
    fingerprint: String,
) -> Result<()> {
    let mut prompts = state.ssh.git_prompts.lock().unwrap();
    let Some(Prompt::HostUnknown { host_key }) = prompts.get(&id) else {
        return Err(stale());
    };
    if host_key.fingerprint != fingerprint {
        return Err(stale());
    }
    state.ssh.known.trust(
        &host_key.host,
        host_key.port,
        &host_key.algorithm,
        &host_key.fingerprint,
    )?;
    prompts.remove(&id);
    Ok(())
}

/// Forgets the saved keys for the server whose key changed; the next request asks again.
#[tauri::command]
pub async fn ios_ssh_git_forget_host_key(state: State<'_, AppState>, id: String) -> Result<()> {
    let prompt = state.ssh.git_prompts.lock().unwrap().get(&id).cloned();
    let Some(Prompt::HostChanged { host_key, .. }) = prompt else {
        return Err(stale());
    };
    for host in state.ssh.hosts.list()? {
        if host.hostname.eq_ignore_ascii_case(&host_key.host) && host.port == host_key.port {
            state.ssh.pool.disconnect(&host.id).await;
            state.ssh.close_host_roots(&host.id);
        }
    }
    state.ssh.known.forget(&host_key.host, host_key.port)?;
    state.ssh.git_prompts.lock().unwrap().remove(&id);
    Ok(())
}
