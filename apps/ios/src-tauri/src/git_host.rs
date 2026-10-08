use crate::{
    fs_core::{Error, Result},
    git_core,
    git_requests::{safe_output, validate_request, validate_request_id},
    ssh::git::{GitConnector, GIT_SSH_KEY},
    AppState,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_oxbit_files::OxbitFilesExt;

/// Workspace storage key for the account ID that Git Accounts and Commit Author binds to the root.
const GIT_ACCOUNT_KEY: &str = "git-account";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    request_id: &'a str,
    data: String,
}

#[tauri::command]
pub async fn ios_git_request(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    request_id: String,
    method: String,
    params: Value,
) -> Result<Value> {
    validate_request_id(&request_id)?;
    validate_request(&method, &params)?;
    let (root, operation) = {
        let roots = state
            .roots
            .lock()
            .map_err(|_| Error::new("IO", "Workspace roots are unavailable"))?;
        let root = roots.get(&id)?.clone();
        let operation = state.git.register(&id, &request_id)?;
        (root, operation)
    };
    let binding = state
        .storage
        .get(&root.id, GIT_ACCOUNT_KEY)?
        .and_then(|value| value.as_str().map(str::to_owned));
    let connector = if matches!(
        method.strip_prefix("git.").unwrap_or(&method),
        "clone" | "fetch" | "pull" | "push" | "publish"
    ) {
        state.ssh.git_prompts.lock().unwrap().remove(&root.id);
        Some(Arc::new(ssh_connector(&app, &state, &root.id, &operation)?))
    } else {
        None
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = operation.lock();
        if operation.is_cancelled() {
            return Err(Error::new("CANCELLED", "Git operation cancelled"));
        }
        let response = app
            .oxbit_files()
            .read_git_credentials()
            .map_err(|_| Error::new("AUTH", "Could not read Git credentials"))?;
        let mut credentials: git_core::Credentials = serde_json::from_value(response)
            .map_err(|_| Error::new("AUTH", "Invalid native Git credentials"))?;
        credentials.binding = binding;
        credentials.ssh = connector
            .clone()
            .map(|connector| connector as Arc<dyn git_core::ssh_transport::SshConnector>);
        if git_core::creates_commit(&method) {
            credentials.signer = app
                .oxbit_files()
                .commit_signer()
                .map_err(|error| Error::new("COMMIT_SIGNING", error.to_string()))?;
        }
        if operation.is_cancelled() {
            return Err(Error::new("CANCELLED", "Git operation cancelled"));
        }
        let event = format!("ios-git-progress:{id}");
        let progress = |data: &str| {
            let data = safe_output(data, &credentials.tokens());
            if !data.is_empty() {
                let _ = app.emit(
                    &event,
                    Progress {
                        request_id: &request_id,
                        data,
                    },
                );
            }
        };
        let result = git_core::dispatch(
            &root,
            &method,
            &params,
            &credentials,
            operation.cancellation(),
            &progress,
        );
        if let Some(prompt) = connector.and_then(|connector| connector.take_prompt()) {
            let state = app.state::<AppState>();
            state
                .ssh
                .git_prompts
                .lock()
                .unwrap()
                .insert(root.id.clone(), prompt);
        }
        result.map_err(|error| {
            Error::new(
                error.code,
                safe_output(&error.message, &credentials.tokens()),
            )
        })
    })
    .await
    .map_err(|_| Error::new("IO", "Native Git operation failed"))?
}

#[tauri::command]
pub fn ios_git_cancel(state: State<'_, AppState>, id: String, request_id: String) -> Result<()> {
    validate_request_id(&request_id)?;
    let roots = state
        .roots
        .lock()
        .map_err(|_| Error::new("IO", "Workspace roots are unavailable"))?;
    roots.get(&id)?;
    state.git.cancel(&id, &request_id)
}

/// Reads hosts and the repository's key binding now; private keys load only when a remote needs one.
fn ssh_connector(
    app: &AppHandle,
    state: &AppState,
    root_id: &str,
    operation: &crate::git_operations::Operation,
) -> Result<GitConnector> {
    let binding = state
        .storage
        .get(root_id, GIT_SSH_KEY)?
        .and_then(|value| value.as_str().map(str::to_owned));
    let keychain = app.clone();
    Ok(GitConnector {
        runtime: tokio::runtime::Handle::current(),
        known: state.ssh.known.clone(),
        hosts: state.ssh.hosts.list()?,
        binding,
        private_key: Box::new(move |id| {
            keychain
                .oxbit_files()
                .ssh_keys(json!({ "operation": "read", "id": id }))
                .ok()
                .and_then(|saved| saved.get("privateKey")?.as_str().map(str::to_owned))
                .ok_or_else(|| {
                    Error::new(
                        "KEY_INVALID",
                        "The SSH key for this remote is no longer on this device.",
                    )
                })
        }),
        cancel: operation.cancel_flag(),
        prompt: Mutex::new(None),
    })
}
