// Section 4.16 statusline facts: word and character counting, the
// last-edited formatting contract (relative at minute granularity within
// seven days, the absolute date past that), the selection form of the
// word count, and the registered command coverage.

import { describe, expect, it } from "vitest";
import { createAppRegistry } from "../../src/lib/features";
import {
  ADD_PROPERTY_COMMAND,
  countCharacters,
  countWords,
  formatLastEdited,
  formatLineColumn,
  formatWordCount,
  NOTE_STATISTICS_COMMAND,
} from "../../src/lib/features/noteStatistics";

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("word and character counting", () => {
  it("counts whitespace-delimited words", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   \n\t ")).toBe(0);
    expect(countWords("one")).toBe(1);
    expect(countWords("one two\nthree\tfour")).toBe(4);
    expect(countWords("  café über naïve  ")).toBe(3);
  });

  it("counts characters in code points", () => {
    expect(countCharacters("")).toBe(0);
    expect(countCharacters("abc")).toBe(3);
    expect(countCharacters("a🧭b")).toBe(3);
  });
});

describe("last-edited formatting (section 4.16)", () => {
  it("reads as just-now under a minute", () => {
    expect(formatLastEdited(NOW - 20_000, NOW)).toBe("Edited just now");
  });

  it("is relative at minute granularity inside seven days", () => {
    expect(formatLastEdited(NOW - 4 * MINUTE, NOW)).toBe(
      "Edited 4 minutes ago",
    );
    expect(formatLastEdited(NOW - 3 * HOUR, NOW)).toBe("Edited 3 hours ago");
    expect(formatLastEdited(NOW - 2 * DAY, NOW)).toBe("Edited 2 days ago");
  });

  it("switches to the absolute date past seven days", () => {
    const formatted = formatLastEdited(NOW - 8 * DAY, NOW);
    expect(formatted.startsWith("Edited ")).toBe(true);
    expect(formatted).not.toContain("ago");
    expect(formatted).toMatch(/\d{4}/);
  });
});

describe("word-count segment forms", () => {
  it("formats the plain count with a singular form", () => {
    expect(formatWordCount(0, 0)).toBe("0 words");
    expect(formatWordCount(1, 0)).toBe("1 word");
    expect(formatWordCount(4210, 0)).toBe("4,210 words");
  });

  it("folds in a non-empty selection", () => {
    expect(formatWordCount(4210, 132)).toBe("132 of 4,210 words");
  });

  it("formats the source-mode line and column segment", () => {
    expect(formatLineColumn(12, 8)).toBe("Ln 12, Col 8");
  });
});

describe("registered commands", () => {
  it("registers note statistics and add property with palette routes", () => {
    const registry = createAppRegistry();
    const statistics = registry.command(NOTE_STATISTICS_COMMAND);
    const addProperty = registry.command(ADD_PROPERTY_COMMAND);
    expect(statistics?.title).toBe("Note statistics");
    expect(addProperty?.title).toBe("Note: add property");
  });
});
