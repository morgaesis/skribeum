import { describe, expect, it } from "vitest";
import {
  defaultWorkspaceState,
  loadWorkspaceState,
  normalizeWorkspaceState,
  remapWorkspacePath,
  removeWorkspacePath,
  saveWorkspaceState,
} from "../../src/lib/workspaceState";

describe("per-vault workspace state", () => {
  it("persists panel, tree, tab, split, and per-pane history state", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const state = defaultWorkspaceState();
    state.sidebarWidthRem = 21.5;
    state.sidebarCollapsed = true;
    state.outlineWidthRem = 18;
    state.expandedFolders = ["Projects", "Projects/Active"];
    state.selectedPath = "Projects/Active/one.md";
    state.panes = [
      {
        id: "pane-1",
        tabs: [
          { path: "one.md", viewState: null },
          { path: "two.md", viewState: null },
        ],
        activePath: "two.md",
        history: [
          { address: { path: "one.md" }, viewState: null },
          { address: { path: "two.md", fragment: "Details" }, viewState: null },
        ],
        historyIndex: 1,
      },
      {
        id: "pane-2",
        tabs: [{ path: "three.md", viewState: null }],
        activePath: "three.md",
        history: [{ address: { path: "three.md" }, viewState: null }],
        historyIndex: 0,
      },
    ];
    state.focusedPaneId = "pane-2";
    state.splitRatio = 0.62;

    saveWorkspaceState("vault-a", state, storage);
    expect(loadWorkspaceState("vault-a", storage)).toEqual(state);
    expect(loadWorkspaceState("vault-b", storage)).toEqual(
      defaultWorkspaceState(),
    );
  });

  it("clamps corrupt persisted geometry and discards invalid panes", () => {
    const state = normalizeWorkspaceState({
      sidebarWidthRem: 99,
      outlineWidthRem: -4,
      splitRatio: 0.99,
      panes: [{ id: "pane-1", tabs: [{ path: "" }] }],
      focusedPaneId: "missing",
    });
    expect(state.sidebarWidthRem).toBe(24);
    expect(state.outlineWidthRem).toBe(12);
    expect(state.splitRatio).toBe(0.8);
    expect(state.panes).toHaveLength(1);
    expect(state.focusedPaneId).toBe("pane-1");
  });

  it("reconciles tree moves and deletions across tabs and pane histories", () => {
    const state = defaultWorkspaceState();
    state.expandedFolders = ["Projects", "Projects/Active"];
    state.selectedPath = "Projects/Active/one.md";
    state.panes[0] = {
      id: "pane-1",
      tabs: [
        { path: "Projects/Active/one.md", viewState: null },
        { path: "keep.md", viewState: null },
      ],
      activePath: "Projects/Active/one.md",
      history: [
        {
          address: { path: "Projects/Active/one.md", fragment: "Detail" },
          viewState: null,
        },
      ],
      historyIndex: 0,
    };

    const moved = remapWorkspacePath(state, "Projects", "Archive/Projects");
    expect(moved.selectedPath).toBe("Archive/Projects/Active/one.md");
    expect(moved.panes[0]?.activePath).toBe("Archive/Projects/Active/one.md");
    expect(moved.panes[0]?.history[0]?.address).toEqual({
      path: "Archive/Projects/Active/one.md",
      fragment: "Detail",
    });

    const removed = removeWorkspacePath(moved, "Archive");
    expect(removed.selectedPath).toBeNull();
    expect(removed.panes[0]?.tabs.map((tab) => tab.path)).toEqual(["keep.md"]);
    expect(removed.panes[0]?.activePath).toBe("keep.md");
    expect(removed.panes[0]?.history).toEqual([]);
  });
});
