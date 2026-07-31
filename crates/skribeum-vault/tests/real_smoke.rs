//! Real-filesystem smoke layer: a handful of cases proving `RealFs` matches
//! the simulator's model. Everything substantive runs under the simulator;
//! this suite only pins the real implementation to the same contract.

use std::path::PathBuf;
use std::time::Duration;

use skribeum_vault::{EntryKind, FileSystem, FsError, RealFs, SimFs, Vault};

/// A unique scratch directory for one test, created through the trait.
fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("skribeum-smoke-{}-{name}", std::process::id()));
    RealFs.create_dir_all(&dir).expect("scratch dir creates");
    dir
}

/// Write, read, metadata and delete behave identically to the simulator on
/// one file.
#[test]
fn write_read_metadata_remove_round_trip() {
    let real = RealFs;
    let sim = SimFs::new();
    let real_root = scratch("roundtrip");
    let sim_root = PathBuf::from("vault");
    sim.external_create_dir(&sim_root);

    for fs_and_root in [
        (&real as &dyn FileSystem, real_root.clone()),
        (&sim as &dyn FileSystem, sim_root.clone()),
    ] {
        let (fs, root) = fs_and_root;
        let file = root.join("note.md");
        fs.write_atomic(&file, b"content\n")
            .expect("write succeeds");
        assert_eq!(fs.read(&file).expect("read succeeds"), b"content\n");
        let meta = fs.metadata(&file).expect("metadata succeeds");
        assert_eq!(meta.size, 8);
        assert!(!meta.is_dir);
        fs.remove_file(&file).expect("remove succeeds");
        assert_eq!(fs.read(&file), Err(FsError::NotFound));
    }
}

/// Missing paths surface the same error on both implementations.
#[test]
fn missing_path_maps_to_not_found() {
    let real_root = scratch("missing");
    assert_eq!(
        RealFs.read(&real_root.join("absent.md")),
        Err(FsError::NotFound)
    );
    assert_eq!(
        RealFs.metadata(&real_root.join("absent.md")),
        Err(FsError::NotFound)
    );
    let sim = SimFs::new();
    assert_eq!(
        sim.read(&PathBuf::from("vault/absent.md")),
        Err(FsError::NotFound)
    );
}

/// Directory listing agrees between implementations on names and kinds.
#[test]
fn read_dir_lists_names_and_kinds() {
    let real = RealFs;
    let sim = SimFs::new();
    let real_root = scratch("listing");
    let sim_root = PathBuf::from("vault");
    sim.external_create_dir(&sim_root);

    for fs_and_root in [
        (&real as &dyn FileSystem, real_root.clone()),
        (&sim as &dyn FileSystem, sim_root.clone()),
    ] {
        let (fs, root) = fs_and_root;
        fs.create_dir_all(&root.join("sub"))
            .expect("mkdir succeeds");
        fs.write_atomic(&root.join("a.md"), b"a").expect("write a");
        fs.write_atomic(&root.join("b.txt"), b"b").expect("write b");
        let mut names: Vec<(String, bool)> = fs
            .read_dir(&root)
            .expect("read_dir succeeds")
            .into_iter()
            .map(|e| (e.file_name, e.is_dir))
            .collect();
        names.sort();
        assert_eq!(
            names,
            vec![
                ("a.md".to_owned(), false),
                ("b.txt".to_owned(), false),
                ("sub".to_owned(), true),
            ]
        );
    }
}

/// Rename moves content on both implementations.
#[test]
fn rename_moves_content() {
    let real = RealFs;
    let sim = SimFs::new();
    let real_root = scratch("rename");
    let sim_root = PathBuf::from("vault");
    sim.external_create_dir(&sim_root);

    for fs_and_root in [
        (&real as &dyn FileSystem, real_root.clone()),
        (&sim as &dyn FileSystem, sim_root.clone()),
    ] {
        let (fs, root) = fs_and_root;
        fs.write_atomic(&root.join("old.md"), b"payload")
            .expect("write");
        fs.rename(&root.join("old.md"), &root.join("new.md"))
            .expect("rename");
        assert_eq!(fs.read(&root.join("old.md")), Err(FsError::NotFound));
        assert_eq!(fs.read(&root.join("new.md")).expect("read"), b"payload");
    }
}

/// The vault model built on `RealFs` opens the committed corpus directory,
/// indexes notes and reads every one of them without error or write.
#[test]
fn vault_opens_committed_corpus_on_real_fs() {
    let corpus = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/corpus");
    let vault = Vault::open(&RealFs, &corpus).expect("corpus vault opens");
    let notes: Vec<_> = vault
        .tree()
        .iter()
        .filter(|e| e.kind == EntryKind::Note)
        .collect();
    assert!(notes.len() >= 25, "corpus should index all committed notes");
    for note in notes {
        let content = vault.read_note(&RealFs, &note.path).expect("note reads");
        assert_eq!(content.projection_hash.len(), 64);
    }
}

/// An invalid root fails to open identically on both implementations.
#[test]
fn opening_a_file_as_vault_fails() {
    let real_root = scratch("notdir");
    RealFs
        .write_atomic(&real_root.join("file.md"), b"x")
        .expect("write");
    let real_err = Vault::open(&RealFs, &real_root.join("file.md"));
    assert!(real_err.is_err());

    let sim = SimFs::new();
    sim.external_write(&PathBuf::from("vault/file.md"), b"x");
    let sim_err = Vault::open(&sim, &PathBuf::from("vault/file.md"));
    assert!(sim_err.is_err());

    assert_eq!(
        format!("{:?}", real_err.expect_err("must fail")),
        format!("{:?}", sim_err.expect_err("must fail")),
        "both implementations must report the same vault error"
    );
}

/// The real watcher observes a write under its root, matching the
/// simulator's event vocabulary. Bounded polling; this is the smoke layer's
/// one concession to real time.
#[test]
fn real_watcher_observes_a_write() {
    let root = scratch("watch");
    let mut watcher = RealFs.watch(&root).expect("watch subscribes");
    RealFs
        .write_atomic(&root.join("seen.md"), b"event")
        .expect("write");

    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let mut observed = Vec::new();
    while std::time::Instant::now() < deadline {
        while let Some(event) = watcher.try_next() {
            observed.push(event);
        }
        if !observed.is_empty() {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    assert!(
        !observed.is_empty(),
        "the real watcher must deliver at least one event for a write under its root"
    );
}
