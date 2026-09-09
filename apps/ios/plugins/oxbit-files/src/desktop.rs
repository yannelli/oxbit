use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<OxbitFiles<R>> {
    Ok(OxbitFiles(std::marker::PhantomData))
}

/// Desktop builds exist so the crate compiles and tests on the macOS host; every call is unsupported.
pub struct OxbitFiles<R: Runtime>(std::marker::PhantomData<fn() -> R>);

const UNSUPPORTED: crate::Error = crate::Error::Unsupported("Files app folders need iOS");

impl<R: Runtime> OxbitFiles<R> {
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
