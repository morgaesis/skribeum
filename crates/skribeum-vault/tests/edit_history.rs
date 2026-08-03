use std::path::{Path, PathBuf};

use skribeum_vault::{
    EditHistoryAction, EditHistoryChange, EditHistoryEntry, EditHistoryJournal, EditHistoryRange,
    EditHistorySelection, EditHistoryStateCheck, FileSystem, SimFs,
};

fn entry(index: usize) -> EditHistoryEntry {
    let before = format!("text {index}");
    let after = format!("text {}", index + 1);
    let before_length = u32::try_from(before.len()).expect("test text length fits u32");
    let after_length = u32::try_from(after.len()).expect("test text length fits u32");
    EditHistoryEntry {
        changes: vec![EditHistoryChange {
            from: 5,
            to: before_length,
            insert: (index + 1).to_string(),
        }],
        inverse: vec![EditHistoryChange {
            from: 5,
            to: after_length,
            insert: index.to_string(),
        }],
        selection_before: EditHistorySelection {
            ranges: vec![EditHistoryRange {
                anchor: before_length,
                head: before_length,
            }],
            main: 0,
        },
        selection_after: EditHistorySelection {
            ranges: vec![EditHistoryRange {
                anchor: after_length,
                head: after_length,
            }],
            main: 0,
        },
        before: EditHistoryStateCheck {
            length: before_length,
            projection_hash: format!("before-{index}"),
        },
        after: EditHistoryStateCheck {
            length: after_length,
            projection_hash: format!("after-{index}"),
        },
    }
}

fn journal() -> (SimFs, EditHistoryJournal, PathBuf) {
    let fs = SimFs::new();
    let root = PathBuf::from("vault");
    fs.external_create_dir(&root);
    (
        fs,
        EditHistoryJournal::new(PathBuf::from("appdata/edit-history.jsonl")),
        root,
    )
}

#[test]
fn append_round_trips_forward_inverse_and_selection() {
    let (fs, journal, root) = journal();
    let expected = entry(0);
    journal
        .append(
            &fs,
            &root,
            "note.md",
            "batch-1",
            &[EditHistoryAction::Entry {
                entry: expected.clone(),
            }],
        )
        .expect("history appends");

    let snapshot = journal.read(&fs, &root, "note.md");
    assert_eq!(snapshot.undo, [expected]);
    assert!(snapshot.redo.is_empty());
    assert!(
        fs.metadata(journal.path()).expect("journal exists").size > 0,
        "append writes the application-data journal"
    );
}

#[test]
fn fence_discards_older_entries_but_keeps_later_edits() {
    let (fs, journal, root) = journal();
    journal
        .append(
            &fs,
            &root,
            "note.md",
            "before-fence",
            &[EditHistoryAction::Entry { entry: entry(0) }],
        )
        .expect("first entry appends");
    journal
        .append(&fs, &root, "note.md", "fence", &[EditHistoryAction::Fence])
        .expect("fence appends");
    journal
        .append(
            &fs,
            &root,
            "note.md",
            "after-fence",
            &[EditHistoryAction::Entry { entry: entry(1) }],
        )
        .expect("post-fence entry appends");

    let snapshot = journal.read(&fs, &root, "note.md");
    assert_eq!(snapshot.undo, [entry(1)]);
    assert!(snapshot.redo.is_empty());
}

#[test]
fn count_and_byte_caps_trim_from_the_oldest_end() {
    let (fs, journal, root) = journal();
    let journal = journal.with_caps(3, 2_400);
    for index in 0..8 {
        journal
            .append(
                &fs,
                &root,
                "note.md",
                &format!("batch-{index}"),
                &[EditHistoryAction::Entry {
                    entry: entry(index),
                }],
            )
            .expect("entry appends");
    }

    let snapshot = journal.read(&fs, &root, "note.md");
    assert!(!snapshot.undo.is_empty());
    assert!(snapshot.undo.len() <= 3);
    assert_eq!(snapshot.undo.last(), Some(&entry(7)));
    assert_ne!(snapshot.undo.first(), Some(&entry(0)));
    let note_bytes = fs.metadata(journal.path()).expect("journal exists").size;
    assert!(note_bytes <= 2_400, "byte cap bounds the retained note");
}

#[test]
fn deleted_note_gc_removes_only_the_target_journal() {
    let (fs, journal, root) = journal();
    fs.external_write(&root.join("gone.md"), b"gone");
    fs.external_write(&root.join("kept.md"), b"kept");
    for (path, batch, value) in [("gone.md", "gone", 0), ("kept.md", "kept", 1)] {
        journal
            .append(
                &fs,
                &root,
                path,
                batch,
                &[EditHistoryAction::Entry {
                    entry: entry(value),
                }],
            )
            .expect("entry appends");
    }

    fs.external_remove(&root.join("gone.md"));
    journal
        .garbage_collect(&fs, &root)
        .expect("deleted note history removes");
    assert!(journal.read(&fs, &root, "gone.md").undo.is_empty());
    assert_eq!(journal.read(&fs, &root, "kept.md").undo, [entry(1)]);
}

#[test]
fn duplicate_batches_are_idempotent() {
    let (fs, journal, root) = journal();
    let action = EditHistoryAction::Entry { entry: entry(0) };
    for _ in 0..2 {
        journal
            .append(
                &fs,
                &root,
                "note.md",
                "same-batch",
                std::slice::from_ref(&action),
            )
            .expect("batch appends");
    }
    assert_eq!(journal.read(&fs, &root, "note.md").undo, [entry(0)]);
}

#[test]
fn undo_and_redo_actions_move_the_persisted_cursor_symmetrically() {
    let (fs, journal, root) = journal();
    journal
        .append(
            &fs,
            &root,
            "note.md",
            "entries",
            &[
                EditHistoryAction::Entry { entry: entry(0) },
                EditHistoryAction::Entry { entry: entry(1) },
            ],
        )
        .expect("entries append");
    journal
        .append(
            &fs,
            &root,
            "note.md",
            "undo",
            &[EditHistoryAction::Undo { count: 1 }],
        )
        .expect("undo appends");
    let undone = journal.read(&fs, &root, "note.md");
    assert_eq!(undone.undo, [entry(0)]);
    assert_eq!(undone.redo, [entry(1)]);

    journal
        .append(
            &fs,
            &root,
            "note.md",
            "redo",
            &[EditHistoryAction::Redo { count: 1 }],
        )
        .expect("redo appends");
    let redone = journal.read(&fs, &root, "note.md");
    assert_eq!(redone.undo, [entry(0), entry(1)]);
    assert!(redone.redo.is_empty());
}

#[test]
fn journals_are_keyed_by_vault_identity_and_note_path() {
    let (fs, journal, root) = journal();
    let other_root = Path::new("other-vault");
    fs.external_create_dir(other_root);
    journal
        .append(
            &fs,
            &root,
            "same.md",
            "first",
            &[EditHistoryAction::Entry { entry: entry(0) }],
        )
        .expect("first vault appends");
    journal
        .append(
            &fs,
            other_root,
            "same.md",
            "second",
            &[EditHistoryAction::Entry { entry: entry(1) }],
        )
        .expect("second vault appends");

    assert_eq!(journal.read(&fs, &root, "same.md").undo, [entry(0)]);
    assert_eq!(journal.read(&fs, other_root, "same.md").undo, [entry(1)]);
}
