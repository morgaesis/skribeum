// Picker item building: the quick-switcher ranking (recent notes first),
// search-result rows built as text segments with byte-offset match
// ranges (no markup injection anywhere on the path), and the first-match
// extraction used to open a result at its match.

import { describe, expect, it } from "vitest";
import {
  firstMatchText,
  quickSwitcherItems,
  searchResultItems,
  segmentByCharRanges,
} from "../../src/lib/features/pickers";
import { byteRangesToCharRanges } from "../../src/lib/ipc/services";

const PATHS = [
  "notes/alpha.md",
  "notes/beta.md",
  "journal/2026-01-01.md",
  "beta-plan.md",
];

describe("quick switcher ranking", () => {
  it("lists recents first on an empty query, then the rest sorted", () => {
    const items = quickSwitcherItems(
      PATHS,
      ["journal/2026-01-01.md", "notes/beta.md"],
      "",
    );
    expect(items.map((item) => item.id)).toEqual([
      "journal/2026-01-01.md",
      "notes/beta.md",
      "beta-plan.md",
      "notes/alpha.md",
    ]);
  });

  it("ignores recents that left the vault", () => {
    const items = quickSwitcherItems(PATHS, ["gone.md"], "");
    expect(items.map((item) => item.id)).not.toContain("gone.md");
  });

  it("fuzzy-filters with a recency bonus on ties", () => {
    const items = quickSwitcherItems(PATHS, ["notes/beta.md"], "beta");
    expect(items[0]?.id).toBe("notes/beta.md");
    expect(items.map((item) => item.id)).toContain("beta-plan.md");
    expect(items.map((item) => item.id)).not.toContain("notes/alpha.md");
  });

  it("returns highlight segments that reassemble the path", () => {
    const items = quickSwitcherItems(PATHS, [], "alpha");
    const first = items[0];
    expect(first?.id).toBe("notes/alpha.md");
    expect(first?.titleSegments.map((segment) => segment.text).join("")).toBe(
      "notes/alpha.md",
    );
    expect(first?.titleSegments.some((segment) => segment.highlighted)).toBe(
      true,
    );
  });
});

describe("byte-range conversion", () => {
  it("is the identity over ASCII", () => {
    expect(
      byteRangesToCharRanges("hello world", [
        [0, 5],
        [6, 11],
      ]),
    ).toEqual([
      [0, 5],
      [6, 11],
    ]);
  });

  it("converts across multi-byte characters", () => {
    // "café " is 6 UTF-8 bytes for 5 characters; a match on "test"
    // starting at byte 6 starts at character 5.
    expect(byteRangesToCharRanges("café test", [[6, 10]])).toEqual([[5, 9]]);
    // Astral-plane emoji: 4 bytes, 2 UTF-16 units.
    expect(byteRangesToCharRanges("🙂 ok", [[5, 7]])).toEqual([[3, 5]]);
  });

  it("clamps out-of-range and boundary-splitting offsets", () => {
    expect(byteRangesToCharRanges("café", [[0, 999]])).toEqual([[0, 4]]);
    // Byte 4 splits the é sequence: clamp to the previous boundary.
    expect(byteRangesToCharRanges("café", [[3, 4]])).toEqual([[3, 3]]);
  });
});

describe("search result rows", () => {
  const result = {
    path: "notes/alpha.md",
    title: "Alpha",
    snippet: "café body with match here",
    match_ranges: [[16, 21]] as [number, number][],
    score: 7.5,
  };

  it("builds snippet segments as text runs, never markup", () => {
    const items = searchResultItems([result]);
    const detail = items[0]?.detailSegments ?? [];
    expect(detail.map((segment) => segment.text).join("")).toBe(result.snippet);
    const highlighted = detail
      .filter((segment) => segment.highlighted)
      .map((segment) => segment.text)
      .join("");
    expect(highlighted).toBe("match");
    // No segment carries markup characters that were not in the source.
    for (const segment of detail) {
      expect(result.snippet).toContain(segment.text);
    }
  });

  it("falls back to the path when the title is empty", () => {
    const items = searchResultItems([{ ...result, title: "" }]);
    expect(
      items[0]?.titleSegments.map((segment) => segment.text).join(""),
    ).toBe("notes/alpha.md");
  });

  it("extracts the first match text for open-at-match", () => {
    expect(firstMatchText(result)).toBe("match");
    expect(firstMatchText({ ...result, match_ranges: [] })).toBeNull();
  });
});

describe("segmenting by character ranges", () => {
  it("merges overlapping ranges and preserves the text", () => {
    const segments = segmentByCharRanges("abcdef", [
      [1, 3],
      [2, 4],
    ]);
    expect(segments.map((segment) => segment.text).join("")).toBe("abcdef");
    expect(segments).toEqual([
      { text: "a", highlighted: false },
      { text: "bcd", highlighted: true },
      { text: "ef", highlighted: false },
    ]);
  });
});
