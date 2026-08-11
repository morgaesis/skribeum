//! Vault filesystem access. All filesystem and clock access in this crate
//! goes through the traits in [`fs`], so vault and reconciliation logic runs
//! identically under the seeded deterministic simulator ([`sim`]) and on the
//! real filesystem ([`real`]). Direct `std::fs` use is confined to [`real`]
//! and enforced by a committed guard test.

pub mod edit_history;
pub mod fs;
pub mod journal;
pub mod path;
pub mod real;
pub mod recon;
pub mod search;
pub mod settings;
pub mod sim;
pub mod vault;
pub mod vault_session;
pub mod write;

pub use edit_history::{
    DEFAULT_EDIT_HISTORY_ENTRY_CAP, DEFAULT_EDIT_HISTORY_NOTE_CAP_BYTES, EDIT_HISTORY_FILE_NAME,
    EditHistoryAction, EditHistoryChange, EditHistoryEntry, EditHistoryError, EditHistoryJournal,
    EditHistoryRange, EditHistorySelection, EditHistorySnapshot, EditHistoryStateCheck,
};
pub use fs::{Clock, DirEntry, FileMetadata, FileSystem, FsError, WatchEvent, Watcher};
pub use journal::{JOURNAL_FILE_NAME, Journal, JournalError, ReplayOutcome};
pub use path::{PathCollision, VaultPath, VaultPathError, detect_collisions};
pub use real::{RealClock, RealFs};
pub use recon::{BannerReason, ReconEvent, Reconciler, ReconcilerConfig};
pub use search::{
    SEARCH_SCHEMA_VERSION, SearchError, SearchHit, SearchIndex, TagFrequency, index_file_name,
};
pub use settings::{
    SETTINGS_FILE_NAME, SETTINGS_SCHEMA_VERSION, Settings, SettingsError, SettingsStore,
    TaskStatus, TaskStatusCategory, ZOOM_PERCENT_RANGE, ZOOM_PERCENT_STEP, default_task_statuses,
    validate_zoom_percent,
};
pub use sim::{
    NetworkProfile, Scheduler, SchedulerOp, SimClock, SimFs, SimKill, install_quiet_kill_hook,
};
pub use vault::{
    ConflictInfo, Encoding, EntryKind, NoteContent, TreeEntry, Vault, VaultError, WriteResult,
    classify, is_indexed_path,
};
pub use vault_session::{
    MAX_RECENT_VAULTS, VAULT_SESSION_FILE_NAME, VAULT_SESSION_SCHEMA_VERSION, VaultSession,
    VaultSessionError, VaultSessionStore,
};
pub use write::{WRITE_TEMP_PREFIX, is_write_temp_name, write_durable, write_temp_path};
