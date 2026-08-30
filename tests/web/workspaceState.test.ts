import { describe, expect, it } from "vitest";
import {
  clearWorkspacePreviewReplacement,
  currentWorkspaceNavigationPane,
  defaultWorkspaceState,
  emptyPane,
  findWorkspaceLeaf,
  flattenWorkspaceLayout,
  loadWorkspaceState,
  MAX_LEAF_PANES,
  minimumNodeExtentRem,
  nextPaneId,
  normalizeWorkspaceState,
  openInTemporaryWorkspaceSplit,
  reconcilePreviewReplacementAfterNavigation,
  reconcilePreviewReplacementAfterTabRemoval,
  remapWorkspacePath,
  removeWorkspaceLeaf,
  removeWorkspacePath,
  saveWorkspaceState,
  settleTemporaryWorkspacePaneNavigation,
  splitWorkspaceLeaf,
  TemporaryWorkspacePaneTransition,
  type VaultWorkspaceState,
  type WorkspaceLeaf,
  type WorkspaceNode,
  workspaceLeaves,
  workspacePaneOwnsActivePath,
  workspacePathOpenPaneId,
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
  it("resolves explicit and ordinary opens to their intended panes", () => {
    const layout = splitWorkspaceLeaf(
      leaf("pane-1", ["already-open.md"]),
      "pane-1",
      "right",
      leaf("pane-2", ["destination.md"]),
    );

    expect(
      workspacePathOpenPaneId(
        layout,
        "pane-2",
        "already-open.md",
        "focused-pane",
      ),
    ).toBe("pane-2");
    expect(
      workspacePathOpenPaneId(
        layout,
        "pane-2",
        "already-open.md",
        "existing-pane",
      ),
    ).toBe("pane-1");
  });

  it("clears pane and path preview state at a workspace replacement", () => {
    const oldWorkspacePreview = {
      paneId: "pane-1",
      path: "old-vault/preview.md",
      tab: { path: "old-vault/displaced.md", viewState: null },
      index: 0,
    };

    const replacement = clearWorkspacePreviewReplacement(oldWorkspacePreview);
    const promotable =
      replacement?.paneId === "pane-1" ? replacement.tab : null;

    expect(replacement).toBeNull();
    expect(promotable).toBeNull();
  });

  it("cannot promote a displaced tab after its preview tab closes", () => {
    const replacement = {
      paneId: "pane-1",
      path: "preview.md",
      tab: { path: "displaced.md", viewState: null },
      index: 0,
    };

    const reconciled = reconcilePreviewReplacementAfterTabRemoval(
      replacement,
      "pane-1",
      "preview.md",
    );
    const promoted =
      reconciled?.paneId === "pane-1" && reconciled.path === "preview.md"
        ? reconciled.tab
        : null;

    expect(reconciled).toBeNull();
    expect(promoted).toBeNull();
    expect(
      reconcilePreviewReplacementAfterTabRemoval(
        replacement,
        "pane-1",
        "displaced.md",
      ),
    ).toBeNull();
  });

  it("retains a displaced tab when its replacement navigation fails", () => {
    const replacement = {
      paneId: "pane-1",
      path: "preview-b.md",
      tab: { path: "original-a.md", viewState: null },
      index: 0,
    };

    expect(
      reconcilePreviewReplacementAfterNavigation(replacement, {
        path: "failed-c.md",
        intent: "in-place",
        outcome: "failed",
      }),
    ).toBe(replacement);
    expect(
      reconcilePreviewReplacementAfterNavigation(replacement, {
        path: "replacement-c.md",
        intent: "in-place",
        outcome: "committed",
      }),
    ).toBeNull();
    expect(
      reconcilePreviewReplacementAfterNavigation(replacement, {
        path: "preview-b.md",
        intent: "new-tab",
        outcome: "committed",
      }),
    ).toBe(replacement);
  });

  it("rolls back a temporary split when focus transfer fails", async () => {
    let layout: WorkspaceNode = leaf("pane-1", ["existing.md"]);
    const baseline = structuredClone(layout);
    let opened = false;
    let focusedPaneId = "pane-1";
    const transition = new TemporaryWorkspacePaneTransition(
      "pane-2",
      "dropped.md",
      "pane-1",
      "pane-1",
    );

    const outcome = await openInTemporaryWorkspaceSplit({
      currentLayout: () => layout,
      setLayout: (next) => (layout = next),
      targetPaneId: "pane-1",
      side: "right",
      addition: emptyPane("pane-2"),
      transition,
      focusAddition: async () => false,
      open: async () => {
        opened = true;
        return true;
      },
      currentFocusedPaneId: () => focusedPaneId,
      restoreFocus: async (paneId) => {
        focusedPaneId = paneId;
      },
    });

    expect(outcome).toBe("failed");
    expect(opened).toBe(false);
    expect(focusedPaneId).toBe("pane-1");
    expect(transition.phase).toBe("rolled-back");
    expect(layout).toEqual(baseline);
  });

  it("removes a failed temporary leaf without changing existing tabs", async () => {
    let layout: WorkspaceNode = leaf("pane-1", ["one.md", "two.md"]);
    const baseline = structuredClone(layout);
    let focusedPaneId = "pane-1";
    const transition = new TemporaryWorkspacePaneTransition(
      "pane-2",
      "missing.md",
      "pane-1",
      "pane-1",
    );

    const outcome = await openInTemporaryWorkspaceSplit({
      currentLayout: () => layout,
      setLayout: (next) => (layout = next),
      targetPaneId: "pane-1",
      side: "left",
      addition: emptyPane("pane-2"),
      transition,
      focusAddition: async () => {
        focusedPaneId = "pane-2";
        return true;
      },
      open: async () => false,
      currentFocusedPaneId: () => focusedPaneId,
      restoreFocus: async (paneId) => {
        focusedPaneId = paneId;
      },
    });

    expect(outcome).toBe("failed");
    expect(focusedPaneId).toBe("pane-1");
    expect(layout).toEqual(baseline);
    expect(workspaceLeaves(layout)[0]?.tabs.map((tab) => tab.path)).toEqual([
      "one.md",
      "two.md",
    ]);
  });

  it("rolls back a missing dropped path before the new pane owns a tab", async () => {
    let layout: WorkspaceNode = emptyPane("pane-1");
    const baseline = structuredClone(layout);
    const created = emptyPane("pane-2");
    let focusedPaneId = "pane-1";
    const transition = new TemporaryWorkspacePaneTransition(
      created.id,
      "vanished.md",
      "pane-1",
      "pane-1",
    );

    const outcome = await openInTemporaryWorkspaceSplit({
      currentLayout: () => layout,
      setLayout: (next) => (layout = next),
      targetPaneId: "pane-1",
      side: "right",
      addition: created,
      transition,
      focusAddition: async () => {
        focusedPaneId = created.id;
        return true;
      },
      // Ordinary navigation accepts a missing surface, but the transition
      // still rejects it because the destination owns no active tab.
      open: async () => true,
      currentFocusedPaneId: () => focusedPaneId,
      restoreFocus: async (paneId) => {
        focusedPaneId = paneId;
      },
    });

    expect(outcome).toBe("failed");
    expect(focusedPaneId).toBe("pane-1");
    expect(layout).toEqual(baseline);
    expect(workspaceLeaves(layout)[0]?.activePath).toBeNull();
    expect(workspaceLeaves(layout)[0]?.tabs).toEqual([]);
  });

  it("preserves newer surviving focus when a bound load is cancelled", async () => {
    let layout: WorkspaceNode = splitWorkspaceLeaf(
      leaf("pane-1", ["existing.md"]),
      "pane-1",
      "right",
      leaf("pane-3", ["newer-focus.md"]),
    );
    const baseline = structuredClone(layout);
    const created = emptyPane("pane-2");
    let focusedPaneId = "pane-1";
    const load = Promise.withResolvers<void>();
    const loadStarted = Promise.withResolvers<void>();
    const transition = new TemporaryWorkspacePaneTransition(
      created.id,
      "delayed.md",
      "pane-1",
      "pane-1",
    );

    const opening = openInTemporaryWorkspaceSplit({
      currentLayout: () => layout,
      setLayout: (next) => (layout = next),
      targetPaneId: "pane-1",
      side: "right",
      addition: created,
      transition,
      focusAddition: async () => {
        focusedPaneId = created.id;
        return true;
      },
      open: async () => {
        loadStarted.resolve();
        await load.promise;
        const destination = currentWorkspaceNavigationPane(
          layout,
          focusedPaneId,
          created.id,
        );
        if (destination === null) return false;
        destination.tabs.push({ path: "delayed.md", viewState: null });
        destination.activePath = "delayed.md";
        return workspacePaneOwnsActivePath(layout, created.id, "delayed.md");
      },
      currentFocusedPaneId: () => focusedPaneId,
      restoreFocus: async (paneId) => {
        focusedPaneId = paneId;
      },
    });

    await loadStarted.promise;
    focusedPaneId = "pane-3";
    load.resolve();

    expect(await opening).toBe("failed");
    expect(focusedPaneId).toBe("pane-3");
    expect(layout).toEqual(baseline);
    expect(
      workspaceLeaves(layout).find((pane) => pane.id === "pane-3")?.activePath,
    ).toBe("newer-focus.md");
  });

  it("keeps a temporary leaf claimed by a later successful navigation", async () => {
    let layout: WorkspaceNode = splitWorkspaceLeaf(
      leaf("pane-1", ["existing.md"]),
      "pane-1",
      "right",
      leaf("pane-3", ["moved.md"]),
    );
    let restoreCount = 0;
    let focusedPaneId = "pane-1";
    const originalOpen = Promise.withResolvers<boolean>();
    const openStarted = Promise.withResolvers<void>();
    const transition = new TemporaryWorkspacePaneTransition(
      "pane-2",
      "original-drop.md",
      "pane-1",
      "pane-1",
    );

    const opening = openInTemporaryWorkspaceSplit({
      currentLayout: () => layout,
      setLayout: (next) => (layout = next),
      targetPaneId: "pane-1",
      side: "right",
      addition: emptyPane("pane-2"),
      transition,
      focusAddition: async () => {
        focusedPaneId = "pane-2";
        return true;
      },
      open: async () => {
        openStarted.resolve();
        return originalOpen.promise;
      },
      currentFocusedPaneId: () => focusedPaneId,
      restoreFocus: async (paneId) => {
        restoreCount += 1;
        focusedPaneId = paneId;
      },
    });

    await openStarted.promise;
    const claimed = findWorkspaceLeaf(layout, "pane-2");
    if (claimed === null) throw new Error("temporary pane was not created");
    const claim = transition.claimNavigation();
    if (claim === null) throw new Error("temporary pane was not claimable");
    claimed.tabs.push({ path: "later.md", viewState: null });
    claimed.activePath = "later.md";
    const newerOutcome = await settleTemporaryWorkspacePaneNavigation({
      currentLayout: () => layout,
      setLayout: (next) => (layout = next),
      transition,
      claim,
      opened: true,
      currentFocusedPaneId: () => focusedPaneId,
      restoreFocus: async (paneId) => {
        restoreCount += 1;
        focusedPaneId = paneId;
      },
    });
    originalOpen.resolve(false);

    expect(newerOutcome).toBe("committed");
    expect(await opening).toBe("superseded");
    expect(restoreCount).toBe(0);
    expect(findWorkspaceLeaf(layout, "pane-2")).toBe(claimed);
    expect(claimed.activePath).toBe("later.md");
    expect(transition.phase).toBe("committed");
  });

  it("rolls back once when the claiming navigation also fails", async () => {
    let layout: WorkspaceNode = leaf("pane-1", ["existing.md"]);
    const baseline = structuredClone(layout);
    let focusedPaneId = "pane-1";
    let restoreCount = 0;
    const originalOpen = Promise.withResolvers<boolean>();
    const openStarted = Promise.withResolvers<void>();
    const transition = new TemporaryWorkspacePaneTransition(
      "pane-2",
      "original-drop.md",
      "pane-1",
      "pane-1",
    );

    const opening = openInTemporaryWorkspaceSplit({
      currentLayout: () => layout,
      setLayout: (next) => (layout = next),
      targetPaneId: "pane-1",
      side: "right",
      addition: emptyPane("pane-2"),
      transition,
      focusAddition: async () => {
        focusedPaneId = "pane-2";
        return true;
      },
      open: async () => {
        openStarted.resolve();
        return originalOpen.promise;
      },
      currentFocusedPaneId: () => focusedPaneId,
      restoreFocus: async (paneId) => {
        restoreCount += 1;
        focusedPaneId = paneId;
      },
    });

    await openStarted.promise;
    const claim = transition.claimNavigation();
    if (claim === null) throw new Error("temporary pane was not claimable");
    originalOpen.resolve(false);

    expect(await opening).toBe("superseded");
    expect(findWorkspaceLeaf(layout, "pane-2")).not.toBeNull();

    const newerOutcome = await settleTemporaryWorkspacePaneNavigation({
      currentLayout: () => layout,
      setLayout: (next) => (layout = next),
      transition,
      claim,
      opened: false,
      currentFocusedPaneId: () => focusedPaneId,
      restoreFocus: async (paneId) => {
        restoreCount += 1;
        focusedPaneId = paneId;
      },
    });

    expect(newerOutcome).toBe("failed");
    expect(layout).toEqual(baseline);
    expect(focusedPaneId).toBe("pane-1");
    expect(restoreCount).toBe(1);
    expect(transition.phase).toBe("rolled-back");
  });

  it("commits only when the temporary pane owns the requested active tab", async () => {
    let layout: WorkspaceNode = leaf("pane-1", ["existing.md"]);
    const created = emptyPane("pane-2");
    const transition = new TemporaryWorkspacePaneTransition(
      created.id,
      "dropped.md",
      "pane-1",
      "pane-1",
    );

    const outcome = await openInTemporaryWorkspaceSplit({
      currentLayout: () => layout,
      setLayout: (next) => (layout = next),
      targetPaneId: "pane-1",
      side: "right",
      addition: created,
      transition,
      focusAddition: async () => true,
      open: async () => {
        created.tabs.push({ path: "dropped.md", viewState: null });
        created.activePath = "dropped.md";
        return true;
      },
      currentFocusedPaneId: () => created.id,
      restoreFocus: async () => {},
    });

    expect(outcome).toBe("committed");
    expect(transition.phase).toBe("committed");
    expect(workspacePaneOwnsActivePath(layout, created.id, "dropped.md")).toBe(
      true,
    );
  });

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
    // One storage area per vault holds one session; the shape is versioned
    // inside the document, so an earlier document is found and migrated.
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

  it("reconciles a selection that sits inside a folder outside the expanded set", () => {
    // The record that traps the shell: the note is open, its folder is the
    // one folder missing from the expanded set, and nothing in the product
    // could put the folder back.
    const state = normalizeWorkspaceState({
      expandedFolders: ["Examples", "Examples/Home"],
      selectedPath: "Examples/Research/literature-review.md",
    });
    expect(state.expandedFolders).toEqual([
      "Examples",
      "Examples/Home",
      "Examples/Research",
    ]);
    expect(state.selectedPath).toBe("Examples/Research/literature-review.md");
  });

  it("heals the trapped record on the read that finds it", () => {
    const storage = memoryStorage();
    storage.values.set(
      `skribeum.workspace.v1.${loadWorkspaceKeySuffix("vault-trap")}`,
      JSON.stringify({
        version: 2,
        expandedFolders: ["Examples", "Examples/Home"],
        selectedPath: "Examples/Research/literature-review.md",
      }),
    );

    const restored = loadWorkspaceState("vault-trap", storage);
    expect(restored.expandedFolders).toContain("Examples/Research");

    // And the healed record is what the next write leaves behind, so the
    // trap does not come back on the visit after that.
    saveWorkspaceState("vault-trap", restored, storage);
    expect(loadWorkspaceState("vault-trap", storage).expandedFolders).toContain(
      "Examples/Research",
    );
  });

  it("adds no ancestors for a selection at the vault root", () => {
    const state = normalizeWorkspaceState({
      expandedFolders: ["Examples"],
      selectedPath: "quickstart.md",
    });
    expect(state.expandedFolders).toEqual(["Examples"]);
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

describe("cross-version persistence", () => {
  it("writes a flat pane projection an earlier version can still read", () => {
    const storage = memoryStorage();
    const state = defaultWorkspaceState();
    state.layout = {
      type: "split",
      axis: "row",
      ratio: 0.62,
      children: [
        leaf("pane-1", ["one.md", "two.md"]),
        leaf("pane-2", ["three.md"]),
      ],
    };
    state.focusedPaneId = "pane-2";
    saveWorkspaceState("vault-a", state, storage);

    const written = JSON.parse(
      storage.values.get(
        `skribeum.workspace.v1.${loadWorkspaceKeySuffix("vault-a")}`,
      ) ?? "null",
    ) as {
      version: number;
      layout: unknown;
      panes: Array<{ tabs: Array<{ path: string }>; activePath: string }>;
      splitRatio: number;
      focusedPaneId: string;
    };
    expect(written.version).toBe(2);
    expect(written.layout).toBeDefined();
    // A plain two-pane row projects faithfully, ratio and all.
    expect(
      written.panes.map((pane) => pane.tabs.map((tab) => tab.path)),
    ).toEqual([["one.md", "two.md"], ["three.md"]]);
    expect(written.panes.map((pane) => pane.activePath)).toEqual([
      "one.md",
      "three.md",
    ]);
    expect(written.splitRatio).toBeCloseTo(0.62);
    expect(written.focusedPaneId).toBe("pane-2");
  });

  it("flattens a deeper tree into the projection without dropping a tab", () => {
    const storage = memoryStorage();
    const state = defaultWorkspaceState();
    state.layout = chain(4);
    saveWorkspaceState("vault-b", state, storage);

    const written = JSON.parse(
      storage.values.get(
        `skribeum.workspace.v1.${loadWorkspaceKeySuffix("vault-b")}`,
      ) ?? "null",
    ) as { panes: Array<{ tabs: Array<{ path: string }> }> };
    expect(written.panes).toHaveLength(1);
    expect(written.panes[0]?.tabs.map((tab) => tab.path)).toEqual([
      "note-1.md",
      "note-2.md",
      "note-3.md",
      "note-4.md",
    ]);
  });

  it("prefers the tree over its own projection when reading back", () => {
    const storage = memoryStorage();
    const state = defaultWorkspaceState();
    state.layout = chain(3);
    state.focusedPaneId = "pane-3";
    saveWorkspaceState("vault-c", state, storage);

    const restored = loadWorkspaceState("vault-c", storage);
    expect(workspaceLeaves(restored.layout).map((pane) => pane.id)).toEqual([
      "pane-1",
      "pane-2",
      "pane-3",
    ]);
    expect(restored.focusedPaneId).toBe("pane-3");
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
