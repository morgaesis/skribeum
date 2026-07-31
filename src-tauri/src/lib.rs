//! Tauri shell. This crate contains glue only: window setup, IPC command
//! registration and the error mapping at the boundary. Application logic
//! lives in `skribeum-core` and `skribeum-vault`.

pub mod error;
pub mod ipc;

pub use ipc::ipc_builder;

/// Starts the application window.
///
/// # Panics
///
/// Panics if the Tauri runtime fails to initialize; there is no meaningful
/// recovery path before a window exists.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let specta_builder = ipc_builder();

    // In development, keep the committed TypeScript bindings current on
    // every launch. The path is anchored to this crate's manifest directory
    // so the export works whatever the process working directory is; CI
    // separately asserts the committed file matches what this generates.
    #[cfg(debug_assertions)]
    specta_builder
        .export(
            specta_typescript::Typescript::default(),
            concat!(env!("CARGO_MANIFEST_DIR"), "/../src/lib/ipc/bindings.ts"),
        )
        .expect("failed to export TypeScript bindings");

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ipc::VaultRegistry::default())
        .invoke_handler(specta_builder.invoke_handler());

    // The embedded WebDriver server used by the end-to-end suite. Compiled in
    // only when the `webdriver` feature is enabled, so release artifacts never
    // contain it.
    #[cfg(feature = "webdriver")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());

    // End-to-end vault seam: the directory-picker dialog cannot be driven
    // headlessly, so webdriver-feature builds announce the vault named by
    // `SKRIBEUM_E2E_VAULT` to the webview, which opens it on startup. The
    // hook compiles only into webdriver builds, so the seam does not exist
    // in release artifacts; the corresponding webview poll is inert without
    // this injection.
    #[cfg(feature = "webdriver")]
    let builder = builder.on_page_load(|webview, _payload| {
        if let Ok(vault_path) = std::env::var("SKRIBEUM_E2E_VAULT")
            && let Ok(encoded) = serde_json::to_string(&vault_path)
        {
            let _ = webview.eval(format!("window.__SKRIBEUM_E2E_VAULT__ = {encoded};"));
        }
    });

    builder
        .setup(move |app| {
            use tauri::Manager;
            specta_builder.mount_events(app);
            // The crash journal is enabled by default; it lives in the OS
            // app-data directory, never inside any vault.
            let journal = app.path().app_data_dir().ok().map(|dir| {
                skribeum_vault::Journal::new(dir.join(skribeum_vault::JOURNAL_FILE_NAME))
            });
            app.manage(ipc::JournalState(journal));
            // Settings live in the OS app-config directory, never in any
            // vault, with unknown keys preserved on every write.
            let settings = app.path().app_config_dir().ok().map(|dir| {
                skribeum_vault::SettingsStore::new(dir.join(skribeum_vault::SETTINGS_FILE_NAME))
            });
            app.manage(ipc::SettingsState(settings));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to start the application window");
}
