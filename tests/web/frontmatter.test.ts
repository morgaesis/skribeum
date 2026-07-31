// Criterion 10 (M2): typed frontmatter properties. The positional parser
// records the exact character range of every value, panel edits replace
// precisely that range through a normal editor transaction, and untouched
// keys are byte-preserved: the round-trip cases below drive an edit
// through a real EditorState change and compare every byte outside the
// declared range against the original.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  applyTypeOverrides,
  parseFrontmatter,
  parseObsidianTypes,
} from "../../src/lib/editor/frontmatter";

const corpusDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "corpus",
);

const corpusText = readFileSync(
  path.join(corpusDirectory, "frontmatter-duplicate-keys.md"),
  "utf8",
);

/** Applies a single range replacement through a real editor transaction. */
function applyEdit(
  text: string,
  from: number,
  to: number,
  insert: string,
): string {
  return EditorState.create({ doc: text })
    .update({ changes: { from, to, insert } })
    .state.doc.toString();
}

describe("frontmatter parsing", () => {
  it("preserves key order and duplicate keys over the corpus file", () => {
    const frontmatter = parseFrontmatter(corpusText);
    expect(frontmatter).not.toBeNull();
    expect(frontmatter?.entries.map((entry) => entry.key)).toEqual([
      "title",
      "title",
      "aliases",
      "tags",
      "author",
      "location",
      "summary",
      "rating",
      "published",
      "created",
      "weird spacing",
    ]);
  });

  it("every recorded range slices to exactly the raw value", () => {
    const frontmatter = parseFrontmatter(corpusText);
    expect(frontmatter).not.toBeNull();
    for (const entry of frontmatter?.entries ?? []) {
      expect(corpusText.slice(entry.keyFrom, entry.keyTo)).toBe(entry.key);
      expect(corpusText.slice(entry.valueFrom, entry.valueTo)).toBe(entry.raw);
      for (const item of entry.items ?? []) {
        expect(corpusText.slice(item.from, item.to)).toBe(item.raw);
      }
    }
  });

  it("types scalars from their values", () => {
    const frontmatter = parseFrontmatter(corpusText);
    const byKey = new Map(
      frontmatter?.entries.map((entry) => [entry.key, entry]) ?? [],
    );
    expect(byKey.get("rating")?.type).toBe("number");
    expect(byKey.get("published")?.type).toBe("boolean");
    expect(byKey.get("created")?.type).toBe("date");
    expect(byKey.get("author")?.type).toBe("text");
    expect(byKey.get("aliases")?.type).toBe("list");
    expect(byKey.get("aliases")?.items?.map((item) => item.raw)).toEqual([
      "fjörður-glósa",
      "café-notat",
    ]);
  });

  it("parses flow lists with item ranges", () => {
    const text = "---\ntags: [alpha, beta-two, gamma]\n---\nbody\n";
    const frontmatter = parseFrontmatter(text);
    const tags = frontmatter?.entries[0];
    expect(tags?.type).toBe("list");
    expect(tags?.items?.map((item) => item.raw)).toEqual([
      "alpha",
      "beta-two",
      "gamma",
    ]);
    for (const item of tags?.items ?? []) {
      expect(text.slice(item.from, item.to)).toBe(item.raw);
    }
  });

  it("returns null without a closed leading fence", () => {
    expect(parseFrontmatter("no frontmatter\n")).toBeNull();
    expect(parseFrontmatter("---\ntitle: unterminated\n")).toBeNull();
    expect(parseFrontmatter("\n---\ntitle: not leading\n---\n")).toBeNull();
  });
});

describe("frontmatter round-trip byte preservation", () => {
  function assertOnlyRangeChanged(
    original: string,
    edited: string,
    from: number,
    to: number,
    insert: string,
  ) {
    expect(edited.slice(0, from)).toBe(original.slice(0, from));
    expect(edited.slice(from, from + insert.length)).toBe(insert);
    expect(edited.slice(from + insert.length)).toBe(original.slice(to));
  }

  it("a number edit rewrites only the value's bytes", () => {
    const frontmatter = parseFrontmatter(corpusText);
    const rating = frontmatter?.entries.find((entry) => entry.key === "rating");
    expect(rating).toBeDefined();
    if (rating === undefined) {
      return;
    }
    const edited = applyEdit(corpusText, rating.valueFrom, rating.valueTo, "5");
    assertOnlyRangeChanged(
      corpusText,
      edited,
      rating.valueFrom,
      rating.valueTo,
      "5",
    );
    // The duplicate title keys, the oddly spaced key and every other line
    // survive byte-for-byte; the reparse sees the same key order.
    expect(edited).toContain(
      "weird spacing:    value with leading spaces preserved by some loaders",
    );
    expect(parseFrontmatter(edited)?.entries.map((entry) => entry.key)).toEqual(
      parseFrontmatter(corpusText)?.entries.map((entry) => entry.key),
    );
    expect(
      parseFrontmatter(edited)?.entries.find((entry) => entry.key === "rating")
        ?.raw,
    ).toBe("5");
  });

  it("a boolean edit rewrites only the value's bytes", () => {
    const frontmatter = parseFrontmatter(corpusText);
    const published = frontmatter?.entries.find(
      (entry) => entry.key === "published",
    );
    expect(published?.raw).toBe("false");
    if (published === undefined) {
      return;
    }
    const edited = applyEdit(
      corpusText,
      published.valueFrom,
      published.valueTo,
      "true",
    );
    assertOnlyRangeChanged(
      corpusText,
      edited,
      published.valueFrom,
      published.valueTo,
      "true",
    );
  });

  it("a list item edit rewrites only that item's bytes", () => {
    const frontmatter = parseFrontmatter(corpusText);
    const aliases = frontmatter?.entries.find(
      (entry) => entry.key === "aliases",
    );
    const second = aliases?.items?.[1];
    expect(second?.raw).toBe("café-notat");
    if (second === undefined) {
      return;
    }
    const edited = applyEdit(corpusText, second.from, second.to, "té-notat");
    assertOnlyRangeChanged(
      corpusText,
      edited,
      second.from,
      second.to,
      "té-notat",
    );
    expect(
      parseFrontmatter(edited)
        ?.entries.find((entry) => entry.key === "aliases")
        ?.items?.map((item) => item.raw),
    ).toEqual(["fjörður-glósa", "té-notat"]);
  });
});

describe("declared Obsidian property types (decision 101)", () => {
  it("maps types.json declarations onto panel types", () => {
    const overrides = parseObsidianTypes(
      JSON.stringify({
        types: {
          published: "checkbox",
          created: "datetime",
          aliases: "multitext",
          rating: "number",
          summary: "unknown-kind",
        },
      }),
    );
    expect(overrides).toEqual({
      published: "boolean",
      created: "date",
      aliases: "list",
      rating: "number",
    });
  });

  it("declared types win only when the value can edit as that type", () => {
    const text = "---\ncount: not-a-number\nflag: true\n---\n";
    const frontmatter = parseFrontmatter(text);
    expect(frontmatter).not.toBeNull();
    if (frontmatter === null) {
      return;
    }
    const applied = applyTypeOverrides(frontmatter, {
      count: "number",
      flag: "text",
    });
    // A declared number over a non-numeric value stays text.
    expect(applied.entries.find((entry) => entry.key === "count")?.type).toBe(
      "text",
    );
    // A declared text over a boolean is honored.
    expect(applied.entries.find((entry) => entry.key === "flag")?.type).toBe(
      "text",
    );
  });

  it("tolerates malformed types.json", () => {
    expect(parseObsidianTypes("not json")).toEqual({});
    expect(parseObsidianTypes("[]")).toEqual({});
  });
});
