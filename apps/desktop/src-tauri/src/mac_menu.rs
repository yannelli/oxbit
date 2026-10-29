use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Wry,
};

const CATALOG: &str = include_str!("../../../../packages/workbench/src/catalog.json");

/// Catalog ids whose action already has a native item in this menu.
const NATIVE_EQUIVALENTS: &[&str] = &[
    "workspace.open",
    "workspace.close",
    "file.save",
    "file.saveAll",
    "editor.selectAll",
    "help.about",
];

#[derive(Deserialize)]
struct Catalog {
    commands: Vec<Command>,
    menus: HashMap<String, Vec<String>>,
}

#[derive(Deserialize)]
struct Command {
    id: String,
    title: String,
    mac: Option<String>,
    when: Option<String>,
}

/// Converts a catalog macOS binding such as `⇧⌘P` into a menu accelerator.
/// Chords and bindings without ⌘ or ⌃ return `None`.
fn accelerator(binding: &str) -> Option<String> {
    if binding.contains(' ') {
        return None;
    }
    let mut parts = Vec::new();
    let mut key = String::new();
    for glyph in binding.chars() {
        match glyph {
            '⌃' => parts.push("Ctrl"),
            '⌥' => parts.push("Alt"),
            '⇧' => parts.push("Shift"),
            '⌘' => parts.push("CmdOrCtrl"),
            _ => key.push(glyph),
        }
    }
    if key.is_empty()
        || !parts
            .iter()
            .any(|part| matches!(*part, "Ctrl" | "CmdOrCtrl"))
    {
        return None;
    }
    parts.push(&key);
    Some(parts.join("+"))
}

/// Orders modifiers so equal accelerators compare equal.
fn normalized(accelerator: &str) -> String {
    let mut parts: Vec<&str> = accelerator.split('+').collect();
    let key = parts.pop();
    parts.sort_unstable();
    parts.extend(key);
    parts.join("+")
}

struct Builder<'a> {
    app: &'a AppHandle,
    commands: HashMap<&'a str, &'a Command>,
    menus: &'a HashMap<String, Vec<String>>,
    taken: HashSet<String>,
}

impl<'a> Builder<'a> {
    fn item(
        &mut self,
        id: &str,
        title: &str,
        accelerator: Option<&str>,
    ) -> tauri::Result<MenuItem<Wry>> {
        if let Some(accelerator) = accelerator {
            self.taken.insert(normalized(accelerator));
        }
        MenuItem::with_id(self.app, id, title, true, accelerator)
    }

    /// The webview binds keys for commands with a `when` clause only in that context,
    /// so those keys stay with the webview and the item shows no accelerator.
    fn command_accelerator(&self, command: &Command) -> Option<String> {
        command
            .when
            .is_none()
            .then(|| command.mac.as_deref().and_then(accelerator))
            .flatten()
            .filter(|accelerator| !self.taken.contains(&normalized(accelerator)))
    }

    fn command(&mut self, id: &str, title: Option<&str>) -> tauri::Result<Option<MenuItem<Wry>>> {
        let Some(command) = self.commands.get(id).copied() else {
            return Ok(None);
        };
        let accelerator = self.command_accelerator(command);
        self.item(id, title.unwrap_or(&command.title), accelerator.as_deref())
            .map(Some)
    }

    /// Appends a catalog menu's items, skipping native equivalents and redundant separators.
    fn append_catalog(&mut self, submenu: &Submenu<Wry>, name: &str) -> tauri::Result<()> {
        let menus = self.menus;
        let mut separator = !submenu.items()?.is_empty();
        for id in menus.get(name).into_iter().flatten() {
            if id == "-" {
                separator = true;
                continue;
            }
            if NATIVE_EQUIVALENTS.contains(&id.as_str()) {
                continue;
            }
            let Some(item) = self.command(id, None)? else {
                continue;
            };
            if separator && !submenu.items()?.is_empty() {
                submenu.append(&PredefinedMenuItem::separator(self.app)?)?;
            }
            separator = false;
            submenu.append(&item)?;
        }
        Ok(())
    }

    fn catalog_menu(&mut self, name: &str) -> tauri::Result<Submenu<Wry>> {
        let submenu = Submenu::new(self.app, name, true)?;
        self.append_catalog(&submenu, name)?;
        Ok(submenu)
    }
}

pub fn menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let catalog: Catalog = serde_json::from_str(CATALOG)?;
    let mut builder = Builder {
        app,
        commands: catalog
            .commands
            .iter()
            .map(|command| (command.id.as_str(), command))
            .collect(),
        menus: &catalog.menus,
        taken: HashSet::new(),
    };
    let separator = || PredefinedMenuItem::separator(app);
    for reserved in [
        "CmdOrCtrl+H",
        "Alt+CmdOrCtrl+H",
        "CmdOrCtrl+M",
        "CmdOrCtrl+Z",
        "Shift+CmdOrCtrl+Z",
        "CmdOrCtrl+X",
        "CmdOrCtrl+C",
        "CmdOrCtrl+V",
        "CmdOrCtrl+A",
    ] {
        builder.taken.insert(normalized(reserved));
    }

    let app_menu = Submenu::with_items(
        app,
        "Oxbit",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("About Oxbit"), None)?,
            &builder.item("desktop:updates", "Check for Updates…", None)?,
            &separator()?,
        ],
    )?;
    if let Some(settings) = builder.command("settings.open", Some("Settings…"))? {
        app_menu.append(&settings)?;
    }
    app_menu.append_items(&[
        &builder.item("desktop:tools", "Developer Tools…", None)?,
        &separator()?,
        &PredefinedMenuItem::services(app, None)?,
        &separator()?,
        &PredefinedMenuItem::hide(app, Some("Hide Oxbit"))?,
        &PredefinedMenuItem::hide_others(app, None)?,
        &PredefinedMenuItem::show_all(app, None)?,
        &separator()?,
        &builder.item("desktop:quit", "Quit Oxbit", Some("CmdOrCtrl+Q"))?,
    ])?;

    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &builder.item("desktop:open", "Open Folder…", Some("CmdOrCtrl+O"))?,
            &builder.item("desktop:remote", "Connect over SSH…", None)?,
            &builder.item("desktop:open-file", "Open File…", Some("CmdOrCtrl+Shift+O"))?,
            &builder.item("desktop:open-new", "Open in New Window…", None)?,
            &builder.item("desktop:move", "Move Project to New Window", None)?,
        ],
    )?;
    let file_end = [
        builder.item("file.save", "Save", Some("CmdOrCtrl+S"))?,
        builder.item("file.saveAll", "Save All", Some("CmdOrCtrl+Shift+S"))?,
        builder.item("desktop:close-project", "Close Project", None)?,
        builder.item(
            "desktop:close-window",
            "Close Window",
            Some("CmdOrCtrl+Shift+W"),
        )?,
    ];
    builder.append_catalog(&file, "File")?;
    file.append(&separator()?)?;
    for item in &file_end {
        file.append(item)?;
    }

    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &separator()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    builder.append_catalog(&edit, "Edit")?;

    let view = builder.catalog_menu("View")?;
    let go = builder.catalog_menu("Go")?;
    let terminal = builder.catalog_menu("Terminal")?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, Some("Zoom"))?,
            &separator()?,
            &PredefinedMenuItem::bring_all_to_front(app, None)?,
        ],
    )?;
    window.set_as_windows_menu_for_nsapp()?;
    let help = builder.catalog_menu("Help")?;
    help.set_as_help_menu_for_nsapp()?;

    Menu::with_items(
        app,
        &[
            &app_menu, &file, &edit, &view, &go, &terminal, &window, &help,
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::{accelerator, normalized, Catalog, CATALOG, NATIVE_EQUIVALENTS};

    #[test]
    fn converts_catalog_bindings() {
        assert_eq!(accelerator("⇧⌘P").as_deref(), Some("Shift+CmdOrCtrl+P"));
        assert_eq!(accelerator("⌃⇧`").as_deref(), Some("Ctrl+Shift+`"));
        assert_eq!(accelerator("⌘\\").as_deref(), Some("CmdOrCtrl+\\"));
        assert_eq!(accelerator("⌘K ⌘T"), None);
        assert_eq!(accelerator("⌥Z"), None);
        assert_eq!(accelerator("F12"), None);
        assert_eq!(
            normalized("Shift+CmdOrCtrl+O"),
            normalized("CmdOrCtrl+Shift+O")
        );
    }

    #[test]
    fn catalog_menus_resolve_to_valid_items() {
        let catalog: Catalog = serde_json::from_str(CATALOG).unwrap();
        for name in ["File", "Edit", "View", "Go", "Terminal", "Help"] {
            let ids = &catalog.menus[name];
            for id in ids.iter().filter(|id| *id != "-") {
                let command = catalog.commands.iter().find(|command| &command.id == id);
                let command =
                    command.unwrap_or_else(|| panic!("{name} menu lists unknown command {id}"));
                if let Some(value) = command.mac.as_deref().and_then(accelerator) {
                    let key = value.rsplit('+').next().unwrap();
                    assert!(
                        key.chars().count() == 1 || key.starts_with('F'),
                        "{id} has an unsupported key in {value}"
                    );
                }
            }
        }
        for id in NATIVE_EQUIVALENTS {
            assert!(
                catalog.commands.iter().any(|command| command.id == *id),
                "{id}"
            );
        }
        assert!(catalog
            .commands
            .iter()
            .any(|command| command.id == "settings.open"));
    }
}
