use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<OxbitFiles<R>> {
    Ok(OxbitFiles(std::marker::PhantomData))
}

/// Desktop fallback for the iOS Files app plugin.
pub struct OxbitFiles<R: Runtime>(std::marker::PhantomData<fn() -> R>);

const UNSUPPORTED: crate::Error = crate::Error::Unsupported("Files app folders need iOS");

impl<R: Runtime> OxbitFiles<R> {
    pub fn lsp_message(&self, _request: serde_json::Value) -> crate::Result<serde_json::Value> {
        Err(UNSUPPORTED)
    }

    pub fn lsp_close_workspace(&self, _workspace_id: String) -> crate::Result<()> {
        Ok(())
    }

    pub fn git_credentials(&self, _request: serde_json::Value) -> crate::Result<serde_json::Value> {
        Err(UNSUPPORTED)
    }

    pub fn read_git_credentials(&self) -> crate::Result<serde_json::Value> {
        Err(UNSUPPORTED)
    }

    pub fn ssh_keys(&self, _request: serde_json::Value) -> crate::Result<serde_json::Value> {
        Err(UNSUPPORTED)
    }

    pub fn download_runtime(
        &self,
        _id: &str,
        _url: &str,
        _sha256: &str,
        _size: u64,
    ) -> crate::Result<serde_json::Value> {
        Err(UNSUPPORTED)
    }

    pub fn cancel_runtime_download(&self, _id: &str) -> crate::Result<()> {
        Err(UNSUPPORTED)
    }

    pub fn pick_files(&self, _multiple: bool) -> crate::Result<PickedFiles> {
        Err(UNSUPPORTED)
    }

    pub fn commit_signing(&self, _request: serde_json::Value) -> crate::Result<serde_json::Value> {
        Err(UNSUPPORTED)
    }

    pub fn commit_signer(&self) -> crate::Result<Option<crate::CommitSigner>> {
        crate::commit_signing::commit_signer(
            self.commit_signing(serde_json::json!({ "operation": "read" }))?,
        )
    }

    pub fn runtime_credentials(
        &self,
        _request: serde_json::Value,
    ) -> crate::Result<serde_json::Value> {
        Err(UNSUPPORTED)
    }

    pub fn runtime_discovery(
        &self,
        _request: serde_json::Value,
    ) -> crate::Result<serde_json::Value> {
        Err(UNSUPPORTED)
    }

    pub fn pick_folder(&self) -> crate::Result<Folder> {
        Err(UNSUPPORTED)
    }
    pub fn open_folder(&self, _id: String) -> crate::Result<Folder> {
        Err(UNSUPPORTED)
    }
    pub fn close_folder(&self, _id: String) -> crate::Result<()> {
        Err(UNSUPPORTED)
    }
    pub fn forget_folder(&self, _id: String) -> crate::Result<()> {
        Err(UNSUPPORTED)
    }
    pub fn documents_path(&self) -> crate::Result<DocumentsPath> {
        Err(UNSUPPORTED)
    }
}
