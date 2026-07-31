//! The crash journal: unsaved buffer deltas appended durably before every
//! mirror write, replayed on the next start. With no CRDT through v0 the
//! file is the only copy, and the journal is the only recovery path for a
//! killed process.
//!
//! The journal lives in the OS app-data directory (never inside the vault),
//! as a single JSON-lines file named [`JOURNAL_FILE_NAME`]; the application
//! shell resolves the directory and passes the full path in. Records append
//! through [`FileSystem::append_file`] followed by a file fsync, so a delta
//! is durable before the write it protects begins; a torn trailing record
//! from a crash mid-append is ignored on replay. The file is size-capped:
//! when an append would grow it past the cap, obsolete records (anything at
//! or before each path's last committed save) are compacted away first.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use skribeum_core::{ByteRangeReplace, apply_change_set};

use crate::fs::{FileSystem, FsError};
use crate::vault::classify;
use crate::write::write_durable;

/// File name of the crash journal inside the OS app-data directory.
pub const JOURNAL_FILE_NAME: &str = "write-journal.jsonl";

/// Default size cap in bytes.
pub const DEFAULT_CAP_BYTES: u64 = 8 * 1024 * 1024;

/// Journal failures.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum JournalError {
    /// The journal file could not be read or written.
    #[error(transparent)]
    Fs(#[from] FsError),
    /// A record could not be serialized.
    #[error("journal record serialization failed")]
    Serialize,
}

/// A byte-range replacement as serialized in journal records.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct RecordChange {
    start: usize,
    end: usize,
    bytes: Vec<u8>,
}

impl From<&ByteRangeReplace> for RecordChange {
    fn from(change: &ByteRangeReplace) -> Self {
        Self {
            start: change.start,
            end: change.end,
            bytes: change.bytes.clone(),
        }
    }
}

impl From<RecordChange> for ByteRangeReplace {
    fn from(change: RecordChange) -> Self {
        Self {
            start: change.start,
            end: change.end,
            bytes: change.bytes,
        }
    }
}

/// One journal record: a buffer delta awaiting its durable save, or the
/// marker that a save completed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum Record {
    /// A change set produced by an edit, applied to the buffer whose
    /// projection hash is `base`, yielding the buffer with hash `result`.
    Delta {
        root: String,
        path: String,
        base: String,
        result: String,
        changes: Vec<RecordChange>,
    },
    /// A durable mirror write of the buffer with hash `hash` completed.
    Commit {
        root: String,
        path: String,
        hash: String,
    },
}

/// The outcome of replaying one journaled note on start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReplayOutcome {
    /// The on-disk bytes match the delta chain's base: the chain applies
    /// and the pre-kill buffer is recovered.
    Recovered {
        /// Vault-relative path.
        rel_path: String,
        /// The recovered buffer bytes.
        bytes: Vec<u8>,
        /// Projection hash of the recovered buffer.
        projection_hash: String,
    },
    /// The on-disk bytes already match the chain's final state: the save
    /// completed before the kill and nothing needs recovery.
    Clean {
        /// Vault-relative path.
        rel_path: String,
    },
    /// The on-disk file changed between the kill and this start. Nothing is
    /// applied; the reconciliation banner is surfaced instead.
    Diverged {
        /// Vault-relative path.
        rel_path: String,
        /// The current on-disk projection hash, absent when the file is
        /// gone.
        disk_hash: Option<String>,
    },
}

/// A crash journal at a fixed path with a size cap.
#[derive(Debug, Clone)]
pub struct Journal {
    path: PathBuf,
    cap_bytes: u64,
}

impl Journal {
    /// A journal at `path` (conventionally [`JOURNAL_FILE_NAME`] inside the
    /// OS app-data directory) with the default size cap.
    #[must_use]
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            cap_bytes: DEFAULT_CAP_BYTES,
        }
    }

    /// Overrides the size cap.
    #[must_use]
    pub fn with_cap(mut self, cap_bytes: u64) -> Self {
        self.cap_bytes = cap_bytes;
        self
    }

    /// The journal file path.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Durably appends a delta record: an edit's change set against the
    /// buffer state with hash `base`, producing the state with hash
    /// `result`. Called before the mirror write it protects.
    ///
    /// # Errors
    ///
    /// Propagates serialization and filesystem failures; on failure the
    /// caller must treat the edit as unprotected.
    pub fn append_delta(
        &self,
        fs: &dyn FileSystem,
        root: &Path,
        rel_path: &str,
        base_hash: &str,
        result_hash: &str,
        changes: &[ByteRangeReplace],
    ) -> Result<(), JournalError> {
        self.append(
            fs,
            &Record::Delta {
                root: root.to_string_lossy().into_owned(),
                path: rel_path.to_owned(),
                base: base_hash.to_owned(),
                result: result_hash.to_owned(),
                changes: changes.iter().map(RecordChange::from).collect(),
            },
        )
    }

    /// Durably appends a commit record after a completed mirror write of
    /// the buffer with hash `hash`.
    ///
    /// # Errors
    ///
    /// Propagates serialization and filesystem failures.
    pub fn append_commit(
        &self,
        fs: &dyn FileSystem,
        root: &Path,
        rel_path: &str,
        hash: &str,
    ) -> Result<(), JournalError> {
        self.append(
            fs,
            &Record::Commit {
                root: root.to_string_lossy().into_owned(),
                path: rel_path.to_owned(),
                hash: hash.to_owned(),
            },
        )
    }

    fn append(&self, fs: &dyn FileSystem, record: &Record) -> Result<(), JournalError> {
        let mut line = serde_json::to_vec(record).map_err(|_| JournalError::Serialize)?;
        line.push(b'\n');
        if let Some(parent) = self.path.parent()
            && fs.metadata(parent).is_err()
        {
            fs.create_dir_all(parent)?;
        }
        let existing = fs.metadata(&self.path).map(|m| m.size).ok();
        if existing.unwrap_or(0) + line.len() as u64 > self.cap_bytes {
            self.compact(fs)?;
        }
        fs.append_file(&self.path, &line)?;
        fs.fsync_file(&self.path)?;
        if existing.is_none()
            && let Some(parent) = self.path.parent()
        {
            // First append created the journal file; the directory entry
            // must be durable before any record is trusted.
            fs.fsync_dir(parent)?;
        }
        Ok(())
    }

    /// Rewrites the journal keeping, per note, only the last commit and the
    /// deltas after it. A chain that alone exceeds the cap is kept whole:
    /// recovery data is never discarded to satisfy the cap.
    fn compact(&self, fs: &dyn FileSystem) -> Result<(), JournalError> {
        let records = self.load(fs);
        let mut kept: BTreeMap<(String, String), Vec<Record>> = BTreeMap::new();
        for record in records {
            match &record {
                Record::Commit { root, path, .. } => {
                    kept.insert((root.clone(), path.clone()), vec![record]);
                }
                Record::Delta { root, path, .. } => {
                    kept.entry((root.clone(), path.clone()))
                        .or_default()
                        .push(record);
                }
            }
        }
        let mut out = Vec::new();
        for records in kept.into_values() {
            for record in records {
                let line = serde_json::to_vec(&record).map_err(|_| JournalError::Serialize)?;
                out.extend_from_slice(&line);
                out.push(b'\n');
            }
        }
        write_durable(fs, &self.path, &out)?;
        Ok(())
    }

    /// Parses every intact record, ignoring an unparsable (torn) tail.
    fn load(&self, fs: &dyn FileSystem) -> Vec<Record> {
        let Ok(bytes) = fs.read(&self.path) else {
            return Vec::new();
        };
        bytes
            .split(|&b| b == b'\n')
            .filter(|line| !line.is_empty())
            .filter_map(|line| serde_json::from_slice(line).ok())
            .collect()
    }

    /// Replays the journal for one vault on start. For every note with
    /// deltas after its last commit, reads the on-disk bytes and decides:
    /// base matches, apply the chain and recover the buffer; final state
    /// matches, the save completed; anything else, the file changed between
    /// kill and restart and the reconciliation banner is surfaced instead
    /// of applying.
    #[must_use]
    pub fn replay(&self, fs: &dyn FileSystem, root: &Path) -> Vec<ReplayOutcome> {
        let root_key = root.to_string_lossy().into_owned();
        let mut chains: BTreeMap<String, Vec<&Record>> = BTreeMap::new();
        let records = self.load(fs);
        for record in &records {
            match record {
                Record::Commit { root: r, path, .. } if *r == root_key => {
                    chains.insert(path.clone(), vec![record]);
                }
                Record::Delta { root: r, path, .. } if *r == root_key => {
                    chains.entry(path.clone()).or_default().push(record);
                }
                _ => {}
            }
        }

        let mut outcomes = Vec::new();
        for (rel_path, chain) in chains {
            let deltas: Vec<&Record> = chain
                .iter()
                .copied()
                .filter(|r| matches!(r, Record::Delta { .. }))
                .collect();
            if deltas.is_empty() {
                continue;
            }
            let disk = fs.read(&root.join(&rel_path)).ok();
            let disk_hash = disk
                .as_ref()
                .map(|bytes| classify(bytes.clone()).projection_hash);
            let (base_hash, final_hash) = match (deltas.first(), deltas.last()) {
                (Some(Record::Delta { base, .. }), Some(Record::Delta { result, .. })) => {
                    (base.clone(), result.clone())
                }
                _ => continue,
            };

            if disk_hash.as_deref() == Some(final_hash.as_str()) {
                outcomes.push(ReplayOutcome::Clean { rel_path });
                continue;
            }
            if disk_hash.as_deref() != Some(base_hash.as_str()) {
                outcomes.push(ReplayOutcome::Diverged {
                    rel_path,
                    disk_hash,
                });
                continue;
            }
            let mut buffer = disk.unwrap_or_default();
            let mut intact = true;
            for delta in &deltas {
                let Record::Delta { changes, .. } = delta else {
                    continue;
                };
                let changes: Vec<ByteRangeReplace> = changes
                    .iter()
                    .cloned()
                    .map(ByteRangeReplace::from)
                    .collect();
                if let Ok(next) = apply_change_set(&buffer, &changes) {
                    buffer = next;
                } else {
                    intact = false;
                    break;
                }
            }
            if intact {
                let projection_hash = classify(buffer.clone()).projection_hash;
                outcomes.push(ReplayOutcome::Recovered {
                    rel_path,
                    bytes: buffer,
                    projection_hash,
                });
            } else {
                outcomes.push(ReplayOutcome::Diverged {
                    rel_path,
                    disk_hash,
                });
            }
        }
        outcomes
    }
}
