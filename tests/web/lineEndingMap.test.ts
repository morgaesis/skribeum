// Parity tests for the line-ending mapping layer. The Rust implementation
// in crates/skribeum-core/src/line_endings.rs owns the semantics; every
// case below replicates one of its unit tests one for one, so a semantic
// drift between the two implementations fails this suite.

import { describe, expect, it } from "vitest";
import { applyByteChangeSet } from "../../src/lib/editor/byteChangeSet";
import {
  type BufferEdit,
  bufferEditsToChangeSet,
  bufferFromBytes,
  buildLineEndingMap,
  dominantTerminator,
} from "../../src/lib/editor/lineEndingMap";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesOf(text: string): Uint8Array {
  return encoder.encode(text);
}

function edit(start: number, end: number, insert: string): BufferEdit {
  return { start, end, insert: bytesOf(insert) };
}

function convertAndApply(source: string, edits: BufferEdit[]): string {
  const bytes = bytesOf(source);
  const map = buildLineEndingMap(bytes);
  const changes = bufferEditsToChangeSet(map, edits);
  return decoder.decode(applyByteChangeSet(bytes, changes));
}

describe("line-ending map parity", () => {
  it("records mixed terminators", () => {
    const bytes = bytesOf("a\nb\r\nc\rd");
    const map = buildLineEndingMap(bytes);
    expect(decoder.decode(bufferFromBytes(bytes))).toBe("a\nb\nc\nd");
    expect(map.bufferLength).toBe(7);
    expect(dominantTerminator(map)).toBe("lf");
  });

  it("handles empty and terminatorless files", () => {
    expect(buildLineEndingMap(bytesOf("")).bufferLength).toBe(0);
    const map = buildLineEndingMap(bytesOf("plain"));
    expect(map.bufferLength).toBe(5);
    expect(dominantTerminator(map)).toBe("lf");
  });

  it("preserves all terminators for an edit inside content", () => {
    // Replace "two" (buffer offsets 4..7) with "TWO".
    expect(convertAndApply("one\r\ntwo\rthree\n", [edit(4, 7, "TWO")])).toBe(
      "one\r\nTWO\rthree\n",
    );
  });

  it("styles an inserted line break after the touched line", () => {
    // Split the first (CRLF) line: the new break is CRLF.
    expect(convertAndApply("one\r\ntwo\nthree\n", [edit(2, 2, "X\nY")])).toBe(
      "onX\r\nYe\r\ntwo\nthree\n",
    );
  });

  it("joins lines without touching other terminators when a break is deleted", () => {
    // Buffer is "a\nb\nc\n"; delete the first break (offsets 1..2).
    expect(convertAndApply("a\r\nb\nc\r\n", [edit(1, 2, "")])).toBe(
      "ab\nc\r\n",
    );
  });

  it("appends at the end of a terminatorless file", () => {
    expect(convertAndApply("no newline", [edit(10, 10, "!")])).toBe(
      "no newline!",
    );
  });

  it("repairs boundaries so no CRLF merge is created", () => {
    // Inserting an LF-styled break right after a lone-CR terminator must
    // not merge into a single CRLF. Buffer is "lone CR.\nThis ends LF.\n";
    // insert "\n" at offset 9 (start of the second line, style LF).
    const first = convertAndApply("lone CR.\rThis ends LF.\n", [
      edit(9, 9, "\n"),
    ]);
    expect(decoder.decode(bufferFromBytes(bytesOf(first)))).toBe(
      "lone CR.\n\nThis ends LF.\n",
    );

    // Deleting a whole line's content between a CR terminator and an LF
    // terminator must not fuse the two breaks into one CRLF. Buffer is
    // "a\nXXX\nb": delete "XXX" (offsets 2..5).
    const second = convertAndApply("a\rXXX\nb", [edit(2, 5, "")]);
    expect(decoder.decode(bufferFromBytes(bytesOf(second)))).toBe("a\n\nb");

    // A break inserted inside the CR-terminated first line, styled CR,
    // must not merge with anything around it.
    const third = convertAndApply("x\rtail\n", [edit(1, 1, "\n")]);
    expect(decoder.decode(bufferFromBytes(bytesOf(third)))).toBe("x\n\ntail\n");
  });

  it("rejects malformed edits", () => {
    const map = buildLineEndingMap(bytesOf("abc\ndef\n"));
    expect(() => bufferEditsToChangeSet(map, [edit(3, 2, "")])).toThrow(
      "buffer edit start exceeds end",
    );
    expect(() => bufferEditsToChangeSet(map, [edit(0, 99, "")])).toThrow(
      "buffer edit exceeds the buffer length",
    );
    expect(() =>
      bufferEditsToChangeSet(map, [edit(2, 5, "x"), edit(4, 6, "y")]),
    ).toThrow("buffer edits overlap or are unsorted");
  });

  it("emits the dominant CRLF style for new breaks on the final line", () => {
    const map = buildLineEndingMap(bytesOf("a\r\nb\r\ntail"));
    expect(dominantTerminator(map)).toBe("crlf");
    // Insert a break inside the terminatorless final line: dominant style
    // applies.
    expect(convertAndApply("a\r\nb\r\ntail", [edit(6, 6, "x\ny")])).toBe(
      "a\r\nb\r\ntax\r\nyil",
    );
  });
});
