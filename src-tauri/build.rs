fn main() {
    // The CLI passes config overlays (for example the webdriver test overlay)
    // through this environment variable. Without declaring it as an input,
    // a cached build script keeps the previously embedded config and the
    // overlay is silently dropped.
    println!("cargo:rerun-if-env-changed=TAURI_CONFIG");
    tauri_build::build();
}
