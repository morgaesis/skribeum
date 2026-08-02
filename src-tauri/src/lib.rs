//! Tauri shell. This crate contains glue only: window setup, IPC command
//! registration and the error mapping at the boundary. Application logic
//! lives in `skribeum-core` and `skribeum-vault`.

#[cfg(debug_assertions)]
use skribeum_vault::{FileSystem, RealFs, write_durable};
#[cfg(debug_assertions)]
use std::sync::OnceLock;
#[cfg(debug_assertions)]
use std::time::Instant;

pub mod error;
pub mod ipc;

pub use ipc::ipc_builder;

/// Removes trailing horizontal whitespace from generated TypeScript bindings.
pub fn normalize_generated_bindings(generated: &str) -> String {
    let mut normalized = generated
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n");
    if generated.ends_with('\n') {
        normalized.push('\n');
    }
    normalized
}

#[cfg(debug_assertions)]
const COLD_START_FIRST_EDITOR_PAINT_EVENT: &str = "skribeum://debug/first-editor-paint";
#[cfg(debug_assertions)]
static COLD_START_MAIN_ENTRY: OnceLock<Instant> = OnceLock::new();

/// Records the process timestamp used by debug cold-start measurement.
#[cfg(debug_assertions)]
pub fn mark_cold_start_main_entry() {
    let _ = COLD_START_MAIN_ENTRY.set(Instant::now());
}

/// Returns elapsed process time for debug-only cold-start measurement.
#[cfg(debug_assertions)]
pub(crate) fn cold_start_elapsed_milliseconds() -> Option<u128> {
    COLD_START_MAIN_ENTRY
        .get()
        .map(|start| start.elapsed().as_millis())
}

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
    let bindings_path = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/lib/ipc/bindings.ts");
    specta_builder
        .export(specta_typescript::Typescript::default(), bindings_path)
        .expect("failed to export TypeScript bindings");
    #[cfg(debug_assertions)]
    {
        let bindings_path = std::path::Path::new(bindings_path);
        let generated = RealFs
            .read(bindings_path)
            .expect("failed to read generated TypeScript bindings");
        let generated =
            String::from_utf8(generated).expect("generated TypeScript bindings are not UTF-8");
        let normalized = normalize_generated_bindings(&generated);
        if normalized != generated {
            write_durable(&RealFs, bindings_path, normalized.as_bytes())
                .expect("failed to normalize generated TypeScript bindings");
        }
    }

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ipc::VaultRegistry::default())
        .invoke_handler(specta_builder.invoke_handler());

    // The updater is compiled out of the end-to-end build so tests never
    // reach the network; release builds carry it.
    #[cfg(not(feature = "webdriver"))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    // The embedded WebDriver server used by the end-to-end suite. Compiled in
    // only when the `webdriver` feature is enabled, so release artifacts never
    // contain it.
    #[cfg(feature = "webdriver")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());

    // The debug measurement flag and the end-to-end vault seam are injected
    // only into debug or webdriver builds. Release artifacts receive neither
    // hook. The directory-picker dialog cannot be driven headlessly, so the
    // webdriver seam announces `SKRIBEUM_E2E_VAULT` to the webview.
    #[cfg(any(debug_assertions, feature = "webdriver"))]
    let builder = builder.on_page_load(|webview, _payload| {
        #[cfg(debug_assertions)]
        {
            if let Some(process_ms) = cold_start_elapsed_milliseconds() {
                let _ = webview.eval(format!(
                    "window.__SKRIBEUM_DEBUG_COLD_START_CALIBRATION__ = {{ processMs: {process_ms}, webviewMs: performance.now() }}; window.__SKRIBEUM_DEBUG_COLD_START__ = true;"
                ));
            }
        }

        #[cfg(any(debug_assertions, feature = "webdriver"))]
        if let Ok(vault_path) = std::env::var("SKRIBEUM_E2E_VAULT")
            && let Ok(encoded) = serde_json::to_string(&vault_path)
        {
            let _ = webview.eval(format!("window.__SKRIBEUM_E2E_VAULT__ = {encoded};"));
        }

        #[cfg(feature = "webdriver")]
        if let Ok(note_path) = std::env::var("SKRIBEUM_E2E_NOTE")
            && let Ok(encoded) = serde_json::to_string(&note_path)
        {
            let _ = webview.eval(format!("window.__SKRIBEUM_E2E_NOTE__ = {encoded};"));
        }

        #[cfg(feature = "webdriver")]
        if std::env::var("SKRIBEUM_PERF_HARNESS").as_deref() == Ok("1") {
            let _ = webview.eval("window.__SKRIBEUM_DEBUG_PERF__ = true;");
        }
    });

    builder
        .setup(move |app| {
            use tauri::Manager;
            #[cfg(debug_assertions)]
            use tauri::Listener;

            specta_builder.mount_events(app);
            #[cfg(debug_assertions)]
            app.listen(COLD_START_FIRST_EDITOR_PAINT_EVENT, |event| {
                let Ok(report) = serde_json::from_str::<ColdStartFirstEditorPaint>(event.payload())
                else {
                    return;
                };
                let process_ms = report.process_ms;
                eprintln!(
                    "SKRIBEUM_COLD_START {{\"event\":\"first-editor-paint\",\"process_ms\":{process_ms},\"webview_ms\":{}}}",
                    report.webview_ms
                );
            });
            // The crash journal is enabled by default; it lives in the OS
            // app-data directory, never inside any vault.
            let journal = app.path().app_data_dir().ok().map(|dir| {
                skribeum_vault::Journal::new(dir.join(skribeum_vault::JOURNAL_FILE_NAME))
            });
            app.manage(ipc::JournalState(journal));
            // Settings live in the OS app-config directory, never in any
            // vault, with unknown keys preserved on every write. WebDriver
            // builds accept an isolated store so concurrent suites cannot
            // change each other's editor behavior.
            #[cfg(feature = "webdriver")]
            let settings_path = std::env::var_os("SKRIBEUM_E2E_SETTINGS")
                .map(std::path::PathBuf::from)
                .or_else(|| {
                    app.path()
                        .app_config_dir()
                        .ok()
                        .map(|dir| dir.join(skribeum_vault::SETTINGS_FILE_NAME))
                });
            #[cfg(not(feature = "webdriver"))]
            let settings_path = app
                .path()
                .app_config_dir()
                .ok()
                .map(|dir| dir.join(skribeum_vault::SETTINGS_FILE_NAME));
            let settings = settings_path.map(skribeum_vault::SettingsStore::new);
            app.manage(ipc::SettingsState(settings));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to start the application window");
}

#[cfg(debug_assertions)]
#[derive(serde::Deserialize)]
struct ColdStartFirstEditorPaint {
    process_ms: f64,
    webview_ms: f64,
}
