use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::*;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_oxbit_files);

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<OxbitFiles<R>> {
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_oxbit_files)?;
    #[cfg(target_os = "android")]
    let handle = {
        let _ = api;
        return Err(crate::Error::Unsupported("Files app folders need iOS"));
    };
    Ok(OxbitFiles(handle))
}

/// Access to the Swift plugin that owns security-scoped folder URLs.
pub struct OxbitFiles<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> OxbitFiles<R> {
    pub fn lsp_message(&self, request: serde_json::Value) -> crate::Result<serde_json::Value> {
        self.0
            .run_mobile_plugin("lspMessage", request)
            .map_err(Into::into)
    }

    pub fn lsp_close_workspace(&self, workspace_id: String) -> crate::Result<()> {
        self.0
            .run_mobile_plugin(
                "lspCloseWorkspace",
                serde_json::json!({ "workspaceId": workspace_id }),
            )
            .map_err(Into::into)
    }

    pub fn git_credentials(&self, request: serde_json::Value) -> crate::Result<serde_json::Value> {
        self.0
            .run_mobile_plugin("gitCredentials", request)
            .map_err(Into::into)
    }

    pub fn read_git_credentials(&self) -> crate::Result<serde_json::Value> {
        self.git_credentials(serde_json::json!({ "operation": "read" }))
    }

    /// Internal callers reach every operation, including `read` and the host password ones.
    pub fn ssh_keys(&self, request: serde_json::Value) -> crate::Result<serde_json::Value> {
        self.0
            .run_mobile_plugin("sshKeys", request)
            .map_err(Into::into)
    }

    /// Internal only: the pinned remote runtime archive, downloaded with URLSession. `id` names
    /// the download for `cancel_runtime_download`.
    pub fn download_runtime(
        &self,
        id: &str,
        url: &str,
        sha256: &str,
        size: u64,
    ) -> crate::Result<serde_json::Value> {
        self.0
            .run_mobile_plugin(
                "downloadRuntime",
                serde_json::json!({ "id": id, "url": url, "sha256": sha256, "size": size }),
            )
            .map_err(Into::into)
    }

    pub fn cancel_runtime_download(&self, id: &str) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("cancelRuntimeDownload", serde_json::json!({ "id": id }))
            .map_err(Into::into)
    }

    pub fn pick_files(&self, multiple: bool) -> crate::Result<PickedFiles> {
        self.0
            .run_mobile_plugin("pickFiles", serde_json::json!({ "multiple": multiple }))
            .map_err(Into::into)
    }

    pub fn commit_signing(&self, request: serde_json::Value) -> crate::Result<serde_json::Value> {
        self.0
            .run_mobile_plugin("commitSigning", request)
            .map_err(Into::into)
    }

    /// Reads the Keychain key when commit signing is on.
    pub fn commit_signer(&self) -> crate::Result<Option<crate::CommitSigner>> {
        crate::commit_signing::commit_signer(
            self.commit_signing(serde_json::json!({ "operation": "read" }))?,
        )
    }

    pub fn runtime_credentials(
        &self,
        request: serde_json::Value,
    ) -> crate::Result<serde_json::Value> {
        self.0
            .run_mobile_plugin("runtimeCredentials", request)
            .map_err(Into::into)
    }

    pub fn pick_folder(&self) -> crate::Result<Folder> {
        self.0
            .run_mobile_plugin("pickFolder", ())
            .map_err(Into::into)
    }
    pub fn open_folder(&self, id: String) -> crate::Result<Folder> {
        self.0
            .run_mobile_plugin("openFolder", FolderRequest { id })
            .map_err(Into::into)
    }
    pub fn close_folder(&self, id: String) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("closeFolder", FolderRequest { id })
            .map_err(Into::into)
    }
    pub fn forget_folder(&self, id: String) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("forgetFolder", FolderRequest { id })
            .map_err(Into::into)
    }
    pub fn documents_path(&self) -> crate::Result<DocumentsPath> {
        self.0
            .run_mobile_plugin("documentsPath", ())
            .map_err(Into::into)
    }
}
