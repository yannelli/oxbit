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
    "live_activity",
    "watch_live_activity_tokens",
    "unwatch_live_activity_tokens",
    "notification_permission",
    "request_notification_permission",
    "notify",
    "watch_notification_taps",
    "unwatch_notification_taps",
    "register_remote_notifications",
    "agent_models_stream",
    "agent_models_cancel",
    "agent_models_key",
    "agent_models_chatgpt",
    "background_location",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
