use std::{env, fs, path::PathBuf};

const MANIFEST_VARIABLE: &str = "OXBIT_REMOTE_RUNTIME_MANIFEST";

fn main() {
    println!("cargo:rerun-if-env-changed={MANIFEST_VARIABLE}");
    let pinned = match env::var_os(MANIFEST_VARIABLE).filter(|value| !value.is_empty()) {
        Some(file) => {
            let file = PathBuf::from(file);
            println!("cargo:rerun-if-changed={}", file.display());
            let text = fs::read_to_string(&file).unwrap_or_else(|error| {
                panic!("{MANIFEST_VARIABLE} ({}): {error}", file.display())
            });
            format!("Some({text:?})")
        }
        None => "None".to_owned(),
    };
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set by Cargo"));
    fs::write(
        output.join("remote_runtime_manifest.rs"),
        format!("const PINNED_MANIFEST: Option<&str> = {pinned};\n"),
    )
    .expect("write the pinned remote runtime manifest");
    tauri_build::build();
}
