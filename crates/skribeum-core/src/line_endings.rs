//! Byte-to-buffer line-ending mapping. `CodeMirror` normalizes line
//! separators, so a mixed-ending file cannot be represented in the buffer
//! natively. This layer records each line's original terminator on open and
//! re-emits it for untouched lines when buffer-space edits are converted to
//! byte-space change sets; only lines an edit actually touched may carry a
//! new terminator.

use crate::change_set::ByteRangeReplace;

/// A line's original terminator as found in the on-disk bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Terminator {
    /// `\n`.
    Lf,
    /// `\r\n`.
    CrLf,
    /// A lone `\r`.
    Cr,
    /// No terminator: the final line of a file with no trailing newline.
    None,
}

impl Terminator {
    /// The terminator's on-disk byte representation.
    #[must_use]
    pub fn as_bytes(self) -> &'static [u8] {
        match self {
            Self::Lf => b"\n",
            Self::CrLf => b"\r\n",
            Self::Cr => b"\r",
            Self::None => b"",
        }
    }

    /// Byte length on disk.
    #[must_use]
    pub fn byte_len(self) -> usize {
        self.as_bytes().len()
    }

    /// Length in the buffer projection, where every terminator is a single
    /// `\n` and a missing terminator contributes nothing.
    #[must_use]
    pub fn buffer_len(self) -> usize {
        match self {
            Self::None => 0,
            Self::Lf | Self::CrLf | Self::Cr => 1,
        }
    }
}

/// One recorded line: where its content starts in the original bytes, how
/// long the content is, and which terminator followed it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Line {
    byte_start: usize,
    content_len: usize,
    terminator: Terminator,
}

/// The per-line terminator record taken at open time. All offsets are byte
/// offsets: original-byte offsets on the disk side and buffer-byte offsets
/// (UTF-8, `\n`-separated) on the buffer side, per the IPC invariant that
/// every position is a UTF-8 byte offset.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineEndingMap {
    lines: Vec<Line>,
    byte_len: usize,
    buffer_len: usize,
}

/// One buffer-space edit: replace buffer bytes `start..end` with `insert`,
/// where `insert` uses `\n` separators (the only separator a normalized
/// buffer can contain).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BufferEdit {
    /// Inclusive start buffer-byte offset.
    pub start: usize,
    /// Exclusive end buffer-byte offset.
    pub end: usize,
    /// Replacement buffer bytes, `\n`-separated.
    pub insert: Vec<u8>,
}

/// Why buffer edits failed to convert.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum LineEndingError {
    /// An edit reaches past the end of the buffer projection.
    #[error("buffer edit exceeds the buffer length")]
    OutOfBounds,
    /// An edit has `start > end`.
    #[error("buffer edit start exceeds end")]
    Inverted,
    /// Edits overlap or are not sorted by start offset.
    #[error("buffer edits overlap or are unsorted")]
    Overlap,
}

impl LineEndingMap {
    /// Records each line's terminator from the exact on-disk bytes.
    #[must_use]
    pub fn from_bytes(bytes: &[u8]) -> Self {
        let mut lines = Vec::new();
        let mut buffer_len = 0usize;
        let mut start = 0usize;
        let mut index = 0usize;
        while index < bytes.len() {
            let terminator = match bytes[index] {
                b'\n' => Some(Terminator::Lf),
                b'\r' if bytes.get(index + 1) == Some(&b'\n') => Some(Terminator::CrLf),
                b'\r' => Some(Terminator::Cr),
                _ => None,
            };
            if let Some(terminator) = terminator {
                let content_len = index - start;
                lines.push(Line {
                    byte_start: start,
                    content_len,
                    terminator,
                });
                buffer_len += content_len + terminator.buffer_len();
                start = index + terminator.byte_len();
                index = start;
            } else {
                index += 1;
            }
        }
        if start < bytes.len() {
            let content_len = bytes.len() - start;
            lines.push(Line {
                byte_start: start,
                content_len,
                terminator: Terminator::None,
            });
            buffer_len += content_len;
        }
        Self {
            lines,
            byte_len: bytes.len(),
            buffer_len,
        }
    }

    /// Length of the buffer projection in bytes.
    #[must_use]
    pub fn buffer_len(&self) -> usize {
        self.buffer_len
    }

    /// The terminator style most frequent in the file, used for line breaks
    /// created inside an edit. Ties resolve in the order LF, CRLF, CR; a
    /// file with no terminator at all defaults to LF.
    #[must_use]
    pub fn dominant_terminator(&self) -> Terminator {
        let mut counts = [0usize; 3];
        for line in &self.lines {
            match line.terminator {
                Terminator::Lf => counts[0] += 1,
                Terminator::CrLf => counts[1] += 1,
                Terminator::Cr => counts[2] += 1,
                Terminator::None => {}
            }
        }
        let best = counts.iter().copied().max().unwrap_or(0);
        if best == 0 {
            return Terminator::Lf;
        }
        if counts[0] == best {
            Terminator::Lf
        } else if counts[1] == best {
            Terminator::CrLf
        } else {
            Terminator::Cr
        }
    }

    /// Converts a buffer-byte offset into an original-byte offset. Offsets
    /// on a line map within that line's content; the offset just past a
    /// line's content maps to the start of its terminator bytes.
    fn buffer_offset_to_byte(&self, offset: usize) -> usize {
        let mut buffer_pos = 0usize;
        for line in &self.lines {
            let content_end = buffer_pos + line.content_len;
            if offset <= content_end {
                return line.byte_start + (offset - buffer_pos);
            }
            buffer_pos = content_end + line.terminator.buffer_len();
        }
        self.byte_len
    }

    /// The terminator of the line whose buffer range contains `offset`,
    /// falling back through the dominant terminator to LF. Used to pick the
    /// style for line breaks the edit itself creates.
    fn terminator_at_buffer_offset(&self, offset: usize) -> Terminator {
        let mut buffer_pos = 0usize;
        for line in &self.lines {
            let line_end = buffer_pos + line.content_len + line.terminator.buffer_len();
            if offset < line_end || line_end == self.buffer_len {
                return match line.terminator {
                    Terminator::None => self.dominant_terminator(),
                    other => other,
                };
            }
            buffer_pos = line_end;
        }
        self.dominant_terminator()
    }

    /// Converts buffer-space edits into a byte-space change set against the
    /// original bytes. Untouched lines keep their original terminators
    /// because their terminator bytes never enter any replaced range; line
    /// breaks inside an edit's inserted text are emitted in the style of the
    /// first line the edit touches.
    ///
    /// # Errors
    ///
    /// Returns a [`LineEndingError`] when edits are out of bounds, inverted,
    /// overlapping or unsorted.
    pub fn buffer_edits_to_change_set(
        &self,
        edits: &[BufferEdit],
    ) -> Result<Vec<ByteRangeReplace>, LineEndingError> {
        let mut cursor = 0usize;
        for edit in edits {
            if edit.start > edit.end {
                return Err(LineEndingError::Inverted);
            }
            if edit.end > self.buffer_len {
                return Err(LineEndingError::OutOfBounds);
            }
            if edit.start < cursor {
                return Err(LineEndingError::Overlap);
            }
            cursor = edit.end;
        }

        let mut changes = Vec::with_capacity(edits.len());
        for edit in edits {
            let start = self.buffer_offset_to_byte(edit.start);
            let end = self.buffer_offset_to_byte(edit.end);
            let style = self.terminator_at_buffer_offset(edit.start);
            let mut bytes = Vec::with_capacity(edit.insert.len());
            for &byte in &edit.insert {
                if byte == b'\n' {
                    bytes.extend_from_slice(style.as_bytes());
                } else {
                    bytes.push(byte);
                }
            }
            // A CR immediately followed by an LF reads back as one CRLF, so
            // a replacement boundary must never create that adjacency: it
            // would silently merge two line breaks into one. Both repairs
            // restyle only a break the edit itself touches. The trailing
            // repair runs first so a boundary hit on both sides is repaired
            // once, not twice.
            if bytes.last() == Some(&b'\r') && self.lf_terminator_starts_at(end) {
                bytes.push(b'\n');
            }
            let first_effective = bytes.first().copied().or_else(|| {
                if self.lf_terminator_starts_at(end) {
                    Some(b'\n')
                } else {
                    None
                }
            });
            if self.cr_terminator_ends_at(start) && first_effective == Some(b'\n') {
                bytes.insert(0, b'\r');
            }
            changes.push(ByteRangeReplace { start, end, bytes });
        }
        Ok(changes)
    }

    /// Whether a lone-CR terminator occupies exactly the byte before
    /// `byte_offset`.
    fn cr_terminator_ends_at(&self, byte_offset: usize) -> bool {
        self.lines.iter().any(|line| {
            line.terminator == Terminator::Cr
                && line.byte_start + line.content_len + 1 == byte_offset
        })
    }

    /// Whether a lone-LF terminator starts exactly at `byte_offset`.
    fn lf_terminator_starts_at(&self, byte_offset: usize) -> bool {
        self.lines.iter().any(|line| {
            line.terminator == Terminator::Lf && line.byte_start + line.content_len == byte_offset
        })
    }
}

/// The buffer projection of on-disk bytes: every terminator (`\n`, `\r\n`,
/// lone `\r`) becomes a single `\n`, and content bytes pass through
/// untouched. This is the byte string whose offsets the buffer side of the
/// mapping uses.
#[must_use]
pub fn buffer_from_bytes(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0usize;
    while index < bytes.len() {
        match bytes[index] {
            b'\r' if bytes.get(index + 1) == Some(&b'\n') => {
                out.push(b'\n');
                index += 2;
            }
            b'\r' => {
                out.push(b'\n');
                index += 1;
            }
            other => {
                out.push(other);
                index += 1;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::change_set::apply_change_set;

    fn edit(start: usize, end: usize, insert: &[u8]) -> BufferEdit {
        BufferEdit {
            start,
            end,
            insert: insert.to_vec(),
        }
    }

    #[test]
    fn records_mixed_terminators() {
        let bytes = b"a\nb\r\nc\rd";
        let map = LineEndingMap::from_bytes(bytes);
        assert_eq!(buffer_from_bytes(bytes), b"a\nb\nc\nd");
        assert_eq!(map.buffer_len(), 7);
        assert_eq!(map.dominant_terminator(), Terminator::Lf);
    }

    #[test]
    fn empty_and_terminatorless_files() {
        assert_eq!(LineEndingMap::from_bytes(b"").buffer_len(), 0);
        let map = LineEndingMap::from_bytes(b"plain");
        assert_eq!(map.buffer_len(), 5);
        assert_eq!(map.dominant_terminator(), Terminator::Lf);
    }

    #[test]
    fn edit_inside_content_preserves_all_terminators() {
        let bytes = b"one\r\ntwo\rthree\n";
        let map = LineEndingMap::from_bytes(bytes);
        // Replace "two" (buffer offsets 4..7) with "TWO".
        let changes = map
            .buffer_edits_to_change_set(&[edit(4, 7, b"TWO")])
            .expect("converts");
        let out = apply_change_set(bytes, &changes).expect("applies");
        assert_eq!(out, b"one\r\nTWO\rthree\n");
    }

    #[test]
    fn inserted_line_break_uses_touched_line_style() {
        let bytes = b"one\r\ntwo\nthree\n";
        let map = LineEndingMap::from_bytes(bytes);
        // Split the first (CRLF) line: the new break is CRLF.
        let changes = map
            .buffer_edits_to_change_set(&[edit(2, 2, b"X\nY")])
            .expect("converts");
        let out = apply_change_set(bytes, &changes).expect("applies");
        assert_eq!(out, b"onX\r\nYe\r\ntwo\nthree\n");
    }

    #[test]
    fn deleting_a_line_break_joins_lines_without_touching_others() {
        let bytes = b"a\r\nb\nc\r\n";
        let map = LineEndingMap::from_bytes(bytes);
        // Buffer is "a\nb\nc\n"; delete the first break (offsets 1..2).
        let changes = map
            .buffer_edits_to_change_set(&[edit(1, 2, b"")])
            .expect("converts");
        let out = apply_change_set(bytes, &changes).expect("applies");
        assert_eq!(out, b"ab\nc\r\n");
    }

    #[test]
    fn append_at_end_of_terminatorless_file() {
        let bytes = b"no newline";
        let map = LineEndingMap::from_bytes(bytes);
        let changes = map
            .buffer_edits_to_change_set(&[edit(10, 10, b"!")])
            .expect("converts");
        let out = apply_change_set(bytes, &changes).expect("applies");
        assert_eq!(out, b"no newline!");
    }

    #[test]
    fn boundary_repairs_prevent_crlf_merges() {
        // Inserting an LF-styled break right after a lone-CR terminator
        // must not merge into a single CRLF.
        let bytes = b"lone CR.\rThis ends LF.\n";
        let map = LineEndingMap::from_bytes(bytes);
        // Buffer is "lone CR.\nThis ends LF.\n"; insert "\n" at offset 9
        // (start of the second line, style LF).
        let changes = map
            .buffer_edits_to_change_set(&[edit(9, 9, b"\n")])
            .expect("converts");
        let out = apply_change_set(bytes, &changes).expect("applies");
        assert_eq!(
            buffer_from_bytes(&out),
            b"lone CR.\n\nThis ends LF.\n",
            "the inserted break must survive next to the lone CR"
        );

        // Deleting a whole line's content between a CR terminator and an
        // LF terminator must not fuse the two breaks into one CRLF.
        let bytes = b"a\rXXX\nb";
        let map = LineEndingMap::from_bytes(bytes);
        // Buffer is "a\nXXX\nb": delete "XXX" (offsets 2..5).
        let changes = map
            .buffer_edits_to_change_set(&[edit(2, 5, b"")])
            .expect("converts");
        let out = apply_change_set(bytes, &changes).expect("applies");
        assert_eq!(
            buffer_from_bytes(&out),
            b"a\n\nb",
            "both original breaks must survive the deletion"
        );

        // A break inserted inside the CR-terminated first line, styled CR,
        // must not merge with anything around it.
        let bytes = b"x\rtail\n";
        let map = LineEndingMap::from_bytes(bytes);
        let changes = map
            .buffer_edits_to_change_set(&[edit(1, 1, b"\n")])
            .expect("converts");
        let out = apply_change_set(bytes, &changes).expect("applies");
        assert_eq!(buffer_from_bytes(&out), b"x\n\ntail\n");
    }

    #[test]
    fn rejects_malformed_edits() {
        let map = LineEndingMap::from_bytes(b"abc\ndef\n");
        assert_eq!(
            map.buffer_edits_to_change_set(&[edit(3, 2, b"")]),
            Err(LineEndingError::Inverted)
        );
        assert_eq!(
            map.buffer_edits_to_change_set(&[edit(0, 99, b"")]),
            Err(LineEndingError::OutOfBounds)
        );
        assert_eq!(
            map.buffer_edits_to_change_set(&[edit(2, 5, b"x"), edit(4, 6, b"y")]),
            Err(LineEndingError::Overlap)
        );
    }

    #[test]
    fn crlf_dominant_file_emits_crlf_for_new_breaks_on_final_line() {
        let bytes = b"a\r\nb\r\ntail";
        let map = LineEndingMap::from_bytes(bytes);
        assert_eq!(map.dominant_terminator(), Terminator::CrLf);
        // Insert a break inside the terminatorless final line: dominant
        // style applies.
        let changes = map
            .buffer_edits_to_change_set(&[edit(6, 6, b"x\ny")])
            .expect("converts");
        let out = apply_change_set(bytes, &changes).expect("applies");
        assert_eq!(out, b"a\r\nb\r\ntax\r\nyil".as_slice());
    }
}
