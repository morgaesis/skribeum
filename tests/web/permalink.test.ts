// Stable note identity: id generation format, the fixed public URL, and
// the browser demo's id-to-path resolution (including the not-found
// fallback to normal landing rather than an error).

import { describe, expect, it } from "vitest";
import {
  generateNoteId,
  isNoteId,
  normalizeNoteIdScalar,
  noteIdFromContent,
  PERMALINK_ID_PARAMETER,
  PERMALINK_ORIGIN,
  permalinkUrlForId,
  resolveNoteId,
} from "../../src/lib/features/permalink";

describe("permalink id generation", () => {
  it("generates an 11-character base64url id from a random source", () => {
    const id = generateNoteId();
    expect(id).toHaveLength(11);
    expect(id).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(isNoteId(id)).toBe(true);
  });

  it("rejects shapes it would never itself produce", () => {
    expect(isNoteId("tooshort")).toBe(false);
    expect(isNoteId("has a space")).toBe(false);
    expect(isNoteId("has/aslash1")).toBe(false);
    expect(isNoteId("elevenchars0")).toBe(false);
  });

  it("does not repeat across a large sample", () => {
    const ids = new Set(Array.from({ length: 2000 }, () => generateNoteId()));
    expect(ids.size).toBe(2000);
  });
});

describe("permalink URL", () => {
  it("always resolves to the published origin regardless of caller", () => {
    expect(permalinkUrlForId("dQw4w9WgXcQ")).toBe(
      "https://skribeum.app/?n=dQw4w9WgXcQ",
    );
    expect(PERMALINK_ORIGIN).toBe("https://skribeum.app");
    expect(PERMALINK_ID_PARAMETER).toBe("n");
  });
});

describe("frontmatter id extraction", () => {
  it("reads an unquoted id property", () => {
    expect(
      noteIdFromContent("---\nid: dQw4w9WgXcQ\ntitle: Hi\n---\nBody"),
    ).toBe("dQw4w9WgXcQ");
  });

  it("unwraps a quoted id property", () => {
    expect(noteIdFromContent('---\nid: "dQw4w9WgXcQ"\n---\n')).toBe(
      "dQw4w9WgXcQ",
    );
    expect(noteIdFromContent("---\nid: 'dQw4w9WgXcQ'\n---\n")).toBe(
      "dQw4w9WgXcQ",
    );
  });

  it("normalizes a quoted scalar the same way the copy path does", () => {
    expect(normalizeNoteIdScalar('"dQw4w9WgXcQ"')).toBe("dQw4w9WgXcQ");
    expect(normalizeNoteIdScalar("'dQw4w9WgXcQ'")).toBe("dQw4w9WgXcQ");
    expect(normalizeNoteIdScalar("dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("returns null for a note without frontmatter or an id key", () => {
    expect(noteIdFromContent("# No frontmatter\n")).toBeNull();
    expect(noteIdFromContent("---\ntitle: Hi\n---\nBody")).toBeNull();
  });
});

describe("resolveNoteId", () => {
  const vault = new Map<string, string>([
    ["a.md", "---\ntitle: A\n---\n"],
    ["b.md", "---\nid: target-id0\n---\n"],
    ["c.md", "no frontmatter"],
  ]);
  const readNoteText = async (path: string) => {
    const text = vault.get(path);
    if (text === undefined) throw new Error("not found");
    return text;
  };

  it("resolves an id to its note path by scanning frontmatter", async () => {
    const resolved = await resolveNoteId(
      "target-id0",
      [...vault.keys()],
      readNoteText,
    );
    expect(resolved).toBe("b.md");
  });

  it("falls back to null (normal landing) when no note matches", async () => {
    const resolved = await resolveNoteId(
      "missing-id1",
      [...vault.keys()],
      readNoteText,
    );
    expect(resolved).toBeNull();
  });

  it("tolerates a reader that rejects for one path and still finds the match", async () => {
    const resolved = await resolveNoteId(
      "target-id0",
      ["missing.md", ...vault.keys()],
      readNoteText,
    );
    expect(resolved).toBe("b.md");
  });
});
