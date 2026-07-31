//! The watcher-reconciliation invariant over 10,000 seeded interleavings:
//! no externally written byte sequence is ever replaced by an editor-held
//! buffer without explicit user action. The modeled editor edits, saves
//! through the change-set path, ingests reconciliation events and resolves
//! conflicts only through explicit re-reads; the harness observes every
//! save from outside and fails if a save ever lands over disk content whose
//! hash the editor did not hold. Deterministic behavior tests for the
//! reconciliation rules (echo suppression, the write-settle banner, the
//! shrink and zero-byte guards, bulk divergence, unstable reads) live at
//! the bottom.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use skribeum_core::{ByteRangeReplace, apply_change_set};
use skribeum_vault::{
    BannerReason, FileSystem, ReconEvent, Reconciler, ReconcilerConfig, SimFs, Vault, VaultPath,
    WatchEvent, WriteResult, classify, write_durable,
};

const PATHS: [&str; 3] = ["a.md", "b.md", "c.md"];

fn test_config() -> ReconcilerConfig {
    ReconcilerConfig {
        settle: Duration::from_millis(3),
        write_settle: Duration::from_millis(10),
        shrink_guard_percent: 25,
        bulk_threshold: 20,
    }
}

/// Small deterministic generator for the harness's own draws.
struct Rng(u64);

impl Rng {
    fn draw(&mut self, bound: u64) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        (z ^ (z >> 31)) % bound
    }
}

/// The modeled editor's view of one note.
struct Doc {
    base: Vec<u8>,
    expected_hash: String,
    dirty: Option<Vec<ByteRangeReplace>>,
    conflicted: bool,
}

/// How the editor persists a save. The production implementation goes
/// through `Vault::write_note`; the mutation companion swaps in a blind
/// writer to prove the invariant checker has teeth.
type SaveImpl = fn(&Vault, &SimFs, &VaultPath, &[ByteRangeReplace], &str) -> Option<String>;

fn production_save(
    vault: &Vault,
    fs: &SimFs,
    path: &VaultPath,
    changes: &[ByteRangeReplace],
    expected: &str,
) -> Option<String> {
    match vault.write_note(fs, path, changes, expected) {
        Ok(WriteResult::Written { projection_hash }) => Some(projection_hash),
        Ok(WriteResult::Conflict { .. }) | Err(_) => None,
    }
}

/// The deliberately broken writer: applies the change set to the editor's
/// base and writes it over whatever is on disk, skipping the projection
/// verification.
fn blind_save(
    vault: &Vault,
    fs: &SimFs,
    path: &VaultPath,
    changes: &[ByteRangeReplace],
    _expected: &str,
) -> Option<String> {
    let base = vault.note_base(path)?;
    let bytes = apply_change_set(&base.bytes, changes).ok()?;
    write_durable(fs, &PathBuf::from("vault").join(path.as_str()), &bytes).ok()?;
    Some(classify(bytes).projection_hash)
}

/// Runs one seeded interleaving; `Err` describes the first invariant
/// violation observed.
#[allow(clippy::too_many_lines)] // One scenario, inspected as one piece.
fn run_seed(seed: u64, save: SaveImpl) -> Result<(), String> {
    let fs = SimFs::new();
    fs.seed(seed);
    let root = PathBuf::from("vault");
    fs.external_create_dir(&root);
    for (index, name) in PATHS.iter().enumerate() {
        fs.external_write(&root.join(name), format!("initial {index}\n").as_bytes());
    }
    fs.deliver_all();

    let vault = Vault::open(&fs, &root).map_err(|e| format!("open failed: {e}"))?;
    let mut recon = Reconciler::new(test_config());
    let mut watcher = fs.watch(&root).map_err(|e| format!("watch failed: {e}"))?;
    let mut docs: HashMap<String, Doc> = HashMap::new();
    for name in PATHS {
        let path = VaultPath::new(name).map_err(|e| format!("path: {e}"))?;
        let note = vault
            .read_note(&fs, &path)
            .map_err(|e| format!("read failed: {e}"))?;
        recon.record_read(&path, &note.bytes);
        docs.insert(
            name.to_owned(),
            Doc {
                base: note.bytes,
                expected_hash: note.projection_hash,
                dirty: None,
                conflicted: false,
            },
        );
    }

    let mut rng = Rng(seed.wrapping_mul(0x0123_4567_89AB_CDEF).wrapping_add(1));
    let mut counter = 0u64;
    for _step in 0..40 {
        counter += 1;
        let name = PATHS[usize::try_from(rng.draw(3)).unwrap_or(0)];
        let path = VaultPath::new(name).map_err(|e| format!("path: {e}"))?;
        let absolute = root.join(name);
        match rng.draw(12) {
            // External writer replaces the file.
            0..=2 => {
                let content = format!("external {seed}-{counter}\n");
                fs.external_write(&absolute, content.as_bytes());
            }
            // External delete.
            3 => fs.external_remove(&absolute),
            // Watcher delivery.
            4 => {
                let _ = fs.deliver_one();
            }
            5 => fs.deliver_all(),
            // Time passes.
            6 => fs.advance_ticks(rng.draw(5) + 1),
            // The user types.
            7 => {
                if let Some(doc) = docs.get_mut(name)
                    && !doc.conflicted
                {
                    doc.dirty = Some(vec![ByteRangeReplace {
                        start: 0,
                        end: 0,
                        bytes: format!("edit {counter} ").into_bytes(),
                    }]);
                }
            }
            // The editor saves. The invariant is checked here, from outside
            // the implementation under test.
            8 => {
                let Some(doc) = docs.get_mut(name) else {
                    continue;
                };
                let Some(changes) = doc.dirty.clone() else {
                    continue;
                };
                if doc.conflicted {
                    continue;
                }
                let disk_before = fs.read(&absolute).ok();
                let hash_before = disk_before.clone().map(|b| classify(b).projection_hash);
                let written = save(&vault, &fs, &path, &changes, &doc.expected_hash);
                let disk_after = fs.read(&absolute).ok();
                if let Some(new_hash) = written {
                    if hash_before.as_deref() != Some(doc.expected_hash.as_str()) {
                        return Err(format!(
                            "seed {seed}: a save landed over disk content the editor \
                             never held (externally written bytes replaced)"
                        ));
                    }
                    doc.base =
                        apply_change_set(&doc.base, &changes).map_err(|e| format!("apply: {e}"))?;
                    doc.expected_hash = new_hash;
                    doc.dirty = None;
                    recon.record_write(&path, &doc.base, Duration::from_millis(fs.tick()));
                } else {
                    if disk_after != disk_before {
                        return Err(format!(
                            "seed {seed}: a refused save still changed the disk"
                        ));
                    }
                    doc.conflicted = true;
                }
            }
            // The user explicitly resolves: re-reads the note.
            9 => {
                if let Some(doc) = docs.get_mut(name)
                    && doc.conflicted
                    && let Ok(note) = vault.read_note(&fs, &path)
                {
                    recon.record_read(&path, &note.bytes);
                    doc.base = note.bytes;
                    doc.expected_hash = note.projection_hash;
                    doc.dirty = None;
                    doc.conflicted = false;
                }
            }
            // Reconciliation runs: watcher events observed, poll classified.
            10 => {
                let now = Duration::from_millis(fs.tick());
                while let Some(event) = watcher.try_next() {
                    for observed in watch_paths(&event) {
                        if let Ok(observed) = observed
                            .strip_prefix(&root)
                            .map(|p| VaultPath::new(&p.to_string_lossy()))
                            && let Ok(observed) = observed
                        {
                            recon.observe_event(&observed, now);
                        }
                    }
                }
                for event in recon.poll(&fs, &root, now) {
                    apply_recon_event(&vault, &fs, &mut docs, &event)?;
                }
            }
            // Watcher overflow.
            _ => fs.queue_overflow(),
        }
    }
    Ok(())
}

fn watch_paths(event: &WatchEvent) -> Vec<PathBuf> {
    match event {
        WatchEvent::Created(p) | WatchEvent::Modified(p) | WatchEvent::Removed(p) => {
            vec![p.clone()]
        }
        WatchEvent::Renamed { from, to } => vec![from.clone(), to.clone()],
        WatchEvent::Overflow => Vec::new(),
    }
}

/// The editor's reaction to a reconciliation event: external updates ingest
/// (never revert), banners mark the doc conflicted until the user acts.
fn apply_recon_event(
    vault: &Vault,
    fs: &SimFs,
    docs: &mut HashMap<String, Doc>,
    event: &ReconEvent,
) -> Result<(), String> {
    match event {
        ReconEvent::ExternalUpdate {
            path, change_set, ..
        } => {
            if let Some(doc) = docs.get_mut(path.as_str()) {
                doc.base =
                    apply_change_set(&doc.base, change_set).map_err(|e| format!("ingest: {e}"))?;
                doc.expected_hash = classify(doc.base.clone()).projection_hash;
                doc.dirty = None;
                doc.conflicted = false;
            }
            let _ = (vault, fs);
        }
        ReconEvent::ExternalRemove { path } | ReconEvent::Banner { path, .. } => {
            if let Some(doc) = docs.get_mut(path.as_str()) {
                doc.conflicted = true;
            }
        }
        ReconEvent::BulkDivergence { paths } => {
            for path in paths {
                if let Some(doc) = docs.get_mut(path.as_str()) {
                    doc.conflicted = true;
                }
            }
        }
    }
    Ok(())
}

/// Criterion: 10,000 seeds, zero invariant violations through the
/// production save path.
#[test]
fn ten_thousand_seeds_never_replace_external_bytes() {
    for seed in 0..10_000u64 {
        run_seed(seed, production_save).unwrap_or_else(|violation| panic!("{violation}"));
    }
}

/// Mutation companion: the same harness must detect the violation when the
/// save path skips projection verification. A checker that passes a blind
/// writer proves nothing.
#[test]
fn harness_rejects_a_blind_writer() {
    let mut caught = false;
    for seed in 0..500u64 {
        if run_seed(seed, blind_save).is_err() {
            caught = true;
            break;
        }
    }
    assert!(
        caught,
        "the invariant harness must catch a writer that skips hash verification"
    );
}

// Deterministic reconciliation behavior tests.

struct ReconScene {
    fs: SimFs,
    root: PathBuf,
    recon: Reconciler,
    path: VaultPath,
}

fn recon_scene(initial: &[u8]) -> ReconScene {
    let fs = SimFs::new();
    let root = PathBuf::from("vault");
    fs.external_create_dir(&root);
    fs.external_write(&root.join("note.md"), initial);
    let mut recon = Reconciler::new(test_config());
    let path = VaultPath::new("note.md").expect("valid");
    recon.record_read(&path, initial);
    ReconScene {
        fs,
        root,
        recon,
        path,
    }
}

/// Polls through the settle window (two stability reads) and returns the
/// classified events.
fn settle_and_poll(scene: &mut ReconScene) -> Vec<ReconEvent> {
    let mut events = Vec::new();
    for _ in 0..6 {
        scene.fs.advance_ticks(4);
        events.extend(scene.recon.poll(
            &scene.fs,
            &scene.root,
            Duration::from_millis(scene.fs.tick()),
        ));
    }
    events
}

/// Decision 84: an observed hash equal to this device's own last projection
/// is an echo and is suppressed.
#[test]
fn own_write_echo_is_suppressed() {
    let mut scene = recon_scene(b"before\n");
    scene.fs.advance_ticks(100);
    let now = Duration::from_millis(scene.fs.tick());
    scene.recon.record_write(&scene.path, b"after\n", now);
    scene
        .fs
        .external_write(&scene.root.join("note.md"), b"after\n");
    scene.recon.observe_event(&scene.path, now);
    // Let the write-settle window pass as well: an echo is an echo whenever
    // it arrives.
    scene.fs.advance_ticks(50);
    let events = settle_and_poll(&mut scene);
    assert!(
        events.is_empty(),
        "an echo of this device's own last projection must be suppressed, got {events:?}"
    );
}

/// Decision 84: a match against an older projection is a legitimate
/// external revert and ingests; only the last projection is an echo.
#[test]
fn revert_to_an_older_projection_ingests() {
    let mut scene = recon_scene(b"version one\n");
    scene.fs.advance_ticks(100);
    let now = Duration::from_millis(scene.fs.tick());
    scene.recon.record_write(&scene.path, b"version two\n", now);
    // Well past the write settle window, an external writer restores the
    // older content (a checkout, an undo in another editor).
    scene.fs.advance_ticks(50);
    scene
        .fs
        .external_write(&scene.root.join("note.md"), b"version one\n");
    scene
        .recon
        .observe_event(&scene.path, Duration::from_millis(scene.fs.tick()));
    let events = settle_and_poll(&mut scene);
    assert!(
        events.iter().any(|e| matches!(
            e,
            ReconEvent::ExternalUpdate { path, .. } if path == &scene.path
        )),
        "a revert to an older projection must ingest, got {events:?}"
    );
}

/// Decision 107: an external edit within the settle window of this device's
/// own last mirror write takes the banner path, not the ingest path.
#[test]
fn external_edit_within_write_settle_takes_the_banner_path() {
    let mut scene = recon_scene(b"before\n");
    scene.fs.advance_ticks(100);
    let now = Duration::from_millis(scene.fs.tick());
    scene.recon.record_write(&scene.path, b"mine\n", now);
    // An external edit lands immediately after our own mirror write.
    scene
        .fs
        .external_write(&scene.root.join("note.md"), b"theirs\n");
    scene.recon.observe_event(&scene.path, now);
    scene.fs.advance_ticks(4);
    let events = scene.recon.poll(
        &scene.fs,
        &scene.root,
        Duration::from_millis(scene.fs.tick()),
    );
    let events = [
        events,
        scene.recon.poll(
            &scene.fs,
            &scene.root,
            Duration::from_millis(scene.fs.tick() + 4),
        ),
    ]
    .concat();
    assert!(
        events.iter().any(|e| matches!(
            e,
            ReconEvent::Banner {
                reason: BannerReason::EditWithinWriteSettle,
                ..
            }
        )),
        "an external edit within the write settle window must banner, got {events:?}"
    );
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, ReconEvent::ExternalUpdate { .. })),
        "the banner path must not also ingest"
    );
}

/// A previously non-empty note reading back as zero bytes never ingests.
#[test]
fn zero_byte_read_takes_the_banner_path() {
    let mut scene = recon_scene(b"a full note body\n");
    scene.fs.advance_ticks(100);
    scene.fs.external_write(&scene.root.join("note.md"), b"");
    scene
        .recon
        .observe_event(&scene.path, Duration::from_millis(scene.fs.tick()));
    let events = settle_and_poll(&mut scene);
    assert!(
        events.iter().any(|e| matches!(
            e,
            ReconEvent::Banner {
                reason: BannerReason::BecameEmpty,
                ..
            }
        )),
        "a zero-byte read of a non-empty note must banner, got {events:?}"
    );
}

/// A stable read that shrank past the guard fraction banners after its
/// extra confirmation round instead of ingesting silently.
#[test]
fn large_shrink_takes_the_banner_path() {
    let mut scene = recon_scene(b"a note body long enough that a shrink is measurable\n");
    scene.fs.advance_ticks(100);
    scene
        .fs
        .external_write(&scene.root.join("note.md"), b"tiny\n");
    scene
        .recon
        .observe_event(&scene.path, Duration::from_millis(scene.fs.tick()));
    let events = settle_and_poll(&mut scene);
    assert!(
        events.iter().any(|e| matches!(
            e,
            ReconEvent::Banner {
                reason: BannerReason::SizeShrank,
                ..
            }
        )),
        "a large shrink must banner, got {events:?}"
    );
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, ReconEvent::ExternalUpdate { .. })),
        "a large shrink must never ingest silently"
    );
}

/// More divergent files than the threshold in one pass become one bulk
/// review event and nothing is applied automatically.
#[test]
fn bulk_divergence_is_surfaced_for_review() {
    let fs = SimFs::new();
    let root = PathBuf::from("vault");
    fs.external_create_dir(&root);
    let mut recon = Reconciler::new(test_config());
    let count = 25usize;
    for index in 0..count {
        let name = format!("note-{index:02}.md");
        let initial = format!("initial {index}\n");
        fs.external_write(&root.join(&name), initial.as_bytes());
        let path = VaultPath::new(&name).expect("valid");
        recon.record_read(&path, initial.as_bytes());
    }
    fs.advance_ticks(100);
    // A sync tool completes a bulk pull: every file changes at once.
    for index in 0..count {
        let name = format!("note-{index:02}.md");
        fs.external_write(&root.join(&name), format!("synced {index}\n").as_bytes());
        let path = VaultPath::new(&name).expect("valid");
        recon.observe_event(&path, Duration::from_millis(fs.tick()));
    }
    let mut events = Vec::new();
    for _ in 0..6 {
        fs.advance_ticks(4);
        events.extend(recon.poll(&fs, &root, Duration::from_millis(fs.tick())));
    }
    let bulk: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            ReconEvent::BulkDivergence { paths } => Some(paths.len()),
            _ => None,
        })
        .collect();
    assert_eq!(
        bulk,
        vec![count],
        "the whole divergent set must surface as one review event, got {events:?}"
    );
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, ReconEvent::ExternalUpdate { .. })),
        "above the threshold nothing may be applied automatically"
    );
}

/// An unstable read (content still changing between polls) never
/// classifies until it holds still across the settle interval.
#[test]
fn unstable_reads_never_ingest() {
    let mut scene = recon_scene(b"stable start\n");
    scene.fs.advance_ticks(100);
    // A writer that keeps changing the file between polls.
    for round in 0..5 {
        scene.fs.external_write(
            &scene.root.join("note.md"),
            format!("torn write {round}\n").as_bytes(),
        );
        scene
            .recon
            .observe_event(&scene.path, Duration::from_millis(scene.fs.tick()));
        scene.fs.advance_ticks(4);
        let events = scene.recon.poll(
            &scene.fs,
            &scene.root,
            Duration::from_millis(scene.fs.tick()),
        );
        assert!(
            events.is_empty(),
            "round {round}: an unstable read must never classify, got {events:?}"
        );
    }
    // Once the content holds still, it ingests.
    let events = settle_and_poll(&mut scene);
    assert!(
        events
            .iter()
            .any(|e| matches!(e, ReconEvent::ExternalUpdate { .. })),
        "the final stable content must ingest, got {events:?}"
    );
}
