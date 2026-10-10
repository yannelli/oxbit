const COMMANDS: &[&str] = &[
    "pick_folder",
    "open_folder",
    "close_folder",
    "forget_folder",
    "documents_path",
    "runtime_credentials",
    "runtime_discovery",
    "git_credentials",
    "ssh_keys",
    "pick_files",
    "commit_signing",
    "start_dictation",
    "stop_dictation",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
