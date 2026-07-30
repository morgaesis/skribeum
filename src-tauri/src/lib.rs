//! Tauri shell. This crate contains glue only: window setup and, once the
//! IPC allowlist gains entries, command registration. Application logic
//! lives in `skribeum-core` and `skribeum-vault`.

/// Starts the application window.
///
/// # Panics
///
/// Panics if the Tauri runtime fails to initialize; there is no meaningful
/// recovery path before a window exists.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // The embedded WebDriver server used by the end-to-end suite. Compiled in
    // only when the `webdriver` feature is enabled, so release artifacts never
    // contain it.
    #[cfg(feature = "webdriver")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());

    builder
        .run(tauri::generate_context!())
        .expect("failed to start the application window");
}
