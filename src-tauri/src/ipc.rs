//! The IPC command surface. Every command here must appear in the committed
//! `ipc-allowlist.json` at the repository root; CI fails when the generated
//! bindings and the allowlist diverge. Commands are glue only: they resolve
//! handles and delegate to `skribeum-vault`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use skribeum_vault::{
    Clock, EditHistoryJournal, Encoding, EntryKind, FileSystem, Journal, RealClock, RealFs,
    ReconEvent, Reconciler, ReplayOutcome, SearchIndex, Settings, SettingsError, SettingsStore,
    Vault, VaultPath, VaultSession, VaultSessionStore, is_indexed_path,
};
use tauri::ipc::InvokeResponseBody;
use tauri::{AppHandle, Emitter, Manager, Runtime, State, WebviewWindow};
#[cfg(not(feature = "webdriver"))]
use tauri_plugin_updater::UpdaterExt;
use tauri_specta::Event;

use crate::error::AppError;

/// Opaque handle to a vault opened in this session.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
pub struct VaultHandle {
    /// Session-local identifier; never persisted.
    pub id: u32,
}

/// The canonical vault identity and the handle that owns it for this native
/// session. Frontend callers retain `handle` for every handle-scoped command
/// and use `root` when they need the canonical path identity.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct VaultOpenResult {
    /// Opaque session-local handle for subsequent vault commands.
    pub handle: VaultHandle,
    /// Canonical absolute root accepted by the native vault model.
    pub root: String,
}

/// Entry kind over IPC.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum TreeEntryKind {
    /// A directory.
    Directory,
    /// An editable Markdown or plain-text note.
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

/// One UTF-16 text replacement in a persisted editor transaction.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct EditHistoryChange {
    /// Inclusive UTF-16 offset in the starting document.
    pub from: u32,
    /// Exclusive UTF-16 offset in the starting document.
    pub to: u32,
    /// Replacement text.
    pub insert: String,
}

/// One anchor and head pair in a persisted selection.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct EditHistoryRange {
    /// Selection anchor as a UTF-16 offset.
    pub anchor: u32,
    /// Selection head as a UTF-16 offset.
    pub head: u32,
}

/// A complete persisted selection, including its main range.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct EditHistorySelection {
    /// Every selection range.
    pub ranges: Vec<EditHistoryRange>,
    /// Index of the main range.
    pub main: u32,
}

/// The document identity required before replaying a history direction.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct EditHistoryStateCheck {
    /// Document length in UTF-16 code units.
    pub length: u32,
    /// Lowercase SHA-256 over the UTF-8 editor projection.
    pub projection_hash: String,
}

/// One reversible editor transaction over typed IPC.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct EditHistoryEntry {
    /// Forward changes from the before state to the after state.
    pub changes: Vec<EditHistoryChange>,
    /// Inverse changes from the after state to the before state.
    pub inverse: Vec<EditHistoryChange>,
    /// Selection before the transaction.
    pub selection_before: EditHistorySelection,
    /// Selection after the transaction.
    pub selection_after: EditHistorySelection,
    /// Required state before applying the forward changes.
    pub before: EditHistoryStateCheck,
    /// Required state before applying the inverse changes.
    pub after: EditHistoryStateCheck,
}

/// One logical persistent undo-stack mutation.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum EditHistoryAction {
    /// Adds one transaction and clears the redo branch.
    Entry { entry: EditHistoryEntry },
    /// Moves applied transactions onto the redo stack.
    Undo { count: u32 },
    /// Moves redo transactions back onto the undo stack.
    Redo { count: u32 },
    /// Makes every older transaction unreachable.
    Fence,
}

/// The reachable edit history for one note.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct EditHistorySnapshot {
    /// Applied entries, oldest first.
    pub undo: Vec<EditHistoryEntry>,
    /// Undone entries, with the next redo at the end.
    pub redo: Vec<EditHistoryEntry>,
}

impl From<EditHistoryChange> for skribeum_vault::EditHistoryChange {
    fn from(change: EditHistoryChange) -> Self {
        Self {
            from: change.from,
            to: change.to,
            insert: change.insert,
        }
    }
}

impl From<skribeum_vault::EditHistoryChange> for EditHistoryChange {
    fn from(change: skribeum_vault::EditHistoryChange) -> Self {
        Self {
            from: change.from,
            to: change.to,
            insert: change.insert,
        }
    }
}

impl From<EditHistorySelection> for skribeum_vault::EditHistorySelection {
    fn from(selection: EditHistorySelection) -> Self {
        Self {
            ranges: selection
                .ranges
                .into_iter()
                .map(|range| skribeum_vault::EditHistoryRange {
                    anchor: range.anchor,
                    head: range.head,
                })
                .collect(),
            main: selection.main,
        }
    }
}

impl From<skribeum_vault::EditHistorySelection> for EditHistorySelection {
    fn from(selection: skribeum_vault::EditHistorySelection) -> Self {
        Self {
            ranges: selection
                .ranges
                .into_iter()
                .map(|range| EditHistoryRange {
                    anchor: range.anchor,
                    head: range.head,
                })
                .collect(),
            main: selection.main,
        }
    }
}

impl From<EditHistoryStateCheck> for skribeum_vault::EditHistoryStateCheck {
    fn from(check: EditHistoryStateCheck) -> Self {
        Self {
            length: check.length,
            projection_hash: check.projection_hash,
        }
    }
}

impl From<skribeum_vault::EditHistoryStateCheck> for EditHistoryStateCheck {
    fn from(check: skribeum_vault::EditHistoryStateCheck) -> Self {
        Self {
            length: check.length,
            projection_hash: check.projection_hash,
        }
    }
}

impl From<EditHistoryEntry> for skribeum_vault::EditHistoryEntry {
    fn from(entry: EditHistoryEntry) -> Self {
        Self {
            changes: entry.changes.into_iter().map(Into::into).collect(),
            inverse: entry.inverse.into_iter().map(Into::into).collect(),
            selection_before: entry.selection_before.into(),
            selection_after: entry.selection_after.into(),
            before: entry.before.into(),
            after: entry.after.into(),
        }
    }
}

impl From<skribeum_vault::EditHistoryEntry> for EditHistoryEntry {
    fn from(entry: skribeum_vault::EditHistoryEntry) -> Self {
        Self {
            changes: entry.changes.into_iter().map(Into::into).collect(),
            inverse: entry.inverse.into_iter().map(Into::into).collect(),
            selection_before: entry.selection_before.into(),
            selection_after: entry.selection_after.into(),
            before: entry.before.into(),
            after: entry.after.into(),
        }
    }
}

impl From<EditHistoryAction> for skribeum_vault::EditHistoryAction {
    fn from(action: EditHistoryAction) -> Self {
        match action {
            EditHistoryAction::Entry { entry } => Self::Entry {
                entry: entry.into(),
            },
            EditHistoryAction::Undo { count } => Self::Undo { count },
            EditHistoryAction::Redo { count } => Self::Redo { count },
            EditHistoryAction::Fence => Self::Fence,
        }
    }
}

impl From<skribeum_vault::EditHistorySnapshot> for EditHistorySnapshot {
    fn from(snapshot: skribeum_vault::EditHistorySnapshot) -> Self {
        Self {
            undo: snapshot.undo.into_iter().map(Into::into).collect(),
            redo: snapshot.redo.into_iter().map(Into::into).collect(),
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

/// Filesystem timestamps for one indexed note, serving the statusline's
/// last-edited segment and the note-info popover.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct NoteStat {
    /// Modification time in whole milliseconds since the Unix epoch, absent
    /// when the platform reports none.
    pub modified_ms: Option<f64>,
    /// Creation time in whole milliseconds since the Unix epoch, absent on
    /// filesystems that record none.
    pub created_ms: Option<f64>,
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

/// One tag in the indexed vault with aggregate usage counts.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct TagFrequency {
    /// Tag text without its leading hash.
    pub tag: String,
    /// Number of notes containing the tag.
    pub note_count: u32,
    /// Total inline and frontmatter occurrences across indexed notes.
    pub occurrence_count: u32,
}

/// Result of checking the selected release channel.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum UpdateCheckDoc {
    /// The installed version matches the selected channel manifest.
    Current,
    /// A signed update is available from the selected channel manifest.
    Available {
        /// Version announced by the manifest.
        version: String,
        /// Release notes from the manifest, when supplied.
        notes: String,
    },
}

/// Semantic task status category over IPC.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TaskStatusCategory {
    /// An open task.
    Todo,
    /// Work is underway.
    InProgress,
    /// Work is intentionally paused.
    OnHold,
    /// Work is complete.
    Done,
    /// Work was cancelled.
    Cancelled,
    /// A checkbox-like marker that is not a task.
    NonTask,
}

/// Track that groups a task status by its purpose over IPC.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatusTrack {
    /// Ordinary task state.
    Task,
    /// A dated task state.
    Time,
    /// A task importance marker.
    Importance,
    /// A user-defined reference marker.
    Reference,
}

/// Optional plain-text payload associated with a task status over IPC.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatusPayload {
    /// An Obsidian Tasks date token.
    Date,
    /// An importance-level token.
    Level,
}

/// One configured task marker over IPC.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct TaskStatusDoc {
    /// The single source character between brackets.
    pub symbol: String,
    /// Custom status name, or empty when the frontend resolves a default name.
    pub name: String,
    /// Semantic status category.
    pub category: TaskStatusCategory,
    /// Short glyph rendered inside the checkbox.
    pub glyph: String,
    /// Existing CSS theme custom property used for the status color.
    pub color_token: String,
    /// Symbol written by the default click transition.
    pub next_status: String,
    /// Optional grouping metadata. Absent fields remain absent in settings.
    pub track: Option<TaskStatusTrack>,
    /// Optional payload metadata. Absent fields remain absent in settings.
    pub payload: Option<TaskStatusPayload>,
}

/// The typed settings document over IPC. Unknown keys in the underlying
/// `settings.json` never cross the boundary; they are preserved internally
/// on every write.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[allow(
    clippy::struct_excessive_bools,
    reason = "flat fields mirror the typed settings IPC document"
)]
pub struct SettingsDoc {
    /// Schema version of the document.
    pub schema_version: u32,
    /// Color theme: `system`, `light` or `dark`.
    pub theme: String,
    /// Palette used in light mode.
    pub light_palette: String,
    /// Palette used in dark mode.
    pub dark_palette: String,
    /// Prose font family choice.
    pub prose_font: String,
    /// Code font family choice.
    pub code_font: String,
    /// Editor font size in CSS pixels.
    pub editor_font_size: u32,
    /// Editor line height as a percentage.
    pub editor_line_height: u32,
    /// Editor line width in characters.
    pub editor_line_width: u32,
    /// Application webview zoom as an integer percentage.
    pub zoom_percent: u32,
    /// Whether line numbers appear beside the editor.
    pub show_line_numbers: bool,
    /// Whether interface animations are enabled.
    pub animations: bool,
    /// Idle delay before saving edits, in milliseconds.
    pub autosave_delay_ms: u32,
    /// Whether platform spell checking is enabled.
    pub spell_check: bool,
    /// Indentation uses spaces or tabs.
    pub indent_style: String,
    /// Indentation width in columns.
    pub indent_width: u32,
    /// Whether long lines wrap in the editor.
    pub wrap_long_lines: bool,
    /// Whether whitespace characters are shown.
    pub show_invisible_characters: bool,
    /// Whether Markdown syntax is revealed at the cursor.
    pub reveal_markdown_syntax: bool,
    /// Default folder for new notes, relative to the vault.
    pub default_note_folder: String,
    /// Attachment placement mode.
    pub attachment_folder_mode: String,
    /// Attachment folder, relative to the vault.
    pub attachment_folder_path: String,
    /// Whether supported Obsidian configuration is honored.
    pub honor_obsidian_config: bool,
    /// Maximum number of results a search query returns.
    pub search_result_limit: u32,
    /// Whether note links show rendered previews.
    pub link_previews: bool,
    /// Whether note bodies are included in search.
    pub search_note_bodies: bool,
    /// Whether search matches case sensitively.
    pub search_case_sensitive: bool,
    /// Update release channel.
    pub update_channel: String,
    /// Ordered task marker vocabulary and click-transition graph.
    pub task_statuses: Vec<TaskStatusDoc>,
}

fn task_status_from_vault(status: skribeum_vault::TaskStatus) -> TaskStatusDoc {
    TaskStatusDoc {
        symbol: status.symbol,
        name: status.name,
        category: match status.category {
            skribeum_vault::TaskStatusCategory::Todo => TaskStatusCategory::Todo,
            skribeum_vault::TaskStatusCategory::InProgress => TaskStatusCategory::InProgress,
            skribeum_vault::TaskStatusCategory::OnHold => TaskStatusCategory::OnHold,
            skribeum_vault::TaskStatusCategory::Done => TaskStatusCategory::Done,
            skribeum_vault::TaskStatusCategory::Cancelled => TaskStatusCategory::Cancelled,
            skribeum_vault::TaskStatusCategory::NonTask => TaskStatusCategory::NonTask,
        },
        glyph: status.glyph,
        color_token: status.color_token,
        next_status: status.next_status,
        track: status.track.map(|track| match track {
            skribeum_vault::settings::TaskStatusTrack::Task => TaskStatusTrack::Task,
            skribeum_vault::settings::TaskStatusTrack::Time => TaskStatusTrack::Time,
            skribeum_vault::settings::TaskStatusTrack::Importance => TaskStatusTrack::Importance,
            skribeum_vault::settings::TaskStatusTrack::Reference => TaskStatusTrack::Reference,
        }),
        payload: status.payload.map(|payload| match payload {
            skribeum_vault::settings::TaskStatusPayload::Date => TaskStatusPayload::Date,
            skribeum_vault::settings::TaskStatusPayload::Level => TaskStatusPayload::Level,
        }),
    }
}

fn task_status_into_vault(status: TaskStatusDoc) -> skribeum_vault::TaskStatus {
    skribeum_vault::TaskStatus {
        symbol: status.symbol,
        name: status.name,
        category: match status.category {
            TaskStatusCategory::Todo => skribeum_vault::TaskStatusCategory::Todo,
            TaskStatusCategory::InProgress => skribeum_vault::TaskStatusCategory::InProgress,
            TaskStatusCategory::OnHold => skribeum_vault::TaskStatusCategory::OnHold,
            TaskStatusCategory::Done => skribeum_vault::TaskStatusCategory::Done,
            TaskStatusCategory::Cancelled => skribeum_vault::TaskStatusCategory::Cancelled,
            TaskStatusCategory::NonTask => skribeum_vault::TaskStatusCategory::NonTask,
        },
        glyph: status.glyph,
        color_token: status.color_token,
        next_status: status.next_status,
        track: status.track.map(|track| match track {
            TaskStatusTrack::Task => skribeum_vault::settings::TaskStatusTrack::Task,
            TaskStatusTrack::Time => skribeum_vault::settings::TaskStatusTrack::Time,
            TaskStatusTrack::Importance => skribeum_vault::settings::TaskStatusTrack::Importance,
            TaskStatusTrack::Reference => skribeum_vault::settings::TaskStatusTrack::Reference,
        }),
        payload: status.payload.map(|payload| match payload {
            TaskStatusPayload::Date => skribeum_vault::settings::TaskStatusPayload::Date,
            TaskStatusPayload::Level => skribeum_vault::settings::TaskStatusPayload::Level,
        }),
    }
}

struct OpenVault {
    vault: Vault,
    /// Cleared by `vault_close`; every background worker checks it before
    /// doing more work or publishing an event.
    active: Arc<AtomicBool>,
    /// Serializes publication with close so no event can cross the IPC
    /// boundary after `vault_close` completes.
    publication: Arc<Mutex<()>>,
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
    active_watchers: Arc<AtomicU32>,
    clock: RealClock,
}

impl VaultRegistry {
    fn lock(&self) -> MutexGuard<'_, HashMap<u32, OpenVault>> {
        self.vaults.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn register(&self, vault: Vault, search: Arc<Mutex<Option<SearchIndex>>>) -> VaultOpenResult {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let root = vault.root().to_string_lossy().into_owned();
        self.lock().insert(
            id,
            OpenVault {
                vault,
                active: Arc::new(AtomicBool::new(true)),
                publication: Arc::new(Mutex::new(())),
                watching: Arc::new(AtomicBool::new(false)),
                reconciler: Arc::new(Mutex::new(Reconciler::default())),
                search,
            },
        );
        VaultOpenResult {
            handle: VaultHandle { id },
            root,
        }
    }

    /// Releases one handle's ownership. Missing handles are already closed.
    fn close(&self, handle: VaultHandle) {
        if let Some(open) = self.lock().remove(&handle.id) {
            open.active.store(false, Ordering::Release);
            open.watching.store(false, Ordering::Release);
            let _publication = open
                .publication
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
        }
    }

    #[cfg(test)]
    fn open_count(&self) -> usize {
        self.lock().len()
    }

    #[cfg(test)]
    fn watcher_count(&self) -> u32 {
        self.active_watchers.load(Ordering::Acquire)
    }
}

/// Keeps the registry's watcher count accurate even when a worker returns
/// through an early cancellation branch.
struct WatchLease(Arc<AtomicU32>);

impl WatchLease {
    fn new(count: Arc<AtomicU32>) -> Self {
        count.fetch_add(1, Ordering::AcqRel);
        Self(count)
    }
}

impl Drop for WatchLease {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

struct VaultWatchWorker<R: Runtime> {
    app: AppHandle<R>,
    vault_id: u32,
    root: PathBuf,
    vault: Vault,
    active: Arc<AtomicBool>,
    publication: Arc<Mutex<()>>,
    reconciler: Arc<Mutex<Reconciler>>,
    search: Arc<Mutex<Option<SearchIndex>>>,
    edit_history: Option<EditHistoryJournal>,
    clock: RealClock,
    active_watchers: Arc<AtomicU32>,
    watcher: Box<dyn skribeum_vault::Watcher>,
}

impl<R: Runtime> VaultWatchWorker<R> {
    fn run(mut self) {
        let _lease = WatchLease::new(self.active_watchers);
        loop {
            if !self.active.load(Ordering::Acquire) {
                return;
            }
            let mut delivered_any = false;
            while let Some(event) = self.watcher.try_next() {
                if !self.active.load(Ordering::Acquire) {
                    return;
                }
                delivered_any = true;
                let now = self.clock.now();
                let Some(change) = translate_event(self.vault_id, &self.root, event) else {
                    continue;
                };
                {
                    let mut recon = self
                        .reconciler
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner);
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
                {
                    if let Some(index) = self
                        .search
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .as_ref()
                    {
                        let _ = index.remove_note(path);
                    }
                    if matches!(change.change, VaultChangeKind::Renamed)
                        && let Some(journal) = &self.edit_history
                    {
                        let _ = journal.remove_note(&RealFs, &self.root, path);
                    }
                }
                if !emit_for_open_vault(
                    &self.app,
                    &self.active,
                    &self.publication,
                    VaultChanged::NAME,
                    change,
                ) {
                    return;
                }
            }
            if !self.active.load(Ordering::Acquire) {
                return;
            }
            let events = {
                let mut recon = self
                    .reconciler
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner);
                recon.poll(&RealFs, &self.root, self.clock.now())
            };
            for event in events {
                if !self.active.load(Ordering::Acquire) {
                    return;
                }
                apply_external_recon_state(
                    &self.vault,
                    self.edit_history.as_ref(),
                    &self.root,
                    &event,
                );
                // External changes update the search index incrementally:
                // updates re-read and re-index, removals drop the row.
                if let Some(index) = self
                    .search
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .as_ref()
                {
                    let _ = index.apply_recon_event(&RealFs, &self.root, &event);
                }
                if !emit_recon_event(
                    &self.app,
                    self.vault_id,
                    event,
                    &self.active,
                    &self.publication,
                ) {
                    return;
                }
            }
            if !delivered_any {
                // Polling cadence for the OS watcher queue. Reconciliation
                // debounce logic runs on the Clock trait, not this interval.
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }
}

/// Emits while the handle is still active. Holding the publication lock makes
/// close a linearization point: after close returns, no worker can publish.
fn publish_if_open<Result>(
    active: &AtomicBool,
    publication: &Mutex<()>,
    publish: impl FnOnce() -> Result,
) -> Option<Result> {
    let _publication = publication.lock().unwrap_or_else(PoisonError::into_inner);
    active.load(Ordering::Acquire).then(publish)
}

fn emit_for_open_vault<R: Runtime, Payload: Serialize + Clone>(
    app: &AppHandle<R>,
    active: &AtomicBool,
    publication: &Mutex<()>,
    event: &str,
    payload: Payload,
) -> bool {
    publish_if_open(active, publication, || app.emit(event, payload))
        .is_some_and(|result| result.is_ok())
}

/// The crash journal, enabled by default and living in the OS app-data
/// directory (see `skribeum_vault::journal`). Absent only when the app-data
/// directory could not be resolved, in which case saves proceed without
/// journal protection.
pub struct JournalState(pub Option<Journal>);

/// Durable per-note undo history in the OS app-data directory.
pub struct EditHistoryState(pub Option<EditHistoryJournal>);

/// The settings store, at `settings.json` in the OS app-config directory.
/// Absent only when that directory could not be resolved.
pub struct SettingsState(pub Option<SettingsStore>, pub Mutex<()>);

/// The device-local startup-vault session store, separate from settings.
/// Absent only when the OS app-config directory could not be resolved.
pub struct VaultSessionState(pub Option<VaultSessionStore>, pub Mutex<()>);

/// File paths waiting for the frontend to resolve after an open-with request.
#[derive(Default)]
pub struct OpenFilesState(pub Mutex<Vec<String>>);

/// Whether the main window has completed its first reveal. Set by
/// `window_ready` and by every fallback reveal path, so the startup
/// watchdog and the Linux warmup never fight an already-visible window.
#[derive(Default)]
pub struct WindowRevealState(pub AtomicBool);

const OPEN_FILE_QUEUE_LIMIT: usize = 128;

/// A file-open request is waiting in the Rust-owned queue.
#[derive(Debug, Clone, Serialize, specta::Type, Event)]
pub struct OpenFilesAvailable;

/// The persisted zoom changed and every application window now uses it.
#[derive(Debug, Clone, Serialize, specta::Type, Event)]
pub struct SettingsZoomChanged {
    /// Effective webview zoom as an integer percentage.
    pub zoom_percent: u32,
}

/// A native macOS menu bar item registered against a command registry id was
/// clicked (design system section 4.13); the frontend runs the matching
/// command through the same registry every other surface uses.
#[derive(Debug, Clone, Serialize, specta::Type, Event)]
pub struct MenuCommandInvoked {
    /// The command registry id carried by the clicked menu item.
    pub command: String,
}

/// The native hover and press state of the Windows Maximize caption button
/// (design system section 4.13). Emitted only on Windows: a genuine
/// `WM_NCHITTEST` result of `HTMAXBUTTON` routes real pointer input away
/// from the webview entirely, so the button's own CSS `:hover` and
/// `:active` never fire once native hit-testing answers for that area, and
/// this event carries the highlight and press state back instead.
#[derive(Debug, Clone, Copy, Serialize, specta::Type, Event)]
pub struct MaximizeButtonHitState {
    /// Whether the cursor is currently over the button's reported
    /// rectangle.
    pub hovered: bool,
    /// Whether the primary button is currently held down over the button.
    pub pressed: bool,
}

/// Vault and note selected for one operating-system open-with path.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct OpenFileTarget {
    /// Absolute vault root to open or retain.
    pub vault_path: String,
    /// Vault-relative note path to select.
    pub note_path: String,
}

/// The typed startup-vault session document. It is independent of
/// `settings.json` so selecting a vault never changes user preferences.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct VaultSessionDoc {
    /// Schema version of the document.
    pub schema_version: u32,
    /// Canonical root selected for automatic startup recovery, if any.
    pub last_vault: Option<String>,
    /// Canonical vault roots ordered newest first.
    pub recent_vaults: Vec<String>,
}

/// Queues validated native paths and wakes the frontend without placing paths
/// in event payloads.
pub(crate) fn queue_open_files<R: Runtime>(app: &AppHandle<R>, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    let state = app.state::<OpenFilesState>();
    let mut queue = state.0.lock().unwrap_or_else(PoisonError::into_inner);
    let initial_length = queue.len();
    for path in paths {
        if queue.len() >= OPEN_FILE_QUEUE_LIMIT {
            break;
        }
        if !queue.contains(&path) {
            queue.push(path);
        }
    }
    let changed = queue.len() != initial_length;
    drop(queue);
    if changed {
        let _ = app.emit(OpenFilesAvailable::NAME, OpenFilesAvailable);
    }
}

fn settings_to_doc(settings: Settings) -> SettingsDoc {
    SettingsDoc {
        schema_version: settings.schema_version,
        theme: settings.theme,
        light_palette: settings.light_palette,
        dark_palette: settings.dark_palette,
        prose_font: settings.prose_font,
        code_font: settings.code_font,
        editor_font_size: settings.editor_font_size,
        editor_line_height: settings.editor_line_height,
        editor_line_width: settings.editor_line_width,
        zoom_percent: settings.zoom_percent,
        show_line_numbers: settings.show_line_numbers,
        animations: settings.animations,
        autosave_delay_ms: settings.autosave_delay_ms,
        spell_check: settings.spell_check,
        indent_style: settings.indent_style,
        indent_width: settings.indent_width,
        wrap_long_lines: settings.wrap_long_lines,
        show_invisible_characters: settings.show_invisible_characters,
        reveal_markdown_syntax: settings.reveal_markdown_syntax,
        default_note_folder: settings.default_note_folder,
        attachment_folder_mode: settings.attachment_folder_mode,
        attachment_folder_path: settings.attachment_folder_path,
        honor_obsidian_config: settings.honor_obsidian_config,
        search_result_limit: settings.search_result_limit,
        link_previews: settings.link_previews,
        search_note_bodies: settings.search_note_bodies,
        search_case_sensitive: settings.search_case_sensitive,
        update_channel: settings.update_channel,
        task_statuses: settings
            .task_statuses
            .into_iter()
            .map(task_status_from_vault)
            .collect(),
    }
}

fn settings_from_doc(doc: SettingsDoc) -> Settings {
    Settings {
        schema_version: doc.schema_version,
        theme: doc.theme,
        light_palette: doc.light_palette,
        dark_palette: doc.dark_palette,
        prose_font: doc.prose_font,
        code_font: doc.code_font,
        editor_font_size: doc.editor_font_size,
        editor_line_height: doc.editor_line_height,
        editor_line_width: doc.editor_line_width,
        zoom_percent: doc.zoom_percent,
        show_line_numbers: doc.show_line_numbers,
        animations: doc.animations,
        autosave_delay_ms: doc.autosave_delay_ms,
        spell_check: doc.spell_check,
        indent_style: doc.indent_style,
        indent_width: doc.indent_width,
        wrap_long_lines: doc.wrap_long_lines,
        show_invisible_characters: doc.show_invisible_characters,
        reveal_markdown_syntax: doc.reveal_markdown_syntax,
        default_note_folder: doc.default_note_folder,
        attachment_folder_mode: doc.attachment_folder_mode,
        attachment_folder_path: doc.attachment_folder_path,
        honor_obsidian_config: doc.honor_obsidian_config,
        search_result_limit: doc.search_result_limit,
        link_previews: doc.link_previews,
        search_note_bodies: doc.search_note_bodies,
        search_case_sensitive: doc.search_case_sensitive,
        update_channel: doc.update_channel,
        task_statuses: doc
            .task_statuses
            .into_iter()
            .map(task_status_into_vault)
            .collect(),
    }
}

fn vault_session_to_doc(session: VaultSession) -> VaultSessionDoc {
    VaultSessionDoc {
        schema_version: session.schema_version,
        last_vault: session.last_vault,
        recent_vaults: session.recent_vaults,
    }
}

fn record_opened_vault(
    fs: &dyn FileSystem,
    session: Option<&VaultSessionStore>,
    vault: &Vault,
) -> Result<(), AppError> {
    if let Some(session) = session {
        session.record_opened(fs, vault.root())?;
    }
    Ok(())
}

fn set_all_window_zoom<R: Runtime>(app: &AppHandle<R>, zoom_percent: u32) -> Result<(), AppError> {
    skribeum_vault::validate_zoom_percent(zoom_percent).map_err(AppError::from)?;
    let factor = f64::from(zoom_percent) / 100.0;
    let mut first_error = None;
    for window in app.webview_windows().values() {
        if let Err(error) = window.set_zoom(factor)
            && first_error.is_none()
        {
            first_error = Some(AppError::window_failed(error.to_string()));
        }
    }
    if let Some(error) = first_error {
        return Err(error);
    }
    Ok(())
}

fn change_all_window_zoom<R: Runtime>(
    app: &AppHandle<R>,
    previous_percent: u32,
    zoom_percent: u32,
) -> Result<(), AppError> {
    if let Err(error) = set_all_window_zoom(app, zoom_percent) {
        if let Err(rollback_error) = set_all_window_zoom(app, previous_percent) {
            return Err(AppError::window_failed(format!(
                "failed to apply zoom: {}; failed to restore the previous zoom: {}",
                error.message, rollback_error.message
            )));
        }
        return Err(error);
    }
    Ok(())
}

/// Rebuilds a vault's search index on a background thread. The index reads
/// notes only; a rebuild never writes inside the vault. The function returns
/// after the worker acquires the index lock, so a subsequent query waits for
/// the complete rebuild instead of racing ahead of it.
fn spawn_index_rebuild(
    search: &Arc<Mutex<Option<SearchIndex>>>,
    vault: Vault,
    active: Arc<AtomicBool>,
) {
    let search = Arc::clone(search);
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        if !active.load(Ordering::Acquire) {
            let _ = started_tx.send(());
            return;
        }
        let guard = search.lock().unwrap_or_else(PoisonError::into_inner);
        let _ = started_tx.send(());
        if active.load(Ordering::Acquire)
            && let Some(index) = guard.as_ref()
        {
            #[cfg(debug_assertions)]
            let rebuilt = index.rebuild(&RealFs, &vault).is_ok();
            #[cfg(not(debug_assertions))]
            let _ = index.rebuild(&RealFs, &vault);
            #[cfg(debug_assertions)]
            if rebuilt
                && active.load(Ordering::Acquire)
                && let Some(process_ms) = crate::cold_start_elapsed_milliseconds()
            {
                eprintln!(
                    "SKRIBEUM_COLD_START {{\"event\":\"full-text-index-complete\",\"process_ms\":{process_ms}}}"
                );
            }
        }
    });
    let _ = started_rx.recv();
}

/// Opens a vault at an absolute path, validates it and indexes its tree.
/// This is the only command that accepts an absolute path.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)] // Tauri commands take owned arguments.
fn vault_open<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, VaultRegistry>,
    session: State<'_, VaultSessionState>,
    path: String,
) -> Result<VaultOpenResult, AppError> {
    let vault = Vault::open(&RealFs, Path::new(&path))?;
    let mutation = session.1.lock().unwrap_or_else(PoisonError::into_inner);
    // Startup recovery is best effort. A read-only, full, or inaccessible
    // device-local session store never invalidates a successfully opened vault.
    let _ = record_opened_vault(&RealFs, session.0.as_ref(), &vault);
    drop(mutation);
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
    let result = registry.register(vault.clone(), search.clone());
    let active = {
        let vaults = registry.lock();
        Arc::clone(&vaults[&result.handle.id].active)
    };
    spawn_index_rebuild(&search, vault, active);
    if !groups.is_empty() {
        let (active, publication) = {
            let vaults = registry.lock();
            let open = &vaults[&result.handle.id];
            (Arc::clone(&open.active), Arc::clone(&open.publication))
        };
        let _ = emit_for_open_vault(
            &app,
            &active,
            &publication,
            VaultCollisionsDetected::NAME,
            VaultCollisionsDetected {
                vault: result.handle.id,
                groups,
            },
        );
    }
    Ok(result)
}

/// Releases a native vault handle. Repeating the close is harmless so a
/// superseded frontend open can always clean up its provisional handle.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)] // Tauri commands take owned arguments.
fn vault_close(registry: State<'_, VaultRegistry>, handle: VaultHandle) {
    registry.close(handle);
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
    let (entries, groups, search, vault, active, publication) = {
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
            Arc::clone(&open.active),
            Arc::clone(&open.publication),
        )
    };
    spawn_index_rebuild(&search, vault, Arc::clone(&active));
    if !groups.is_empty() {
        let _ = emit_for_open_vault(
            &app,
            &active,
            &publication,
            VaultCollisionsDetected::NAME,
            VaultCollisionsDetected {
                vault: handle.id,
                groups,
            },
        );
    }
    Ok(entries)
}

/// Creates an empty Markdown note at a vault-relative path without
/// overwriting an existing file. Missing parent folders are created inside
/// the vault, and the in-memory tree and search index update immediately.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)] // Tauri commands take owned arguments.
fn note_create(
    registry: State<'_, VaultRegistry>,
    handle: VaultHandle,
    rel_path: String,
) -> Result<(), AppError> {
    let path = VaultPath::new(&rel_path)?;
    let search = {
        let mut vaults = registry.lock();
        let open = vaults
            .get_mut(&handle.id)
            .ok_or_else(AppError::unknown_handle)?;
        open.vault
            .create_note(&RealFs, &path)
            .map_err(|error| AppError::from(error).with_path(path.as_str()))?;
        Arc::clone(&open.search)
    };
    if let Some(index) = search
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .as_ref()
    {
        index
            .index_note(path.as_str(), b"")
            .map_err(AppError::from)?;
    }
    Ok(())
}

/// Creates a folder inside an open vault and returns the refreshed tree.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)]
fn tree_folder_create(
    registry: State<'_, VaultRegistry>,
    handle: VaultHandle,
    rel_path: String,
) -> Result<Vec<TreeEntry>, AppError> {
    let path = VaultPath::new(&rel_path)?;
    let (entries, search, vault, active) = {
        let mut vaults = registry.lock();
        let open = vaults
            .get_mut(&handle.id)
            .ok_or_else(AppError::unknown_handle)?;
        open.vault
            .create_directory(&RealFs, &path)
            .map_err(|error| AppError::from(error).with_path(path.as_str()))?;
        (
            tree_entries(&open.vault),
            Arc::clone(&open.search),
            open.vault.clone(),
            Arc::clone(&open.active),
        )
    };
    spawn_index_rebuild(&search, vault, active);
    Ok(entries)
}

/// Moves or renames one vault entry without replacing an existing entry.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)]
fn tree_entry_move(
    registry: State<'_, VaultRegistry>,
    handle: VaultHandle,
    from_path: String,
    to_path: String,
) -> Result<Vec<TreeEntry>, AppError> {
    let from = VaultPath::new(&from_path)?;
    let to = VaultPath::new(&to_path)?;
    let (entries, search, vault, active) = {
        let mut vaults = registry.lock();
        let open = vaults
            .get_mut(&handle.id)
            .ok_or_else(AppError::unknown_handle)?;
        open.vault
            .move_entry(&RealFs, &from, &to)
            .map_err(|error| AppError::from(error).with_path(from.as_str()))?;
        (
            tree_entries(&open.vault),
            Arc::clone(&open.search),
            open.vault.clone(),
            Arc::clone(&open.active),
        )
    };
    spawn_index_rebuild(&search, vault, active);
    Ok(entries)
}

/// Deletes one vault entry and returns the refreshed tree.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)]
fn tree_entry_delete(
    registry: State<'_, VaultRegistry>,
    handle: VaultHandle,
    rel_path: String,
) -> Result<Vec<TreeEntry>, AppError> {
    let path = VaultPath::new(&rel_path)?;
    let (entries, search, vault, active) = {
        let mut vaults = registry.lock();
        let open = vaults
            .get_mut(&handle.id)
            .ok_or_else(AppError::unknown_handle)?;
        open.vault
            .delete_entry(&RealFs, &path)
            .map_err(|error| AppError::from(error).with_path(path.as_str()))?;
        (
            tree_entries(&open.vault),
            Arc::clone(&open.search),
            open.vault.clone(),
            Arc::clone(&open.active),
        )
    };
    spawn_index_rebuild(&search, vault, active);
    Ok(entries)
}

/// Reveals one indexed entry in the operating system file manager.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)]
fn tree_entry_reveal(
    registry: State<'_, VaultRegistry>,
    handle: VaultHandle,
    rel_path: String,
) -> Result<(), AppError> {
    let path = VaultPath::new(&rel_path)?;
    let absolute = {
        let vaults = registry.lock();
        let open = vaults
            .get(&handle.id)
            .ok_or_else(AppError::unknown_handle)?;
        if !open.vault.tree().iter().any(|entry| entry.path == path) {
            return Err(
                AppError::from(skribeum_vault::VaultError::EntryNotFound).with_path(path.as_str())
            );
        }
        open.vault.root().join(path.as_str())
    };
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("explorer")
        .arg(format!("/select,{}", absolute.display()))
        .spawn();
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open")
        .arg("-R")
        .arg(&absolute)
        .spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = std::process::Command::new("xdg-open")
        .arg(absolute.parent().unwrap_or(&absolute))
        .spawn();
    result
        .map(|_| ())
        .map_err(|error| AppError::window_failed(error.to_string()))
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

/// Converts an epoch duration into whole milliseconds as a JSON number.
fn epoch_milliseconds(duration: Duration) -> f64 {
    #[allow(clippy::cast_precision_loss)] // Millisecond epochs stay far below 2^53.
    let milliseconds = duration.as_millis() as f64;
    milliseconds
}

/// Reads the creation and modification timestamps of one indexed note. The
/// path resolves through the vault index exactly like `note_read`, so no
/// unindexed path is ever statted.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)] // Tauri commands take owned arguments.
fn note_stat(
    registry: State<'_, VaultRegistry>,
    handle: VaultHandle,
    rel_path: String,
) -> Result<NoteStat, AppError> {
    let path = VaultPath::new(&rel_path)?;
    let vaults = registry.lock();
    let open = vaults
        .get(&handle.id)
        .ok_or_else(AppError::unknown_handle)?;
    let entry = open
        .vault
        .tree()
        .iter()
        .find(|entry| entry.path == path)
        .ok_or_else(|| {
            AppError::from(skribeum_vault::VaultError::NoteNotFound).with_path(path.as_str())
        })?;
    if entry.kind != EntryKind::Note {
        return Err(AppError::from(skribeum_vault::VaultError::NotANote).with_path(path.as_str()));
    }
    let absolute = open.vault.root().join(path.as_str());
    let metadata = RealFs.metadata(&absolute).map_err(|error| AppError {
        code: "note/stat",
        message: format!("failed to read note metadata: {error}"),
        path: Some(path.as_str().to_owned()),
    })?;
    Ok(NoteStat {
        modified_ms: (metadata.mtime > Duration::ZERO).then(|| epoch_milliseconds(metadata.mtime)),
        created_ms: metadata.created.map(epoch_milliseconds),
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

/// Overwrites one indexed non-note file's full contents. The canvas board
/// is the only editable consumer today: a card move, add, or remove
/// rewrites the whole document rather than a change-set, so this command
/// carries no projection-hash conflict check the way `note_write` does for
/// prose. It never creates editor or reconciliation state and never
/// touches search indexing, matching `vault_file_read`'s scope on the
/// write side.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)]
fn vault_file_write(
    registry: State<'_, VaultRegistry>,
    handle: VaultHandle,
    rel_path: String,
    bytes: Vec<u8>,
) -> Result<(), AppError> {
    let path = VaultPath::new(&rel_path)?;
    let vaults = registry.lock();
    let open = vaults
        .get(&handle.id)
        .ok_or_else(AppError::unknown_handle)?;
    open.vault
        .write_file(&RealFs, &path, &bytes)
        .map_err(|error| AppError::from(error).with_path(path.as_str()))?;
    Ok(())
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

    let (response, search_update) = match result {
        skribeum_vault::WriteResult::Written { projection_hash } => {
            if let Some(journal) = &journal.0 {
                let _ = journal.append_commit(&RealFs, &root, path.as_str(), &projection_hash);
            }
            if let Some(base) = open.vault.note_base(&path) {
                open.reconciler
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .record_write(&path, &base.bytes, registry.clock.now());
                (
                    WriteResult::Written {
                        projection_hash: projection_hash.clone(),
                    },
                    Some((Arc::clone(&open.search), base.bytes)),
                )
            } else {
                (
                    WriteResult::Written {
                        projection_hash: projection_hash.clone(),
                    },
                    None,
                )
            }
        }
        skribeum_vault::WriteResult::Conflict {
            current_projection_hash,
            reconciliation,
        } => (
            WriteResult::Conflict {
                current_projection_hash,
                reconciliation,
            },
            None,
        ),
    };
    drop(vaults);
    if let Some((search, bytes)) = search_update
        && let Some(index) = search
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
    {
        let _ = index.index_note(path.as_str(), &bytes);
    }
    Ok(response)
}

/// Reads one note's reachable persistent undo and redo stacks.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)]
fn edit_history_read(
    registry: State<'_, VaultRegistry>,
    history: State<'_, EditHistoryState>,
    handle: VaultHandle,
    rel_path: String,
) -> Result<EditHistorySnapshot, AppError> {
    let path = VaultPath::new(&rel_path)?;
    let vaults = registry.lock();
    let open = vaults
        .get(&handle.id)
        .ok_or_else(AppError::unknown_handle)?;
    let snapshot = history
        .0
        .as_ref()
        .map_or_else(skribeum_vault::EditHistorySnapshot::default, |journal| {
            journal.read(&RealFs, open.vault.root(), path.as_str())
        });
    Ok(snapshot.into())
}

/// Appends and fsyncs a batch before the note save it describes begins.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)]
fn edit_history_append(
    registry: State<'_, VaultRegistry>,
    history: State<'_, EditHistoryState>,
    handle: VaultHandle,
    rel_path: String,
    batch: String,
    actions: Vec<EditHistoryAction>,
) -> Result<(), AppError> {
    let path = VaultPath::new(&rel_path)?;
    let vaults = registry.lock();
    let open = vaults
        .get(&handle.id)
        .ok_or_else(AppError::unknown_handle)?;
    let journal = history
        .0
        .as_ref()
        .ok_or_else(AppError::edit_history_unavailable)?;
    let actions = actions.into_iter().map(Into::into).collect::<Vec<_>>();
    journal
        .append(&RealFs, open.vault.root(), path.as_str(), &batch, &actions)
        .map_err(|error| AppError::from(error).with_path(path.as_str()))
}

/// Appends an external-ingest fence for one note.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)]
fn edit_history_fence(
    registry: State<'_, VaultRegistry>,
    history: State<'_, EditHistoryState>,
    handle: VaultHandle,
    rel_path: String,
    batch: String,
) -> Result<(), AppError> {
    edit_history_append(
        registry,
        history,
        handle,
        rel_path,
        batch,
        vec![EditHistoryAction::Fence],
    )
}

/// Physically removes one note's persisted edit history.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)]
fn edit_history_clear(
    registry: State<'_, VaultRegistry>,
    history: State<'_, EditHistoryState>,
    handle: VaultHandle,
    rel_path: String,
) -> Result<(), AppError> {
    let path = VaultPath::new(&rel_path)?;
    let vaults = registry.lock();
    let open = vaults
        .get(&handle.id)
        .ok_or_else(AppError::unknown_handle)?;
    let Some(journal) = &history.0 else {
        return Ok(());
    };
    journal
        .remove_note(&RealFs, open.vault.root(), path.as_str())
        .map_err(|error| AppError::from(error).with_path(path.as_str()))
}

fn apply_external_recon_state(
    vault: &Vault,
    edit_history: Option<&EditHistoryJournal>,
    root: &Path,
    event: &ReconEvent,
) {
    match event {
        ReconEvent::ExternalUpdate {
            path,
            projection_hash,
            change_set,
        } => {
            let _ = vault.ingest_external_note(path, change_set, projection_hash);
        }
        ReconEvent::ExternalRemove { path } => {
            if let Some(journal) = edit_history {
                let _ = journal.remove_note(&RealFs, root, path.as_str());
            }
        }
        _ => {}
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
    edit_history: State<'_, EditHistoryState>,
    handle: VaultHandle,
) -> Result<(), AppError> {
    let (root, vault, active, publication, watching, reconciler, search, clock, active_watchers) = {
        let vaults = registry.lock();
        let open = vaults
            .get(&handle.id)
            .ok_or_else(AppError::unknown_handle)?;
        (
            open.vault.root().to_owned(),
            open.vault.clone(),
            Arc::clone(&open.active),
            Arc::clone(&open.publication),
            Arc::clone(&open.watching),
            Arc::clone(&open.reconciler),
            Arc::clone(&open.search),
            registry.clock,
            Arc::clone(&registry.active_watchers),
        )
    };
    if !active.load(Ordering::Acquire) {
        return Err(AppError::unknown_handle());
    }
    if watching.swap(true, Ordering::SeqCst) {
        return Ok(());
    }

    // Replay the crash journal for this vault now that the editor side is
    // listening: recovered chains arrive as deltas against the on-disk
    // bytes, a changed-on-disk chain surfaces the reconciliation banner and
    // is never applied silently.
    if let Some(journal) = &journal.0 {
        replay_journal(&app, journal, handle.id, &root, &active, &publication);
    }
    if !active.load(Ordering::Acquire) {
        watching.store(false, Ordering::Release);
        return Ok(());
    }
    if let Some(journal) = &edit_history.0 {
        let _ = journal.garbage_collect(&RealFs, &root);
    }

    let watcher = RealFs.watch(&root).map_err(|error| AppError {
        code: "fs/io",
        message: format!("failed to start the vault watcher: {error}"),
        path: None,
    })?;
    if !active.load(Ordering::Acquire) {
        watching.store(false, Ordering::Release);
        return Ok(());
    }

    let worker = VaultWatchWorker {
        app,
        vault_id: handle.id,
        root,
        vault,
        active,
        publication,
        reconciler,
        search,
        edit_history: edit_history.0.clone(),
        clock,
        active_watchers,
        watcher,
    };
    std::thread::spawn(move || worker.run());
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
    search_note_bodies: bool,
    case_sensitive: bool,
) -> Result<Vec<SearchHit>, AppError> {
    const MAX_QUERY_BYTES: usize = 512;
    const MAX_QUERY_TERMS: usize = 16;
    const MAX_SEARCH_RESULTS: u32 = 1000;
    if query.len() > MAX_QUERY_BYTES
        || query.split_whitespace().count() > MAX_QUERY_TERMS
        || !(1..=MAX_SEARCH_RESULTS).contains(&limit)
    {
        return Err(AppError::search_invalid());
    }
    let search = {
        let vaults = registry.lock();
        let open = vaults
            .get(&handle.id)
            .ok_or_else(AppError::unknown_handle)?;
        Arc::clone(&open.search)
    };
    let guard = search.lock().unwrap_or_else(PoisonError::into_inner);
    let index = guard.as_ref().ok_or_else(AppError::search_unavailable)?;
    let hits = index
        .query_with_options(&query, limit, search_note_bodies, case_sensitive)
        .map_err(AppError::from)?;
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

/// Returns the indexed vault tag catalog with aggregate usage counts.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)] // Tauri commands take owned arguments.
fn tag_catalog(
    registry: State<'_, VaultRegistry>,
    handle: VaultHandle,
) -> Result<Vec<TagFrequency>, AppError> {
    let search = {
        let vaults = registry.lock();
        let open = vaults
            .get(&handle.id)
            .ok_or_else(AppError::unknown_handle)?;
        Arc::clone(&open.search)
    };
    let guard = search.lock().unwrap_or_else(PoisonError::into_inner);
    let index = guard.as_ref().ok_or_else(AppError::search_unavailable)?;
    let tags = index.tag_frequencies().map_err(AppError::from)?;
    Ok(tags
        .into_iter()
        .map(|entry| TagFrequency {
            tag: entry.tag,
            note_count: entry.note_count,
            occurrence_count: entry.occurrence_count,
        })
        .collect())
}

/// Checks the signed manifest for the selected release channel.
#[cfg(any(not(feature = "webdriver"), test))]
fn update_manifest_names(channel: &str) -> Option<&'static [&'static str]> {
    match channel {
        "stable" => Some(&["latest.json"]),
        "beta" => Some(&["beta.json", "latest.json"]),
        _ => None,
    }
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)] // Tauri commands take owned arguments.
async fn update_check(app: AppHandle, channel: String) -> Result<UpdateCheckDoc, AppError> {
    #[cfg(feature = "webdriver")]
    {
        let _ = (app, channel);
        return Err(AppError::update_failed(
            "update checks are unavailable in the WebDriver build",
        ));
    }

    #[cfg(not(feature = "webdriver"))]
    {
        let manifests = update_manifest_names(&channel)
            .ok_or_else(|| AppError::update_failed("unknown update channel"))?;
        let endpoints = manifests
            .iter()
            .map(|manifest| {
                format!(
                    "https://github.com/morgaesis/skribeum/releases/download/updater/{manifest}"
                )
                .parse::<tauri::Url>()
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| AppError::update_failed(error.to_string()))?;
        let updater = app
            .updater_builder()
            .endpoints(endpoints)
            .map_err(|error| AppError::update_failed(error.to_string()))?
            .build()
            .map_err(|error| AppError::update_failed(error.to_string()))?;
        match updater
            .check()
            .await
            .map_err(|error| AppError::update_failed(error.to_string()))?
        {
            Some(update) => Ok(UpdateCheckDoc::Available {
                version: update.version,
                notes: update.body.unwrap_or_default(),
            }),
            None => Ok(UpdateCheckDoc::Current),
        }
    }
}

#[cfg(test)]
mod update_tests {
    use super::update_manifest_names;

    #[test]
    fn beta_checks_the_stable_manifest_when_no_beta_is_published() {
        assert_eq!(
            update_manifest_names("beta"),
            Some(["beta.json", "latest.json"].as_slice())
        );
        assert_eq!(
            update_manifest_names("stable"),
            Some(["latest.json"].as_slice())
        );
        assert_eq!(update_manifest_names("nightly"), None);
    }
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
    Ok(settings_to_doc(doc))
}

/// Reads the device-local startup-vault session. Missing or corrupt documents
/// safely return an empty session.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)] // Tauri commands take owned arguments.
fn vault_session_read(session: State<'_, VaultSessionState>) -> Result<VaultSessionDoc, AppError> {
    let store = session
        .0
        .as_ref()
        .ok_or_else(AppError::vault_session_unavailable)?;
    Ok(vault_session_to_doc(store.read(&RealFs)?))
}

/// Forgets an explicitly selected stale vault candidate. Failed opens stay
/// recorded until the frontend deliberately calls this command.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)] // Tauri commands take owned arguments.
fn vault_session_forget(
    session: State<'_, VaultSessionState>,
    path: String,
) -> Result<VaultSessionDoc, AppError> {
    let _mutation = session.1.lock().unwrap_or_else(PoisonError::into_inner);
    let store = session
        .0
        .as_ref()
        .ok_or_else(AppError::vault_session_unavailable)?;
    Ok(vault_session_to_doc(store.forget(&RealFs, &path)?))
}

/// Clears only the authoritative startup selection while retaining recent
/// choices. Startup policy can still select one remaining recent vault.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)] // Tauri commands take owned arguments.
fn vault_session_clear_last(
    session: State<'_, VaultSessionState>,
) -> Result<VaultSessionDoc, AppError> {
    let _mutation = session.1.lock().unwrap_or_else(PoisonError::into_inner);
    let store = session
        .0
        .as_ref()
        .ok_or_else(AppError::vault_session_unavailable)?;
    Ok(vault_session_to_doc(store.clear_last(&RealFs)?))
}

/// Returns the resolved settings document path for display in the settings
/// footer and About section.
#[tauri::command]
#[specta::specta]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri commands extract managed state by value"
)]
fn settings_path(settings: State<'_, SettingsState>) -> Result<String, AppError> {
    let store = settings
        .0
        .as_ref()
        .ok_or_else(AppError::settings_unavailable)?;
    Ok(store.path().to_string_lossy().into_owned())
}

/// Writes the settings document whole. Values are validated first, and
/// unknown keys already present in the file are preserved, so settings
/// written by a newer build survive a round trip through this one.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)] // Tauri commands take owned arguments.
fn settings_write(settings: State<'_, SettingsState>, doc: SettingsDoc) -> Result<(), AppError> {
    let _mutation = settings.1.lock().unwrap_or_else(PoisonError::into_inner);
    let store = settings
        .0
        .as_ref()
        .ok_or_else(AppError::settings_unavailable)?;
    let mut document = settings_from_doc(doc);
    document.zoom_percent = store.read(&RealFs).map_err(AppError::from)?.zoom_percent;
    store.write(&RealFs, &document).map_err(AppError::from)?;
    Ok(())
}

/// Persists and applies one webview zoom percentage to every window.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)]
fn zoom_set<R: Runtime>(
    app: AppHandle<R>,
    settings: State<'_, SettingsState>,
    zoom_percent: u32,
) -> Result<u32, AppError> {
    skribeum_vault::validate_zoom_percent(zoom_percent).map_err(AppError::from)?;
    let _mutation = settings.1.lock().unwrap_or_else(PoisonError::into_inner);
    let store = settings
        .0
        .as_ref()
        .ok_or_else(AppError::settings_unavailable)?;
    let mut document = store.read(&RealFs).map_err(AppError::from)?;
    let previous_document = document.clone();
    let previous_percent = document.zoom_percent;
    change_all_window_zoom(&app, previous_percent, zoom_percent)?;
    document.zoom_percent = zoom_percent;
    if let Err(error) = store.write(&RealFs, &document) {
        if let Err(rollback_error) = set_all_window_zoom(&app, previous_percent) {
            return Err(AppError::window_failed(format!(
                "failed to persist zoom: {error}; failed to restore the previous zoom: {}",
                rollback_error.message
            )));
        }
        return Err(AppError::from(error));
    }
    if let Err(error) = app.emit(
        SettingsZoomChanged::NAME,
        SettingsZoomChanged { zoom_percent },
    ) {
        let persistence_rollback = store.write(&RealFs, &previous_document);
        let window_rollback = set_all_window_zoom(&app, previous_percent);
        if let Err(rollback_error) = persistence_rollback {
            return Err(AppError::window_failed(format!(
                "failed to publish zoom state: {error}; failed to restore persisted zoom: {rollback_error}"
            )));
        }
        if let Err(rollback_error) = window_rollback {
            return Err(AppError::window_failed(format!(
                "failed to publish zoom state: {error}; failed to restore the previous zoom: {}",
                rollback_error.message
            )));
        }
        return Err(AppError::window_failed(format!(
            "failed to publish zoom state: {error}"
        )));
    }
    Ok(zoom_percent)
}

#[cfg(target_os = "linux")]
fn cancel_window_warmup<R: Runtime>(window: &WebviewWindow<R>) {
    let _ = window.hide();
    let _ = window.center();
    let _ = window.set_skip_taskbar(false);
}

/// How long the native watchdog waits for the frontend to call
/// `window_ready` before revealing the window itself. Long enough for a
/// slow cold boot (webview start, fonts, first paint) to finish normally,
/// short enough that a broken frontend degrades to a visible window
/// instead of an invisible process.
pub const STARTUP_REVEAL_DEADLINE: Duration = Duration::from_secs(5);

/// Moves the main window from its hidden or Linux offscreen-warmup state to
/// its real visible position. Shared by `window_ready`, the startup reveal
/// watchdog, and forwarded second launches so every reveal lands at the
/// same place, never the warmup slot.
fn reveal_window<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), AppError> {
    #[cfg(target_os = "linux")]
    {
        if let Err(error) = window.center() {
            cancel_window_warmup(window);
            return Err(AppError::window_failed(error.to_string()));
        }
        if let Err(error) = window.set_skip_taskbar(false) {
            cancel_window_warmup(window);
            return Err(AppError::window_failed(error.to_string()));
        }
    }
    if let Err(error) = window.show() {
        #[cfg(target_os = "linux")]
        cancel_window_warmup(window);
        return Err(AppError::window_failed(error.to_string()));
    }
    Ok(())
}

/// Reveals the main window unless `window_ready` already has. The startup
/// watchdog calls this after [`STARTUP_REVEAL_DEADLINE`] so any frontend
/// boot failure still produces a visible window; on the normal path the
/// flag is already set and this does nothing. The reveal hops to the main
/// thread: on Linux, window calls from a plain thread are dropped by GTK.
pub fn reveal_main_window_if_pending<R: Runtime>(app: &AppHandle<R>) {
    let revealed = app.state::<WindowRevealState>();
    if revealed.0.swap(true, Ordering::AcqRel) {
        return;
    }
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window("main") {
            let _ = reveal_window(&window);
        }
    });
}

/// Reveals (when hidden) and focuses the main window for a forwarded
/// launch, so a second launch always surfaces the running instance, even
/// while its frontend is still booting.
pub fn focus_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        if !window.is_visible().unwrap_or(false) && reveal_window(&window).is_ok() {
            app.state::<WindowRevealState>()
                .0
                .store(true, Ordering::Release);
        }
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Resolves the zoom percentage to apply before the first reveal. Reveal
/// must never block on settings state: an unreadable or corrupt store falls
/// back to the default zoom and reports the error for the caller to surface
/// once the window is visible.
fn startup_zoom_percent(
    store: Option<&SettingsStore>,
    fs: &dyn FileSystem,
) -> (u32, Option<SettingsError>) {
    match store.map(|store| store.read(fs)) {
        Some(Ok(document)) => (document.zoom_percent, None),
        Some(Err(error)) => (Settings::default().zoom_percent, Some(error)),
        None => (Settings::default().zoom_percent, None),
    }
}

#[cfg(test)]
mod vault_session_tests {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex, mpsc};
    use std::time::Duration;

    use super::{VaultRegistry, WatchLease, publish_if_open, record_opened_vault};
    use skribeum_vault::{SearchIndex, SimFs, Vault, VaultSession, VaultSessionStore};

    #[test]
    fn only_a_successful_open_records_the_canonical_vault_root() {
        let fs = SimFs::new();
        fs.external_create_dir(&PathBuf::from("/config"));
        fs.external_create_dir(&PathBuf::from("/vaults/real"));
        fs.external_symlink(Path::new("/vaults/link"), Path::new("/vaults/real"));
        let store = VaultSessionStore::new(Path::new("/config/vault-session"));

        assert!(Vault::open(&fs, Path::new("/vaults/missing")).is_err());
        assert_eq!(
            store.read(&fs).expect("session reads"),
            VaultSession::default()
        );

        let vault = Vault::open(&fs, Path::new("/vaults/link")).expect("vault opens");
        record_opened_vault(&fs, Some(&store), &vault).expect("opened vault records");

        let session = store.read(&fs).expect("session rereads");
        assert_eq!(session.last_vault.as_deref(), Some("/vaults/real"));
        assert_eq!(session.recent_vaults, ["/vaults/real"]);
    }

    #[test]
    fn session_persistence_failure_does_not_prevent_canonical_registration() {
        let fs = SimFs::new();
        fs.external_create_dir(&PathBuf::from("/config"));
        fs.external_create_dir(&PathBuf::from("/vaults/real"));
        let store = VaultSessionStore::new(Path::new("/config/vault-session"));
        let vault = Vault::open(&fs, Path::new("/vaults/real")).expect("vault opens");
        fs.set_read_only(true);

        assert!(record_opened_vault(&fs, Some(&store), &vault).is_err());

        let registry = VaultRegistry::default();
        let opened = registry.register(vault, Arc::new(Mutex::new(None::<SearchIndex>)));
        assert_eq!(opened.root, "/vaults/real");
        assert_eq!(registry.open_count(), 1);

        registry.close(opened.handle);
        assert_eq!(registry.open_count(), 0);
    }

    #[test]
    fn repeated_close_releases_registry_and_watcher_ownership_promptly() {
        let fs = SimFs::new();
        fs.external_create_dir(&PathBuf::from("/vaults/real"));
        let vault = Vault::open(&fs, Path::new("/vaults/real")).expect("vault opens");
        let registry = Arc::new(VaultRegistry::default());
        let opened = registry.register(vault, Arc::new(Mutex::new(None::<SearchIndex>)));
        let (active, watcher_count) = {
            let vaults = registry.lock();
            let open = vaults.get(&opened.handle.id).expect("registered vault");
            (
                Arc::clone(&open.active),
                Arc::clone(&registry.active_watchers),
            )
        };
        let (started_tx, started_rx) = mpsc::channel();
        let (stopped_tx, stopped_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _lease = WatchLease::new(watcher_count);
            let _ = started_tx.send(());
            while active.load(Ordering::Acquire) {
                std::thread::sleep(Duration::from_millis(1));
            }
            let _ = stopped_tx.send(());
        });
        started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("watch worker starts");
        assert_eq!(registry.watcher_count(), 1);

        registry.close(opened.handle);
        registry.close(opened.handle);
        stopped_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("watch worker stops promptly after close");
        worker.join().expect("watch worker exits after close");

        assert_eq!(registry.open_count(), 0);
        assert_eq!(registry.watcher_count(), 0);
    }

    #[test]
    fn close_blocks_publication_from_in_progress_workers() {
        let active = Arc::new(AtomicBool::new(true));
        let publication = Arc::new(Mutex::new(()));
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let worker_active = Arc::clone(&active);
        let worker_publication = Arc::clone(&publication);
        let worker = std::thread::spawn(move || {
            publish_if_open(&worker_active, &worker_publication, || {
                let _ = entered_tx.send(());
                release_rx.recv().expect("publication releases");
            })
        });
        entered_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("worker reaches publication gate");

        let (close_started_tx, close_started_rx) = mpsc::channel();
        let close_active = Arc::clone(&active);
        let close_publication = Arc::clone(&publication);
        let closer = std::thread::spawn(move || {
            close_active.store(false, Ordering::Release);
            let _ = close_started_tx.send(());
            let _guard = close_publication.lock().expect("publication lock");
        });
        close_started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("close begins before publication releases");
        release_tx.send(()).expect("worker releases publication");
        worker.join().expect("worker exits");
        closer.join().expect("close waits for publication");

        assert!(
            publish_if_open(&active, &publication, || ()).is_none(),
            "closed workers must not publish"
        );
    }
}

/// Gives Linux `WebKit` an offscreen frame in which to commit its first
/// paint. A no-op once the window is already revealed, so a late warmup can
/// never drag a visible window back to the offscreen slot.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value, clippy::unnecessary_wraps)] // Tauri commands keep one typed result signature across every platform.
fn window_warmup<R: Runtime>(
    #[cfg_attr(not(target_os = "linux"), allow(unused_variables))] window: WebviewWindow<R>,
    #[cfg_attr(not(target_os = "linux"), allow(unused_variables))] revealed: State<
        '_,
        WindowRevealState,
    >,
) -> Result<(), AppError> {
    #[cfg(target_os = "linux")]
    {
        if revealed.0.load(Ordering::Acquire) {
            return Ok(());
        }
        window
            .set_skip_taskbar(true)
            .map_err(|error| AppError::window_failed(error.to_string()))?;
        if let Err(error) = window.set_position(tauri::PhysicalPosition::new(32_000, 32_000)) {
            cancel_window_warmup(&window);
            return Err(AppError::window_failed(error.to_string()));
        }
        if let Err(error) = window.show() {
            cancel_window_warmup(&window);
            return Err(AppError::window_failed(error.to_string()));
        }
    }
    Ok(())
}

/// Applies persisted zoom before revealing the first committed frontend
/// render. Reveal is unconditional: a corrupt settings store or a failed
/// zoom application falls back to defaults and the window still shows, with
/// the degraded state reported only after the window is visible.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)]
fn window_ready<R: Runtime>(
    window: WebviewWindow<R>,
    settings: State<'_, SettingsState>,
    revealed: State<'_, WindowRevealState>,
    webview_ms: Option<f64>,
) -> Result<(), AppError> {
    let _mutation = settings.1.lock().unwrap_or_else(PoisonError::into_inner);
    let (zoom_percent, settings_error) = startup_zoom_percent(settings.0.as_ref(), &RealFs);
    let zoom_error = window
        .set_zoom(f64::from(zoom_percent) / 100.0)
        .err()
        .map(|error| AppError::window_failed(error.to_string()));
    reveal_window(&window)?;
    revealed.0.store(true, Ordering::Release);
    #[cfg(debug_assertions)]
    if let Some(process_ms) = crate::cold_start_elapsed_milliseconds() {
        eprintln!(
            "SKRIBEUM_COLD_START {{\"event\":\"first-editor-paint\",\"process_ms\":{process_ms},\"webview_ms\":{}}}",
            webview_ms.unwrap_or_default()
        );
    }
    if let Some(error) = settings_error {
        return Err(AppError::from(error));
    }
    if let Some(error) = zoom_error {
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod window_reveal_tests {
    use super::startup_zoom_percent;
    use skribeum_vault::{Settings, SettingsError, SettingsStore, SimFs};
    use std::path::PathBuf;

    #[test]
    fn corrupt_settings_fall_back_to_the_default_zoom_and_report_it() {
        let fs = SimFs::new();
        let path = PathBuf::from("config/settings.json");
        fs.external_write(&path, b"[]");
        let store = SettingsStore::new(path);

        let (zoom, error) = startup_zoom_percent(Some(&store), &fs);
        assert_eq!(zoom, Settings::default().zoom_percent);
        assert!(matches!(error, Some(SettingsError::Corrupt)));
    }

    #[test]
    fn a_missing_store_or_file_uses_the_default_zoom_without_error() {
        let fs = SimFs::new();
        let (zoom, error) = startup_zoom_percent(None, &fs);
        assert_eq!(zoom, Settings::default().zoom_percent);
        assert!(error.is_none());

        let store = SettingsStore::new(PathBuf::from("config/settings.json"));
        let (zoom, error) = startup_zoom_percent(Some(&store), &fs);
        assert_eq!(zoom, Settings::default().zoom_percent);
        assert!(error.is_none());
    }
}

/// Shows the window menu at the pointer, for the header's drag-region
/// right-click (design system section 4.13: "Right-clicking it opens the
/// system window menu where the platform provides one"). On Windows this is
/// the real platform system menu (`GetSystemMenu` and `TrackPopupMenu`),
/// carrying Move, Size, and keyboard-driven resize alongside Minimize,
/// Maximize or Restore, and Close; every other platform keeps the
/// predefined-item approximation, built fresh per call so it always
/// reflects the window's current state.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)]
fn window_show_system_menu<R: Runtime>(window: tauri::Window<R>) -> Result<(), AppError> {
    #[cfg(target_os = "windows")]
    {
        crate::windows_chrome::show_system_menu(&window).map_err(AppError::window_failed)
    }
    #[cfg(not(target_os = "windows"))]
    {
        use tauri::menu::{ContextMenu, Menu, PredefinedMenuItem};

        let menu = Menu::with_items(
            &window,
            &[
                &PredefinedMenuItem::minimize(&window, None).map_err(|e| window_menu_error(&e))?,
                &PredefinedMenuItem::maximize(&window, None).map_err(|e| window_menu_error(&e))?,
                &PredefinedMenuItem::separator(&window).map_err(|e| window_menu_error(&e))?,
                &PredefinedMenuItem::close_window(&window, None)
                    .map_err(|e| window_menu_error(&e))?,
            ],
        )
        .map_err(|e| window_menu_error(&e))?;
        menu.popup(window).map_err(|e| window_menu_error(&e))
    }
}

/// Reports the Maximize caption button's current rectangle in physical
/// pixels from the client area's top-left corner (design system section
/// 4.13), keeping Windows native hit-testing in sync with the webview's own
/// layout so Windows 11 snap layouts appear on hover and hold over the
/// button, not somewhere it used to be. The webview calls this whenever the
/// button's own layout changes and with `None` when it should stop
/// answering the hit test at all (window teardown). A no-op everywhere
/// except Windows.
#[tauri::command]
#[specta::specta]
#[allow(
    clippy::needless_pass_by_value,
    clippy::unnecessary_wraps,
    reason = "the Result shape matches every other void IPC command's typed-error contract, \
              even though this one happens to be infallible on every platform"
)]
fn window_set_maximize_button_rect<R: Runtime>(
    window: tauri::Window<R>,
    rect: Option<crate::window_hit_test::MaximizeButtonRect>,
) -> Result<(), AppError> {
    #[cfg(target_os = "windows")]
    crate::windows_chrome::set_maximize_button_rect(&window, rect);
    #[cfg(not(target_os = "windows"))]
    let _ = (&window, rect);
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn window_menu_error(error: &tauri::Error) -> AppError {
    AppError::window_failed(error.to_string())
}

fn supported_open_file(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("md")
                || extension.eq_ignore_ascii_case("markdown")
                || extension.eq_ignore_ascii_case("txt")
        })
}

fn relative_note_path(path: &Path) -> Result<String, AppError> {
    let path = path
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/");
    VaultPath::new(&path).map_err(AppError::from)?;
    Ok(path)
}

fn resolve_open_file_target(
    file: &Path,
    known_roots: impl IntoIterator<Item = PathBuf>,
) -> Result<OpenFileTarget, AppError> {
    let root = known_roots
        .into_iter()
        .filter(|root| file.starts_with(root))
        .max_by_key(|root| root.components().count())
        .unwrap_or_else(|| {
            file.parent()
                .expect("a canonical file has a parent")
                .to_path_buf()
        });
    let relative = file
        .strip_prefix(&root)
        .map_err(|_| AppError::open_file_invalid())?;
    Ok(OpenFileTarget {
        vault_path: root.to_string_lossy().into_owned(),
        note_path: relative_note_path(relative)?,
    })
}

#[cfg(test)]
mod open_file_tests {
    use super::resolve_open_file_target;

    #[test]
    fn known_vaults_win_and_other_files_adopt_their_parent() {
        let scratch =
            std::env::temp_dir().join(format!("skribeum-open-target-{}", std::process::id()));
        let known = scratch.join("known");
        let nested = known.join("nested");
        let known_file = nested.join("note.md");
        let outside = scratch.join("outside");
        let outside_file = outside.join("plain.txt");

        let target = resolve_open_file_target(&known_file, [known, nested.clone()])
            .expect("known target resolves");
        assert_eq!(target.vault_path, nested.to_string_lossy());
        assert_eq!(target.note_path, "note.md");

        let target = resolve_open_file_target(&outside_file, []).expect("outside target resolves");
        assert_eq!(target.vault_path, outside.to_string_lossy());
        assert_eq!(target.note_path, "plain.txt");
    }
}

/// Resolves one operating-system open-with path against known vault roots.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)]
fn file_open_resolve(
    registry: State<'_, VaultRegistry>,
    path: String,
) -> Result<OpenFileTarget, AppError> {
    let file = RealFs
        .canonicalize(&PathBuf::from(path))
        .map_err(|_| AppError::open_file_invalid())?;
    if !RealFs
        .metadata(&file)
        .is_ok_and(|metadata| !metadata.is_dir)
        || !supported_open_file(&file)
    {
        return Err(AppError::open_file_invalid());
    }

    let known_roots = registry
        .lock()
        .values()
        .map(|open| open.vault.root().to_path_buf())
        .collect::<Vec<_>>();
    resolve_open_file_target(&file, known_roots)
}

/// Drains operating-system open-with paths queued by argv or open-file events.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value, clippy::unnecessary_wraps)] // Tauri injects State by value, and typed IPC keeps a fallible command shape.
fn open_files_take(state: State<'_, OpenFilesState>) -> Result<Vec<String>, AppError> {
    let mut paths = state.0.lock().unwrap_or_else(PoisonError::into_inner);
    Ok(std::mem::take(&mut *paths))
}

/// Replays the crash journal for one vault, emitting recovery deltas and
/// divergence banners.
fn replay_journal<R: Runtime>(
    app: &AppHandle<R>,
    journal: &Journal,
    vault: u32,
    root: &Path,
    active: &Arc<AtomicBool>,
    publication: &Arc<Mutex<()>>,
) {
    for outcome in journal.replay(&RealFs, root) {
        if !active.load(Ordering::Acquire) {
            return;
        }
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
                let _ = emit_for_open_vault(
                    app,
                    active,
                    publication,
                    NoteRecovered::NAME,
                    NoteRecovered {
                        vault,
                        path: rel_path,
                        change_set: to_ipc_changes(&change_set),
                        projection_hash,
                    },
                );
            }
            ReplayOutcome::Diverged {
                rel_path,
                disk_hash,
            } => {
                let _ = emit_for_open_vault(
                    app,
                    active,
                    publication,
                    ReconciliationBanner::NAME,
                    ReconciliationBanner {
                        vault,
                        path: rel_path,
                        reason: BannerReason::JournalDiverged,
                        disk_hash,
                    },
                );
            }
            ReplayOutcome::Clean { .. } => {}
        }
    }
}

/// Emits one typed reconciliation event; false when the app is shutting
/// down.
fn emit_recon_event<R: Runtime>(
    app: &AppHandle<R>,
    vault: u32,
    event: ReconEvent,
    active: &Arc<AtomicBool>,
    publication: &Arc<Mutex<()>>,
) -> bool {
    match event {
        ReconEvent::ExternalUpdate {
            path,
            projection_hash,
            change_set,
        } => emit_for_open_vault(
            app,
            active,
            publication,
            ExternalNoteUpdate::NAME,
            ExternalNoteUpdate {
                vault,
                path: path.as_str().to_owned(),
                projection_hash,
                change_set: to_ipc_changes(&change_set),
            },
        ),
        ReconEvent::ExternalRemove { path } => emit_for_open_vault(
            app,
            active,
            publication,
            ExternalNoteRemove::NAME,
            ExternalNoteRemove {
                vault,
                path: path.as_str().to_owned(),
            },
        ),
        ReconEvent::Banner {
            path,
            reason,
            disk_hash,
        } => emit_for_open_vault(
            app,
            active,
            publication,
            ReconciliationBanner::NAME,
            ReconciliationBanner {
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
            },
        ),
        ReconEvent::BulkDivergence { paths } => emit_for_open_vault(
            app,
            active,
            publication,
            BulkDivergenceReview::NAME,
            BulkDivergenceReview {
                vault,
                paths: paths.iter().map(|p| p.as_str().to_owned()).collect(),
            },
        ),
    }
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
            vault_close,
            vault_session_read,
            vault_session_forget,
            vault_session_clear_last,
            vault_tree,
            vault_tree_refresh::<tauri::Wry>,
            note_create,
            tree_folder_create,
            tree_entry_move,
            tree_entry_delete,
            tree_entry_reveal,
            note_read,
            note_stat,
            vault_file_read,
            vault_file_write,
            note_write,
            edit_history_read,
            edit_history_append,
            edit_history_fence,
            edit_history_clear,
            watch_subscribe::<tauri::Wry>,
            search_query,
            tag_catalog,
            update_check,
            settings_read,
            settings_path,
            settings_write,
            zoom_set::<tauri::Wry>,
            window_warmup::<tauri::Wry>,
            window_ready::<tauri::Wry>,
            window_show_system_menu::<tauri::Wry>,
            window_set_maximize_button_rect::<tauri::Wry>,
            file_open_resolve,
            open_files_take,
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
            OpenFilesAvailable,
            SettingsZoomChanged,
            MenuCommandInvoked,
            MaximizeButtonHitState,
        ])
}
