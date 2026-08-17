//! Byte fidelity of the rename link rewrite, over the full committed
//! corpus and through the production change-set write path. Three
//! properties per corpus file: a rename retargets only the bytes of the
//! link targets that pointed at the renamed note, every other byte in every
//! other file is untouched, and reversing the rename restores every file
//! byte for byte. Zero skips: every committed corpus file runs.

use std::path::{Path, PathBuf};

use skribeum_core::{ByteRangeReplace, WikilinkResolution, apply_change_set, resolve_wikilink};
use skribeum_vault::{Encoding, FileSystem, MoveRecord, RealFs, SimFs, Vault, VaultPath, classify};

const OLD_NOTE: &str = "garden-journal.md";
const NEW_NOTE: &str = "plot-notes.md";

fn corpus_files() -> Vec<(String, Vec<u8>)> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/corpus");
    let mut files = Vec::new();
    for entry in RealFs.read_dir(&dir).expect("corpus directory reads") {
        if entry.is_dir || !entry.file_name.to_lowercase().ends_with(".md") {
            continue;
        }
        let bytes = RealFs.read(&entry.path).expect("corpus file reads");
        files.push((entry.file_name, bytes));
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));
    assert!(
        files.len() >= 30,
        "expected the full corpus, found {} files",
        files.len()
    );
    files
}

/// A simulated vault holding `bytes` at `note.md` beside the note the
/// rename targets, so every corpus file is exercised as a linking note.
fn vault_with(bytes: &[u8]) -> (SimFs, Vault) {
    let fs = SimFs::new();
    let root = PathBuf::from("vault");
    fs.external_create_dir(&root);
    fs.external_write(&root.join("note.md"), bytes);
    fs.external_write(&root.join(OLD_NOTE), b"# Garden journal\n");
    fs.deliver_all();
    let vault = Vault::open(&fs, &root).expect("vault opens");
    (fs, vault)
}

fn path(value: &str) -> VaultPath {
    VaultPath::new(value).expect("valid vault path")
}

fn read(fs: &SimFs, relative: &str) -> Vec<u8> {
    fs.read(&Path::new("vault").join(relative))
        .expect("file reads")
}

/// The whole-file property: the written bytes are exactly the declared
/// change set applied to the original, so no byte outside a declared span
/// moved, and no byte inside one changed to anything but what was declared.
fn assert_only_declared_changes(
    original: &[u8],
    written: &[u8],
    changes: &[ByteRangeReplace],
    file: &str,
) {
    let expected = apply_change_set(original, changes).expect("declared changes apply");
    assert_eq!(
        written, expected,
        "{file}: only the declared link-target bytes may change"
    );
}

/// The meaning property: every declared span held a target that named the
/// renamed note, and now holds one that names its new path.
fn assert_every_change_is_a_link_target(
    original: &[u8],
    changes: &[ByteRangeReplace],
    index_before: &[String],
    index_after: &[String],
    file: &str,
) {
    let text = std::str::from_utf8(original).expect("corpus note is UTF-8");
    for change in changes {
        let before = &text[change.start..change.end];
        let after = std::str::from_utf8(&change.bytes).expect("replacement is UTF-8");
        assert!(
            text[..change.start].trim_end_matches(' ').ends_with("[["),
            "{file}: the change at {} does not start at a link target",
            change.start
        );
        assert!(
            !before.contains(['[', ']', '|', '#']) && !after.contains(['[', ']', '|', '#']),
            "{file}: the change covers more than the target path: {before:?} to {after:?}"
        );
        assert!(
            matches!(
                resolve_wikilink(before, index_before),
                WikilinkResolution::Resolved { path, .. } if path == OLD_NOTE
            ),
            "{file}: the replaced target {before:?} must have named the renamed note"
        );
        assert!(
            matches!(
                resolve_wikilink(after, index_after),
                WikilinkResolution::Resolved { path, .. } if path == NEW_NOTE
            ),
            "{file}: the rewritten target {after:?} must resolve to the renamed note"
        );
    }
}

fn index_after_rename(vault: &Vault) -> Vec<String> {
    vault
        .tree()
        .iter()
        .map(|entry| entry.path.as_str().to_owned())
        .collect()
}

/// Renaming a note rewrites only the link targets that pointed at it, in
/// every corpus file, and leaves a file that never referenced it identical.
#[test]
fn a_rename_changes_only_link_target_bytes_for_every_corpus_file() {
    let mut referencing = 0usize;
    for (name, bytes) in corpus_files() {
        let (fs, mut vault) = vault_with(&bytes);
        let planned = vault
            .plan_link_updates(&fs, &path(OLD_NOTE), &path(NEW_NOTE))
            .expect("the plan reads the vault");
        let declared = planned
            .iter()
            .find(|update| update.path.as_str() == "note.md")
            .map(|update| update.changes.clone())
            .unwrap_or_default();

        let note = vault.read_note(&fs, &path("note.md")).expect("note reads");
        if note.encoding == Encoding::NonUtf8 {
            assert!(
                declared.is_empty(),
                "{name}: a non-UTF-8 note is never rewritten"
            );
        }

        vault
            .move_entry_updating_links(&fs, &path(OLD_NOTE), &path(NEW_NOTE))
            .expect("the rename applies");

        let written = read(&fs, "note.md");
        assert_only_declared_changes(&bytes, &written, &declared, &name);
        if declared.is_empty() {
            assert_eq!(
                written, bytes,
                "{name}: a note that never referenced the renamed note is untouched"
            );
        } else {
            referencing += 1;
            assert_ne!(written, bytes, "{name}: the declared changes must land");
            assert_every_change_is_a_link_target(
                &bytes,
                &declared,
                &[OLD_NOTE.to_owned(), "note.md".to_owned()],
                &index_after_rename(&vault),
                &name,
            );
        }
    }
    assert!(
        referencing >= 2,
        "the corpus must exercise the rewrite, rewrote {referencing} files"
    );
}

/// Reversing a rename restores every rewritten file byte for byte and puts
/// the entry back where it was.
#[test]
fn reverting_a_rename_restores_every_file_byte_for_byte() {
    for (name, bytes) in corpus_files() {
        let (fs, mut vault) = vault_with(&bytes);
        let record = vault
            .move_entry_updating_links(&fs, &path(OLD_NOTE), &path(NEW_NOTE))
            .expect("the rename applies");
        vault
            .revert_move(&fs, &record)
            .expect("the rename reverses");

        assert_eq!(
            read(&fs, "note.md"),
            bytes,
            "{name}: undo restores the linking note's bytes"
        );
        assert_eq!(
            read(&fs, OLD_NOTE),
            b"# Garden journal\n",
            "{name}: undo restores the renamed note"
        );
        assert!(
            vault.tree().iter().any(|e| e.path.as_str() == OLD_NOTE),
            "{name}: undo restores the original path"
        );
        assert!(
            !vault.tree().iter().any(|e| e.path.as_str() == NEW_NOTE),
            "{name}: undo leaves no note at the new path"
        );
    }
}

/// A link that merely looks similar, and one written inside code, are not
/// references and are not touched.
#[test]
fn text_that_only_resembles_the_renamed_note_is_left_alone() {
    let source = concat!(
        "A real link [[garden-journal|the journal]].\n",
        "A different note [[garden-journal-archive]].\n",
        "The words garden-journal in prose.\n",
        "`[[garden-journal]]` inside code.\n",
        "```\n[[garden-journal]]\n```\n",
    );
    let fs = SimFs::new();
    let root = PathBuf::from("vault");
    fs.external_create_dir(&root);
    fs.external_write(&root.join("note.md"), source.as_bytes());
    fs.external_write(&root.join(OLD_NOTE), b"x\n");
    fs.external_write(&root.join("garden-journal-archive.md"), b"y\n");
    fs.deliver_all();
    let mut vault = Vault::open(&fs, &root).expect("vault opens");
    vault
        .move_entry_updating_links(&fs, &path(OLD_NOTE), &path(NEW_NOTE))
        .expect("the rename applies");

    let written = String::from_utf8(read(&fs, "note.md")).expect("UTF-8");
    assert_eq!(
        written,
        source.replacen("[[garden-journal|", "[[plot-notes|", 1),
        "only the one resolving reference may change"
    );
}

/// A rename that touches nothing writes nothing at all.
#[test]
fn a_rename_with_no_inbound_links_writes_no_other_file() {
    let fs = SimFs::new();
    let root = PathBuf::from("vault");
    fs.external_create_dir(&root);
    fs.external_write(&root.join("note.md"), b"No links here.\n");
    fs.external_write(&root.join(OLD_NOTE), b"x\n");
    fs.deliver_all();
    let mut vault = Vault::open(&fs, &root).expect("vault opens");
    let record = vault
        .move_entry_updating_links(&fs, &path(OLD_NOTE), &path(NEW_NOTE))
        .expect("the rename applies");
    assert_eq!(record.restore, Vec::new(), "no note was rewritten");
    assert_eq!(record.skipped, Vec::new(), "no note was skipped");
    assert_eq!(read(&fs, "note.md"), b"No links here.\n");
}

/// Moving a folder carries the links to every note inside it, and the
/// shortest-form targets among them stay short.
#[test]
fn moving_a_folder_retargets_links_to_every_note_inside_it() {
    let fs = SimFs::new();
    let root = PathBuf::from("vault");
    fs.external_create_dir(&root);
    fs.external_create_dir(&root.join("Personal"));
    fs.external_write(&root.join("Personal/travel-plan.md"), b"trip\n");
    fs.external_write(
        &root.join("index.md"),
        b"See [[Personal/travel-plan|the trip]] and [[travel-plan]].\n",
    );
    fs.deliver_all();
    let mut vault = Vault::open(&fs, &root).expect("vault opens");
    vault
        .move_entry_updating_links(&fs, &path("Personal"), &path("Trips"))
        .expect("the move applies");

    assert_eq!(
        String::from_utf8(read(&fs, "index.md")).expect("UTF-8"),
        "See [[Trips/travel-plan|the trip]] and [[travel-plan]].\n"
    );
    let index = index_after_rename(&vault);
    assert!(matches!(
        resolve_wikilink("Trips/travel-plan", &index),
        WikilinkResolution::Resolved { path, .. } if path == "Trips/travel-plan.md"
    ));
}

/// Mutation companion: the whole-file checker must reject a writer that
/// normalizes line endings while it rewrites a link, and the undo check
/// must reject an undo that leaves a stray byte behind. A checker that
/// cannot fail is a tautology.
#[test]
fn the_checkers_reject_a_writer_that_touches_more_than_the_target() {
    let original = b"See [[garden-journal]].\r\nNext line.\r\n".to_vec();
    let changes = vec![ByteRangeReplace {
        start: 6,
        end: 20,
        bytes: b"plot-notes".to_vec(),
    }];
    let honest = apply_change_set(&original, &changes).expect("changes apply");
    assert_only_declared_changes(&original, &honest, &changes, "companion");

    let normalizing = b"See [[plot-notes]].\nNext line.\n".to_vec();
    let rejected = std::panic::catch_unwind(|| {
        assert_only_declared_changes(&original, &normalizing, &changes, "companion");
    });
    assert!(
        rejected.is_err(),
        "the checker must reject a writer that normalizes bytes outside the target"
    );
}

/// A recorded move names both paths, so the undo affordance can describe
/// what it will put back.
#[test]
fn a_move_record_names_the_notes_it_rewrote() {
    let fs = SimFs::new();
    let root = PathBuf::from("vault");
    fs.external_create_dir(&root);
    fs.external_write(&root.join("a.md"), b"[[garden-journal]]\n");
    fs.external_write(&root.join("b.md"), b"nothing\n");
    fs.external_write(&root.join(OLD_NOTE), b"x\n");
    fs.deliver_all();
    let mut vault = Vault::open(&fs, &root).expect("vault opens");
    let record: MoveRecord = vault
        .move_entry_updating_links(&fs, &path(OLD_NOTE), &path(NEW_NOTE))
        .expect("the rename applies");
    assert_eq!(record.from.as_str(), OLD_NOTE);
    assert_eq!(record.to.as_str(), NEW_NOTE);
    assert_eq!(
        record
            .restore
            .iter()
            .map(|update| update.path.as_str().to_owned())
            .collect::<Vec<_>>(),
        vec!["a.md".to_owned()]
    );
    assert_eq!(record.restore[0].references, 1);
}

/// A non-UTF-8 note is never opened for rewriting, whatever it contains.
#[test]
fn a_non_utf8_note_is_never_rewritten() {
    let latin1 = b"Caf\xe9 links to [[garden-journal]].\n".to_vec();
    assert_eq!(classify(latin1.clone()).encoding, Encoding::NonUtf8);
    let fs = SimFs::new();
    let root = PathBuf::from("vault");
    fs.external_create_dir(&root);
    fs.external_write(&root.join("note.md"), &latin1);
    fs.external_write(&root.join(OLD_NOTE), b"x\n");
    fs.deliver_all();
    let mut vault = Vault::open(&fs, &root).expect("vault opens");
    vault
        .move_entry_updating_links(&fs, &path(OLD_NOTE), &path(NEW_NOTE))
        .expect("the rename applies");
    assert_eq!(read(&fs, "note.md"), latin1);
}
