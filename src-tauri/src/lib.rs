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

    builder
        .setup(move |app| {
            specta_builder.mount_events(app);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to start the application window");
}
