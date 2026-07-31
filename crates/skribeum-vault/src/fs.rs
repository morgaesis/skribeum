//! Filesystem and clock abstractions. Every vault operation goes through
//! these traits so reconciliation logic runs identically under the seeded
//! deterministic simulator and against the real filesystem. Only
//! [`crate::real`] touches the operating system.

use std::path::{Path, PathBuf};
use std::time::Duration;

/// Errors surfaced by [`FileSystem`] implementations. The simulator and the
/// real implementation map their failures onto the same variants so logic
/// written against the trait observes one error model.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FsError {
    /// The path does not exist.
    #[error("path not found")]
    NotFound,
    /// A directory was expected but the path is a file, or the reverse.
    #[error("unexpected file type")]
    NotADirectory,
    /// The vault is opened read-only and a mutating operation was attempted.
    #[error("vault is read-only")]
    ReadOnly,
    /// Any other I/O failure, with a short description that never contains
    /// file content.
    #[error("i/o failure: {0}")]
    Io(String),
}

/// Metadata for a single filesystem entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileMetadata {
    /// Size in bytes; zero for directories.
    pub size: u64,
    /// Modification time as a duration since the Unix epoch. The simulator
    /// synthesizes this deterministically from its logical tick counter.
    pub mtime: Duration,
    /// Whether the entry is a directory.
    pub is_dir: bool,
}

/// One entry of a directory listing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirEntry {
    /// Absolute path of the entry.
    pub path: PathBuf,
    /// Final path component as the filesystem reported it, before any
    /// normalization. Unicode normalization happens in the vault model, which
    /// needs the raw form to detect collisions.
    pub file_name: String,
    /// Whether the entry is a directory.
    pub is_dir: bool,
}

/// A change observed by a watcher. Coalescing and loss are part of the model:
/// consumers must treat `Overflow` as "state unknown, rescan" and must never
/// assume every write produces exactly one event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchEvent {
    /// A file or directory appeared.
    Created(PathBuf),
    /// File content changed. Consecutive modifications may be coalesced into
    /// a single event.
    Modified(PathBuf),
    /// A file or directory disappeared.
    Removed(PathBuf),
    /// A rename with both endpoints known. Platforms that report renames as
    /// separate remove/create pairs deliver those instead.
    Renamed {
        /// Previous path.
        from: PathBuf,
        /// New path.
        to: PathBuf,
    },
    /// The event queue overflowed and an unknown number of events were lost.
    /// The only correct response is a full rescan.
    Overflow,
}

/// A subscription to filesystem changes under a watched root.
pub trait Watcher: Send {
    /// Returns the next pending event, or `None` when the queue is currently
    /// empty. Non-blocking; callers poll on their own schedule so tests never
    /// wait on real time.
    fn try_next(&mut self) -> Option<WatchEvent>;
}

/// Filesystem operations the vault layer is allowed to perform. Object-safe
/// so the simulator and the real implementation interchange behind
/// `&dyn FileSystem`.
#[allow(clippy::missing_errors_doc)] // Every method fails with `FsError`, documented on the type.
pub trait FileSystem: Send + Sync {
    /// Reads the full content of a file as bytes.
    fn read(&self, path: &Path) -> Result<Vec<u8>, FsError>;

    /// Atomically replaces the content of `path` with `bytes`. The real
    /// implementation writes a temporary file and renames it over the target;
    /// the simulator models the same all-or-nothing semantics.
    fn write_atomic(&self, path: &Path, bytes: &[u8]) -> Result<(), FsError>;

    /// Renames `from` to `to`.
    fn rename(&self, from: &Path, to: &Path) -> Result<(), FsError>;

    /// Removes a file.
    fn remove_file(&self, path: &Path) -> Result<(), FsError>;

    /// Creates a directory, including missing parents.
    fn create_dir_all(&self, path: &Path) -> Result<(), FsError>;

    /// Returns metadata for a path.
    fn metadata(&self, path: &Path) -> Result<FileMetadata, FsError>;

    /// Lists the entries of a directory.
    fn read_dir(&self, path: &Path) -> Result<Vec<DirEntry>, FsError>;

    /// Subscribes to change events under `root`.
    fn watch(&self, root: &Path) -> Result<Box<dyn Watcher>, FsError>;
}

/// A monotonic clock. Debounce and settle logic reads time only through this
/// trait, which is what lets the simulator drive timers deterministically.
pub trait Clock: Send + Sync {
    /// Monotonic time elapsed since an arbitrary fixed origin.
    fn now(&self) -> Duration;
}
