const COMMANDS: &[&str] = &[
    "pick_folder",
    "open_folder",
    "close_folder",
    "forget_folder",
    "documents_path",
    "runtime_credentials",
    "git_credentials",
    "ssh_keys",
    "pick_files",
    "commit_signing",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
