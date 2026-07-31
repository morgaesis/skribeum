//! The line-ending mapping layer's own property test over the corpus CRLF,
//! LF and mixed-ending files: buffer-space edits converted to byte-space
//! change sets touch only their declared ranges (so untouched lines keep
//! their original terminators byte-for-byte), and the byte result projects
//! back to exactly the buffer the edit produced.

use std::path::PathBuf;

use proptest::prelude::*;
use proptest::test_runner::FileFailurePersistence;
use skribeum_core::{
    BufferEdit, LineEndingMap, apply_change_set, buffer_from_bytes, span_within_declared,
};

const LINE_ENDING_FILES: [&str; 3] = [
    "bytes-crlf.md",
    "bytes-lf.md",
    "bytes-mixed-line-endings.md",
];

fn corpus_file(name: &str) -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/corpus")
        .join(name);
    std::fs::read(&path).expect("corpus file reads")
}

/// Applies `edits` directly in buffer space, the reference the byte-space
/// result must project back onto.
fn apply_in_buffer(buffer: &[u8], edits: &[BufferEdit]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut copied = 0usize;
    for edit in edits {
        out.extend_from_slice(&buffer[copied..edit.start]);
        out.extend_from_slice(&edit.insert);
        copied = edit.end;
    }
    out.extend_from_slice(&buffer[copied..]);
    out
}

/// Normalizes raw draws into sorted, non-overlapping, in-bounds edits.
fn normalize_edits(buffer_len: usize, raw: &[(usize, usize, Vec<u8>)]) -> Vec<BufferEdit> {
    let mut cursor = 0usize;
    let mut edits = Vec::new();
    for (start_draw, len_draw, insert) in raw {
        if cursor > buffer_len {
            break;
        }
        let start = cursor + (start_draw % (buffer_len - cursor + 1));
        let end = (start + len_draw % 12).min(buffer_len);
        edits.push(BufferEdit {
            start,
            end,
            insert: insert.clone(),
        });
        cursor = end + 1;
    }
    edits
}

proptest! {
    #![proptest_config(ProptestConfig {
        cases: 512,
        failure_persistence: Some(Box::new(FileFailurePersistence::Direct(
            "../../tests/regressions/line_ending_corpus.txt",
        ))),
        .. ProptestConfig::default()
    })]

    /// Over each corpus line-ending file: random buffer edits round-trip
    /// through the byte-space conversion with untouched terminators
    /// preserved and buffer equivalence exact.
    #[test]
    fn corpus_line_ending_edits_round_trip(
        file_index in 0usize..3,
        raw in proptest::collection::vec(
            (any::<usize>(), any::<usize>(), "[a-z \n]{0,10}".prop_map(String::into_bytes)),
            1..4,
        ),
    ) {
        let bytes = corpus_file(LINE_ENDING_FILES[file_index]);
        let map = LineEndingMap::from_bytes(&bytes);
        let buffer = buffer_from_bytes(&bytes);
        let edits = normalize_edits(map.buffer_len(), &raw);

        let changes = map.buffer_edits_to_change_set(&edits).expect("edits convert");
        let new_bytes = apply_change_set(&bytes, &changes).expect("change set applies");

        // Only declared byte ranges changed, which is exactly what keeps
        // every untouched line's terminator byte-identical.
        let declared: Vec<(usize, usize)> = changes.iter().map(|c| (c.start, c.end)).collect();
        prop_assert!(
            span_within_declared(&bytes, &new_bytes, &declared),
            "conversion touched bytes outside its declared ranges"
        );

        // The byte result projects back to exactly the edited buffer.
        let expected_buffer = apply_in_buffer(&buffer, &edits);
        prop_assert_eq!(
            buffer_from_bytes(&new_bytes),
            expected_buffer,
            "the byte-space result must project to the edited buffer"
        );
    }
}

/// Mutation companion: a broken conversion that re-emits every terminator
/// as LF passes buffer equivalence but must fail the containment check on a
/// CRLF file, proving the terminator-preservation property is load-bearing.
#[test]
fn corpus_checker_rejects_a_terminator_normalizing_conversion() {
    let bytes = corpus_file("bytes-crlf.md");
    let buffer = buffer_from_bytes(&bytes);
    // The broken implementation: pretend the whole file may be rewritten
    // from the normalized buffer (which silently emits LF everywhere).
    let edit = BufferEdit {
        start: 0,
        end: 0,
        insert: b"x".to_vec(),
    };
    let broken_bytes = apply_in_buffer(&buffer, std::slice::from_ref(&edit));

    let map = LineEndingMap::from_bytes(&bytes);
    let changes = map
        .buffer_edits_to_change_set(&[edit])
        .expect("edit converts");
    let declared: Vec<(usize, usize)> = changes.iter().map(|c| (c.start, c.end)).collect();
    assert!(
        !span_within_declared(&bytes, &broken_bytes, &declared),
        "the checker must reject a conversion that normalizes terminators"
    );

    // Buffer equivalence alone would NOT have caught it, which is why the
    // containment check exists.
    assert_eq!(
        buffer_from_bytes(&broken_bytes),
        apply_in_buffer(
            &buffer,
            &[BufferEdit {
                start: 0,
                end: 0,
                insert: b"x".to_vec()
            }]
        ),
    );
}
