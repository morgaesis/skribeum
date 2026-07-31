//! The seeded deterministic simulator harness: reproducibility, the
//! zero-writes-on-open property, read-only vault mode, and modeled
//! network-mount semantics (latency, stale reads, event loss).

use std::path::{Path, PathBuf};

use skribeum_vault::{
    Encoding, EntryKind, FileSystem, FsError, NetworkProfile, Scheduler, SimFs, Vault, WatchEvent,
};

fn build_vault(fs: &SimFs) -> PathBuf {
    let root = PathBuf::from("vault");
    fs.external_create_dir(&root.join("folder"));
    fs.external_write(&root.join("welcome.md"), b"# Welcome\n");
    fs.external_write(&root.join("folder/nested.md"), b"nested\n");
    fs.external_write(&root.join("folder/data.csv"), b"a,b\n");
    fs.external_write(&root.join(".hidden.md"), b"hidden\n");
    fs.external_write(
        &root.join("note.sync-conflict-20260101-120000-ABCDEF.md"),
        b"conflict artifact\n",
    );
    fs.external_create_dir(&root.join(".git"));
    fs.external_write(&root.join(".git/config"), b"[core]\n");
    fs.external_create_dir(&root.join(".obsidian"));
    fs.external_write(&root.join(".obsidian/workspace.json"), b"{}\n");
    fs.external_create_dir(&root.join(".skribeum"));
    fs.external_write(&root.join(".skribeum/state"), b"internal\n");
    // Drain setup events so tests start from a quiet queue.
    fs.deliver_all();
    root
}

/// Opening a vault, listing its tree and reading every note performs zero
/// writes, asserted mechanically through the simulator's write counter.
#[test]
fn open_tree_read_performs_zero_writes() {
    let fs = SimFs::new();
    let root = build_vault(&fs);

    let vault = Vault::open(&fs, &root).expect("vault opens");
    for entry in vault.tree() {
        if entry.kind == EntryKind::Note {
            vault
                .read_note(&fs, &entry.path)
                .expect("indexed note reads");
        }
    }

    assert_eq!(
        fs.app_write_count(),
        0,
        "opening a vault must never write; the counter is the mechanical proof"
    );
}

/// A read-only vault opens and browses normally while every write attempt
/// fails.
#[test]
fn read_only_vault_opens_and_rejects_writes() {
    let fs = SimFs::new();
    let root = build_vault(&fs);
    fs.set_read_only(true);

    let vault = Vault::open(&fs, &root).expect("read-only vault opens");
    assert!(!vault.tree().is_empty());
    for entry in vault.tree() {
        if entry.kind == EntryKind::Note {
            vault
                .read_note(&fs, &entry.path)
                .expect("read-only note reads");
        }
    }
    assert_eq!(fs.app_write_count(), 0);

    assert_eq!(
        fs.write_file(&root.join("welcome.md"), b"changed"),
        Err(FsError::ReadOnly)
    );
    assert_eq!(
        fs.rename(&root.join("welcome.md"), &root.join("renamed.md")),
        Err(FsError::ReadOnly)
    );
    assert_eq!(
        fs.remove_file(&root.join("welcome.md")),
        Err(FsError::ReadOnly)
    );
}

/// The exclusion list from the reconciliation design holds at index time.
#[test]
fn excluded_paths_are_not_indexed() {
    let fs = SimFs::new();
    let root = build_vault(&fs);
    let vault = Vault::open(&fs, &root).expect("vault opens");

    let paths: Vec<&str> = vault.tree().iter().map(|e| e.path.as_str()).collect();
    assert!(paths.contains(&"welcome.md"));
    assert!(paths.contains(&"folder/nested.md"));
    assert!(
        paths.contains(&"folder/data.csv"),
        "non-md files are typed, not dropped"
    );
    assert!(
        paths.contains(&".hidden.md"),
        "hidden files are typed, not dropped"
    );
    for excluded in [".git", ".obsidian", ".skribeum"] {
        assert!(
            !paths.iter().any(|p| p.starts_with(excluded)),
            "{excluded} must be excluded from indexing"
        );
    }
    assert!(
        !paths.iter().any(|p| p.contains(".sync-conflict-")),
        "sync-conflict artifacts must be excluded from indexing"
    );

    let hidden = vault
        .tree()
        .iter()
        .find(|e| e.path.as_str() == ".hidden.md")
        .expect("hidden note indexed");
    assert!(hidden.hidden);
    assert_eq!(hidden.kind, EntryKind::Note);
    let csv = vault
        .tree()
        .iter()
        .find(|e| e.path.as_str() == "folder/data.csv")
        .expect("csv indexed");
    assert_eq!(csv.kind, EntryKind::File);
}

/// Case collisions are surfaced at index time, never silently merged.
#[test]
fn case_collision_is_surfaced() {
    let fs = SimFs::new();
    let root = PathBuf::from("vault");
    fs.external_write(&root.join("Note.md"), b"upper\n");
    fs.external_write(&root.join("note.md"), b"lower\n");
    let vault = Vault::open(&fs, &root).expect("vault opens");
    assert_eq!(vault.collisions().len(), 1);
    assert_eq!(
        vault.collisions()[0].paths,
        vec!["Note.md".to_owned(), "note.md".to_owned()]
    );
    assert_eq!(vault.tree().len(), 2, "both entries stay in the tree");
}

/// Encoding classification distinguishes UTF-8, UTF-8 with BOM, and
/// non-UTF-8, with the BOM preserved in the returned bytes.
#[test]
fn encoding_classification() {
    let fs = SimFs::new();
    let root = PathBuf::from("vault");
    fs.external_write(&root.join("plain.md"), b"plain\n");
    fs.external_write(&root.join("bom.md"), &[0xEF, 0xBB, 0xBF, b'x', b'\n']);
    fs.external_write(&root.join("binary.md"), &[0xC0, 0xFF, 0x00]);
    let vault = Vault::open(&fs, &root).expect("vault opens");

    let read = |name: &str| {
        vault
            .read_note(&fs, &skribeum_vault::VaultPath::new(name).expect("valid"))
            .expect("note reads")
    };
    assert_eq!(read("plain.md").encoding, Encoding::Utf8);
    let bom = read("bom.md");
    assert_eq!(bom.encoding, Encoding::Utf8Bom);
    assert_eq!(bom.bytes[..3], [0xEF, 0xBB, 0xBF]);
    assert_eq!(read("binary.md").encoding, Encoding::NonUtf8);
    assert_eq!(read("plain.md").projection_hash.len(), 64);
}

/// Two runs from one seed produce identical op sequences, traces and
/// observed watcher events; different seeds diverge.
#[test]
fn scheduler_is_seed_reproducible() {
    let run = |seed: u64| {
        let fs = SimFs::new();
        fs.seed(seed);
        fs.set_network_profile(NetworkProfile {
            latency_ticks: 3,
            stale_read_percent: 20,
            event_loss_percent: 10,
        });
        let root = build_vault(&fs);
        let paths: Vec<PathBuf> = ["a.md", "b.md", "folder/c.md"]
            .iter()
            .map(|p| root.join(p))
            .collect();
        let mut scheduler = Scheduler::new(seed, paths);
        let mut ops = Vec::new();
        for _ in 0..200 {
            ops.push(format!("{:?}", scheduler.step(&fs)));
        }
        // Read through the trait as the app would, exercising stale reads.
        let _ = fs.read(&root.join("a.md"));
        let _ = fs.read(&root.join("welcome.md"));
        (ops, fs.trace(), drain_events(&fs, &root))
    };

    let first = run(42);
    let second = run(42);
    assert_eq!(first, second, "same seed must replay identically");

    let third = run(43);
    assert_ne!(first.1, third.1, "different seeds must diverge");
}

fn drain_events(fs: &SimFs, root: &Path) -> Vec<WatchEvent> {
    fs.advance_ticks(1_000);
    fs.deliver_all();
    let mut watcher = fs.watch(root).expect("sim watch");
    let mut events = Vec::new();
    while let Some(event) = watcher.try_next() {
        events.push(event);
    }
    events
}

/// With latency configured, an event queued now is not deliverable until the
/// clock advances past the latency window.
#[test]
fn network_latency_delays_delivery() {
    let fs = SimFs::new();
    fs.seed(1);
    fs.set_network_profile(NetworkProfile {
        latency_ticks: 5,
        stale_read_percent: 0,
        event_loss_percent: 0,
    });
    let root = PathBuf::from("vault");
    fs.external_create_dir(&root);
    fs.deliver_all();

    fs.external_write(&root.join("late.md"), b"late\n");
    assert!(!fs.deliver_one(), "event must wait out the latency window");
    fs.advance_ticks(5);
    assert!(fs.deliver_one(), "event becomes deliverable after latency");
}

/// Within the latency window of an external overwrite, a stale read returns
/// the previous content; after the window it always returns current bytes.
#[test]
fn network_stale_reads_serve_previous_content_within_window() {
    let fs = SimFs::new();
    fs.seed(7);
    fs.set_network_profile(NetworkProfile {
        latency_ticks: 10,
        stale_read_percent: 100,
        event_loss_percent: 0,
    });
    let root = PathBuf::from("vault");
    fs.external_write(&root.join("n.md"), b"old");
    fs.advance_ticks(20);
    fs.external_write(&root.join("n.md"), b"new");

    let within = fs.read(&root.join("n.md")).expect("read succeeds");
    assert_eq!(
        within, b"old",
        "read inside the window observes stale bytes"
    );

    fs.advance_ticks(20);
    let after = fs.read(&root.join("n.md")).expect("read succeeds");
    assert_eq!(
        after, b"new",
        "read after the window observes current bytes"
    );
}

/// With total event loss, external writes still mutate state while the
/// watcher observes nothing: the lost-event case reconciliation must handle.
#[test]
fn network_event_loss_drops_events_without_losing_state() {
    let fs = SimFs::new();
    fs.seed(3);
    fs.set_network_profile(NetworkProfile {
        latency_ticks: 0,
        stale_read_percent: 0,
        event_loss_percent: 100,
    });
    let root = PathBuf::from("vault");
    fs.external_create_dir(&root);
    fs.deliver_all();

    fs.external_write(&root.join("silent.md"), b"content");
    fs.deliver_all();
    let mut watcher = fs.watch(&root).expect("sim watch");
    assert!(watcher.try_next().is_none(), "the event was lost");
    assert_eq!(
        fs.read(&root.join("silent.md")).expect("read succeeds"),
        b"content",
        "the write itself is durable; only its event was lost"
    );
}

/// Consecutive modifications of one path may coalesce into a single
/// delivered event.
#[test]
fn consecutive_modifications_coalesce() {
    let fs = SimFs::new();
    let root = PathBuf::from("vault");
    fs.external_write(&root.join("c.md"), b"v1");
    fs.deliver_all();
    let mut watcher = fs.watch(&root).expect("sim watch");
    while watcher.try_next().is_some() {}

    fs.external_write(&root.join("c.md"), b"v2");
    fs.external_write(&root.join("c.md"), b"v3");
    fs.external_write(&root.join("c.md"), b"v4");
    fs.deliver_all();

    let mut events = Vec::new();
    while let Some(event) = watcher.try_next() {
        events.push(event);
    }
    assert_eq!(
        events,
        vec![WatchEvent::Modified(root.join("c.md"))],
        "three writes coalesce into one modification event"
    );
}

/// Renames and deletes flow through the event queue with their paths.
#[test]
fn rename_and_delete_events_are_observable() {
    let fs = SimFs::new();
    let root = PathBuf::from("vault");
    fs.external_write(&root.join("a.md"), b"a");
    fs.deliver_all();
    let mut watcher = fs.watch(&root).expect("sim watch");
    while watcher.try_next().is_some() {}

    fs.external_rename(&root.join("a.md"), &root.join("b.md"));
    fs.external_remove(&root.join("b.md"));
    fs.deliver_all();

    let mut events = Vec::new();
    while let Some(event) = watcher.try_next() {
        events.push(event);
    }
    assert_eq!(
        events,
        vec![
            WatchEvent::Renamed {
                from: root.join("a.md"),
                to: root.join("b.md"),
            },
            WatchEvent::Removed(root.join("b.md")),
        ]
    );
}
