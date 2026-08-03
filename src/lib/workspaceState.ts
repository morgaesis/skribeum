import type { NoteAddress, NoteViewState } from "./features/navigation";

export const SIDEBAR_MIN_REM = 12;
export const SIDEBAR_MAX_REM = 24;
export const SIDEBAR_DEFAULT_REM = 16;
export const OUTLINE_MIN_REM = 12;
export const OUTLINE_MAX_REM = 20;
export const OUTLINE_DEFAULT_REM = 15;
export const SPLIT_MIN_REM = 20;

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

export type WorkspacePane = {
  id: string;
  tabs: WorkspaceTab[];
  activePath: string | null;
  history: WorkspaceHistoryEntry[];
  historyIndex: number;
};

export type VaultWorkspaceState = {
  version: 1;
  sidebarWidthRem: number;
  sidebarCollapsed: boolean;
  outlineWidthRem: number;
  outlineCollapsed: boolean;
  splitRatio: number;
  expandedFolders: string[];
  selectedPath: string | null;
  panes: WorkspacePane[];
  focusedPaneId: string;
  closedTabs: WorkspaceTab[];
};

export function defaultWorkspaceState(): VaultWorkspaceState {
  return {
    version: 1,
    sidebarWidthRem: SIDEBAR_DEFAULT_REM,
    sidebarCollapsed: false,
    outlineWidthRem: OUTLINE_DEFAULT_REM,
    outlineCollapsed: true,
    splitRatio: 0.5,
    expandedFolders: [],
    selectedPath: null,
    panes: [emptyPane("pane-1")],
    focusedPaneId: "pane-1",
    closedTabs: [],
  };
}

export function emptyPane(id: string): WorkspacePane {
  return {
    id,
    tabs: [],
    activePath: null,
    history: [],
    historyIndex: -1,
  };
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

function paneFrom(value: unknown, index: number): WorkspacePane | null {
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
    typeof pane.id === "string" && pane.id.length > 0
      ? pane.id
      : `pane-${index + 1}`;
  const requestedActive =
    typeof pane.activePath === "string" ? pane.activePath : null;
  const history = Array.isArray(pane.history)
    ? pane.history
        .map(historyEntryFrom)
        .filter((entry): entry is WorkspaceHistoryEntry => entry !== null)
        .slice(-100)
    : [];
  return {
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

/** Validates persisted state so corrupt local data cannot break the shell. */
export function normalizeWorkspaceState(value: unknown): VaultWorkspaceState {
  const defaults = defaultWorkspaceState();
  if (typeof value !== "object" || value === null) return defaults;
  const stored = value as Record<string, unknown>;
  const panes = Array.isArray(stored.panes)
    ? stored.panes
        .slice(0, 2)
        .map(paneFrom)
        .filter((pane): pane is WorkspacePane => pane !== null)
    : [];
  const normalizedPanes = panes.length > 0 ? panes : defaults.panes;
  const requestedFocused =
    typeof stored.focusedPaneId === "string" ? stored.focusedPaneId : "";
  return {
    version: 1,
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
    splitRatio: clamp(finiteNumber(stored.splitRatio, 0.5), 0.2, 0.8),
    expandedFolders: Array.isArray(stored.expandedFolders)
      ? stored.expandedFolders.filter(
          (path): path is string => typeof path === "string" && path.length > 0,
        )
      : [],
    selectedPath:
      typeof stored.selectedPath === "string" ? stored.selectedPath : null,
    panes: normalizedPanes,
    focusedPaneId: normalizedPanes.some((pane) => pane.id === requestedFocused)
      ? requestedFocused
      : (normalizedPanes[0]?.id ?? "pane-1"),
    closedTabs: Array.isArray(stored.closedTabs)
      ? stored.closedTabs
          .map(tabFrom)
          .filter((tab): tab is WorkspaceTab => tab !== null)
          .slice(-20)
      : [],
  };
}

function vaultKey(vaultIdentity: string): string {
  let hash = 2_166_136_261;
  for (const character of vaultIdentity.normalize("NFC")) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return `skribeum.workspace.v1.${(hash >>> 0).toString(16)}`;
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
    storage.setItem(
      vaultKey(vaultIdentity),
      JSON.stringify(normalizeWorkspaceState(state)),
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
    panes: state.panes.map((pane) => ({
      ...pane,
      tabs: pane.tabs.map((tab) => ({
        ...tab,
        path: remappedPath(tab.path, from, to),
      })),
      activePath:
        pane.activePath === null
          ? null
          : remappedPath(pane.activePath, from, to),
      history: pane.history.map((entry) => ({
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
  const panes = state.panes.map((pane) => {
    const tabs = pane.tabs.filter((tab) => !pathWithin(tab.path, removedPath));
    const history = pane.history.filter(
      (entry) => !pathWithin(entry.address.path, removedPath),
    );
    return {
      ...pane,
      tabs,
      activePath:
        pane.activePath !== null && pathWithin(pane.activePath, removedPath)
          ? (tabs[0]?.path ?? null)
          : pane.activePath,
      history,
      historyIndex: Math.min(pane.historyIndex, history.length - 1),
    };
  });
  const populated = panes.filter((pane) => pane.tabs.length > 0);
  const retained =
    populated.length > 0 ? populated : [panes[0] ?? emptyPane("pane-1")];
  return normalizeWorkspaceState({
    ...state,
    selectedPath:
      state.selectedPath !== null && pathWithin(state.selectedPath, removedPath)
        ? null
        : state.selectedPath,
    expandedFolders: state.expandedFolders.filter(
      (path) => !pathWithin(path, removedPath),
    ),
    panes: retained,
    focusedPaneId: retained.some((pane) => pane.id === state.focusedPaneId)
      ? state.focusedPaneId
      : (retained[0]?.id ?? "pane-1"),
    closedTabs: state.closedTabs.filter(
      (tab) => !pathWithin(tab.path, removedPath),
    ),
  });
}
