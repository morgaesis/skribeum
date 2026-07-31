// Byte-range change sets on the editor side: the delta form in which edits
// cross IPC. Applying one is a pure function mirroring
// `skribeum_core::apply_change_set`, so the tracked base projection stays
// byte-identical to what the Rust side computes from the same change set.

/**
 * One byte-range replacement against a base byte string: the bytes at
 * `start..end` (byte offsets into the base) are replaced by `bytes`. An
 * insertion has `start === end`; a deletion has empty `bytes`.
 */
export type ByteChange = {
  /** Inclusive start byte offset into the base. */
  start: number;
  /** Exclusive end byte offset into the base. */
  end: number;
  /** Replacement bytes. */
  bytes: Uint8Array;
};

/**
 * Applies a change set to `base`, returning the new byte string. Ranges
 * must be sorted by start offset, non-overlapping and within bounds;
 * adjacent ranges are allowed. Throws on the first structural violation
 * before any byte is produced, matching the Rust validation.
 */
export function applyByteChangeSet(
  base: Uint8Array,
  changes: readonly ByteChange[],
): Uint8Array {
  let cursor = 0;
  let sizeDelta = 0;
  for (const change of changes) {
    if (change.start > change.end) {
      throw new Error("change range start exceeds end");
    }
    if (change.end > base.length) {
      throw new Error("change range exceeds the base length");
    }
    if (change.start < cursor) {
      throw new Error("change ranges overlap or are unsorted");
    }
    cursor = change.end;
    sizeDelta += change.bytes.length - (change.end - change.start);
  }

  const out = new Uint8Array(base.length + sizeDelta);
  let copied = 0;
  let written = 0;
  for (const change of changes) {
    out.set(base.subarray(copied, change.start), written);
    written += change.start - copied;
    out.set(change.bytes, written);
    written += change.bytes.length;
    copied = change.end;
  }
  out.set(base.subarray(copied), written);
  return out;
}

/** One contiguous text replacement in UTF-16 (CodeMirror) coordinates. */
export type TextSpan = {
  /** Inclusive start offset into the old text. */
  from: number;
  /** Exclusive end offset into the old text. */
  to: number;
  /** Replacement text. */
  insert: string;
};

/** Whether a UTF-16 code unit is a high surrogate. */
function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

/** Whether a UTF-16 code unit is a low surrogate. */
function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/**
 * The single contiguous span of `before` that differs from `after`, or
 * `null` when the two are identical. Computed by trimming the longest
 * common prefix and suffix, then backing the boundaries off so they never
 * split a surrogate pair. This is `skribeum_core::changed_span` lifted
 * into text space: a valid (not necessarily minimal-count) replacement
 * that turns `before` into `after`, used to express an externally observed
 * difference as one CodeMirror change.
 */
export function changedTextSpan(
  before: string,
  after: string,
): TextSpan | null {
  if (before === after) {
    return null;
  }
  const shorter = Math.min(before.length, after.length);
  let prefix = 0;
  while (
    prefix < shorter &&
    before.charCodeAt(prefix) === after.charCodeAt(prefix)
  ) {
    prefix += 1;
  }
  if (prefix > 0 && isHighSurrogate(before.charCodeAt(prefix - 1))) {
    prefix -= 1;
  }
  const maxSuffix = shorter - prefix;
  let suffix = 0;
  while (
    suffix < maxSuffix &&
    before.charCodeAt(before.length - 1 - suffix) ===
      after.charCodeAt(after.length - 1 - suffix)
  ) {
    suffix += 1;
  }
  if (suffix > 0 && isLowSurrogate(before.charCodeAt(before.length - suffix))) {
    // The suffix would begin with the low half of a surrogate pair; pull
    // that unit into the changed span instead of splitting the pair.
    suffix -= 1;
  }
  return {
    from: prefix,
    to: before.length - suffix,
    insert: after.slice(prefix, after.length - suffix),
  };
}
