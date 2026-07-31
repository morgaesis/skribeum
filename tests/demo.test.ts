import { beforeEach, describe, expect, it } from "vitest";
import {
  searchQuery,
  settingsRead,
  settingsWrite,
  vaultTreeRefresh,
} from "../demo/lib/ipc/services";
import {
  noteWrite,
  openVault,
  readNote,
  readVaultFile,
  vaultTree,
  watchSubscribe,
} from "../demo/lib/ipc/vault";

describe("browser demo IPC", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("opens the seeded vault and indexes its nested content", async () => {
    const handle = await openVault("ignored-in-browser");
    const tree = await vaultTree(handle);

    expect(tree.filter((entry) => entry.kind === "note")).toHaveLength(25);
    expect(tree).toContainEqual({
      path: "Features",
      kind: "directory",
      hidden: false,
    });
    expect(tree).toContainEqual({
      path: "demo.canvas",
      kind: "file",
      hidden: false,
    });
    await expect(vaultTreeRefresh(handle)).resolves.toEqual(tree);
    await expect(watchSubscribe(handle)).resolves.toBeUndefined();
  });

  it("reads Markdown notes and render-only vault files", async () => {
    const handle = await openVault("demo");
    const note = await readNote(handle, "quickstart.md");
    const canvas = await readVaultFile(handle, "demo.canvas");

    expect(note.text).toContain("# Quickstart");
    expect(note.meta.byte_length).toBe(note.bytes.byteLength);
    expect(note.meta.projection_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(new TextDecoder().decode(canvas))).toHaveProperty(
      "nodes",
    );
  });

  it("applies note edits to memory without touching the seed source", async () => {
    const handle = await openVault("demo");
    const before = await readNote(handle, "about.md");
    const addition = "\n\nA temporary browser note.";
    const result = await noteWrite(
      handle,
      "about.md",
      [
        {
          start: before.bytes.byteLength,
          end: before.bytes.byteLength,
          bytes: Array.from(new TextEncoder().encode(addition)),
        },
      ],
      before.meta.projection_hash,
    );

    expect(result.result).toBe("written");
    const after = await readNote(handle, "about.md");
    expect(after.text).toBe(`${before.text}${addition}`);
    expect(after.meta.projection_hash).not.toBe(before.meta.projection_hash);
  });

  it("performs lexical search and ranks earlier body matches first", async () => {
    const handle = await openVault("demo");
    const results = await searchQuery(handle, "cedar", 50);

    expect(results.length).toBeGreaterThan(2);
    expect(results.every((result) => result.match_ranges.length > 0)).toBe(
      true,
    );
    const positions = await Promise.all(
      results.map(async (result) =>
        (await readNote(handle, result.path)).text
          .toLocaleLowerCase()
          .indexOf("cedar"),
      ),
    );
    expect(positions).toEqual(
      [...positions].sort((left, right) => left - right),
    );
    await expect(searchQuery(handle, "cedar", 2)).resolves.toHaveLength(2);
    await expect(searchQuery(handle, "", 50)).resolves.toEqual([]);
  });

  it("persists settings through local storage", async () => {
    await expect(settingsRead()).resolves.toEqual({
      schema_version: 1,
      theme: "system",
      editor_font_size: 15,
      search_result_limit: 50,
    });

    const settings = {
      schema_version: 1,
      theme: "dark",
      editor_font_size: 18,
      search_result_limit: 24,
    };
    await settingsWrite(settings);
    await expect(settingsRead()).resolves.toEqual(settings);
    expect(localStorage.getItem("skribeum.demo.settings")).toBe(
      JSON.stringify(settings),
    );
  });

  it("defaults invalid stored settings and rejects invalid writes", async () => {
    localStorage.setItem(
      "skribeum.demo.settings",
      JSON.stringify({
        schema_version: 1,
        theme: "neon",
        editor_font_size: Number.POSITIVE_INFINITY,
        search_result_limit: 0,
      }),
    );

    await expect(settingsRead()).resolves.toEqual({
      schema_version: 1,
      theme: "system",
      editor_font_size: 15,
      search_result_limit: 50,
    });
    await expect(
      settingsWrite({
        schema_version: 1,
        theme: "system",
        editor_font_size: 15,
        search_result_limit: 1001,
      }),
    ).rejects.toThrow("search_result_limit");
  });
});
