//! The IPC command surface. Every command here must appear in the committed
//! `ipc-allowlist.json` at the repository root; CI fails when the generated
//! bindings and the allowlist diverge. Commands are glue only: they resolve
//! handles and delegate to `skribeum-vault`.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use skribeum_vault::{Encoding, EntryKind, FileSystem, RealFs, Vault, VaultPath, is_indexed_path};
use tauri::ipc::InvokeResponseBody;
use tauri::{AppHandle, Runtime, State};
use tauri_specta::Event;

use crate::error::AppError;

/// Opaque handle to a vault opened in this session.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
pub struct VaultHandle {
    /// Session-local identifier; never persisted.
    pub id: u32,
}

/// Entry kind over IPC.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum TreeEntryKind {
    /// A directory.
    Directory,
    /// A markdown note.
    Note,
    /// Any other file; listed and typed, never parsed.
    File,
}

/// One vault tree row over IPC. Paths are vault-relative `VaultPath`
/// strings; absolute paths never cross the boundary except into
/// `vault_open`.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct TreeEntry {
    /// Vault-relative path.
    pub path: String,
    /// Entry kind.
    pub kind: TreeEntryKind,
    /// Whether the final segment is dot-prefixed.
    pub hidden: bool,
}

/// Encoding classification over IPC.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum NoteEncoding {
    /// Valid UTF-8.
    Utf8,
    /// Valid UTF-8 with a byte-order mark, preserved byte-for-byte.
    Utf8Bom,
    /// Not UTF-8; the note is read-only.
    NonUtf8,
}

/// Metadata for a note read. The bytes themselves travel over the raw
/// channel passed to `note_read`, not through this JSON value; see the
/// payload note on [`note_read`].
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct NoteContent {
    /// Encoding classification.
    pub encoding: NoteEncoding,
    /// Lowercase hex SHA-256 over the exact on-disk bytes. Opaque.
    pub projection_hash: String,
    /// Exact byte count delivered over the channel.
    pub byte_length: u32,
}

/// A filesystem change under an open vault, delivered as a Tauri event
/// stream after `watch_subscribe`.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct VaultChanged {
    /// Handle of the vault the change belongs to.
    pub vault: u32,
    /// Change kind.
    pub change: VaultChangeKind,
    /// Vault-relative path, absent for overflow.
    pub path: Option<String>,
    /// Rename target, present only for renames.
    pub renamed_to: Option<String>,
}

/// Kinds of watched change.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum VaultChangeKind {
    /// A file or directory appeared.
    Created,
    /// File content changed.
    Modified,
    /// A file or directory disappeared.
    Removed,
    /// A rename with both endpoints inside the vault.
    Renamed,
    /// Events were lost; the vault must be rescanned.
    Overflow,
}

/// Case or Unicode-normalization collisions found while indexing a vault.
/// Emitted at open; collisions are surfaced, never silently merged.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct VaultCollisionsDetected {
    /// Handle of the vault concerned.
    pub vault: u32,
    /// Colliding path groups, each a set of vault-relative paths that one
    /// filesystem may treat as a single file.
    pub groups: Vec<Vec<String>>,
}

/// A channel whose messages are raw byte payloads. The specta signature
/// borrows `Channel<Vec<u8>>` so bindings type it as a Tauri channel, while
/// sends use `InvokeResponseBody::Raw`, which the webview receives as an
/// `ArrayBuffer` and which never travels the JSON path. This implements the
/// contract rule that payloads above roughly 1MB avoid JSON serialization.
pub struct RawChannel(tauri::ipc::Channel<InvokeResponseBody>);

impl RawChannel {
    fn send_raw(&self, bytes: Vec<u8>) -> tauri::Result<()> {
        self.0.send(InvokeResponseBody::Raw(bytes))
    }
}

impl<'de, R: Runtime> tauri::ipc::CommandArg<'de, R> for RawChannel {
    fn from_command(
        command: tauri::ipc::CommandItem<'de, R>,
    ) -> Result<Self, tauri::ipc::InvokeError> {
        tauri::ipc::Channel::from_command(command).map(RawChannel)
    }
}

impl specta::Type for RawChannel {
    fn definition(types: &mut specta::Types) -> specta::datatype::DataType {
        // Typed in bindings exactly like a byte channel; the runtime payload
        // is a raw ArrayBuffer, which the hand-written wrapper handles.
        <tauri::ipc::Channel<Vec<u8>> as specta::Type>::definition(types)
    }
}

struct OpenVault {
    vault: Vault,
    watching: Arc<AtomicBool>,
}

/// Session state: open vaults by handle.
#[derive(Default)]
pub struct VaultRegistry {
    next_id: AtomicU32,
    vaults: Mutex<HashMap<u32, OpenVault>>,
}

impl VaultRegistry {
    fn lock(&self) -> MutexGuard<'_, HashMap<u32, OpenVault>> {
        self.vaults.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Opens a vault at an absolute path, validates it and indexes its tree.
/// This is the only command that accepts an absolute path.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)] // Tauri commands take owned arguments.
fn vault_open<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, VaultRegistry>,
    path: String,
) -> Result<VaultHandle, AppError> {
    let vault = Vault::open(&RealFs, Path::new(&path))?;
    let id = registry.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let groups: Vec<Vec<String>> = vault
        .collisions()
        .iter()
        .map(|collision| collision.paths.clone())
        .collect();
    registry.lock().insert(
        id,
        OpenVault {
            vault,
            watching: Arc::new(AtomicBool::new(false)),
        },
    );
    if !groups.is_empty() {
        let _ = VaultCollisionsDetected { vault: id, groups }.emit(&app);
    }
    Ok(VaultHandle { id })
}

/// Lists the indexed tree of an open vault, sorted by path.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)] // Tauri commands take owned arguments.
fn vault_tree(
    registry: State<'_, VaultRegistry>,
    handle: VaultHandle,
) -> Result<Vec<TreeEntry>, AppError> {
    let vaults = registry.lock();
    let open = vaults
        .get(&handle.id)
        .ok_or_else(AppError::unknown_handle)?;
    Ok(open
        .vault
        .tree()
        .iter()
        .map(|entry| TreeEntry {
            path: entry.path.as_str().to_owned(),
            kind: match entry.kind {
                EntryKind::Directory => TreeEntryKind::Directory,
                EntryKind::Note => TreeEntryKind::Note,
                EntryKind::File => TreeEntryKind::File,
            },
            hidden: entry.hidden,
        })
        .collect())
}

/// Reads a note. Metadata returns as JSON; the note bytes are sent over
/// `content` as a single raw-payload message (an `ArrayBuffer` in the
/// webview), so large files never cross the bridge as JSON.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)] // Tauri commands take owned arguments.
fn note_read(
    registry: State<'_, VaultRegistry>,
    handle: VaultHandle,
    rel_path: String,
    content: RawChannel,
) -> Result<NoteContent, AppError> {
    let path = VaultPath::new(&rel_path)?;
    let vaults = registry.lock();
    let open = vaults
        .get(&handle.id)
        .ok_or_else(AppError::unknown_handle)?;
    let note = open
        .vault
        .read_note(&RealFs, &path)
        .map_err(|e| AppError::from(e).with_path(path.as_str()))?;

    let byte_length = u32::try_from(note.bytes.len()).map_err(|_| AppError {
        code: "note/too-large",
        message: "note exceeds the maximum readable size".to_owned(),
        path: Some(path.as_str().to_owned()),
    })?;
    let encoding = match note.encoding {
        Encoding::Utf8 => NoteEncoding::Utf8,
        Encoding::Utf8Bom => NoteEncoding::Utf8Bom,
        Encoding::NonUtf8 => NoteEncoding::NonUtf8,
    };
    let projection_hash = note.projection_hash.clone();
    content.send_raw(note.bytes).map_err(|error| AppError {
        code: "ipc/channel",
        message: format!("failed to deliver note bytes: {error}"),
        path: Some(path.as_str().to_owned()),
    })?;
    Ok(NoteContent {
        encoding,
        projection_hash,
        byte_length,
    })
}

/// Subscribes to change events under an open vault. Events arrive as the
/// `VaultChanged` event stream; a second subscription for the same handle is
/// a no-op.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)] // Tauri commands take owned arguments.
fn watch_subscribe<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, VaultRegistry>,
    handle: VaultHandle,
) -> Result<(), AppError> {
    let (root, watching) = {
        let vaults = registry.lock();
        let open = vaults
            .get(&handle.id)
            .ok_or_else(AppError::unknown_handle)?;
        (open.vault.root().to_owned(), Arc::clone(&open.watching))
    };
    if watching.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let watcher = RealFs.watch(&root).map_err(|error| AppError {
        code: "fs/io",
        message: format!("failed to start the vault watcher: {error}"),
        path: None,
    })?;

    let vault_id = handle.id;
    std::thread::spawn(move || {
        let mut watcher = watcher;
        loop {
            let mut delivered_any = false;
            while let Some(event) = watcher.try_next() {
                delivered_any = true;
                if let Some(change) = translate_event(vault_id, &root, event)
                    && change.emit(&app).is_err()
                {
                    // The app is shutting down; end the watch thread.
                    return;
                }
            }
            if !delivered_any {
                // Polling cadence for the OS watcher queue. Reconciliation
                // debounce logic (M1b) runs on the Clock trait, not on this
                // interval.
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    });
    Ok(())
}

/// Converts an absolute watcher path into a vault-relative string, dropping
/// anything outside the vault or inside the exclusion list.
fn vault_relative(root: &Path, absolute: &Path) -> Option<String> {
    let relative = absolute.strip_prefix(root).ok()?;
    let joined = relative
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/");
    let path = VaultPath::new(&joined).ok()?;
    is_indexed_path(&path).then(|| path.as_str().to_owned())
}

fn translate_event(
    vault: u32,
    root: &Path,
    event: skribeum_vault::WatchEvent,
) -> Option<VaultChanged> {
    use skribeum_vault::WatchEvent;
    let changed = match event {
        WatchEvent::Created(path) => VaultChanged {
            vault,
            change: VaultChangeKind::Created,
            path: Some(vault_relative(root, &path)?),
            renamed_to: None,
        },
        WatchEvent::Modified(path) => VaultChanged {
            vault,
            change: VaultChangeKind::Modified,
            path: Some(vault_relative(root, &path)?),
            renamed_to: None,
        },
        WatchEvent::Removed(path) => VaultChanged {
            vault,
            change: VaultChangeKind::Removed,
            path: Some(vault_relative(root, &path)?),
            renamed_to: None,
        },
        WatchEvent::Renamed { from, to } => VaultChanged {
            vault,
            change: VaultChangeKind::Renamed,
            path: Some(vault_relative(root, &from)?),
            renamed_to: vault_relative(root, &to),
        },
        WatchEvent::Overflow => VaultChanged {
            vault,
            change: VaultChangeKind::Overflow,
            path: None,
            renamed_to: None,
        },
    };
    Some(changed)
}

/// The typed IPC surface: commands and events registered with
/// `tauri-specta`. Used by the running app and by the contract tests that
/// compare generated bindings against the committed allowlist.
#[must_use]
pub fn ipc_builder() -> tauri_specta::Builder<tauri::Wry> {
    tauri_specta::Builder::<tauri::Wry>::new()
        .commands(tauri_specta::collect_commands![
            vault_open::<tauri::Wry>,
            vault_tree,
            note_read,
            watch_subscribe::<tauri::Wry>,
        ])
        .events(tauri_specta::collect_events![
            VaultChanged,
            VaultCollisionsDetected,
        ])
}
