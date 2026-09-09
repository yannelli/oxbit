//! Files app folder access. Swift owns the document picker and security-scoped bookmarks;
//! the app crate reads and writes the resolved paths with `std::fs`.
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

mod commands;
#[cfg(desktop)]
mod desktop;
mod error;
#[cfg(mobile)]
mod mobile;
mod models;

pub use error::{Error, Result};
pub use models::*;

#[cfg(desktop)]
use desktop::OxbitFiles;
#[cfg(mobile)]
use mobile::OxbitFiles;

pub trait OxbitFilesExt<R: Runtime> {
    fn oxbit_files(&self) -> &OxbitFiles<R>;
}

impl<R: Runtime, T: Manager<R>> OxbitFilesExt<R> for T {
    fn oxbit_files(&self) -> &OxbitFiles<R> {
        self.state::<OxbitFiles<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("oxbit-files")
        .invoke_handler(tauri::generate_handler![
            commands::pick_folder,
            commands::open_folder,
            commands::close_folder,
            commands::forget_folder,
            commands::documents_path,
        ])
        .setup(|app, api| {
            #[cfg(mobile)]
            let files = mobile::init(app, api)?;
            #[cfg(desktop)]
            let files = desktop::init(app, api)?;
            app.manage(files);
            Ok(())
        })
        .build()
}
