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
