//! Offset conversions at the IPC boundary must never panic, must stay in
//! bounds, and must land on character boundaries for any input.

#![no_main]

use libfuzzer_sys::fuzz_target;
use skribeum_core::{byte_offset_to_utf16, utf16_offset_to_byte};

fuzz_target!(|input: (String, u16)| {
    let (text, raw_offset) = input;
    let offset = usize::from(raw_offset);

    let byte = utf16_offset_to_byte(&text, offset);
    assert!(byte <= text.len());
    assert!(text.is_char_boundary(byte));

    let units = byte_offset_to_utf16(&text, offset.min(text.len()));
    assert!(units <= text.encode_utf16().count());

    // A boundary produced by one direction must map back to itself.
    let round = utf16_offset_to_byte(&text, byte_offset_to_utf16(&text, byte));
    assert_eq!(round, byte, "boundary offsets must round-trip");
});
