//! Frontmatter byte-range detection. Finds the leading YAML block of a note
//! as a byte range without parsing YAML semantics: the range is what editing
//! and reconciliation need, and semantic interpretation stays out of the
//! byte-fidelity path.

use core::ops::Range;

const BOM: &[u8] = &[0xEF, 0xBB, 0xBF];

/// The byte range of a leading YAML frontmatter block, including both
/// delimiter lines and the closing delimiter's line terminator, or `None`
/// when the bytes do not begin with a complete block.
///
/// A block starts with a line that is exactly `---` (a UTF-8 byte-order
/// mark before it is allowed and excluded from the range) and ends at the
/// next line that is exactly `---` or `...`. Delimiter lines may end in
/// `\n`, `\r\n` or a lone `\r`; the closing delimiter may also end at the
/// end of input. An unterminated block is not frontmatter.
#[must_use]
pub fn read_frontmatter(bytes: &[u8]) -> Option<Range<usize>> {
    let start = if bytes.starts_with(BOM) { BOM.len() } else { 0 };
    let rest = &bytes[start..];
    let after_open = start + delimiter_line(rest, b"---")?;
    if after_open == start + 3 {
        // `---` at the very end of input opens nothing.
        return None;
    }

    let mut cursor = after_open;
    while cursor < bytes.len() {
        let line = &bytes[cursor..];
        if let Some(len) = delimiter_line(line, b"---").or_else(|| delimiter_line(line, b"...")) {
            return Some(start..cursor + len);
        }
        cursor += line_length(line);
    }
    None
}

/// When `bytes` begin with `marker` followed by a line terminator or the end
/// of input, the byte length of that delimiter line (marker plus
/// terminator); otherwise `None`.
fn delimiter_line(bytes: &[u8], marker: &[u8]) -> Option<usize> {
    if !bytes.starts_with(marker) {
        return None;
    }
    match bytes.get(marker.len()) {
        None => Some(marker.len()),
        Some(b'\n') => Some(marker.len() + 1),
        Some(b'\r') => {
            if bytes.get(marker.len() + 1) == Some(&b'\n') {
                Some(marker.len() + 2)
            } else {
                Some(marker.len() + 1)
            }
        }
        Some(_) => None,
    }
}

/// The byte length of the first line of `bytes`, terminator included; the
/// whole input when no terminator remains.
fn line_length(bytes: &[u8]) -> usize {
    for (index, &byte) in bytes.iter().enumerate() {
        match byte {
            b'\n' => return index + 1,
            b'\r' => {
                return if bytes.get(index + 1) == Some(&b'\n') {
                    index + 2
                } else {
                    index + 1
                };
            }
            _ => {}
        }
    }
    bytes.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_a_plain_block() {
        let bytes = b"---\ntitle: x\n---\nbody\n";
        assert_eq!(read_frontmatter(bytes), Some(0..17));
    }

    #[test]
    fn detects_crlf_and_dot_terminated_blocks() {
        let bytes = b"---\r\nkey: v\r\n---\r\nbody";
        assert_eq!(read_frontmatter(bytes), Some(0..18));
        let dots = b"---\nkey: v\n...\nbody";
        assert_eq!(read_frontmatter(dots), Some(0..15));
    }

    #[test]
    fn bom_is_allowed_and_excluded_from_the_range() {
        let bytes = b"\xEF\xBB\xBF---\nkey: v\n---\n";
        assert_eq!(read_frontmatter(bytes), Some(3..18));
    }

    #[test]
    fn closing_delimiter_at_end_of_input() {
        let bytes = b"---\nkey: v\n---";
        assert_eq!(read_frontmatter(bytes), Some(0..14));
    }

    #[test]
    fn rejects_non_blocks() {
        assert_eq!(read_frontmatter(b""), None);
        assert_eq!(read_frontmatter(b"body first\n---\nx\n---\n"), None);
        assert_eq!(read_frontmatter(b"---\nunterminated\n"), None);
        assert_eq!(read_frontmatter(b"----\nnot a delimiter\n---\n"), None);
        assert_eq!(read_frontmatter(b"---"), None);
        assert_eq!(read_frontmatter(b"--- trailing\nx\n---\n"), None);
    }

    #[test]
    fn empty_block_is_detected() {
        let bytes = b"---\n---\nbody\n";
        assert_eq!(read_frontmatter(bytes), Some(0..8));
    }
}
