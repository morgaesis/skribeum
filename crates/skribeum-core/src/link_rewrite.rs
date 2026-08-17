//! Retargeting the links that point at a note whose path is changing.
//!
//! Renaming or moving a note is a path change; every link elsewhere in the
//! vault still names the old path and stops resolving. This module produces
//! the minimal byte edits that keep those links pointing at the same note:
//! for each reference that resolves to a renamed path, only the note part of
//! the link target is replaced, and nothing else in the file moves.
//!
//! The link's written form is preserved. A target written as a full
//! vault-relative path stays a full path; a target written in Obsidian's
//! shortest form stays as short as still resolves unambiguously; an alias, a
//! heading or block subpath, and the presence or absence of the `.md`
//! extension are all carried across untouched.

use crate::change_set::ByteRangeReplace;
use crate::extract::{ExtractionKind, extract};
use crate::wikilink::{WikilinkResolution, has_extension, resolve_wikilink, strip_md};

/// One path change to carry into the vault's links: the path a note had and
/// the path it now has, both vault-root-relative and `/`-separated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathChange {
    /// The path references currently resolve to.
    pub from: String,
    /// The path those references must resolve to afterwards.
    pub to: String,
}

/// The path index after `changes` are applied, given the index before.
#[must_use]
pub fn index_after(index_before: &[String], changes: &[PathChange]) -> Vec<String> {
    index_before
        .iter()
        .map(|path| {
            changes
                .iter()
                .find_map(|change| remap(path, change))
                .unwrap_or_else(|| path.clone())
        })
        .collect()
}

/// The path `path` takes when `change` is applied, or `None` when the change
/// does not cover it. A directory change covers everything beneath it.
#[must_use]
pub fn remap(path: &str, change: &PathChange) -> Option<String> {
    if path == change.from {
        return Some(change.to.clone());
    }
    path.strip_prefix(&change.from)
        .and_then(|rest| rest.strip_prefix('/'))
        .map(|rest| format!("{}/{rest}", change.to))
}

/// Whether `source` can possibly hold a reference to any of `changes`.
///
/// Every resolution tier requires the written target to end with the moved
/// file's own name, case-insensitively, so a source without that name
/// anywhere cannot reference it. Used to skip parsing the large majority of
/// a vault's notes on a rename.
#[must_use]
pub fn may_reference(source: &[u8], changes: &[PathChange]) -> bool {
    let Ok(text) = core::str::from_utf8(source) else {
        return false;
    };
    let folded = text.to_lowercase();
    changes.iter().any(|change| {
        let name = change.from.rsplit('/').next().unwrap_or_default();
        let stem = strip_md(name).unwrap_or(name);
        !stem.is_empty() && folded.contains(&stem.to_lowercase())
    })
}

/// The minimal change set that retargets every wikilink and embed in
/// `source` whose target resolves to a path in `changes`.
///
/// `index_before` is the vault's path list as the links were written
/// against; `index_after` is the list they must resolve against once the
/// move is applied, and decides how short a shortest-form target may stay.
/// Returns changes sorted by start offset and non-overlapping, ready for
/// [`crate::apply_change_set`]. Input that is not valid UTF-8 yields no
/// changes: those files are never written.
#[must_use]
pub fn retarget_links(
    source: &[u8],
    index_before: &[String],
    index_after: &[String],
    changes: &[PathChange],
) -> Vec<ByteRangeReplace> {
    let Ok(text) = core::str::from_utf8(source) else {
        return Vec::new();
    };
    let mut edits = Vec::new();
    for extraction in extract(source) {
        if !matches!(
            extraction.kind,
            ExtractionKind::Wikilink | ExtractionKind::Embed
        ) {
            continue;
        }
        let span = &text[extraction.start_byte..extraction.end_byte];
        let Some(target) = note_part(span, extraction.start_byte) else {
            continue;
        };
        let written = &text[target.start..target.end];
        let WikilinkResolution::Resolved { path, .. } = resolve_wikilink(written, index_before)
        else {
            continue;
        };
        let Some(change) = changes.iter().find(|change| change.from == path) else {
            continue;
        };
        let replacement = retargeted_target(written, change, index_after);
        // A replacement carrying link punctuation would rewrite the shape of
        // the link, not its target. Refuse it: the reference is left dangling
        // and visible rather than the note silently restructured.
        if replacement == written || replacement.contains(['[', ']', '|', '#', '\n', '\r']) {
            continue;
        }
        edits.push(ByteRangeReplace {
            start: target.start,
            end: target.end,
            bytes: replacement.into_bytes(),
        });
    }
    edits
}

/// The byte range of the note part of a wikilink or embed span, in the
/// coordinates of the source the span was extracted from. Surrounding
/// whitespace inside the brackets is left alone, so a rewrite touches only
/// the path the reader wrote.
struct TargetRange {
    start: usize,
    end: usize,
}

fn note_part(span: &str, span_start: usize) -> Option<TargetRange> {
    let open = if span.starts_with("![[") {
        3
    } else if span.starts_with("[[") {
        2
    } else {
        return None;
    };
    let inner = span.strip_suffix("]]")?.get(open..)?;
    // Alias first, then subpath: `[[note#heading|alias]]` and
    // `[[note|alias#not-a-heading]]` both name `note`.
    let written = &inner[..inner.find(['|', '#']).unwrap_or(inner.len())];
    let trimmed = written.trim();
    if trimmed.is_empty() {
        return None;
    }
    let offset = span_start + open + (written.len() - written.trim_start().len());
    Some(TargetRange {
        start: offset,
        end: offset + trimmed.len(),
    })
}

/// The target text that replaces `written`, keeping the form it was written
/// in: full vault path, or the shortest suffix that still resolves to the
/// moved note alone, with the extension present exactly as before.
fn retargeted_target(written: &str, change: &PathChange, index_after: &[String]) -> String {
    let keep_extension = has_extension(written);
    let shorten = |path: &str| -> String {
        if keep_extension {
            path.to_owned()
        } else {
            strip_md(path).unwrap_or(path).to_owned()
        }
    };
    let full = shorten(&change.to);
    if written == change.from || strip_md(&change.from) == Some(written) {
        return full;
    }
    let segments: Vec<&str> = change.to.split('/').collect();
    for taken in 1..segments.len() {
        let candidate = shorten(&segments[segments.len() - taken..].join("/"));
        if matches!(
            resolve_wikilink(&candidate, index_after),
            WikilinkResolution::Resolved {
                path,
                ambiguous: false,
                ..
            } if path == change.to
        ) {
            return candidate;
        }
    }
    full
}

/// The change set that restores `base` from the bytes `changes` produce.
/// Applying `changes` and then the returned inverse yields `base` byte for
/// byte, which is what makes a rename one undoable step.
///
/// # Panics
///
/// Panics when a change reaches past the end of `base`; callers hold change
/// sets this crate produced against that same base.
#[must_use]
pub fn invert_changes(base: &[u8], changes: &[ByteRangeReplace]) -> Vec<ByteRangeReplace> {
    let mut inverse = Vec::with_capacity(changes.len());
    let mut drift: isize = 0;
    for change in changes {
        let start =
            usize::try_from(isize::try_from(change.start).expect("offset fits in isize") + drift)
                .expect("shifted offset is non-negative");
        inverse.push(ByteRangeReplace {
            start,
            end: start + change.bytes.len(),
            bytes: base[change.start..change.end].to_vec(),
        });
        drift += isize::try_from(change.bytes.len()).expect("length fits in isize")
            - isize::try_from(change.end - change.start).expect("length fits in isize");
    }
    inverse
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::change_set::apply_change_set;

    fn index(paths: &[&str]) -> Vec<String> {
        paths.iter().map(ToString::to_string).collect()
    }

    fn change(from: &str, to: &str) -> Vec<PathChange> {
        vec![PathChange {
            from: from.to_owned(),
            to: to.to_owned(),
        }]
    }

    fn rewritten(source: &str, before: &[&str], changes: &[PathChange]) -> String {
        let before = index(before);
        let after = index_after(&before, changes);
        let edits = retarget_links(source.as_bytes(), &before, &after, changes);
        String::from_utf8(apply_change_set(source.as_bytes(), &edits).expect("edits apply"))
            .expect("result is UTF-8")
    }

    #[test]
    fn full_path_targets_take_the_new_full_path() {
        assert_eq!(
            rewritten(
                "See [[Examples/Community/event-plan|repair cafe]] tonight.\n",
                &["Examples/Community/event-plan.md"],
                &change(
                    "Examples/Community/event-plan.md",
                    "Examples/Community/repair-cafe.md",
                ),
            ),
            "See [[Examples/Community/repair-cafe|repair cafe]] tonight.\n"
        );
    }

    #[test]
    fn shortest_form_targets_stay_short() {
        assert_eq!(
            rewritten(
                "See [[event-plan]].\n",
                &["Examples/Community/event-plan.md"],
                &change(
                    "Examples/Community/event-plan.md",
                    "Archive/2026/repair-cafe.md",
                ),
            ),
            "See [[repair-cafe]].\n"
        );
    }

    #[test]
    fn shortest_form_lengthens_when_the_new_name_is_ambiguous() {
        assert_eq!(
            rewritten(
                "See [[event-plan]].\n",
                &["Examples/Community/event-plan.md", "Work/repair-cafe.md"],
                &change(
                    "Examples/Community/event-plan.md",
                    "Community/repair-cafe.md",
                ),
            ),
            "See [[Community/repair-cafe]].\n"
        );
    }

    #[test]
    fn extension_presence_and_subpaths_are_preserved() {
        assert_eq!(
            rewritten(
                "[[notes/plan.md#Agenda|A]] and ![[notes/plan#^b1]] and [[notes/plan]]\n",
                &["notes/plan.md"],
                &change("notes/plan.md", "notes/agenda.md"),
            ),
            "[[notes/agenda.md#Agenda|A]] and ![[notes/agenda#^b1]] and [[notes/agenda]]\n"
        );
    }

    #[test]
    fn similar_text_and_code_are_left_alone() {
        let source = concat!(
            "A [[tasks|Tasks]] link and the word event-plan in prose.\n",
            "`[[event-plan]]` in code, and a fence:\n",
            "```\n[[event-plan]]\n```\n",
            "[[event-planning]] is a different note.\n",
        );
        assert_eq!(
            rewritten(
                source,
                &["tasks.md", "event-plan.md", "event-planning.md"],
                &change("event-plan.md", "repair-cafe.md"),
            ),
            source
        );
    }

    #[test]
    fn a_self_heading_link_is_not_a_reference() {
        assert_eq!(
            rewritten(
                "[[#Bare note link]]\n",
                &["event-plan.md"],
                &change("event-plan.md", "repair-cafe.md"),
            ),
            "[[#Bare note link]]\n"
        );
    }

    #[test]
    fn a_folder_move_carries_every_path_beneath_it() {
        let changes = [PathChange {
            from: "Examples/Personal".to_owned(),
            to: "Trips".to_owned(),
        }];
        assert_eq!(
            remap("Examples/Personal/travel-plan.md", &changes[0]),
            Some("Trips/travel-plan.md".to_owned())
        );
        assert_eq!(remap("Examples/Personality.md", &changes[0]), None);
    }

    #[test]
    fn inverting_a_change_set_restores_the_original_bytes() {
        let base = b"See [[event-plan]] and [[event-plan|the plan]].\n".to_vec();
        let changes = change("event-plan.md", "a/much/longer/repair-cafe.md");
        let before = index(&["event-plan.md"]);
        let after = index_after(&before, &changes);
        let edits = retarget_links(&base, &before, &after, &changes);
        assert_eq!(edits.len(), 2);
        let written = apply_change_set(&base, &edits).expect("edits apply");
        assert_ne!(written, base);
        let restored = apply_change_set(&written, &invert_changes(&base, &edits))
            .expect("the inverse applies");
        assert_eq!(restored, base);
    }

    #[test]
    fn the_prefilter_admits_every_spelling_that_can_resolve() {
        let changes = change("Examples/Community/event-plan.md", "x.md");
        assert!(may_reference(b"[[EVENT-PLAN]]", &changes));
        assert!(may_reference(b"[[Community/event-plan]]", &changes));
        assert!(!may_reference(b"[[tasks]]", &changes));
    }
}
