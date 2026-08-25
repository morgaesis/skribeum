//! Watcher reconciliation: turning raw filesystem events into safe, typed
//! reconciliation events. External changes are detected by content hash
//! against the last projection and are never reverted; unstable reads are
//! never ingested (size-shrink and zero-byte guards, stability across a
//! settle interval on the [`Clock`](crate::fs::Clock) trait); divergence
//! above a threshold in one pass becomes a single review event; and an
//! observed hash equal to this device's own last projection for the
//! document is an echo of its own mirror write and is suppressed, while an
//! external edit landing within the settle window of that write takes the
//! banner path instead of the ingest path.

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use skribeum_core::{ByteRangeReplace, changed_span};

use crate::fs::{FileSystem, FsError};
use crate::path::VaultPath;
use crate::vault::classify;

/// Tunable reconciliation parameters.
#[derive(Debug, Clone, Copy)]
pub struct ReconcilerConfig {
    /// How long `(size, mtime)` and content must hold still before a read
    /// is considered stable enough to classify.
    pub settle: Duration,
    /// The window after this device's own mirror write within which a
    /// differing external edit is surfaced as a banner rather than
    /// ingested.
    pub write_settle: Duration,
    /// A stable read whose size shrank by more than this percentage of the
    /// last projection takes the banner path, never silent ingest.
    pub shrink_guard_percent: u8,
    /// More divergent files than this in a single pass become one bulk
    /// review event with nothing applied automatically.
    pub bulk_threshold: usize,
}

impl Default for ReconcilerConfig {
    fn default() -> Self {
        Self {
            settle: Duration::from_millis(500),
            write_settle: Duration::from_millis(1500),
            shrink_guard_percent: 25,
            bulk_threshold: 20,
        }
    }
}

/// Why a reconciliation banner is shown instead of a silent ingest.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BannerReason {
    /// The file shrank past the guard fraction; confirmed stable, but a
    /// large shrink never ingests silently.
    SizeShrank,
    /// A previously non-empty note read back as zero bytes.
    BecameEmpty,
    /// An external edit landed within the settle window of this device's
    /// own last mirror write for the document.
    EditWithinWriteSettle,
}

/// A typed reconciliation event for the editor layer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReconEvent {
    /// A stable external change to ingest: never reverted, delivered with a
    /// change set against this device's last projection so an open note can
    /// apply it as a delta.
    ExternalUpdate {
        /// The changed note.
        path: VaultPath,
        /// Projection hash of the bytes the change set applies to.
        base_projection_hash: String,
        /// Projection hash of the new content.
        projection_hash: String,
        /// Byte-range delta from the last projection to the new content.
        change_set: Vec<ByteRangeReplace>,
    },
    /// The file disappeared.
    ExternalRemove {
        /// The removed note.
        path: VaultPath,
    },
    /// Ambiguity surfaced for the user; nothing was applied.
    Banner {
        /// The note concerned.
        path: VaultPath,
        /// Why the banner is shown.
        reason: BannerReason,
        /// The observed on-disk projection hash, when a stable read exists.
        disk_hash: Option<String>,
    },
    /// More files diverged in one pass than the bulk threshold; the whole
    /// set is surfaced for review and nothing is applied automatically.
    BulkDivergence {
        /// Every path in the divergent set.
        paths: Vec<VaultPath>,
    },
}

/// This device's record of one document.
#[derive(Debug, Clone)]
struct DocState {
    /// The last projection this device itself read or wrote, byte-exact.
    projection: Vec<u8>,
    projection_hash: String,
    /// When this device last mirrored its own write, for echo settling.
    last_write_at: Option<Duration>,
}

/// A path with an undigested filesystem event.
#[derive(Debug, Clone, Default)]
struct Pending {
    /// Last time an event arrived; the settle timer restarts here.
    changed_at: Duration,
    /// The first stable-candidate read: `(hash, size, when)`.
    last_read: Option<(String, u64, Duration)>,
    /// A confirmed shrink awaiting its extra confirmation round.
    shrink_confirmed: bool,
}

/// The reconciliation state machine. Driven by watcher events through
/// [`Reconciler::observe_event`] and by time through [`Reconciler::poll`];
/// it reads files only through the [`FileSystem`] trait and time only
/// through values the caller passes in, so the deterministic simulator
/// drives it exactly.
#[derive(Debug, Default)]
pub struct Reconciler {
    config: ReconcilerConfigOrDefault,
    docs: HashMap<VaultPath, DocState>,
    pending: HashMap<VaultPath, Pending>,
}

/// Wrapper so `Reconciler::default()` works while the config stays plain.
#[derive(Debug, Default)]
struct ReconcilerConfigOrDefault(Option<ReconcilerConfig>);

impl ReconcilerConfigOrDefault {
    fn get(&self) -> ReconcilerConfig {
        self.0.unwrap_or_default()
    }
}

impl Reconciler {
    /// A reconciler with explicit configuration.
    #[must_use]
    pub fn new(config: ReconcilerConfig) -> Self {
        Self {
            config: ReconcilerConfigOrDefault(Some(config)),
            docs: HashMap::new(),
            pending: HashMap::new(),
        }
    }

    /// Records the projection this device just read for a document, making
    /// it the echo-suppression reference (decision: an echo matches only
    /// this device's own last projection).
    pub fn record_read(&mut self, path: &VaultPath, bytes: &[u8]) {
        let hash = classify(bytes.to_vec()).projection_hash;
        self.docs.insert(
            path.clone(),
            DocState {
                projection: bytes.to_vec(),
                projection_hash: hash,
                last_write_at: self.docs.get(path).and_then(|d| d.last_write_at),
            },
        );
    }

    /// Records a mirror write this device performed, starting the write
    /// settle window.
    pub fn record_write(&mut self, path: &VaultPath, bytes: &[u8], now: Duration) {
        let hash = classify(bytes.to_vec()).projection_hash;
        self.docs.insert(
            path.clone(),
            DocState {
                projection: bytes.to_vec(),
                projection_hash: hash,
                last_write_at: Some(now),
            },
        );
    }

    /// Notes a watcher event for a path. The settle timer restarts on every
    /// event, so a file still being written never classifies.
    pub fn observe_event(&mut self, path: &VaultPath, now: Duration) {
        let entry = self.pending.entry(path.clone()).or_default();
        entry.changed_at = now;
    }

    /// Whether any observed change is still awaiting classification.
    #[must_use]
    pub fn has_pending(&self) -> bool {
        !self.pending.is_empty()
    }

    /// Advances reconciliation: classifies every pending path whose settle
    /// interval elapsed, returning the events the editor layer consumes.
    /// Reads go through `fs` under `root`; `now` comes from the caller's
    /// [`Clock`](crate::fs::Clock).
    pub fn poll(&mut self, fs: &dyn FileSystem, root: &Path, now: Duration) -> Vec<ReconEvent> {
        let config = self.config.get();
        let due: Vec<VaultPath> = self
            .pending
            .iter()
            .filter(|(_, p)| now.saturating_sub(p.changed_at) >= config.settle)
            .map(|(path, _)| path.clone())
            .collect();

        let mut events = Vec::new();
        let mut divergent: Vec<(VaultPath, ReconEvent, Option<Vec<u8>>)> = Vec::new();
        for path in due {
            match self.classify_due(fs, root, &path, now, config) {
                Classification::NotYet => {}
                Classification::Quiet => {
                    self.pending.remove(&path);
                }
                Classification::Event(event, ingested) => {
                    self.pending.remove(&path);
                    divergent.push((path, event, ingested));
                }
            }
        }

        if divergent.len() > config.bulk_threshold {
            // Nothing is applied automatically: projections stay untouched
            // and the whole set is surfaced for review.
            events.push(ReconEvent::BulkDivergence {
                paths: divergent.into_iter().map(|(path, _, _)| path).collect(),
            });
        } else {
            for (path, event, ingested) in divergent {
                if let Some(bytes) = ingested {
                    // The ingested content becomes the new projection
                    // reference for echo suppression.
                    self.record_read(&path, &bytes);
                }
                events.push(event);
            }
        }
        events
    }

    fn classify_due(
        &mut self,
        fs: &dyn FileSystem,
        root: &Path,
        path: &VaultPath,
        now: Duration,
        config: ReconcilerConfig,
    ) -> Classification {
        let absolute = root.join(path.as_str());
        let bytes = match fs.read(&absolute) {
            Ok(bytes) => bytes,
            Err(FsError::NotFound) => {
                let known = self.docs.remove(path).is_some();
                return if known {
                    Classification::Event(ReconEvent::ExternalRemove { path: path.clone() }, None)
                } else {
                    Classification::Quiet
                };
            }
            Err(_) => return Classification::NotYet,
        };
        let hash = classify(bytes.clone()).projection_hash;
        let size = bytes.len() as u64;

        let pending = self.pending.entry(path.clone()).or_default();
        match &pending.last_read {
            None => {
                pending.last_read = Some((hash, size, now));
                return Classification::NotYet;
            }
            Some((seen_hash, _, _)) if *seen_hash != hash => {
                // Unstable: restart the stability window on the new content.
                pending.last_read = Some((hash, size, now));
                return Classification::NotYet;
            }
            Some((_, _, first_at)) if now.saturating_sub(*first_at) < config.settle => {
                return Classification::NotYet;
            }
            Some(_) => {}
        }

        // The read is stable across the settle interval. Classify.
        let doc = self.docs.get(path);
        if let Some(doc) = doc {
            if doc.projection_hash == hash {
                // Echo of this device's own last projection: suppressed.
                return Classification::Quiet;
            }
            if let Some(write_at) = doc.last_write_at
                && now.saturating_sub(write_at) <= config.write_settle
            {
                return Classification::Event(
                    ReconEvent::Banner {
                        path: path.clone(),
                        reason: BannerReason::EditWithinWriteSettle,
                        disk_hash: Some(hash),
                    },
                    None,
                );
            }
            let previous_len = doc.projection.len() as u64;
            if previous_len > 0 && size == 0 {
                return Classification::Event(
                    ReconEvent::Banner {
                        path: path.clone(),
                        reason: BannerReason::BecameEmpty,
                        disk_hash: Some(hash),
                    },
                    None,
                );
            }
            let shrink_floor =
                previous_len * u64::from(100 - config.shrink_guard_percent.min(100)) / 100;
            if previous_len > 0 && size < shrink_floor {
                let pending = self.pending.entry(path.clone()).or_default();
                if pending.shrink_confirmed {
                    return Classification::Event(
                        ReconEvent::Banner {
                            path: path.clone(),
                            reason: BannerReason::SizeShrank,
                            disk_hash: Some(hash),
                        },
                        None,
                    );
                }
                // Demand one more full stability round before the banner.
                pending.shrink_confirmed = true;
                pending.last_read = None;
                pending.changed_at = now;
                return Classification::NotYet;
            }
            let base = doc.projection.clone();
            return Classification::Event(external_update(path, &base, &bytes, hash), Some(bytes));
        }
        // A file this device has no projection for: a create; ingest whole.
        Classification::Event(external_update(path, &[], &bytes, hash), Some(bytes))
    }
}

enum Classification {
    /// Keep waiting.
    NotYet,
    /// Nothing to do (echo or unknown removal).
    Quiet,
    /// A classified event, with the observed bytes when the event ingests
    /// them as the new projection reference.
    Event(ReconEvent, Option<Vec<u8>>),
}

/// Builds the external-update event with a minimal byte-range delta from
/// the last projection to the observed content.
fn external_update(path: &VaultPath, base: &[u8], observed: &[u8], hash: String) -> ReconEvent {
    let change_set = match changed_span(base, observed) {
        None => Vec::new(),
        Some((start, end)) => {
            let replaced_len = observed.len() - (base.len() - (end - start));
            vec![ByteRangeReplace {
                start,
                end,
                bytes: observed[start..start + replaced_len].to_vec(),
            }]
        }
    };
    ReconEvent::ExternalUpdate {
        path: path.clone(),
        base_projection_hash: classify(base.to_vec()).projection_hash,
        projection_hash: hash,
        change_set,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use skribeum_core::apply_change_set;

    #[test]
    fn external_update_delta_reproduces_observed_bytes() {
        let path = VaultPath::new("note.md").expect("valid");
        let base = b"hello world\n";
        let observed = b"hello brave new world\n";
        let hash = classify(observed.to_vec()).projection_hash;
        let ReconEvent::ExternalUpdate {
            base_projection_hash,
            change_set,
            ..
        } = external_update(&path, base, observed, hash)
        else {
            panic!("expected an update event");
        };
        assert_eq!(
            base_projection_hash,
            classify(base.to_vec()).projection_hash
        );
        let rebuilt = apply_change_set(base, &change_set).expect("delta applies");
        assert_eq!(rebuilt, observed);
    }

    #[test]
    fn identical_content_yields_empty_delta() {
        let path = VaultPath::new("note.md").expect("valid");
        let bytes = b"same\n";
        let hash = classify(bytes.to_vec()).projection_hash;
        let ReconEvent::ExternalUpdate { change_set, .. } =
            external_update(&path, bytes, bytes, hash)
        else {
            panic!("expected an update event");
        };
        assert!(change_set.is_empty());
    }
}
