import { describe, expect, it } from "vitest";
import {
  resolveNoteTitle,
  resolveTitleCollisions,
} from "../../src/lib/noteTitles";

describe("note display titles", () => {
  it("prefers a non-empty frontmatter title over a first-line heading and file name", () => {
    expect(
      resolveNoteTitle({
        path: "notes/file-name.md",
        source: "---\ntitle: Authored title\n---\n# Heading title\n",
      }),
    ).toEqual({ displayTitle: "Authored title", fileName: "file-name" });
  });

  it("uses an ATX or setext H1 only when it starts the note", () => {
    expect(
      resolveNoteTitle({ path: "atx.md", source: "# First heading ###\nBody" })
        .displayTitle,
    ).toBe("First heading");
    expect(
      resolveNoteTitle({ path: "setext.md", source: "Setext title\n===\n" })
        .displayTitle,
    ).toBe("Setext title");
    expect(
      resolveNoteTitle({ path: "fallback.md", source: "Body\n# Later" })
        .displayTitle,
    ).toBe("fallback");
  });

  it("falls back from empty and non-string title values to the file name", () => {
    expect(
      resolveNoteTitle({
        path: "folder/trimmed.md",
        source: '---\ntitle: ""\n---\n',
      }).displayTitle,
    ).toBe("trimmed");
    expect(
      resolveNoteTitle({
        path: "folder/numeric.md",
        source: "---\ntitle: 42\n---\n",
      }).displayTitle,
    ).toBe("numeric");
    for (const value of ["null", "~", "{ nested: value }"]) {
      expect(
        resolveNoteTitle({
          path: "folder/non-string.md",
          source: `---\ntitle: ${value}\n---\n`,
        }).displayTitle,
      ).toBe("non-string");
    }
    for (const value of [
      "42 # count",
      "true # flag",
      "1e3",
      "0x2a",
      "0o52",
      ".inf",
      ".nan",
      "+42",
    ]) {
      expect(
        resolveNoteTitle({
          path: "folder/commented-non-string.md",
          source: `---\ntitle: ${value}\n---\n`,
        }).displayTitle,
      ).toBe("commented-non-string");
    }
    expect(
      resolveNoteTitle({
        path: "tagged-string.md",
        source: "---\ntitle: !!str 42\n---\n",
      }).displayTitle,
    ).toBe("42");
    for (const value of ["1_000", "0x2_a", "-0x2a", "+.nan"]) {
      expect(
        resolveNoteTitle({
          path: "core-string.md",
          source: `---\ntitle: ${value}\n---\n`,
        }).displayTitle,
      ).toBe(value);
    }
    for (const value of [
      "nUlL",
      "tRuE",
      "0O7",
      "0X3A",
      ".iNf",
      ".nAn",
      "2031-04-05",
    ]) {
      expect(
        resolveNoteTitle({
          path: "core-case-string.md",
          source: `---\ntitle: ${value}\n---\n`,
        }).displayTitle,
      ).toBe(value);
    }
  });

  it("parses comments and block strings as YAML title values", () => {
    expect(
      resolveNoteTitle({
        path: "comment.md",
        source: "---\ntitle: Authored title # explanation\n---\n",
      }).displayTitle,
    ).toBe("Authored title");
    expect(
      resolveNoteTitle({
        path: "block.md",
        source: "---\ntitle: >\n  A folded\n  title\n---\n",
      }).displayTitle,
    ).toBe("A folded title");
    expect(
      resolveNoteTitle({
        path: "indent-first.md",
        source: "---\ntitle: |2-\n  Indented title\n---\n",
      }).displayTitle,
    ).toBe("Indented title");
    expect(
      resolveNoteTitle({
        path: "escaped.md",
        source: '---\ntitle: "Authored\\x20title"\n---\n',
      }).displayTitle,
    ).toBe("Authored title");
  });

  it("resolves frontmatter titles from CRLF source", () => {
    expect(
      resolveNoteTitle({
        path: "crlf.md",
        source: "---\r\ntitle: CRLF title\r\n---\r\n",
      }).displayTitle,
    ).toBe("CRLF title");
  });

  it("does not treat indented code as a setext title", () => {
    expect(
      resolveNoteTitle({
        path: "indented-code.md",
        source: "    Indented code\n===\n",
      }).displayTitle,
    ).toBe("indented-code");
  });

  it.each<{ name: string; path: string; source: string; expected: string }>([
    {
      name: "file name only, no heading and no frontmatter",
      path: "notes/plain.md",
      source: "Just a paragraph, nothing else.",
      expected: "plain",
    },
    {
      name: "heading only, differs from the file name",
      path: "notes/file-name.md",
      source: "# A Totally Different Heading\nBody text.",
      expected: "A Totally Different Heading",
    },
    {
      name: "heading matches the file name",
      path: "notes/matching-title.md",
      source: "# matching-title\n",
      expected: "matching-title",
    },
    {
      name: "frontmatter title and heading both present and differ: frontmatter wins",
      path: "notes/frontmatter-wins.md",
      source: "---\ntitle: Frontmatter Wins\n---\n# Inline Heading\n",
      expected: "Frontmatter Wins",
    },
    {
      name: "frontmatter present, no title key, heading follows immediately: heading wins over file name",
      path: "notes/heading-after-frontmatter.md",
      source: "---\ntags:\n  - demo\n---\n# Heading After Frontmatter\n",
      expected: "Heading After Frontmatter",
    },
    {
      name: "frontmatter present with neither a title key nor a following heading: falls back to file name",
      path: "notes/frontmatter-only.md",
      source: "---\ntags:\n  - demo\n---\nJust a paragraph.",
      expected: "frontmatter-only",
    },
    {
      name: "setext H1 after frontmatter with no title key",
      path: "notes/setext-after-frontmatter.md",
      source: "---\ntags:\n  - demo\n---\nSetext Heading\n===\n",
      expected: "Setext Heading",
    },
    {
      name: "empty ATX heading: falls back to file name",
      path: "notes/empty-heading.md",
      source: "#   \nBody text.",
      expected: "empty-heading",
    },
    {
      name: "heading present but not on the first content line: falls back to file name",
      path: "notes/heading-not-first.md",
      source: "An intro paragraph.\n\n# Heading Not On Line One\n",
      expected: "heading-not-first",
    },
    {
      name: "heading not on the first content line after frontmatter (blank line separates): falls back to file name",
      path: "notes/heading-not-first-after-frontmatter.md",
      source: "---\ntags:\n  - demo\n---\n\n# Heading After A Blank Line\n",
      expected: "heading-not-first-after-frontmatter",
    },
    {
      name: "CRLF line endings: frontmatter title still resolves",
      path: "notes/crlf-title.md",
      source: "---\r\ntitle: CRLF Title\r\n---\r\n# Ignored Heading\r\n",
      expected: "CRLF Title",
    },
    {
      name: "CRLF line endings: heading after frontmatter with no title key resolves",
      path: "notes/crlf-heading.md",
      source: "---\r\ntags:\r\n  - demo\r\n---\r\n# CRLF Heading\r\n",
      expected: "CRLF Heading",
    },
  ])("title precedence: $name", ({ path, source, expected }) => {
    expect(resolveNoteTitle({ path, source }).displayTitle).toBe(expected);
  });

  it("adds each file name only when titles collide in the presented group", () => {
    expect(
      resolveTitleCollisions([
        { path: "one.md", source: "# Shared\n" },
        { path: "two.md", source: "---\ntitle: Shared\n---\n" },
        { path: "three.md", source: "# Distinct\n" },
      ]),
    ).toEqual([
      { displayTitle: "Shared", fileName: "one", collisionSuffix: "one" },
      { displayTitle: "Shared", fileName: "two", collisionSuffix: "two" },
      { displayTitle: "Distinct", fileName: "three" },
    ]);
  });
});
