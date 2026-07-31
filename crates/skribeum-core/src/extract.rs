//! Construct extraction for vault-wide indexing. Implements the Rust half of
//! the two-parser conformance contract in `tests/syntax-spec.toml`: every
//! recognized construct is reported as a `(kind, start_byte, end_byte)`
//! extraction over the raw input bytes, and the TypeScript decoration engine
//! must produce the identical set over the same input. This layer feeds the
//! link graph, backlinks, tags, and search; it never drives decoration.

use crate::frontmatter::read_frontmatter;
use core::ops::Range;
use pulldown_cmark::{CodeBlockKind, Event, LinkType, Options, Parser, Tag};

const BOM: &[u8] = &[0xEF, 0xBB, 0xBF];

/// The stable construct vocabulary of the conformance gate. The string names
/// returned by [`ExtractionKind::as_str`] appear in committed conformance
/// snapshots and must never change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ExtractionKind {
    /// Angle-bracket URI and email autolinks.
    Autolink,
    /// Obsidian `^block-id` identifiers.
    BlockId,
    /// Fenced code blocks, backtick or tilde.
    CodeFence,
    /// Indented code blocks.
    CodeIndented,
    /// Inline code spans.
    CodeSpan,
    /// Obsidian `![[...]]` embeds.
    Embed,
    /// ATX and setext headings, all levels.
    Heading,
    /// `CommonMark` inline and reference links.
    Link,
    /// Obsidian `#tag` inline tags.
    Tag,
    /// Obsidian `[[...]]` wikilinks, all four forms.
    Wikilink,
}

impl ExtractionKind {
    /// The stable snapshot name of this kind.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Autolink => "autolink",
            Self::BlockId => "block-id",
            Self::CodeFence => "code-fence",
            Self::CodeIndented => "code-indented",
            Self::CodeSpan => "code-span",
            Self::Embed => "embed",
            Self::Heading => "heading",
            Self::Link => "link",
            Self::Tag => "tag",
            Self::Wikilink => "wikilink",
        }
    }
}

/// One extracted construct. `start_byte` is inclusive and `end_byte`
/// exclusive, both indices into the original input bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Extraction {
    pub kind: ExtractionKind,
    pub start_byte: usize,
    pub end_byte: usize,
}

/// Extracts every recognized construct from `source` per the shared syntax
/// specification. Total and deterministic: any byte input yields a sorted
/// extraction list (ordered by start, end, then kind name) and never panics.
/// Input that is not valid UTF-8 yields an empty list, matching the
/// specification's ruling for files that open read-only.
#[must_use]
pub fn extract(source: &[u8]) -> Vec<Extraction> {
    let Ok(text) = core::str::from_utf8(source) else {
        return Vec::new();
    };

    let bom_end = if source.starts_with(BOM) {
        BOM.len()
    } else {
        0
    };
    let frontmatter_end = read_frontmatter(source).map_or(bom_end, |range| range.end);
    let parse_start = frontmatter_end.max(bom_end);
    let body = &text[parse_start..];

    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);
    options.insert(Options::ENABLE_FOOTNOTES);
    options.insert(Options::ENABLE_WIKILINKS);

    let mut extractions: Vec<Extraction> = Vec::new();
    // Byte ranges (absolute) in which the post-pass constructs are never
    // recognized: code, autolinks, wikilinks, embeds, and raw HTML.
    let mut exclusion_zones: Vec<Range<usize>> = Vec::new();

    for (event, range) in Parser::new_ext(body, options).into_offset_iter() {
        let absolute = range.start + parse_start..range.end + parse_start;
        match event {
            Event::Start(Tag::Heading { .. }) => {
                push(
                    &mut extractions,
                    ExtractionKind::Heading,
                    trim_final_terminator(source, absolute),
                );
            }
            Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(_))) => {
                let trimmed = trim_final_terminator(source, absolute);
                exclusion_zones.push(trimmed.clone());
                push(&mut extractions, ExtractionKind::CodeFence, trimmed);
            }
            Event::Start(Tag::CodeBlock(CodeBlockKind::Indented)) => {
                // pulldown reports the block from after the first line's
                // indentation; the specification pins the range to column
                // zero of that line.
                let start = line_start(source, absolute.start);
                let trimmed = trim_final_terminator(source, start..absolute.end);
                exclusion_zones.push(trimmed.clone());
                push(&mut extractions, ExtractionKind::CodeIndented, trimmed);
            }
            Event::Code(_) => {
                exclusion_zones.push(absolute.clone());
                push(&mut extractions, ExtractionKind::CodeSpan, absolute);
            }
            Event::Start(Tag::Link { link_type, .. }) => match link_type {
                LinkType::WikiLink { .. } => {
                    exclusion_zones.push(absolute.clone());
                    push(&mut extractions, ExtractionKind::Wikilink, absolute);
                }
                LinkType::Autolink | LinkType::Email => {
                    exclusion_zones.push(absolute.clone());
                    push(&mut extractions, ExtractionKind::Autolink, absolute);
                }
                LinkType::Collapsed | LinkType::CollapsedUnknown => {
                    // Normalization shim: pulldown reports a collapsed
                    // reference without its trailing `[]`; the specification
                    // rules the range through the closing bracket pair.
                    let mut range = absolute;
                    if source[range.end..].starts_with(b"[]") {
                        range.end += 2;
                    }
                    push(&mut extractions, ExtractionKind::Link, range);
                }
                LinkType::Inline
                | LinkType::Reference
                | LinkType::ReferenceUnknown
                | LinkType::Shortcut
                | LinkType::ShortcutUnknown => {
                    push(&mut extractions, ExtractionKind::Link, absolute);
                }
            },
            Event::Start(Tag::Image { link_type, .. }) => {
                if matches!(link_type, LinkType::WikiLink { .. }) {
                    exclusion_zones.push(absolute.clone());
                    push(&mut extractions, ExtractionKind::Embed, absolute);
                }
                // CommonMark images are not an extraction kind.
            }
            Event::Html(_) | Event::InlineHtml(_) => {
                exclusion_zones.push(absolute);
            }
            _ => {}
        }
    }

    extract_tags(text, parse_start, &exclusion_zones, &mut extractions);
    extract_block_ids(text, parse_start, &exclusion_zones, &mut extractions);

    extractions.sort_by(|a, b| {
        (a.start_byte, a.end_byte, a.kind.as_str()).cmp(&(
            b.start_byte,
            b.end_byte,
            b.kind.as_str(),
        ))
    });
    extractions
}

fn push(extractions: &mut Vec<Extraction>, kind: ExtractionKind, range: Range<usize>) {
    if range.start < range.end {
        extractions.push(Extraction {
            kind,
            start_byte: range.start,
            end_byte: range.end,
        });
    }
}

/// Removes one trailing line terminator (LF, CRLF, or lone CR) from the end
/// of a block range, so block ranges end at their last content byte.
fn trim_final_terminator(source: &[u8], range: Range<usize>) -> Range<usize> {
    let mut end = range.end;
    if end > range.start && source.get(end - 1) == Some(&b'\n') {
        end -= 1;
    }
    if end > range.start && source.get(end - 1) == Some(&b'\r') {
        end -= 1;
    }
    range.start..end
}

/// The byte offset of the start of the line containing `offset`.
fn line_start(source: &[u8], offset: usize) -> usize {
    source[..offset]
        .iter()
        .rposition(|&byte| byte == b'\n' || byte == b'\r')
        .map_or(0, |position| position + 1)
}

fn in_exclusion_zone(zones: &[Range<usize>], position: usize) -> bool {
    zones.iter().any(|zone| zone.contains(&position))
}

/// Whether the tag or block-id opener at `byte_index` is validly preceded:
/// start of input or Unicode whitespace.
fn opener_preceded(text: &str, byte_index: usize) -> bool {
    text[..byte_index]
        .chars()
        .next_back()
        .is_none_or(char::is_whitespace)
}

fn is_tag_body_char(character: char) -> bool {
    character.is_alphanumeric() || matches!(character, '-' | '_' | '/')
}

/// Post-pass tag recognition per the specification's `tag` rulings.
fn extract_tags(
    text: &str,
    parse_start: usize,
    zones: &[Range<usize>],
    extractions: &mut Vec<Extraction>,
) {
    let body = &text[parse_start..];
    let mut cursor = 0usize;
    while let Some(found) = body[cursor..].find('#') {
        let hash = cursor + found;
        cursor = hash + 1;
        let absolute_hash = parse_start + hash;
        if in_exclusion_zone(zones, absolute_hash) || !opener_preceded(text, absolute_hash) {
            continue;
        }
        let after = &body[hash + 1..];
        let body_len: usize = after
            .chars()
            .take_while(|&c| is_tag_body_char(c))
            .map(char::len_utf8)
            .sum();
        if body_len == 0 {
            continue;
        }
        let tag_body = &after[..body_len];
        // A tag never ends in '/'.
        let trimmed_len = tag_body.trim_end_matches('/').len();
        if trimmed_len == 0 {
            cursor = hash + 1 + body_len;
            continue;
        }
        let trimmed_body = &tag_body[..trimmed_len];
        if trimmed_body.chars().all(|c| c.is_ascii_digit()) {
            cursor = hash + 1 + body_len;
            continue;
        }
        push(
            extractions,
            ExtractionKind::Tag,
            absolute_hash..absolute_hash + 1 + trimmed_len,
        );
        cursor = hash + 1 + body_len;
    }
}

fn is_block_id_char(character: char) -> bool {
    character.is_ascii_alphanumeric() || character == '-'
}

/// Post-pass block-identifier recognition per the specification's
/// `block-id` rulings: a whitespace-preceded `^identifier` with nothing but
/// whitespace between it and the end of its line.
fn extract_block_ids(
    text: &str,
    parse_start: usize,
    zones: &[Range<usize>],
    extractions: &mut Vec<Extraction>,
) {
    let body = &text[parse_start..];
    let mut cursor = 0usize;
    while let Some(found) = body[cursor..].find('^') {
        let caret = cursor + found;
        cursor = caret + 1;
        let absolute_caret = parse_start + caret;
        if in_exclusion_zone(zones, absolute_caret) || !opener_preceded(text, absolute_caret) {
            continue;
        }
        let after = &body[caret + 1..];
        let body_len = after.chars().take_while(|&c| is_block_id_char(c)).count();
        if body_len == 0 {
            continue;
        }
        // Only whitespace may follow before the line terminator.
        let rest_of_line = after[body_len..]
            .split(['\n', '\r'])
            .next()
            .unwrap_or_default();
        if !rest_of_line.chars().all(char::is_whitespace) {
            continue;
        }
        push(
            extractions,
            ExtractionKind::BlockId,
            absolute_caret..absolute_caret + 1 + body_len,
        );
        cursor = caret + 1 + body_len;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(source: &str) -> Vec<(&'static str, usize, usize)> {
        extract(source.as_bytes())
            .into_iter()
            .map(|e| (e.kind.as_str(), e.start_byte, e.end_byte))
            .collect()
    }

    #[test]
    fn wikilink_wins_over_reference_definition() {
        let src =
            "The wikilink [[Foo]] and shortcut [Foo] here.\n\n[Foo]: https://example.com/foo\n";
        assert_eq!(kinds(src), vec![("wikilink", 13, 20), ("link", 34, 39)]);
    }

    #[test]
    fn embed_includes_exclamation_and_escaped_embed_is_a_wikilink() {
        let src = "An embed ![[note#^b1]] and escaped \\![[note2]] end.\n";
        assert_eq!(kinds(src), vec![("embed", 9, 22), ("wikilink", 37, 46)]);
    }

    #[test]
    fn heading_ranges_exclude_terminators() {
        let src = "  # Two leading spaces ##\n\nSetext\n======\n";
        assert_eq!(kinds(src), vec![("heading", 2, 25), ("heading", 27, 40)]);
    }

    #[test]
    fn code_blocks_and_spans() {
        let src = "```rust\nfn x() {}\n```\n\npara\n\n    code\n\nA `span` end.\n";
        assert_eq!(
            kinds(src),
            vec![
                ("code-fence", 0, 21),
                ("code-indented", 29, 37),
                ("code-span", 41, 47),
            ]
        );
    }

    fn texts(src: &str) -> Vec<(&'static str, &str)> {
        extract(src.as_bytes())
            .into_iter()
            .map(|e| (e.kind.as_str(), &src[e.start_byte..e.end_byte]))
            .collect()
    }

    #[test]
    fn tags_follow_obsidian_rules() {
        let src = "#morning starts.\n\nA #projects/greenhouse/frame. Not #2024 but #y2024.\nUrl https://e.com/p#frag stays.\n`#not-a-tag` here.\n";
        assert_eq!(
            texts(src),
            vec![
                ("tag", "#morning"),
                ("tag", "#projects/greenhouse/frame"),
                ("tag", "#y2024"),
                ("code-span", "`#not-a-tag`"),
            ]
        );
    }

    #[test]
    fn hash_word_at_line_start_is_a_tag_not_a_heading() {
        let src = "#Not a heading because the space is missing\n";
        assert_eq!(kinds(src), vec![("tag", 0, 4)]);
    }

    #[test]
    fn block_ids_require_line_end() {
        let src = "A paragraph ends here. ^para-anchor\n\n^standalone\n\nMath 2^10 and mid ^not-anchor words.\n";
        assert_eq!(
            texts(src),
            vec![("block-id", "^para-anchor"), ("block-id", "^standalone")]
        );
    }

    #[test]
    fn subpath_caret_inside_wikilink_is_not_a_block_id() {
        let src = "See [[note#^remote]] here.\n";
        assert_eq!(kinds(src), vec![("wikilink", 4, 20)]);
    }

    #[test]
    fn collapsed_reference_range_includes_the_bracket_pair() {
        let src =
            "A [collapsed reference][] link.\n\n[collapsed reference]: https://example.com/c\n";
        assert_eq!(texts(src), vec![("link", "[collapsed reference][]")]);
    }

    #[test]
    fn autolinks_extracted_bare_urls_are_not() {
        let src = "A <https://example.com/a> and bare https://example.com/b end.\n";
        assert_eq!(kinds(src), vec![("autolink", 2, 25)]);
    }

    #[test]
    fn footnotes_are_not_links() {
        let src = "Claim.[^1]\n\n[^1]: The definition.\n";
        assert_eq!(kinds(src), Vec::new());
    }

    #[test]
    fn frontmatter_is_invisible() {
        let src = "---\ntags:\n  - listed/tag\n---\n\n# Heading\n";
        assert_eq!(kinds(src), vec![("heading", 30, 39)]);
    }

    #[test]
    fn bom_offsets_are_file_absolute() {
        let src = "\u{feff}# Heading after BOM\n";
        assert_eq!(kinds(src), vec![("heading", 3, 22)]);
    }

    #[test]
    fn invalid_utf8_yields_no_extractions() {
        assert_eq!(extract(b"# caf\xE9 latin-1\n"), Vec::new());
    }

    #[test]
    fn total_over_arbitrary_bytes() {
        // A construct-dense adversarial string exercises every branch.
        let src = "[[a|b]] ![[c#^d]] `e` #f ^g\n^h\n<https://i.j>\n";
        let extractions = extract(src.as_bytes());
        assert!(!extractions.is_empty());
        for e in &extractions {
            assert!(e.start_byte < e.end_byte && e.end_byte <= src.len());
        }
    }
}
