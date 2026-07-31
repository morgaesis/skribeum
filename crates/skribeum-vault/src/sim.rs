//! Seeded deterministic filesystem and clock simulator. An in-memory tree,
//! a watcher event queue and a logical clock, all driven by a seeded
//! scheduler so any interleaving of external writes, renames, deletes,
//! watcher delivery, coalescing and event loss replays exactly from its
//! seed. Network-mount semantics (delivery latency, stale reads, event
//! loss) and a read-only-vault mode are modeled here so reconciliation
//! logic meets them in tests before it meets them in the field.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use crate::fs::{Clock, DirEntry, FileMetadata, FileSystem, FsError, WatchEvent, Watcher};

/// `SplitMix64`: a small deterministic generator. Statistical quality is
/// irrelevant here; seed-reproducibility is the requirement.
#[derive(Debug, Clone)]
struct SplitMix64(u64);

impl SplitMix64 {
    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform value in `0..bound` (`bound` must be nonzero).
    fn below(&mut self, bound: u64) -> u64 {
        self.next_u64() % bound
    }

    /// Bernoulli draw with probability `percent`/100.
    fn chance(&mut self, percent: u8) -> bool {
        self.below(100) < u64::from(percent)
    }
}

/// Network-mount semantics applied to the simulated filesystem.
#[derive(Debug, Clone, Copy, Default)]
pub struct NetworkProfile {
    /// Logical ticks between an external change and the earliest possible
    /// delivery of its watcher event.
    pub latency_ticks: u64,
    /// Percent chance that a read within `latency_ticks` of a write observes
    /// the previous content (a stale read).
    pub stale_read_percent: u8,
    /// Percent chance that a queued watcher event is silently dropped at
    /// delivery time.
    pub event_loss_percent: u8,
}

#[derive(Debug, Clone)]
enum Node {
    Directory,
    File {
        content: Vec<u8>,
        /// Content before the most recent external write, kept for the stale
        /// read model.
        previous: Option<Vec<u8>>,
        /// Tick of the most recent write.
        written_at: u64,
        mtime_tick: u64,
    },
}

#[derive(Debug)]
struct PendingEvent {
    event: WatchEvent,
    enqueued_at: u64,
}

#[derive(Debug, Default)]
struct SimState {
    nodes: BTreeMap<PathBuf, Node>,
    pending: Vec<PendingEvent>,
    delivered: Vec<WatchEvent>,
    tick: u64,
    app_write_count: u64,
    read_only: bool,
    network: Option<NetworkProfile>,
    rng: Option<SplitMix64>,
    /// Human-readable trace of every state transition, used to assert
    /// seed-reproducibility.
    trace: Vec<String>,
}

/// The simulated filesystem. Cloneable handle; clones share state.
#[derive(Debug, Clone, Default)]
pub struct SimFs {
    state: Arc<Mutex<SimState>>,
}

impl SimFs {
    /// An empty simulated filesystem with default (local, writable)
    /// semantics.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Enables read-only-vault mode: every mutating trait operation fails
    /// with [`FsError::ReadOnly`]. External mutations (the other writer the
    /// vault does not control) still apply.
    pub fn set_read_only(&self, read_only: bool) {
        self.lock().read_only = read_only;
    }

    /// Applies network-mount semantics.
    pub fn set_network_profile(&self, profile: NetworkProfile) {
        self.lock().network = Some(profile);
    }

    /// Seeds the internal generator used for stale reads and event loss.
    pub fn seed(&self, seed: u64) {
        self.lock().rng = Some(SplitMix64(seed));
    }

    /// Number of mutating operations the application has performed through
    /// the [`FileSystem`] trait. The zero-writes-on-open property asserts
    /// this is zero after open, tree and read.
    #[must_use]
    pub fn app_write_count(&self) -> u64 {
        self.lock().app_write_count
    }

    /// The transition trace so far. Two runs from the same seed produce
    /// identical traces.
    #[must_use]
    pub fn trace(&self) -> Vec<String> {
        self.lock().trace.clone()
    }

    /// Advances the logical clock.
    pub fn advance_ticks(&self, ticks: u64) {
        let mut state = self.lock();
        state.tick += ticks;
        let tick = state.tick;
        state.trace.push(format!("tick={tick}"));
    }

    /// Current logical tick, also surfaced through [`SimClock`].
    #[must_use]
    pub fn tick(&self) -> u64 {
        self.lock().tick
    }

    /// Creates a directory as external setup (not counted as an app write).
    pub fn external_create_dir(&self, path: &Path) {
        let mut state = self.lock();
        add_dir_with_parents(&mut state, path);
        state.trace.push(format!("ext-mkdir {}", path.display()));
    }

    /// An external writer (sync tool, other editor) creating or replacing a
    /// file. Queues the corresponding watcher event.
    pub fn external_write(&self, path: &Path, content: &[u8]) {
        let mut state = self.lock();
        if let Some(parent) = path.parent() {
            add_dir_with_parents(&mut state, parent);
        }
        let tick = state.tick;
        let (event, previous) = match state.nodes.get(path) {
            Some(Node::File { content: old, .. }) => {
                (WatchEvent::Modified(path.to_owned()), Some(old.clone()))
            }
            _ => (WatchEvent::Created(path.to_owned()), None),
        };
        state.nodes.insert(
            path.to_owned(),
            Node::File {
                content: content.to_vec(),
                previous,
                written_at: tick,
                mtime_tick: tick,
            },
        );
        state.pending.push(PendingEvent {
            event,
            enqueued_at: tick,
        });
        state.trace.push(format!(
            "ext-write {} len={}",
            path.display(),
            content.len()
        ));
    }

    /// An external rename. Queues a rename watcher event.
    pub fn external_rename(&self, from: &Path, to: &Path) {
        let mut state = self.lock();
        let Some(node) = state.nodes.remove(from) else {
            return;
        };
        state.nodes.insert(to.to_owned(), node);
        let tick = state.tick;
        state.pending.push(PendingEvent {
            event: WatchEvent::Renamed {
                from: from.to_owned(),
                to: to.to_owned(),
            },
            enqueued_at: tick,
        });
        state
            .trace
            .push(format!("ext-rename {} -> {}", from.display(), to.display()));
    }

    /// An external delete. Queues a remove watcher event.
    pub fn external_remove(&self, path: &Path) {
        let mut state = self.lock();
        if state.nodes.remove(path).is_none() {
            return;
        }
        let tick = state.tick;
        state.pending.push(PendingEvent {
            event: WatchEvent::Removed(path.to_owned()),
            enqueued_at: tick,
        });
        state.trace.push(format!("ext-remove {}", path.display()));
    }

    /// Delivers at most one queued watcher event, honoring network latency,
    /// modeled loss, and coalescing (a delivery may fold consecutive
    /// modifications of one path into a single event). Returns whether an
    /// event left the pending queue.
    #[must_use = "false means nothing was deliverable"]
    pub fn deliver_one(&self) -> bool {
        let mut state = self.lock();
        let now = state.tick;
        let latency = state.network.map_or(0, |n| n.latency_ticks);
        let Some(index) = state
            .pending
            .iter()
            .position(|p| now >= p.enqueued_at.saturating_add(latency))
        else {
            return false;
        };
        let pending = state.pending.remove(index);

        // Coalescing: fold immediately queued duplicate modifications of the
        // same path into this delivery.
        if let WatchEvent::Modified(path) = &pending.event {
            let path = path.clone();
            while let Some(next) = state.pending.first() {
                if next.event == WatchEvent::Modified(path.clone())
                    && now >= next.enqueued_at.saturating_add(latency)
                {
                    state.pending.remove(0);
                    state.trace.push(format!("coalesce {}", path.display()));
                } else {
                    break;
                }
            }
        }

        let loss = state.network.map_or(0, |n| n.event_loss_percent);
        let dropped = loss > 0 && state.rng.as_mut().is_some_and(|rng| rng.chance(loss));
        if dropped {
            state.trace.push(format!("drop {:?}", pending.event));
        } else {
            state.trace.push(format!("deliver {:?}", pending.event));
            state.delivered.push(pending.event);
        }
        true
    }

    /// Delivers everything currently deliverable.
    pub fn deliver_all(&self) {
        while self.deliver_one() {}
    }

    /// Queues an explicit overflow event, modeling a platform buffer
    /// overflow where an unknown number of events were lost.
    pub fn queue_overflow(&self) {
        let mut state = self.lock();
        let tick = state.tick;
        state.pending.push(PendingEvent {
            event: WatchEvent::Overflow,
            enqueued_at: tick,
        });
        state.trace.push("overflow".to_owned());
    }

    fn lock(&self) -> MutexGuard<'_, SimState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

fn add_dir_with_parents(state: &mut SimState, path: &Path) {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component);
        state
            .nodes
            .entry(current.clone())
            .or_insert(Node::Directory);
    }
}

impl FileSystem for SimFs {
    fn read(&self, path: &Path) -> Result<Vec<u8>, FsError> {
        let mut state = self.lock();
        let now = state.tick;
        let network = state.network;
        let stale_percent = network.map_or(0, |profile| profile.stale_read_percent);
        let stale_draw = stale_percent > 0
            && state
                .rng
                .as_mut()
                .is_some_and(|rng| rng.chance(stale_percent));
        let (bytes, served_stale) = match state.nodes.get(path) {
            Some(Node::File {
                content,
                previous,
                written_at,
                ..
            }) => {
                let within_window =
                    network.is_some_and(|n| now < written_at.saturating_add(n.latency_ticks));
                match (stale_draw && within_window, previous) {
                    (true, Some(previous)) => (previous.clone(), true),
                    _ => (content.clone(), false),
                }
            }
            Some(Node::Directory) => return Err(FsError::NotADirectory),
            None => return Err(FsError::NotFound),
        };
        if served_stale {
            state.trace.push(format!("stale-read {}", path.display()));
        }
        Ok(bytes)
    }

    fn write_atomic(&self, path: &Path, bytes: &[u8]) -> Result<(), FsError> {
        let mut state = self.lock();
        if state.read_only {
            return Err(FsError::ReadOnly);
        }
        state.app_write_count += 1;
        if matches!(state.nodes.get(path), Some(Node::Directory)) {
            return Err(FsError::NotADirectory);
        }
        let tick = state.tick;
        let previous = match state.nodes.get(path) {
            Some(Node::File { content, .. }) => Some(content.clone()),
            _ => None,
        };
        state.nodes.insert(
            path.to_owned(),
            Node::File {
                content: bytes.to_vec(),
                previous,
                written_at: tick,
                mtime_tick: tick,
            },
        );
        state
            .trace
            .push(format!("app-write {} len={}", path.display(), bytes.len()));
        Ok(())
    }

    fn rename(&self, from: &Path, to: &Path) -> Result<(), FsError> {
        let mut state = self.lock();
        if state.read_only {
            return Err(FsError::ReadOnly);
        }
        state.app_write_count += 1;
        let node = state.nodes.remove(from).ok_or(FsError::NotFound)?;
        state.nodes.insert(to.to_owned(), node);
        state
            .trace
            .push(format!("app-rename {} -> {}", from.display(), to.display()));
        Ok(())
    }

    fn remove_file(&self, path: &Path) -> Result<(), FsError> {
        let mut state = self.lock();
        if state.read_only {
            return Err(FsError::ReadOnly);
        }
        state.app_write_count += 1;
        match state.nodes.get(path) {
            Some(Node::File { .. }) => {
                state.nodes.remove(path);
                state.trace.push(format!("app-remove {}", path.display()));
                Ok(())
            }
            Some(Node::Directory) => Err(FsError::NotADirectory),
            None => Err(FsError::NotFound),
        }
    }

    fn create_dir_all(&self, path: &Path) -> Result<(), FsError> {
        let mut state = self.lock();
        if state.read_only {
            return Err(FsError::ReadOnly);
        }
        state.app_write_count += 1;
        add_dir_with_parents(&mut state, path);
        state.trace.push(format!("app-mkdir {}", path.display()));
        Ok(())
    }

    fn metadata(&self, path: &Path) -> Result<FileMetadata, FsError> {
        let state = self.lock();
        match state.nodes.get(path) {
            Some(Node::Directory) => Ok(FileMetadata {
                size: 0,
                mtime: Duration::ZERO,
                is_dir: true,
            }),
            Some(Node::File {
                content,
                mtime_tick,
                ..
            }) => Ok(FileMetadata {
                size: content.len() as u64,
                mtime: Duration::from_millis(*mtime_tick),
                is_dir: false,
            }),
            None => Err(FsError::NotFound),
        }
    }

    fn read_dir(&self, path: &Path) -> Result<Vec<DirEntry>, FsError> {
        let state = self.lock();
        match state.nodes.get(path) {
            Some(Node::Directory) => {}
            Some(Node::File { .. }) => return Err(FsError::NotADirectory),
            None => return Err(FsError::NotFound),
        }
        let mut entries = Vec::new();
        for (candidate, node) in &state.nodes {
            if candidate.parent() == Some(path) {
                entries.push(DirEntry {
                    path: candidate.clone(),
                    file_name: candidate
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                    is_dir: matches!(node, Node::Directory),
                });
            }
        }
        Ok(entries)
    }

    fn watch(&self, _root: &Path) -> Result<Box<dyn Watcher>, FsError> {
        Ok(Box::new(SimWatcher { fs: self.clone() }))
    }
}

/// Watcher over the simulated filesystem: drains events the scheduler has
/// delivered.
struct SimWatcher {
    fs: SimFs,
}

impl Watcher for SimWatcher {
    fn try_next(&mut self) -> Option<WatchEvent> {
        let mut state = self.fs.lock();
        if state.delivered.is_empty() {
            None
        } else {
            Some(state.delivered.remove(0))
        }
    }
}

/// The simulated [`Clock`], sharing the logical tick counter of a [`SimFs`].
/// One tick is modeled as one millisecond.
#[derive(Debug, Clone)]
pub struct SimClock {
    fs: SimFs,
}

impl SimClock {
    /// A clock over the given simulated filesystem.
    #[must_use]
    pub fn new(fs: &SimFs) -> Self {
        Self { fs: fs.clone() }
    }
}

impl Clock for SimClock {
    fn now(&self) -> Duration {
        Duration::from_millis(self.fs.tick())
    }
}

/// One step of a scheduled interleaving.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SchedulerOp {
    /// An external write of seeded content to one of the scheduler's paths.
    ExternalWrite,
    /// An external rename between two scheduler paths.
    ExternalRename,
    /// An external delete of a scheduler path.
    ExternalDelete,
    /// Deliver one queued watcher event (subject to latency and loss).
    DeliverEvent,
    /// Advance the logical clock.
    AdvanceClock,
    /// Queue a watcher overflow.
    Overflow,
}

/// A seeded scheduler producing a reproducible interleaving of external
/// filesystem activity and watcher delivery over a fixed path set.
#[derive(Debug)]
pub struct Scheduler {
    rng: SplitMix64,
    paths: Vec<PathBuf>,
    counter: u64,
}

impl Scheduler {
    /// A scheduler over `paths`, seeded so the produced op sequence is a
    /// pure function of `seed`.
    #[must_use]
    pub fn new(seed: u64, paths: Vec<PathBuf>) -> Self {
        Self {
            rng: SplitMix64(seed),
            paths,
            counter: 0,
        }
    }

    /// Draws the next operation and applies it to `fs`. Returns the op for
    /// trace assertions.
    pub fn step(&mut self, fs: &SimFs) -> SchedulerOp {
        self.counter += 1;
        let op = match self.rng.below(12) {
            0..=3 => SchedulerOp::ExternalWrite,
            4 => SchedulerOp::ExternalRename,
            5 => SchedulerOp::ExternalDelete,
            6..=8 => SchedulerOp::DeliverEvent,
            9..=10 => SchedulerOp::AdvanceClock,
            _ => SchedulerOp::Overflow,
        };
        match &op {
            SchedulerOp::ExternalWrite => {
                let path = self.pick_path();
                let content = format!("content {}", self.counter);
                fs.external_write(&path, content.as_bytes());
            }
            SchedulerOp::ExternalRename => {
                let from = self.pick_path();
                let to = self.pick_path();
                if from != to {
                    fs.external_rename(&from, &to);
                }
            }
            SchedulerOp::ExternalDelete => {
                let path = self.pick_path();
                fs.external_remove(&path);
            }
            SchedulerOp::DeliverEvent => {
                let _ = fs.deliver_one();
            }
            SchedulerOp::AdvanceClock => {
                let ticks = self.rng.below(5) + 1;
                fs.advance_ticks(ticks);
            }
            SchedulerOp::Overflow => {
                fs.queue_overflow();
            }
        }
        op
    }

    fn pick_path(&mut self) -> PathBuf {
        let draw = self.rng.below(self.paths.len() as u64);
        let index = usize::try_from(draw).unwrap_or(0);
        self.paths[index].clone()
    }
}
