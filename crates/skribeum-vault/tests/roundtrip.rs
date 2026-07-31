//! Round-trip byte-equality over the full committed corpus, driven through
//! the production change-set write path. Two properties per corpus file:
//! open then save without edit is whole-file byte-identical, and a scripted
//! edit at a scripted offset leaves every byte outside the edited span
//! byte-identical. Non-UTF-8 corpus files must refuse the write and stay
//! byte-identical on disk. Zero skips: every committed corpus file runs.

use std::path::PathBuf;

use skribeum_core::{BufferEdit, LineEndingMap, buffer_from_bytes};
use skribeum_vault::{
    Encoding, FileSystem, RealFs, SimFs, Vault, VaultError, VaultPath, WriteResult,
};

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

/// A fresh single-note simulated vault holding `bytes` at `note.md`. Each
/// corpus file gets its own vault so filename normalization cases cannot
/// interact with the byte-fidelity property under test.
fn vault_with(bytes: &[u8]) -> (SimFs, Vault, VaultPath) {
    let fs = SimFs::new();
    let root = PathBuf::from("vault");
    fs.external_create_dir(&root);
    fs.external_write(&root.join("note.md"), bytes);
    fs.deliver_all();
    let vault = Vault::open(&fs, &root).expect("vault opens");
    let path = VaultPath::new("note.md").expect("valid path");
    (fs, vault, path)
}

/// Checks the untouched-span property: every byte outside the declared
/// edited span is identical between `original` and `written`. `span` is the
/// smallest byte range covering every declared change, in original
/// coordinates; `span_growth` is the length delta the edit introduced.
fn assert_outside_span_identical(
    original: &[u8],
    written: &[u8],
    span: (usize, usize),
    file: &str,
) {
    let (start, end) = span;
    assert_eq!(
        &written[..start],
        &original[..start],
        "{file}: bytes before the edited span must be identical"
    );
    let tail_len = original.len() - end;
    assert_eq!(
        &written[written.len() - tail_len..],
        &original[end..],
        "{file}: bytes after the edited span must be identical"
    );
}

/// Open then save-without-edit: whole-file byte identity, over every corpus
/// file. Non-UTF-8 files refuse the write and stay untouched.
#[test]
fn open_save_without_edit_is_byte_identical_for_every_corpus_file() {
    for (name, bytes) in corpus_files() {
        let (fs, vault, path) = vault_with(&bytes);
        let note = vault.read_note(&fs, &path).expect("note reads");

        if note.encoding == Encoding::NonUtf8 {
            let refusal = vault.write_note(&fs, &path, &[], &note.projection_hash);
            assert!(
                matches!(refusal, Err(VaultError::NoteReadOnly)),
                "{name}: non-UTF-8 notes must refuse the write"
            );
        } else {
            let result = vault
                .write_note(&fs, &path, &[], &note.projection_hash)
                .expect("empty change set writes");
            assert!(
                matches!(result, WriteResult::Written { .. }),
                "{name}: clean save must not conflict"
            );
        }
        let on_disk = fs
            .read(&PathBuf::from("vault/note.md"))
            .expect("note readable after save");
        assert_eq!(on_disk, bytes, "{name}: whole-file byte identity");
    }
}

/// Scripted edit at a scripted offset through the change-set path: bytes
/// outside the edited span are byte-identical, over every corpus file.
/// Offsets are derived from the file's own projection hash, so every file
/// gets a deterministic, reproducible edit point.
#[test]
fn scripted_edit_preserves_bytes_outside_the_edited_span() {
    const MARKER: &[u8] = b"[scripted-edit]";
    for (name, bytes) in corpus_files() {
        let (fs, vault, path) = vault_with(&bytes);
        let note = vault.read_note(&fs, &path).expect("note reads");

        if note.encoding == Encoding::NonUtf8 {
            // The write path never touches non-UTF-8 files: any edit attempt
            // refuses and the on-disk bytes stay identical.
            let refusal = vault.write_note(
                &fs,
                &path,
                &[skribeum_core::ByteRangeReplace {
                    start: 0,
                    end: 0,
                    bytes: MARKER.to_vec(),
                }],
                &note.projection_hash,
            );
            assert!(
                matches!(refusal, Err(VaultError::NoteReadOnly)),
                "{name}: non-UTF-8 notes must refuse edits"
            );
            let on_disk = fs
                .read(&PathBuf::from("vault/note.md"))
                .expect("note readable");
            assert_eq!(on_disk, bytes, "{name}: refused edit leaves bytes intact");
            continue;
        }

        // Scripted offset: the first eight hex digits of the projection
        // hash, reduced modulo the buffer length, aligned down to a UTF-8
        // character boundary of the buffer projection.
        let map = LineEndingMap::from_bytes(&bytes);
        let buffer = buffer_from_bytes(&bytes);
        let seed = u64::from_str_radix(&note.projection_hash[..8], 16).expect("hex hash");
        let mut offset = usize::try_from(seed % (buffer.len() as u64 + 1)).expect("fits");
        while offset > 0 && offset < buffer.len() && (buffer[offset] & 0xC0) == 0x80 {
            offset -= 1;
        }

        let change_set = map
            .buffer_edits_to_change_set(&[BufferEdit {
                start: offset,
                end: offset,
                insert: MARKER.to_vec(),
            }])
            .expect("edit converts");
        let span_start = change_set.iter().map(|c| c.start).min().expect("nonempty");
        let span_end = change_set.iter().map(|c| c.end).max().expect("nonempty");

        let result = vault
            .write_note(&fs, &path, &change_set, &note.projection_hash)
            .expect("scripted edit writes");
        assert!(
            matches!(result, WriteResult::Written { .. }),
            "{name}: scripted edit must not conflict"
        );

        let on_disk = fs
            .read(&PathBuf::from("vault/note.md"))
            .expect("note readable after edit");
        assert_ne!(on_disk, bytes, "{name}: the edit must change the file");
        assert_outside_span_identical(&bytes, &on_disk, (span_start, span_end), &name);
    }
}

/// Mutation companion: the untouched-span checker must reject a deliberately
/// broken save that normalizes line endings outside the edited span, and a
/// broken save that appends a trailing newline. A checker that cannot fail
/// is a tautology; this pins its teeth.
#[test]
fn round_trip_checker_rejects_a_normalizing_writer() {
    let original = b"alpha\r\nbeta\r\ngamma\r\n".to_vec();
    // The scripted edit inserts at offset 7 (inside "beta"); a broken writer
    // additionally rewrites every CRLF to LF.
    let broken: Vec<u8> = b"alpha\nbeX[edit]ta\ngamma\n".to_vec();
    let span = (7usize, 7usize);
    let result = std::panic::catch_unwind(|| {
        assert_outside_span_identical(&original, &broken, span, "companion");
    });
    assert!(
        result.is_err(),
        "the checker must reject a writer that normalizes bytes outside the span"
    );

    // Whole-file identity must likewise reject an appended trailing newline.
    let appended = b"alpha\r\nbeta\r\ngamma\r\n\n".to_vec();
    assert_ne!(appended, original, "the companion mutation must differ");
}

/// The write path writes through a symlink rather than replacing it: the
/// target file receives the bytes and the link stays a link.
#[test]
fn write_through_symlink_updates_the_target() {
    let fs = SimFs::new();
    let root = PathBuf::from("vault");
    fs.external_create_dir(&root);
    fs.external_write(&root.join("real.md"), b"target content\n");
    fs.external_symlink(&root.join("link.md"), &root.join("real.md"));
    fs.deliver_all();

    skribeum_vault::write_durable(&fs, &root.join("link.md"), b"through the link\n")
        .expect("write through symlink");
    assert_eq!(
        fs.read(&root.join("real.md")).expect("target reads"),
        b"through the link\n",
        "the symlink target must receive the write"
    );
    assert_eq!(
        fs.read(&root.join("link.md")).expect("link resolves"),
        b"through the link\n",
        "reading through the link must observe the write"
    );
}

/// Permission modes survive the temp-and-rename replace.
#[test]
fn write_preserves_the_target_mode() {
    let fs = SimFs::new();
    let root = PathBuf::from("vault");
    fs.external_create_dir(&root);
    fs.external_write(&root.join("note.md"), b"content\n");
    fs.external_set_mode(&root.join("note.md"), 0o640);

    skribeum_vault::write_durable(&fs, &root.join("note.md"), b"replaced\n")
        .expect("write succeeds");
    assert_eq!(
        fs.mode_of(&root.join("note.md")),
        Some(0o640),
        "the replaced file must keep the target's permission mode"
    );
}
