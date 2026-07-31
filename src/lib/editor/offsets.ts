// UTF-16 to UTF-8 offset conversion at the IPC boundary. CodeMirror
// indexes documents in UTF-16 code units and every position crossing IPC
// is a UTF-8 byte offset; the spaces agree on ASCII and diverge on emoji
// and CJK. This module mirrors the conversion semantics of
// `skribeum-core` (`utf16_offset_to_byte` and `byte_offset_to_utf16`),
// including the clamping rules for offsets inside a surrogate pair or a
// multi-byte character and for offsets past the end of the text. The web
// test suite asserts parity on the same cases the Rust tests pin: ASCII,
// astral plane, combining marks, CJK and the clamps.

/** UTF-8 byte length of one Unicode code point. */
function codePointByteLength(codePoint: number): number {
  if (codePoint < 0x80) {
    return 1;
  }
  if (codePoint < 0x800) {
    return 2;
  }
  if (codePoint < 0x10000) {
    return 3;
  }
  return 4;
}

/**
 * Converts a UTF-16 code-unit offset (the CodeMirror index space) into a
 * UTF-8 byte offset into `text`. Offsets past the end of `text`, or landing
 * inside a surrogate pair, clamp to the start of the last complete
 * character at or before the target.
 */
export function utf16OffsetToByteOffset(
  text: string,
  utf16Offset: number,
): number {
  let units = 0;
  let bytes = 0;
  for (const character of text) {
    if (units === utf16Offset) {
      return bytes;
    }
    const codePoint = character.codePointAt(0) ?? 0;
    if (units + character.length > utf16Offset) {
      // The target lands inside this character's code units; clamp to the
      // character start.
      return bytes;
    }
    units += character.length;
    bytes += codePointByteLength(codePoint);
  }
  return bytes;
}

/**
 * Converts a UTF-8 byte offset into a UTF-16 code-unit offset. Byte
 * offsets inside a multi-byte character clamp to the start of that
 * character; offsets past the end clamp to the end.
 */
export function byteOffsetToUtf16Offset(
  text: string,
  byteOffset: number,
): number {
  let units = 0;
  let bytes = 0;
  for (const character of text) {
    if (bytes === byteOffset) {
      return units;
    }
    const codePoint = character.codePointAt(0) ?? 0;
    const characterBytes = codePointByteLength(codePoint);
    if (bytes + characterBytes > byteOffset) {
      // The target lands inside this character's bytes; clamp to the
      // character start.
      return units;
    }
    units += character.length;
    bytes += characterBytes;
  }
  return units;
}
