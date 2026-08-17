//! The vault model: opening a vault, indexing its tree, reading notes and
//! writing them through the crash-safe change-set path. Everything here
//! runs against the [`FileSystem`](crate::fs::FileSystem) trait, so the
//! same code paths execute under the deterministic simulator and on the
//! real filesystem. Opening a vault performs zero writes; the simulator
//! asserts that mechanically.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use sha2::{Digest, Sha256};
use skribeum_core::{ByteRangeReplace, ChangeSetError, apply_change_set};

use crate::fs::{FileSystem, FsError};
use crate::path::{PathCollision, VaultPath, VaultPathError, detect_collisions};
use crate::write::{is_write_temp_name, write_durable};

/// Errors surfaced by vault operations.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum VaultError {
    /// The vault root does not exist.
    #[error("vault root not found")]
    RootNotFound,
    /// The vault root is not a directory.
    #[error("vault root is not a directory")]
    RootNotADirectory,
    /// A path failed vault path validation.
    #[error("invalid vault path: {0}")]
    Path(#[from] VaultPathError),
    /// The requested note is not in the vault index.
    #[error("note not found in vault")]
    NoteNotFound,
    /// A new note path already exists.
    #[error("note already exists in vault")]
    NoteAlreadyExists,
    /// A requested tree entry is not indexed.
    #[error("vault entry not found")]
    EntryNotFound,
    /// A tree mutation would replace an existing entry.
    #[error("vault entry already exists")]
    EntryAlreadyExists,
    /// The requested path exists in the index but is not an editable note.
    #[error("path is not a note")]
    NotANote,
    /// The requested path exists in the index but is not a plain file (it
    /// names a note or a directory).
    #[error("path is not a plain file")]
    NotAFile,
    /// A write was attempted for a note this session never read; the
    /// change-set base is unknown.
    #[error("note was never read in this session")]
    NoteNotRead,
    /// The note is not valid UTF-8 and is never written.
    #[error("note is read-only")]
    NoteReadOnly,
    /// The expected projection hash does not match the base this session
    /// last read; the caller is out of sync with its own read.
    #[error("expected hash does not match the last-read base")]
    BaseMismatch,
    /// The change set is structurally invalid against the base.
    #[error(transparent)]
    ChangeSet(#[from] ChangeSetError),
    /// A filesystem operation failed.
    #[error(transparent)]
    Fs(#[from] FsError),
}

/// The result of a note write. On projection-hash mismatch the write
/// returns the conflict variant carrying the current on-disk hash plus a
/// reconciliation handle, the entry point of the reconciliation UX; the
/// on-disk file is never overwritten on conflict.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteResult {
    /// The change set was applied and durably written.
    Written {
        /// Projection hash of the new on-disk bytes.
        projection_hash: String,
    },
    /// The on-disk projection no longer matches `expected_projection_hash`.
    Conflict {
        /// The current on-disk projection hash; absent when the file is
        /// gone.
        current_projection_hash: Option<String>,
        /// Handle for the reconciliation flow; resolves through
        /// [`Vault::conflict`].
        reconciliation: u32,
    },
}

/// A registered write conflict awaiting reconciliation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConflictInfo {
    /// The conflicted note.
    pub path: VaultPath,
    /// Projection hash this session expected.
    pub expected_projection_hash: String,
    /// The on-disk projection hash observed at conflict time, absent when
    /// the file was gone.
    pub current_projection_hash: Option<String>,
}

/// What kind of entry a tree row is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    /// A directory.
    Directory,
    /// A Markdown or plain-text note: parsed as prose, indexed for search,
    /// and resolvable as a link target.
    Note,
    /// Any other file. Never parsed as prose and never indexed for search,
    /// but read and written through the same byte-faithful change-set path
    /// notes use ([`Vault::read_note`], [`Vault::write_note`]). A registered
    /// render-only view (the canvas board) instead replaces one whole
    /// through [`Vault::write_file`].
    File,
}

/// One row of the vault tree, sorted by path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeEntry {
    /// Vault-relative path.
    pub path: VaultPath,
    /// Entry kind.
    pub kind: EntryKind,
    /// Whether the final segment starts with a dot. Hidden entries are listed
    /// and typed, never silently dropped.
    pub hidden: bool,
}

/// How a note's bytes classify for editing purposes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Encoding {
    /// Valid UTF-8 without a byte-order mark.
    Utf8,
    /// Valid UTF-8 preceded by an EF BB BF byte-order mark. The mark is part
    /// of the returned bytes and is preserved byte-for-byte on any write.
    Utf8Bom,
    /// Not valid UTF-8. The note opens read-only and is never written.
    NonUtf8,
}

/// The result of reading a note: raw bytes, their classification and the
/// projection hash the reconciliation layer tracks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteContent {
    /// The exact on-disk bytes, byte-order mark included.
    pub bytes: Vec<u8>,
    /// Encoding classification.
    pub encoding: Encoding,
    /// Lowercase hex SHA-256 of `bytes`. Opaque to callers.
    pub projection_hash: String,
}

/// An open vault: the validated root, the indexed tree, the last-read
/// bytes of notes (the change-set base for writes) and registered write
/// conflicts.
#[derive(Debug, Clone)]
pub struct Vault {
    root: PathBuf,
    tree: Vec<TreeEntry>,
    collisions: Vec<PathCollision>,
    notes: Arc<Mutex<HashMap<VaultPath, NoteContent>>>,
    conflicts: Arc<Mutex<(u32, HashMap<u32, ConflictInfo>)>>,
}

/// Directory names excluded from indexing and watching, per the
/// reconciliation design: sync-tool internals, VCS state, Obsidian
/// configuration (consulted read-only later, never indexed) and Skribeum's
/// own vault-local state.
const EXCLUDED_DIRECTORIES: &[&str] = &[
    ".git",
    ".obsidian",
    ".skribeum",
    ".stfolder",
    ".stversions",
    ".tmp.drivedownload",
];

/// File names excluded from indexing.
const EXCLUDED_FILES: &[&str] = &[".stignore", "4913"];

/// Whether a file name ends in `.tmp`, case-insensitively.
fn has_tmp_extension(name: &str) -> bool {
    name.len() > 4 && name[name.len() - 4..].eq_ignore_ascii_case(".tmp")
}

/// Whether a file name matches an excluded editor-temp or sync-artifact
/// pattern, including this application's own write-sequence temp files.
fn is_excluded_file(name: &str) -> bool {
    EXCLUDED_FILES.contains(&name)
        || is_write_temp_name(name)
        || name.contains(".sync-conflict-")
        || name.starts_with(".goutputstream-")
        || name.starts_with(".~lock.")
        || (name.starts_with(".syncthing.") && has_tmp_extension(name))
        || (name.starts_with("~syncthing~") && has_tmp_extension(name))
}

impl Vault {
    /// Opens a vault: validates the root and indexes the tree. Performs zero
    /// writes; the simulator test suite asserts that with a write counter.
    ///
    /// # Errors
    ///
    /// Returns [`VaultError::RootNotFound`] or
    /// [`VaultError::RootNotADirectory`] for an invalid root, and propagates
    /// filesystem and path validation failures from indexing.
    pub fn open(fs: &dyn FileSystem, root: &Path) -> Result<Self, VaultError> {
        // Canonical root, so watcher event paths (reported canonical by the
        // platform backends) map back into the vault.
        let root = &fs.canonicalize(root).map_err(|e| match e {
            FsError::NotFound => VaultError::RootNotFound,
            other => VaultError::Fs(other),
        })?;
        let meta = fs.metadata(root).map_err(|e| match e {
            FsError::NotFound => VaultError::RootNotFound,
            other => VaultError::Fs(other),
        })?;
        if !meta.is_dir {
            return Err(VaultError::RootNotADirectory);
        }

        let mut tree = Vec::new();
        // (normalized path, number of distinct raw spellings observed)
        let mut seen: Vec<(VaultPath, usize)> = Vec::new();
        index_directory(fs, root, None, &mut tree, &mut seen)?;
        tree.sort_by(|a, b| a.path.cmp(&b.path));
        let collisions = detect_collisions(&seen);

        Ok(Self {
            root: root.to_owned(),
            tree,
            collisions,
            notes: Arc::new(Mutex::new(HashMap::new())),
            conflicts: Arc::new(Mutex::new((0, HashMap::new()))),
        })
    }

    /// The vault root directory.
    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Re-indexes the tree from the current filesystem state, replacing the
    /// index taken at open. Read state (last-read note bases, registered
    /// conflicts) is untouched, so open editing sessions survive a refresh.
    /// Like open, a refresh performs zero writes.
    ///
    /// # Errors
    ///
    /// Propagates filesystem and path validation failures from indexing;
    /// on failure the previous tree is kept.
    pub fn refresh(&mut self, fs: &dyn FileSystem) -> Result<(), VaultError> {
        let mut tree = Vec::new();
        let mut seen: Vec<(VaultPath, usize)> = Vec::new();
        index_directory(fs, &self.root, None, &mut tree, &mut seen)?;
        tree.sort_by(|a, b| a.path.cmp(&b.path));
        self.collisions = detect_collisions(&seen);
        self.tree = tree;
        Ok(())
    }

    /// The indexed tree, sorted by path.
    #[must_use]
    pub fn tree(&self) -> &[TreeEntry] {
        &self.tree
    }

    /// Case and normalization collisions found at index time. Surfaced to the
    /// caller, never silently merged.
    #[must_use]
    pub fn collisions(&self) -> &[PathCollision] {
        &self.collisions
    }

    /// Reads an indexed file as an editing base by vault-relative path,
    /// returning bytes, encoding classification and the projection hash, and
    /// recording it as the base the next change set applies to.
    ///
    /// Every indexed file is editable, not only the Markdown family: what a
    /// file is named decides how it is presented, never whether it may be
    /// opened. What decides whether it may be *written* is its content, in
    /// [`classify`]: a file that is not valid UTF-8 opens read-only and
    /// [`Vault::write_note`] refuses it.
    ///
    /// # Errors
    ///
    /// Returns [`VaultError::NoteNotFound`] when the path is not in the
    /// index, [`VaultError::NotANote`] when it names a directory, and
    /// propagates read failures.
    pub fn read_note(
        &self,
        fs: &dyn FileSystem,
        path: &VaultPath,
    ) -> Result<NoteContent, VaultError> {
        let entry = self
            .tree
            .iter()
            .find(|entry| &entry.path == path)
            .ok_or(VaultError::NoteNotFound)?;
        if entry.kind == EntryKind::Directory {
            return Err(VaultError::NotANote);
        }
        let absolute = self.root.join(path.as_str());
        let bytes = fs.read(&absolute)?;
        let note = classify(bytes);
        self.lock_notes().insert(path.clone(), note.clone());
        Ok(note)
    }

    /// Creates an empty Markdown note without overwriting an existing path,
    /// then refreshes the vault index so the note can be opened immediately.
    /// Missing parent folders are created inside the vault.
    ///
    /// # Errors
    ///
    /// Returns [`VaultError::NotANote`] for a non-Markdown path,
    /// [`VaultError::NoteAlreadyExists`] when the path is occupied, and
    /// propagates filesystem and refresh failures.
    pub fn create_note(&mut self, fs: &dyn FileSystem, path: &VaultPath) -> Result<(), VaultError> {
        if !path.is_note() || !is_indexed_path(path) {
            return Err(VaultError::NotANote);
        }
        let relative_parent = Path::new(path.as_str())
            .parent()
            .ok_or(FsError::NotADirectory)?;
        let mut parent = self.root.clone();
        for segment in relative_parent.components() {
            parent.push(segment.as_os_str());
            match fs.metadata(&parent) {
                Ok(metadata) if !metadata.is_dir => return Err(FsError::NotADirectory.into()),
                Ok(_) => {}
                Err(FsError::NotFound) => fs.create_dir_all(&parent)?,
                Err(error) => return Err(error.into()),
            }
            let canonical = fs.canonicalize(&parent)?;
            if !canonical.starts_with(&self.root) {
                return Err(VaultPathError::Absolute.into());
            }
            parent = canonical;
        }
        let absolute = parent.join(path.file_name());
        if !fs.create_new_file(&absolute)? {
            return Err(VaultError::NoteAlreadyExists);
        }
        fs.fsync_file(&absolute)?;
        fs.fsync_dir(&parent)?;
        self.refresh(fs)?;
        self.lock_notes().insert(path.clone(), classify(Vec::new()));
        Ok(())
    }

    /// Creates a directory inside the indexed vault and refreshes the tree.
    ///
    /// # Errors
    ///
    /// Returns [`VaultError::EntryNotFound`] for a path outside the index,
    /// [`VaultError::EntryAlreadyExists`] when the path is occupied, and
    /// propagates filesystem and refresh failures.
    pub fn create_directory(
        &mut self,
        fs: &dyn FileSystem,
        path: &VaultPath,
    ) -> Result<(), VaultError> {
        if !is_indexed_path(path) {
            return Err(VaultError::EntryNotFound);
        }
        let absolute = self.root.join(path.as_str());
        if fs.metadata(&absolute).is_ok() {
            return Err(VaultError::EntryAlreadyExists);
        }
        let parent = absolute.parent().ok_or(FsError::NotADirectory)?;
        let canonical_parent = fs.canonicalize(parent)?;
        if !canonical_parent.starts_with(&self.root) {
            return Err(VaultPathError::Absolute.into());
        }
        fs.create_dir_all(&absolute)?;
        fs.fsync_dir(&canonical_parent)?;
        self.refresh(fs)
    }

    /// Moves or renames one indexed entry without replacing another entry.
    ///
    /// # Errors
    ///
    /// Returns [`VaultError::EntryNotFound`] when the source is not indexed,
    /// [`VaultError::EntryAlreadyExists`] when the destination is occupied,
    /// and propagates filesystem and refresh failures.
    pub fn move_entry(
        &mut self,
        fs: &dyn FileSystem,
        from: &VaultPath,
        to: &VaultPath,
    ) -> Result<(), VaultError> {
        if !self.tree.iter().any(|entry| &entry.path == from) {
            return Err(VaultError::EntryNotFound);
        }
        if self.tree.iter().any(|entry| &entry.path == to) {
            return Err(VaultError::EntryAlreadyExists);
        }
        let from_absolute = self.root.join(from.as_str());
        let to_absolute = self.root.join(to.as_str());
        let to_parent = to_absolute.parent().ok_or(FsError::NotADirectory)?;
        let canonical_parent = fs.canonicalize(to_parent)?;
        if !canonical_parent.starts_with(&self.root) {
            return Err(VaultPathError::Absolute.into());
        }
        fs.rename(&from_absolute, &to_absolute)?;
        fs.fsync_dir(&canonical_parent)?;
        if let Some(from_parent) = from_absolute.parent()
            && from_parent != canonical_parent
        {
            fs.fsync_dir(from_parent)?;
        }
        self.lock_notes().retain(|path, _| {
            path != from && !path.as_str().starts_with(&format!("{}/", from.as_str()))
        });
        self.refresh(fs)
    }

    /// Removes one indexed file or directory and refreshes the tree.
    ///
    /// # Errors
    ///
    /// Returns [`VaultError::EntryNotFound`] when the path is not indexed and
    /// propagates filesystem and refresh failures.
    pub fn delete_entry(
        &mut self,
        fs: &dyn FileSystem,
        path: &VaultPath,
    ) -> Result<(), VaultError> {
        let entry = self
            .tree
            .iter()
            .find(|entry| &entry.path == path)
            .ok_or(VaultError::EntryNotFound)?;
        let absolute = self.root.join(path.as_str());
        if entry.kind == EntryKind::Directory {
            fs.remove_dir_all(&absolute)?;
        } else {
            fs.remove_file(&absolute)?;
        }
        if let Some(parent) = absolute.parent() {
            fs.fsync_dir(parent)?;
        }
        self.lock_notes().retain(|candidate, _| {
            candidate != path
                && !candidate
                    .as_str()
                    .starts_with(&format!("{}/", path.as_str()))
        });
        self.refresh(fs)
    }

    /// Reads any indexed regular file without creating note editing state.
    ///
    /// # Errors
    ///
    /// Returns [`VaultError::NoteNotFound`] when the path is not indexed,
    /// [`VaultError::NotANote`] when it names a directory, and propagates
    /// filesystem read failures.
    pub fn read_file(&self, fs: &dyn FileSystem, path: &VaultPath) -> Result<Vec<u8>, VaultError> {
        let entry = self
            .tree
            .iter()
            .find(|entry| &entry.path == path)
            .ok_or(VaultError::NoteNotFound)?;
        if entry.kind == EntryKind::Directory {
            return Err(VaultError::NotANote);
        }
        Ok(fs.read(&self.root.join(path.as_str()))?)
    }

    /// Reads one of the recognized Obsidian configuration files, read-only
    /// and size-capped. The `.obsidian` directory is excluded from indexing
    /// and watching; this is the single sanctioned read path into it, and
    /// only for the named configuration files the editor honors.
    ///
    /// Returns `Ok(None)` when the file does not exist, is not valid UTF-8,
    /// or exceeds the size cap; configuration reads degrade to defaults
    /// rather than erroring.
    ///
    /// # Errors
    ///
    /// Returns [`VaultError::NoteNotFound`] when `name` is not a recognized
    /// configuration file name; filesystem failures other than absence
    /// propagate.
    pub fn read_obsidian_config(
        &self,
        fs: &dyn FileSystem,
        name: &str,
    ) -> Result<Option<String>, VaultError> {
        const RECOGNIZED: &[&str] = &["app.json", "types.json"];
        const SIZE_CAP: usize = 1 << 20;
        if !RECOGNIZED.contains(&name) {
            return Err(VaultError::NoteNotFound);
        }
        let absolute = self.root.join(".obsidian").join(name);
        let canonical = match fs.canonicalize(&absolute) {
            Ok(canonical) if canonical.starts_with(&self.root) => canonical,
            Ok(_) | Err(FsError::NotFound) => return Ok(None),
            Err(other) => return Err(VaultError::Fs(other)),
        };
        let bytes = match fs.read(&canonical) {
            Ok(bytes) => bytes,
            Err(FsError::NotFound) => return Ok(None),
            Err(other) => return Err(VaultError::Fs(other)),
        };
        if bytes.len() > SIZE_CAP {
            return Ok(None);
        }
        Ok(String::from_utf8(bytes).ok())
    }

    /// Writes an indexed file through the crash-safe path: applies
    /// `change_set` (a list of byte-range replacements) to the bytes this
    /// session last read, after verifying that `expected_projection_hash`
    /// still matches the current on-disk projection. On mismatch nothing is
    /// written and the conflict variant returns the current hash plus a
    /// reconciliation handle.
    ///
    /// Every file the session has read through [`Vault::read_note`] writes
    /// back this way, so a concurrent external write is caught for a
    /// configuration file exactly as it is for prose: an edit is never lost
    /// because of what the file is named. A file that is not valid UTF-8 is
    /// refused outright, since its editor projection is lossy.
    ///
    /// # Errors
    ///
    /// Returns [`VaultError::NoteNotRead`] when the file was never read in
    /// this session, [`VaultError::NoteReadOnly`] for non-UTF-8 content,
    /// [`VaultError::BaseMismatch`] when `expected_projection_hash` is not
    /// the hash of the last-read base, [`VaultError::ChangeSet`] for a
    /// structurally invalid change set, and propagates filesystem
    /// failures (including out-of-space) from the durable write sequence.
    pub fn write_note(
        &self,
        fs: &dyn FileSystem,
        path: &VaultPath,
        change_set: &[ByteRangeReplace],
        expected_projection_hash: &str,
    ) -> Result<WriteResult, VaultError> {
        let entry = self
            .tree
            .iter()
            .find(|entry| &entry.path == path)
            .ok_or(VaultError::NoteNotFound)?;
        if entry.kind == EntryKind::Directory {
            return Err(VaultError::NotANote);
        }
        let base = self
            .lock_notes()
            .get(path)
            .cloned()
            .ok_or(VaultError::NoteNotRead)?;
        if base.encoding == Encoding::NonUtf8 {
            return Err(VaultError::NoteReadOnly);
        }
        if base.projection_hash != expected_projection_hash {
            return Err(VaultError::BaseMismatch);
        }

        // Verify the on-disk projection still matches before writing;
        // anything else is a conflict, never an overwrite.
        let absolute = self.root.join(path.as_str());
        let disk_hash = match fs.read(&absolute) {
            Ok(disk) => Some(classify(disk).projection_hash),
            Err(FsError::NotFound) => None,
            Err(error) => return Err(VaultError::Fs(error)),
        };
        if disk_hash.as_deref() != Some(expected_projection_hash) {
            let handle = self.register_conflict(ConflictInfo {
                path: path.clone(),
                expected_projection_hash: expected_projection_hash.to_owned(),
                current_projection_hash: disk_hash.clone(),
            });
            return Ok(WriteResult::Conflict {
                current_projection_hash: disk_hash,
                reconciliation: handle,
            });
        }

        let new_bytes = apply_change_set(&base.bytes, change_set)?;
        write_durable(fs, &absolute, &new_bytes)?;
        let note = classify(new_bytes);
        let projection_hash = note.projection_hash.clone();
        self.lock_notes().insert(path.clone(), note);
        Ok(WriteResult::Written { projection_hash })
    }

    /// Atomically overwrites one indexed non-note file's full contents.
    /// Canvas boards are the only editable consumer today, and a board is
    /// small and single-writer in practice, so the write is a whole-document
    /// replace through the same crash-safe [`write_durable`] sequence
    /// `write_note` uses, rather than the change-set and projection-hash
    /// machinery notes need for multi-editor prose. A concurrent external
    /// edit is overwritten; this path carries no conflict detection.
    ///
    /// # Errors
    ///
    /// Returns [`VaultError::EntryNotFound`] when the path is not indexed,
    /// [`VaultError::NotAFile`] when it names a note or a directory, and
    /// propagates filesystem failures (including out-of-space) from the
    /// durable write sequence.
    pub fn write_file(
        &self,
        fs: &dyn FileSystem,
        path: &VaultPath,
        bytes: &[u8],
    ) -> Result<(), VaultError> {
        let entry = self
            .tree
            .iter()
            .find(|entry| &entry.path == path)
            .ok_or(VaultError::EntryNotFound)?;
        if entry.kind != EntryKind::File {
            return Err(VaultError::NotAFile);
        }
        let absolute = self.root.join(path.as_str());
        write_durable(fs, &absolute, bytes)?;
        Ok(())
    }

    /// The bytes this session last read or wrote for a note, the base the
    /// next change set applies to.
    #[must_use]
    pub fn note_base(&self, path: &VaultPath) -> Option<NoteContent> {
        self.lock_notes().get(path).cloned()
    }

    /// Advances a previously read note's write base from the same validated
    /// delta emitted by the reconciler for an external ingest.
    ///
    /// # Errors
    ///
    /// Returns [`VaultError::NoteNotRead`] when no write base exists, or
    /// [`VaultError::BaseMismatch`] when the delta does not produce the
    /// reconciler's projection hash.
    pub fn ingest_external_note(
        &self,
        path: &VaultPath,
        change_set: &[ByteRangeReplace],
        projection_hash: &str,
    ) -> Result<(), VaultError> {
        let base = self.note_base(path).ok_or(VaultError::NoteNotRead)?;
        let note = classify(apply_change_set(&base.bytes, change_set)?);
        if note.projection_hash != projection_hash {
            return Err(VaultError::BaseMismatch);
        }
        self.lock_notes().insert(path.clone(), note);
        Ok(())
    }

    /// Looks up a registered write conflict by reconciliation handle.
    #[must_use]
    pub fn conflict(&self, reconciliation: u32) -> Option<ConflictInfo> {
        self.lock_conflicts().1.get(&reconciliation).cloned()
    }

    fn register_conflict(&self, info: ConflictInfo) -> u32 {
        let mut guard = self.lock_conflicts();
        guard.0 += 1;
        let handle = guard.0;
        guard.1.insert(handle, info);
        handle
    }

    fn lock_notes(&self) -> MutexGuard<'_, HashMap<VaultPath, NoteContent>> {
        self.notes.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn lock_conflicts(&self) -> MutexGuard<'_, (u32, HashMap<u32, ConflictInfo>)> {
        self.conflicts
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

/// Classifies raw note bytes and computes the projection hash.
#[must_use]
pub fn classify(bytes: Vec<u8>) -> NoteContent {
    const BOM: &[u8] = &[0xEF, 0xBB, 0xBF];
    let encoding = if std::str::from_utf8(&bytes).is_ok() {
        if bytes.starts_with(BOM) {
            Encoding::Utf8Bom
        } else {
            Encoding::Utf8
        }
    } else {
        Encoding::NonUtf8
    };
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let projection_hash =
        hasher
            .finalize()
            .iter()
            .fold(String::with_capacity(64), |mut acc, byte| {
                use std::fmt::Write;
                let _ = write!(acc, "{byte:02x}");
                acc
            });
    NoteContent {
        bytes,
        encoding,
        projection_hash,
    }
}

/// Whether a vault-relative path is inside the indexed surface: no excluded
/// directory segment anywhere and no excluded file pattern in the final
/// segment. Watcher events on excluded paths are dropped with this check.
#[must_use]
pub fn is_indexed_path(path: &VaultPath) -> bool {
    let mut segments = path.as_str().split('/').peekable();
    while let Some(segment) = segments.next() {
        if EXCLUDED_DIRECTORIES.contains(&segment) {
            return false;
        }
        if segments.peek().is_none() && is_excluded_file(segment) {
            return false;
        }
    }
    true
}

fn index_directory(
    fs: &dyn FileSystem,
    absolute: &Path,
    relative: Option<&VaultPath>,
    tree: &mut Vec<TreeEntry>,
    seen: &mut Vec<(VaultPath, usize)>,
) -> Result<(), VaultError> {
    let mut entries = fs.read_dir(absolute)?;
    entries.sort_by(|a, b| a.file_name.cmp(&b.file_name));
    for entry in entries {
        if entry.is_dir {
            if EXCLUDED_DIRECTORIES.contains(&entry.file_name.as_str()) {
                continue;
            }
        } else if is_excluded_file(&entry.file_name) {
            continue;
        }

        let path = VaultPath::join(relative, &entry.file_name)?;
        let hidden = entry.file_name.starts_with('.');
        record_spelling(seen, &path);

        if entry.is_dir {
            tree.push(TreeEntry {
                path: path.clone(),
                kind: EntryKind::Directory,
                hidden,
            });
            index_directory(fs, &entry.path, Some(&path), tree, seen)?;
        } else {
            let kind = if path.is_note() {
                EntryKind::Note
            } else {
                EntryKind::File
            };
            tree.push(TreeEntry { path, kind, hidden });
        }
    }
    Ok(())
}

/// Records one raw directory-entry spelling for `path`. Two distinct raw
/// spellings normalizing onto one `VaultPath` (an NFC/NFD pair) bump the
/// spelling count, which `detect_collisions` surfaces as a collision.
fn record_spelling(seen: &mut Vec<(VaultPath, usize)>, path: &VaultPath) {
    if let Some(existing) = seen.iter_mut().find(|(p, _)| p == path) {
        existing.1 += 1;
    } else {
        seen.push((path.clone(), 1));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sim::SimFs;

    #[test]
    fn classify_detects_bom_and_non_utf8() {
        let plain = classify(b"hello".to_vec());
        assert_eq!(plain.encoding, Encoding::Utf8);
        assert_eq!(
            plain.projection_hash,
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );

        let bom = classify(vec![0xEF, 0xBB, 0xBF, b'h', b'i']);
        assert_eq!(bom.encoding, Encoding::Utf8Bom);
        assert_eq!(bom.bytes.len(), 5, "the BOM stays in the bytes");

        let binary = classify(vec![0xFF, 0xFE, 0x00]);
        assert_eq!(binary.encoding, Encoding::NonUtf8);
    }

    #[test]
    fn indexed_path_filter_matches_exclusions() {
        let indexed = |s: &str| is_indexed_path(&VaultPath::new(s).expect("valid"));
        assert!(indexed("folder/note.md"));
        assert!(indexed(".hidden.md"));
        assert!(!indexed(".git/config"));
        assert!(!indexed(".obsidian/workspace.json"));
        assert!(!indexed(".skribeum/state"));
        assert!(!indexed("folder/note.sync-conflict-20260101-1200-AB.md"));
        assert!(!indexed(".stversions/old.md"));
    }

    #[test]
    fn excluded_file_patterns() {
        assert!(is_excluded_file(".stignore"));
        assert!(is_excluded_file("4913"));
        assert!(is_excluded_file("note.sync-conflict-20260101-120000.md"));
        assert!(is_excluded_file(".goutputstream-ABCDEF"));
        assert!(is_excluded_file(".~lock.note.md#"));
        assert!(is_excluded_file(".syncthing.note.md.tmp"));
        assert!(is_excluded_file("~syncthing~note.md.tmp"));
        assert!(is_excluded_file(".skribeum-write-note.md.tmp"));
        assert!(!is_excluded_file("note.md"));
        assert!(!is_excluded_file(".hidden.md"));
    }

    #[test]
    fn create_note_makes_parent_folders_and_never_overwrites() {
        let fs = SimFs::new();
        let root = PathBuf::from("vault");
        fs.external_create_dir(&root);
        let mut vault = Vault::open(&fs, &root).expect("vault opens");
        let path = VaultPath::new("drafts/Untitled.md").expect("path is valid");

        vault.create_note(&fs, &path).expect("new note is created");
        assert_eq!(
            fs.read(&root.join(path.as_str())).expect("file exists"),
            b""
        );
        assert!(vault.tree().iter().any(|entry| entry.path == path));
        assert_eq!(
            vault.create_note(&fs, &path),
            Err(VaultError::NoteAlreadyExists)
        );
    }

    #[test]
    fn tree_mutations_refresh_directories_and_descendants() {
        let fs = SimFs::new();
        let root = PathBuf::from("vault");
        fs.external_create_dir(&root);
        let mut vault = Vault::open(&fs, &root).expect("vault opens");
        let draft = VaultPath::new("Drafts/one.md").expect("path is valid");
        let archive = VaultPath::new("Archive").expect("path is valid");
        let moved = VaultPath::new("Archive/Drafts").expect("path is valid");

        vault.create_note(&fs, &draft).expect("note is created");
        vault
            .create_directory(&fs, &archive)
            .expect("folder is created");
        vault
            .move_entry(
                &fs,
                &VaultPath::new("Drafts").expect("path is valid"),
                &moved,
            )
            .expect("folder is moved");
        assert!(
            vault
                .tree()
                .iter()
                .any(|entry| entry.path.as_str() == "Archive/Drafts/one.md")
        );
        assert!(!vault.tree().iter().any(|entry| entry.path == draft));

        vault
            .delete_entry(&fs, &archive)
            .expect("folder is deleted recursively");
        assert!(
            vault
                .tree()
                .iter()
                .all(|entry| !entry.path.as_str().starts_with("Archive"))
        );
        assert!(fs.metadata(&root.join("Archive")).is_err());
    }

    #[test]
    fn write_file_overwrites_a_plain_file_but_refuses_notes_and_directories() {
        let fs = SimFs::new();
        let root = PathBuf::from("vault");
        fs.external_create_dir(&root);
        fs.external_write(&root.join("board.canvas"), b"{}");
        fs.external_write(&root.join("note.md"), b"hello");
        fs.deliver_all();
        let vault = Vault::open(&fs, &root).expect("vault opens");
        let canvas = VaultPath::new("board.canvas").expect("path is valid");
        let note = VaultPath::new("note.md").expect("path is valid");
        let missing = VaultPath::new("absent.canvas").expect("path is valid");

        vault
            .write_file(&fs, &canvas, br#"{"nodes":[],"edges":[]}"#)
            .expect("plain file overwrites");
        assert_eq!(
            fs.read(&root.join("board.canvas")).expect("file reads"),
            br#"{"nodes":[],"edges":[]}"#
        );

        assert_eq!(
            vault.write_file(&fs, &note, b"{}"),
            Err(VaultError::NotAFile),
            "a note path is never overwritten through the plain-file path"
        );
        assert_eq!(
            fs.read(&root.join("note.md")).expect("note unchanged"),
            b"hello"
        );

        assert_eq!(
            vault.write_file(&fs, &missing, b"{}"),
            Err(VaultError::EntryNotFound)
        );
    }
}
