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
    /// The requested path exists in the index but is not a markdown note.
    #[error("path is not a note")]
    NotANote,
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
    /// A markdown note (`.md`, case-insensitive).
    Note,
    /// Any other file. Present in the tree but never parsed or edited.
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

    /// Reads a note by vault-relative path, returning bytes, encoding
    /// classification and the projection hash.
    ///
    /// # Errors
    ///
    /// Returns [`VaultError::NoteNotFound`] when the path is not in the
    /// index, [`VaultError::NotANote`] when it is indexed but not a markdown
    /// note, and propagates read failures.
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
        if entry.kind != EntryKind::Note {
            return Err(VaultError::NotANote);
        }
        let absolute = self.root.join(path.as_str());
        let bytes = fs.read(&absolute)?;
        let note = classify(bytes);
        self.lock_notes().insert(path.clone(), note.clone());
        Ok(note)
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
        let bytes = match fs.read(&absolute) {
            Ok(bytes) => bytes,
            Err(FsError::NotFound) => return Ok(None),
            Err(other) => return Err(VaultError::Fs(other)),
        };
        if bytes.len() > SIZE_CAP {
            return Ok(None);
        }
        Ok(String::from_utf8(bytes).ok())
    }

    /// Writes a note through the crash-safe path: applies `change_set` (a
    /// list of byte-range replacements) to the bytes this session last
    /// read, after verifying that `expected_projection_hash` still matches
    /// the current on-disk projection. On mismatch nothing is written and
    /// the conflict variant returns the current hash plus a reconciliation
    /// handle.
    ///
    /// # Errors
    ///
    /// Returns [`VaultError::NoteNotRead`] when the note was never read in
    /// this session, [`VaultError::NoteReadOnly`] for non-UTF-8 notes,
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
        if entry.kind != EntryKind::Note {
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

    /// The bytes this session last read or wrote for a note, the base the
    /// next change set applies to.
    #[must_use]
    pub fn note_base(&self, path: &VaultPath) -> Option<NoteContent> {
        self.lock_notes().get(path).cloned()
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
}
