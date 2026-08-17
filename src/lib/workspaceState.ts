import type { NoteAddress, NoteViewState } from "./features/navigation";

export const SIDEBAR_MIN_REM = 12;
export const SIDEBAR_MAX_REM = 24;
export const SIDEBAR_DEFAULT_REM = 16;
export const OUTLINE_MIN_REM = 12;
export const OUTLINE_MAX_REM = 20;
export const OUTLINE_DEFAULT_REM = 15;
/** Width floor for one leaf pane: the prose measure needs the harder floor. */
export const SPLIT_MIN_REM = 20;
/** Height floor for one leaf pane: a note scrolls instead of reflowing. */
export const SPLIT_MIN_HEIGHT_REM = 12;
/** Guard rail on the tree, the focus search, and the persisted shape. */
export const MAX_LEAF_PANES = 8;

export type WorkspaceTab = {
  path: string;
  viewState: NoteViewState | null;
  /** Transient editor state. Omitted from persisted workspace documents. */
  dirty?: boolean;
};

export type WorkspaceHistoryEntry = {
  address: NoteAddress;
  viewState: NoteViewState | null;
};

/** One pane: its own tab strip, editor, and navigation history. */
export type WorkspaceLeaf = {
  type: "leaf";
  id: string;
  tabs: WorkspaceTab[];
  activePath: string | null;
  history: WorkspaceHistoryEntry[];
  historyIndex: number;
  /**
   * Transient: an empty focused tab opened from the strip's "+" control,
   * filled by the next open-in-place route. Never persisted, because a
   * blank tab has nothing to restore.
   */
  emptyTab?: boolean;
};

/** Two child nodes side by side (`row`) or stacked (`column`). */
export type WorkspaceSplit = {
  type: "split";
  axis: "row" | "column";
  ratio: number;
  children: [WorkspaceNode, WorkspaceNode];
};

export type WorkspaceNode = WorkspaceLeaf | WorkspaceSplit;

/** Where a new pane lands relative to the pane being split. */
export type SplitSide = "up" | "down" | "left" | "right";

export type VaultWorkspaceState = {
  version: 2;
  sidebarWidthRem: number;
  sidebarCollapsed: boolean;
  outlineWidthRem: number;
  outlineCollapsed: boolean;
  expandedFolders: string[];
  selectedPath: string | null;
  layout: WorkspaceNode;
  focusedPaneId: string;
  closedTabs: WorkspaceTab[];
};

export function emptyPane(id: string): WorkspaceLeaf {
  return {
    type: "leaf",
    id,
    tabs: [],
    activePath: null,
    history: [],
    historyIndex: -1,
  };
}

export function defaultWorkspaceState(): VaultWorkspaceState {
  return {
    version: 2,
    sidebarWidthRem: SIDEBAR_DEFAULT_REM,
    sidebarCollapsed: false,
    outlineWidthRem: OUTLINE_DEFAULT_REM,
    outlineCollapsed: true,
    expandedFolders: [],
    selectedPath: null,
    layout: emptyPane("pane-1"),
    focusedPaneId: "pane-1",
    closedTabs: [],
  };
}

/** Every leaf in depth-first, top-to-bottom, left-to-right order. */
export function workspaceLeaves(node: WorkspaceNode): WorkspaceLeaf[] {
  if (node.type === "leaf") return [node];
  return [
    ...workspaceLeaves(node.children[0]),
    ...workspaceLeaves(node.children[1]),
  ];
}

export function findWorkspaceLeaf(
  node: WorkspaceNode,
  id: string,
): WorkspaceLeaf | null {
  if (node.type === "leaf") return node.id === id ? node : null;
  return (
    findWorkspaceLeaf(node.children[0], id) ??
    findWorkspaceLeaf(node.children[1], id)
  );
}

/** An identifier no leaf in the tree currently holds. */
export function nextPaneId(node: WorkspaceNode): string {
  const used = new Set(workspaceLeaves(node).map((leaf) => leaf.id));
  let index = used.size + 1;
  while (used.has(`pane-${index}`)) index += 1;
  return `pane-${index}`;
}

/**
 * Replaces one leaf with a split holding it and `addition` on `side`. The
 * caller enforces the leaf cap; this operation only rewrites the shape.
 */
export function splitWorkspaceLeaf(
  node: WorkspaceNode,
  leafId: string,
  side: SplitSide,
  addition: WorkspaceLeaf,
): WorkspaceNode {
  if (node.type === "leaf") {
    if (node.id !== leafId) return node;
    const axis = side === "left" || side === "right" ? "row" : "column";
    const children: [WorkspaceNode, WorkspaceNode] =
      side === "left" || side === "up" ? [addition, node] : [node, addition];
    return { type: "split", axis, ratio: 0.5, children };
  }
  const first = splitWorkspaceLeaf(node.children[0], leafId, side, addition);
  const second = splitWorkspaceLeaf(node.children[1], leafId, side, addition);
  return first === node.children[0] && second === node.children[1]
    ? node
    : { ...node, children: [first, second] };
}

/**
 * Drops one leaf, replacing its parent split with the surviving sibling so
 * no single-child split is ever left behind. Returns null when the removed
 * leaf was the whole tree.
 */
export function removeWorkspaceLeaf(
  node: WorkspaceNode,
  leafId: string,
): WorkspaceNode | null {
  if (node.type === "leaf") return node.id === leafId ? null : node;
  const first = removeWorkspaceLeaf(node.children[0], leafId);
  const second = removeWorkspaceLeaf(node.children[1], leafId);
  if (first === null) return second;
  if (second === null) return first;
  return first === node.children[0] && second === node.children[1]
    ? node
    : { ...node, children: [first, second] };
}

/**
 * Collapses a tree into one pane, concatenating every leaf's tabs in the
 * tree's own depth-first order. Narrow viewports carry one pane only.
 */
export function flattenWorkspaceLayout(node: WorkspaceNode): WorkspaceLeaf {
  const leaves = workspaceLeaves(node);
  const [first] = leaves;
  if (first === undefined) return emptyPane("pane-1");
  if (leaves.length === 1) return first;
  const tabs: WorkspaceTab[] = [];
  for (const leaf of leaves) {
    for (const tab of leaf.tabs) {
      if (!tabs.some((candidate) => candidate.path === tab.path))
        tabs.push(tab);
    }
  }
  return {
    ...first,
    tabs,
    activePath:
      first.activePath ??
      leaves.find((leaf) => leaf.activePath !== null)?.activePath ??
      null,
  };
}

/** The minimum extent one node needs along an axis, in rem. */
export function minimumNodeExtentRem(
  node: WorkspaceNode,
  axis: "row" | "column",
): number {
  const floor = axis === "row" ? SPLIT_MIN_REM : SPLIT_MIN_HEIGHT_REM;
  if (node.type === "leaf") return floor;
  const first = minimumNodeExtentRem(node.children[0], axis);
  const second = minimumNodeExtentRem(node.children[1], axis);
  return node.axis === axis ? first + second : Math.max(first, second);
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function isViewState(value: unknown): value is NoteViewState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  return (
    typeof state.anchor === "number" &&
    typeof state.head === "number" &&
    typeof state.scrollAnchor === "number" &&
    typeof state.scrollOffset === "number" &&
    typeof state.propertiesExpanded === "boolean"
  );
}

function tabFrom(value: unknown): WorkspaceTab | null {
  if (typeof value !== "object" || value === null) return null;
  const tab = value as Record<string, unknown>;
  if (typeof tab.path !== "string" || tab.path.length === 0) return null;
  return {
    path: tab.path,
    viewState: isViewState(tab.viewState) ? tab.viewState : null,
  };
}

function addressFrom(value: unknown): NoteAddress | null {
  if (typeof value !== "object" || value === null) return null;
  const address = value as Record<string, unknown>;
  if (typeof address.path !== "string" || address.path.length === 0)
    return null;
  return typeof address.fragment === "string"
    ? { path: address.path, fragment: address.fragment }
    : { path: address.path };
}

function historyEntryFrom(value: unknown): WorkspaceHistoryEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const entry = value as Record<string, unknown>;
  const address = addressFrom(entry.address);
  if (address === null) return null;
  return {
    address,
    viewState: isViewState(entry.viewState) ? entry.viewState : null,
  };
}

function leafFrom(value: unknown, fallbackId: string): WorkspaceLeaf | null {
  if (typeof value !== "object" || value === null) return null;
  const pane = value as Record<string, unknown>;
  const tabs = Array.isArray(pane.tabs)
    ? pane.tabs.map(tabFrom).filter((tab): tab is WorkspaceTab => tab !== null)
    : [];
  const uniqueTabs = tabs.filter(
    (tab, tabIndex) =>
      tabs.findIndex((item) => item.path === tab.path) === tabIndex,
  );
  const id =
    typeof pane.id === "string" && pane.id.length > 0 ? pane.id : fallbackId;
  const requestedActive =
    typeof pane.activePath === "string" ? pane.activePath : null;
  const history = Array.isArray(pane.history)
    ? pane.history
        .map(historyEntryFrom)
        .filter((entry): entry is WorkspaceHistoryEntry => entry !== null)
        .slice(-100)
    : [];
  return {
    type: "leaf",
    id,
    tabs: uniqueTabs,
    activePath:
      requestedActive !== null &&
      uniqueTabs.some((tab) => tab.path === requestedActive)
        ? requestedActive
        : (uniqueTabs[0]?.path ?? null),
    history,
    historyIndex: clamp(
      Math.trunc(finiteNumber(pane.historyIndex, history.length - 1)),
      history.length === 0 ? -1 : 0,
      history.length - 1,
    ),
  };
}

function nodeFrom(value: unknown, depth: number): WorkspaceNode | null {
  if (typeof value !== "object" || value === null) return null;
  const node = value as Record<string, unknown>;
  if (node.type !== "split") return leafFrom(value, `pane-${depth + 1}`);
  // A recursion guard only: the leaf cap is enforced after parsing so an
  // over-large tree loses its shape rather than the tabs it carried.
  if (depth > 64 || !Array.isArray(node.children)) return null;
  const first = nodeFrom(node.children[0], depth + 1);
  const second = nodeFrom(node.children[1], depth + 1);
  if (first === null) return second;
  if (second === null) return first;
  return {
    type: "split",
    axis: node.axis === "column" ? "column" : "row",
    ratio: clamp(finiteNumber(node.ratio, 0.5), 0.05, 0.95),
    children: [first, second],
  };
}

/** Renames duplicate identifiers so every leaf addresses exactly one pane. */
function withUniquePaneIds(node: WorkspaceNode, used: Set<string>): void {
  if (node.type === "leaf") {
    if (node.id.length === 0 || used.has(node.id)) {
      let index = 1;
      while (used.has(`pane-${index}`)) index += 1;
      node.id = `pane-${index}`;
    }
    used.add(node.id);
    return;
  }
  withUniquePaneIds(node.children[0], used);
  withUniquePaneIds(node.children[1], used);
}

/**
 * Enforces the leaf cap by folding every leaf past it into the last kept
 * pane, so an over-large persisted tree loses its shape rather than tabs.
 */
function withLeafCap(node: WorkspaceNode): WorkspaceNode {
  const leaves = workspaceLeaves(node);
  if (leaves.length <= MAX_LEAF_PANES) return node;
  const kept = leaves.slice(0, MAX_LEAF_PANES);
  const survivor = kept[MAX_LEAF_PANES - 1];
  let layout = node;
  for (const leaf of leaves.slice(MAX_LEAF_PANES)) {
    if (survivor !== undefined) {
      for (const tab of leaf.tabs) {
        if (!survivor.tabs.some((candidate) => candidate.path === tab.path)) {
          survivor.tabs.push(tab);
        }
      }
    }
    layout = removeWorkspaceLeaf(layout, leaf.id) ?? layout;
  }
  return layout;
}

/**
 * Every folder on the way to a path, outermost first: `a/b/note.md` yields
 * `a` and `a/b`.
 */
function ancestorFolders(path: string): string[] {
  const segments = path.split("/").slice(0, -1);
  return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
}

/**
 * The selected note is always reachable in the tree, so every folder on the
 * way to it is expanded. A record that selects a note inside a collapsed
 * folder describes a workspace the tree does not render as written, and
 * because that record is what the next visit restores, it would describe the
 * same unreachable selection forever. Reconciling the pair here heals it on
 * the read that finds it.
 */
function withReachableSelection(
  expandedFolders: string[],
  selectedPath: string | null,
): string[] {
  if (selectedPath === null) return expandedFolders;
  const reachable = [...expandedFolders];
  const present = new Set(expandedFolders);
  for (const ancestor of ancestorFolders(selectedPath)) {
    if (ancestor.length === 0 || present.has(ancestor)) continue;
    present.add(ancestor);
    reachable.push(ancestor);
  }
  return reachable;
}

/** Validates persisted state so corrupt local data cannot break the shell. */
export function normalizeWorkspaceState(value: unknown): VaultWorkspaceState {
  const defaults = defaultWorkspaceState();
  if (typeof value !== "object" || value === null) return defaults;
  const stored = value as Record<string, unknown>;
  const layout = withLeafCap(
    nodeFrom(stored.layout, 0) ?? migratedPaneArray(stored) ?? defaults.layout,
  );
  withUniquePaneIds(layout, new Set());
  const leaves = workspaceLeaves(layout);
  const requestedFocused =
    typeof stored.focusedPaneId === "string" ? stored.focusedPaneId : "";
  const selectedPath =
    typeof stored.selectedPath === "string" ? stored.selectedPath : null;
  return {
    version: 2,
    sidebarWidthRem: clamp(
      finiteNumber(stored.sidebarWidthRem, SIDEBAR_DEFAULT_REM),
      SIDEBAR_MIN_REM,
      SIDEBAR_MAX_REM,
    ),
    sidebarCollapsed: stored.sidebarCollapsed === true,
    outlineWidthRem: clamp(
      finiteNumber(stored.outlineWidthRem, OUTLINE_DEFAULT_REM),
      OUTLINE_MIN_REM,
      OUTLINE_MAX_REM,
    ),
    outlineCollapsed: stored.outlineCollapsed !== false,
    expandedFolders: withReachableSelection(
      Array.isArray(stored.expandedFolders)
        ? stored.expandedFolders.filter(
            (path): path is string =>
              typeof path === "string" && path.length > 0,
          )
        : [],
      selectedPath,
    ),
    selectedPath,
    layout,
    focusedPaneId: leaves.some((leaf) => leaf.id === requestedFocused)
      ? requestedFocused
      : (leaves[0]?.id ?? "pane-1"),
    closedTabs: Array.isArray(stored.closedTabs)
      ? stored.closedTabs
          .map(tabFrom)
          .filter((tab): tab is WorkspaceTab => tab !== null)
          .slice(-20)
      : [],
  };
}

/**
 * Reads the earlier document shape, a flat pane list with one ratio, as the
 * equivalent tree: two panes become one row split carrying that ratio.
 */
function migratedPaneArray(
  stored: Record<string, unknown>,
): WorkspaceNode | null {
  if (!Array.isArray(stored.panes)) return null;
  const leaves = stored.panes
    .map((pane, index) => leafFrom(pane, `pane-${index + 1}`))
    .filter((leaf): leaf is WorkspaceLeaf => leaf !== null);
  const [first, ...rest] = leaves;
  if (first === undefined) return null;
  const ratio = clamp(finiteNumber(stored.splitRatio, 0.5), 0.05, 0.95);
  return rest.reduce<WorkspaceNode>(
    (accumulated, leaf) => ({
      type: "split",
      axis: "row",
      ratio,
      children: [accumulated, leaf],
    }),
    first,
  );
}

/**
 * The storage key names the per-vault storage area, not the document shape;
 * the shape is versioned inside the document so one area holds one session
 * and two application versions can never diverge into two of them.
 */
const STORAGE_KEY_PREFIX = "skribeum.workspace.v1";

function vaultKey(vaultIdentity: string): string {
  let hash = 2_166_136_261;
  for (const character of vaultIdentity.normalize("NFC")) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return `${STORAGE_KEY_PREFIX}.${(hash >>> 0).toString(16)}`;
}

/**
 * The flat pane list an earlier version reads. It travels alongside the tree
 * so a downgrade finds its own shape and keeps every open note: a plain
 * two-pane row projects faithfully, and any other tree flattens into one
 * pane in the tree's own order, which is all the earlier shape can express.
 */
function legacyPaneProjection(state: VaultWorkspaceState): {
  panes: unknown[];
  splitRatio: number;
} {
  const asPane = (leaf: WorkspaceLeaf) => ({
    id: leaf.id,
    tabs: leaf.tabs.map((tab) => ({
      path: tab.path,
      viewState: tab.viewState,
    })),
    activePath: leaf.activePath,
    history: leaf.history,
    historyIndex: leaf.historyIndex,
  });
  const layout = state.layout;
  if (
    layout.type === "split" &&
    layout.axis === "row" &&
    layout.children[0].type === "leaf" &&
    layout.children[1].type === "leaf"
  ) {
    return {
      panes: [asPane(layout.children[0]), asPane(layout.children[1])],
      splitRatio: layout.ratio,
    };
  }
  return { panes: [asPane(flattenWorkspaceLayout(layout))], splitRatio: 0.5 };
}

export function loadWorkspaceState(
  vaultIdentity: string,
  storage: Pick<Storage, "getItem"> = localStorage,
): VaultWorkspaceState {
  try {
    const value = storage.getItem(vaultKey(vaultIdentity));
    return value === null
      ? defaultWorkspaceState()
      : normalizeWorkspaceState(JSON.parse(value));
  } catch {
    return defaultWorkspaceState();
  }
}

export function saveWorkspaceState(
  vaultIdentity: string,
  state: VaultWorkspaceState,
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  try {
    const normalized = normalizeWorkspaceState(state);
    storage.setItem(
      vaultKey(vaultIdentity),
      JSON.stringify({ ...normalized, ...legacyPaneProjection(normalized) }),
    );
  } catch {
    // A full or unavailable storage area must not interrupt editing.
  }
}

function pathWithin(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

function remappedPath(candidate: string, from: string, to: string): string {
  return pathWithin(candidate, from)
    ? `${to}${candidate.slice(from.length)}`
    : candidate;
}

function mapLeaves(
  node: WorkspaceNode,
  transform: (leaf: WorkspaceLeaf) => WorkspaceLeaf,
): WorkspaceNode {
  return node.type === "leaf"
    ? transform(node)
    : {
        ...node,
        children: [
          mapLeaves(node.children[0], transform),
          mapLeaves(node.children[1], transform),
        ],
      };
}

/** Reconciles every persisted reference after a file or folder move. */
export function remapWorkspacePath(
  state: VaultWorkspaceState,
  from: string,
  to: string,
): VaultWorkspaceState {
  return normalizeWorkspaceState({
    ...state,
    selectedPath:
      state.selectedPath === null
        ? null
        : remappedPath(state.selectedPath, from, to),
    expandedFolders: state.expandedFolders.map((path) =>
      remappedPath(path, from, to),
    ),
    layout: mapLeaves(state.layout, (leaf) => ({
      ...leaf,
      tabs: leaf.tabs.map((tab) => ({
        ...tab,
        path: remappedPath(tab.path, from, to),
      })),
      activePath:
        leaf.activePath === null
          ? null
          : remappedPath(leaf.activePath, from, to),
      history: leaf.history.map((entry) => ({
        ...entry,
        address: {
          ...entry.address,
          path: remappedPath(entry.address.path, from, to),
        },
      })),
    })),
    closedTabs: state.closedTabs.map((tab) => ({
      ...tab,
      path: remappedPath(tab.path, from, to),
    })),
  });
}

/** Removes stale persisted references after a file or folder deletion. */
export function removeWorkspacePath(
  state: VaultWorkspaceState,
  removedPath: string,
): VaultWorkspaceState {
  const pruned = mapLeaves(state.layout, (leaf) => {
    const tabs = leaf.tabs.filter((tab) => !pathWithin(tab.path, removedPath));
    const history = leaf.history.filter(
      (entry) => !pathWithin(entry.address.path, removedPath),
    );
    return {
      ...leaf,
      tabs,
      activePath:
        leaf.activePath !== null && pathWithin(leaf.activePath, removedPath)
          ? (tabs[0]?.path ?? null)
          : leaf.activePath,
      history,
      historyIndex: Math.min(leaf.historyIndex, history.length - 1),
    };
  });
  // An emptied pane collapses into its sibling exactly as closing its last
  // tab would, so a deletion never leaves a blank pane behind.
  let layout = pruned;
  for (const leaf of workspaceLeaves(pruned)) {
    if (leaf.tabs.length > 0) continue;
    const remaining = removeWorkspaceLeaf(layout, leaf.id);
    if (remaining !== null) layout = remaining;
  }
  const leaves = workspaceLeaves(layout);
  return normalizeWorkspaceState({
    ...state,
    selectedPath:
      state.selectedPath !== null && pathWithin(state.selectedPath, removedPath)
        ? null
        : state.selectedPath,
    expandedFolders: state.expandedFolders.filter(
      (path) => !pathWithin(path, removedPath),
    ),
    layout,
    focusedPaneId: leaves.some((leaf) => leaf.id === state.focusedPaneId)
      ? state.focusedPaneId
      : (leaves[0]?.id ?? "pane-1"),
    closedTabs: state.closedTabs.filter(
      (tab) => !pathWithin(tab.path, removedPath),
    ),
  });
}
