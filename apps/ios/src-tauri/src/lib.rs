mod commands;
mod fs_core;
mod git_core;
mod git_host;
mod git_operations;
mod git_requests;
mod icon_packs;
mod ssh;
mod storage;
mod watch;

use std::sync::Mutex;
use tauri::Manager;

pub struct AppState {
    pub storage: storage::Storage,
    pub roots: Mutex<fs_core::Roots>,
    pub watchers: watch::Watchers,
    pub language_servers: Mutex<()>,
    pub git: git_operations::Operations,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_oxbit_files::init())
        .setup(|app| {
            let directory = app.path().app_data_dir()?;
            app.manage(AppState {
                storage: storage::Storage::new(directory),
                roots: Mutex::new(fs_core::Roots::default()),
                watchers: watch::Watchers::default(),
                language_servers: Mutex::new(()),
                git: git_operations::Operations::default(),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::ios_storage_get,
            commands::ios_storage_set,
            commands::ios_documents_path,
            commands::ios_fs_open_root,
            commands::ios_fs_close_root,
            commands::ios_lsp_message,
            commands::ios_fs_list,
            commands::ios_fs_read,
            commands::ios_fs_write,
            commands::ios_fs_mkdir,
            commands::ios_fs_rename,
            commands::ios_fs_delete,
            commands::ios_fs_watch,
            commands::ios_fs_unwatch,
            commands::ios_icon_packs_read,
            commands::ios_icon_packs_mutate,
            commands::ios_open_external,
            git_host::ios_git_request,
            git_host::ios_git_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Oxbit");
}
