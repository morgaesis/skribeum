//! Declared-range containment: every buffer mutation the application
//! performs declares its byte ranges, and `diff(before, after)` must be a
//! subset of the union of declared ranges. 4,096 proptest cases,
//! seed-reproducible, with failing cases persisted under
//! `tests/regressions/` at the repository root. The mutation companion at
//! the bottom feeds a deliberately broken mutator through the same checker
//! to prove the property can fail.

use proptest::prelude::*;
use proptest::test_runner::FileFailurePersistence;
use skribeum_core::{ByteRangeReplace, apply_change_set, changed_span, span_within_declared};

/// Builds a sorted, non-overlapping, in-bounds change set from raw draws.
fn normalize_changes(base_len: usize, raw: &[(usize, usize, Vec<u8>)]) -> Vec<ByteRangeReplace> {
    let mut cursor = 0usize;
    let mut changes = Vec::new();
    for (start_draw, len_draw, insert) in raw {
        if cursor > base_len {
            break;
        }
        let start = cursor + (start_draw % (base_len - cursor + 1));
        let end = (start + len_draw % 32).min(base_len);
        changes.push(ByteRangeReplace {
            start,
            end,
            bytes: insert.clone(),
        });
        cursor = end + 1;
    }
    changes
}

fn declared(changes: &[ByteRangeReplace]) -> Vec<(usize, usize)> {
    changes.iter().map(|c| (c.start, c.end)).collect()
}

/// Base strategy: arbitrary bytes, biased toward text with mixed line
/// endings so terminator handling is exercised alongside raw bytes.
fn base_strategy() -> impl Strategy<Value = Vec<u8>> {
    prop_oneof![
        proptest::collection::vec(any::<u8>(), 0..512),
        "(?s)[a-z \r\n]{0,512}".prop_map(String::into_bytes),
        "(?s)([a-z]{0,12}(\r\n|\n|\r)){0,40}".prop_map(String::into_bytes),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig {
        cases: 4096,
        failure_persistence: Some(Box::new(FileFailurePersistence::Direct(
            "../../tests/regressions/declared_range_containment.txt",
        ))),
        .. ProptestConfig::default()
    })]

    /// The production change-set applier only ever touches bytes inside the
    /// ranges the change set declares.
    #[test]
    fn diff_is_a_subset_of_declared_ranges(
        base in base_strategy(),
        raw in proptest::collection::vec(
            (any::<usize>(), any::<usize>(), proptest::collection::vec(any::<u8>(), 0..24)),
            0..4,
        ),
    ) {
        let changes = normalize_changes(base.len(), &raw);
        let after = apply_change_set(&base, &changes).expect("normalized change sets apply");
        prop_assert!(
            span_within_declared(&base, &after, &declared(&changes)),
            "diff escaped the declared ranges: span {:?}, declared {:?}",
            changed_span(&base, &after),
            declared(&changes),
        );
    }

    /// The same property through the line-ending mapping layer: buffer
    /// edits declare their byte ranges via the conversion, and the applied
    /// result stays inside them.
    #[test]
    fn buffer_edit_conversion_stays_inside_declared_ranges(
        base in "(?s)([a-z]{0,16}(\r\n|\n|\r)){0,30}[a-z]{0,16}".prop_map(String::into_bytes),
        offset_draw in any::<usize>(),
        len_draw in 0usize..8,
        insert in "[a-z \n]{0,16}".prop_map(String::into_bytes),
    ) {
        let map = skribeum_core::LineEndingMap::from_bytes(&base);
        let buffer_len = map.buffer_len();
        let start = offset_draw % (buffer_len + 1);
        let end = (start + len_draw).min(buffer_len);
        let changes = map
            .buffer_edits_to_change_set(&[skribeum_core::BufferEdit {
                start,
                end,
                insert,
            }])
            .expect("in-bounds edits convert");
        let after = apply_change_set(&base, &changes).expect("converted change sets apply");
        prop_assert!(
            span_within_declared(&base, &after, &declared(&changes)),
            "buffer edit escaped its declared ranges: span {:?}, declared {:?}",
            changed_span(&base, &after),
            declared(&changes),
        );
    }
}

/// A deliberately broken mutator: applies the change set and additionally
/// rewrites the first CRLF outside the declared ranges to LF, the exact
/// shape of a hidden normalization bug.
fn broken_apply(base: &[u8], changes: &[ByteRangeReplace]) -> Vec<u8> {
    let mut after = apply_change_set(base, changes).expect("applies");
    let declared = declared(changes);
    let mut index = 0;
    while index + 1 < after.len() {
        let inside = declared
            .iter()
            .any(|&(s, e)| index >= s && index < e.max(s + 1));
        if !inside && after[index] == b'\r' && after[index + 1] == b'\n' {
            after.remove(index);
            break;
        }
        index += 1;
    }
    after
}

/// Mutation companion: the checker must reject the broken mutator. Without
/// this, a refactor could silently reduce the property to a tautology.
#[test]
fn containment_checker_rejects_an_undeclared_normalization() {
    let base = b"alpha\r\nbeta\r\ngamma\r\n".to_vec();
    let changes = vec![ByteRangeReplace {
        start: 0,
        end: 5,
        bytes: b"ALPHA".to_vec(),
    }];
    let after = broken_apply(&base, &changes);
    assert!(
        !span_within_declared(&base, &after, &declared(&changes)),
        "the checker must catch a mutation outside the declared ranges"
    );
    // And the honest applier passes the identical case.
    let honest = apply_change_set(&base, &changes).expect("applies");
    assert!(span_within_declared(&base, &honest, &declared(&changes)));
}
