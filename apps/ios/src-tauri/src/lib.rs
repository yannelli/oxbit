mod commands;
mod fs_core;
mod git_core;
mod git_host;
mod git_operations;
mod git_requests;
mod icon_packs;
pub mod remote_runtime;
mod search;
mod search_core;
mod ssh;
mod storage;
mod watch;

use std::sync::{Mutex, RwLock};
use tauri::Manager;

pub struct AppState {
    pub storage: storage::Storage,
    pub roots: Mutex<fs_core::Roots>,
    pub watchers: watch::Watchers,
    pub language_servers: RwLock<()>,
    pub git: git_operations::Operations,
    pub ssh: ssh::Ssh,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_oxbit_files::init())
        .setup(|app| {
            git_core::ssh_transport::register().map_err(|error| error.message)?;
            let directory = app.path().app_data_dir()?;
            let ssh = ssh::Ssh::new(&directory.join("ssh"));
            app.manage(AppState {
                storage: storage::Storage::new(directory),
                roots: Mutex::new(fs_core::Roots::default()),
                watchers: watch::Watchers::default(),
                language_servers: RwLock::new(()),
                git: git_operations::Operations::default(),
                ssh,
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
            ssh::commands::ios_ssh_hosts_list,
            ssh::commands::ios_ssh_host_save,
            ssh::commands::ios_ssh_host_remove,
            ssh::commands::ios_ssh_forget_password,
            ssh::commands::ios_ssh_keys_generate,
            ssh::commands::ios_ssh_keys_import,
            ssh::commands::ios_ssh_connect,
            ssh::commands::ios_ssh_trust,
            ssh::commands::ios_ssh_forget_host_key,
            ssh::commands::ios_ssh_disconnect,
            ssh::runtime_commands::ios_ssh_runtime_start,
            ssh::runtime_commands::ios_ssh_runtime_resume,
            ssh::runtime_commands::ios_ssh_runtime_stop,
            ssh::git_commands::ios_ssh_git_prompt,
            ssh::git_commands::ios_ssh_git_trust,
            ssh::git_commands::ios_ssh_git_forget_host_key,
            ssh::fs_commands::ios_ssh_open_root,
            ssh::fs_commands::ios_ssh_close_root,
            ssh::fs_commands::ios_ssh_fs_list,
            ssh::fs_commands::ios_ssh_fs_read,
            ssh::fs_commands::ios_ssh_fs_write,
            ssh::fs_commands::ios_ssh_fs_mkdir,
            ssh::fs_commands::ios_ssh_fs_rename,
            ssh::fs_commands::ios_ssh_fs_delete,
            ssh::fs_commands::ios_ssh_upload,
            ssh::fs_commands::ios_ssh_download,
            ssh::fs_commands::ios_ssh_transfer_cancel,
            search::ios_search_request,
            search::ios_search_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Oxbit");
}
