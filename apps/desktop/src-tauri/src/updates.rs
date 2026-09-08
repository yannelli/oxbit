use crate::commands::{self, Desktop};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_updater::UpdaterExt;

fn manual_updates() -> bool {
    cfg!(target_os = "linux")
        && !matches!(
            tauri::utils::platform::bundle_type(),
            Some(tauri::utils::config::BundleType::AppImage)
        )
}

pub const RELEASES: &str = "https://github.com/yannelli/oxbit/releases/latest";
pub const MANIFEST: &str = "https://github.com/yannelli/oxbit/releases/latest/download/latest.json";

#[tauri::command]
pub async fn desktop_check_update(app: AppHandle, window: WebviewWindow) -> Result<Value, String> {
    commands::local(&window)?;
    if manual_updates() {
        return Ok(json!({"status":"manual", "url":RELEASES}));
    }
    let Some(key) = option_env!("OXBIT_UPDATER_PUBLIC_KEY").filter(|k| !k.is_empty()) else {
        return Ok(json!({"status":"unconfigured"}));
    };
    let updater = app
        .updater_builder()
        .pubkey(key)
        .endpoints(vec![MANIFEST
            .parse()
            .map_err(|_| "Invalid update endpoint")?])
        .map_err(|_| "Invalid updater configuration")?
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|_| "Updater is unavailable")?;
    match updater
        .check()
        .await
        .map_err(|_| "Update check failed. Check your connection and try again.")?
    {
        Some(update) => Ok(
            json!({"status":"available", "version":update.version, "notes":update.body, "url":RELEASES}),
        ),
        None => Ok(json!({"status":"current"})),
    }
}

#[tauri::command]
pub async fn desktop_download_update(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    commands::local(&window)?;
    if manual_updates() {
        return Err("Use the package download to upgrade this installation".into());
    }
    let key = option_env!("OXBIT_UPDATER_PUBLIC_KEY")
        .filter(|k| !k.is_empty())
        .ok_or("This build has no updater signing key")?;
    let update = app
        .updater_builder()
        .pubkey(key)
        .endpoints(vec![MANIFEST.parse().map_err(|_| "Invalid endpoint")?])
        .map_err(|_| "Invalid updater configuration")?
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|_| "Updater unavailable")?
        .check()
        .await
        .map_err(|_| "Update check failed")?
        .ok_or("No update is available")?;
    let mut downloaded = 0_u64;
    let bytes = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                let _ = app.emit(
                    "desktop-update-progress",
                    json!({"downloaded":downloaded, "total":total}),
                );
            },
            || {},
        )
        .await
        .map_err(|_| {
            "Download or signature verification failed. The installed application was not changed."
        })?;
    *app.state::<Desktop>().update.lock().unwrap() = Some((update, bytes));
    crate::closing::begin(&app, window.label(), "update", None)
}
