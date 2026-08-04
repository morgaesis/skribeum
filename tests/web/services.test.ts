// The typed wrappers over the search, settings and tree-refresh
// commands, exercised against a mocked IPC boundary (the generated
// bindings call the mocked `invoke`): payload shapes and error
// normalization to `IpcError`.

import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class {},
}));

import {
  settingsRead as browserSettingsRead,
  settingsWrite as browserSettingsWrite,
} from "../../demo/lib/ipc/services";
import { DEFAULT_SETTINGS } from "../../src/lib/features/settingsStore";
import {
  searchQuery,
  settingsPath,
  settingsRead,
  settingsWrite,
  tagCatalog,
  updateCheck,
  vaultTreeRefresh,
} from "../../src/lib/ipc/services";
import { IpcError } from "../../src/lib/ipc/vault";
import { defaultTaskStatuses } from "../../src/lib/taskStatuses";

describe("ipc service wrappers", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("passes the search payload and returns ranked results", async () => {
    const results = [
      {
        path: "a.md",
        title: "A",
        snippet: "s",
        match_ranges: [[0, 1]],
        score: 1,
      },
    ];
    invoke.mockResolvedValueOnce(results);
    const handle = { id: 3 };
    await expect(searchQuery(handle, "term", 25)).resolves.toEqual(results);
    expect(invoke).toHaveBeenCalledWith("search_query", {
      handle,
      query: "term",
      limit: 25,
      searchNoteBodies: true,
      caseSensitive: false,
    });
  });

  it("returns tag usage through the catalog command", async () => {
    const tags = [
      {
        tag: "project/alpha",
        note_count: 3,
        occurrence_count: 5,
      },
    ];
    invoke.mockResolvedValueOnce(tags);
    const handle = { id: 3 };
    await expect(tagCatalog(handle)).resolves.toEqual(tags);
    expect(invoke).toHaveBeenCalledWith("tag_catalog", { handle });
  });

  it("round-trips the settings document shape", async () => {
    const doc = {
      ...DEFAULT_SETTINGS,
      theme: "dark",
      light_palette: "studio",
      dark_palette: "graphite",
      editor_font_size: 17,
      search_result_limit: 40,
      link_previews: false,
      task_statuses: defaultTaskStatuses(),
    };
    invoke.mockResolvedValueOnce(doc);
    await expect(settingsRead()).resolves.toEqual(doc);
    expect(invoke).toHaveBeenCalledWith("settings_read");

    invoke.mockResolvedValueOnce(null);
    await settingsWrite(doc);
    expect(invoke).toHaveBeenCalledWith("settings_write", { doc });
  });

  it("persists the complete default document in the browser", async () => {
    localStorage.clear();
    await expect(
      browserSettingsWrite(DEFAULT_SETTINGS),
    ).resolves.toBeUndefined();
    expect(
      JSON.parse(localStorage.getItem("skribeum.demo.settings") ?? "null"),
    ).toEqual(DEFAULT_SETTINGS);
    await expect(browserSettingsRead()).resolves.toMatchObject({
      theme: "system",
      light_palette: "manuscript",
      dark_palette: "nightroom",
      prose_font: "serif",
    });
  });

  it("reads the resolved settings path", async () => {
    invoke.mockResolvedValueOnce("/config/settings.json");
    await expect(settingsPath()).resolves.toBe("/config/settings.json");
    expect(invoke).toHaveBeenCalledWith("settings_path");
  });

  it("checks the selected update channel", async () => {
    invoke.mockResolvedValueOnce({ kind: "current" });
    await expect(updateCheck("beta")).resolves.toEqual({ kind: "current" });
    expect(invoke).toHaveBeenCalledWith("update_check", { channel: "beta" });
  });

  it("refreshes the tree by handle", async () => {
    invoke.mockResolvedValueOnce([]);
    await expect(vaultTreeRefresh({ id: 1 })).resolves.toEqual([]);
    expect(invoke).toHaveBeenCalledWith("vault_tree_refresh", {
      handle: { id: 1 },
    });
  });

  it("normalizes AppError-shaped rejections to IpcError", async () => {
    invoke.mockRejectedValueOnce({
      code: "search/unavailable",
      message: "index not built",
      path: null,
    });
    await expect(searchQuery({ id: 1 }, "x", 1)).rejects.toBeInstanceOf(
      IpcError,
    );

    // Non-AppError failures pass through untouched.
    invoke.mockRejectedValueOnce(new Error("transport down"));
    await expect(settingsRead()).rejects.toThrow("transport down");
  });
});
