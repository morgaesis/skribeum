// Parity tests for the boundary offset conversion. The cases mirror the
// Rust tests on `skribeum_core::utf16_offset_to_byte` and
// `byte_offset_to_utf16` plus the corpus-mandated divergence classes:
// ASCII (spaces agree), astral plane (4 UTF-8 bytes, 2 UTF-16 units),
// combining marks (2 UTF-8 bytes, 1 unit) and CJK (3 UTF-8 bytes, 1 unit).

import { describe, expect, it } from "vitest";
import {
  byteOffsetToUtf16Offset,
  utf16OffsetToByteOffset,
} from "../../src/lib/editor/offsets";

describe("offset conversion parity", () => {
  it("agrees on ASCII", () => {
    const text = "hello world";
    expect(utf16OffsetToByteOffset(text, 5)).toBe(5);
    expect(byteOffsetToUtf16Offset(text, 5)).toBe(5);
  });

  it("diverges on the astral plane", () => {
    // One emoji: 4 UTF-8 bytes, 2 UTF-16 code units.
    const text = "a\u{1F600}b";
    expect(utf16OffsetToByteOffset(text, 1)).toBe(1);
    expect(utf16OffsetToByteOffset(text, 3)).toBe(5);
    expect(byteOffsetToUtf16Offset(text, 5)).toBe(3);
  });

  it("clamps surrogate-interior offsets to the character start", () => {
    const text = "a\u{1F600}b";
    expect(utf16OffsetToByteOffset(text, 2)).toBe(1);
    expect(byteOffsetToUtf16Offset(text, 3)).toBe(1);
  });

  it("clamps out-of-range offsets to the end", () => {
    const text = "ab";
    expect(utf16OffsetToByteOffset(text, 99)).toBe(2);
    expect(byteOffsetToUtf16Offset(text, 99)).toBe(2);
  });

  it("counts combining marks by their own bytes", () => {
    // "e" plus combining acute: 1 + 2 UTF-8 bytes, 1 + 1 UTF-16 units.
    const text = "e\u0301x";
    expect(utf16OffsetToByteOffset(text, 1)).toBe(1);
    expect(utf16OffsetToByteOffset(text, 2)).toBe(3);
    expect(utf16OffsetToByteOffset(text, 3)).toBe(4);
    expect(byteOffsetToUtf16Offset(text, 3)).toBe(2);
    // Inside the combining mark's bytes: clamp to its start.
    expect(byteOffsetToUtf16Offset(text, 2)).toBe(1);
  });

  it("diverges on CJK", () => {
    // Each character: 3 UTF-8 bytes, 1 UTF-16 code unit.
    const text = "\u6F22\u5B57a";
    expect(utf16OffsetToByteOffset(text, 1)).toBe(3);
    expect(utf16OffsetToByteOffset(text, 2)).toBe(6);
    expect(byteOffsetToUtf16Offset(text, 6)).toBe(2);
    // Inside a character's bytes: clamp to its start.
    expect(byteOffsetToUtf16Offset(text, 4)).toBe(1);
  });

  it("round-trips every character boundary", () => {
    const text = "a\u{1F600}\u6F22e\u0301\r\nb";
    let bytes = 0;
    let units = 0;
    for (const character of text) {
      expect(utf16OffsetToByteOffset(text, units)).toBe(bytes);
      expect(byteOffsetToUtf16Offset(text, bytes)).toBe(units);
      units += character.length;
      bytes += new TextEncoder().encode(character).length;
    }
    expect(utf16OffsetToByteOffset(text, units)).toBe(bytes);
    expect(byteOffsetToUtf16Offset(text, bytes)).toBe(units);
  });
});
