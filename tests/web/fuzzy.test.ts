// The fuzzy matcher behind the command surface and slash menu.

import { describe, expect, it } from "vitest";
import { fuzzyMatch, segmentByPositions } from "../../src/lib/fuzzy";

describe("fuzzy matching", () => {
  it("matches subsequences case-insensitively", () => {
    expect(fuzzyMatch("tbl", "Table: insert row below")).not.toBeNull();
    expect(fuzzyMatch("XYZ", "Table")).toBeNull();
    expect(fuzzyMatch("HEAD", "heading 1")).not.toBeNull();
  });

  it("matches everything on an empty query", () => {
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, positions: [] });
  });

  it("matches multi-word queries exactly (boundary greed regression)", () => {
    // The boundary-preferring pass alone jumps to the second word's `o`
    // and then cannot find `g`; the exact title must still match.
    const match = fuzzyMatch("toggle outline", "Toggle outline");
    expect(match).not.toBeNull();
    expect(match?.positions).toEqual([...Array(14).keys()]);
    expect(fuzzyMatch("insert row", "Table: insert row below")).not.toBeNull();
  });

  it("ranks word-boundary and consecutive hits above scattered ones", () => {
    const boundary = fuzzyMatch("qs", "quick switcher");
    const scattered = fuzzyMatch("qs", "aqbsc words");
    expect(boundary).not.toBeNull();
    expect(scattered).not.toBeNull();
    expect(boundary?.score ?? 0).toBeGreaterThan(scattered?.score ?? 0);
    const consecutive = fuzzyMatch("head", "heading");
    const spread = fuzzyMatch("head", "h e a d longer");
    expect(consecutive?.score ?? 0).toBeGreaterThan(spread?.score ?? 0);
  });

  it("prefers shorter candidates at equal quality", () => {
    const short = fuzzyMatch("note", "note.md");
    const long = fuzzyMatch("note", "note-with-a-much-longer-name.md");
    expect(short?.score ?? 0).toBeGreaterThan(long?.score ?? 0);
  });

  it("reports matched positions usable for highlighting", () => {
    const match = fuzzyMatch("qsw", "quick switcher");
    expect(match).not.toBeNull();
    const positions = match?.positions ?? [];
    expect(positions).toHaveLength(3);
    expect(positions.map((p) => "quick switcher"[p]).join("")).toBe("qsw");
  });
});

describe("segmenting by positions", () => {
  it("splits into plain and highlighted runs preserving all text", () => {
    const segments = segmentByPositions("abcdef", [1, 2, 4]);
    expect(segments.map((segment) => segment.text).join("")).toBe("abcdef");
    expect(segments).toEqual([
      { text: "a", highlighted: false },
      { text: "bc", highlighted: true },
      { text: "d", highlighted: false },
      { text: "e", highlighted: true },
      { text: "f", highlighted: false },
    ]);
  });

  it("handles empty input", () => {
    expect(segmentByPositions("", [])).toEqual([]);
  });
});
