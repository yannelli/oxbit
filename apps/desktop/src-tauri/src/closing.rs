use crate::commands::{self, Desktop};
use serde_json::json;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::atomic::Ordering,
};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

#[derive(Clone)]
pub struct Transaction {
    pub id: String,
    pub kind: String,
    pub targets: BTreeMap<String, Vec<String>>,
    pub waiting: BTreeSet<String>,
    pub committing: bool,
}

pub fn begin(app: &AppHandle, window: &str, kind: &str, key: Option<&str>) -> Result<(), String> {
    if !["project", "window", "quit", "update"].contains(&kind) {
        return Err("Invalid close operation".into());
    }
    let desktop = app.state::<Desktop>();
    let mut closing = desktop.closing.lock().unwrap();
    if closing.is_some() {
        return Err("A close request is already in progress".into());
    }
    if kind == "update" && desktop.update.lock().unwrap().is_none() {
        return Err("Download and verify the update first".into());
    }
    let model = desktop.model.lock().unwrap();
    let targets: BTreeMap<String, Vec<String>> = if kind == "project" {
        let key = key.ok_or("Choose a project to close")?;
        model.authorize(window, key)?;
        BTreeMap::from([(window.into(), vec![key.into()])])
    } else if kind == "window" {
        BTreeMap::from([(
            window.into(),
            model
                .windows
                .get(window)
                .cloned()
                .unwrap_or_default()
                .projects,
        )])
    } else {
        app.webview_windows()
            .keys()
            .filter(|label| model.windows.contains_key(*label))
            .map(|label| {
                (
                    label.clone(),
                    model
                        .windows
                        .get(label)
                        .cloned()
                        .unwrap_or_default()
                        .projects,
                )
            })
            .collect()
    };
    drop(model);
    if targets.is_empty() {
        desktop.exiting.store(true, Ordering::SeqCst);
        app.exit(0);
        return Ok(());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let transaction = Transaction {
        id: id.clone(),
        kind: kind.into(),
        waiting: targets.keys().cloned().collect(),
        targets: targets.clone(),
        committing: false,
    };
    *closing = Some(transaction);
    drop(closing);
    for (label, keys) in targets {
        app.emit_to(
            &label,
            "desktop-prepare-close",
            json!({"id":id, "keys":keys, "reason":kind}),
        )
        .map_err(|_| "Could not ask window to prepare for closing")?;
    }
    Ok(())
}

#[tauri::command]
pub fn desktop_request_close(
    app: AppHandle,
    window: WebviewWindow,
    kind: String,
    key: Option<String>,
) -> Result<(), String> {
    commands::local(&window)?;
    begin(&app, window.label(), &kind, key.as_deref())
}

#[tauri::command]
pub fn desktop_close_vote(
    app: AppHandle,
    window: WebviewWindow,
    id: String,
    accepted: bool,
) -> Result<(), String> {
    commands::local(&window)?;
    let desktop = app.state::<Desktop>();
    let mut closing = desktop.closing.lock().unwrap();
    let transaction = closing
        .as_mut()
        .filter(|t| t.id == id && t.targets.contains_key(window.label()))
        .ok_or("Close request expired")?;
    if transaction.committing {
        return Err("Close is already being committed".into());
    }
    if !accepted {
        *closing = None;
        drop(closing);
        let _ = app.emit("desktop-close-cancelled", json!({"id":id}));
        return Ok(());
    }
    transaction.waiting.remove(window.label());
    if !transaction.waiting.is_empty() {
        return Ok(());
    }
    transaction.committing = true;
    transaction.waiting = transaction.targets.keys().cloned().collect();
    let targets = transaction.targets.clone();
    drop(closing);
    for (label, keys) in targets {
        let _ = app.emit_to(label, "desktop-commit-close", json!({"id":id, "keys":keys}));
    }
    Ok(())
}

#[tauri::command]
pub async fn desktop_close_finished(
    app: AppHandle,
    window: WebviewWindow,
    id: String,
    error: Option<String>,
) -> Result<(), String> {
    commands::local(&window)?;
    let desktop = app.state::<Desktop>();
    let transaction = {
        let mut closing = desktop.closing.lock().unwrap();
        let transaction = closing
            .as_mut()
            .filter(|t| t.id == id && t.committing && t.targets.contains_key(window.label()))
            .ok_or("Close request expired")?;
        if error.is_some() {
            *closing = None;
            drop(closing);
            let _ = app.emit("desktop-close-cancelled", json!({"id":id}));
            commands::changed(&app);
            return Err("Persistence failed. Sessions were retained; retry closing after resolving the error.".into());
        }
        transaction.waiting.remove(window.label());
        if !transaction.waiting.is_empty() {
            return Ok(());
        }
        transaction.clone()
    };
    tauri::async_runtime::spawn_blocking(move || {
        let result = finish(&app, transaction);
        *app.state::<Desktop>().closing.lock().unwrap() = None;
        if result.is_err() {
            let _ = app.emit("desktop-close-cancelled", ());
            commands::changed(&app);
        }
        result
    })
    .await
    .map_err(|_| "Shutdown failed")?
}

fn finish(app: &AppHandle, transaction: Transaction) -> Result<(), String> {
    let desktop = app.state::<Desktop>();
    let keys: Vec<_> = transaction.targets.values().flatten().cloned().collect();
    {
        let mut runtimes = desktop.runtimes.lock().unwrap();
        for key in &keys {
            if let Some(record) = runtimes.remove(key) {
                record.process.stop();
            }
        }
    }
    if transaction.kind == "update" {
        let (update, bytes) = desktop
            .update
            .lock()
            .unwrap()
            .take()
            .ok_or("Verified update is unavailable")?;
        if update.install(bytes).is_err() {
            let _ = app.emit("desktop-error", "Update installation failed. Reopen your projects and retry from a writable installation.");
            commands::changed(app);
            return Err("Update installation failed; recovery data was retained".into());
        }
        desktop.exiting.store(true, Ordering::SeqCst);
        app.restart();
    }
    if transaction.kind == "quit" {
        // Keep window/project metadata so the next launch can restore every draft and layout.
        desktop.model.lock().unwrap().save(&desktop.directory)?;
        desktop.exiting.store(true, Ordering::SeqCst);
        app.exit(0);
        return Ok(());
    }
    {
        let mut model = desktop.model.lock().unwrap();
        for key in &keys {
            model.remove(key);
        }
        if transaction.kind == "window" {
            for label in transaction.targets.keys() {
                model.windows.remove(label);
            }
        }
        model.save(&desktop.directory)?;
    }
    if transaction.kind == "window" {
        for label in transaction.targets.keys() {
            desktop.destroying.lock().unwrap().push(label.clone());
            if let Some(window) = app.get_webview_window(label) {
                let _ = window.destroy();
            }
        }
        if cfg!(target_os = "linux") && app.webview_windows().is_empty() {
            desktop.exiting.store(true, Ordering::SeqCst);
            app.exit(0);
        }
    }
    let _ = app.emit("desktop-close-completed", ());
    commands::changed(app);
    Ok(())
}
