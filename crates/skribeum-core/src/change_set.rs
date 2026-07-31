//! Byte-range change sets: the delta form in which edits cross IPC and are
//! applied to note bytes. A change set is an ordered list of non-overlapping
//! byte-range replacements against one base byte string; applying it is a
//! pure function, which is what makes byte-fidelity properties testable.

/// One byte-range replacement against a base byte string: the bytes at
/// `start..end` (byte offsets into the base) are replaced by `bytes`. An
/// insertion has `start == end`; a deletion has empty `bytes`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ByteRangeReplace {
    /// Inclusive start byte offset into the base.
    pub start: usize,
    /// Exclusive end byte offset into the base.
    pub end: usize,
    /// Replacement bytes.
    pub bytes: Vec<u8>,
}

/// Why a change set failed to apply.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ChangeSetError {
    /// A range has `start > end`.
    #[error("change range start exceeds end")]
    Inverted,
    /// A range reaches past the end of the base bytes.
    #[error("change range exceeds the base length")]
    OutOfBounds,
    /// Ranges overlap or are not sorted by start offset.
    #[error("change ranges overlap or are unsorted")]
    Overlap,
}

/// Applies a change set to `base`, returning the new byte string. Ranges
/// must be sorted by start offset, non-overlapping and within bounds;
/// adjacent ranges (one ending where the next starts) are allowed.
///
/// # Errors
///
/// Returns a [`ChangeSetError`] naming the first structural violation. The
/// base is never partially applied: validation happens before any byte is
/// produced.
pub fn apply_change_set(
    base: &[u8],
    changes: &[ByteRangeReplace],
) -> Result<Vec<u8>, ChangeSetError> {
    let mut cursor = 0usize;
    for change in changes {
        if change.start > change.end {
            return Err(ChangeSetError::Inverted);
        }
        if change.end > base.len() {
            return Err(ChangeSetError::OutOfBounds);
        }
        if change.start < cursor {
            return Err(ChangeSetError::Overlap);
        }
        cursor = change.end;
    }

    let mut out = Vec::with_capacity(base.len());
    let mut copied = 0usize;
    for change in changes {
        out.extend_from_slice(&base[copied..change.start]);
        out.extend_from_slice(&change.bytes);
        copied = change.end;
    }
    out.extend_from_slice(&base[copied..]);
    Ok(out)
}

/// The single contiguous span of `before` that differs from `after`, as a
/// `(start, end)` byte range in `before` coordinates, or `None` when the two
/// are byte-identical. Computed by trimming the longest common prefix and
/// suffix; a pure insertion or deletion yields an empty or minimal span at
/// the edit point. Reconciliation and journal recovery use it to express an
/// observed difference as a single byte-range replacement.
#[must_use]
pub fn changed_span(before: &[u8], after: &[u8]) -> Option<(usize, usize)> {
    if before == after {
        return None;
    }
    let prefix = before
        .iter()
        .zip(after.iter())
        .take_while(|(b, a)| b == a)
        .count();
    let max_suffix = before.len().min(after.len()) - prefix;
    let suffix = before
        .iter()
        .rev()
        .zip(after.iter().rev())
        .take(max_suffix)
        .take_while(|(b, a)| b == a)
        .count();
    Some((prefix, before.len() - suffix))
}

/// Whether the difference between `before` and `after` lies inside the
/// union of `declared` ranges (each `(start, end)` in `before`
/// coordinates). This is the declared-range containment property:
/// `diff(before, after)` must be a subset of the declared ranges.
///
/// Mechanically: every byte of `before` outside the declared union must
/// survive into `after` unchanged, in order, with the segment before the
/// first range anchored at the start and the segment after the last range
/// anchored at the end. Only the declared ranges may account for whatever
/// lies between those segments, so any undeclared mutation breaks a
/// segment and fails. Diff ambiguity on repeated content (deleting one
/// byte of an identical run has many equally minimal placements) is
/// handled by construction, since the check asks whether some assignment
/// of the declared ranges explains `after`, not whether one canonical diff
/// placement does.
#[must_use]
pub fn span_within_declared(before: &[u8], after: &[u8], declared: &[(usize, usize)]) -> bool {
    // Normalize: clamp to bounds, sort, merge overlapping and adjacent.
    let mut ranges: Vec<(usize, usize)> = declared
        .iter()
        .map(|&(s, e)| (s.min(before.len()), e.clamp(s, before.len())))
        .collect();
    ranges.sort_unstable();
    let mut merged: Vec<(usize, usize)> = Vec::with_capacity(ranges.len());
    for (s, e) in ranges {
        match merged.last_mut() {
            Some(last) if s <= last.1 => last.1 = last.1.max(e),
            _ => merged.push((s, e)),
        }
    }
    if merged.is_empty() {
        return before == after;
    }

    // The fixed segments of `before` outside the declared union.
    let mut segments: Vec<&[u8]> = Vec::with_capacity(merged.len() + 1);
    segments.push(&before[..merged[0].0]);
    for window in merged.windows(2) {
        segments.push(&before[window[0].1..window[1].0]);
    }
    let tail = &before[merged[merged.len() - 1].1..];

    // Anchors: the head segment at the start, the tail segment at the end.
    if !after.starts_with(segments[0]) {
        return false;
    }
    if after.len() < segments[0].len() + tail.len() || !after.ends_with(tail) {
        return false;
    }
    let limit = after.len() - tail.len();

    // Middle segments must appear in order between the anchors; greedy
    // leftmost matching is complete for in-order matching with free gaps.
    let mut position = segments[0].len();
    for segment in &segments[1..] {
        if segment.is_empty() {
            continue;
        }
        let Some(found) = find_from(after, segment, position, limit) else {
            return false;
        };
        position = found + segment.len();
    }
    position <= limit
}

/// Leftmost occurrence of `needle` in `haystack[from..limit]`, as an
/// absolute offset.
fn find_from(haystack: &[u8], needle: &[u8], from: usize, limit: usize) -> Option<usize> {
    let end = limit.min(haystack.len());
    if from > end || needle.len() > end - from {
        return None;
    }
    haystack[from..end]
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|offset| from + offset)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn replace(start: usize, end: usize, bytes: &[u8]) -> ByteRangeReplace {
        ByteRangeReplace {
            start,
            end,
            bytes: bytes.to_vec(),
        }
    }

    #[test]
    fn applies_replacements_insertions_and_deletions() {
        let base = b"hello world";
        let out = apply_change_set(base, &[replace(0, 5, b"goodbye")]).expect("applies");
        assert_eq!(out, b"goodbye world");

        let out = apply_change_set(base, &[replace(5, 5, b",")]).expect("applies");
        assert_eq!(out, b"hello, world");

        let out = apply_change_set(base, &[replace(5, 11, b"")]).expect("applies");
        assert_eq!(out, b"hello");

        let out =
            apply_change_set(base, &[replace(0, 1, b"H"), replace(6, 7, b"W")]).expect("applies");
        assert_eq!(out, b"Hello World");
    }

    #[test]
    fn empty_change_set_is_identity() {
        let base = b"unchanged";
        assert_eq!(apply_change_set(base, &[]).expect("applies"), base);
    }

    #[test]
    fn rejects_malformed_change_sets() {
        let base = b"0123456789";
        assert_eq!(
            apply_change_set(base, &[replace(5, 3, b"")]),
            Err(ChangeSetError::Inverted)
        );
        assert_eq!(
            apply_change_set(base, &[replace(5, 99, b"")]),
            Err(ChangeSetError::OutOfBounds)
        );
        assert_eq!(
            apply_change_set(base, &[replace(3, 6, b"x"), replace(5, 8, b"y")]),
            Err(ChangeSetError::Overlap)
        );
        assert_eq!(
            apply_change_set(base, &[replace(6, 8, b"x"), replace(1, 2, b"y")]),
            Err(ChangeSetError::Overlap)
        );
    }

    #[test]
    fn adjacent_ranges_are_allowed() {
        let base = b"abcdef";
        let out =
            apply_change_set(base, &[replace(1, 3, b"X"), replace(3, 5, b"Y")]).expect("applies");
        assert_eq!(out, b"aXYf");
    }

    #[test]
    fn changed_span_trims_prefix_and_suffix() {
        assert_eq!(changed_span(b"abcdef", b"abcdef"), None);
        assert_eq!(changed_span(b"abcdef", b"abXdef"), Some((2, 3)));
        assert_eq!(changed_span(b"abcdef", b"abdef"), Some((2, 3)));
        assert_eq!(changed_span(b"abdef", b"abcdef"), Some((2, 2)));
        assert_eq!(changed_span(b"", b"x"), Some((0, 0)));
        assert_eq!(changed_span(b"x", b""), Some((0, 1)));
    }

    #[test]
    fn containment_accepts_declared_and_rejects_undeclared_changes() {
        let before = b"one two three".to_vec();
        let after = apply_change_set(&before, &[replace(4, 7, b"TWO")]).expect("applies");
        assert!(span_within_declared(&before, &after, &[(4, 7)]));
        // The same change with a declaration elsewhere is a violation.
        assert!(!span_within_declared(&before, &after, &[(0, 3)]));
        // An undeclared extra mutation is a violation even when one range
        // is declared.
        let sneaky = apply_change_set(&before, &[replace(4, 7, b"TWO"), replace(8, 13, b"THREE")])
            .expect("applies");
        assert!(!span_within_declared(&before, &sneaky, &[(4, 7)]));
    }
}
