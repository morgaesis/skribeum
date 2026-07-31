//! Encoding classification runs on every byte sequence a vault can contain
//! and must never panic; UTF-8 inputs must never classify as non-UTF-8.

#![no_main]

use libfuzzer_sys::fuzz_target;
use skribeum_vault::{Encoding, classify};

fuzz_target!(|data: &[u8]| {
    let content = classify(data.to_vec());
    if std::str::from_utf8(data).is_ok() {
        assert!(
            !matches!(content.encoding, Encoding::NonUtf8),
            "valid UTF-8 must not classify as non-UTF-8"
        );
    }
});
