//! Property tests for wikilink resolution, plus corpus-driven cases: every
//! wikilink and embed target in the corpus resolves as the specification's
//! `[wikilink-resolution]` section rules against a synthetic vault index.

use proptest::prelude::*;
use skribeum_core::{
    ExtractionKind, WikilinkResolution, WikilinkSubpath, extract, resolve_wikilink,
};

// Interior spaces are exercised by the corpus-driven cases; generated
// segments avoid leading and trailing whitespace, which resolution trims
// from the note part by design.
fn segment() -> impl Strategy<Value = String> {
    "[a-zA-Z][a-zA-Z0-9_-]{0,10}"
}

fn path() -> impl Strategy<Value = String> {
    proptest::collection::vec(segment(), 1..4).prop_map(|segments| segments.join("/") + ".md")
}

fn index() -> impl Strategy<Value = Vec<String>> {
    proptest::collection::vec(path(), 0..12)
}

fn resolved_path<'i>(resolution: WikilinkResolution<'i, '_>) -> Option<&'i str> {
    match resolution {
        WikilinkResolution::Resolved { path, .. } => Some(path),
        _ => None,
    }
}

proptest! {
    /// A resolved path is always an element of the provided index.
    #[test]
    fn resolution_stays_within_the_index(target in "[a-zA-Z0-9 /#^|._-]{0,24}", idx in index()) {
        if let Some(path) = resolved_path(resolve_wikilink(&target, &idx)) {
            prop_assert!(idx.iter().any(|entry| entry == path));
        }
    }

    /// Resolution is a function of the index's contents, not its order.
    #[test]
    fn resolution_is_order_independent(target in "[a-zA-Z0-9 /._-]{1,24}", idx in index()) {
        let mut reversed = idx.clone();
        reversed.reverse();
        prop_assert_eq!(
            resolve_wikilink(&target, &idx),
            resolve_wikilink(&target, &reversed)
        );
    }

    /// A target naming a full index path resolves to exactly that path,
    /// regardless of what else the index holds.
    #[test]
    fn exact_match_beats_suffix_match(stem in segment(), folder in segment(), idx in index()) {
        let exact = format!("{stem}.md");
        let nested = format!("{folder}/{stem}.md");
        let mut with_both = idx.clone();
        with_both.push(exact.clone());
        with_both.push(nested);
        prop_assert_eq!(resolved_path(resolve_wikilink(&stem, &with_both)), Some(exact.as_str()));
    }

    /// Unrelated index entries never change an exact-match resolution.
    #[test]
    fn unrelated_paths_do_not_disturb_resolution(stem in segment(), extra in path()) {
        let exact = format!("{stem}.md");
        let alone = vec![exact.clone()];
        let mut widened = alone.clone();
        if !extra.ends_with(&format!("/{exact}")) && extra != exact {
            widened.push(extra);
        }
        prop_assert_eq!(
            resolved_path(resolve_wikilink(&stem, &alone)),
            resolved_path(resolve_wikilink(&stem, &widened))
        );
    }

    /// The alias part never affects resolution.
    #[test]
    fn alias_is_ignored(target in "[a-zA-Z0-9 /#^._-]{1,24}", alias in "[a-zA-Z0-9 ]{0,12}", idx in index()) {
        let with_alias = format!("{target}|{alias}");
        prop_assert_eq!(
            resolve_wikilink(&with_alias, &idx),
            resolve_wikilink(&target, &idx)
        );
    }

    /// The subpath split is faithful: a heading subpath round-trips verbatim
    /// and a block subpath keeps its identifier.
    #[test]
    fn subpath_splits_faithfully(stem in segment(), heading in "[a-zA-Z0-9 ]{1,12}", block in "[a-zA-Z0-9-]{1,12}") {
        let idx = vec![format!("{stem}.md")];
        let heading_target = format!("{stem}#{heading}");
        match resolve_wikilink(&heading_target, &idx) {
            WikilinkResolution::Resolved { subpath, .. } => {
                prop_assert_eq!(subpath, Some(WikilinkSubpath::Heading(heading.as_str())));
            }
            other => prop_assert!(false, "expected resolution, got {other:?}"),
        }
        let block_target = format!("{stem}#^{block}");
        match resolve_wikilink(&block_target, &idx) {
            WikilinkResolution::Resolved { subpath, .. } => {
                prop_assert_eq!(subpath, Some(WikilinkSubpath::Block(block.as_str())));
            }
            other => prop_assert!(false, "expected resolution, got {other:?}"),
        }
    }

    /// Case-insensitive matching fires only when no case-sensitive tier
    /// matched, so an exact-case file always wins over a folded one.
    #[test]
    fn case_sensitive_wins_over_folded(stem in "[a-z][a-z0-9-]{0,10}") {
        let lower = format!("{stem}.md");
        let upper = format!("{}.md", stem.to_uppercase());
        let idx = vec![upper.clone(), lower.clone()];
        prop_assert_eq!(resolved_path(resolve_wikilink(&stem, &idx)), Some(lower.as_str()));
        let only_upper = vec![upper.clone()];
        prop_assert_eq!(
            resolved_path(resolve_wikilink(&stem, &only_upper)),
            Some(upper.as_str())
        );
    }
}

/// Every wikilink and embed target the extractor finds in the corpus
/// resolves as expected against a synthetic index shaped like the corpus's
/// own link targets.
#[test]
fn corpus_targets_resolve_against_a_synthetic_index() {
    let corpus_dir =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/corpus");
    let synthetic_index: Vec<String> = [
        "garden-journal.md",
        "weekly review notes.md",
        "projects/greenhouse/frame.md",
        "assets/sketch-of-frame.png",
        "block-target-note.md",
        "notes/first-target.md",
        "notes/second-target.md",
        "notes/emphasized-target.md",
        "notes/heading-target.md",
        "notes/inline-embedded-note.md",
        "notes/not-an-embed.md",
        "notes/wikilink-target.md",
        "notes/table-note-target.md",
        "Foo.md",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();

    let mut targets_seen = 0usize;
    for file in ["wikilinks-forms.md", "embeds.md", "block-references.md"] {
        let source = std::fs::read(corpus_dir.join(file)).expect("corpus file must be readable");
        let text = core::str::from_utf8(&source).expect("corpus link files are UTF-8");
        for extraction in extract(&source) {
            let inner = match extraction.kind {
                ExtractionKind::Wikilink => {
                    &text[extraction.start_byte + 2..extraction.end_byte - 2]
                }
                ExtractionKind::Embed => &text[extraction.start_byte + 3..extraction.end_byte - 2],
                _ => continue,
            };
            targets_seen += 1;
            let resolution = resolve_wikilink(inner, &synthetic_index);
            match resolution {
                WikilinkResolution::Resolved { ambiguous, .. } => {
                    assert!(!ambiguous, "{file}: [[{inner}]] resolved ambiguously");
                }
                WikilinkResolution::SelfReference { subpath } => {
                    assert!(
                        subpath.is_some(),
                        "{file}: [[{inner}]] self-reference without subpath"
                    );
                }
                WikilinkResolution::Unresolved { .. } => {
                    panic!("{file}: [[{inner}]] failed to resolve");
                }
            }
        }
    }
    assert!(
        targets_seen >= 20,
        "expected the corpus to exercise at least 20 targets, saw {targets_seen}"
    );
}
