//! Fuzzes the construct extractor: any byte input, including corpus-seeded
//! markdown, must yield a sorted extraction set whose ranges are in bounds,
//! never empty, disjoint per kind, and identical across repeated runs.

#![no_main]

use libfuzzer_sys::fuzz_target;
use std::collections::BTreeMap;

fuzz_target!(|data: &[u8]| {
    let extractions = skribeum_core::extract(data);

    let mut last_end_per_kind: BTreeMap<&str, usize> = BTreeMap::new();
    let mut previous: Option<(usize, usize, &str)> = None;
    for extraction in &extractions {
        assert!(
            extraction.start_byte < extraction.end_byte,
            "an extraction is never empty"
        );
        assert!(
            extraction.end_byte <= data.len(),
            "ranges must stay in bounds"
        );
        let key = (
            extraction.start_byte,
            extraction.end_byte,
            extraction.kind.as_str(),
        );
        if let Some(previous_key) = previous {
            assert!(previous_key <= key, "output must be sorted");
        }
        previous = Some(key);
        if let Some(&end) = last_end_per_kind.get(extraction.kind.as_str()) {
            assert!(
                extraction.start_byte >= end,
                "extractions of one kind must be disjoint"
            );
        }
        last_end_per_kind.insert(extraction.kind.as_str(), extraction.end_byte);
    }

    assert_eq!(
        extractions,
        skribeum_core::extract(data),
        "extraction must be deterministic"
    );
});
