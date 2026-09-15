const COMMANDS: &[&str] = &[
    "pick_folder",
    "open_folder",
    "close_folder",
    "forget_folder",
    "documents_path",
    "runtime_credentials",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
