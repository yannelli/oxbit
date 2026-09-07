fn main() {
    println!("cargo:rerun-if-env-changed=OXBIT_UPDATER_PUBLIC_KEY");
    tauri_build::build();
}
