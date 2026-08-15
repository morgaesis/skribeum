import { describe, expect, it } from "vitest";
import {
  defaultWorkspaceState,
  emptyPane,
  findWorkspaceLeaf,
  flattenWorkspaceLayout,
  loadWorkspaceState,
  MAX_LEAF_PANES,
  minimumNodeExtentRem,
  nextPaneId,
  normalizeWorkspaceState,
  remapWorkspacePath,
  removeWorkspaceLeaf,
  removeWorkspacePath,
  saveWorkspaceState,
  splitWorkspaceLeaf,
  type VaultWorkspaceState,
  type WorkspaceLeaf,
  type WorkspaceNode,
  workspaceLeaves,
} from "../../src/lib/workspaceState";

function leaf(id: string, paths: string[]): WorkspaceLeaf {
  return {
    type: "leaf",
    id,
    tabs: paths.map((path) => ({ path, viewState: null })),
    activePath: paths[0] ?? null,
    history: paths.map((path) => ({ address: { path }, viewState: null })),
    historyIndex: paths.length - 1,
  };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

/** Builds a tree of `count` leaves by splitting the last one repeatedly. */
function chain(count: number): WorkspaceNode {
  let layout: WorkspaceNode = leaf("pane-1", ["note-1.md"]);
  for (let index = 2; index <= count; index += 1) {
    const previous = workspaceLeaves(layout).at(-1);
    if (previous === undefined) break;
    layout = splitWorkspaceLeaf(
      layout,
      previous.id,
      "right",
      leaf(`pane-${index}`, [`note-${index}.md`]),
    );
  }
  return layout;
}

describe("per-vault workspace state", () => {
  it("persists panel, tree, tab, split-tree, and per-pane history state", () => {
    const storage = memoryStorage();
    const state = defaultWorkspaceState();
    state.sidebarWidthRem = 21.5;
    state.sidebarCollapsed = true;
    state.outlineWidthRem = 18;
    state.expandedFolders = ["Projects", "Projects/Active"];
    state.selectedPath = "Projects/Active/one.md";
    state.layout = {
      type: "split",
      axis: "row",
      ratio: 0.62,
      children: [
        {
          type: "leaf",
          id: "pane-1",
          tabs: [
            { path: "one.md", viewState: null },
            { path: "two.md", viewState: null },
          ],
          activePath: "two.md",
          history: [
            { address: { path: "one.md" }, viewState: null },
            {
              address: { path: "two.md", fragment: "Details" },
              viewState: null,
            },
          ],
          historyIndex: 1,
        },
        {
          type: "split",
          axis: "column",
          ratio: 0.4,
          children: [leaf("pane-2", ["three.md"]), leaf("pane-3", ["four.md"])],
        },
      ],
    };
    state.focusedPaneId = "pane-3";

    saveWorkspaceState("vault-a", state, storage);
    expect(loadWorkspaceState("vault-a", storage)).toEqual(state);
    expect(loadWorkspaceState("vault-b", storage)).toEqual(
      defaultWorkspaceState(),
    );
  });

  it("migrates the earlier two-pane document into one row split", () => {
    const storage = memoryStorage();
    const legacy = {
      version: 1,
      sidebarWidthRem: 16,
      sidebarCollapsed: false,
      outlineWidthRem: 15,
      outlineCollapsed: true,
      splitRatio: 0.62,
      expandedFolders: ["Projects"],
      selectedPath: "one.md",
      panes: [
        {
          id: "pane-1",
          tabs: [
            { path: "one.md", viewState: null },
            { path: "two.md", viewState: null },
          ],
          activePath: "two.md",
          history: [{ address: { path: "one.md" }, viewState: null }],
          historyIndex: 0,
        },
        {
          id: "pane-2",
          tabs: [{ path: "three.md", viewState: null }],
          activePath: "three.md",
          history: [{ address: { path: "three.md" }, viewState: null }],
          historyIndex: 0,
        },
      ],
      focusedPaneId: "pane-2",
      closedTabs: [{ path: "gone.md", viewState: null }],
    };
    // The earlier document lives under its own key; loading finds it when no
    // current document exists.
    storage.values.set(
      `skribeum.workspace.v1.${loadWorkspaceKeySuffix("vault-legacy")}`,
      JSON.stringify(legacy),
    );

    const migrated = loadWorkspaceState("vault-legacy", storage);
    expect(migrated.version).toBe(2);
    expect(migrated.layout.type).toBe("split");
    if (migrated.layout.type !== "split") return;
    expect(migrated.layout.axis).toBe("row");
    expect(migrated.layout.ratio).toBeCloseTo(0.62);
    expect(workspaceLeaves(migrated.layout).map((pane) => pane.id)).toEqual([
      "pane-1",
      "pane-2",
    ]);
    expect(
      workspaceLeaves(migrated.layout).map((pane) =>
        pane.tabs.map((tab) => tab.path),
      ),
    ).toEqual([["one.md", "two.md"], ["three.md"]]);
    expect(migrated.focusedPaneId).toBe("pane-2");
    expect(migrated.closedTabs.map((tab) => tab.path)).toEqual(["gone.md"]);
    expect(migrated.selectedPath).toBe("one.md");
  });

  it("migrates a single-pane document into a bare leaf", () => {
    const migrated = normalizeWorkspaceState({
      version: 1,
      splitRatio: 0.5,
      panes: [
        { id: "pane-1", tabs: [{ path: "one.md" }], activePath: "one.md" },
      ],
      focusedPaneId: "pane-1",
    });
    expect(migrated.layout.type).toBe("leaf");
    expect(workspaceLeaves(migrated.layout)).toHaveLength(1);
  });

  it("clamps corrupt persisted geometry and repairs a corrupt tree", () => {
    const state = normalizeWorkspaceState({
      sidebarWidthRem: 99,
      outlineWidthRem: -4,
      layout: {
        type: "split",
        axis: "sideways",
        ratio: 40,
        children: [
          { id: "pane-1", tabs: [{ path: "" }] },
          { type: "split", axis: "column", children: [null, null] },
        ],
      },
      focusedPaneId: "missing",
    });
    expect(state.sidebarWidthRem).toBe(24);
    expect(state.outlineWidthRem).toBe(12);
    // Both children reduce to nothing usable, so the tree flattens to one
    // empty pane rather than carrying a split with a missing child.
    expect(state.layout.type).toBe("leaf");
    expect(state.focusedPaneId).toBe("pane-1");
  });

  it("gives every pane a unique identifier", () => {
    const state = normalizeWorkspaceState({
      layout: {
        type: "split",
        axis: "row",
        ratio: 0.5,
        children: [
          { id: "pane-1", tabs: [{ path: "one.md" }] },
          { id: "pane-1", tabs: [{ path: "two.md" }] },
        ],
      },
    });
    const ids = workspaceLeaves(state.layout).map((pane) => pane.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("enforces the eight-leaf cap without losing tabs", () => {
    const state = normalizeWorkspaceState({
      layout: chain(MAX_LEAF_PANES + 3),
    });
    const leaves = workspaceLeaves(state.layout);
    expect(leaves).toHaveLength(MAX_LEAF_PANES);
    const paths = leaves.flatMap((pane) => pane.tabs.map((tab) => tab.path));
    expect(paths).toHaveLength(MAX_LEAF_PANES + 3);
    expect(paths).toContain(`note-${MAX_LEAF_PANES + 3}.md`);
  });
});

describe("split tree operations", () => {
  it("splits a leaf on each side with the requested axis and order", () => {
    const base = leaf("pane-1", ["one.md"]);
    const addition = leaf("pane-2", ["two.md"]);

    const right = splitWorkspaceLeaf(base, "pane-1", "right", addition);
    expect(right.type).toBe("split");
    if (right.type !== "split") return;
    expect(right.axis).toBe("row");
    expect(workspaceLeaves(right).map((pane) => pane.id)).toEqual([
      "pane-1",
      "pane-2",
    ]);

    const above = splitWorkspaceLeaf(base, "pane-1", "up", addition);
    expect(above.type).toBe("split");
    if (above.type !== "split") return;
    expect(above.axis).toBe("column");
    expect(workspaceLeaves(above).map((pane) => pane.id)).toEqual([
      "pane-2",
      "pane-1",
    ]);
  });

  it("splits a nested leaf without disturbing its siblings", () => {
    const layout = splitWorkspaceLeaf(
      splitWorkspaceLeaf(
        leaf("pane-1", ["one.md"]),
        "pane-1",
        "right",
        leaf("pane-2", ["two.md"]),
      ),
      "pane-2",
      "down",
      leaf("pane-3", ["three.md"]),
    );
    expect(workspaceLeaves(layout).map((pane) => pane.id)).toEqual([
      "pane-1",
      "pane-2",
      "pane-3",
    ]);
    expect(layout.type === "split" && layout.children[1]?.type).toBe("split");
  });

  it("collapses a removed leaf into its sibling with no single-child split", () => {
    const layout = splitWorkspaceLeaf(
      splitWorkspaceLeaf(
        leaf("pane-1", ["one.md"]),
        "pane-1",
        "right",
        leaf("pane-2", ["two.md"]),
      ),
      "pane-2",
      "down",
      leaf("pane-3", ["three.md"]),
    );

    const withoutThree = removeWorkspaceLeaf(layout, "pane-3");
    expect(withoutThree).not.toBeNull();
    if (withoutThree === null) return;
    expect(workspaceLeaves(withoutThree).map((pane) => pane.id)).toEqual([
      "pane-1",
      "pane-2",
    ]);
    expect(withoutThree.type).toBe("split");

    const withoutTwo = removeWorkspaceLeaf(withoutThree, "pane-2");
    expect(withoutTwo?.type).toBe("leaf");
    expect(removeWorkspaceLeaf(leaf("pane-1", []), "pane-1")).toBeNull();
  });

  it("finds leaves, allocates fresh identifiers, and flattens in tree order", () => {
    const layout = chain(3);
    expect(findWorkspaceLeaf(layout, "pane-2")?.id).toBe("pane-2");
    expect(findWorkspaceLeaf(layout, "pane-9")).toBeNull();
    expect(nextPaneId(layout)).toBe("pane-4");

    const flattened = flattenWorkspaceLayout(layout);
    expect(flattened.type).toBe("leaf");
    expect(flattened.tabs.map((tab) => tab.path)).toEqual([
      "note-1.md",
      "note-2.md",
      "note-3.md",
    ]);
  });

  it("sums minimum extents along a split's own axis and maxes across it", () => {
    const row = splitWorkspaceLeaf(
      leaf("pane-1", []),
      "pane-1",
      "right",
      leaf("pane-2", []),
    );
    expect(minimumNodeExtentRem(row, "row")).toBe(40);
    expect(minimumNodeExtentRem(row, "column")).toBe(12);

    const nested = splitWorkspaceLeaf(
      row,
      "pane-2",
      "down",
      leaf("pane-3", []),
    );
    expect(minimumNodeExtentRem(nested, "row")).toBe(40);
    expect(minimumNodeExtentRem(nested, "column")).toBe(24);
  });
});

describe("path reconciliation across the tree", () => {
  function threePaneState(): VaultWorkspaceState {
    const state = defaultWorkspaceState();
    state.expandedFolders = ["Projects", "Projects/Active"];
    state.selectedPath = "Projects/Active/one.md";
    state.layout = splitWorkspaceLeaf(
      splitWorkspaceLeaf(
        leaf("pane-1", ["Projects/Active/one.md", "keep.md"]),
        "pane-1",
        "right",
        leaf("pane-2", ["Projects/Active/two.md"]),
      ),
      "pane-2",
      "down",
      leaf("pane-3", ["elsewhere.md"]),
    );
    return state;
  }

  it("remaps every tab, active path, and history entry in every pane", () => {
    const moved = remapWorkspacePath(
      threePaneState(),
      "Projects",
      "Archive/Projects",
    );
    expect(moved.selectedPath).toBe("Archive/Projects/Active/one.md");
    const panes = workspaceLeaves(moved.layout);
    expect(panes[0]?.activePath).toBe("Archive/Projects/Active/one.md");
    expect(panes[0]?.history[0]?.address.path).toBe(
      "Archive/Projects/Active/one.md",
    );
    expect(panes[1]?.tabs.map((tab) => tab.path)).toEqual([
      "Archive/Projects/Active/two.md",
    ]);
    expect(panes[2]?.tabs.map((tab) => tab.path)).toEqual(["elsewhere.md"]);
  });

  it("removes deleted paths and collapses the panes they emptied", () => {
    const removed = removeWorkspacePath(threePaneState(), "Projects");
    const panes = workspaceLeaves(removed.layout);
    expect(panes.map((pane) => pane.id)).toEqual(["pane-1", "pane-3"]);
    expect(panes[0]?.tabs.map((tab) => tab.path)).toEqual(["keep.md"]);
    expect(panes[0]?.activePath).toBe("keep.md");
    expect(panes[0]?.history.map((entry) => entry.address.path)).toEqual([
      "keep.md",
    ]);
    expect(removed.selectedPath).toBeNull();
  });

  it("keeps one empty pane when a deletion empties the whole tree", () => {
    const state = defaultWorkspaceState();
    state.layout = leaf("pane-1", ["Projects/one.md"]);
    const removed = removeWorkspacePath(state, "Projects");
    expect(workspaceLeaves(removed.layout)).toHaveLength(1);
    expect(removed.layout).toEqual(
      expect.objectContaining({ type: "leaf", tabs: [], activePath: null }),
    );
    expect(emptyPane("pane-1").tabs).toEqual([]);
  });
});

/** Mirrors the module's own vault-key hash so the migration test can seed it. */
function loadWorkspaceKeySuffix(vaultIdentity: string): string {
  let hash = 2_166_136_261;
  for (const character of vaultIdentity.normalize("NFC")) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16);
}
