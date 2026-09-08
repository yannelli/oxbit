use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub key: String,
    pub path: String,
    pub name: String,
    pub owner: String,
    #[serde(default)]
    pub missing: bool,
    #[serde(default)]
    pub open_file: Option<String>,
    #[serde(default)]
    pub open_file_id: Option<String>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowState {
    pub projects: Vec<String>,
    pub active: Option<String>,
    pub geometry: Option<Geometry>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Geometry {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Model {
    pub version: u8,
    pub windows: BTreeMap<String, WindowState>,
    pub projects: BTreeMap<String, Project>,
    pub recent: Vec<String>,
    pub profile: Value,
}
impl Default for Model {
    fn default() -> Self {
        Self {
            version: 1,
            windows: BTreeMap::new(),
            projects: BTreeMap::new(),
            recent: Vec::new(),
            profile: serde_json::json!({"user":{},"userLanguages":{}}),
        }
    }
}

pub fn atomic_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let parent = path.parent().ok_or("Invalid state path")?;
    fs::create_dir_all(parent).map_err(|_| "Cannot create application state directory")?;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let bytes = serde_json::to_vec(value).map_err(|_| "Cannot serialize application state")?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)
            .map_err(|_| "Cannot write application state")?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "Cannot flush application state")?;
        fs::rename(&temporary, path).map_err(|_| "Cannot replace application state")?;
        fs::File::open(parent)
            .and_then(|dir| dir.sync_all())
            .map_err(|_| "Cannot flush state directory")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

impl Model {
    pub fn load(path: &Path) -> Result<Self, String> {
        match fs::read(path) {
            Ok(bytes) => {
                let mut model: Self = serde_json::from_slice(&bytes).map_err(|_| "Desktop session state is unreadable. Preserve session.json and restore a backup.")?;
                if model.version != 1 {
                    return Err("Unsupported desktop session state version".into());
                }
                for project in model.projects.values_mut() {
                    project.missing =
                        !project.path.starts_with("ssh://") && !Path::new(&project.path).is_dir();
                }
                Ok(model)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(_) => Err("Desktop session state could not be read".into()),
        }
    }
    pub fn save(&self, directory: &Path) -> Result<(), String> {
        atomic_json(&directory.join("session.json"), self)
    }
    pub fn authorize(&self, window: &str, key: &str) -> Result<&Project, String> {
        self.projects
            .get(key)
            .filter(|p| p.owner == window)
            .ok_or_else(|| "This window does not own the project".into())
    }
    pub fn locate(path: &Path) -> Result<(String, String, Option<String>), String> {
        let path = fs::canonicalize(path).map_err(|_| {
            "Project path is unavailable. Reconnect its disk or select another folder."
        })?;
        let (directory, file) = if path.is_dir() {
            (path, None)
        } else {
            (
                path.parent()
                    .ok_or("File has no parent directory")?
                    .to_path_buf(),
                path.file_name().and_then(|p| p.to_str()).map(String::from),
            )
        };
        let root = directory
            .to_str()
            .ok_or("Project paths must use UTF-8")?
            .to_owned();
        let key = format!("{:x}", Sha256::digest(root.as_bytes()));
        Ok((key, root, file))
    }
    pub fn known_open_path(&self, path: &Path) -> bool {
        self.recent.iter().any(|p| Path::new(p) == path)
            || self
                .projects
                .values()
                .any(|p| Path::new(&p.path) == path || path.is_file() && path.starts_with(&p.path))
    }
    pub fn locate_open(&self, path: &Path) -> Result<(String, String, Option<String>), String> {
        let canonical = fs::canonicalize(path).map_err(|_| "Project path is unavailable")?;
        if canonical.is_file() {
            if let Some(project) = self
                .projects
                .values()
                .filter(|p| canonical.starts_with(&p.path))
                .max_by_key(|p| p.path.len())
            {
                let file = canonical
                    .strip_prefix(&project.path)
                    .map_err(|_| "File is outside project")?
                    .to_str()
                    .ok_or("File paths must use UTF-8")?
                    .to_owned();
                return Ok((project.key.clone(), project.path.clone(), Some(file)));
            }
        }
        Self::locate(&canonical)
    }
    pub fn add(
        &mut self,
        key: String,
        path: String,
        file: Option<String>,
        window: String,
    ) -> String {
        if let Some(project) = self.projects.get_mut(&key) {
            project.missing = false;
            if file.is_some() {
                project.open_file = file;
                project.open_file_id = Some(uuid::Uuid::new_v4().to_string());
            }
            let owner = project.owner.clone();
            self.windows.entry(owner.clone()).or_default().active = Some(key);
            return owner;
        }
        let name = Path::new(&path)
            .file_name()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.clone());
        self.projects.insert(
            key.clone(),
            Project {
                key: key.clone(),
                name,
                path: path.clone(),
                owner: window.clone(),
                missing: false,
                open_file_id: file.as_ref().map(|_| uuid::Uuid::new_v4().to_string()),
                open_file: file,
            },
        );
        let state = self.windows.entry(window.clone()).or_default();
        state.projects.push(key.clone());
        state.active = Some(key);
        self.recent.retain(|p| p != &path);
        self.recent.insert(0, path);
        self.recent.truncate(30);
        window
    }
    pub fn transfer(&mut self, key: &str, source: &str, target: &str) -> Result<(), String> {
        self.authorize(source, key)?;
        self.detach(key, source);
        self.projects
            .get_mut(key)
            .ok_or("Project disappeared")?
            .owner = target.into();
        let destination = self.windows.entry(target.into()).or_default();
        destination.projects.push(key.into());
        destination.active = Some(key.into());
        Ok(())
    }
    fn detach(&mut self, key: &str, window: &str) {
        if let Some(state) = self.windows.get_mut(window) {
            state.projects.retain(|p| p != key);
            if state.active.as_deref() == Some(key) {
                state.active = state.projects.last().cloned();
            }
        }
    }
    pub fn remove(&mut self, key: &str) {
        if let Some(project) = self.projects.remove(key) {
            self.detach(key, &project.owner);
        }
    }
    pub fn new_window_setting(&self) -> bool {
        self.profile["user"]["desktop.projects.openBehavior"] == "newWindow"
    }
    pub fn configured_tool(&self, name: &str) -> Option<String> {
        self.profile["user"][format!("desktop.tools.{name}Path")]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(String::from)
    }
}

#[derive(Deserialize)]
pub struct SettingChange {
    pub path: Vec<String>,
    pub value: Option<Value>,
}
pub fn patch_profile(profile: &mut Value, changes: Vec<SettingChange>) -> Result<(), String> {
    for change in changes {
        if !(change.path.len() == 2 && change.path[0] == "user"
            || change.path.len() == 3 && change.path[0] == "userLanguages")
        {
            return Err("Invalid user settings patch".into());
        }
        let mut cursor = &mut *profile;
        for key in &change.path[..change.path.len() - 1] {
            if cursor.get(key).is_none() {
                cursor[key] = serde_json::json!({});
            }
            cursor = cursor.get_mut(key).ok_or("Invalid settings structure")?;
        }
        let object = cursor.as_object_mut().ok_or("Invalid settings object")?;
        let key = change.path.last().ok_or("Missing settings key")?;
        if let Some(value) = change.value {
            object.insert(key.clone(), value);
        } else {
            object.remove(key);
        }
    }
    Ok(())
}

pub fn ui_path(directory: &Path, key: &str) -> PathBuf {
    directory.join("projects").join(key).join("ui.json")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn duplicate_focus_and_transfer_have_one_owner() {
        let mut m = Model::default();
        assert_eq!(
            m.add("key".into(), "/test".into(), None, "main".into()),
            "main"
        );
        assert_eq!(
            m.add("key".into(), "/test".into(), None, "other".into()),
            "main"
        );
        assert!(m.authorize("other", "key").is_err());
        m.transfer("key", "main", "other").unwrap();
        assert!(m.authorize("main", "key").is_err());
        assert!(m.authorize("other", "key").is_ok());
        assert!(m.windows["main"].projects.is_empty());
    }
    #[test]
    fn independent_settings_changes_merge() {
        let mut p = Model::default().profile;
        patch_profile(
            &mut p,
            vec![SettingChange {
                path: vec!["user".into(), "a".into()],
                value: Some(1.into()),
            }],
        )
        .unwrap();
        patch_profile(
            &mut p,
            vec![SettingChange {
                path: vec!["user".into(), "b".into()],
                value: Some(2.into()),
            }],
        )
        .unwrap();
        assert_eq!(p["user"], serde_json::json!({"a":1,"b":2}));
        assert!(patch_profile(
            &mut p,
            vec![SettingChange {
                path: vec!["workspace".into(), "a".into()],
                value: None
            }]
        )
        .is_err());
    }
    #[test]
    fn remote_projects_restore_without_local_filesystem_checks() {
        let directory =
            std::env::temp_dir().join(format!("oxbit-remote-model-{}", uuid::Uuid::new_v4()));
        let mut model = Model::default();
        model.add(
            "remote".into(),
            "ssh://dev/~/project".into(),
            None,
            "main".into(),
        );
        model.save(&directory).unwrap();
        let restored = Model::load(&directory.join("session.json")).unwrap();
        assert!(!restored.projects["remote"].missing);
        assert_eq!(restored.recent, vec!["ssh://dev/~/project"]);
        assert!(restored.authorize("other", "remote").is_err());
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn canonical_aliases_share_identity_and_missing_projects_restore() {
        let directory = std::env::temp_dir().join(format!("oxbit-model-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(directory.join("project")).unwrap();
        std::os::unix::fs::symlink(directory.join("project"), directory.join("alias")).unwrap();
        let (key, path, _) = Model::locate(&directory.join("project")).unwrap();
        assert_eq!(key, Model::locate(&directory.join("alias")).unwrap().0);
        let mut model = Model::default();
        model.add(key.clone(), path, None, "main".into());
        model.save(&directory).unwrap();
        fs::remove_dir(directory.join("project")).unwrap();
        assert!(
            Model::load(&directory.join("session.json"))
                .unwrap()
                .projects[&key]
                .missing
        );
        fs::remove_dir_all(directory).unwrap();
    }
}
