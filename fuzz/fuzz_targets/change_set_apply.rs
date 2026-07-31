//! Fuzzes the change-set applier: arbitrary bytes decode into a base plus
//! a change list; a rejected list must reject cleanly, and an accepted one
//! must produce output whose difference from the base stays inside the
//! declared ranges (the declared-range containment property).

#![no_main]

use libfuzzer_sys::fuzz_target;
use skribeum_core::{ByteRangeReplace, apply_change_set, span_within_declared};

/// Decodes `[count][per change: start_lo start_hi len_lo insert_len
/// insert...]` then the remaining bytes as the base, so corpus-seeded
/// inputs mostly become base bytes.
fn decode(data: &[u8]) -> Option<(Vec<u8>, Vec<ByteRangeReplace>)> {
    let (&count, mut rest) = data.split_first()?;
    let mut changes = Vec::new();
    for _ in 0..count % 8 {
        if rest.len() < 4 {
            return None;
        }
        let start = usize::from(u16::from_le_bytes([rest[0], rest[1]]));
        let len = usize::from(rest[2]);
        let insert_len = usize::from(rest[3]) % 16;
        rest = &rest[4..];
        if rest.len() < insert_len {
            return None;
        }
        let (insert, remaining) = rest.split_at(insert_len);
        rest = remaining;
        changes.push(ByteRangeReplace {
            start,
            end: start.saturating_add(len),
            bytes: insert.to_vec(),
        });
    }
    Some((rest.to_vec(), changes))
}

fuzz_target!(|data: &[u8]| {
    let Some((base, changes)) = decode(data) else {
        return;
    };
    let Ok(after) = apply_change_set(&base, &changes) else {
        // Structural rejection is a valid outcome; it must not panic.
        return;
    };
    let declared: Vec<(usize, usize)> = changes.iter().map(|c| (c.start, c.end)).collect();
    assert!(
        span_within_declared(&base, &after, &declared),
        "an accepted change set escaped its declared ranges"
    );
});
