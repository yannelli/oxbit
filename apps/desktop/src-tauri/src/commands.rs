use crate::{
    environment,
    model::{self, Model, Project, SettingChange},
    supervisor::{Launch, OwnedRuntime},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

pub struct RuntimeRecord {
    pub token: String,
    pub process: Arc<OwnedRuntime>,
}
pub struct Desktop {
    pub directory: PathBuf,
    pub model: Mutex<Model>,
    pub runtimes: Mutex<BTreeMap<String, RuntimeRecord>>,
    pub storage: Mutex<BTreeMap<String, BTreeMap<String, Value>>>,
    pub environment: environment::Environment,
    pub closing: Mutex<Option<crate::closing::Transaction>>,
    pub exiting: AtomicBool,
    pub destroying: Mutex<Vec<String>>,
    pub update: Mutex<Option<(tauri_plugin_updater::Update, Vec<u8>)>>,
}

pub fn local(window: &WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|_| "Cannot verify window origin")?;
    if crate::application_url(&url) {
        Ok(())
    } else {
        Err("Native commands require a local application window".into())
    }
}
pub fn changed(app: &AppHandle) {
    let _ = app.emit("desktop-changed", ());
}
pub fn authorized(app: &AppHandle, window: &WebviewWindow, key: &str) -> Result<Project, String> {
    local(window)?;
    app.state::<Desktop>()
        .model
        .lock()
        .unwrap()
        .authorize(window.label(), key)
        .cloned()
}

#[tauri::command]
pub fn desktop_snapshot(app: AppHandle, window: WebviewWindow) -> Result<Value, String> {
    local(&window)?;
    let desktop = app.state::<Desktop>();
    let model = desktop.model.lock().unwrap();
    let state = model
        .windows
        .get(window.label())
        .cloned()
        .unwrap_or_default();
    let projects: Vec<_> = state
        .projects
        .iter()
        .filter_map(|key| model.projects.get(key))
        .collect();
    Ok(
        json!({"label":window.label(), "projects":projects, "active":state.active, "recent":model.recent, "profile":model.profile}),
    )
}

pub fn open_path(
    app: &AppHandle,
    window: &str,
    path: &Path,
    new_window: bool,
) -> Result<String, String> {
    let desktop = app.state::<Desktop>();
    let (key, root, file) = desktop.model.lock().unwrap().locate_open(path)?;
    if desktop.closing.lock().unwrap().is_some() {
        return Err("Finish or cancel closing first".into());
    }
    let target = {
        let model = desktop.model.lock().unwrap();
        model
            .projects
            .get(&key)
            .map(|p| p.owner.clone())
            .unwrap_or_else(|| {
                if new_window || model.new_window_setting() {
                    format!("project-{}", uuid::Uuid::new_v4())
                } else {
                    window.into()
                }
            })
    };
    crate::create_window(app, &target)?;
    {
        let mut model = desktop.model.lock().unwrap();
        model.add(key.clone(), root, file, target.clone());
        model.save(&desktop.directory)?;
    }
    if let Some(window) = app.get_webview_window(&target) {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    changed(app);
    Ok(key)
}

/// The SSH URI is persisted as the project identity; remote paths are never
/// passed to local filesystem dialogs, canonicalization, or file-manager APIs.
fn open_remote(
    app: &AppHandle,
    window: &str,
    target: &str,
    new_window: bool,
) -> Result<String, String> {
    validate_remote(target)?;
    let desktop = app.state::<Desktop>();
    if desktop.closing.lock().unwrap().is_some() {
        return Err("Finish or cancel closing first".into());
    }
    let key = format!("{:x}", Sha256::digest(target.as_bytes()));
    let owner = {
        let model = desktop.model.lock().unwrap();
        model
            .projects
            .get(&key)
            .map(|p| p.owner.clone())
            .unwrap_or_else(|| {
                if new_window || model.new_window_setting() {
                    format!("project-{}", uuid::Uuid::new_v4())
                } else {
                    window.into()
                }
            })
    };
    crate::create_window(app, &owner)?;
    {
        let mut model = desktop.model.lock().unwrap();
        model.add(key.clone(), target.into(), None, owner.clone());
        if let Some(project) = model.projects.get_mut(&key) {
            project.name = format!("SSH · {}", target.trim_start_matches("ssh://"));
        }
        model.save(&desktop.directory)?;
    }
    if let Some(window) = app.get_webview_window(&owner) {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    changed(app);
    Ok(key)
}

fn validate_remote(target: &str) -> Result<(), String> {
    let url = tauri::Url::parse(target).map_err(|_| "Invalid SSH workspace URI")?;
    if target.len() > 8192
        || target.chars().any(char::is_control)
        || url.scheme() != "ssh"
        || url.host_str().is_none()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.path().starts_with('/')
        || url.port() == Some(0)
    {
        return Err(
            "Use ssh://[user@]host[:port]/path without passwords, queries, or fragments".into(),
        );
    }
    Ok(())
}

#[tauri::command]
pub fn desktop_open_remote(
    app: AppHandle,
    window: WebviewWindow,
    target: String,
    new_window: Option<bool>,
) -> Result<String, String> {
    local(&window)?;
    open_remote(&app, window.label(), &target, new_window.unwrap_or(false))
}

#[tauri::command]
pub async fn desktop_open_project(
    app: AppHandle,
    window: WebviewWindow,
    path: Option<String>,
    new_window: Option<bool>,
    file: Option<bool>,
) -> Result<Option<String>, String> {
    local(&window)?;
    if let Some(target) = path.as_deref().filter(|p| p.starts_with("ssh://")) {
        return open_remote(&app, window.label(), target, new_window.unwrap_or(false)).map(Some);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let picked = if let Some(path) = path {
            let path = fs::canonicalize(path).map_err(|_| "Project path is unavailable")?;
            let known = app
                .state::<Desktop>()
                .model
                .lock()
                .unwrap()
                .known_open_path(&path);
            #[cfg(feature = "native-test")]
            let known = known
                || std::env::var_os("OXBIT_NATIVE_FIXTURES")
                    .and_then(|p| fs::canonicalize(p).ok())
                    .is_some_and(|root| path.starts_with(root));
            if !known {
                return Err(
                    "Use the native Open Folder or Open File dialog to authorize a new location"
                        .into(),
                );
            }
            Some(path)
        } else {
            let dialog = app.dialog().file().set_title(if file == Some(true) {
                "Open File"
            } else {
                "Open Project Folder"
            });
            (if file == Some(true) {
                dialog.blocking_pick_file()
            } else {
                dialog.blocking_pick_folder()
            })
            .and_then(|p| p.into_path().ok())
        };
        picked
            .map(|path| open_path(&app, window.label(), &path, new_window.unwrap_or(false)))
            .transpose()
    })
    .await
    .map_err(|_| "Folder dialog failed")?
}

#[tauri::command]
pub fn desktop_activate(app: AppHandle, window: WebviewWindow, key: String) -> Result<(), String> {
    authorized(&app, &window, &key)?;
    let desktop = app.state::<Desktop>();
    let mut model = desktop.model.lock().unwrap();
    model.authorize(window.label(), &key)?;
    model
        .windows
        .entry(window.label().into())
        .or_default()
        .active = Some(key);
    model.save(&desktop.directory)?;
    drop(model);
    changed(&app);
    Ok(())
}

#[tauri::command]
pub fn desktop_file_opened(
    app: AppHandle,
    window: WebviewWindow,
    key: String,
    request: String,
) -> Result<(), String> {
    local(&window)?;
    let desktop = app.state::<Desktop>();
    let mut model = desktop.model.lock().unwrap();
    model.authorize(window.label(), &key)?;
    if let Some(project) = model
        .projects
        .get_mut(&key)
        .filter(|p| p.open_file_id.as_deref() == Some(&request))
    {
        project.open_file = None;
        project.open_file_id = None;
        model.save(&desktop.directory)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn desktop_connection(
    app: AppHandle,
    window: WebviewWindow,
    key: String,
    restart: Option<bool>,
) -> Result<Value, String> {
    let project = authorized(&app, &window, &key)?;
    tauri::async_runtime::spawn_blocking(move || {
        let desktop = app.state::<Desktop>();
        let mut runtimes = desktop.runtimes.lock().unwrap();
        desktop.model.lock().unwrap().authorize(window.label(), &key)?;
        if restart != Some(true) {
            if let Some(record) = runtimes.get(&key).filter(|r| r.process.alive.load(Ordering::SeqCst)) {
                return Ok(json!({"url":format!("http://127.0.0.1:{}", record.process.port), "token":record.token, "key":key}));
            }
        }
        let token = if let Some(record) = runtimes.remove(&key) { record.process.stop(); record.token } else { format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple()) };
        let resource = app.path().resource_dir().map_err(|_| "Application resources are unavailable")?.join("runtime");
        let resource = if cfg!(debug_assertions) && !resource.join("bin/node").is_file() { PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/runtime") } else { resource };
        let data = desktop.directory.join("projects").join(&key).join("runtime");
        let git = {
            let model = desktop.model.lock().unwrap();
            environment::executable("git", model.configured_tool("git").as_deref(), &desktop.environment).map(|p| p.display().to_string())
        };
        let event_app = app.clone(); let event_key = key.clone();
        let progress_app = app.clone(); let progress_key = key.clone();
        let process = OwnedRuntime::launch(&resource.join("bin/node"), &resource.join("desktop.js"), Launch {
            version: 1, r#type: "launch", root: &project.path, data_dir: &data.to_string_lossy(), workspace_key: &key, token: &token,
            rg_path: &resource.join("bin/rg").to_string_lossy(), git_path: git.as_deref(), development: cfg!(debug_assertions) && !cfg!(feature = "custom-protocol"),
        }, &desktop.environment, move || { let _ = event_app.emit("desktop-runtime-failed", json!({"key":event_key})); }, move |message| { let _ = progress_app.emit("desktop-remote-progress", json!({"key":progress_key,"message":message})); })?;
        // Ownership can change while the runtime starts. Never return credentials to a former owner.
        desktop.model.lock().unwrap().authorize(window.label(), &key)?;
        let result = json!({"url":format!("http://127.0.0.1:{}", process.port), "token":token, "key":key, "openFile":process.open_file});
        runtimes.insert(key, RuntimeRecord { token, process });
        Ok(result)
    }).await.map_err(|_| "Runtime supervisor failed")?
}

#[tauri::command]
pub fn desktop_move_project(
    app: AppHandle,
    window: WebviewWindow,
    key: String,
) -> Result<(), String> {
    authorized(&app, &window, &key)?;
    let desktop = app.state::<Desktop>();
    if desktop.closing.lock().unwrap().is_some() {
        return Err("Finish or cancel closing first".into());
    }
    let target = format!("project-{}", uuid::Uuid::new_v4());
    crate::create_window(&app, &target)?;
    {
        let mut runtimes = desktop.runtimes.lock().unwrap();
        let mut model = desktop.model.lock().unwrap();
        model.authorize(window.label(), &key)?;
        if let Some(record) = runtimes.get_mut(&key) {
            let token = format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            );
            record.process.rotate(&token)?;
            record.token = token;
        }
        model.transfer(&key, window.label(), &target)?;
        model.save(&desktop.directory)?;
    }
    changed(&app);
    Ok(())
}

#[tauri::command]
pub fn desktop_storage_get(
    app: AppHandle,
    window: WebviewWindow,
    project: String,
    key: String,
) -> Result<Option<Value>, String> {
    authorized(&app, &window, &project)?;
    let desktop = app.state::<Desktop>();
    if key == "profile-settings" {
        return Ok(Some(desktop.model.lock().unwrap().profile.clone()));
    }
    let mut storage = desktop.storage.lock().unwrap();
    let model_guard = desktop.model.lock().unwrap();
    model_guard.authorize(window.label(), &project)?;
    if !storage.contains_key(&project) {
        let data = match fs::read(model::ui_path(&desktop.directory, &project)) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| {
                "Project recovery data is unreadable; preserve ui.json before resetting it"
            })?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
            Err(_) => return Err("Project recovery data could not be read".into()),
        };
        storage.insert(project.clone(), data);
    }
    Ok(storage[&project].get(&key).cloned())
}

#[tauri::command]
pub fn desktop_storage_set(
    app: AppHandle,
    window: WebviewWindow,
    project: String,
    key: String,
    value: Option<Value>,
) -> Result<(), String> {
    if key == "profile-settings" {
        return Err("Use serialized user setting patches".into());
    }
    if key.len() > 4096 {
        return Err("Storage key is too large".into());
    }
    desktop_storage_get(app.clone(), window.clone(), project.clone(), key.clone())?;
    let desktop = app.state::<Desktop>();
    let mut storage = desktop.storage.lock().unwrap();
    let model_guard = desktop.model.lock().unwrap();
    model_guard.authorize(window.label(), &project)?;
    let entries = storage
        .get_mut(&project)
        .ok_or("Project storage is unavailable")?;
    let mut next = entries.clone();
    if let Some(value) = value {
        next.insert(key, value);
    } else {
        next.remove(&key);
    }
    if serde_json::to_vec(&next)
        .map_err(|_| "Invalid recovery data")?
        .len()
        > 64 * 1024 * 1024
    {
        return Err(
            "Project recovery data exceeds 64 MiB. Save large documents before closing.".into(),
        );
    }
    model::atomic_json(&model::ui_path(&desktop.directory, &project), &next)?;
    *entries = next;
    Ok(())
}

#[tauri::command]
pub fn desktop_settings_patch(
    app: AppHandle,
    window: WebviewWindow,
    changes: Vec<SettingChange>,
) -> Result<Value, String> {
    local(&window)?;
    let desktop = app.state::<Desktop>();
    let mut model = desktop.model.lock().unwrap();
    let mut profile = model.profile.clone();
    model::patch_profile(&mut profile, changes)?;
    let previous = std::mem::replace(&mut model.profile, profile.clone());
    if let Err(error) = model.save(&desktop.directory) {
        model.profile = previous;
        return Err(error);
    }
    drop(model);
    let _ = app.emit("desktop-settings-changed", &profile);
    Ok(profile)
}

#[tauri::command]
pub async fn desktop_tools(
    app: AppHandle,
    window: WebviewWindow,
    check_auth: bool,
) -> Result<Value, String> {
    local(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let desktop = app.state::<Desktop>();
        let (git, gh) = {
            let model = desktop.model.lock().unwrap();
            (model.configured_tool("git"), model.configured_tool("gh"))
        };
        json!([
            environment::diagnose("git", git.as_deref(), &desktop.environment, false),
            environment::diagnose("gh", gh.as_deref(), &desktop.environment, check_auth)
        ])
    })
    .await
    .map_err(|_| "Developer tool diagnostics failed".into())
}

pub fn external(app: &AppHandle, url: &tauri::Url) -> Result<(), String> {
    if !["http", "https", "mailto"].contains(&url.scheme()) {
        return Err("This URL scheme cannot be opened externally".into());
    }
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|_| "Could not open the system browser".into())
}
#[tauri::command]
pub fn desktop_open_external(
    app: AppHandle,
    window: WebviewWindow,
    url: String,
) -> Result<(), String> {
    local(&window)?;
    external(&app, &tauri::Url::parse(&url).map_err(|_| "Invalid URL")?)
}
#[tauri::command]
pub fn desktop_clipboard(
    app: AppHandle,
    window: WebviewWindow,
    text: Option<String>,
) -> Result<String, String> {
    local(&window)?;
    if let Some(text) = text {
        app.clipboard()
            .write_text(text)
            .map_err(|_| "Clipboard write failed")?;
        Ok(String::new())
    } else {
        app.clipboard()
            .read_text()
            .map_err(|_| "Clipboard read failed".into())
    }
}
#[tauri::command]
pub fn desktop_reveal(
    app: AppHandle,
    window: WebviewWindow,
    key: String,
    relative: String,
) -> Result<(), String> {
    let project = authorized(&app, &window, &key)?;
    if project.path.starts_with("ssh://") {
        return Err("Remote files are available in the Oxbit explorer".into());
    }
    let root = Path::new(&project.path);
    let target = fs::canonicalize(root.join(relative)).map_err(|_| "File is unavailable")?;
    if !target.starts_with(root) {
        return Err("File leaves the selected project".into());
    }
    app.opener()
        .reveal_item_in_dir(target)
        .map_err(|_| "File manager could not be opened".into())
}
#[tauri::command]
pub async fn desktop_archive(
    app: AppHandle,
    window: WebviewWindow,
    key: String,
    contents: Option<String>,
) -> Result<Option<String>, String> {
    authorized(&app, &window, &key)?;
    tauri::async_runtime::spawn_blocking(move || {
        let dialog = app.dialog().file().add_filter("Oxbit workspace", &["json"]);
        if let Some(contents) = contents {
            if contents.len() > 32 * 1024 * 1024 {
                return Err("Workspace export exceeds 32 MiB".into());
            }
            if let Some(path) = dialog
                .set_file_name("oxbit-workspace.json")
                .blocking_save_file()
                .and_then(|p| p.into_path().ok())
            {
                let value: Value =
                    serde_json::from_str(&contents).map_err(|_| "Invalid archive")?;
                model::atomic_json(&path, &value)?;
            }
            Ok(None)
        } else if let Some(path) = dialog.blocking_pick_file().and_then(|p| p.into_path().ok()) {
            if fs::metadata(&path)
                .map_err(|_| "Archive is unavailable")?
                .len()
                > 32 * 1024 * 1024
            {
                return Err("Workspace import exceeds 32 MiB".into());
            }
            fs::read_to_string(path)
                .map(Some)
                .map_err(|_| "Could not read the selected archive".into())
        } else {
            Ok(None)
        }
    })
    .await
    .map_err(|_| "Archive dialog failed")?
}

#[cfg(feature = "native-test")]
#[tauri::command]
pub fn desktop_test_crash(
    app: AppHandle,
    window: WebviewWindow,
    key: String,
) -> Result<(), String> {
    authorized(&app, &window, &key)?;
    if let Some(record) = app.state::<Desktop>().runtimes.lock().unwrap().get(&key) {
        record.process.crash_for_test();
    }
    Ok(())
}

#[cfg(test)]
mod remote_tests {
    use super::*;
    #[test]
    fn remote_locations_reject_passwords_and_non_ssh_schemes() {
        assert!(validate_remote("ssh://user@dev:2222/~/my%20project").is_ok());
        for uri in [
            "https://dev/path",
            "ssh://user:secret@dev/path",
            "ssh://dev/path?x",
            "ssh://dev/path#x",
            "ssh://dev:0/path",
        ] {
            assert!(validate_remote(uri).is_err(), "{uri}");
        }
    }
}
