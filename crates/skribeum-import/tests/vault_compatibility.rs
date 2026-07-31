mod common;

use skribeum_import::{ImportOptions, import_notion};
use skribeum_vault::{EntryKind, RealFs, Vault, VaultPath};

#[test]
fn imported_corpus_opens_and_reads_as_a_collision_free_vault() {
    let temp = tempfile::tempdir().expect("temporary directory creates");
    let archive = temp.path().join("pages.zip");
    let output = temp.path().join("vault");
    common::archive_from_tree("pages", &archive);
    import_notion(&ImportOptions {
        archive,
        out: output.clone(),
        dry_run: false,
        force: false,
    })
    .expect("corpus imports");

    let vault = Vault::open(&RealFs, &output).expect("imported vault opens");
    assert!(
        vault.collisions().is_empty(),
        "imported vault has no path collisions: {:?}",
        vault.collisions()
    );
    let note_path = VaultPath::new("Workspace.md").expect("valid vault path");
    let note = vault
        .read_note(&RealFs, &note_path)
        .expect("imported note reads");
    assert!(note.bytes.starts_with(b"---\ncreated:"));
    assert_eq!(
        vault
            .tree()
            .iter()
            .filter(|entry| entry.kind == EntryKind::Note)
            .count(),
        6
    );
}
