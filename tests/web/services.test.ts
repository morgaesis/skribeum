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
  searchQuery,
  settingsRead,
  settingsWrite,
  vaultTreeRefresh,
} from "../../src/lib/ipc/services";
import { IpcError } from "../../src/lib/ipc/vault";

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
    });
  });

  it("round-trips the settings document shape", async () => {
    const doc = {
      schema_version: 1,
      theme: "dark",
      editor_font_size: 17,
      search_result_limit: 40,
    };
    invoke.mockResolvedValueOnce(doc);
    await expect(settingsRead()).resolves.toEqual(doc);
    expect(invoke).toHaveBeenCalledWith("settings_read");

    invoke.mockResolvedValueOnce(null);
    await settingsWrite(doc);
    expect(invoke).toHaveBeenCalledWith("settings_write", { doc });
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
