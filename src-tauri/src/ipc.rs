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
use skribeum_vault::{
    Clock, Encoding, EntryKind, FileSystem, Journal, RealClock, RealFs, ReconEvent, Reconciler,
    ReplayOutcome, SearchIndex, Settings, SettingsStore, Vault, VaultPath, is_indexed_path,
};
use tauri::ipc::InvokeResponseBody;
use tauri::{AppHandle, Manager, Runtime, State};
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

/// One byte-range replacement over IPC: bytes `start..end` of the base
/// (the last-read projection) are replaced by `bytes`. Offsets are UTF-8
/// byte offsets, per the boundary invariant.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ByteRangeReplace {
    /// Inclusive start byte offset into the base.
    pub start: u32,
    /// Exclusive end byte offset into the base.
    pub end: u32,
    /// Replacement bytes.
    pub bytes: Vec<u8>,
}

impl From<&ByteRangeReplace> for skribeum_core::ByteRangeReplace {
    fn from(change: &ByteRangeReplace) -> Self {
        Self {
            start: change.start as usize,
            end: change.end as usize,
            bytes: change.bytes.clone(),
        }
    }
}

/// Converts a core change set into its IPC form. Offsets past `u32::MAX`
/// cannot occur: note reads are capped below that size.
fn to_ipc_changes(changes: &[skribeum_core::ByteRangeReplace]) -> Vec<ByteRangeReplace> {
    changes
        .iter()
        .map(|change| ByteRangeReplace {
            start: u32::try_from(change.start).unwrap_or(u32::MAX),
            end: u32::try_from(change.end).unwrap_or(u32::MAX),
            bytes: change.bytes.clone(),
        })
        .collect()
}

/// The result of `note_write`. The conflict variant is the entry point of
/// the reconciliation UX: it carries the current on-disk projection hash
/// plus a reconciliation handle, and nothing was overwritten.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(tag = "result", rename_all = "lowercase")]
pub enum WriteResult {
    /// The change set was applied and durably written.
    Written {
        /// Projection hash of the new on-disk bytes.
        projection_hash: String,
    },
    /// The on-disk projection no longer matches the expected hash.
    Conflict {
        /// Current on-disk projection hash; absent when the file is gone.
        current_projection_hash: Option<String>,
        /// Reconciliation handle for the conflict flow.
        reconciliation: u32,
    },
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

/// Metadata for a read-only indexed-file read. Bytes travel over the raw
/// channel passed to `vault_file_read`.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct VaultFileContent {
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

/// A reconciliation banner: ambiguity the editor must surface; nothing was
/// applied automatically.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct ReconciliationBanner {
    /// Handle of the vault concerned.
    pub vault: u32,
    /// Vault-relative path.
    pub path: String,
    /// Why the banner is shown.
    pub reason: BannerReason,
    /// The observed on-disk projection hash, when one exists.
    pub disk_hash: Option<String>,
}

/// Banner reasons over IPC.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum BannerReason {
    /// A stable read shrank past the guard fraction.
    SizeShrank,
    /// A previously non-empty note read back empty.
    BecameEmpty,
    /// An external edit landed within the settle window of this device's
    /// own last write.
    EditWithinWriteSettle,
    /// The on-disk file changed between a crash and this start; the crash
    /// journal was not replayed.
    JournalDiverged,
}

/// A stable external change to an indexed note, delivered with a change set
/// against this device's last-read projection so an open note ingests it as
/// a delta. External changes are never reverted.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct ExternalNoteUpdate {
    /// Handle of the vault concerned.
    pub vault: u32,
    /// Vault-relative path.
    pub path: String,
    /// Projection hash of the new on-disk content.
    pub projection_hash: String,
    /// Delta from the last projection to the new content.
    pub change_set: Vec<ByteRangeReplace>,
}

/// An indexed note disappeared from disk.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct ExternalNoteRemove {
    /// Handle of the vault concerned.
    pub vault: u32,
    /// Vault-relative path.
    pub path: String,
}

/// More files diverged in one reconciliation pass than the review
/// threshold; nothing was applied and the whole set needs review.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct BulkDivergenceReview {
    /// Handle of the vault concerned.
    pub vault: u32,
    /// Every divergent vault-relative path.
    pub paths: Vec<String>,
}

/// A crash-journal chain replayed on start: applying `change_set` to the
/// current on-disk bytes reproduces the buffer as it was before the crash.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct NoteRecovered {
    /// Handle of the vault concerned.
    pub vault: u32,
    /// Vault-relative path.
    pub path: String,
    /// Delta from the on-disk bytes to the recovered buffer.
    pub change_set: Vec<ByteRangeReplace>,
    /// Projection hash of the recovered buffer.
    pub projection_hash: String,
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

/// One ranked full-text search result over IPC. `match_ranges` are byte
/// offsets into `snippet` (`[start, end)`, character-boundary aligned), so
/// the UI highlights by slicing, never by injecting markup.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct SearchHit {
    /// Vault-relative path of the note.
    pub path: String,
    /// Note title (final path segment without its extension).
    pub title: String,
    /// Snippet of the note text around the first match.
    pub snippet: String,
    /// Byte ranges of query-term matches inside `snippet`.
    pub match_ranges: Vec<[u32; 2]>,
    /// Relevance score; higher ranks better.
    pub score: f64,
}

/// The typed settings document over IPC. Unknown keys in the underlying
/// `settings.json` never cross the boundary; they are preserved internally
/// on every write.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct SettingsDoc {
    /// Schema version of the document.
    pub schema_version: u32,
    /// Color theme: `system`, `light` or `dark`.
    pub theme: String,
    /// Editor font size in CSS pixels.
    pub editor_font_size: u32,
    /// Maximum number of results a search query returns.
    pub search_result_limit: u32,
}

struct OpenVault {
    vault: Vault,
    watching: Arc<AtomicBool>,
    reconciler: Arc<Mutex<Reconciler>>,
    /// The vault's full-text index. `None` when the OS app-data directory
    /// could not be resolved; the index lives there, never in the vault.
    search: Arc<Mutex<Option<SearchIndex>>>,
}

/// Session state: open vaults by handle, plus the session clock driving
/// reconciliation settle windows.
#[derive(Default)]
pub struct VaultRegistry {
    next_id: AtomicU32,
    vaults: Mutex<HashMap<u32, OpenVault>>,
    clock: RealClock,
}

impl VaultRegistry {
    fn lock(&self) -> MutexGuard<'_, HashMap<u32, OpenVault>> {
        self.vaults.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// The crash journal, enabled by default and living in the OS app-data
/// directory (see `skribeum_vault::journal`). Absent only when the app-data
/// directory could not be resolved, in which case saves proceed without
/// journal protection.
pub struct JournalState(pub Option<Journal>);

/// The settings store, at `settings.json` in the OS app-config directory.
/// Absent only when that directory could not be resolved.
pub struct SettingsState(pub Option<SettingsStore>);

/// Rebuilds a vault's search index on a background thread. The index reads
/// notes only; a rebuild never writes inside the vault.
fn spawn_index_rebuild(search: &Arc<Mutex<Option<SearchIndex>>>, vault: Vault) {
    let search = Arc::clone(search);
    std::thread::spawn(move || {
        let guard = search.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(index) = guard.as_ref() {
            #[cfg(debug_assertions)]
            let rebuilt = index.rebuild(&RealFs, &vault).is_ok();
            #[cfg(not(debug_assertions))]
            let _ = index.rebuild(&RealFs, &vault);
            #[cfg(debug_assertions)]
            if rebuilt && let Some(process_ms) = crate::cold_start_elapsed_milliseconds() {
                eprintln!(
                    "SKRIBEUM_COLD_START {{\"event\":\"full-text-index-complete\",\"process_ms\":{process_ms}}}"
                );
            }
        }
    });
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

    // The full-text index lives in the OS app-data directory, keyed by a
    // hash of the vault root; it is never created inside the vault. A
    // corrupt or missing index file is recreated transparently, and the
    // content rebuild runs off the command thread.
    let search =
        Arc::new(Mutex::new(app.path().app_data_dir().ok().and_then(|dir| {
            SearchIndex::open_in_app_data(&dir, vault.root()).ok()
        })));
    spawn_index_rebuild(&search, vault.clone());

    registry.lock().insert(
        id,
        OpenVault {
            vault,
            watching: Arc::new(AtomicBool::new(false)),
            reconciler: Arc::new(Mutex::new(Reconciler::default())),
            search,
        },
    );
    if !groups.is_empty() {
        let _ = VaultCollisionsDetected { vault: id, groups }.emit(&app);
    }
    Ok(VaultHandle { id })
}

/// Converts a vault's indexed tree into its IPC form.
fn tree_entries(vault: &Vault) -> Vec<TreeEntry> {
    vault
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
        .collect()
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
    Ok(tree_entries(&open.vault))
}

/// Re-indexes the tree of an open vault from the current filesystem state
/// and returns it. This is the recovery path for tree staleness after
/// external bulk changes or watcher overflow: the tree indexed at open
/// never silently drifts, it is re-read here on demand. Newly discovered
/// collisions re-emit, and the search index rebuilds in the background.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)] // Tauri commands take owned arguments.
fn vault_tree_refresh<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, VaultRegistry>,
    handle: VaultHandle,
) -> Result<Vec<TreeEntry>, AppError> {
    let (entries, groups, search, vault) = {
        let mut vaults = registry.lock();
        let open = vaults
            .get_mut(&handle.id)
            .ok_or_else(AppError::unknown_handle)?;
        open.vault.refresh(&RealFs)?;
        let groups: Vec<Vec<String>> = open
            .vault
            .collisions()
            .iter()
            .map(|collision| collision.paths.clone())
            .collect();
        (
            tree_entries(&open.vault),
            groups,
            Arc::clone(&open.search),
            open.vault.clone(),
        )
    };
    spawn_index_rebuild(&search, vault);
    if !groups.is_empty() {
        let _ = VaultCollisionsDetected {
            vault: handle.id,
            groups,
        }
        .emit(&app);
    }
    Ok(entries)
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
    open.reconciler
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .record_read(&path, &note.bytes);
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

/// Reads any indexed regular file without creating editor, reconciliation,
/// or search-index state. This is the read path for render-only vault files.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)]
fn vault_file_read(
    registry: State<'_, VaultRegistry>,
    handle: VaultHandle,
    rel_path: String,
    content: RawChannel,
) -> Result<VaultFileContent, AppError> {
    let path = VaultPath::new(&rel_path)?;
    let vaults = registry.lock();
    let open = vaults
        .get(&handle.id)
        .ok_or_else(AppError::unknown_handle)?;
    let bytes = open
        .vault
        .read_file(&RealFs, &path)
        .map_err(|error| AppError::from(error).with_path(path.as_str()))?;
    let byte_length = u32::try_from(bytes.len()).map_err(|_| AppError {
        code: "file/too-large",
        message: "file exceeds the maximum readable size".to_owned(),
        path: Some(path.as_str().to_owned()),
    })?;
    content.send_raw(bytes).map_err(|error| AppError {
        code: "ipc/channel",
        message: format!("failed to deliver file bytes: {error}"),
        path: Some(path.as_str().to_owned()),
    })?;
    Ok(VaultFileContent { byte_length })
}

/// Writes a note through the crash-safe change-set path: `change_set` (a
/// list of byte-range replacements against the last-read projection)
/// applies only after `expected_projection_hash` is verified against the
/// current on-disk projection. On mismatch nothing is written and the
/// conflict variant returns with the current hash and a reconciliation
/// handle. The delta is journaled durably before the write and committed
/// after it.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)] // Tauri commands take owned arguments.
fn note_write(
    registry: State<'_, VaultRegistry>,
    journal: State<'_, JournalState>,
    handle: VaultHandle,
    rel_path: String,
    change_set: Vec<ByteRangeReplace>,
    expected_projection_hash: String,
) -> Result<WriteResult, AppError> {
    let path = VaultPath::new(&rel_path)?;
    let changes: Vec<skribeum_core::ByteRangeReplace> = change_set.iter().map(Into::into).collect();
    let vaults = registry.lock();
    let open = vaults
        .get(&handle.id)
        .ok_or_else(AppError::unknown_handle)?;
    let root = open.vault.root().to_owned();

    // Journal the delta durably before touching the file: with no CRDT the
    // journal is the only recovery path for a kill mid-write. A journal
    // failure never blocks the save itself.
    if let Some(journal) = &journal.0
        && let Some(base) = open.vault.note_base(&path)
        && base.projection_hash == expected_projection_hash
        && let Ok(result_bytes) = skribeum_core::apply_change_set(&base.bytes, &changes)
    {
        let result_hash = skribeum_vault::classify(result_bytes).projection_hash;
        let _ = journal.append_delta(
            &RealFs,
            &root,
            path.as_str(),
            &expected_projection_hash,
            &result_hash,
            &changes,
        );
    }

    let result = open
        .vault
        .write_note(&RealFs, &path, &changes, &expected_projection_hash)
        .map_err(|e| AppError::from(e).with_path(path.as_str()))?;

    match &result {
        skribeum_vault::WriteResult::Written { projection_hash } => {
            if let Some(journal) = &journal.0 {
                let _ = journal.append_commit(&RealFs, &root, path.as_str(), projection_hash);
            }
            if let Some(base) = open.vault.note_base(&path) {
                open.reconciler
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .record_write(&path, &base.bytes, registry.clock.now());
                // Update the search index on save with the written bytes.
                if let Some(index) = open
                    .search
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .as_ref()
                {
                    let _ = index.index_note(path.as_str(), &base.bytes);
                }
            }
            Ok(WriteResult::Written {
                projection_hash: projection_hash.clone(),
            })
        }
        skribeum_vault::WriteResult::Conflict {
            current_projection_hash,
            reconciliation,
        } => Ok(WriteResult::Conflict {
            current_projection_hash: current_projection_hash.clone(),
            reconciliation: *reconciliation,
        }),
    }
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
    journal: State<'_, JournalState>,
    handle: VaultHandle,
) -> Result<(), AppError> {
    let (root, watching, reconciler, search) = {
        let vaults = registry.lock();
        let open = vaults
            .get(&handle.id)
            .ok_or_else(AppError::unknown_handle)?;
        (
            open.vault.root().to_owned(),
            Arc::clone(&open.watching),
            Arc::clone(&open.reconciler),
            Arc::clone(&open.search),
        )
    };
    if watching.swap(true, Ordering::SeqCst) {
        return Ok(());
    }

    // Replay the crash journal for this vault now that the editor side is
    // listening: recovered chains arrive as deltas against the on-disk
    // bytes, a changed-on-disk chain surfaces the reconciliation banner and
    // is never applied silently.
    if let Some(journal) = &journal.0 {
        replay_journal(&app, journal, handle.id, &root);
    }

    let watcher = RealFs.watch(&root).map_err(|error| AppError {
        code: "fs/io",
        message: format!("failed to start the vault watcher: {error}"),
        path: None,
    })?;

    let vault_id = handle.id;
    std::thread::spawn(move || {
        let mut watcher = watcher;
        let clock = RealClock::default();
        loop {
            let mut delivered_any = false;
            while let Some(event) = watcher.try_next() {
                delivered_any = true;
                let now = clock.now();
                let Some(change) = translate_event(vault_id, &root, event) else {
                    continue;
                };
                {
                    let mut recon = reconciler.lock().unwrap_or_else(PoisonError::into_inner);
                    for observed in [&change.path, &change.renamed_to] {
                        if let Some(observed) = observed
                            && let Ok(path) = VaultPath::new(observed)
                        {
                            recon.observe_event(&path, now);
                        }
                    }
                }
                // Disappearances drop out of the search index directly:
                // the reconciler only tracks notes this session has read,
                // so a delete or rename-away of an unopened note would
                // otherwise leave a stale index row.
                if matches!(
                    change.change,
                    VaultChangeKind::Removed | VaultChangeKind::Renamed
                ) && let Some(path) = &change.path
                    && let Some(index) = search
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .as_ref()
                {
                    let _ = index.remove_note(path);
                }
                if change.emit(&app).is_err() {
                    // The app is shutting down; end the watch thread.
                    return;
                }
            }
            let events = {
                let mut recon = reconciler.lock().unwrap_or_else(PoisonError::into_inner);
                recon.poll(&RealFs, &root, clock.now())
            };
            for event in events {
                // External changes update the search index incrementally:
                // updates re-read and re-index, removals drop the row.
                if let Some(index) = search
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .as_ref()
                {
                    let _ = index.apply_recon_event(&RealFs, &root, &event);
                }
                if !emit_recon_event(&app, vault_id, event) {
                    return;
                }
            }
            if !delivered_any {
                // Polling cadence for the OS watcher queue. Reconciliation
                // debounce logic runs on the Clock trait, not on this
                // interval.
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    });
    Ok(())
}

/// Runs a ranked full-text query over an open vault's notes. Results carry
/// BM25 scores (title matches outrank heading matches outrank body
/// matches), a Rust-assembled snippet and byte-offset match ranges into
/// that snippet. At most `limit` hits return, best first.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)] // Tauri commands take owned arguments.
fn search_query(
    registry: State<'_, VaultRegistry>,
    handle: VaultHandle,
    query: String,
    limit: u32,
) -> Result<Vec<SearchHit>, AppError> {
    let vaults = registry.lock();
    let open = vaults
        .get(&handle.id)
        .ok_or_else(AppError::unknown_handle)?;
    let guard = open.search.lock().unwrap_or_else(PoisonError::into_inner);
    let index = guard.as_ref().ok_or_else(AppError::search_unavailable)?;
    let hits = index.query(&query, limit).map_err(AppError::from)?;
    Ok(hits
        .into_iter()
        .map(|hit| SearchHit {
            path: hit.path,
            title: hit.title,
            snippet: hit.snippet,
            match_ranges: hit.match_ranges,
            score: hit.score,
        })
        .collect())
}

/// Reads a recognized Obsidian configuration file from the vault's
/// `.obsidian` directory, the single sanctioned read path into it. Returns
/// null when the file is absent, oversized or not UTF-8: configuration
/// degrades to defaults rather than erroring.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)] // Tauri commands take owned arguments.
fn vault_config_read(
    registry: State<'_, VaultRegistry>,
    handle: VaultHandle,
    name: String,
) -> Result<Option<String>, AppError> {
    let vaults = registry.lock();
    let open = vaults
        .get(&handle.id)
        .ok_or_else(AppError::unknown_handle)?;
    open.vault
        .read_obsidian_config(&RealFs, &name)
        .map_err(AppError::from)
}

/// Reads the settings document from `settings.json` in the OS app-config
/// directory. A missing file yields the defaults.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)] // Tauri commands take owned arguments.
fn settings_read(settings: State<'_, SettingsState>) -> Result<SettingsDoc, AppError> {
    let store = settings
        .0
        .as_ref()
        .ok_or_else(AppError::settings_unavailable)?;
    let doc = store.read(&RealFs).map_err(AppError::from)?;
    Ok(SettingsDoc {
        schema_version: doc.schema_version,
        theme: doc.theme,
        editor_font_size: doc.editor_font_size,
        search_result_limit: doc.search_result_limit,
    })
}

/// Writes the settings document whole. Values are validated first, and
/// unknown keys already present in the file are preserved, so settings
/// written by a newer build survive a round trip through this one.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)] // Tauri commands take owned arguments.
fn settings_write(settings: State<'_, SettingsState>, doc: SettingsDoc) -> Result<(), AppError> {
    let store = settings
        .0
        .as_ref()
        .ok_or_else(AppError::settings_unavailable)?;
    store
        .write(
            &RealFs,
            &Settings {
                schema_version: doc.schema_version,
                theme: doc.theme,
                editor_font_size: doc.editor_font_size,
                search_result_limit: doc.search_result_limit,
            },
        )
        .map_err(AppError::from)
}

/// Replays the crash journal for one vault, emitting recovery deltas and
/// divergence banners.
fn replay_journal<R: Runtime>(app: &AppHandle<R>, journal: &Journal, vault: u32, root: &Path) {
    for outcome in journal.replay(&RealFs, root) {
        match outcome {
            ReplayOutcome::Recovered {
                rel_path,
                bytes,
                projection_hash,
            } => {
                let disk = RealFs.read(&root.join(&rel_path)).unwrap_or_default();
                let change_set = match skribeum_core::changed_span(&disk, &bytes) {
                    None => Vec::new(),
                    Some((start, end)) => {
                        let replaced = bytes.len() - (disk.len() - (end - start));
                        vec![skribeum_core::ByteRangeReplace {
                            start,
                            end,
                            bytes: bytes[start..start + replaced].to_vec(),
                        }]
                    }
                };
                let _ = NoteRecovered {
                    vault,
                    path: rel_path,
                    change_set: to_ipc_changes(&change_set),
                    projection_hash,
                }
                .emit(app);
            }
            ReplayOutcome::Diverged {
                rel_path,
                disk_hash,
            } => {
                let _ = ReconciliationBanner {
                    vault,
                    path: rel_path,
                    reason: BannerReason::JournalDiverged,
                    disk_hash,
                }
                .emit(app);
            }
            ReplayOutcome::Clean { .. } => {}
        }
    }
}

/// Emits one typed reconciliation event; false when the app is shutting
/// down.
fn emit_recon_event<R: Runtime>(app: &AppHandle<R>, vault: u32, event: ReconEvent) -> bool {
    let result = match event {
        ReconEvent::ExternalUpdate {
            path,
            projection_hash,
            change_set,
        } => ExternalNoteUpdate {
            vault,
            path: path.as_str().to_owned(),
            projection_hash,
            change_set: to_ipc_changes(&change_set),
        }
        .emit(app),
        ReconEvent::ExternalRemove { path } => ExternalNoteRemove {
            vault,
            path: path.as_str().to_owned(),
        }
        .emit(app),
        ReconEvent::Banner {
            path,
            reason,
            disk_hash,
        } => ReconciliationBanner {
            vault,
            path: path.as_str().to_owned(),
            reason: match reason {
                skribeum_vault::BannerReason::SizeShrank => BannerReason::SizeShrank,
                skribeum_vault::BannerReason::BecameEmpty => BannerReason::BecameEmpty,
                skribeum_vault::BannerReason::EditWithinWriteSettle => {
                    BannerReason::EditWithinWriteSettle
                }
            },
            disk_hash,
        }
        .emit(app),
        ReconEvent::BulkDivergence { paths } => BulkDivergenceReview {
            vault,
            paths: paths.iter().map(|p| p.as_str().to_owned()).collect(),
        }
        .emit(app),
    };
    result.is_ok()
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
        // A rename from an excluded name into an indexed one (the shape of
        // every temp-then-rename writer, this application included) is a
        // modification of the target; the mirror is a removal.
        WatchEvent::Renamed { from, to } => {
            match (vault_relative(root, &from), vault_relative(root, &to)) {
                (Some(from), to) => VaultChanged {
                    vault,
                    change: VaultChangeKind::Renamed,
                    path: Some(from),
                    renamed_to: to,
                },
                (None, Some(to)) => VaultChanged {
                    vault,
                    change: VaultChangeKind::Modified,
                    path: Some(to),
                    renamed_to: None,
                },
                (None, None) => return None,
            }
        }
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
            vault_tree_refresh::<tauri::Wry>,
            note_read,
            vault_file_read,
            note_write,
            watch_subscribe::<tauri::Wry>,
            search_query,
            settings_read,
            settings_write,
            vault_config_read,
        ])
        .events(tauri_specta::collect_events![
            VaultChanged,
            VaultCollisionsDetected,
            ReconciliationBanner,
            ExternalNoteUpdate,
            ExternalNoteRemove,
            BulkDivergenceReview,
            NoteRecovered,
        ])
}
