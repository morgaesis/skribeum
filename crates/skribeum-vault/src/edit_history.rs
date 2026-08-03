//! Durable per-note edit history. Records use the crash journal's storage
//! discipline: JSON Lines in OS application data, append plus fsync before
//! the save they describe, torn-tail tolerance, and filesystem access only
//! through [`FileSystem`]. The vault itself is never touched.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use serde::{Deserialize, Serialize};

use crate::fs::{FileSystem, FsError};
use crate::write::write_durable;

/// File name of the edit-history journal inside the OS app-data directory.
pub const EDIT_HISTORY_FILE_NAME: &str = "edit-history.jsonl";

/// Maximum retained transaction entries for one note.
pub const DEFAULT_EDIT_HISTORY_ENTRY_CAP: usize = 2_000;

/// Maximum serialized journal bytes retained for one note.
pub const DEFAULT_EDIT_HISTORY_NOTE_CAP_BYTES: usize = 8 * 1024 * 1024;

const RETAINED_BATCH_IDS: usize = 128;

/// An edit-history storage failure.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EditHistoryError {
    /// The journal file could not be read or written.
    #[error(transparent)]
    Fs(#[from] FsError),
    /// A record could not be serialized.
    #[error("edit-history record serialization failed")]
    Serialize,
}

/// One UTF-16 text replacement in a CodeMirror document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EditHistoryChange {
    /// Inclusive UTF-16 offset in the starting document.
    pub from: u32,
    /// Exclusive UTF-16 offset in the starting document.
    pub to: u32,
    /// Replacement text.
    pub insert: String,
}

/// One anchor and head pair in a CodeMirror selection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EditHistoryRange {
    /// Selection anchor as a UTF-16 offset.
    pub anchor: u32,
    /// Selection head as a UTF-16 offset.
    pub head: u32,
}

/// A complete CodeMirror selection, including its main range.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EditHistorySelection {
    /// Every selection range.
    pub ranges: Vec<EditHistoryRange>,
    /// Index of the main range.
    pub main: u32,
}

/// The document identity required before replaying a history direction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EditHistoryStateCheck {
    /// Document length in UTF-16 code units.
    pub length: u32,
    /// Lowercase SHA-256 over the UTF-8 editor projection.
    pub projection_hash: String,
}

/// One reversible editor transaction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EditHistoryEntry {
    /// Forward changes from the before state to the after state.
    pub changes: Vec<EditHistoryChange>,
    /// Inverse changes from the after state to the before state.
    pub inverse: Vec<EditHistoryChange>,
    /// Selection before the transaction.
    pub selection_before: EditHistorySelection,
    /// Selection after the transaction.
    pub selection_after: EditHistorySelection,
    /// Required state before applying `changes`.
    pub before: EditHistoryStateCheck,
    /// Required state before applying `inverse`.
    pub after: EditHistoryStateCheck,
}

/// One logical mutation of a note's persistent undo and redo stacks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum EditHistoryAction {
    /// Adds a new local transaction and clears the redo branch.
    Entry { entry: EditHistoryEntry },
    /// Moves the newest applied entries onto the redo stack.
    Undo { count: u32 },
    /// Moves the newest redo entries back onto the undo stack.
    Redo { count: u32 },
    /// Makes every older entry unreachable after an external ingest.
    Fence,
}

/// The reachable history for one note.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EditHistorySnapshot {
    /// Applied entries, oldest first.
    pub undo: Vec<EditHistoryEntry>,
    /// Undone entries, with the next redo at the end.
    pub redo: Vec<EditHistoryEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredRecord {
    root: String,
    path: String,
    batch: String,
    #[serde(default)]
    seen_batches: Vec<String>,
    actions: Vec<EditHistoryAction>,
}

#[derive(Debug, Default)]
struct FoldedHistory {
    snapshot: EditHistorySnapshot,
    seen: BTreeSet<String>,
    recent_batches: VecDeque<String>,
}

impl FoldedHistory {
    fn observe_batch(&mut self, batch: &str) {
        if self.seen.insert(batch.to_owned()) {
            if batch == "compacted" {
                return;
            }
            self.recent_batches.push_back(batch.to_owned());
            while self.recent_batches.len() > RETAINED_BATCH_IDS {
                self.recent_batches.pop_front();
            }
        }
    }

    fn apply(&mut self, action: &EditHistoryAction) {
        match action {
            EditHistoryAction::Entry { entry } => {
                self.snapshot.redo.clear();
                self.snapshot.undo.push(entry.clone());
            }
            EditHistoryAction::Undo { count } => {
                for _ in 0..*count {
                    let Some(entry) = self.snapshot.undo.pop() else {
                        break;
                    };
                    self.snapshot.redo.push(entry);
                }
            }
            EditHistoryAction::Redo { count } => {
                for _ in 0..*count {
                    let Some(entry) = self.snapshot.redo.pop() else {
                        break;
                    };
                    self.snapshot.undo.push(entry);
                }
            }
            EditHistoryAction::Fence => {
                self.snapshot.undo.clear();
                self.snapshot.redo.clear();
            }
        }
    }
}

/// The append-only edit-history journal at a fixed application-data path.
#[derive(Debug, Clone)]
pub struct EditHistoryJournal {
    path: PathBuf,
    entry_cap: usize,
    note_cap_bytes: usize,
    lock: Arc<Mutex<()>>,
}

impl EditHistoryJournal {
    /// Creates a journal with the production per-note retention limits.
    #[must_use]
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            entry_cap: DEFAULT_EDIT_HISTORY_ENTRY_CAP,
            note_cap_bytes: DEFAULT_EDIT_HISTORY_NOTE_CAP_BYTES,
            lock: Arc::new(Mutex::new(())),
        }
    }

    /// Overrides the per-note retention limits.
    #[must_use]
    pub fn with_caps(mut self, entry_cap: usize, note_cap_bytes: usize) -> Self {
        self.entry_cap = entry_cap;
        self.note_cap_bytes = note_cap_bytes;
        self
    }

    /// Returns the journal path.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Appends and fsyncs one idempotent batch for a note.
    ///
    /// # Errors
    ///
    /// Propagates serialization and filesystem failures. A caller saving a
    /// note must stop before the mirror write when this operation fails.
    pub fn append(
        &self,
        fs: &dyn FileSystem,
        root: &Path,
        rel_path: &str,
        batch: &str,
        actions: &[EditHistoryAction],
    ) -> Result<(), EditHistoryError> {
        let _guard = self.lock.lock().unwrap_or_else(PoisonError::into_inner);
        if actions.is_empty() {
            return Ok(());
        }
        let record = StoredRecord {
            root: root.to_string_lossy().into_owned(),
            path: rel_path.to_owned(),
            batch: batch.to_owned(),
            seen_batches: Vec::new(),
            actions: actions.to_vec(),
        };
        let mut line = serde_json::to_vec(&record).map_err(|_| EditHistoryError::Serialize)?;
        line.push(b'\n');
        let existed = fs.metadata(&self.path).is_ok();
        if let Some(parent) = self.path.parent()
            && fs.metadata(parent).is_err()
        {
            fs.create_dir_all(parent)?;
        }
        fs.append_file(&self.path, &line)?;
        fs.fsync_file(&self.path)?;
        if !existed && let Some(parent) = self.path.parent() {
            fs.fsync_dir(parent)?;
        }

        let records = self.load(fs);
        let root_key = root.to_string_lossy();
        let note_bytes = records
            .iter()
            .filter(|candidate| candidate.root == root_key && candidate.path == rel_path)
            .map(|candidate| serde_json::to_vec(candidate).map_or(0, |bytes| bytes.len() + 1))
            .sum::<usize>();
        let folded = fold_records(
            records
                .iter()
                .filter(|candidate| candidate.root == root_key && candidate.path == rel_path),
        );
        if folded.snapshot.undo.len() + folded.snapshot.redo.len() > self.entry_cap
            || note_bytes > self.note_cap_bytes
        {
            self.compact_records(fs, records)?;
        }
        Ok(())
    }

    /// Reads the reachable undo and redo stacks for one note.
    #[must_use]
    pub fn read(&self, fs: &dyn FileSystem, root: &Path, rel_path: &str) -> EditHistorySnapshot {
        let _guard = self.lock.lock().unwrap_or_else(PoisonError::into_inner);
        let root_key = root.to_string_lossy();
        fold_records(
            self.load(fs)
                .iter()
                .filter(|record| record.root == root_key && record.path == rel_path),
        )
        .snapshot
    }

    /// Physically removes every record for one note. This is used by the
    /// clear-history command and by deleted-note garbage collection.
    ///
    /// # Errors
    ///
    /// Propagates serialization and filesystem failures.
    pub fn remove_note(
        &self,
        fs: &dyn FileSystem,
        root: &Path,
        rel_path: &str,
    ) -> Result<(), EditHistoryError> {
        let _guard = self.lock.lock().unwrap_or_else(PoisonError::into_inner);
        let root_key = root.to_string_lossy();
        let records = self
            .load(fs)
            .into_iter()
            .filter(|record| record.root != root_key || record.path != rel_path)
            .collect();
        self.write_records(fs, records)
    }

    /// Removes records whose note no longer exists in one vault. This runs
    /// when a vault starts watching, while stable remove events collect
    /// deletions observed during the session.
    ///
    /// # Errors
    ///
    /// Propagates serialization and filesystem failures.
    pub fn garbage_collect(
        &self,
        fs: &dyn FileSystem,
        root: &Path,
    ) -> Result<(), EditHistoryError> {
        let _guard = self.lock.lock().unwrap_or_else(PoisonError::into_inner);
        let root_key = root.to_string_lossy();
        let records = self
            .load(fs)
            .into_iter()
            .filter(|record| {
                record.root != root_key || fs.metadata(&root.join(&record.path)).is_ok()
            })
            .collect();
        self.write_records(fs, records)
    }

    fn load(&self, fs: &dyn FileSystem) -> Vec<StoredRecord> {
        let Ok(bytes) = fs.read(&self.path) else {
            return Vec::new();
        };
        bytes
            .split(|&byte| byte == b'\n')
            .filter(|line| !line.is_empty())
            .filter_map(|line| serde_json::from_slice(line).ok())
            .collect()
    }

    fn compact_records(
        &self,
        fs: &dyn FileSystem,
        records: Vec<StoredRecord>,
    ) -> Result<(), EditHistoryError> {
        let mut grouped: BTreeMap<(String, String), Vec<&StoredRecord>> = BTreeMap::new();
        for record in &records {
            grouped
                .entry((record.root.clone(), record.path.clone()))
                .or_default()
                .push(record);
        }
        let mut compacted = Vec::new();
        for ((root, path), note_records) in grouped {
            let folded = fold_records(note_records.into_iter());
            if let Some(record) = self.compacted_record(root, path, folded)? {
                compacted.push(record);
            }
        }
        self.write_records(fs, compacted)
    }

    fn compacted_record(
        &self,
        root: String,
        path: String,
        folded: FoldedHistory,
    ) -> Result<Option<StoredRecord>, EditHistoryError> {
        let mut timeline = folded.snapshot.undo.clone();
        timeline.extend(folded.snapshot.redo.iter().rev().cloned());
        let mut applied = folded.snapshot.undo.len();
        while timeline.len() > self.entry_cap {
            timeline.remove(0);
            applied = applied.saturating_sub(1);
        }
        loop {
            let actions = canonical_actions(&timeline, applied);
            if actions.is_empty() {
                return Ok(None);
            }
            let record = StoredRecord {
                root: root.clone(),
                path: path.clone(),
                batch: "compacted".to_owned(),
                seen_batches: folded.recent_batches.iter().cloned().collect(),
                actions,
            };
            let size = serde_json::to_vec(&record)
                .map_err(|_| EditHistoryError::Serialize)?
                .len()
                + 1;
            if size <= self.note_cap_bytes {
                return Ok(Some(record));
            }
            timeline.remove(0);
            applied = applied.saturating_sub(1);
        }
    }

    fn write_records(
        &self,
        fs: &dyn FileSystem,
        records: Vec<StoredRecord>,
    ) -> Result<(), EditHistoryError> {
        let mut bytes = Vec::new();
        for record in records {
            bytes.extend(serde_json::to_vec(&record).map_err(|_| EditHistoryError::Serialize)?);
            bytes.push(b'\n');
        }
        if fs.metadata(&self.path).is_err() && bytes.is_empty() {
            return Ok(());
        }
        write_durable(fs, &self.path, &bytes)?;
        Ok(())
    }
}

fn fold_records<'a>(records: impl Iterator<Item = &'a StoredRecord>) -> FoldedHistory {
    let mut folded = FoldedHistory::default();
    for record in records {
        for seen in &record.seen_batches {
            folded.observe_batch(seen);
        }
        if folded.seen.contains(&record.batch) {
            continue;
        }
        folded.observe_batch(&record.batch);
        for action in &record.actions {
            folded.apply(action);
        }
    }
    folded
}

fn canonical_actions(timeline: &[EditHistoryEntry], applied: usize) -> Vec<EditHistoryAction> {
    let mut actions = timeline
        .iter()
        .cloned()
        .map(|entry| EditHistoryAction::Entry { entry })
        .collect::<Vec<_>>();
    let undone = timeline.len().saturating_sub(applied);
    if undone > 0 {
        actions.push(EditHistoryAction::Undo {
            count: u32::try_from(undone).unwrap_or(u32::MAX),
        });
    }
    actions
}
