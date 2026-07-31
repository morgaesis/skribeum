//! Fuzzes the frontmatter byte-range extractor: any input, including
//! corpus-seeded markdown, must yield either no block or a structurally
//! sound range (in bounds, starting at the delimiter, never empty).

#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    if let Some(range) = skribeum_core::read_frontmatter(data) {
        assert!(range.end <= data.len(), "range must stay in bounds");
        assert!(range.start < range.end, "a detected block is never empty");
        assert!(
            data[range.start..].starts_with(b"---"),
            "a detected block starts at its opening delimiter"
        );
    }
});
