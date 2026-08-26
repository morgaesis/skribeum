// The fuzzy matcher behind the command surface and slash menu.

import { describe, expect, it } from "vitest";
import { settingSearchTerms } from "../../src/lib/features/settingsCatalog";
import {
  fuzzyMatch,
  matchesSearchTerms,
  segmentByPositions,
} from "../../src/lib/fuzzy";
import { STRINGS } from "../../src/lib/strings";

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

describe("settings search matching", () => {
  const label = STRINGS.settingsPalette;
  const description = STRINGS.settingsPaletteDescription;
  const terms = [
    ...settingSearchTerms("appearance.light-palette"),
    ...settingSearchTerms("appearance.dark-palette"),
  ];
  const matches = (query: string) =>
    matchesSearchTerms(query, label, description, terms);

  it("answers the words a reader uses for a setting the label never says", () => {
    // None of these three appears anywhere in "Colour palette" or its
    // description, and each is what a reader types to find it.
    expect(matches("theme")).toBe(true);
    expect(matches("color")).toBe(true);
    expect(matches("gazette")).toBe(true);
  });

  it("tolerates a typo in a naming word", () => {
    expect(matches("palete")).toBe(true);
    expect(
      matchesSearchTerms(
        "fnot size",
        STRINGS.settingsFontSize,
        STRINGS.settingsFontSizeDescription,
        settingSearchTerms("appearance.font-size"),
      ),
    ).toBe(true);
  });

  it("never treats the description's ordinary English as a near match", () => {
    // "theme" is one edit from "these"; a description full of common words
    // would otherwise make every short query a near miss for every setting.
    expect(
      matchesSearchTerms(
        "theme",
        STRINGS.settingsFile,
        "These preferences",
        [],
      ),
    ).toBe(false);
  });

  it("narrows on each further word rather than widening", () => {
    expect(matches("dark palette")).toBe(true);
    expect(matches("dark elephant")).toBe(false);
  });

  it("abbreviates only across word starts and runs", () => {
    expect(matchesSearchTerms("lw", "Line width", "", [])).toBe(true);
    expect(matchesSearchTerms("linewid", "Line width", "", [])).toBe(true);
    // `shone` is a subsequence of "Show line numbers" and two edits from
    // every word in it, so only plain subsequence matching would return it.
    // Each character has to start a word or continue a run, and the trailing
    // `e` does neither.
    expect(matchesSearchTerms("shone", "Show line numbers", "", [])).toBe(
      false,
    );
  });

  it("matches every setting on an empty query", () => {
    expect(matches("")).toBe(true);
    expect(matches("   ")).toBe(true);
  });
});
