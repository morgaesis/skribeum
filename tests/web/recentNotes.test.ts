import { describe, expect, it } from "vitest";
import {
  RECENT_NOTES_LIMIT,
  rankByModifiedTime,
  selectRecentPaths,
} from "../../src/lib/features/recentNotes";

describe("selectRecentPaths", () => {
  it("prefers the vault's recorded open history, most recent first", () => {
    const result = selectRecentPaths(
      ["b.md", "a.md", "c.md"],
      ["a.md", "b.md", "c.md", "d.md"],
      new Set(),
      ["d.md", "c.md"],
    );
    expect(result).toEqual(["b.md", "a.md", "c.md"]);
  });

  it("excludes notes already open in a tab in this window", () => {
    const result = selectRecentPaths(
      ["b.md", "a.md", "c.md"],
      ["a.md", "b.md", "c.md"],
      new Set(["b.md"]),
      [],
    );
    expect(result).toEqual(["a.md", "c.md"]);
  });

  it("drops history entries for paths the vault no longer has", () => {
    const result = selectRecentPaths(
      ["removed.md", "a.md"],
      ["a.md"],
      new Set(),
      [],
    );
    expect(result).toEqual(["a.md"]);
  });

  it("caps at five rows", () => {
    const recentlyOpened = ["a", "b", "c", "d", "e", "f", "g"];
    const result = selectRecentPaths(
      recentlyOpened,
      recentlyOpened,
      new Set(),
      [],
    );
    expect(result).toHaveLength(RECENT_NOTES_LIMIT);
    expect(result).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("falls back to file-modification order when the history record is empty", () => {
    const result = selectRecentPaths([], ["a.md", "b.md", "c.md"], new Set(), [
      "c.md",
      "b.md",
      "a.md",
    ]);
    expect(result).toEqual(["c.md", "b.md", "a.md"]);
  });

  it("falls back when every recorded entry was filtered out, not only when the record itself is empty", () => {
    const result = selectRecentPaths(
      ["already-open.md"],
      ["already-open.md", "other.md"],
      new Set(["already-open.md"]),
      ["other.md"],
    );
    expect(result).toEqual(["other.md"]);
  });

  it("never renders an empty Recent section for a vault that has notes", () => {
    const result = selectRecentPaths([], ["only.md"], new Set(), ["only.md"]);
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("rankByModifiedTime", () => {
  it("ranks by modification time, most recent first", async () => {
    const stats: Record<string, number> = {
      "old.md": 1000,
      "new.md": 3000,
      "middle.md": 2000,
    };
    const result = await rankByModifiedTime(
      Object.keys(stats),
      async (path) => stats[path] ?? null,
    );
    expect(result).toEqual(["new.md", "middle.md", "old.md"]);
  });

  it("drops paths whose stat fails or reports no modification time", async () => {
    const result = await rankByModifiedTime(
      ["a.md", "b.md", "c.md"],
      async (path) => {
        if (path === "a.md") return 100;
        if (path === "b.md") throw new Error("stat failed");
        return null;
      },
    );
    expect(result).toEqual(["a.md"]);
  });

  it("stats in bounded batches without dropping any candidate", async () => {
    const paths = Array.from({ length: 40 }, (_, index) => `note-${index}.md`);
    let concurrentCalls = 0;
    let maxConcurrent = 0;
    const result = await rankByModifiedTime(
      paths,
      async (path) => {
        concurrentCalls += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
        await Promise.resolve();
        concurrentCalls -= 1;
        return Number(path.replace(/\D/g, ""));
      },
      8,
    );
    expect(result).toHaveLength(paths.length);
    expect(maxConcurrent).toBeLessThanOrEqual(8);
    expect(result[0]).toBe("note-39.md");
    expect(result.at(-1)).toBe("note-0.md");
  });
});
