#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#[cfg(all(feature = "native-test", not(debug_assertions)))]
compile_error!("Native test access must never be compiled into release builds");
mod closing;
mod commands;
mod environment;
mod icon_packs;
mod model;
#[cfg(all(feature = "native-test", target_os = "macos"))]
mod panel_test_delegate;
mod supervisor;
mod updates;

use commands::Desktop;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
};

fn application_url(url: &tauri::Url) -> bool {
    url.scheme() == "tauri" && url.host_str() == Some("localhost")
        || cfg!(debug_assertions)
            && !cfg!(feature = "custom-protocol")
            && url.scheme() == "http"
            && matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
            && url.port() == Some(9280)
}

#[tauri::command]
fn desktop_close_panel(
    app: AppHandle,
    window: tauri::WebviewWindow,
    id: String,
) -> Result<(), String> {
    if !app
        .state::<Desktop>()
        .model
        .lock()
        .unwrap()
        .windows
        .contains_key(window.label())
        || !id.starts_with("panel-")
        || id.len() >= 80
        || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err("Invalid panel owner or window identifier".into());
    }
    let prefix = format!("{}-{id}-", window.label());
    for (label, child) in app.webview_windows() {
        if label.starts_with(&prefix) {
            child.destroy().map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn configure_text_input(configuration: &objc2_web_kit::WKWebViewConfiguration) {
    unsafe {
        configuration.setAllowsInlinePredictions(false);
        // This public macOS 15 API is absent from objc2-web-kit 0.3.2's bindings.
        let _: () = objc2::msg_send![configuration,
            setWritingToolsBehavior: objc2_app_kit::NSWritingToolsBehavior::None
        ];
    }
}

fn create_window(app: &AppHandle, label: &str) -> Result<(), String> {
    if app.get_webview_window(label).is_some() {
        return Ok(());
    }
    let app_nav = app.clone();
    let app_new = app.clone();
    let panel_owner = label.to_owned();
    let reload_app = app.clone();
    let child_prefix = format!("{label}-panel-");
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title("Oxbit")
        .inner_size(1380.0, 900.0)
        .min_inner_size(720.0, 480.0)
        .on_page_load(move |_, payload| {
            // A reloaded owner gets a fresh JS session. Retire any old related
            // documents before the saved panel layout opens its replacements.
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                for (label, child) in reload_app.webview_windows() {
                    if label.starts_with(&child_prefix) {
                        let _ = child.destroy();
                    }
                }
            }
        })
        .on_navigation(move |url| {
            if application_url(url) || (url.scheme() == "about" && url.path() == "blank") {
                true
            } else {
                let _ = commands::external(&app_nav, url);
                false
            }
        })
        .on_new_window(move |url, features| {
            // Only this inert same-origin shell may retain an opener. It does not
            // bootstrap another project or receive native command capabilities.
            if url.scheme() == "about"
                && url.path() == "blank"
                && url
                    .fragment()
                    .is_some_and(|f| f.starts_with("oxbit-panel="))
            {
                let id = url
                    .fragment()
                    .and_then(|f| f.strip_prefix("oxbit-panel="))
                    .map(str::to_owned);
                if let Some(id) = id.filter(|id| {
                    id.starts_with("panel-")
                        && id.len() < 80
                        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
                }) {
                    let panel_label =
                        format!("{}-{}-{}", panel_owner, id, uuid::Uuid::new_v4().simple());
                    let owner = panel_owner.clone();
                    let nav_app = app_new.clone();
                    let link_app = app_new.clone();
                    #[cfg(target_os = "macos")]
                    configure_text_input(&features.opener().target_configuration);
                    let builder = WebviewWindowBuilder::new(
                        &app_new,
                        &panel_label,
                        WebviewUrl::External("about:blank".parse().unwrap()),
                    )
                    .window_features(features)
                    .title("Oxbit — Panels")
                    .min_inner_size(320.0, 240.0)
                    .disable_drag_drop_handler()
                    .on_navigation(move |target| {
                        if target.scheme() == "about" && target.path() == "blank" {
                            true
                        } else {
                            let _ = commands::external(&link_app, target);
                            false
                        }
                    })
                    .on_new_window(move |target, _| {
                        let _ = commands::external(&nav_app, &target);
                        tauri::webview::NewWindowResponse::Deny
                    });
                    let panel = match builder.build() {
                        Ok(panel) => panel,
                        Err(error) => {
                            let _ = app_new.emit_to(
                                &owner,
                                "desktop-error",
                                format!("Could not open floating panel: {error}"),
                            );
                            return tauri::webview::NewWindowResponse::Deny;
                        }
                    };
                    {
                        if let (Ok(position), Ok(scale)) =
                            (panel.outer_position(), panel.scale_factor())
                        {
                            let pos = position.to_logical::<i32>(scale);
                            let visible = app_new
                                .available_monitors()
                                .unwrap_or_default()
                                .iter()
                                .any(|m| {
                                    let origin = m.position().to_logical::<i32>(m.scale_factor());
                                    let size = m.size().to_logical::<u32>(m.scale_factor());
                                    pos.x >= origin.x
                                        && pos.y >= origin.y
                                        && pos.x < origin.x + size.width as i32 - 80
                                        && pos.y < origin.y + size.height as i32 - 80
                                });
                            if !visible {
                                let _ = panel.center();
                            }
                        }
                        if let Some(parent) = app_new.get_webview_window(&owner) {
                            let child = panel.clone();
                            parent.on_window_event(move |event| {
                                if matches!(event, tauri::WindowEvent::Destroyed) {
                                    let _ = child.destroy();
                                }
                            });
                        }
                        return tauri::webview::NewWindowResponse::Create { window: panel };
                    }
                }
                return tauri::webview::NewWindowResponse::Deny;
            }
            let _ = commands::external(&app_new, &url);
            tauri::webview::NewWindowResponse::Deny
        });
    let geometry = app
        .state::<Desktop>()
        .model
        .lock()
        .unwrap()
        .windows
        .get(label)
        .and_then(|w| w.geometry.clone());
    if let Some(g) = geometry {
        builder = builder.inner_size(
            g.width.clamp(720, 3840) as f64,
            g.height.clamp(480, 2160) as f64,
        );
        let visible = app
            .available_monitors()
            .unwrap_or_default()
            .iter()
            .any(|m| {
                let pos = m.position().to_logical::<i32>(m.scale_factor());
                let size = m.size().to_logical::<u32>(m.scale_factor());
                g.x >= pos.x
                    && g.y >= pos.y
                    && g.x < pos.x + size.width as i32 - 80
                    && g.y < pos.y + size.height as i32 - 80
            });
        if visible {
            builder = builder.position(g.x as f64, g.y as f64);
        } else {
            builder = builder.center();
        }
    }
    #[cfg(target_os = "macos")]
    let builder = {
        let main_thread =
            objc2::MainThreadMarker::new().ok_or("Webviews must be created on the main thread")?;
        let configuration = unsafe { objc2_web_kit::WKWebViewConfiguration::new(main_thread) };
        configure_text_input(&configuration);
        builder.with_webview_configuration(configuration)
    };
    let window = builder
        .build()
        .map_err(|e| format!("Could not create an Oxbit window: {e}"))?;
    #[cfg(target_os = "macos")]
    window
        .with_webview(|view| unsafe {
            // A saved layout must be able to reopen its related windows without a
            // fresh input gesture. The navigation/new-window callbacks still restrict URLs.
            let webview = &*(view.inner() as *const objc2_web_kit::WKWebView);
            webview
                .configuration()
                .preferences()
                .setJavaScriptCanOpenWindowsAutomatically(true);
        })
        .map_err(|error| error.to_string())?;
    {
        let desktop = app.state::<Desktop>();
        let mut model = desktop.model.lock().unwrap();
        model.windows.entry(label.into()).or_default();
        model.save(&desktop.directory)?;
    }
    let drop_app = app.clone();
    let drop_label = label.to_owned();
    window.on_webview_event(move |event| {
        if let tauri::WebviewEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
            for path in paths {
                if let Err(error) = commands::open_path(&drop_app, &drop_label, path, false) {
                    let _ = drop_app.emit_to(&drop_label, "desktop-error", error);
                }
            }
        }
    });
    let event_app = app.clone();
    let event_label = label.to_owned();
    window.on_window_event(move |event| {
        let desktop = event_app.state::<Desktop>();
        match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                if !desktop.exiting.load(Ordering::SeqCst)
                    && !desktop.destroying.lock().unwrap().contains(&event_label)
                {
                    api.prevent_close();
                    let _ = closing::begin(&event_app, &event_label, "window", None);
                }
            }
            tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                if let Some(window) = event_app.get_webview_window(&event_label) {
                    if let (Ok(position), Ok(size), Ok(scale)) = (
                        window.outer_position(),
                        window.inner_size(),
                        window.scale_factor(),
                    ) {
                        let position = position.to_logical::<i32>(scale);
                        let size = size.to_logical::<u32>(scale);
                        let mut model = desktop.model.lock().unwrap();
                        if let Some(state) = model.windows.get_mut(&event_label) {
                            state.geometry = Some(model::Geometry {
                                x: position.x,
                                y: position.y,
                                width: size.width,
                                height: size.height,
                            });
                            let _ = model.save(&desktop.directory);
                        }
                    }
                }
            }
            _ => {}
        }
    });
    Ok(())
}

fn focused_label(app: &AppHandle) -> String {
    app.webview_windows()
        .values()
        .find(|w| w.is_focused().unwrap_or(false))
        .map(|w| {
            w.label()
                .split("-panel-")
                .next()
                .unwrap_or(w.label())
                .to_owned()
        })
        .unwrap_or_else(|| "main".into())
}

fn menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let item = |id: &str, title: &str, accelerator: Option<&str>| {
        MenuItem::with_id(app, id, title, true, accelerator)
    };
    let app_menu = Submenu::with_items(
        app,
        "Oxbit",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("About Oxbit"), None)?,
            &item("desktop:updates", "Check for Updates…", None)?,
            &item("desktop:tools", "Developer Tools…", None)?,
            &PredefinedMenuItem::separator(app)?,
            &item("desktop:quit", "Quit Oxbit", Some("CmdOrCtrl+Q"))?,
        ],
    )?;
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &item("desktop:open", "Open Folder…", Some("CmdOrCtrl+O"))?,
            &item("desktop:remote", "Connect over SSH…", None)?,
            &item("desktop:open-file", "Open File…", Some("CmdOrCtrl+Shift+O"))?,
            &item("desktop:open-new", "Open in New Window…", None)?,
            &item("desktop:move", "Move Project to New Window", None)?,
            &PredefinedMenuItem::separator(app)?,
            &item("file.save", "Save", Some("CmdOrCtrl+S"))?,
            &item("file.saveAll", "Save All", Some("CmdOrCtrl+Shift+S"))?,
            &item("desktop:close-project", "Close Project", None)?,
            &item(
                "desktop:close-window",
                "Close Window",
                Some("CmdOrCtrl+Shift+W"),
            )?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &file, &edit])
}

fn open_arguments(app: &AppHandle, arguments: Vec<String>, cwd: &str) {
    let label = focused_label(app);
    let mut opened = false;
    for argument in arguments
        .into_iter()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
    {
        let path = Path::new(cwd).join(argument);
        match commands::open_path(app, &label, &path, false) {
            Ok(_) => opened = true,
            Err(message) => {
                let _ = app.emit("desktop-error", message);
            }
        }
    }
    if !opened {
        let _ = create_window(app, &label);
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.set_focus();
        }
    }
}

fn main() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            open_arguments(app, argv, &cwd)
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_updater::Builder::new()
                .pubkey(option_env!("OXBIT_UPDATER_PUBLIC_KEY").unwrap_or(""))
                .build(),
        );
    #[cfg(all(feature = "native-test", target_os = "macos"))]
    let builder = builder.plugin(panel_test_delegate::hook(false));
    #[cfg(feature = "native-test")]
    let builder = builder
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_wdio_webdriver::init());
    #[cfg(all(feature = "native-test", target_os = "macos"))]
    let builder = builder.plugin(panel_test_delegate::hook(true));
    let app = builder
        .invoke_handler(tauri::generate_handler![
            desktop_close_panel,
            #[cfg(feature = "native-test")]
            commands::desktop_test_crash,
            commands::desktop_snapshot,
            commands::desktop_open_project,
            commands::desktop_open_remote,
            commands::desktop_activate,
            commands::desktop_file_opened,
            commands::desktop_connection,
            commands::desktop_move_project,
            icon_packs::desktop_icon_packs_read,
            icon_packs::desktop_icon_packs_mutate,
            commands::desktop_storage_get,
            commands::desktop_storage_set,
            commands::desktop_settings_patch,
            commands::desktop_tools,
            commands::desktop_open_external,
            commands::desktop_clipboard,
            commands::desktop_reveal,
            commands::desktop_archive,
            closing::desktop_request_close,
            closing::desktop_close_vote,
            closing::desktop_close_finished,
            updates::desktop_check_update,
            updates::desktop_download_update,
        ])
        .setup(|app| {
            let directory = app.path().app_data_dir()?;
            #[cfg(feature = "native-test")]
            let directory = std::env::var_os("OXBIT_DESKTOP_TEST_DATA")
                .map(PathBuf::from)
                .unwrap_or(directory);
            let model = model::Model::load(&directory.join("session.json"))?;
            app.manage(Desktop {
                directory,
                model: Mutex::new(model),
                runtimes: Mutex::new(BTreeMap::new()),
                storage: Mutex::new(BTreeMap::new()),
                environment: environment::login_environment(),
                closing: Mutex::new(None),
                exiting: AtomicBool::new(false),
                destroying: Mutex::new(Vec::new()),
                update: Mutex::new(None),
            });
            app.set_menu(menu(app.handle())?)?;
            app.on_menu_event(|app, event| {
                let id = event.id().as_ref();
                if id == "desktop:close-window" {
                    if let Some(panel) = app.webview_windows().values().find(|window| {
                        window.label().contains("-panel-") && window.is_focused().unwrap_or(false)
                    }) {
                        let _ = panel.close();
                        return;
                    }
                }
                let label = focused_label(app);
                if id == "desktop:quit" {
                    let _ = closing::begin(app, &label, "quit", None);
                } else {
                    let _ = app.emit_to(label, "desktop-menu", id);
                }
            });
            let labels: Vec<String> = app
                .state::<Desktop>()
                .model
                .lock()
                .unwrap()
                .windows
                .keys()
                .cloned()
                .collect();
            if labels.is_empty() {
                create_window(app.handle(), "main")?;
            } else {
                for label in labels {
                    create_window(app.handle(), &label)?;
                }
            }
            let args: Vec<String> = std::env::args().collect();
            if args.len() > 1 {
                open_arguments(
                    app.handle(),
                    args,
                    &std::env::current_dir()
                        .unwrap_or_else(|_| PathBuf::from("/"))
                        .to_string_lossy(),
                );
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Oxbit desktop failed to initialize");
    app.run(|app, event| match event {
        tauri::RunEvent::ExitRequested { api, code, .. } => {
            if !app.state::<Desktop>().exiting.load(Ordering::SeqCst) {
                api.prevent_exit();
                if code.is_some() || cfg!(target_os = "linux") {
                    let _ = closing::begin(app, &focused_label(app), "quit", None);
                }
            }
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            let _ = create_window(app, "main");
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Opened { urls } => {
            for url in urls {
                if let Ok(path) = url.to_file_path() {
                    let _ = commands::open_path(app, &focused_label(app), &path, false);
                }
            }
        }
        tauri::RunEvent::Exit => {
            for record in app.state::<Desktop>().runtimes.lock().unwrap().values() {
                record.process.stop();
            }
        }
        _ => {}
    });
}
