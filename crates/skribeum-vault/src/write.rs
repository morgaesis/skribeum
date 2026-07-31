//! The crash-safe write sequence. One implementation composed from the
//! [`FileSystem`](crate::fs::FileSystem) primitives, so the simulator drives
//! the exact production sequence through every interleaving point, injected
//! failure and kill point.

use std::path::{Path, PathBuf};

use crate::fs::{FileSystem, FsError};

/// Prefix of the sibling temporary files the write sequence creates. Names
/// with this prefix are excluded from indexing and watching.
pub const WRITE_TEMP_PREFIX: &str = ".skribeum-write-";

/// The sibling temporary path used while replacing `target`. Deterministic
/// per target: a stale temp left by a crash is simply replaced by the next
/// save of the same file.
#[must_use]
pub fn write_temp_path(target: &Path) -> Option<PathBuf> {
    let parent = target.parent()?;
    let name = target.file_name()?;
    Some(parent.join(format!("{WRITE_TEMP_PREFIX}{}.tmp", name.to_string_lossy())))
}

/// Whether a file name is one of the write sequence's temporary files.
#[must_use]
pub fn is_write_temp_name(name: &str) -> bool {
    name.starts_with(WRITE_TEMP_PREFIX)
}

/// Atomically and durably replaces the content of `path` with `bytes`:
///
/// 1. resolve symlinks so the write goes through to the final target;
/// 2. write a temporary file in the target's directory;
/// 3. fsync the temporary file (`F_FULLFSYNC` on macOS);
/// 4. copy the target's permission mode (and ownership where obtainable)
///    onto the temporary file;
/// 5. rename the temporary file over the target;
/// 6. fsync the target's parent directory so the rename is durable.
///
/// A failure before the rename removes the temporary file and leaves the
/// target byte-identical; a failure at the final directory fsync is reported
/// (the save is not yet durable) while the target already holds the complete
/// new content. At no point can a reader observe a truncated target.
///
/// # Errors
///
/// Propagates the first failing step's [`FsError`], including
/// [`FsError::NoSpace`] from any write or fsync site.
pub fn write_durable(fs: &dyn FileSystem, path: &Path, bytes: &[u8]) -> Result<(), FsError> {
    let target = fs.resolve_write_target(path)?;
    let parent = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or(FsError::NotADirectory)?;
    let temp = write_temp_path(&target).ok_or(FsError::NotADirectory)?;
    let target_exists = fs.metadata(&target).is_ok();

    let cleanup = |error: FsError| {
        let _ = fs.remove_file(&temp);
        error
    };
    fs.write_file(&temp, bytes).map_err(cleanup)?;
    fs.fsync_file(&temp).map_err(cleanup)?;
    if target_exists {
        fs.copy_permissions(&target, &temp).map_err(cleanup)?;
    }
    fs.rename(&temp, &target).map_err(cleanup)?;
    // The temporary file no longer exists past this point; a failure here
    // means the replace happened but is not yet guaranteed durable, and the
    // caller must surface the failed save.
    fs.fsync_dir(parent)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temp_path_is_a_sibling_with_the_reserved_prefix() {
        let temp = write_temp_path(Path::new("vault/folder/note.md")).expect("has parent");
        assert_eq!(temp, Path::new("vault/folder/.skribeum-write-note.md.tmp"));
        assert!(is_write_temp_name(".skribeum-write-note.md.tmp"));
        assert!(!is_write_temp_name("note.md"));
    }
}
