// Picker item building: the quick-switcher ranking (recent notes first),
// search-result rows built as text segments with byte-offset match
// ranges (no markup injection anywhere on the path), and the first-match
// extraction used to open a result at its match.

import { describe, expect, it } from "vitest";
import { createAppRegistry } from "../../src/lib/features";
import {
  appendBareDiscoveryItems,
  commandItems,
  fileItems,
  firstMatchText,
  parsePickerQuery,
  searchResultItems,
  segmentByCharRanges,
  tagItems,
} from "../../src/lib/features/pickers";
import { byteRangesToCharRanges } from "../../src/lib/ipc/services";
import type { CommandContext } from "../../src/lib/registry";

const PATHS = [
  "notes/alpha.md",
  "notes/beta.md",
  "journal/2026-01-01.md",
  "beta-plan.md",
];

describe("unified command surface modes", () => {
  it("parses ordinary prefixes and returns to file mode without one", () => {
    expect(parsePickerQuery("notes")).toEqual({ mode: "file", query: "notes" });
    expect(parsePickerQuery(">copy")).toEqual({
      mode: "command",
      query: "copy",
    });
    expect(parsePickerQuery("#work")).toEqual({ mode: "tag", query: "work" });
    expect(parsePickerQuery("?cedar")).toEqual({
      mode: "text",
      query: "cedar",
    });
  });

  it("groups open notes, recents, and the rest of the vault", () => {
    const items = fileItems(
      PATHS,
      ["journal/2026-01-01.md", "notes/beta.md"],
      ["notes/alpha.md"],
      "",
    );
    expect(items.map((item) => item.value)).toEqual([
      "notes/alpha.md",
      "journal/2026-01-01.md",
      "notes/beta.md",
      "beta-plan.md",
    ]);
    expect(items.map((item) => item.group)).toEqual([
      "Open notes",
      "Recent",
      "Recent",
      "Vault",
    ]);
  });

  it("ignores recents that left the vault", () => {
    const items = fileItems(PATHS, ["gone.md"], [], "");
    expect(items.map((item) => item.value)).not.toContain("gone.md");
  });

  it("fuzzy-filters within groups and offers note-text search", () => {
    const items = fileItems(PATHS, ["notes/beta.md"], [], "beta");
    expect(items[0]?.value).toBe("notes/beta.md");
    expect(items.map((item) => item.value)).toContain("beta-plan.md");
    expect(items.map((item) => item.value)).not.toContain("notes/alpha.md");
    expect(items.at(-1)?.id).toBe("text-search:beta");
  });

  it("returns highlight segments that reassemble the path", () => {
    const items = fileItems(PATHS, [], [], "alpha");
    const first = items[0];
    expect(first?.value).toBe("notes/alpha.md");
    expect(first?.titleSegments.map((segment) => segment.text).join("")).toBe(
      "alpha",
    );
    expect(first?.titleSegments.some((segment) => segment.highlighted)).toBe(
      true,
    );
  });

  it("searches setting descriptions without blending other modes", () => {
    const items = commandItems(createAppRegistry(), "line width", false);
    expect(items[0]?.value).toBe("setting.appearance.line-width");
    expect(new Set(items.map((item) => item.kind))).toEqual(
      new Set(["command"]),
    );
    expect(items[0]?.actionKind).toBe("setting");
  });

  it("lists application zoom as capability-disabled in the browser", () => {
    const registry = createAppRegistry();
    const context = {} as CommandContext;
    const items = commandItems(registry, "Zoom", false, context).filter(
      (item) => item.value.startsWith("application.zoom-"),
    );
    expect(items).toHaveLength(3);
    expect(
      items.every((item) => item.disabledReason?.includes("desktop")),
    ).toBe(true);
    expect(registry.run("application.zoom-in", context)).toBe(false);
  });

  it("builds only tag rows in tag mode", () => {
    const items = tagItems(
      [{ tag: "project/work", noteCount: 2, occurrenceCount: 4 }],
      "work",
    );
    expect(items.map((item) => [item.kind, item.value])).toEqual([
      ["tag", "project/work"],
    ]);
  });

  it("appends bounded discovery groups to a non-empty bare query", () => {
    const items = appendBareDiscoveryItems(
      fileItems(PATHS, [], [], "line"),
      commandItems(createAppRegistry(), "line", false),
      tagItems(
        [{ tag: "line-work", noteCount: 1, occurrenceCount: 1 }],
        "line",
      ),
      "line",
    );
    const commandRows = items.filter(
      (item) => item.group === "Commands and settings",
    );
    const tagRows = items.filter((item) => item.group === "Tags");
    expect(commandRows).toHaveLength(3);
    expect(commandRows.every((item) => item.kind === "command")).toBe(true);
    expect(commandRows.every((item) => item.prefixHint === ">")).toBe(true);
    expect(tagRows).toHaveLength(1);
    expect(tagRows[0]).toMatchObject({ kind: "tag", prefixHint: "#" });
    expect(items.at(-1)?.id).toBe("text-search:line");
    expect(items.at(-1)?.group).toBeUndefined();
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
