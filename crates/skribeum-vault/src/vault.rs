//! The vault model: opening a vault, indexing its tree and reading notes.
//! Everything here runs against the [`FileSystem`](crate::fs::FileSystem)
//! trait, so the same code paths execute under the deterministic simulator
//! and on the real filesystem. Opening a vault performs zero writes; the
//! simulator asserts that mechanically.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::fs::{FileSystem, FsError};
use crate::path::{PathCollision, VaultPath, VaultPathError, detect_collisions};

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
    /// A filesystem operation failed.
    #[error(transparent)]
    Fs(#[from] FsError),
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

/// An open vault: the validated root plus the indexed tree.
#[derive(Debug, Clone)]
pub struct Vault {
    root: PathBuf,
    tree: Vec<TreeEntry>,
    collisions: Vec<PathCollision>,
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
/// pattern.
fn is_excluded_file(name: &str) -> bool {
    EXCLUDED_FILES.contains(&name)
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
        })
    }

    /// The vault root directory.
    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
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
        Ok(classify(bytes))
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
        assert!(!is_excluded_file("note.md"));
        assert!(!is_excluded_file(".hidden.md"));
    }
}
