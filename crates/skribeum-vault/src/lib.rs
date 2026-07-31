//! Vault filesystem access. All filesystem and clock access in this crate
//! goes through the traits in [`fs`], so vault and reconciliation logic runs
//! identically under the seeded deterministic simulator ([`sim`]) and on the
//! real filesystem ([`real`]). Direct `std::fs` use is confined to [`real`]
//! and enforced by a committed guard test.

pub mod fs;
pub mod path;
pub mod real;
pub mod sim;
pub mod vault;

pub use fs::{Clock, DirEntry, FileMetadata, FileSystem, FsError, WatchEvent, Watcher};
pub use path::{PathCollision, VaultPath, VaultPathError, detect_collisions};
pub use real::{RealClock, RealFs};
pub use sim::{NetworkProfile, Scheduler, SchedulerOp, SimClock, SimFs};
pub use vault::{
    Encoding, EntryKind, NoteContent, TreeEntry, Vault, VaultError, classify, is_indexed_path,
};
