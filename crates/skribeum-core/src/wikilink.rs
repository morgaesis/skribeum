//! Wikilink target resolution against the vault index, per the
//! `[wikilink-resolution]` section of `tests/syntax-spec.toml`: Obsidian
//! shortest-path semantics as a pure function over the index's path list.
//! Emission-side configuration from `.obsidian/app.json` (which link format
//! to write) is a display concern and does not enter resolution.

/// The subpath of a wikilink target: the part after the first `#`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WikilinkSubpath<'t> {
    /// A heading reference, kept verbatim; nested chains keep their inner
    /// `#` separators.
    Heading(&'t str),
    /// A block reference: the identifier after `#^`.
    Block(&'t str),
}

/// The outcome of resolving a wikilink target against the vault index.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WikilinkResolution<'i, 't> {
    /// An empty note part: the link points within the current file.
    SelfReference {
        subpath: Option<WikilinkSubpath<'t>>,
    },
    /// The note part matched an index path.
    Resolved {
        /// The matched index entry.
        path: &'i str,
        subpath: Option<WikilinkSubpath<'t>>,
        /// True when several index paths matched in the winning tier; the
        /// returned path is the deterministic winner (fewest segments,
        /// then byte-lexicographic order).
        ambiguous: bool,
    },
    /// No index path matched.
    Unresolved {
        subpath: Option<WikilinkSubpath<'t>>,
    },
}

/// Resolves a wikilink target against `index`, the vault's path list
/// (vault-root-relative, `/`-separated). Accepts the raw inner text of a
/// wikilink: an alias after `|` is split off and ignored, the subpath after
/// the first `#` is split off and returned, and the remaining note part is
/// matched exact-first, then as an Obsidian shortest-path suffix, each
/// case-sensitively before case-insensitively.
#[must_use]
pub fn resolve_wikilink<'i, 't>(
    target: &'t str,
    index: &'i [String],
) -> WikilinkResolution<'i, 't> {
    let without_alias = target.split('|').next().unwrap_or_default();
    let (note_part, subpath) = match without_alias.split_once('#') {
        Some((note, sub)) => (note, Some(parse_subpath(sub))),
        None => (without_alias, None),
    };
    let note = note_part.trim();
    if note.is_empty() {
        return WikilinkResolution::SelfReference { subpath };
    }

    let candidates = match_tiers(note, index);
    match candidates.split_first() {
        None => WikilinkResolution::Unresolved { subpath },
        Some((winner, rest)) => WikilinkResolution::Resolved {
            path: winner,
            subpath,
            ambiguous: !rest.is_empty(),
        },
    }
}

fn parse_subpath(sub: &str) -> WikilinkSubpath<'_> {
    match sub.strip_prefix('^') {
        Some(identifier) => WikilinkSubpath::Block(identifier),
        None => WikilinkSubpath::Heading(sub),
    }
}

/// Candidate paths from the first non-empty match tier, ordered by fewest
/// path segments then byte-lexicographic order.
fn match_tiers<'i>(note: &str, index: &'i [String]) -> Vec<&'i str> {
    let folded_note = note.to_lowercase();
    let tiers: [&dyn Fn(&str) -> bool; 4] = [
        &|path| exact_match(path, note),
        &|path| suffix_match(path, note),
        &|path| exact_match(&path.to_lowercase(), &folded_note),
        &|path| suffix_match(&path.to_lowercase(), &folded_note),
    ];
    for tier in tiers {
        let mut matched: Vec<&'i str> = index
            .iter()
            .map(String::as_str)
            .filter(|path| tier(path))
            .collect();
        if !matched.is_empty() {
            matched.sort_by(|a, b| (a.matches('/').count(), *a).cmp(&(b.matches('/').count(), *b)));
            return matched;
        }
    }
    Vec::new()
}

/// The note part matches a path exactly, as written or with `.md` appended
/// when the note carries no extension of its own.
fn exact_match(path: &str, note: &str) -> bool {
    path == note || (!has_extension(note) && strip_md(path) == Some(note))
}

/// The note part matches the trailing segments of a path: Obsidian
/// shortest-path linking.
fn suffix_match(path: &str, note: &str) -> bool {
    let tail_matches = |candidate: &str| {
        candidate
            .strip_suffix(note)
            .is_some_and(|prefix| prefix.ends_with('/'))
    };
    tail_matches(path) || (!has_extension(note) && strip_md(path).is_some_and(tail_matches))
}

/// The path without its `.md` extension, or `None` when it carries none.
pub(crate) fn strip_md(path: &str) -> Option<&str> {
    path.strip_suffix(".md")
}

/// Whether the note part's final segment carries a file extension, in which
/// case it matches as written only (attachment embeds like `figure.png`).
pub(crate) fn has_extension(note: &str) -> bool {
    note.rsplit('/')
        .next()
        .unwrap_or_default()
        .rsplit_once('.')
        .is_some_and(|(stem, extension)| {
            !stem.is_empty()
                && !extension.is_empty()
                && extension.chars().all(|c| c.is_ascii_alphanumeric())
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index(paths: &[&str]) -> Vec<String> {
        paths.iter().map(ToString::to_string).collect()
    }

    fn resolved_path<'i>(resolution: WikilinkResolution<'i, '_>) -> Option<&'i str> {
        match resolution {
            WikilinkResolution::Resolved { path, .. } => Some(path),
            _ => None,
        }
    }

    #[test]
    fn exact_path_beats_suffix() {
        let idx = index(&["garden-journal.md", "archive/garden-journal.md"]);
        assert_eq!(
            resolve_wikilink("garden-journal", &idx),
            WikilinkResolution::Resolved {
                path: "garden-journal.md",
                subpath: None,
                ambiguous: false,
            }
        );
    }

    #[test]
    fn shortest_path_suffix_matches_basename() {
        let idx = index(&["projects/greenhouse/frame.md"]);
        assert_eq!(
            resolved_path(resolve_wikilink("frame", &idx)),
            Some("projects/greenhouse/frame.md")
        );
        assert_eq!(
            resolved_path(resolve_wikilink("greenhouse/frame", &idx)),
            Some("projects/greenhouse/frame.md")
        );
    }

    #[test]
    fn ambiguity_is_deterministic_and_flagged() {
        let idx = index(&["b/note.md", "a/deep/nested/note.md", "a/note.md"]);
        assert_eq!(
            resolve_wikilink("note", &idx),
            WikilinkResolution::Resolved {
                path: "a/note.md",
                subpath: None,
                ambiguous: true,
            }
        );
    }

    #[test]
    fn case_insensitive_is_a_fallback_only() {
        let idx = index(&["Notes.md", "notes.md"]);
        assert_eq!(
            resolved_path(resolve_wikilink("notes", &idx)),
            Some("notes.md")
        );
        let only_upper = index(&["Notes.md"]);
        assert_eq!(
            resolved_path(resolve_wikilink("notes", &only_upper)),
            Some("Notes.md")
        );
    }

    #[test]
    fn subpaths_split_off() {
        let idx = index(&["garden-journal.md"]);
        assert_eq!(
            resolve_wikilink("garden-journal#Spring planting", &idx),
            WikilinkResolution::Resolved {
                path: "garden-journal.md",
                subpath: Some(WikilinkSubpath::Heading("Spring planting")),
                ambiguous: false,
            }
        );
        assert_eq!(
            resolve_wikilink("garden-journal#^row-seven", &idx),
            WikilinkResolution::Resolved {
                path: "garden-journal.md",
                subpath: Some(WikilinkSubpath::Block("row-seven")),
                ambiguous: false,
            }
        );
        assert_eq!(
            resolve_wikilink("garden-journal#Outer#Inner", &idx),
            WikilinkResolution::Resolved {
                path: "garden-journal.md",
                subpath: Some(WikilinkSubpath::Heading("Outer#Inner")),
                ambiguous: false,
            }
        );
    }

    #[test]
    fn alias_never_affects_resolution() {
        let idx = index(&["garden-journal.md"]);
        assert_eq!(
            resolve_wikilink("garden-journal|the garden notes", &idx),
            resolve_wikilink("garden-journal", &idx)
        );
        assert_eq!(
            resolve_wikilink("garden-journal#^row-seven|row seven", &idx),
            resolve_wikilink("garden-journal#^row-seven", &idx)
        );
    }

    #[test]
    fn self_reference_and_unresolved() {
        let idx = index(&["a.md"]);
        assert_eq!(
            resolve_wikilink("#Bare note link", &idx),
            WikilinkResolution::SelfReference {
                subpath: Some(WikilinkSubpath::Heading("Bare note link")),
            }
        );
        assert_eq!(
            resolve_wikilink("missing-note", &idx),
            WikilinkResolution::Unresolved { subpath: None }
        );
    }

    #[test]
    fn extension_carrying_targets_match_as_written_only() {
        let idx = index(&[
            "assets/sketch-of-frame.png",
            "assets/sketch-of-frame.png.md",
        ]);
        assert_eq!(
            resolved_path(resolve_wikilink("sketch-of-frame.png", &idx)),
            Some("assets/sketch-of-frame.png")
        );
    }

    #[test]
    fn note_with_spaces_resolves() {
        let idx = index(&["weekly review notes.md"]);
        assert_eq!(
            resolved_path(resolve_wikilink("weekly review notes", &idx)),
            Some("weekly review notes.md")
        );
    }
}
