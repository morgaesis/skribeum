//! Pure functions over markdown source text. This crate performs no I/O and
//! has no Tauri dependency; everything here is a function of its arguments.

pub mod change_set;
pub mod frontmatter;
pub mod line_endings;

pub use change_set::{
    ByteRangeReplace, ChangeSetError, apply_change_set, changed_span, span_within_declared,
};
pub use frontmatter::read_frontmatter;
pub use line_endings::{BufferEdit, LineEndingError, LineEndingMap, Terminator, buffer_from_bytes};

/// Converts a UTF-16 code-unit offset (the `CodeMirror` index space) into a UTF-8
/// byte offset into `text`. All positions crossing the IPC boundary are UTF-8
/// byte offsets; this conversion happens at the boundary and nowhere else.
///
/// Offsets past the end of `text`, or landing inside a surrogate pair, clamp
/// to the start of the last complete character at or before the target.
#[must_use]
pub fn utf16_offset_to_byte(text: &str, utf16_offset: usize) -> usize {
    let mut units = 0usize;
    for (byte_index, ch) in text.char_indices() {
        if units == utf16_offset {
            return byte_index;
        }
        if units + ch.len_utf16() > utf16_offset {
            // The target lands inside this character's code units; clamp to
            // the character start.
            return byte_index;
        }
        units += ch.len_utf16();
    }
    text.len()
}

/// Converts a UTF-8 byte offset into a UTF-16 code-unit offset. Byte offsets
/// inside a multi-byte character clamp to the start of that character.
#[must_use]
pub fn byte_offset_to_utf16(text: &str, byte_offset: usize) -> usize {
    let mut units = 0usize;
    for (byte_index, ch) in text.char_indices() {
        if byte_index == byte_offset {
            return units;
        }
        if byte_index + ch.len_utf8() > byte_offset {
            // The target lands inside this character's bytes; clamp to the
            // character start.
            return units;
        }
        units += ch.len_utf16();
    }
    units
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_offsets_agree() {
        let text = "hello world";
        assert_eq!(utf16_offset_to_byte(text, 5), 5);
        assert_eq!(byte_offset_to_utf16(text, 5), 5);
    }

    #[test]
    fn astral_plane_diverges() {
        // One emoji: 4 UTF-8 bytes, 2 UTF-16 code units.
        let text = "a\u{1F600}b";
        assert_eq!(utf16_offset_to_byte(text, 1), 1);
        assert_eq!(utf16_offset_to_byte(text, 3), 5);
        assert_eq!(byte_offset_to_utf16(text, 5), 3);
    }

    #[test]
    fn surrogate_interior_clamps_to_character_start() {
        let text = "a\u{1F600}b";
        assert_eq!(utf16_offset_to_byte(text, 2), 1);
        assert_eq!(byte_offset_to_utf16(text, 3), 1);
    }

    #[test]
    fn out_of_range_clamps_to_end() {
        let text = "ab";
        assert_eq!(utf16_offset_to_byte(text, 99), 2);
        assert_eq!(byte_offset_to_utf16(text, 99), 2);
    }
}
