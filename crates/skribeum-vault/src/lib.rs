//! Vault filesystem access. All filesystem and clock access in this crate
//! goes through the traits in [`fs`], so vault and reconciliation logic runs
//! identically under the seeded deterministic simulator ([`sim`]) and on the
//! real filesystem ([`real`]). Direct `std::fs` use is confined to [`real`]
//! and enforced by a committed guard test.

pub mod fs;
pub mod journal;
pub mod path;
pub mod real;
pub mod recon;
pub mod search;
pub mod settings;
pub mod sim;
pub mod vault;
pub mod write;

pub use fs::{Clock, DirEntry, FileMetadata, FileSystem, FsError, WatchEvent, Watcher};
pub use journal::{JOURNAL_FILE_NAME, Journal, JournalError, ReplayOutcome};
pub use path::{PathCollision, VaultPath, VaultPathError, detect_collisions};
pub use real::{RealClock, RealFs};
pub use recon::{BannerReason, ReconEvent, Reconciler, ReconcilerConfig};
pub use search::{SEARCH_SCHEMA_VERSION, SearchError, SearchHit, SearchIndex, index_file_name};
pub use settings::{
    SETTINGS_FILE_NAME, SETTINGS_SCHEMA_VERSION, Settings, SettingsError, SettingsStore,
};
pub use sim::{
    NetworkProfile, Scheduler, SchedulerOp, SimClock, SimFs, SimKill, install_quiet_kill_hook,
};
pub use vault::{
    ConflictInfo, Encoding, EntryKind, NoteContent, TreeEntry, Vault, VaultError, WriteResult,
    classify, is_indexed_path,
};
pub use write::{WRITE_TEMP_PREFIX, is_write_temp_name, write_durable, write_temp_path};
