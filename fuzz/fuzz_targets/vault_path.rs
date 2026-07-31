//! VaultPath construction must never panic on arbitrary input, and any
//! accepted path must be stable under re-parsing (normalization idempotent).

#![no_main]

use libfuzzer_sys::fuzz_target;
use skribeum_vault::VaultPath;

fuzz_target!(|data: &[u8]| {
    let Ok(text) = std::str::from_utf8(data) else {
        return;
    };
    if let Ok(path) = VaultPath::new(text) {
        let reparsed = VaultPath::new(path.as_str())
            .expect("an accepted VaultPath must re-parse");
        assert_eq!(
            path.as_str(),
            reparsed.as_str(),
            "normalization must be idempotent"
        );
    }
});
