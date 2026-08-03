//! Seeded deterministic filesystem and clock simulator. An in-memory tree,
//! a watcher event queue and a logical clock, all driven by a seeded
//! scheduler so any interleaving of external writes, renames, deletes,
//! watcher delivery, coalescing and event loss replays exactly from its
//! seed. Network-mount semantics (delivery latency, stale reads, event
//! loss) and a read-only-vault mode are modeled here so reconciliation
//! logic meets them in tests before it meets them in the field.
//!
//! Durability is modeled explicitly for application writes: file content
//! becomes crash-safe only at `fsync_file`, and namespace changes (create,
//! rename, remove) only at `fsync_dir` on the parent. Every application
//! mutation and fsync is an interleaving point that can return an injected
//! failure (including out-of-space, leaving torn content at write sites) or
//! kill the modeled process, after which [`SimFs::crash_restart`] restarts
//! it over exactly the state a real crash would have left on disk.

use std::collections::{BTreeMap, HashMap};
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

/// The panic payload thrown when an armed kill point fires. Harnesses catch
/// it with `std::panic::catch_unwind`, downcast to this type, and then call
/// [`SimFs::crash_restart`] to model the reboot.
#[derive(Debug, Clone, Copy)]
pub struct SimKill;

/// Default permission mode for files created in the simulation.
const DEFAULT_MODE: u32 = 0o644;

#[derive(Debug, Clone)]
enum EntryRef {
    Directory,
    File(u64),
    Symlink(PathBuf),
}

#[derive(Debug, Clone)]
struct Inode {
    content: Vec<u8>,
    /// Content as of the last `fsync_file`; `None` when nothing was ever
    /// synced, in which case a crash leaves torn content.
    durable_content: Option<Vec<u8>>,
    mode: u32,
    /// Content before the most recent write, kept for the stale read model.
    previous: Option<Vec<u8>>,
    /// Tick of the most recent write.
    written_at: u64,
    mtime_tick: u64,
}

#[derive(Debug)]
struct PendingEvent {
    event: WatchEvent,
    enqueued_at: u64,
}

#[derive(Debug, Default)]
struct SimState {
    /// The live namespace, as running processes observe it.
    live: BTreeMap<PathBuf, EntryRef>,
    /// The durable namespace, as a crash would leave it. External activity
    /// is modeled as immediately durable; application activity becomes
    /// durable only through the fsync primitives.
    durable: BTreeMap<PathBuf, EntryRef>,
    inodes: HashMap<u64, Inode>,
    next_inode: u64,
    pending: Vec<PendingEvent>,
    delivered: Vec<WatchEvent>,
    tick: u64,
    app_write_count: u64,
    /// Count of application-level interleaving points executed (every
    /// mutation and fsync through the trait).
    app_op_count: u64,
    /// Kill the modeled process before executing this 1-based op number.
    kill_before_op: Option<u64>,
    /// Injected failures by 1-based op number.
    injected: HashMap<u64, FsError>,
    read_only: bool,
    network: Option<NetworkProfile>,
    rng: Option<SplitMix64>,
    /// Human-readable trace of every state transition, used to assert
    /// seed-reproducibility.
    trace: Vec<String>,
}

impl SimState {
    fn allocate_inode(&mut self, content: Vec<u8>, durable: bool) -> u64 {
        let id = self.next_inode;
        self.next_inode += 1;
        let tick = self.tick;
        self.inodes.insert(
            id,
            Inode {
                durable_content: durable.then(|| content.clone()),
                content,
                mode: DEFAULT_MODE,
                previous: None,
                written_at: tick,
                mtime_tick: tick,
            },
        );
        id
    }

    /// Follows symlink entries in the live namespace to the final path.
    fn resolve(&self, path: &Path) -> PathBuf {
        let mut current = path.to_owned();
        for _ in 0..8 {
            match self.live.get(&current) {
                Some(EntryRef::Symlink(target)) => current = target.clone(),
                _ => return current,
            }
        }
        current
    }

    fn file_inode(&self, path: &Path) -> Option<u64> {
        match self.live.get(&self.resolve(path)) {
            Some(EntryRef::File(id)) => Some(*id),
            _ => None,
        }
    }

    /// One application interleaving point: fires an armed kill, then an
    /// injected failure, then counts the op. Returns the 1-based op number.
    fn app_op(&mut self, label: &str) -> Result<u64, FsError> {
        self.app_op_count += 1;
        let op = self.app_op_count;
        if self.kill_before_op == Some(op) {
            self.trace.push(format!("kill at op {op} ({label})"));
            std::panic::panic_any(SimKill);
        }
        if let Some(error) = self.injected.remove(&op) {
            self.trace
                .push(format!("inject {error:?} at op {op} ({label})"));
            return Err(error);
        }
        Ok(op)
    }

    /// Seeded draw of a torn length for a failed or crashed write: some
    /// prefix of the intended bytes, deterministic per seed.
    fn torn_len(&mut self, intended: usize) -> usize {
        match self.rng.as_mut() {
            Some(rng) if intended > 0 => {
                usize::try_from(rng.below(intended as u64 + 1)).unwrap_or(0)
            }
            _ => intended / 2,
        }
    }

    fn queue_event(&mut self, event: WatchEvent) {
        let tick = self.tick;
        self.pending.push(PendingEvent {
            event,
            enqueued_at: tick,
        });
    }
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

    /// Seeds the internal generator used for stale reads, event loss and
    /// torn-write lengths.
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

    /// Number of application interleaving points executed so far (mutations
    /// plus fsyncs). A dry run of a sequence yields the op count needed to
    /// enumerate every kill and injection site.
    #[must_use]
    pub fn app_op_count(&self) -> u64 {
        self.lock().app_op_count
    }

    /// Arms a kill point: the modeled process aborts (panics with
    /// [`SimKill`]) immediately before executing the given 1-based
    /// application op, counted from now. Harnesses catch the panic and call
    /// [`SimFs::crash_restart`].
    pub fn arm_kill_before_op(&self, nth_from_now: u64) {
        let mut state = self.lock();
        let target = state.app_op_count + nth_from_now;
        state.kill_before_op = Some(target);
    }

    /// Injects a failure into the given 1-based application op, counted from
    /// now. A failed `write_file` or `append_file` leaves seeded torn
    /// content behind, as a real out-of-space write can.
    pub fn inject_failure(&self, nth_from_now: u64, error: FsError) {
        let mut state = self.lock();
        let target = state.app_op_count + nth_from_now;
        state.injected.insert(target, error);
    }

    /// Restarts the modeled process after a kill: the live state collapses
    /// to exactly what was durable, volatile inode content is torn, queued
    /// watcher deliveries die with the process, and armed kill and failure
    /// points clear.
    pub fn crash_restart(&self) {
        let mut state = self.lock();
        state.live = state.durable.clone();
        let mut torn: Vec<(u64, usize)> = Vec::new();
        for (id, inode) in &state.inodes {
            if inode.durable_content.is_none() {
                torn.push((*id, inode.content.len()));
            }
        }
        for (id, len) in torn {
            let keep = state.torn_len(len);
            if let Some(inode) = state.inodes.get_mut(&id) {
                inode.content.truncate(keep);
                inode.durable_content = Some(inode.content.clone());
            }
        }
        let mut durable_content: Vec<(u64, Vec<u8>)> = Vec::new();
        for (id, inode) in &state.inodes {
            if let Some(content) = &inode.durable_content {
                durable_content.push((*id, content.clone()));
            }
        }
        for (id, content) in durable_content {
            if let Some(inode) = state.inodes.get_mut(&id) {
                inode.content = content;
                inode.previous = None;
            }
        }
        state.pending.clear();
        state.delivered.clear();
        state.kill_before_op = None;
        state.injected.clear();
        state.trace.push("crash-restart".to_owned());
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

    /// Creates a symlink as external setup. Symlinked files are resolved and
    /// written through by the write path.
    pub fn external_symlink(&self, link: &Path, target: &Path) {
        let mut state = self.lock();
        if let Some(parent) = link.parent() {
            add_dir_with_parents(&mut state, parent);
        }
        state
            .live
            .insert(link.to_owned(), EntryRef::Symlink(target.to_owned()));
        state
            .durable
            .insert(link.to_owned(), EntryRef::Symlink(target.to_owned()));
        state.trace.push(format!(
            "ext-symlink {} -> {}",
            link.display(),
            target.display()
        ));
    }

    /// Sets a file's permission mode as external setup.
    pub fn external_set_mode(&self, path: &Path, mode: u32) {
        let mut state = self.lock();
        if let Some(id) = state.file_inode(path)
            && let Some(inode) = state.inodes.get_mut(&id)
        {
            inode.mode = mode;
        }
    }

    /// A file's current permission mode, for preservation assertions.
    #[must_use]
    pub fn mode_of(&self, path: &Path) -> Option<u32> {
        let state = self.lock();
        let id = state.file_inode(path)?;
        state.inodes.get(&id).map(|inode| inode.mode)
    }

    /// An external writer (sync tool, other editor) creating or replacing a
    /// file. External activity is modeled as immediately durable. Queues the
    /// corresponding watcher event.
    pub fn external_write(&self, path: &Path, content: &[u8]) {
        let mut state = self.lock();
        if let Some(parent) = path.parent() {
            add_dir_with_parents(&mut state, parent);
        }
        let resolved = state.resolve(path);
        let tick = state.tick;
        let existing = match state.live.get(&resolved) {
            Some(EntryRef::File(id)) => Some(*id),
            _ => None,
        };
        let event = if let Some(id) = existing {
            if let Some(inode) = state.inodes.get_mut(&id) {
                inode.previous = Some(inode.content.clone());
                inode.content = content.to_vec();
                inode.durable_content = Some(content.to_vec());
                inode.written_at = tick;
                inode.mtime_tick = tick;
            }
            WatchEvent::Modified(resolved.clone())
        } else {
            let id = state.allocate_inode(content.to_vec(), true);
            state.live.insert(resolved.clone(), EntryRef::File(id));
            state.durable.insert(resolved.clone(), EntryRef::File(id));
            WatchEvent::Created(resolved.clone())
        };
        state.queue_event(event);
        state.trace.push(format!(
            "ext-write {} len={}",
            resolved.display(),
            content.len()
        ));
    }

    /// An external rename. Queues a rename watcher event.
    pub fn external_rename(&self, from: &Path, to: &Path) {
        let mut state = self.lock();
        let Some(node) = state.live.remove(from) else {
            return;
        };
        state.live.insert(to.to_owned(), node);
        let durable = state.durable.remove(from);
        if let Some(durable) = durable {
            state.durable.insert(to.to_owned(), durable);
        }
        state.queue_event(WatchEvent::Renamed {
            from: from.to_owned(),
            to: to.to_owned(),
        });
        state
            .trace
            .push(format!("ext-rename {} -> {}", from.display(), to.display()));
    }

    /// An external delete. Queues a remove watcher event.
    pub fn external_remove(&self, path: &Path) {
        let mut state = self.lock();
        if state.live.remove(path).is_none() {
            return;
        }
        state.durable.remove(path);
        state.queue_event(WatchEvent::Removed(path.to_owned()));
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
        state.queue_event(WatchEvent::Overflow);
        state.trace.push("overflow".to_owned());
    }

    fn lock(&self) -> MutexGuard<'_, SimState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// Installs a panic hook that silences [`SimKill`] panics so kill-point
/// harnesses do not flood test output, delegating everything else to the
/// previous hook. Safe to call more than once per process.
pub fn install_quiet_kill_hook() {
    use std::sync::Once;
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            if info.payload().downcast_ref::<SimKill>().is_none() {
                previous(info);
            }
        }));
    });
}

fn add_dir_with_parents(state: &mut SimState, path: &Path) {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component);
        state
            .live
            .entry(current.clone())
            .or_insert(EntryRef::Directory);
        state
            .durable
            .entry(current.clone())
            .or_insert(EntryRef::Directory);
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
        let resolved = state.resolve(path);
        let (bytes, served_stale) = match state.live.get(&resolved) {
            Some(EntryRef::File(id)) => {
                let inode = state.inodes.get(id).ok_or(FsError::NotFound)?;
                let within_window =
                    network.is_some_and(|n| now < inode.written_at.saturating_add(n.latency_ticks));
                match (stale_draw && within_window, &inode.previous) {
                    (true, Some(previous)) => (previous.clone(), true),
                    _ => (inode.content.clone(), false),
                }
            }
            Some(EntryRef::Directory) => return Err(FsError::NotADirectory),
            Some(EntryRef::Symlink(_)) | None => return Err(FsError::NotFound),
        };
        if served_stale {
            state
                .trace
                .push(format!("stale-read {}", resolved.display()));
        }
        Ok(bytes)
    }

    fn write_file(&self, path: &Path, bytes: &[u8]) -> Result<(), FsError> {
        let mut state = self.lock();
        if state.read_only {
            return Err(FsError::ReadOnly);
        }
        state.app_write_count += 1;
        let resolved = state.resolve(path);
        if matches!(state.live.get(&resolved), Some(EntryRef::Directory)) {
            return Err(FsError::NotADirectory);
        }
        let injected = state.app_op("write_file").err();
        let (kept, torn) = match injected {
            Some(error) => {
                let torn = state.torn_len(bytes.len());
                (torn, Some(error))
            }
            None => (bytes.len(), None),
        };
        let tick = state.tick;
        let existing = match state.live.get(&resolved) {
            Some(EntryRef::File(id)) => Some(*id),
            _ => None,
        };
        let event = if let Some(id) = existing {
            if let Some(inode) = state.inodes.get_mut(&id) {
                inode.previous = Some(inode.content.clone());
                inode.content = bytes[..kept].to_vec();
                inode.written_at = tick;
                inode.mtime_tick = tick;
                // Overwritten content is no longer known durable.
                inode.durable_content = None;
            }
            WatchEvent::Modified(resolved.clone())
        } else {
            let id = state.allocate_inode(bytes[..kept].to_vec(), false);
            state.live.insert(resolved.clone(), EntryRef::File(id));
            WatchEvent::Created(resolved.clone())
        };
        state.queue_event(event);
        state
            .trace
            .push(format!("app-write {} len={kept}", resolved.display()));
        match torn {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    fn create_new_file(&self, path: &Path) -> Result<bool, FsError> {
        let mut state = self.lock();
        if state.read_only {
            return Err(FsError::ReadOnly);
        }
        state.app_write_count += 1;
        let resolved = state.resolve(path);
        if state.live.contains_key(&resolved) {
            return Ok(false);
        }
        state.app_op("create_new_file")?;
        let id = state.allocate_inode(Vec::new(), false);
        state.live.insert(resolved.clone(), EntryRef::File(id));
        state.queue_event(WatchEvent::Created(resolved.clone()));
        state
            .trace
            .push(format!("app-create-new {}", resolved.display()));
        Ok(true)
    }

    fn create_private_file(&self, path: &Path, bytes: &[u8]) -> Result<bool, FsError> {
        let mut state = self.lock();
        if state.read_only {
            return Err(FsError::ReadOnly);
        }
        state.app_write_count += 1;
        let resolved = state.resolve(path);
        if state.live.contains_key(&resolved) {
            return Ok(false);
        }
        state.app_op("create_private_file")?;
        let id = state.allocate_inode(bytes.to_vec(), false);
        state.live.insert(resolved.clone(), EntryRef::File(id));
        state.queue_event(WatchEvent::Created(resolved.clone()));
        state
            .trace
            .push(format!("app-create-private {}", resolved.display()));
        Ok(true)
    }

    fn append_file(&self, path: &Path, bytes: &[u8]) -> Result<(), FsError> {
        let mut state = self.lock();
        if state.read_only {
            return Err(FsError::ReadOnly);
        }
        state.app_write_count += 1;
        let resolved = state.resolve(path);
        if matches!(state.live.get(&resolved), Some(EntryRef::Directory)) {
            return Err(FsError::NotADirectory);
        }
        let injected = state.app_op("append_file").err();
        let (kept, torn) = match injected {
            Some(error) => (state.torn_len(bytes.len()), Some(error)),
            None => (bytes.len(), None),
        };
        let tick = state.tick;
        let existing = match state.live.get(&resolved) {
            Some(EntryRef::File(id)) => Some(*id),
            _ => None,
        };
        if let Some(id) = existing {
            if let Some(inode) = state.inodes.get_mut(&id) {
                inode.previous = Some(inode.content.clone());
                inode.content.extend_from_slice(&bytes[..kept]);
                inode.written_at = tick;
                inode.mtime_tick = tick;
                inode.durable_content = None;
            }
        } else {
            let id = state.allocate_inode(bytes[..kept].to_vec(), false);
            state.live.insert(resolved.clone(), EntryRef::File(id));
        }
        state.queue_event(WatchEvent::Modified(resolved.clone()));
        state
            .trace
            .push(format!("app-append {} len={kept}", resolved.display()));
        match torn {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    fn fsync_file(&self, path: &Path) -> Result<(), FsError> {
        let mut state = self.lock();
        let resolved = state.resolve(path);
        let Some(EntryRef::File(id)) = state.live.get(&resolved).cloned() else {
            return Err(FsError::NotFound);
        };
        state.app_op("fsync_file")?;
        if let Some(inode) = state.inodes.get_mut(&id) {
            inode.durable_content = Some(inode.content.clone());
        }
        state
            .trace
            .push(format!("app-fsync-file {}", resolved.display()));
        Ok(())
    }

    fn fsync_dir(&self, path: &Path) -> Result<(), FsError> {
        let mut state = self.lock();
        if !matches!(state.live.get(path), Some(EntryRef::Directory)) {
            return Err(FsError::NotADirectory);
        }
        state.app_op("fsync_dir")?;
        // Namespace sync: the durable view of this directory's direct
        // children becomes the live view. Content durability is separate and
        // only changes at fsync_file.
        let live_children: Vec<(PathBuf, EntryRef)> = state
            .live
            .iter()
            .filter(|(p, _)| p.parent() == Some(path))
            .map(|(p, e)| (p.clone(), e.clone()))
            .collect();
        let vanished: Vec<PathBuf> = state
            .durable
            .keys()
            .filter(|p| p.parent() == Some(path) && !state.live.contains_key(*p))
            .cloned()
            .collect();
        for p in vanished {
            state.durable.remove(&p);
        }
        for (p, e) in live_children {
            state.durable.insert(p, e);
        }
        state
            .trace
            .push(format!("app-fsync-dir {}", path.display()));
        Ok(())
    }

    fn copy_permissions(&self, from: &Path, to: &Path) -> Result<(), FsError> {
        let mut state = self.lock();
        if state.read_only {
            return Err(FsError::ReadOnly);
        }
        let from_id = state.file_inode(from).ok_or(FsError::NotFound)?;
        let to_id = state.file_inode(to).ok_or(FsError::NotFound)?;
        state.app_op("copy_permissions")?;
        let mode = state
            .inodes
            .get(&from_id)
            .map(|inode| inode.mode)
            .ok_or(FsError::NotFound)?;
        if let Some(inode) = state.inodes.get_mut(&to_id) {
            inode.mode = mode;
        }
        state.trace.push(format!(
            "app-copy-mode {} -> {}",
            from.display(),
            to.display()
        ));
        Ok(())
    }

    fn resolve_write_target(&self, path: &Path) -> Result<PathBuf, FsError> {
        Ok(self.lock().resolve(path))
    }

    fn canonicalize(&self, path: &Path) -> Result<PathBuf, FsError> {
        // The simulator's namespace has no symlinked ancestors, but the final
        // component can be a symlink and canonicalization resolves it.
        let state = self.lock();
        let resolved = state.resolve(path);
        state
            .live
            .contains_key(&resolved)
            .then_some(resolved)
            .ok_or(FsError::NotFound)
    }

    fn rename(&self, from: &Path, to: &Path) -> Result<(), FsError> {
        let mut state = self.lock();
        if state.read_only {
            return Err(FsError::ReadOnly);
        }
        state.app_write_count += 1;
        if !state.live.contains_key(from) {
            return Err(FsError::NotFound);
        }
        state.app_op("rename")?;
        let moved = state
            .live
            .iter()
            .filter(|(path, _)| *path == from || path.starts_with(from))
            .map(|(path, node)| (path.clone(), node.clone()))
            .collect::<Vec<_>>();
        for (path, _) in &moved {
            state.live.remove(path);
        }
        for (path, node) in moved {
            let suffix = path.strip_prefix(from).unwrap_or(Path::new(""));
            state.live.insert(to.join(suffix), node);
        }
        state.queue_event(WatchEvent::Renamed {
            from: from.to_owned(),
            to: to.to_owned(),
        });
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
        match state.live.get(path) {
            Some(EntryRef::File(_) | EntryRef::Symlink(_)) => {
                state.app_op("remove_file")?;
                state.live.remove(path);
                state.queue_event(WatchEvent::Removed(path.to_owned()));
                state.trace.push(format!("app-remove {}", path.display()));
                Ok(())
            }
            Some(EntryRef::Directory) => Err(FsError::NotADirectory),
            None => Err(FsError::NotFound),
        }
    }

    fn remove_dir_all(&self, path: &Path) -> Result<(), FsError> {
        let mut state = self.lock();
        if state.read_only {
            return Err(FsError::ReadOnly);
        }
        if !matches!(state.live.get(path), Some(EntryRef::Directory)) {
            return Err(FsError::NotADirectory);
        }
        state.app_write_count += 1;
        state.app_op("remove_dir_all")?;
        let descendants = state
            .live
            .keys()
            .filter(|candidate| candidate.starts_with(path))
            .cloned()
            .collect::<Vec<_>>();
        for descendant in descendants {
            state.live.remove(&descendant);
        }
        state.queue_event(WatchEvent::Removed(path.to_owned()));
        state
            .trace
            .push(format!("app-remove-dir {}", path.display()));
        Ok(())
    }

    fn create_dir_all(&self, path: &Path) -> Result<(), FsError> {
        let mut state = self.lock();
        if state.read_only {
            return Err(FsError::ReadOnly);
        }
        state.app_write_count += 1;
        state.app_op("create_dir_all")?;
        add_dir_with_parents(&mut state, path);
        state.trace.push(format!("app-mkdir {}", path.display()));
        Ok(())
    }

    fn metadata(&self, path: &Path) -> Result<FileMetadata, FsError> {
        let state = self.lock();
        let resolved = state.resolve(path);
        match state.live.get(&resolved) {
            Some(EntryRef::Directory) => Ok(FileMetadata {
                size: 0,
                mtime: Duration::ZERO,
                is_dir: true,
                mode: None,
            }),
            Some(EntryRef::File(id)) => {
                let inode = state.inodes.get(id).ok_or(FsError::NotFound)?;
                Ok(FileMetadata {
                    size: inode.content.len() as u64,
                    mtime: Duration::from_millis(inode.mtime_tick),
                    is_dir: false,
                    mode: Some(inode.mode),
                })
            }
            Some(EntryRef::Symlink(_)) | None => Err(FsError::NotFound),
        }
    }

    fn read_dir(&self, path: &Path) -> Result<Vec<DirEntry>, FsError> {
        let state = self.lock();
        match state.live.get(path) {
            Some(EntryRef::Directory) => {}
            Some(_) => return Err(FsError::NotADirectory),
            None => return Err(FsError::NotFound),
        }
        let mut entries = Vec::new();
        for (candidate, node) in &state.live {
            if candidate.parent() == Some(path) {
                entries.push(DirEntry {
                    path: candidate.clone(),
                    file_name: candidate
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                    is_dir: matches!(node, EntryRef::Directory),
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

    /// A seeded draw in `0..bound` from the scheduler's generator, for
    /// harnesses that need reproducible auxiliary choices.
    pub fn draw(&mut self, bound: u64) -> u64 {
        if bound == 0 { 0 } else { self.rng.below(bound) }
    }

    fn pick_path(&mut self) -> PathBuf {
        let draw = self.rng.below(self.paths.len() as u64);
        let index = usize::try_from(draw).unwrap_or(0);
        self.paths[index].clone()
    }
}
