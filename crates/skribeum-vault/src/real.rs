//! The real filesystem and clock. This module is the single place in the
//! workspace allowed to call `std::fs` (and, when async I/O arrives,
//! `tokio::fs`); a committed guard test enforces that mechanically. Every
//! other module and crate reaches the operating system through the traits in
//! [`crate::fs`].

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant, UNIX_EPOCH};

use notify::{RecursiveMode, Watcher as NotifyWatcherTrait};

use crate::fs::{Clock, DirEntry, FileMetadata, FileSystem, FsError, WatchEvent, Watcher};

/// The production [`FileSystem`] implementation.
#[derive(Debug, Default, Clone, Copy)]
pub struct RealFs;

/// The production [`Clock`]: monotonic time from [`Instant`].
#[derive(Debug, Clone, Copy)]
pub struct RealClock {
    origin: Instant,
}

impl Default for RealClock {
    fn default() -> Self {
        Self {
            origin: Instant::now(),
        }
    }
}

impl Clock for RealClock {
    fn now(&self) -> Duration {
        self.origin.elapsed()
    }
}

fn map_io(error: &std::io::Error) -> FsError {
    match error.kind() {
        std::io::ErrorKind::NotFound => FsError::NotFound,
        std::io::ErrorKind::NotADirectory | std::io::ErrorKind::IsADirectory => {
            FsError::NotADirectory
        }
        std::io::ErrorKind::StorageFull | std::io::ErrorKind::QuotaExceeded => FsError::NoSpace,
        kind => FsError::Io(kind.to_string()),
    }
}

impl FileSystem for RealFs {
    fn read(&self, path: &Path) -> Result<Vec<u8>, FsError> {
        std::fs::read(path).map_err(|e| map_io(&e))
    }

    fn write_file(&self, path: &Path, bytes: &[u8]) -> Result<(), FsError> {
        std::fs::write(path, bytes).map_err(|e| map_io(&e))
    }

    fn create_new_file(&self, path: &Path) -> Result<bool, FsError> {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
        {
            Ok(_) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
            Err(error) => Err(map_io(&error)),
        }
    }

    fn create_private_file(&self, path: &Path, bytes: &[u8]) -> Result<bool, FsError> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        let mut file = match options.open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(false),
            Err(error) => return Err(map_io(&error)),
        };
        if let Err(error) = file.write_all(bytes).and_then(|()| file.sync_all()) {
            let _ = std::fs::remove_file(path);
            return Err(map_io(&error));
        }
        Ok(true)
    }

    fn append_file(&self, path: &Path, bytes: &[u8]) -> Result<(), FsError> {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|e| map_io(&e))?;
        file.write_all(bytes).map_err(|e| map_io(&e))
    }

    fn fsync_file(&self, path: &Path) -> Result<(), FsError> {
        // Opened with write access: FlushFileBuffers on Windows requires it,
        // and a read-only handle fails with permission denied there.
        let file = std::fs::OpenOptions::new()
            .write(true)
            .open(path)
            .map_err(|e| map_io(&e))?;
        // `sync_all` maps to fsync(2); on macOS the standard library issues
        // the stronger fcntl F_FULLFSYNC barrier, which is the behavior the
        // write path requires there.
        file.sync_all().map_err(|e| map_io(&e))
    }

    #[cfg(not(windows))]
    fn fsync_dir(&self, path: &Path) -> Result<(), FsError> {
        let dir = std::fs::File::open(path).map_err(|e| map_io(&e))?;
        dir.sync_all().map_err(|e| map_io(&e))
    }

    #[cfg(windows)]
    fn fsync_dir(&self, path: &Path) -> Result<(), FsError> {
        // Directories cannot be opened for syncing through the standard
        // library on Windows; NTFS journals metadata operations, so the
        // rename itself is the durability point there.
        let _ = path;
        Ok(())
    }

    fn copy_permissions(&self, from: &Path, to: &Path) -> Result<(), FsError> {
        let meta = std::fs::metadata(from).map_err(|e| map_io(&e))?;
        std::fs::set_permissions(to, meta.permissions()).map_err(|e| map_io(&e))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            // Ownership is preserved where obtainable: without privilege,
            // chown to another owner fails and the write proceeds under the
            // current user, which is the correct fallback.
            let _ = std::os::unix::fs::chown(to, Some(meta.uid()), Some(meta.gid()));
        }
        Ok(())
    }

    fn canonicalize(&self, path: &Path) -> Result<PathBuf, FsError> {
        std::fs::canonicalize(path).map_err(|e| map_io(&e))
    }

    fn resolve_write_target(&self, path: &Path) -> Result<PathBuf, FsError> {
        let mut current = path.to_owned();
        // Bounded symlink chase; a cycle or an over-deep chain settles on
        // the last path, where the write will surface the OS error.
        for _ in 0..8 {
            let Ok(meta) = std::fs::symlink_metadata(&current) else {
                return Ok(current);
            };
            if !meta.file_type().is_symlink() {
                return Ok(current);
            }
            let target = std::fs::read_link(&current).map_err(|e| map_io(&e))?;
            current = if target.is_absolute() {
                target
            } else {
                current
                    .parent()
                    .map_or(target.clone(), |parent| parent.join(&target))
            };
        }
        Ok(current)
    }

    fn rename(&self, from: &Path, to: &Path) -> Result<(), FsError> {
        std::fs::rename(from, to).map_err(|e| map_io(&e))
    }

    fn remove_file(&self, path: &Path) -> Result<(), FsError> {
        std::fs::remove_file(path).map_err(|e| map_io(&e))
    }

    fn create_dir_all(&self, path: &Path) -> Result<(), FsError> {
        std::fs::create_dir_all(path).map_err(|e| map_io(&e))
    }

    fn metadata(&self, path: &Path) -> Result<FileMetadata, FsError> {
        let meta = std::fs::metadata(path).map_err(|e| map_io(&e))?;
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .unwrap_or(Duration::ZERO);
        // Permission mode bits are exposed on Unix only.
        #[cfg(unix)]
        let mode = {
            use std::os::unix::fs::PermissionsExt;
            Some(meta.permissions().mode())
        };
        #[cfg(not(unix))]
        let mode = None;
        Ok(FileMetadata {
            size: meta.len(),
            mtime,
            is_dir: meta.is_dir(),
            mode,
        })
    }

    fn read_dir(&self, path: &Path) -> Result<Vec<DirEntry>, FsError> {
        let mut entries = Vec::new();
        for entry in std::fs::read_dir(path).map_err(|e| map_io(&e))? {
            let entry = entry.map_err(|e| map_io(&e))?;
            let file_type = entry.file_type().map_err(|e| map_io(&e))?;
            entries.push(DirEntry {
                path: entry.path(),
                file_name: entry.file_name().to_string_lossy().into_owned(),
                is_dir: file_type.is_dir(),
            });
        }
        Ok(entries)
    }

    fn watch(&self, root: &Path) -> Result<Box<dyn Watcher>, FsError> {
        RealWatcher::subscribe(root).map(|w| Box::new(w) as Box<dyn Watcher>)
    }
}

/// A watcher backed by the `notify` crate. Events queue on a channel and are
/// drained non-blockingly through [`Watcher::try_next`].
struct RealWatcher {
    receiver: mpsc::Receiver<WatchEvent>,
    watcher: notify::RecommendedWatcher,
    root: PathBuf,
    // Deleting the watched root silently ends the OS subscription; a
    // recreated root is unwatched until re-subscribed. Set when the root's
    // own removal is observed, cleared when a rewatch succeeds.
    needs_rewatch: bool,
}

impl RealWatcher {
    fn subscribe(root: &Path) -> Result<Self, FsError> {
        let (sender, receiver) = mpsc::channel();
        let mut watcher =
            notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
                for event in translate(result) {
                    let _ = sender.send(event);
                }
            })
            .map_err(|e| FsError::Io(e.to_string()))?;
        watcher
            .watch(root, RecursiveMode::Recursive)
            .map_err(|e| FsError::Io(e.to_string()))?;
        Ok(Self {
            receiver,
            watcher,
            root: root.to_owned(),
            needs_rewatch: false,
        })
    }

    /// Attempts to re-establish the subscription after the root was
    /// replaced. Returns true when a rewatch succeeded, which means events
    /// were missed and the consumer must rescan.
    fn try_rewatch(&mut self) -> bool {
        if self.root.symlink_metadata().is_err() {
            return false;
        }
        let _ = self.watcher.unwatch(&self.root);
        if self
            .watcher
            .watch(&self.root, RecursiveMode::Recursive)
            .is_ok()
        {
            self.needs_rewatch = false;
            return true;
        }
        false
    }
}

/// Maps a notify event onto the model's event vocabulary. Unknown or rescan
/// events become [`WatchEvent::Overflow`], the "state unknown, rescan"
/// signal; platform differences in rename reporting collapse into the pair
/// or single-event forms the model already covers.
fn translate(result: notify::Result<notify::Event>) -> Vec<WatchEvent> {
    use notify::EventKind;
    use notify::event::{ModifyKind, RenameMode};

    // Watch errors (including overflow) mean events were lost.
    let Ok(event) = result else {
        return vec![WatchEvent::Overflow];
    };
    if event.need_rescan() {
        return vec![WatchEvent::Overflow];
    }
    let mut paths = event.paths;
    match event.kind {
        EventKind::Remove(_) => paths.into_iter().map(WatchEvent::Removed).collect(),
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) if paths.len() == 2 => {
            let to = paths.pop().unwrap_or_default();
            let from = paths.pop().unwrap_or_default();
            vec![WatchEvent::Renamed { from, to }]
        }
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => {
            paths.into_iter().map(WatchEvent::Removed).collect()
        }
        EventKind::Modify(ModifyKind::Name(RenameMode::To)) => {
            paths.into_iter().map(WatchEvent::Created).collect()
        }
        EventKind::Access(_) => Vec::new(),
        // Event kinds are not portable: FSEvents on macOS reports deletions
        // as generic name modifications, so ambiguous kinds classify by
        // current presence on disk, the only signal every backend agrees on.
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Any | EventKind::Other => {
            let created = matches!(event.kind, EventKind::Create(_));
            paths
                .into_iter()
                .map(|path| {
                    if path.symlink_metadata().is_err() {
                        WatchEvent::Removed(path)
                    } else if created {
                        WatchEvent::Created(path)
                    } else {
                        WatchEvent::Modified(path)
                    }
                })
                .collect()
        }
    }
}

impl Watcher for RealWatcher {
    fn try_next(&mut self) -> Option<WatchEvent> {
        if self.needs_rewatch && self.try_rewatch() {
            // Events were missed while unsubscribed; the consumer rescans.
            return Some(WatchEvent::Overflow);
        }
        let Ok(event) = self.receiver.try_recv() else {
            // Some backends stop silently when the watched root is deleted,
            // delivering no event at all; an empty queue with a missing root
            // is the only portable death signal.
            if !self.needs_rewatch && self.root.symlink_metadata().is_err() {
                self.needs_rewatch = true;
                return Some(WatchEvent::Overflow);
            }
            return None;
        };
        let root_gone = match &event {
            WatchEvent::Removed(path) => *path == self.root,
            WatchEvent::Renamed { from, .. } => *from == self.root,
            _ => false,
        };
        if root_gone {
            self.needs_rewatch = true;
            // The subscription is dead; report unknown state rather than a
            // removal of the vault the consumer still holds open.
            return Some(WatchEvent::Overflow);
        }
        Some(event)
    }
}
