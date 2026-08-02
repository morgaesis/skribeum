//! Tauri shell. This crate contains glue only: window setup, IPC command
//! registration and the error mapping at the boundary. Application logic
//! lives in `skribeum-core` and `skribeum-vault`.

#[cfg(debug_assertions)]
use skribeum_vault::write_durable;
use skribeum_vault::{FileSystem, RealFs};
use std::collections::hash_map::RandomState;
use std::ffi::{OsStr, OsString};
use std::fmt::Write as _;
use std::hash::{BuildHasher, Hasher};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, Shutdown, SocketAddrV4, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
#[cfg(debug_assertions)]
use std::sync::OnceLock;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
#[cfg(debug_assertions)]
use std::time::Instant;
use tauri::Manager;

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
static COLD_START_MAIN_ENTRY: OnceLock<Instant> = OnceLock::new();

const INSTANCE_MESSAGE_LIMIT: usize = 1024 * 1024;
const INSTANCE_PATH_LIMIT: usize = 32;
const INSTANCE_MESSAGE_MAGIC: &str = "skribeum-open-files-v1";
const INSTANCE_PORT_CANDIDATES: u16 = 32;
const INSTANCE_CAPABILITY_FILE: &str = "instance-capability";
const INSTANCE_CAPABILITY_LENGTH: usize = 64;
const INSTANCE_IO_DEADLINE: std::time::Duration = std::time::Duration::from_secs(1);
const INSTANCE_HANDSHAKE_LIMIT: usize = 8;

#[derive(serde::Serialize, serde::Deserialize)]
struct InstanceHello {
    magic: String,
    nonce: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct InstanceProof {
    proof: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct InstancePayload {
    paths: Vec<String>,
    proof: String,
}

enum InstanceClaim {
    Primary,
    Forwarded,
    Unavailable(String),
}

enum ForwardAttempt {
    Forwarded,
    NotOurs,
}

fn supported_open_file(path: &Path) -> bool {
    path.extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("md")
                || extension.eq_ignore_ascii_case("markdown")
                || extension.eq_ignore_ascii_case("txt")
        })
}

fn canonical_open_paths(arguments: impl IntoIterator<Item = OsString>) -> Vec<String> {
    arguments
        .into_iter()
        .take(INSTANCE_PATH_LIMIT)
        .map(PathBuf::from)
        .filter_map(|path| RealFs.canonicalize(&path).ok())
        .filter(|path| {
            RealFs.metadata(path).is_ok_and(|metadata| !metadata.is_dir)
                && supported_open_file(path)
        })
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
}

fn new_instance_capability() -> String {
    let mut capability = String::with_capacity(INSTANCE_CAPABILITY_LENGTH);
    for domain in 0_u64..4 {
        let mut hasher = RandomState::new().build_hasher();
        hasher.write_u64(domain);
        hasher.write_u32(std::process::id());
        hasher.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos(),
        );
        write!(&mut capability, "{:016x}", hasher.finish())
            .expect("writing to a String cannot fail");
    }
    capability
}

fn valid_instance_capability(capability: &str) -> bool {
    capability.len() == INSTANCE_CAPABILITY_LENGTH
        && capability.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn instance_capability(path: &Path) -> String {
    if let Some(parent) = path.parent() {
        RealFs
            .create_dir_all(parent)
            .expect("failed to create the application configuration directory");
    }
    for _ in 0..5 {
        if let Ok(bytes) = RealFs.read(path)
            && let Ok(capability) = String::from_utf8(bytes)
            && valid_instance_capability(&capability)
        {
            return capability;
        }
        let capability = new_instance_capability();
        match RealFs.create_private_file(path, capability.as_bytes()) {
            Ok(true) => return capability,
            Ok(false) => std::thread::sleep(std::time::Duration::from_millis(10)),
            Err(_) => {
                let _ = RealFs.remove_file(path);
            }
        }
    }
    let _ = RealFs.remove_file(path);
    let capability = new_instance_capability();
    RealFs
        .create_private_file(path, capability.as_bytes())
        .expect("failed to create the application instance capability");
    if let Ok(bytes) = RealFs.read(path)
        && let Ok(stored) = String::from_utf8(bytes)
        && valid_instance_capability(&stored)
    {
        return stored;
    }
    panic!("failed to establish the application instance capability");
}

fn instance_capability_path() -> PathBuf {
    if let Some(path) = std::env::var_os("SKRIBEUM_E2E_SETTINGS").map(PathBuf::from) {
        let settings_name = path
            .file_name()
            .unwrap_or_else(|| OsStr::new("settings"))
            .to_string_lossy();
        return path.with_file_name(format!("{settings_name}.{INSTANCE_CAPABILITY_FILE}"));
    }
    #[cfg(target_os = "linux")]
    let directory = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")));
    #[cfg(target_os = "macos")]
    let directory = std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join("Library").join("Application Support"));
    #[cfg(target_os = "windows")]
    let directory = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    let directory: Option<PathBuf> = None;
    directory
        .unwrap_or_else(std::env::temp_dir)
        .join("org.skribeum.desktop")
        .join(INSTANCE_CAPABILITY_FILE)
}

fn capabilities_match(actual: &str, expected: &str) -> bool {
    actual.len() == expected.len()
        && actual
            .bytes()
            .zip(expected.bytes())
            .fold(0_u8, |difference, (left, right)| {
                difference | (left ^ right)
            })
            == 0
}

fn decode_capability(capability: &str) -> Option<[u8; 32]> {
    if !valid_instance_capability(capability) {
        return None;
    }
    let mut decoded = [0_u8; 32];
    for (index, byte) in decoded.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&capability[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(decoded)
}

#[allow(
    deprecated,
    reason = "SipHash-2-4 provides the dependency-free local IPC MAC"
)]
fn instance_mac(capability: &str, domain: &str, parts: &[&[u8]]) -> Option<String> {
    let key = decode_capability(capability)?;
    let mut proof = String::with_capacity(INSTANCE_CAPABILITY_LENGTH);
    for round in 0..4_usize {
        let first = round * 8;
        let second = ((round + 2) % 4) * 8;
        let key0 = u64::from_le_bytes(key[first..first + 8].try_into().ok()?);
        let key1 = u64::from_le_bytes(key[second..second + 8].try_into().ok()?);
        let mut hasher = std::hash::SipHasher::new_with_keys(key0, key1);
        hasher.write_u64(u64::try_from(round).ok()?);
        hasher.write_usize(domain.len());
        hasher.write(domain.as_bytes());
        for part in parts {
            hasher.write_usize(part.len());
            hasher.write(part);
        }
        write!(&mut proof, "{:016x}", hasher.finish()).expect("writing to a String cannot fail");
    }
    Some(proof)
}

fn write_instance_line<T: serde::Serialize>(
    stream: &mut TcpStream,
    value: &T,
    deadline: std::time::Instant,
) -> std::io::Result<()> {
    let mut bytes = serde_json::to_vec(value).map_err(std::io::Error::other)?;
    bytes.push(b'\n');
    if bytes.len() > INSTANCE_MESSAGE_LIMIT {
        return Err(std::io::Error::other("instance message exceeds size limit"));
    }
    let mut written = 0;
    while written < bytes.len() {
        let remaining = deadline
            .checked_duration_since(std::time::Instant::now())
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::TimedOut, "deadline elapsed"))?;
        stream.set_write_timeout(Some(remaining))?;
        let count = stream.write(&bytes[written..])?;
        if count == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::WriteZero,
                "instance connection closed while writing",
            ));
        }
        written += count;
    }
    Ok(())
}

fn read_instance_line<T: serde::de::DeserializeOwned>(
    stream: &mut TcpStream,
    deadline: std::time::Instant,
) -> std::io::Result<T> {
    let mut bytes = Vec::new();
    loop {
        if bytes.len() >= INSTANCE_MESSAGE_LIMIT {
            return Err(std::io::Error::other("instance message exceeds size limit"));
        }
        let remaining = deadline
            .checked_duration_since(std::time::Instant::now())
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::TimedOut, "deadline elapsed"))?;
        stream.set_read_timeout(Some(remaining))?;
        let mut byte = [0_u8; 1];
        stream.read_exact(&mut byte)?;
        if byte[0] == b'\n' {
            break;
        }
        bytes.push(byte[0]);
    }
    serde_json::from_slice(&bytes).map_err(std::io::Error::other)
}

fn authenticated_instance_payload(
    stream: &mut TcpStream,
    capability: &str,
) -> std::io::Result<Vec<String>> {
    let deadline = std::time::Instant::now() + INSTANCE_IO_DEADLINE;
    let hello: InstanceHello = read_instance_line(stream, deadline)?;
    if hello.magic != INSTANCE_MESSAGE_MAGIC || !valid_instance_capability(&hello.nonce) {
        return Err(std::io::Error::other("invalid instance handshake"));
    }
    let server_proof = instance_mac(capability, "server", &[hello.nonce.as_bytes()])
        .ok_or_else(|| std::io::Error::other("invalid instance capability"))?;
    write_instance_line(
        stream,
        &InstanceProof {
            proof: server_proof,
        },
        deadline,
    )?;
    let payload: InstancePayload = read_instance_line(stream, deadline)?;
    let encoded_paths = serde_json::to_vec(&payload.paths).map_err(std::io::Error::other)?;
    let expected = instance_mac(
        capability,
        "client",
        &[hello.nonce.as_bytes(), &encoded_paths],
    )
    .ok_or_else(|| std::io::Error::other("invalid instance capability"))?;
    if !capabilities_match(&payload.proof, &expected) {
        return Err(std::io::Error::other("invalid instance proof"));
    }
    let acknowledgement = instance_mac(capability, "accepted", &[hello.nonce.as_bytes()])
        .ok_or_else(|| std::io::Error::other("invalid instance capability"))?;
    write_instance_line(
        stream,
        &InstanceProof {
            proof: acknowledgement,
        },
        deadline,
    )?;
    Ok(payload.paths)
}

fn instance_port(capability: &str) -> u16 {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in capability.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    49_152 + u16::try_from(hash % 16_384).expect("port offset fits in u16")
}

fn forward_to_instance(
    address: SocketAddrV4,
    paths: &[String],
    capability: &str,
) -> std::io::Result<ForwardAttempt> {
    let Ok(mut stream) = TcpStream::connect_timeout(&address.into(), INSTANCE_IO_DEADLINE) else {
        return Ok(ForwardAttempt::NotOurs);
    };
    let deadline = std::time::Instant::now() + INSTANCE_IO_DEADLINE;
    let nonce = new_instance_capability();
    let hello = InstanceHello {
        magic: INSTANCE_MESSAGE_MAGIC.to_owned(),
        nonce: nonce.clone(),
    };
    if write_instance_line(&mut stream, &hello, deadline).is_err() {
        return Ok(ForwardAttempt::NotOurs);
    }
    let Ok(server_proof) = read_instance_line::<InstanceProof>(&mut stream, deadline) else {
        return Ok(ForwardAttempt::NotOurs);
    };
    let expected_server_proof = instance_mac(capability, "server", &[nonce.as_bytes()])
        .ok_or_else(|| std::io::Error::other("invalid instance capability"))?;
    if !capabilities_match(&server_proof.proof, &expected_server_proof) {
        return Ok(ForwardAttempt::NotOurs);
    }
    let encoded_paths = serde_json::to_vec(paths).map_err(std::io::Error::other)?;
    let client_proof = instance_mac(capability, "client", &[nonce.as_bytes(), &encoded_paths])
        .ok_or_else(|| std::io::Error::other("invalid instance capability"))?;
    let payload = InstancePayload {
        paths: paths.to_vec(),
        proof: client_proof,
    };
    write_instance_line(&mut stream, &payload, deadline)?;
    let acknowledgement = read_instance_line::<InstanceProof>(&mut stream, deadline)?;
    let expected_acknowledgement = instance_mac(capability, "accepted", &[nonce.as_bytes()])
        .ok_or_else(|| std::io::Error::other("invalid instance capability"))?;
    if !capabilities_match(&acknowledgement.proof, &expected_acknowledgement) {
        return Err(std::io::Error::other(
            "invalid application instance acknowledgement",
        ));
    }
    let _ = stream.shutdown(Shutdown::Both);
    Ok(ForwardAttempt::Forwarded)
}

fn claim_instance(
    paths: &[String],
    capability: &str,
    sender: &Sender<Vec<String>>,
) -> InstanceClaim {
    let base_port = instance_port(capability);
    for offset in 0..INSTANCE_PORT_CANDIDATES {
        let port = 49_152 + (base_port - 49_152 + offset) % 16_384;
        let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
        if let Ok(listener) = TcpListener::bind(address) {
            listen_for_open_files(listener, capability.to_owned(), sender.clone());
            return InstanceClaim::Primary;
        }
        let mut last_error = None;
        for _ in 0..3 {
            match forward_to_instance(address, paths, capability) {
                Ok(ForwardAttempt::Forwarded) => return InstanceClaim::Forwarded,
                Ok(ForwardAttempt::NotOurs) => {
                    last_error = None;
                    break;
                }
                Err(error) => {
                    last_error = Some(error);
                    std::thread::sleep(std::time::Duration::from_millis(25));
                }
            }
        }
        if let Some(error) = last_error {
            return InstanceClaim::Unavailable(error.to_string());
        }
    }
    panic!("failed to claim an application instance port");
}

fn listen_for_open_files(listener: TcpListener, capability: String, sender: Sender<Vec<String>>) {
    let (ready_sender, ready_receiver) = mpsc::sync_channel(0);
    std::thread::spawn(move || {
        let active_handshakes = std::sync::Arc::new(AtomicUsize::new(0));
        let _ = ready_sender.send(());
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            if active_handshakes
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |active| {
                    (active < INSTANCE_HANDSHAKE_LIMIT).then_some(active + 1)
                })
                .is_err()
            {
                let _ = stream.shutdown(Shutdown::Both);
                continue;
            }
            let capability = capability.clone();
            let sender = sender.clone();
            let active_handshakes = std::sync::Arc::clone(&active_handshakes);
            std::thread::spawn(move || {
                if let Ok(paths) = authenticated_instance_payload(&mut stream, &capability) {
                    let paths = canonical_open_paths(paths.into_iter().map(OsString::from));
                    let _ = sender.send(paths);
                }
                active_handshakes.fetch_sub(1, Ordering::Relaxed);
            });
        }
    });
    ready_receiver
        .recv()
        .expect("application instance listener failed to start");
}

fn dispatch_open_files<R: tauri::Runtime>(
    receiver: Receiver<Vec<String>>,
    app: tauri::AppHandle<R>,
) {
    std::thread::spawn(move || {
        for paths in receiver {
            if paths.is_empty() {
                continue;
            }
            let app_for_event = app.clone();
            let _ = app.run_on_main_thread(move || {
                ipc::queue_open_files(&app_for_event, paths);
                if let Some(window) = app_for_event.get_webview_window("main")
                    && window.is_visible().unwrap_or(false)
                {
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            });
        }
    });
}

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
#[allow(clippy::too_many_lines)] // Application setup is one Tauri lifecycle.
pub fn run() {
    let initial_open_paths = canonical_open_paths(std::env::args_os().skip(1));
    let capability = instance_capability(&instance_capability_path());
    let (open_files_sender, open_files_receiver) = mpsc::channel();
    match claim_instance(&initial_open_paths, &capability, &open_files_sender) {
        InstanceClaim::Primary => {}
        InstanceClaim::Forwarded => return,
        InstanceClaim::Unavailable(message) => {
            panic!("application instance endpoint unavailable: {message}")
        }
    }
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
        .manage(ipc::OpenFilesState::default())
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
            let _ = webview.eval("window.__SKRIBEUM_DEBUG_COLD_START__ = true;");
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

    let app = builder
        .setup(move |app| {
            specta_builder.mount_events(app);
            ipc::queue_open_files(app.handle(), initial_open_paths);
            dispatch_open_files(open_files_receiver, app.handle().clone());
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
            let persisted_theme = settings
                .as_ref()
                .and_then(|store| store.read(&RealFs).ok())
                .map(|document| document.theme);
            app.manage(ipc::SettingsState(settings, std::sync::Mutex::new(())));
            if let Some(window) = app.get_webview_window("main") {
                let dark = match persisted_theme.as_deref() {
                    Some("dark") => true,
                    Some("light") => false,
                    _ => matches!(window.theme(), Ok(tauri::Theme::Dark)),
                };
                let background = if dark {
                    tauri::window::Color(22, 18, 16, 255)
                } else {
                    tauri::window::Color(246, 242, 234, 255)
                };
                window
                    .set_background_color(Some(background))
                    .expect("failed to set the startup window background");
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the application window");

    app.run(|_app, _event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = _event {
            let paths = canonical_open_paths(
                urls.iter()
                    .filter_map(|url| url.to_file_path().ok())
                    .map(OsString::from),
            );
            ipc::queue_open_files(_app, paths);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn argv_open_paths_recognize_supported_extensions() {
        assert!(supported_open_file(Path::new("note.md")));
        assert!(supported_open_file(Path::new("note.markdown")));
        assert!(supported_open_file(Path::new("note.TXT")));
        assert!(!supported_open_file(Path::new("note.rtf")));
        assert!(!supported_open_file(Path::new("note")));
    }

    #[test]
    fn bundle_registers_markdown_and_plain_text_associations() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("Tauri configuration parses");
        let associations = config["bundle"]["fileAssociations"]
            .as_array()
            .expect("bundle file associations exist");
        assert!(associations.iter().any(|association| {
            association["ext"] == serde_json::json!(["md", "markdown"])
                && association["mimeType"] == "text/markdown"
                && association["role"] == "Editor"
        }));
        assert!(associations.iter().any(|association| {
            association["ext"] == serde_json::json!(["txt"])
                && association["mimeType"] == "text/plain"
                && association["role"] == "Editor"
        }));
    }

    #[test]
    fn startup_window_is_hidden_over_the_light_theme_surface() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("Tauri configuration parses");
        let window = &config["app"]["windows"][0];
        assert_eq!(window["visible"], false);
        assert_eq!(window["backgroundColor"], "#f6f2ea");
    }

    #[test]
    fn instance_handshake_authenticates_without_sending_the_capability() {
        let capability = "0123456789abcdef".repeat(4);
        let nonce = "fedcba9876543210".repeat(4);
        let hello = serde_json::to_string(&InstanceHello {
            magic: INSTANCE_MESSAGE_MAGIC.to_owned(),
            nonce: nonce.clone(),
        })
        .expect("hello serializes");
        assert!(!hello.contains(&capability));

        let server = instance_mac(&capability, "server", &[nonce.as_bytes()])
            .expect("valid capability produces a MAC");
        let client = instance_mac(&capability, "client", &[nonce.as_bytes()])
            .expect("valid capability produces a MAC");
        assert_ne!(server, client);
        assert_eq!(server.len(), INSTANCE_CAPABILITY_LENGTH);
        assert_ne!(
            server,
            instance_mac(&capability, "server", &[b"different nonce"])
                .expect("valid capability produces a MAC")
        );
    }
}
