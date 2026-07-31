//! Property tests over `VaultPath` normalization and collision detection.

use proptest::prelude::*;
use unicode_normalization::UnicodeNormalization;

use skribeum_vault::{VaultPath, detect_collisions};

/// Segment characters spanning ASCII, precomposed and decomposable Latin,
/// CJK, an astral-plane emoji and a combining mark.
fn segment_strategy() -> impl Strategy<Value = String> {
    proptest::collection::vec(
        prop_oneof![
            proptest::char::range('a', 'z'),
            proptest::char::range('A', 'Z'),
            proptest::char::range('0', '9'),
            Just('\u{e9}'),    // é precomposed
            Just('\u{0301}'),  // combining acute accent
            Just('\u{c5}'),    // Å precomposed
            Just('\u{6f22}'),  // CJK
            Just('\u{1F600}'), // astral-plane emoji
            Just('-'),
            Just('_'),
            Just(' '),
        ],
        1..8,
    )
    .prop_map(|chars| chars.into_iter().collect::<String>())
    .prop_filter("segments must not be . or .. or start/end oddly", |s| {
        s != "." && s != ".." && !s.trim().is_empty()
    })
}

fn path_strategy() -> impl Strategy<Value = String> {
    proptest::collection::vec(segment_strategy(), 1..4).prop_map(|segments| segments.join("/"))
}

proptest! {
    /// Construction always yields an NFC string, and construction is
    /// idempotent: re-parsing the normalized output reproduces it.
    #[test]
    fn normalization_is_idempotent(raw in path_strategy()) {
        let Ok(parsed) = VaultPath::new(&raw) else {
            // Rejection is allowed; silent mangling is not.
            return Ok(());
        };
        prop_assert!(unicode_normalization::is_nfc(parsed.as_str()));
        let reparsed = VaultPath::new(parsed.as_str()).expect("normalized output must reparse");
        prop_assert_eq!(parsed.as_str(), reparsed.as_str());
    }

    /// NFC and NFD spellings of one path construct equal `VaultPath` values.
    #[test]
    fn nfc_and_nfd_spellings_are_equal(raw in path_strategy()) {
        let nfc_input: String = raw.nfc().collect();
        let nfd_input: String = raw.nfd().collect();
        let from_nfc = VaultPath::new(&nfc_input);
        let from_nfd = VaultPath::new(&nfd_input);
        prop_assert_eq!(from_nfc, from_nfd);
    }

    /// A path never collides with itself, and a genuine case variant always
    /// produces exactly one surfaced collision group containing both paths.
    #[test]
    fn case_variants_collide_and_identity_does_not(raw in path_strategy()) {
        let Ok(path) = VaultPath::new(&raw) else { return Ok(()); };
        prop_assert!(detect_collisions(&[(path.clone(), 1)]).is_empty());

        let upper = path.as_str().to_uppercase();
        let Ok(upper_path) = VaultPath::new(&upper) else { return Ok(()); };
        if upper_path == path {
            // No distinct case variant exists (digits, CJK, emoji): the
            // uppercased spelling is the same file, not a second one.
            return Ok(());
        }
        let collisions = detect_collisions(&[(path.clone(), 1), (upper_path.clone(), 1)]);
        if upper_path.case_fold_key() == path.case_fold_key() {
            prop_assert_eq!(collisions.len(), 1);
            prop_assert_eq!(collisions[0].paths.len(), 2);
        } else {
            // Uppercasing changed the fold key itself (e.g. a character whose
            // lowercase expands); distinct keys are not a collision.
            prop_assert!(collisions.is_empty());
        }
    }

    /// Two raw spellings normalizing onto one `VaultPath` are surfaced as a
    /// collision.
    #[test]
    fn normalization_merges_are_surfaced(raw in path_strategy()) {
        let Ok(path) = VaultPath::new(&raw) else { return Ok(()); };
        let collisions = detect_collisions(&[(path.clone(), 2)]);
        prop_assert_eq!(collisions.len(), 1);
        prop_assert_eq!(&collisions[0].paths, &vec![path.as_str().to_owned()]);
    }

    /// Invalid shapes are rejected, never repaired: absolute paths, empty
    /// segments, traversal and backslashes all fail construction.
    #[test]
    fn invalid_shapes_are_rejected(raw in path_strategy()) {
        let absolute = format!("/{raw}");
        let trailing = format!("{raw}/");
        let doubled = format!("{raw}//x");
        let leading_traversal = format!("../{raw}");
        let trailing_traversal = format!("{raw}/..");
        let backslashed = format!("{raw}\\x");
        prop_assert!(VaultPath::new(&absolute).is_err());
        prop_assert!(VaultPath::new(&trailing).is_err());
        prop_assert!(VaultPath::new(&doubled).is_err());
        prop_assert!(VaultPath::new(&leading_traversal).is_err());
        prop_assert!(VaultPath::new(&trailing_traversal).is_err());
        prop_assert!(VaultPath::new(&backslashed).is_err());
    }
}
