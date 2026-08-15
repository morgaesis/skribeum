<script lang="ts">
import { open as openDirectoryDialog } from "@tauri-apps/plugin-dialog";
import { onMount, tick } from "svelte";
import tauriConfig from "../src-tauri/tauri.conf.json";
import AnchoredMenu from "./lib/AnchoredMenu.svelte";
import Banners, { type BannerItem } from "./lib/Banners.svelte";
import {
  type CommandTooltipOptions,
  commandTooltip,
} from "./lib/commandTooltip";
import { showConfirmDialog, showPromptDialog } from "./lib/dialogs";
import Editor from "./lib/Editor.svelte";
import {
  currentWikilinkContext,
  focusedRenderedTableCell,
} from "./lib/editor/decorations/engine";
import {
  DEFAULT_OBSIDIAN_APP_CONFIG,
  EMPTY_WIKILINK_CONTEXT,
  type ObsidianAppConfig,
  parseObsidianAppConfig,
  type WikilinkResolutionContext,
} from "./lib/editor/decorations/wikilinks";
import {
  type FrontmatterValueType,
  parseObsidianTypes,
} from "./lib/editor/frontmatter";
import FileTree from "./lib/FileTree.svelte";
import { createAppRegistry } from "./lib/features";
import { ContentRequestGate } from "./lib/features/contentRequestGate";
import {
  browserLinkForAddress,
  desktopLinkForAddress,
} from "./lib/features/copyLinks";
import {
  createNoteNavigator,
  type FollowWikilinkOptions,
  followLinkUnderCursor as followEditorLinkUnderCursor,
  type NavigationState,
  NOTE_ADDRESS_PARAMETER,
  type NoteAddress,
  type NoteNavigator,
  type NoteViewState,
  noteFragmentPosition,
  openExternalLink,
} from "./lib/features/navigation";
import {
  type EditorStatistics,
  type PersistenceState,
} from "./lib/features/noteStatistics";
import {
  computeOutline,
  headingAtOrBefore,
  type OutlineEntry,
} from "./lib/features/outline";
import {
  PERMALINK_ID_PARAMETER,
  permalinkUrlForId,
  resolveNoteId,
} from "./lib/features/permalink";
import {
  appendBareDiscoveryItems,
  commandItems,
  fileItems,
  firstMatchText,
  type PickerItem,
  parsePickerQuery,
  searchResultItems,
  tagItems,
} from "./lib/features/pickers";
import {
  DEFAULT_SETTINGS,
  type SettingsState,
  SettingsStore,
} from "./lib/features/settingsStore";
import { TOGGLE_SOURCE_MODE_COMMAND } from "./lib/features/sourceMode";
import {
  VIEW_CANVAS,
  VIEW_COMMAND_SURFACE,
  VIEW_FILE_TREE,
  VIEW_OUTLINE,
  VIEW_SETTINGS,
} from "./lib/features/surfaces";
import {
  type TagAffordanceOptions,
  type TagCatalogEntry,
} from "./lib/features/tags";
import {
  registerTaskStatusCommands,
  TASK_STATUS_MENU_COMMAND,
  taskStatusMarkerForContext,
} from "./lib/features/taskCommands";
import {
  checkForUpdate,
  hasDesktopRuntime,
  type UpdateState,
} from "./lib/features/updates";
import { M0_FIXTURE } from "./lib/fixture";
import {
  type BannerReason,
  type ByteRangeReplace,
  events,
  type TreeEntry,
  type VaultHandle,
} from "./lib/ipc/bindings";
import {
  fileOpenResolve,
  openFilesTake,
  type SearchResult,
  searchQuery,
  settingsPath,
  tagCatalog,
  treeEntryDelete,
  treeEntryMove,
  treeEntryReveal,
  treeFolderCreate,
  vaultSessionForget,
  vaultSessionRead,
  vaultTreeRefresh,
  zoomSet,
} from "./lib/ipc/services";
import {
  closeVault,
  IpcError,
  type LoadedNote,
  noteCreate,
  openVaultResult,
  readNote,
  readNoteStat,
  readVaultConfigFile,
  readVaultFile,
  vaultTree,
  watchSubscribe,
  writeVaultFile,
} from "./lib/ipc/vault";
import type { PaneSwitchKind } from "./lib/motion";
import NoteInfo from "./lib/NoteInfo.svelte";
import { isNotePath, resolveNoteTitle } from "./lib/noteTitles";
import OutlinePanel from "./lib/OutlinePanel.svelte";
import PanelDivider from "./lib/PanelDivider.svelte";
import {
  type CommandContext,
  formatKeybinding,
  globalKeydownHandler,
} from "./lib/registry";
import CanvasView from "./lib/rendering/CanvasView.svelte";
import {
  type CanvasDocument,
  type CanvasNode,
  canvasFilePaths,
  nextCanvasNodeId,
  nextCanvasNodePosition,
  parseCanvas,
  serializeCanvas,
} from "./lib/rendering/canvas";
import ReadOnlyNote from "./lib/rendering/ReadOnlyNote.svelte";
import { NARROW_BREAKPOINT_REM } from "./lib/responsive";
import SettingsView from "./lib/SettingsView.svelte";
import Sheet from "./lib/Sheet.svelte";
import StartupVaultRecovery from "./lib/StartupVaultRecovery.svelte";
import Statusline from "./lib/Statusline.svelte";
import {
  focusExpandedSidebarTarget,
  focusTabCloseSuccessor,
} from "./lib/shellFocus";
import {
  emptyStartupSurface,
  failedStartupSurface,
  isStaleVaultOpenError,
  nextStartupDecision,
  type StartupVaultSurface,
  selectedStartupFailureSurface,
  staleChooserStartupDecision,
  startupSource,
  type VaultStartupSession,
} from "./lib/startupVaultRecovery";
import { STRINGS } from "./lib/strings";
import TabStrip, { currentTabDrag, setTabDrag } from "./lib/TabStrip.svelte";
import {
  applyAppearance,
  isCodeFontName,
  isDarkPaletteName,
  isLightPaletteName,
  isProseFontName,
  isThemeName,
} from "./lib/themes/theme";
import UnifiedCommandSurface from "./lib/UnifiedCommandSurface.svelte";
import {
  installNativeOpenListener,
  NativeOpenQueue,
  StartupPathGate,
  StartupRecoveryGuard,
  VaultOwnership,
} from "./lib/vaultLifecycle";
import { bindVisualViewportCss } from "./lib/visualViewport";
import WindowControls from "./lib/WindowControls.svelte";
import { showWindowSystemMenu } from "./lib/windowChrome";
import {
  defaultWorkspaceState,
  emptyPane,
  findWorkspaceLeaf,
  flattenWorkspaceLayout,
  loadWorkspaceState,
  MAX_LEAF_PANES,
  minimumNodeExtentRem,
  nextPaneId,
  OUTLINE_DEFAULT_REM,
  OUTLINE_MAX_REM,
  OUTLINE_MIN_REM,
  remapWorkspacePath,
  removeWorkspaceLeaf,
  removeWorkspacePath,
  SIDEBAR_DEFAULT_REM,
  SIDEBAR_MAX_REM,
  SIDEBAR_MIN_REM,
  SPLIT_MIN_HEIGHT_REM,
  SPLIT_MIN_REM,
  type SplitSide,
  saveWorkspaceState,
  splitWorkspaceLeaf,
  type WorkspaceLeaf,
  type WorkspaceNode,
  type WorkspaceSplit,
  type WorkspaceTab,
  workspaceLeaves,
} from "./lib/workspaceState";

let {
  openVaultDisabledReason = null,
  navigationSurface = "desktop",
}: {
  openVaultDisabledReason?: string | null;
  navigationSurface?: "browser" | "desktop";
} = $props();

let vault = $state<VaultHandle | null>(null);
let activeVaultPath = $state<string | null>(null);
let activeVaultGeneration = 0;
const vaultOwnership = new VaultOwnership<VaultHandle>({
  open: openVaultResult,
  close: closeVault,
});
const endToEndVaultStartup = new StartupPathGate();
const startupRecoveryGuard = new StartupRecoveryGuard();
let tree = $state<TreeEntry[]>([]);
let treeTitleSources = $state<Record<string, string>>({});
let selectedPath = $state<string | null>(null);
let note = $state<LoadedNote | null>(null);
let collisionGroups = $state<string[][]>([]);
let errorText = $state<string | null>(null);
function initialStartupVaultSurface(): StartupVaultSurface {
  return navigationSurface === "desktop" && hasDesktopRuntime()
    ? { kind: "pending" }
    : emptyStartupSurface();
}

let startupVaultSurface = $state<StartupVaultSurface>(
  initialStartupVaultSurface(),
);
/**
 * False until every route that might open a vault at startup has settled.
 * The sidebar's column is reserved at its persisted width for that whole
 * window, so the workspace paints its settled geometry in the first frame
 * instead of shifting left when the vault arrives.
 */
let initialVaultSettled = $state(false);
const pendingStartupVaultSources = new Set<string>(["recovery", "announced"]);

function settleStartupVaultSource(source: string) {
  pendingStartupVaultSources.delete(source);
  if (pendingStartupVaultSources.size === 0) initialVaultSettled = true;
}
let banners = $state<BannerItem[]>([]);
// Svelte resets a `bind:this` component binding to `null`, not `undefined`,
// once the bound component unmounts (leaving canvas or the missing-note
// surface, for instance, both swap the template away from Editor); every
// "is the editor mounted" check below must treat both as absent.
let editor = $state<ReturnType<typeof Editor> | null | undefined>();
let contentHost = $state<HTMLElement | undefined>();
let obsidianConfig = $state<ObsidianAppConfig>(DEFAULT_OBSIDIAN_APP_CONFIG);
let linkContext = $state<WikilinkResolutionContext | null>(null);
let propertyTypes = $state<Record<string, FrontmatterValueType> | null>(null);
let obsidianReadGeneration = 0;
let contentView = $state<string | null>(null);
let canvas = $state<CanvasDocument | null>(null);
let canvasPreviews = $state<Record<string, string>>({});
let canvasError = $state<string | null>(null);
let canvasViewer = $state<ReturnType<typeof CanvasView> | undefined>();
const contentRequests = new ContentRequestGate();
let missingAddress = $state<NoteAddress | null>(null);
let navigationState = $state<NavigationState>({
  address: null,
  canGoBack: false,
  canGoForward: false,
});
let navigation: NoteNavigator | null = null;
let historyViewState = $state<NoteViewState | null>(null);
let workspace = $state(defaultWorkspaceState());
let workspaceIdentity = $state<string | null>(null);
let titleLoadGeneration = 0;
let workspaceHost = $state<HTMLElement>();
let splitDraggingNode = $state<WorkspaceSplit | null>(null);
/**
 * Each rendered pane's own box. A split halves the pane it acts on, so its
 * current extent is what decides whether the pane the split would create
 * can hold the minimum pane size.
 */
let paneExtents = $state(new Map<string, { width: number; height: number }>());
/** The pane and edge a dragged tab is currently hovering, if any. */
let splitDropZone = $state<{
  paneId: string;
  side: SplitSide | "center";
} | null>(null);
let sidebarHeaderHovered = $state(false);
let sidebarFocused = $state(false);
/** Live editor facts for the statusline and note-info surfaces. */
let editorStatistics = $state<EditorStatistics | null>(null);
let persistenceState = $state<PersistenceState>({ kind: "saved" });
/** Filesystem timestamps of the open note, when the platform serves them. */
let noteTimes = $state<{
  createdMs: number | null;
  modifiedMs: number | null;
} | null>(null);
let noteTimesGeneration = 0;
/** The transient center-slot statusline announcement (section 6.2). */
let statuslineAnnouncement = $state<{ id: number; text: string } | null>(null);
let nextAnnouncementId = 0;
/** The note-info popover's open state, shared with the registered command. */
let noteInfoOpen = $state(false);

let nextBannerId = 0;
// Journal-recovered deltas for notes that are not open yet, applied as
// pending edits when the note opens.
const pendingRecovered = new Map<string, ByteRangeReplace[]>();

// The registration surface: every command, palette entry, view and
// keybinding is registered here; this shell only maps view ids to
// concrete components and provides command capabilities.
const registry = createAppRegistry(
  DEFAULT_SETTINGS.task_statuses,
  hasDesktopRuntime(),
);

const macPlatform =
  typeof navigator !== "undefined" &&
  /Mac|iP[ao]d|iPhone/.test(navigator.platform);

/** The transient surface currently open (a registered overlay view id). */
let activeOverlay = $state<string | null>(null);
type SheetId = "file-tree" | "outline" | "overflow" | "note-info";
let activeSheet = $state<SheetId | null>(null);
let narrowViewport = $state(false);
let noteTitleVisible = $state(true);
let currentNoteSource = $state("");
let sourceMode = $state(false);
let surfaceFocusOrigin = $state<HTMLElement | null>(null);
let surfaceFocusRestoreFrame: number | null = null;
let taskStatusSurfaceMarker = $state<number | null>(null);
let tableCellSurfaceActive = $state(false);
let overflowContextPrepared = false;
let outlineOpen = $state(false);
let outlineEntries = $state<OutlineEntry[]>([]);
/** The live query of the open picker overlay. */
let overlayQuery = $state("");
let searchResults = $state<SearchResult[]>([]);
let tagCatalogEntries = $state<TagCatalogEntry[]>([]);
let recentTags = $state<string[]>([]);
let tagCatalogGeneration = 0;
let searchDebounce: ReturnType<typeof setTimeout> | undefined;
let cancelOutlineRefresh: (() => void) | undefined;
/** Recently opened note paths, most recent first. */
let recents = $state<string[]>([]);
let settingsState = $state<SettingsState>({
  document: DEFAULT_SETTINGS,
  error: null,
  errorSetting: null,
  loaded: false,
});
let updateState = $state<UpdateState>({ kind: "idle" });
let settingsFilePath = $state<string | null>(null);
let updateCheckGeneration = 0;
let targetSetting = $state<string | null>(null);
const transientBannerTimers = new Map<number, ReturnType<typeof setTimeout>>();

function applySettings(documentSettings: SettingsState["document"]) {
  const root = document.documentElement;
  root.style.setProperty(
    "--skr-editor-font-size",
    `${documentSettings.editor_font_size}px`,
  );
  root.style.setProperty(
    "--skr-editor-measure",
    String(documentSettings.editor_line_width),
  );
  root.style.setProperty(
    "--skr-editor-line-height",
    String(documentSettings.editor_line_height / 100),
  );
  applyAppearance(
    {
      theme: isThemeName(documentSettings.theme)
        ? documentSettings.theme
        : "system",
      light_palette: isLightPaletteName(documentSettings.light_palette)
        ? documentSettings.light_palette
        : "manuscript",
      dark_palette: isDarkPaletteName(documentSettings.dark_palette)
        ? documentSettings.dark_palette
        : "nightroom",
      prose_font: isProseFontName(documentSettings.prose_font)
        ? documentSettings.prose_font
        : "serif",
      code_font: isCodeFontName(documentSettings.code_font)
        ? documentSettings.code_font
        : "modern",
      animations: documentSettings.animations,
    },
    root,
  );
}

// Settings apply optimistically (the font size restart-free via the CSS
// variable); a failed write reverts and the settings view surfaces it.
const settingsStore = new SettingsStore((state) => {
  const previous = settingsState.document;
  registerTaskStatusCommands(registry, state.document.task_statuses);
  settingsState = state;
  if (previous.update_channel !== state.document.update_channel) {
    updateCheckGeneration += 1;
    updateState = { kind: "idle" };
  }
  applySettings(state.document);
  if (
    vault !== null &&
    previous.honor_obsidian_config !== state.document.honor_obsidian_config
  ) {
    void readObsidianConfig(vault);
  } else {
    refreshLinkContext();
  }
});

function checkSelectedUpdateChannel() {
  const channel =
    settingsState.document.update_channel === "beta" ? "beta" : "stable";
  const generation = ++updateCheckGeneration;
  void checkForUpdate(channel, (state) => {
    if (
      generation === updateCheckGeneration &&
      settingsState.document.update_channel === channel
    ) {
      updateState = state;
    }
  });
}

function notePathsOf(entries: TreeEntry[]): string[] {
  return entries
    .filter((entry) => entry.kind === "note")
    .map((entry) => entry.path);
}

function commandSurfacePathsOf(entries: TreeEntry[]): string[] {
  return entries
    .filter(
      (entry) =>
        entry.kind === "note" ||
        entry.path.toLocaleLowerCase().endsWith(".canvas"),
    )
    .map((entry) => entry.path);
}

const vaultName = $derived(
  activeVaultPath
    ?.replace(/[\\/]+$/u, "")
    .split(/[\\/]/u)
    .at(-1) ?? STRINGS.appTitle,
);

function activeVaultMatches(
  handle: VaultHandle,
  generation = activeVaultGeneration,
): boolean {
  const session = vaultOwnership.current();
  return (
    vault?.id === handle.id &&
    activeVaultGeneration === generation &&
    session !== null &&
    session.generation === generation &&
    session.handle.id === handle.id
  );
}

function activeVaultMatchesEvent(handleId: number): boolean {
  const session = vaultOwnership.current();
  return (
    session !== null &&
    activeVaultMatches(session.handle, session.generation) &&
    session.handle.id === handleId
  );
}

$effect(() => {
  const identity = workspaceIdentity;
  if (identity === null) return;
  workspace.selectedPath = selectedPath;
  workspace.outlineCollapsed = !outlineOpen;
  void JSON.stringify(workspace);
  saveWorkspaceState(identity, workspace);
});

// With no note open the statusline renders empty and carries no state.
$effect(() => {
  if (note === null) {
    noteTimes = null;
    editorStatistics = null;
    persistenceState = { kind: "saved" };
    noteInfoOpen = false;
  }
});

async function loadTreeTitles(handle: VaultHandle, entries: TreeEntry[]) {
  const generation = ++titleLoadGeneration;
  const vaultGeneration = activeVaultGeneration;
  const paths = entries
    .filter((entry) => entry.kind === "note")
    .map((entry) => entry.path);
  const next: Record<string, string> = {};
  for (let start = 0; start < paths.length; start += 16) {
    const batch = paths.slice(start, start + 16);
    const loaded = await Promise.all(
      batch.map(async (path) => {
        try {
          const bytes = await readVaultFile(handle, path);
          return [
            path,
            new TextDecoder("utf-8", { fatal: false }).decode(bytes),
          ] as const;
        } catch {
          return [path, ""] as const;
        }
      }),
    );
    if (
      generation !== titleLoadGeneration ||
      !activeVaultMatches(handle, vaultGeneration)
    )
      return;
    for (const [path, source] of loaded) next[path] = source;
    treeTitleSources = { ...next };
  }
}

let panelTogglePointerOrigin: HTMLElement | null | undefined;
let panelTogglePointerClearTimer: ReturnType<typeof setTimeout> | undefined;

function rememberPanelTogglePointerOrigin(event: MouseEvent) {
  if (event.button !== 0 || panelTogglePointerOrigin !== undefined) return;
  const active = document.activeElement;
  panelTogglePointerOrigin =
    active instanceof HTMLElement && active.isConnected ? active : null;
}

function keepPanelTogglePointerFocus(event: MouseEvent) {
  rememberPanelTogglePointerOrigin(event);
  if (event.button === 0) event.preventDefault();
}

function releasePanelTogglePointerOrigin(event: PointerEvent) {
  if (event.button !== 0 || panelTogglePointerOrigin === undefined) return;
  clearTimeout(panelTogglePointerClearTimer);
  panelTogglePointerClearTimer = setTimeout(() => {
    panelTogglePointerOrigin = undefined;
  });
}

function cancelPanelTogglePointerOrigin() {
  clearTimeout(panelTogglePointerClearTimer);
  panelTogglePointerOrigin = undefined;
}

function panelElement(panel: "sidebar" | "outline"): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    panel === "sidebar"
      ? ".skr-desktop-sidebar"
      : '[data-testid="desktop-outline-panel"]',
  );
}

function panelContainsFocus(
  panel: "sidebar" | "outline",
  focusTarget: Element | null,
): boolean {
  return (
    focusTarget !== null && panelElement(panel)?.contains(focusTarget) === true
  );
}

function focusCollapsedPanelRestore(panel: "sidebar" | "outline") {
  const target =
    panel === "sidebar"
      ? document.querySelector<HTMLElement>(
          '.skr-header-leading [data-command-id="panel.sidebar.toggle"]',
        )
      : document.querySelector<HTMLElement>('[aria-label="More actions"]');
  target?.focus();
}

function isCollapsedSidebarToggle(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.matches(
      '.skr-header-leading .skr-desktop-sidebar-toggle[data-command-id="panel.sidebar.toggle"]',
    )
  );
}

function togglePanel(panel: "sidebar" | "outline", origin?: HTMLElement) {
  const pointerOrigin = panelTogglePointerOrigin;
  cancelPanelTogglePointerOrigin();
  if (narrowViewport) {
    if (panel === "sidebar") {
      if (activeSheet === "file-tree") closeSheet();
      else openSheet("file-tree");
    } else if (activeSheet === "outline") closeSheet();
    else {
      refreshOutline();
      openSheet("outline");
    }
    return;
  }
  const wasOpen =
    panel === "sidebar" ? !workspace.sidebarCollapsed : outlineOpen;
  const focusOrigin =
    origin !== undefined
      ? origin
      : pointerOrigin !== undefined
        ? pointerOrigin
        : document.activeElement;
  const shouldRestoreFocus = wasOpen && panelContainsFocus(panel, focusOrigin);
  const shouldPreserveExternalPointerFocus =
    wasOpen &&
    pointerOrigin !== undefined &&
    focusOrigin instanceof HTMLElement &&
    !panelContainsFocus(panel, focusOrigin);
  const shouldFocusExpandedSidebar =
    !wasOpen &&
    panel === "sidebar" &&
    pointerOrigin === undefined &&
    isCollapsedSidebarToggle(focusOrigin);
  if (panel === "sidebar") {
    workspace.sidebarCollapsed = !workspace.sidebarCollapsed;
  } else {
    outlineOpen = !outlineOpen;
    workspace.outlineCollapsed = !outlineOpen;
    if (outlineOpen) refreshOutline();
  }
  if (
    shouldRestoreFocus ||
    shouldPreserveExternalPointerFocus ||
    shouldFocusExpandedSidebar
  ) {
    void tick().then(() => {
      const stillCollapsed =
        panel === "sidebar" ? workspace.sidebarCollapsed : !outlineOpen;
      if (!stillCollapsed) {
        if (shouldFocusExpandedSidebar) focusExpandedSidebarTarget();
        return;
      }
      if (shouldRestoreFocus) focusCollapsedPanelRestore(panel);
      else if (focusOrigin instanceof HTMLElement && focusOrigin.isConnected) {
        focusOrigin.focus();
      }
    });
  }
}

const workspacePanes = $derived(workspaceLeaves(workspace.layout));

/**
 * Editor inputs held at component level rather than written inline in the
 * pane snippet. An expression written as a prop inside a snippet becomes a
 * derived owned by that snippet's effect, and the editor reads these from
 * its own debounced save long after a split has torn that effect down.
 */
const editorVault = $derived(note !== null ? vault : null);
const editorPath = $derived(note !== null ? selectedPath : null);
const documentSettings = $derived(settingsState.document);
const documentTaskStatuses = $derived(settingsState.document.task_statuses);

function focusedWorkspacePane(): WorkspaceLeaf {
  return (
    findWorkspaceLeaf(workspace.layout, workspace.focusedPaneId) ??
    workspaceLeaves(workspace.layout)[0] ??
    emptyPane("pane-1")
  );
}

/** The pane holding a note in one of its tabs, searched in tree order. */
function paneHoldingPath(path: string): WorkspaceLeaf | null {
  return (
    workspaceLeaves(workspace.layout).find((leaf) =>
      leaf.tabs.some((tab) => tab.path === path),
    ) ?? null
  );
}

/**
 * The leaf that inherits focus when one pane collapses: the first pane of
 * its sibling subtree, which is the region that takes over its space.
 */
function siblingPaneId(node: WorkspaceNode, leafId: string): string | null {
  if (node.type === "leaf") return null;
  for (const [index, child] of node.children.entries()) {
    if (findWorkspaceLeaf(child, leafId) === null) continue;
    const nested = siblingPaneId(child, leafId);
    if (nested !== null) return nested;
    const sibling = node.children[index === 0 ? 1 : 0];
    return sibling === undefined
      ? null
      : (workspaceLeaves(sibling)[0]?.id ?? null);
  }
  return null;
}

function updatePaneNavigationState() {
  if (navigationSurface === "browser") return;
  const pane = focusedWorkspacePane();
  const current = pane.history[pane.historyIndex]?.address ?? null;
  navigationState = {
    address: current,
    canGoBack: pane.historyIndex > 0,
    canGoForward:
      pane.historyIndex >= 0 && pane.historyIndex < pane.history.length - 1,
  };
}

function captureFocusedTabState() {
  const pane = focusedWorkspacePane();
  const tab = pane.tabs.find((candidate) => candidate.path === pane.activePath);
  if (tab !== undefined)
    tab.viewState = editor?.captureHistoryState() ?? tab.viewState;
  const entry = pane.history[pane.historyIndex];
  if (entry !== undefined) {
    entry.viewState = editor?.captureHistoryState() ?? entry.viewState;
  }
  if (selectedPath !== null && currentNoteSource.length > 0) {
    treeTitleSources = {
      ...treeTitleSources,
      [selectedPath]: currentNoteSource,
    };
  }
}

function ensurePaneTab(pane: WorkspaceLeaf, path: string): WorkspaceTab {
  const existing = pane.tabs.find((tab) => tab.path === path);
  if (existing !== undefined) return existing;
  const tab = { path, viewState: null } satisfies WorkspaceTab;
  pane.tabs.push(tab);
  return tab;
}

/**
 * Open in place: the focused pane's active tab becomes this note instead of
 * the pane gaining one more tab. An empty pane, or one showing the empty
 * tab, gains its first tab here rather than carrying a special case.
 */
function placeTabInPlace(pane: WorkspaceLeaf, path: string): void {
  pane.emptyTab = false;
  if (pane.tabs.some((tab) => tab.path === path)) {
    pane.activePath = path;
    return;
  }
  const index =
    pane.activePath === null
      ? -1
      : pane.tabs.findIndex((tab) => tab.path === pane.activePath);
  const tab = { path, viewState: null } satisfies WorkspaceTab;
  if (index < 0) {
    pane.tabs.push(tab);
  } else {
    const replaced = pane.tabs[index];
    if (replaced !== undefined) editor?.forgetTab(replaced.path);
    pane.tabs.splice(index, 1, tab);
  }
  pane.activePath = path;
}

/** One of the four explicit new-tab routes: always adds a tab. */
function placeTabBeside(pane: WorkspaceLeaf, path: string): void {
  pane.emptyTab = false;
  if (pane.tabs.some((tab) => tab.path === path)) {
    pane.activePath = path;
    return;
  }
  const index =
    pane.activePath === null
      ? pane.tabs.length - 1
      : pane.tabs.findIndex((tab) => tab.path === pane.activePath);
  pane.tabs.splice(index + 1, 0, { path, viewState: null });
  pane.activePath = path;
}

function pushPaneHistory(
  pane: WorkspaceLeaf,
  address: NoteAddress,
  viewState: NoteViewState | null = null,
) {
  const current = pane.history[pane.historyIndex]?.address;
  if (current?.path === address.path && current.fragment === address.fragment) {
    pane.history[pane.historyIndex] = { address, viewState };
  } else {
    pane.history = [
      ...pane.history.slice(0, pane.historyIndex + 1),
      { address, viewState },
    ].slice(-100);
    pane.historyIndex = pane.history.length - 1;
  }
  updatePaneNavigationState();
}

async function activateWorkspaceTab(path: string | null) {
  const pane = focusedWorkspacePane();
  if (path === null) {
    if (pane.activePath === null) return;
    captureFocusedTabState();
    pane.emptyTab = true;
    pane.activePath = null;
    note = null;
    selectedPath = null;
    currentNoteSource = "";
    return;
  }
  if (pane.activePath === path && selectedPath === path) return;
  captureFocusedTabState();
  const tab = ensurePaneTab(pane, path);
  pane.emptyTab = false;
  pane.activePath = path;
  await openNote(path, tab.viewState, "tab");
  updatePaneNavigationState();
}

/** Opens the strip's own empty tab in the focused pane. */
async function openEmptyWorkspaceTab(paneId = workspace.focusedPaneId) {
  await focusWorkspacePane(paneId);
  const pane = focusedWorkspacePane();
  if (pane.emptyTab === true && pane.activePath === null) return;
  captureFocusedTabState();
  if ((await editor?.flush()) === false) {
    errorText = STRINGS.contentSwitchUnsaved;
    return;
  }
  pane.emptyTab = true;
  pane.activePath = null;
  note = null;
  selectedPath = null;
  currentNoteSource = "";
  updatePaneNavigationState();
}

/** Points the shell at one pane and loads whatever that pane was showing. */
async function adoptFocusedPane(id: string) {
  workspace.focusedPaneId = id;
  await tick();
  contentHost =
    document.querySelector<HTMLElement>(
      `[data-pane-id="${CSS.escape(id)}"] .skr-pane-content`,
    ) ?? undefined;
  const pane = focusedWorkspacePane();
  if (pane.activePath === null) {
    note = null;
    selectedPath = null;
    currentNoteSource = "";
  } else {
    const tab = ensurePaneTab(pane, pane.activePath);
    await openNote(pane.activePath, tab.viewState, "tab");
  }
  updatePaneNavigationState();
}

async function focusWorkspacePane(id: string) {
  if (workspace.focusedPaneId === id) return;
  if (findWorkspaceLeaf(workspace.layout, id) === null) return;
  if ((await editor?.flush()) === false) {
    errorText = STRINGS.contentSwitchUnsaved;
    return;
  }
  captureFocusedTabState();
  await adoptFocusedPane(id);
}

let tabCloseFocusGeneration = 0;

function restoreTabCloseFocus(paneId: string, generation: number) {
  void tick().then(() => {
    if (generation !== tabCloseFocusGeneration) return;
    const pane = document.querySelector<HTMLElement>(
      `[data-pane-id="${CSS.escape(paneId)}"]`,
    );
    const fallback =
      pane?.querySelector<HTMLElement>(".skr-pane-content") ?? null;
    if (pane !== null && focusTabCloseSuccessor(pane, fallback)) return;
    if (focusExpandedSidebarTarget()) return;
    document
      .querySelector<HTMLElement>('[data-command-id="vault.open"]')
      ?.focus();
  });
}

/**
 * Drops an emptied pane and hands its space to its sibling, repeating up
 * the tree so no split is ever left with one child. The last pane standing
 * stays, empty, because the editor area always has a pane.
 */
async function collapseEmptyPane(pane: WorkspaceLeaf): Promise<boolean> {
  const sibling = siblingPaneId(workspace.layout, pane.id);
  const remaining = removeWorkspaceLeaf(workspace.layout, pane.id);
  if (remaining === null || sibling === null) return false;
  workspace.layout = remaining;
  await adoptFocusedPane(sibling);
  return true;
}

async function closeWorkspaceTab(
  path: string | null = focusedWorkspacePane().activePath,
  restoreFocus = false,
) {
  const pane = focusedWorkspacePane();
  const generation = ++tabCloseFocusGeneration;
  if (path === null) {
    if (pane.emptyTab !== true) return;
    pane.emptyTab = false;
    if (pane.tabs.length === 0) {
      if (await collapseEmptyPane(pane)) {
        if (restoreFocus)
          restoreTabCloseFocus(workspace.focusedPaneId, generation);
      }
      return;
    }
    await activateWorkspaceTab(pane.tabs.at(-1)?.path ?? null);
    if (restoreFocus) restoreTabCloseFocus(pane.id, generation);
    return;
  }
  const index = pane.tabs.findIndex((tab) => tab.path === path);
  if (index < 0) return;
  const restoresActiveTabFocus = restoreFocus && pane.activePath === path;
  const closesActiveEditor = pane.activePath === path && selectedPath === path;
  if (closesActiveEditor && (await editor?.flush()) === false) {
    errorText = STRINGS.contentSwitchUnsaved;
    return;
  }
  if (closesActiveEditor) captureFocusedTabState();
  const [closed] = pane.tabs.splice(index, 1);
  if (closed !== undefined) {
    workspace.closedTabs = [...workspace.closedTabs, closed].slice(-20);
  }
  // The tab's durable, byte-offset-approximated view state survives in
  // closedTabs for Mod-Shift-T; the exact live CodeMirror state Editor
  // cached for instant tab-strip swaps does not need to outlive the tab.
  editor?.forgetTab(path);
  if (pane.tabs.length === 0 && pane.emptyTab !== true) {
    if (await collapseEmptyPane(pane)) {
      if (restoresActiveTabFocus) {
        restoreTabCloseFocus(workspace.focusedPaneId, generation);
      }
      return;
    }
  }
  if (pane.activePath === path) {
    const next = pane.tabs[Math.min(index, pane.tabs.length - 1)];
    if (next === undefined) {
      pane.activePath = null;
      note = null;
      selectedPath = null;
      currentNoteSource = "";
    } else {
      await activateWorkspaceTab(next.path);
    }
  }
  if (restoresActiveTabFocus) restoreTabCloseFocus(pane.id, generation);
}

async function reopenClosedWorkspaceTab() {
  const tab = workspace.closedTabs.at(-1);
  if (tab === undefined) return;
  workspace.closedTabs = workspace.closedTabs.slice(0, -1);
  const pane = focusedWorkspacePane();
  if (!pane.tabs.some((candidate) => candidate.path === tab.path)) {
    pane.tabs.push(tab);
  }
  await activateWorkspaceTab(tab.path);
}

function cycleWorkspaceTab(direction: -1 | 1) {
  const pane = focusedWorkspacePane();
  if (pane.tabs.length === 0) return;
  const current = pane.tabs.findIndex((tab) => tab.path === pane.activePath);
  const next = (current + direction + pane.tabs.length) % pane.tabs.length;
  const tab = pane.tabs[next];
  if (tab !== undefined) void activateWorkspaceTab(tab.path);
}

function activateWorkspaceTabIndex(index: number | "last") {
  const tabs = focusedWorkspacePane().tabs;
  const tab = index === "last" ? tabs.at(-1) : tabs[index];
  if (tab !== undefined) void activateWorkspaceTab(tab.path);
}

function reorderWorkspaceTabs(from: number, to: number) {
  const pane = focusedWorkspacePane();
  const [tab] = pane.tabs.splice(from, 1);
  if (tab === undefined) return;
  const target = Math.max(
    0,
    Math.min(to > from ? to - 1 : to, pane.tabs.length),
  );
  pane.tabs.splice(target, 0, tab);
}

/**
 * Why splitting one pane on one side is unavailable, or null when it is
 * available. Two bounds exist and both are stated the same way: the hard
 * leaf cap, and the geometry itself, because a tree whose panes cannot all
 * hold the minimum pane size in the editor area would have to overflow it.
 */
function splitUnavailableReason(
  paneId: string,
  side: SplitSide,
): string | null {
  if (workspaceLeaves(workspace.layout).length >= MAX_LEAF_PANES) {
    return STRINGS.splitPaneCapReached;
  }
  const extent = paneExtents.get(paneId);
  if (extent === undefined) return null;
  // A split halves the pane it acts on, so both halves clear the floor only
  // when the pane already holds twice it along that axis.
  const horizontal = side === "left" || side === "right";
  const available = horizontal ? extent.width : extent.height;
  const floor =
    (horizontal ? SPLIT_MIN_REM : SPLIT_MIN_HEIGHT_REM) * rootFontSize();
  return available + 1 < floor * 2 ? STRINGS.splitPaneTooSmall : null;
}

function rootFontSize(): number {
  return Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
}

/**
 * Splits one pane, carrying a tab into the new child on `side`. A pane
 * holding more than one tab hands its tab over; a pane holding only the one
 * keeps it and the new pane opens the same note, so the command always does
 * something rather than declining silently.
 */
async function splitPaneWithTab(
  paneId: string,
  side: SplitSide,
  path: string,
  sourcePaneId = paneId,
): Promise<void> {
  if (narrowViewport || splitUnavailableReason(paneId, side) !== null) return;
  const source = findWorkspaceLeaf(workspace.layout, sourcePaneId);
  const target = findWorkspaceLeaf(workspace.layout, paneId);
  if (source === null || target === null) return;
  const index = source.tabs.findIndex((tab) => tab.path === path);
  const held = source.tabs[index];
  if (held === undefined) return;
  captureFocusedTabState();
  const moves = source.tabs.length > 1;
  const carried: WorkspaceTab = moves
    ? held
    : { path: held.path, viewState: held.viewState };
  if (moves) {
    source.tabs.splice(index, 1);
    if (source.activePath === path) {
      source.activePath =
        source.tabs[Math.min(index, source.tabs.length - 1)]?.path ?? null;
    }
  }
  const created: WorkspaceLeaf = {
    type: "leaf",
    id: nextPaneId(workspace.layout),
    tabs: [carried],
    activePath: carried.path,
    history: [
      { address: { path: carried.path }, viewState: carried.viewState },
    ],
    historyIndex: 0,
  };
  workspace.layout = splitWorkspaceLeaf(
    workspace.layout,
    paneId,
    side,
    created,
  );
  if (source.tabs.length === 0 && source.emptyTab !== true) {
    const remaining = removeWorkspaceLeaf(workspace.layout, source.id);
    if (remaining !== null) workspace.layout = remaining;
  }
  await adoptFocusedPane(created.id);
}

async function splitFocusedPane(side: SplitSide) {
  const pane = focusedWorkspacePane();
  if (pane.activePath === null) return;
  await splitPaneWithTab(pane.id, side, pane.activePath);
}

/** Every rendered pane's box, for the geometric focus and move searches. */
function paneBounds(): Array<{ id: string; rect: DOMRect }> {
  return [...document.querySelectorAll<HTMLElement>("[data-pane-id]")].map(
    (element) => ({
      id: element.dataset.paneId ?? "",
      rect: element.getBoundingClientRect(),
    }),
  );
}

/**
 * The nearest pane in one geometric direction, resolved the way a tiling
 * window manager does it: candidates strictly past the moving edge, ranked
 * by distance along the axis, then by how far their centers drift across it.
 */
function nearestPaneInDirection(
  fromId: string,
  direction: SplitSide,
): string | null {
  const bounds = paneBounds();
  const origin = bounds.find((entry) => entry.id === fromId)?.rect;
  if (origin === undefined) return null;
  const horizontal = direction === "left" || direction === "right";
  const originCenter = horizontal
    ? origin.top + origin.height / 2
    : origin.left + origin.width / 2;
  let best: { id: string; primary: number; cross: number } | null = null;
  for (const entry of bounds) {
    if (entry.id === fromId || entry.id.length === 0) continue;
    const rect = entry.rect;
    const primary =
      direction === "left"
        ? origin.left - rect.right
        : direction === "right"
          ? rect.left - origin.right
          : direction === "up"
            ? origin.top - rect.bottom
            : rect.top - origin.bottom;
    if (primary < -1) continue;
    const cross = Math.abs(
      (horizontal ? rect.top + rect.height / 2 : rect.left + rect.width / 2) -
        originCenter,
    );
    if (
      best === null ||
      primary < best.primary - 1 ||
      (Math.abs(primary - best.primary) <= 1 && cross < best.cross)
    ) {
      best = { id: entry.id, primary, cross };
    }
  }
  return best?.id ?? null;
}

function focusWorkspacePaneDirection(direction: SplitSide) {
  const target = nearestPaneInDirection(workspace.focusedPaneId, direction);
  if (target !== null) void focusWorkspacePane(target);
}

/** Relocates one tab into another pane's strip at a given position. */
async function moveTabIntoPane(
  sourcePaneId: string,
  path: string,
  targetPaneId: string,
  index: number,
): Promise<void> {
  if (sourcePaneId === targetPaneId) return;
  const source = findWorkspaceLeaf(workspace.layout, sourcePaneId);
  const target = findWorkspaceLeaf(workspace.layout, targetPaneId);
  if (source === null || target === null) return;
  const position = source.tabs.findIndex((tab) => tab.path === path);
  if (position < 0) return;
  captureFocusedTabState();
  const [tab] = source.tabs.splice(position, 1);
  if (tab === undefined) return;
  if (source.activePath === path) {
    source.activePath =
      source.tabs[Math.min(position, source.tabs.length - 1)]?.path ?? null;
  }
  if (!target.tabs.some((candidate) => candidate.path === tab.path)) {
    target.tabs.splice(
      Math.max(0, Math.min(index, target.tabs.length)),
      0,
      tab,
    );
  }
  target.emptyTab = false;
  target.activePath = tab.path;
  pushPaneHistory(target, { path: tab.path }, tab.viewState);
  if (source.tabs.length === 0 && source.emptyTab !== true) {
    const remaining = removeWorkspaceLeaf(workspace.layout, source.id);
    if (remaining !== null) workspace.layout = remaining;
  }
  await adoptFocusedPane(target.id);
}

/**
 * Why moving the active tab in one direction is unavailable. With a pane
 * already there it is a relocation; without one it falls back to a split
 * and inherits the split's own bounds.
 */
function moveTabUnavailableReason(direction: SplitSide): string | null {
  const source = focusedWorkspacePane();
  if (source.activePath === null) return STRINGS.movePaneUnavailable;
  return nearestPaneInDirection(source.id, direction) !== null
    ? null
    : splitUnavailableReason(source.id, direction);
}

async function moveTabToPaneDirection(direction: SplitSide) {
  const source = focusedWorkspacePane();
  const path = source.activePath;
  if (path === null) return;
  const target = nearestPaneInDirection(source.id, direction);
  if (target === null) {
    await splitPaneWithTab(source.id, direction, path);
    return;
  }
  await moveTabIntoPane(source.id, path, target, Number.MAX_SAFE_INTEGER);
}

function paneNavigate(direction: -1 | 1): boolean {
  if (navigationSurface === "browser") {
    return direction < 0
      ? (navigation?.back() ?? false)
      : (navigation?.forward() ?? false);
  }
  const pane = focusedWorkspacePane();
  const next = pane.historyIndex + direction;
  const entry = pane.history[next];
  if (entry === undefined) return false;
  captureFocusedTabState();
  pane.historyIndex = next;
  const tab = ensurePaneTab(pane, entry.address.path);
  pane.emptyTab = false;
  pane.activePath = tab.path;
  void openNoteAddress(entry.address, entry.viewState, "history");
  updatePaneNavigationState();
  return true;
}

/** The zone a dragged tab is over: an outer quarter, or the center. */
function dropZoneAt(
  bounds: DOMRect,
  clientX: number,
  clientY: number,
): SplitSide | "center" {
  const left = (clientX - bounds.left) / bounds.width;
  const top = (clientY - bounds.top) / bounds.height;
  const nearest = Math.min(left, 1 - left, top, 1 - top);
  if (nearest >= 0.25) return "center";
  if (nearest === left) return "left";
  if (nearest === 1 - left) return "right";
  return nearest === top ? "up" : "down";
}

function updateTabDropZone(event: DragEvent, paneId: string) {
  const origin = currentTabDrag();
  if (origin === null) return;
  const target = event.currentTarget as HTMLElement;
  const side = dropZoneAt(
    target.getBoundingClientRect(),
    event.clientX,
    event.clientY,
  );
  // An edge zone that cannot produce a pane does not activate: no overlay,
  // and the drag keeps its no-drop cursor rather than promising a split.
  if (side !== "center" && splitUnavailableReason(paneId, side) !== null) {
    splitDropZone = null;
    return;
  }
  event.preventDefault();
  splitDropZone = { paneId, side };
}

async function dropTabOnPane(event: DragEvent, paneId: string) {
  const origin = currentTabDrag();
  const zone = splitDropZone;
  splitDropZone = null;
  if (origin === null || zone === null || zone.paneId !== paneId) return;
  event.preventDefault();
  setTabDrag(null);
  if (zone.side === "center") {
    await moveTabIntoPane(
      origin.paneId,
      origin.path,
      paneId,
      Number.MAX_SAFE_INTEGER,
    );
    return;
  }
  const source = findWorkspaceLeaf(workspace.layout, origin.paneId);
  // Dropping a pane's only tab on that same pane's edge would split and
  // immediately collapse: nothing to do.
  if (origin.paneId === paneId && (source?.tabs.length ?? 0) <= 1) return;
  await splitPaneWithTab(paneId, zone.side, origin.path, origin.paneId);
}

function splitRatioBounds(
  node: WorkspaceSplit,
  total: number,
  rootSize: number,
): { minimum: number; maximum: number } {
  const first = minimumNodeExtentRem(node.children[0], node.axis) * rootSize;
  const second = minimumNodeExtentRem(node.children[1], node.axis) * rootSize;
  if (total <= 0 || first + second >= total) {
    return { minimum: 0.5, maximum: 0.5 };
  }
  return { minimum: first / total, maximum: 1 - second / total };
}

let lastDividerPress: { node: WorkspaceSplit; at: number } | null = null;

function beginSplitResize(event: PointerEvent, node: WorkspaceSplit) {
  if (event.button !== 0) return;
  const divider = event.currentTarget as HTMLElement;
  const container = divider.parentElement;
  if (container === null) return;
  event.preventDefault();
  const now = event.timeStamp;
  const previous = lastDividerPress;
  lastDividerPress = { node, at: now };
  if (previous !== null && previous.node === node && now - previous.at < 500) {
    lastDividerPress = null;
    node.ratio = 0.5;
    return;
  }
  const pointer = event.pointerId;
  const bounds = container.getBoundingClientRect();
  const rootSize = Number.parseFloat(
    getComputedStyle(document.documentElement).fontSize,
  );
  const total = node.axis === "row" ? bounds.width : bounds.height;
  const { minimum, maximum } = splitRatioBounds(node, total, rootSize);
  splitDraggingNode = node;
  divider.setPointerCapture(pointer);
  const move = (next: PointerEvent) => {
    if (next.pointerId !== pointer) return;
    const offset =
      node.axis === "row"
        ? (next.clientX - bounds.left) / bounds.width
        : (next.clientY - bounds.top) / bounds.height;
    node.ratio = Math.max(minimum, Math.min(maximum, offset));
  };
  const stop = (end: PointerEvent) => {
    if (end.pointerId !== pointer) return;
    splitDraggingNode = null;
    divider.removeEventListener("pointermove", move);
    divider.removeEventListener("pointerup", stop);
    divider.removeEventListener("pointercancel", stop);
  };
  divider.addEventListener("pointermove", move);
  divider.addEventListener("pointerup", stop);
  divider.addEventListener("pointercancel", stop);
}

// registry-exempt keydown: ARIA separator arrow resizing stays local to the
// split divider. Pane focus and structural actions remain registry commands.
function resizeSplitWithKeyboard(event: KeyboardEvent, node: WorkspaceSplit) {
  const container = (event.currentTarget as HTMLElement).parentElement;
  if (container === null) return;
  const bounds = container.getBoundingClientRect();
  const rootSize = Number.parseFloat(
    getComputedStyle(document.documentElement).fontSize,
  );
  const total = node.axis === "row" ? bounds.width : bounds.height;
  const step = total === 0 ? 0 : rootSize / total;
  const decrease = node.axis === "row" ? "ArrowLeft" : "ArrowUp";
  const increase = node.axis === "row" ? "ArrowRight" : "ArrowDown";
  let next = node.ratio;
  if (event.key === decrease) next -= step;
  else if (event.key === increase) next += step;
  else if (event.key === "Home") next = 0.5;
  else return;
  const { minimum, maximum } = splitRatioBounds(node, total, rootSize);
  node.ratio = Math.max(minimum, Math.min(maximum, next));
  event.preventDefault();
}

function refreshOutline() {
  const view = editor?.getView();
  outlineEntries = view === undefined ? [] : computeOutline(view.state);
}

function scheduleOutlineRefresh() {
  cancelOutlineRefresh?.();
  if (typeof requestIdleCallback === "function") {
    const callback = requestIdleCallback(
      () => {
        cancelOutlineRefresh = undefined;
        refreshOutline();
      },
      { timeout: 250 },
    );
    cancelOutlineRefresh = () => cancelIdleCallback(callback);
    return;
  }
  const timer = setTimeout(() => {
    cancelOutlineRefresh = undefined;
    refreshOutline();
  }, 0);
  cancelOutlineRefresh = () => clearTimeout(timer);
}

function openOverlay(id: string, initialQuery = "") {
  taskStatusSurfaceMarker = currentTaskStatusMarker();
  if (
    surfaceFocusOrigin === null &&
    document.activeElement instanceof HTMLElement
  ) {
    surfaceFocusOrigin = document.activeElement;
  }
  activeSheet = null;
  activeOverlay = id;
  overlayQuery = initialQuery;
  searchResults = [];
  if (id === VIEW_COMMAND_SURFACE) {
    void refreshTreeIndex();
  }
}

function openCommandSurface(initialQuery: string) {
  targetSetting = null;
  openOverlay(VIEW_COMMAND_SURFACE, initialQuery);
  const parsed = parsePickerQuery(initialQuery);
  if (parsed.mode === "text" && parsed.query.length > 0) {
    void runVaultSearch(parsed.query);
  }
}

function openSetting(id: string) {
  targetSetting = id;
  openOverlay(VIEW_SETTINGS);
}

function openSheet(id: SheetId, origin?: HTMLElement) {
  if (id === "overflow" && !overflowContextPrepared) {
    prepareOverflowContext();
  }
  overflowContextPrepared = false;
  if (
    surfaceFocusOrigin === null &&
    (origin !== undefined || document.activeElement instanceof HTMLElement)
  ) {
    surfaceFocusOrigin = origin ?? (document.activeElement as HTMLElement);
  }
  activeOverlay = null;
  activeSheet = id;
}

function runSurfaceCommand(id: string, origin: HTMLElement) {
  if (surfaceFocusOrigin === null) {
    surfaceFocusOrigin = origin;
  }
  registry.run(id, commandContext());
}

function closeSheet() {
  activeSheet = null;
  taskStatusSurfaceMarker = null;
  tableCellSurfaceActive = false;
  overflowContextPrepared = false;
  restoreSurfaceFocus();
}

function restoreSurfaceFocus() {
  const origin = surfaceFocusOrigin;
  surfaceFocusOrigin = null;
  void tick().then(() => {
    // Clearing `inert` takes effect with the browser's next render. Restore
    // focus after that render so WebKit accepts the invoking chrome control.
    if (surfaceFocusRestoreFrame !== null) {
      cancelAnimationFrame(surfaceFocusRestoreFrame);
    }
    surfaceFocusRestoreFrame = requestAnimationFrame(() => {
      surfaceFocusRestoreFrame = null;
      if (activeSheet !== null || activeOverlay !== null) return;
      if (origin?.isConnected) {
        origin.focus({ preventScroll: true });
      } else {
        focusContent();
      }
    });
  });
}

function focusFileTree() {
  focusExpandedSidebarTarget();
}

/** Re-indexes the tree so newly discovered notes reach indexed surfaces. */
async function refreshTreeIndex(refreshTags = false) {
  const activeVault = vault;
  if (activeVault === null) {
    return;
  }
  const vaultGeneration = activeVaultGeneration;
  try {
    const refreshedTree = await vaultTreeRefresh(activeVault);
    if (!activeVaultMatches(activeVault, vaultGeneration)) {
      return;
    }
    if (refreshTags) {
      await refreshTagCatalog(activeVault);
      if (!activeVaultMatches(activeVault, vaultGeneration)) {
        return;
      }
    }
    tree = refreshedTree;
    void loadTreeTitles(activeVault, refreshedTree);
    refreshLinkContext();
  } catch {
    // The watcher-maintained tree remains authoritative when the
    // refresh command is unavailable.
  }
}

async function createNewNote() {
  const activeVault = vault;
  if (activeVault === null) {
    return;
  }
  const folder = settingsState.document.default_note_folder;
  const existing = new Set(
    notePathsOf(tree).map((path) => path.toLocaleLowerCase()),
  );
  let number = 1;
  let path = "";
  do {
    const suffix = number === 1 ? "" : ` ${number}`;
    const fileName = `${STRINGS.untitledNoteName}${suffix}.md`;
    path = folder.length === 0 ? fileName : `${folder}/${fileName}`;
    number += 1;
  } while (existing.has(path.toLocaleLowerCase()));

  try {
    await noteCreate(activeVault, path);
    tree = await vaultTreeRefresh(activeVault);
    void loadTreeTitles(activeVault, tree);
    refreshLinkContext();
    await navigateToNote(path);
  } catch (error) {
    errorText = describeError(STRINGS.noteCreateFailed, error);
  }
}

function treeParent(path: string): string {
  return path.split("/").slice(0, -1).join("/");
}

function treeJoin(parent: string, name: string): string {
  return parent.length === 0 ? name : `${parent}/${name}`;
}

function treePathWithin(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

function remapTreePath(candidate: string, from: string, to: string): string {
  return treePathWithin(candidate, from)
    ? `${to}${candidate.slice(from.length)}`
    : candidate;
}

function reconcileRuntimePaths(from: string, to: string) {
  workspace = remapWorkspacePath(workspace, from, to);
  recents = recents.map((path) => remapTreePath(path, from, to));
  for (const [path, changes] of [...pendingRecovered]) {
    if (!treePathWithin(path, from)) continue;
    pendingRecovered.delete(path);
    pendingRecovered.set(remapTreePath(path, from, to), changes);
  }
}

async function createTreeNote(folder: string) {
  const activeVault = vault;
  if (activeVault === null) return;
  const existing = new Set(tree.map((entry) => entry.path.toLocaleLowerCase()));
  let index = 1;
  let path = "";
  do {
    const suffix = index === 1 ? "" : ` ${index}`;
    path = treeJoin(folder, `${STRINGS.untitledNoteName}${suffix}.md`);
    index += 1;
  } while (existing.has(path.toLocaleLowerCase()));
  try {
    await noteCreate(activeVault, path);
    tree = await vaultTreeRefresh(activeVault);
    void loadTreeTitles(activeVault, tree);
    refreshLinkContext();
    await navigateToNote(path);
  } catch (error) {
    errorText = describeError(STRINGS.noteCreateFailed, error);
  }
}

async function createTreeFolder(parent: string) {
  const activeVault = vault;
  if (activeVault === null) return;
  const entered = await showPromptDialog({
    title: STRINGS.treeCreateFolder,
    inputLabel: STRINGS.treeFolderPrompt,
    confirmLabel: STRINGS.createAction,
  });
  const name = entered?.trim();
  if (name === undefined || name === "") return;
  try {
    tree = await treeFolderCreate(activeVault, treeJoin(parent, name));
    refreshLinkContext();
  } catch (error) {
    errorText = describeError(STRINGS.treeOperationFailed, error);
  }
}

/**
 * Validates a rename target before it is applied. A note (an entry the
 * vault scans as `EntryKind::Note`, matching `NOTE_EXTENSIONS` in
 * noteTitles.ts) must keep one of those extensions, or the renamed file
 * becomes an opaque `EntryKind::File` row the tree can no longer select or
 * open. Folders and other file kinds carry no such restriction.
 */
function validateTreeRename(
  requiresNoteExtension: boolean,
  value: string,
): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (requiresNoteExtension && !isNotePath(trimmed)) {
    return STRINGS.treeRenameInvalidExtension;
  }
  return null;
}

async function renameTreeEntry(path: string, restoreFocus?: () => void) {
  const activeVault = vault;
  if (activeVault === null) return;
  const requiresNoteExtension =
    tree.find((entry) => entry.path === path)?.kind === "note";
  const entered = await showPromptDialog({
    title: STRINGS.treeRename,
    inputLabel: STRINGS.treeRenamePrompt,
    initialValue: path.split("/").at(-1) ?? path,
    confirmLabel: STRINGS.treeRename,
    validate: (value) => validateTreeRename(requiresNoteExtension, value),
  });
  const name = entered?.trim();
  if (name === undefined || name === "") return;
  const target = treeJoin(treeParent(path), name);
  if (target === path) return;
  const activePath = selectedPath;
  const affectsActive = activePath !== null && treePathWithin(activePath, path);
  const activeViewState = affectsActive
    ? (editor?.captureHistoryState() ?? null)
    : null;
  if (affectsActive && (await editor?.flush()) === false) {
    errorText = STRINGS.contentSwitchUnsaved;
    return;
  }
  try {
    tree = await treeEntryMove(activeVault, path, target);
    reconcileRuntimePaths(path, target);
    if (activePath !== null) {
      selectedPath = remapTreePath(activePath, path, target);
    }
    void loadTreeTitles(activeVault, tree);
    refreshLinkContext();
    if (affectsActive && selectedPath !== null) {
      await openNote(selectedPath, activeViewState);
      // The renamed note keeps its place in the pane, so the address has to
      // follow it: without this the query parameter still names the old path.
      navigation?.syncAddress({ path: selectedPath });
    }
    await tick();
    restoreFocus?.();
  } catch (error) {
    errorText = describeError(STRINGS.treeOperationFailed, error);
  }
}

async function deleteTreeEntry(path: string, restoreFocus?: () => void) {
  const activeVault = vault;
  if (activeVault === null) return;
  const confirmed = await showConfirmDialog({
    title: STRINGS.treeDelete,
    message: STRINGS.treeDeleteConfirm,
    confirmLabel: STRINGS.treeDelete,
    destructive: true,
  });
  if (!confirmed) return;
  const removesActive =
    selectedPath !== null && treePathWithin(selectedPath, path);
  if (removesActive && (await editor?.flush()) === false) {
    errorText = STRINGS.contentSwitchUnsaved;
    return;
  }
  try {
    tree = await treeEntryDelete(activeVault, path);
    workspace = removeWorkspacePath(workspace, path);
    recents = recents.filter((candidate) => !treePathWithin(candidate, path));
    for (const candidate of [...pendingRecovered.keys()]) {
      if (treePathWithin(candidate, path)) pendingRecovered.delete(candidate);
    }
    const nextPath = focusedWorkspacePane().activePath;
    selectedPath = nextPath;
    void loadTreeTitles(activeVault, tree);
    refreshLinkContext();
    if (removesActive) {
      if (nextPath === null) {
        note = null;
        currentNoteSource = "";
      } else {
        const tab = ensurePaneTab(focusedWorkspacePane(), nextPath);
        await openNote(nextPath, tab.viewState, "tab");
      }
    }
    await tick();
    restoreFocus?.();
  } catch (error) {
    errorText = describeError(STRINGS.treeOperationFailed, error);
  }
}

async function moveTreeEntry(path: string, destination: string | null) {
  const activeVault = vault;
  if (activeVault === null) return;
  const target = treeJoin(destination ?? "", path.split("/").at(-1) ?? path);
  if (target === path) return;
  const activePath = selectedPath;
  const affectsActive = activePath !== null && treePathWithin(activePath, path);
  const activeViewState = affectsActive
    ? (editor?.captureHistoryState() ?? null)
    : null;
  if (affectsActive && (await editor?.flush()) === false) {
    errorText = STRINGS.contentSwitchUnsaved;
    return;
  }
  try {
    tree = await treeEntryMove(activeVault, path, target);
    reconcileRuntimePaths(path, target);
    if (activePath !== null) {
      selectedPath = remapTreePath(activePath, path, target);
    }
    void loadTreeTitles(activeVault, tree);
    refreshLinkContext();
    if (affectsActive && selectedPath !== null) {
      await openNote(selectedPath, activeViewState);
    }
  } catch (error) {
    errorText = describeError(STRINGS.treeOperationFailed, error);
  }
}

async function revealTreeEntry(path: string) {
  if (vault === null) return;
  try {
    await treeEntryReveal(vault, path);
  } catch (error) {
    errorText = describeError(STRINGS.treeOperationFailed, error);
  }
}

function focusContent() {
  if (contentView === VIEW_CANVAS) {
    canvasViewer?.focus();
  } else {
    editor?.getView()?.focus();
  }
}

function focusReadingSurface() {
  contentHost?.focus({ preventScroll: true });
}

function captureContentHost(node: HTMLElement, paneId: string) {
  if (paneId === workspace.focusedPaneId) contentHost = node;
  return {
    update(nextPaneId: string) {
      if (nextPaneId === workspace.focusedPaneId) contentHost = node;
    },
    destroy() {
      if (contentHost === node) contentHost = undefined;
    },
  };
}

function closeOverlay() {
  activeOverlay = null;
  restoreSurfaceFocus();
}

function commandContext(): CommandContext {
  return {
    view: editor?.getView() ?? null,
    openNote: (path) => navigateToNote(path),
    openNoteInNewTab: (path) => navigateToNote(path, undefined, "new-tab"),
    createNote: createNewNote,
    openVault: () => pickVault(),
    openView: (id) => {
      if (id === VIEW_OUTLINE) {
        refreshOutline();
        if (narrowViewport) {
          openSheet("outline");
        } else {
          outlineOpen = true;
        }
      } else if (id === VIEW_FILE_TREE) {
        if (narrowViewport) {
          openSheet("file-tree");
        } else {
          workspace.sidebarCollapsed = false;
          void tick().then(focusFileTree);
        }
      } else {
        if (id === VIEW_SETTINGS) targetSetting = null;
        openOverlay(id);
      }
    },
    openCommandSurface,
    openSetting,
    toggleView: (id) => {
      if (id === VIEW_OUTLINE) {
        if (narrowViewport) {
          if (activeSheet === "outline") {
            closeSheet();
          } else {
            refreshOutline();
            openSheet("outline");
          }
        } else {
          outlineOpen = !outlineOpen;
        }
        if (!narrowViewport && outlineOpen) {
          refreshOutline();
        }
      } else if (activeOverlay === id) {
        closeOverlay();
      } else {
        openOverlay(id);
      }
    },
    closeSurfaces: closeOverlay,
    requestSave: () => {
      void editor?.requestSave();
    },
    clearEditHistory,
    notePaths: () => notePathsOf(tree),
    recentNotePaths: () => recents,
    navigateBack: () => paneNavigate(-1),
    navigateForward: () => paneNavigate(1),
    followLink: followLinkUnderCursor,
    copyNoteLink,
    copyPermalink,
    createTreeNote,
    createTreeFolder,
    renameTreeEntry,
    deleteTreeEntry,
    moveTreeEntry,
    copyTreeNoteLink: (path) => writeLink({ path }),
    revealTreeEntry,
    togglePanel,
    createTab: createNewNote,
    closeTab: () => closeWorkspaceTab(),
    reopenClosedTab: reopenClosedWorkspaceTab,
    cycleTab: cycleWorkspaceTab,
    activateTab: activateWorkspaceTabIndex,
    splitPane: (side) => splitFocusedPane(side),
    focusPane: focusWorkspacePaneDirection,
    moveTabToPane: (direction) => moveTabToPaneDirection(direction),
    copyHeadingLink,
    openNoteStatistics,
    addProperty: () => editor?.startAddProperty(),
    toggleSourceMode: () => {
      if (note === null) {
        return false;
      }
      sourceMode = !sourceMode;
      return true;
    },
    taskStatusMarkerFrom: taskStatusSurfaceMarker,
    ...(hasDesktopRuntime()
      ? { changeApplicationZoom: applyApplicationZoom }
      : {}),
  };
}

async function clearEditHistory(): Promise<void> {
  if (
    editor === undefined ||
    editor === null ||
    note === null ||
    selectedPath === null
  )
    return;
  const testConfirmed = (
    window as Window & { __SKRIBEUM_E2E_CONFIRM_EDIT_HISTORY__?: boolean }
  ).__SKRIBEUM_E2E_CONFIRM_EDIT_HISTORY__;
  const confirmed =
    testConfirmed === true ||
    (await showConfirmDialog({
      title: STRINGS.commandClearEditHistory,
      message: STRINGS.clearEditHistoryConfirmation,
      confirmLabel: STRINGS.clearEditHistoryConfirmAction,
      cancelLabel: STRINGS.clearEditHistoryCancelAction,
      destructive: true,
    }));
  if (!confirmed) return;
  try {
    await editor.clearEditHistory();
  } catch (error) {
    onWriteError(error instanceof IpcError ? error.app.message : String(error));
  }
}

let applicationZoomQueue = Promise.resolve();
function applyApplicationZoom(action: "in" | "out" | "reset"): Promise<void> {
  applicationZoomQueue = applicationZoomQueue
    .catch(() => {})
    .then(async () => {
      await settingsStore.load();
      const current = settingsStore.snapshot.document.zoom_percent;
      const requested =
        action === "reset"
          ? 100
          : Math.max(50, Math.min(200, current + (action === "in" ? 10 : -10)));
      const zoomPercent = await zoomSet(requested);
      settingsStore.applyExternal({ zoom_percent: zoomPercent });
    });
  return applicationZoomQueue;
}

const onGlobalKeydown = globalKeydownHandler(registry, commandContext);
const SPLIT_COMMAND_IDS = new Set(
  (["up", "down", "left", "right"] as const).flatMap((side) => [
    `pane.split-${side}`,
    `pane.focus-${side}`,
    `pane.move-tab-${side}`,
  ]),
);
const actionCommands = $derived(
  registry
    .pointerCommands("action-menu")
    .filter((command) => !narrowViewport || !SPLIT_COMMAND_IDS.has(command.id)),
);
/**
 * Why one pane command cannot run right now, keyed by command id. The
 * action menu and the command surface both read it, so an unavailable
 * command reads the same way wherever it is listed instead of running and
 * doing nothing.
 */
const paneCommandUnavailability = $derived.by((): Map<string, string> => {
  const reasons = new Map<string, string>();
  if (narrowViewport) return reasons;
  void workspace.layout;
  void paneExtents;
  const focused = workspace.focusedPaneId;
  for (const side of ["up", "down", "left", "right"] as const) {
    const split = splitUnavailableReason(focused, side);
    if (split !== null) reasons.set(`pane.split-${side}`, split);
    const move = moveTabUnavailableReason(side);
    if (move !== null) reasons.set(`pane.move-tab-${side}`, move);
  }
  return reasons;
});

const vaultOpenCommand = registry.command("vault.open");
const overflowCommands = $derived([
  {
    command: registry.command("quick-switcher.open"),
    label: STRINGS.quickSwitcherLabel,
  },
  {
    command: registry.command("vault-search.open"),
    label: STRINGS.mobileSearch,
  },
  {
    command: registry.command("palette.open"),
    label: STRINGS.commandPaletteLabel,
  },
]);

function noteOpensWithHeading(source: string): boolean {
  const [first = "", second = ""] = source.split(/\r?\n/u, 2);
  return (
    /^ {0,3}#{1,6}(?:[\t ]|$)/u.test(first) ||
    (first.trim().length > 0 && /^ {0,3}(?:=+|-+)[\t ]*$/u.test(second))
  );
}

const shellTitle = $derived(
  note !== null && selectedPath !== null
    ? resolveNoteTitle({ path: selectedPath, source: currentNoteSource })
        .displayTitle
    : STRINGS.appTitle,
);
const shellTitleVisible = $derived(note === null || noteTitleVisible);

function currentTaskStatusMarker(
  focusTarget: EventTarget | null = document.activeElement,
): number | null {
  const view = editor?.getView();
  return view === undefined
    ? null
    : taskStatusMarkerForContext(view, focusTarget);
}

function prepareOverflowContext(
  focusTarget: EventTarget | null = document.activeElement,
  contextTarget: EventTarget | null = document.activeElement,
) {
  if (focusTarget instanceof HTMLElement && focusTarget.isConnected) {
    surfaceFocusOrigin = focusTarget;
  }
  taskStatusSurfaceMarker = currentTaskStatusMarker(contextTarget);
  const view = editor?.getView();
  tableCellSurfaceActive =
    view !== undefined && focusedRenderedTableCell(view) !== null;
  overflowContextPrepared = true;
}

function contextualOverflowCommands() {
  const taskCommand = registry.command(TASK_STATUS_MENU_COMMAND);
  return [
    ...(taskCommand !== undefined && taskStatusSurfaceMarker !== null
      ? [taskCommand]
      : []),
    ...(tableCellSurfaceActive
      ? registry
          .pointerCommands("overflow-menu")
          .filter((command) => command.id.startsWith("table."))
      : []),
  ];
}

function formattedCommandKeybinding(
  command: ReturnType<typeof registry.command>,
): string | undefined {
  const binding = command?.keybindings?.[0];
  return binding === undefined
    ? undefined
    : formatKeybinding(binding, macPlatform);
}

function tooltipForCommand(
  id: string,
  fallbackTitle: string,
): CommandTooltipOptions {
  const command = registry.command(id);
  const keybinding = formattedCommandKeybinding(command);
  return {
    title: command?.title ?? fallbackTitle,
    ...(keybinding === undefined ? {} : { keybinding }),
  };
}

$effect(() => {
  if (narrowViewport && outlineOpen) {
    outlineOpen = false;
    refreshOutline();
    openSheet("outline");
  }
  if (narrowViewport && workspace.layout.type === "split") {
    // A split tree shrunk below the breakpoint flattens into one pane, its
    // tabs concatenated in the tree's own order; widening does not restore
    // the tree.
    const focused = focusedWorkspacePane().activePath;
    const flattened = flattenWorkspaceLayout(workspace.layout);
    if (focused !== null) flattened.activePath = focused;
    workspace.layout = flattened;
    workspace.focusedPaneId = flattened.id;
  }
});

$effect(() => {
  if (navigationSurface !== "browser") return;
  const path = focusedWorkspacePane().activePath;
  // The address reports the note the shell is showing, so it follows only
  // once the pane's active tab has actually loaded. A restored workspace
  // names its note, and restores the selected path, before anything opens;
  // until the note itself is loaded the address is still an input, naming
  // the note a `?note=` link asked for.
  if (path === null || note === null || selectedPath !== path) return;
  const current = navigation?.state().address ?? null;
  if (current?.path === path) return;
  navigation?.syncAddress({ path });
});

function runActionCommand(id: string) {
  const context = commandContext();
  activeSheet = null;
  taskStatusSurfaceMarker = null;
  tableCellSurfaceActive = false;
  void tick().then(() => {
    const handled = registry.run(id, context);
    if (
      handled &&
      (id === TASK_STATUS_MENU_COMMAND || id === "table.edit-source")
    ) {
      surfaceFocusOrigin = null;
      return;
    }
    if (activeOverlay === null && activeSheet === null) {
      restoreSurfaceFocus();
    }
  });
}

// Derived from the tree alone: the switcher's candidate list must not be
// rebuilt from every tree entry on each keystroke, which is what made the
// surface take most of a second to appear over a large vault.
const notePaths = $derived(notePathsOf(tree));
const commandSurfacePaths = $derived(commandSurfacePathsOf(tree));
const openWorkspacePaths = $derived(
  workspacePanes.flatMap((pane) => pane.tabs.map((tab) => tab.path)),
);
const parsedOverlayQuery = $derived(parsePickerQuery(overlayQuery));

function visibleCommandItems(query: string): PickerItem[] {
  return commandItems(registry, query, macPlatform)
    .filter((item) => !narrowViewport || !SPLIT_COMMAND_IDS.has(item.value))
    .map((item) => {
      const reason = paneCommandUnavailability.get(item.value);
      return reason === undefined
        ? item
        : { ...item, unavailableReason: reason };
    });
}

const overlayItems = $derived.by((): PickerItem[] => {
  void settingsState.document.task_statuses;
  if (activeOverlay !== VIEW_COMMAND_SURFACE) return [];
  switch (parsedOverlayQuery.mode) {
    case "command":
      return visibleCommandItems(parsedOverlayQuery.query);
    case "file":
      return appendBareDiscoveryItems(
        fileItems(
          commandSurfacePaths,
          recents,
          openWorkspacePaths,
          parsedOverlayQuery.query,
          100,
          treeTitleSources,
        ),
        visibleCommandItems(parsedOverlayQuery.query),
        tagItems(tagCatalogEntries, parsedOverlayQuery.query),
        parsedOverlayQuery.query,
      );
    case "tag":
      return tagItems(tagCatalogEntries, parsedOverlayQuery.query);
    case "text":
      return searchResultItems(searchResults);
  }
});

function onOverlayQuery(query: string) {
  overlayQuery = query;
  const parsed = parsePickerQuery(query);
  clearTimeout(searchDebounce);
  if (parsed.mode === "text") {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      void runVaultSearch(parsed.query);
    }, 200);
  } else {
    searchResults = [];
  }
}

async function runVaultSearch(query: string) {
  if (vault === null || query.length === 0) {
    searchResults = [];
    return;
  }
  try {
    searchResults = await searchQuery(
      vault,
      query,
      settingsState.document.search_result_limit,
      true,
      settingsState.document.search_case_sensitive,
    );
  } catch (error) {
    searchResults = [];
    errorText = describeError(STRINGS.vaultSearchFailed, error);
  }
}

function rememberTag(tag: string) {
  const normalized = tag.startsWith("#") ? tag.slice(1) : tag;
  recentTags = [
    normalized,
    ...recentTags.filter(
      (entry) => entry.toLocaleLowerCase() !== normalized.toLocaleLowerCase(),
    ),
  ].slice(0, 50);
}

function openTagSearch(tag: string) {
  const normalized = tag.startsWith("#") ? tag.slice(1) : tag;
  rememberTag(normalized);
  const query = `#${normalized}`;
  openCommandSurface(`?${query}`);
}

function tagAffordanceOptions(): TagAffordanceOptions {
  return {
    catalog: () => tagCatalogEntries,
    recentTags: () => recentTags,
    search: openTagSearch,
    remember: rememberTag,
  };
}

function setTagCatalog(entries: Awaited<ReturnType<typeof tagCatalog>>) {
  tagCatalogEntries = entries.map((entry) => ({
    tag: entry.tag,
    noteCount: entry.note_count,
    occurrenceCount: entry.occurrence_count,
  }));
}

async function refreshTagCatalog(handle = vault) {
  if (handle === null) {
    return;
  }
  const generation = ++tagCatalogGeneration;
  const vaultGeneration = activeVaultGeneration;
  try {
    const entries = await tagCatalog(handle);
    if (
      generation === tagCatalogGeneration &&
      activeVaultMatches(handle, vaultGeneration)
    ) {
      setTagCatalog(entries);
    }
  } catch {
    // Keep the last indexed catalog when search is temporarily unavailable.
  }
}

async function refreshTreeAfterTagCatalog(handle: VaultHandle) {
  const vaultGeneration = activeVaultGeneration;
  await refreshTagCatalog(handle);
  if (activeVaultMatches(handle, vaultGeneration)) {
    await refreshTree();
  }
}

function onOverlayPick(item: PickerItem, intent?: { newTab?: boolean }) {
  if (item.kind === "command") {
    // Keep the editor's selection stable until editor-scoped commands have
    // consumed it. Restoring focus first can reconcile a browser selection
    // change before the command reads the CodeMirror state.
    activeOverlay = null;
    const context = commandContext();
    taskStatusSurfaceMarker = null;
    tableCellSurfaceActive = false;
    const handled = registry.run(item.value, context);
    if (activeOverlay === null && activeSheet === null) {
      if (handled && item.value === "table.edit-source") {
        surfaceFocusOrigin = null;
        void tick().then(() => editor?.getView()?.focus());
        return;
      }
      if (
        handled &&
        (item.value === "navigation.follow-link" ||
          item.value === TASK_STATUS_MENU_COMMAND)
      ) {
        surfaceFocusOrigin = null;
      } else {
        restoreSurfaceFocus();
      }
    }
  } else if (item.kind === "file") {
    if (item.id.startsWith("text-search:")) {
      overlayQuery = `?${item.value}`;
      void runVaultSearch(item.value);
      return;
    }
    closeOverlay();
    openPath(item.value, { newTab: intent?.newTab === true });
  } else if (item.kind === "tag") {
    rememberTag(item.value);
    overlayQuery = `?#${item.value}`;
    void runVaultSearch(`#${item.value}`);
  } else if (item.kind === "text") {
    closeOverlay();
    void openSearchResult(item.value);
  }
}

/** Opens a search hit and selects its first match in the note. */
async function openSearchResult(path: string) {
  const result = searchResults.find((entry) => entry.path === path);
  await navigateToNote(path);
  const view = editor?.getView();
  const match = result === undefined ? null : firstMatchText(result);
  if (view === undefined || match === null || match.length === 0) {
    return;
  }
  const index = view.state.doc.toString().indexOf(match);
  if (index >= 0) {
    view.dispatch({
      selection: { anchor: index, head: index + match.length },
      scrollIntoView: true,
      userEvent: "select",
    });
  }
  view.focus();
}

function outlineNavigate(from: number) {
  const view = editor?.getView();
  if (view === undefined) {
    return;
  }
  view.dispatch({
    selection: { anchor: from },
    scrollIntoView: true,
    userEvent: "select",
  });
  view.focus();
}

function linkGenerationContext(): WikilinkResolutionContext {
  return {
    ...(linkContext ?? EMPTY_WIKILINK_CONTEXT),
    currentPath: selectedPath,
  };
}

async function writeLink(address: NoteAddress) {
  const link =
    navigationSurface === "browser"
      ? browserLinkForAddress(address, new URL(window.location.href))
      : desktopLinkForAddress(address, linkGenerationContext());
  try {
    await navigator.clipboard.writeText(link);
    announceLinkCopied();
  } catch (error) {
    errorText = describeError(STRINGS.linkCopyFailed, error);
  }
}

async function copyNoteLink() {
  if (selectedPath !== null && notePaths.includes(selectedPath)) {
    await writeLink({ path: selectedPath });
  }
}

async function copyHeadingLink(heading?: string) {
  if (selectedPath === null) return;
  const view = editor?.getView();
  const target =
    heading ??
    (view === undefined
      ? undefined
      : headingAtOrBefore(
          computeOutline(view.state),
          view.state.selection.main.head,
        )?.title);
  if (target !== undefined) {
    await writeLink({ path: selectedPath, fragment: target });
  }
}

/**
 * Copies the active note's stable public permalink, allocating its
 * frontmatter id on first use through the editor's own frontmatter-editing
 * path (`ensurePermalinkId`), so the id round-trips through undo and save
 * exactly like a properties-panel edit. Desktop and the browser demo copy
 * the identical `https://skribeum.app` URL.
 */
async function copyPermalink() {
  if (selectedPath === null || !notePaths.includes(selectedPath)) return;
  const id = editor?.ensurePermalinkId();
  if (id === null || id === undefined) return;
  try {
    await navigator.clipboard.writeText(permalinkUrlForId(id));
    announceLinkCopied(STRINGS.permalinkCopied);
  } catch (error) {
    errorText = describeError(STRINGS.permalinkCopyFailed, error);
  }
}

function copyOutlineHeading(heading: string) {
  registry.run("link.copy-heading", {
    ...commandContext(),
    heading,
  });
}

function onEditorDocChanged(source: string, path: string | null) {
  if (path === selectedPath) {
    currentNoteSource = source;
    if (path !== null)
      treeTitleSources = { ...treeTitleSources, [path]: source };
  }
}

function onEditorOutlineChanged() {
  if (outlineOpen) {
    scheduleOutlineRefresh();
  }
}

/**
 * The dirty/saving state of the focused pane's active tab: `true` while
 * local edits or an in-flight save exist, `false` once autosave has fully
 * landed, `null` when no tab is active. This mirrors TabStrip's unsaved
 * indicator without depending on the tab strip actually rendering it (it
 * only appears once a pane holds more than one tab), so end-to-end tests
 * can wait on the same underlying signal in single-tab scenarios.
 */
function activeTabDirty(): boolean | null {
  const pane = findWorkspaceLeaf(workspace.layout, workspace.focusedPaneId);
  const tab = pane?.tabs.find(
    (candidate) => candidate.path === pane?.activePath,
  );
  return tab?.dirty ?? null;
}

function onEditorDirtyChanged(
  paneId: string,
  path: string | null,
  dirty: boolean,
) {
  if (path === null) return;
  const pane = findWorkspaceLeaf(workspace.layout, paneId);
  const tab = pane?.tabs.find((candidate) => candidate.path === path);
  if (tab !== undefined) tab.dirty = dirty;
}

function pushBanner(banner: Omit<BannerItem, "id">): number {
  nextBannerId += 1;
  banners = [...banners, { ...banner, id: nextBannerId }];
  return nextBannerId;
}

function dismissBanner(id: number) {
  const timer = transientBannerTimers.get(id);
  if (timer !== undefined) clearTimeout(timer);
  transientBannerTimers.delete(id);
  banners = banners.filter((banner) => banner.id !== id);
}

/**
 * Section 6.2 announcement routing: wide viewports use the statusline's
 * center slot, narrow ones keep the status banner because the phone shell
 * carries no statusline.
 */
function announceLinkCopied(text: string = STRINGS.linkCopied) {
  if (!narrowViewport) {
    nextAnnouncementId += 1;
    statuslineAnnouncement = {
      id: nextAnnouncementId,
      text,
    };
    return;
  }
  const id = pushBanner({ text, polite: true });
  transientBannerTimers.set(
    id,
    setTimeout(() => dismissBanner(id), 2000),
  );
}

/** Reads the open note's filesystem timestamps for the statusline. */
async function refreshNoteTimes(handle: VaultHandle, path: string) {
  const generation = ++noteTimesGeneration;
  try {
    const stat = await readNoteStat(handle, path);
    if (noteTimesGeneration !== generation || selectedPath !== path) return;
    noteTimes = { createdMs: stat.created_ms, modifiedMs: stat.modified_ms };
  } catch {
    if (noteTimesGeneration === generation) noteTimes = null;
  }
}

/** Refreshes derived indexes and the last-edited fact after a note save. */
function onEditorSaved() {
  void refreshTagCatalog();
  const currentVault = vault;
  const path = selectedPath;
  if (currentVault !== null && path !== null && hasDesktopRuntime()) {
    void refreshNoteTimes(currentVault, path);
  } else {
    noteTimes = {
      createdMs: noteTimes?.createdMs ?? null,
      modifiedMs: Date.now(),
    };
  }
}

/**
 * The registered "Note statistics" route: the statusline popover on wide
 * viewports, a sheet with the same facts on narrow ones (section 4.16).
 */
function openNoteStatistics() {
  if (selectedPath === null) return;
  if (narrowViewport) {
    openSheet("note-info");
  } else {
    noteInfoOpen = true;
  }
}

function describeError(context: string, error: unknown): string {
  if (error instanceof IpcError) {
    return `${context}: ${error.app.message}`;
  }
  return `${context}: ${String(error)}`;
}

function bannerReasonText(reason: BannerReason): string {
  switch (reason) {
    case "size-shrank":
      return STRINGS.bannerReasonSizeShrank;
    case "became-empty":
      return STRINGS.bannerReasonBecameEmpty;
    case "edit-within-write-settle":
      return STRINGS.bannerReasonEditWithinWriteSettle;
    case "journal-diverged":
      return STRINGS.bannerReasonJournalDiverged;
  }
}

function refreshLinkContext() {
  const activeVault = vault;
  const currentPath = selectedPath;
  linkContext = {
    paths: tree
      .filter((entry) => entry.kind !== "directory")
      .map((entry) => entry.path),
    config: effectiveObsidianConfig(),
    currentPath,
    embedAncestry: currentPath === null ? [] : [currentPath],
    embedDepth: 0,
    linkPreviews: settingsState.document.link_previews,
    ...(activeVault === null
      ? {}
      : {
          loadNote: async (path: string) => {
            try {
              const endToEndDelay = (
                window as Window & {
                  __SKRIBEUM_E2E_CONTENT_DELAY_MS__?: number;
                }
              ).__SKRIBEUM_E2E_CONTENT_DELAY_MS__;
              if (typeof endToEndDelay === "number" && endToEndDelay > 0) {
                await new Promise((resolve) =>
                  setTimeout(resolve, endToEndDelay),
                );
              }
              const bytes = await readVaultFile(activeVault, path);
              const content =
                bytes.length >= 3 &&
                bytes[0] === 0xef &&
                bytes[1] === 0xbb &&
                bytes[2] === 0xbf
                  ? bytes.subarray(3)
                  : bytes;
              return new TextDecoder("utf-8", { fatal: false }).decode(content);
            } catch {
              return null;
            }
          },
        }),
  };
}

function effectiveObsidianConfig(): ObsidianAppConfig {
  const documentSettings = settingsState.document;
  const base = documentSettings.honor_obsidian_config
    ? obsidianConfig
    : DEFAULT_OBSIDIAN_APP_CONFIG;
  if (base.attachmentFolderPath !== null) {
    return base;
  }
  const attachmentFolderPath = (() => {
    switch (documentSettings.attachment_folder_mode) {
      case "note":
        return "./";
      case "folder":
        return documentSettings.attachment_folder_path;
      default:
        return "/";
    }
  })();
  return { ...base, attachmentFolderPath };
}

/**
 * Reads the optional `.obsidian` configuration (link knobs, declared
 * property types) read-only through the `vault_config_read` command.
 * Absent files leave the defaults; nothing is ever written.
 */
async function loadObsidianConfig(handle: VaultHandle) {
  if (!settingsState.document.honor_obsidian_config) {
    return { config: DEFAULT_OBSIDIAN_APP_CONFIG, types: null };
  }
  const [appJson, typesJson] = await Promise.all([
    readOptionalVaultConfigFile(handle, "app.json"),
    readOptionalVaultConfigFile(handle, "types.json"),
  ]);
  return {
    config:
      appJson === null
        ? DEFAULT_OBSIDIAN_APP_CONFIG
        : parseObsidianAppConfig(appJson),
    types: typesJson === null ? null : parseObsidianTypes(typesJson),
  };
}

async function readObsidianConfig(handle: VaultHandle) {
  const generation = ++obsidianReadGeneration;
  const vaultGeneration = activeVaultGeneration;
  const next = await loadObsidianConfig(handle);
  if (
    generation !== obsidianReadGeneration ||
    !activeVaultMatches(handle, vaultGeneration) ||
    !settingsState.document.honor_obsidian_config
  ) {
    return;
  }
  obsidianConfig = next.config;
  propertyTypes = next.types;
  refreshLinkContext();
}

async function readOptionalVaultConfigFile(
  handle: VaultHandle,
  name: "app.json" | "types.json",
): Promise<string | null> {
  try {
    return await readVaultConfigFile(handle, name);
  } catch {
    return null;
  }
}

/**
 * Resolves a `?n=<permalink id>` browser URL to its note path by scanning
 * the just-opened vault's frontmatter, then rewrites the URL to the
 * ordinary `?note=<path>` form so the existing address-from-URL routing
 * picks it up unchanged. An id that matches no note falls back gracefully
 * to normal landing: the parameter is dropped and routing proceeds as if
 * it had never been present.
 */
async function resolvePermalinkNavigation(
  handle: VaultHandle,
  entries: TreeEntry[],
): Promise<void> {
  const url = new URL(window.location.href);
  const id = url.searchParams.get(PERMALINK_ID_PARAMETER);
  if (id === null) {
    return;
  }
  url.searchParams.delete(PERMALINK_ID_PARAMETER);
  const resolved = await resolveNoteId(
    id,
    notePathsOf(entries),
    async (notePath) => {
      const bytes = await readVaultFile(handle, notePath);
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    },
  );
  if (resolved !== null) {
    url.searchParams.set(NOTE_ADDRESS_PARAMETER, resolved);
  }
  window.history.replaceState(window.history.state, "", url);
}

async function openVaultAtPath(
  path: string,
  initialNote?: string,
  reportError = true,
  isCurrent: () => boolean = () => true,
): Promise<unknown | null> {
  errorText = null;
  tagCatalogGeneration += 1;
  if ((await editor?.flush()) === false) {
    errorText = STRINGS.contentSwitchUnsaved;
    return new Error(errorText);
  }
  const request = contentRequests.next();
  const replacement = await vaultOwnership.replace(
    path,
    async (session) => {
      const [nextTree, config, , nextTags] = await Promise.all([
        vaultTree(session.handle),
        loadObsidianConfig(session.handle),
        watchSubscribe(session.handle),
        tagCatalog(session.handle).catch(() => []),
      ]);
      if (navigationSurface === "browser") {
        await resolvePermalinkNavigation(session.handle, nextTree);
      }
      return { nextTree, config, nextTags };
    },
    (session, prepared) => {
      const { nextTree, config, nextTags } = prepared;
      vault = session.handle;
      activeVaultGeneration = session.generation;
      activeVaultPath = session.root;
      workspaceIdentity = session.root;
      workspace = loadWorkspaceState(session.root);
      outlineOpen = !workspace.outlineCollapsed;
      tree = nextTree;
      selectedPath = workspace.selectedPath;
      treeTitleSources = {};
      void loadTreeTitles(session.handle, nextTree);
      note = null;
      currentNoteSource = "";
      sourceMode = false;
      missingAddress = null;
      contentView = null;
      canvas = null;
      canvasError = null;
      obsidianConfig = config.config;
      propertyTypes = config.types;
      setTagCatalog(nextTags);
      recentTags = [];
      refreshLinkContext();
    },
    () => contentRequests.isCurrent(request) && isCurrent(),
  );
  if (replacement.kind === "superseded") {
    return new Error("The vault open request was superseded.");
  }
  if (replacement.kind === "failed") {
    if (reportError)
      errorText = describeError(STRINGS.vaultOpenFailed, replacement.error);
    return replacement.error;
  }
  const { session } = replacement;
  try {
    if (!activeVaultMatches(session.handle, session.generation)) {
      return new Error("The vault open request was superseded.");
    }
    const harnessNote = (window as Window & { __SKRIBEUM_E2E_NOTE__?: string })
      .__SKRIBEUM_E2E_NOTE__;
    const addressed = navigation?.state().address ?? null;
    if (initialNote !== undefined) {
      if (navigationSurface === "browser")
        await navigation?.reset({ path: initialNote });
      else await navigateToNote(initialNote);
    } else if (
      navigationSurface === "desktop" &&
      focusedWorkspacePane().activePath !== null &&
      notePathsOf(tree).includes(focusedWorkspacePane().activePath ?? "")
    ) {
      const pane = focusedWorkspacePane();
      const path = pane.activePath;
      if (path !== null) {
        const tab = ensurePaneTab(pane, path);
        await openNote(path, tab.viewState);
        updatePaneNavigationState();
      }
    } else if (addressed !== null) {
      // An address that names a note is a request for that note, on a reload
      // as much as on a first visit, so it outranks whatever the restored
      // workspace last showed. The note joins the focused pane's strip
      // instead of replacing a restored tab, so nothing persisted is lost.
      await navigation?.start(addressed);
    } else if (
      navigationSurface === "browser" &&
      focusedWorkspacePane().activePath !== null &&
      notePathsOf(tree).includes(focusedWorkspacePane().activePath ?? "")
    ) {
      // With no note in the address, the restored workspace decides what the
      // focused pane shows and the address bar follows it.
      const pane = focusedWorkspacePane();
      const path = pane.activePath;
      if (path !== null) {
        const tab = ensurePaneTab(pane, path);
        await openNote(path, tab.viewState);
        navigation?.syncAddress({ path });
        updatePaneNavigationState();
      }
    } else if (typeof harnessNote === "string") {
      if (navigationSurface === "browser")
        await navigation?.start({ path: harnessNote });
      else await navigateToNote(harnessNote);
    }
    return null;
  } catch (error) {
    if (!activeVaultMatches(session.handle, session.generation)) {
      return new Error("The vault open request was superseded.");
    }
    if (reportError) errorText = describeError(STRINGS.vaultOpenFailed, error);
    return error;
  }
}

function comparableNativePath(path: string): string {
  const normalized = path.replace(/[\\/]+$/u, "");
  return /Win/u.test(navigator.platform)
    ? normalized.toLocaleLowerCase()
    : normalized;
}

async function handleNativeOpen(path: string): Promise<boolean> {
  try {
    const target = await fileOpenResolve(path);
    if (
      vault !== null &&
      activeVaultPath !== null &&
      comparableNativePath(activeVaultPath) ===
        comparableNativePath(target.vault_path)
    ) {
      await refreshTreeIndex();
      await navigateToNote(target.note_path);
    } else {
      return (
        (await openVaultAtPath(target.vault_path, target.note_path)) === null
      );
    }
    return true;
  } catch {
    errorText = STRINGS.fileOpenFailed;
    return false;
  }
}

let nativeOpenIntent = false;
const nativeOpenQueue = new NativeOpenQueue(async () => {
  while (true) {
    const paths = await openFilesTake();
    if (paths.length === 0) return;
    for (const path of paths) await handleNativeOpen(path);
  }
});

function drainNativeOpenFiles(): Promise<void> {
  return nativeOpenQueue.enqueue();
}

async function recoverStartupVault(
  session: VaultStartupSession,
  isCurrent: () => boolean,
): Promise<void> {
  if (!isCurrent()) return;
  const decision = nextStartupDecision(session);
  if (decision.kind === "surface") {
    startupVaultSurface = decision.surface;
    return;
  }

  const failure = await openVaultAtPath(
    decision.path,
    undefined,
    false,
    isCurrent,
  );
  if (!isCurrent()) return;
  if (failure === null) return;
  errorText = null;
  if (failure instanceof IpcError && isStaleVaultOpenError(failure.app.code)) {
    try {
      const nextSession = await vaultSessionForget(decision.path);
      if (!isCurrent()) return;
      const next = nextStartupDecision(nextSession);
      if (next.kind === "surface") {
        startupVaultSurface = next.surface;
        return;
      }
      const fallbackFailure = await openVaultAtPath(
        next.path,
        undefined,
        false,
        isCurrent,
      );
      if (!isCurrent() || fallbackFailure === null) return;
      startupVaultSurface = failedStartupSurface(
        nextSession,
        next.path,
        describeError(STRINGS.vaultOpenFailed, fallbackFailure),
      );
    } catch (forgetError) {
      if (!isCurrent()) return;
      startupVaultSurface = emptyStartupSurface(
        describeError(STRINGS.vaultOpenFailed, forgetError),
      );
    }
    return;
  }
  startupVaultSurface = failedStartupSurface(
    session,
    decision.path,
    describeError(STRINGS.vaultOpenFailed, failure),
  );
}

async function openStartupVault(path?: string): Promise<void> {
  if (path === undefined) {
    await pickVault();
    return;
  }
  const failure = await openVaultAtPath(path, undefined, false);
  if (failure === null) return;
  errorText = null;
  const error = describeError(STRINGS.vaultOpenFailed, failure);
  if (
    !(failure instanceof IpcError && isStaleVaultOpenError(failure.app.code))
  ) {
    startupVaultSurface = selectedStartupFailureSurface(
      startupVaultSurface,
      path,
      error,
    );
    return;
  }
  try {
    const nextSession = await vaultSessionForget(path);
    const next = staleChooserStartupDecision(nextSession);
    if (next.kind === "surface") {
      startupVaultSurface = next.surface;
      return;
    }
    const fallbackFailure = await openVaultAtPath(next.path, undefined, false);
    if (fallbackFailure === null) return;
    startupVaultSurface = failedStartupSurface(
      nextSession,
      next.path,
      describeError(STRINGS.vaultOpenFailed, fallbackFailure),
    );
  } catch (forgetError) {
    startupVaultSurface = selectedStartupFailureSurface(
      startupVaultSurface,
      path,
      describeError(STRINGS.vaultOpenFailed, forgetError),
    );
  }
}

async function startDesktopVaultRecovery(
  webdriverVault: string | undefined,
): Promise<void> {
  try {
    await startupVaultRecoverySequence(webdriverVault);
  } finally {
    settleStartupVaultSource("recovery");
  }
}

async function startupVaultRecoverySequence(
  webdriverVault: string | undefined,
): Promise<void> {
  const source = startupSource({
    desktop: navigationSurface === "desktop" && hasDesktopRuntime(),
    ...(webdriverVault === undefined ? {} : { webdriverVault }),
  });
  if (source.kind === "browser") {
    startupVaultSurface = emptyStartupSurface();
    return;
  }
  if (source.kind === "webdriver") {
    const failure = await openEndToEndVault(source.path);
    if (failure !== null) {
      errorText = null;
      startupVaultSurface = emptyStartupSurface(
        describeError(STRINGS.vaultOpenFailed, failure),
      );
    }
    return;
  }

  await drainNativeOpenFiles();
  if (nativeOpenIntent) {
    if (vault === null) {
      startupVaultSurface = emptyStartupSurface(errorText ?? undefined);
      errorText = null;
    }
    return;
  }
  if (vault !== null) return;
  const recoveryEpoch = startupRecoveryGuard.beginRecovery();
  if (recoveryEpoch === null) return;
  try {
    const session = await vaultSessionRead();
    if (!startupRecoveryGuard.isRecoveryCurrent(recoveryEpoch)) return;
    await recoverStartupVault(session, () =>
      startupRecoveryGuard.isRecoveryCurrent(recoveryEpoch),
    );
  } catch (error) {
    if (!startupRecoveryGuard.isRecoveryCurrent(recoveryEpoch)) return;
    startupVaultSurface = emptyStartupSurface(
      describeError(STRINGS.vaultOpenFailed, error),
    );
  }
}

async function pickVault() {
  const path = await openDirectoryDialog({ directory: true, multiple: false });
  if (path === null) {
    return;
  }
  await openVaultAtPath(path);
}

function openEndToEndVault(path: string): Promise<unknown | null> {
  return endToEndVaultStartup.run(path, () => openVaultAtPath(path));
}

async function refreshTree() {
  const currentVault = vault;
  if (currentVault === null) {
    return;
  }
  const vaultGeneration = activeVaultGeneration;
  try {
    const nextTree = await vaultTree(currentVault);
    if (!activeVaultMatches(currentVault, vaultGeneration)) {
      return;
    }
    tree = nextTree;
    void loadTreeTitles(currentVault, nextTree);
    refreshLinkContext();
  } catch (error) {
    errorText = describeError(STRINGS.vaultOpenFailed, error);
  }
}

function isMissingNoteError(error: unknown): boolean {
  return (
    error instanceof IpcError &&
    (error.app.code === "note/not-found" ||
      error.app.code === "vault/path-not-found")
  );
}

async function openNote(
  path: string,
  restoration: NoteViewState | null = null,
  switchKind: PaneSwitchKind = "note",
): Promise<boolean> {
  const currentVault = vault;
  if (currentVault === null) {
    return false;
  }
  const vaultGeneration = activeVaultGeneration;
  const request = contentRequests.next();
  errorText = null;
  // Persist pending edits of the current note before switching away.
  if ((await editor?.flush()) === false) {
    errorText = STRINGS.contentSwitchUnsaved;
    return false;
  }
  historyViewState = restoration;
  const debugWindow = window as Window & {
    __SKRIBEUM_DEBUG_NOTE_OPEN_MS__?: number;
    __SKRIBEUM_DEBUG_PERF__?: boolean;
  };
  const debugStart = debugWindow.__SKRIBEUM_DEBUG_PERF__
    ? performance.now()
    : undefined;
  delete debugWindow.__SKRIBEUM_DEBUG_NOTE_OPEN_MS__;
  try {
    const loaded = await readNote(currentVault, path);
    if (
      !activeVaultMatches(currentVault, vaultGeneration) ||
      !contentRequests.isCurrent(request)
    ) {
      return false;
    }
    const recovered = pendingRecovered.get(path);
    if (recovered !== undefined) {
      pendingRecovered.delete(path);
      loaded.recoveredChangeSet = recovered;
      pushBanner({ text: STRINGS.noteRecoveredNotice });
    }
    if (
      (switchKind !== "note" || selectedPath !== path) &&
      editor !== undefined &&
      editor !== null
    ) {
      // Every pane switch fades its incoming content in over an already
      // composed frame (section 5.1), including the very first note a
      // freshly opened vault or URL-addressed note loads: hiding the
      // outgoing frame here, before the note swap below, is what keeps
      // that first paint from ever showing an intermediate state.
      editor.preparePaneSwitch(switchKind);
    }
    noteTitleVisible = !noteOpensWithHeading(loaded.text);
    currentNoteSource = loaded.text;
    sourceMode = false;
    note = loaded;
    noteTimes = null;
    editorStatistics = null;
    persistenceState = { kind: "saved" };
    missingAddress = null;
    contentView = null;
    canvas = null;
    canvasError = null;
    selectedPath = path;
    void refreshNoteTimes(currentVault, path);
    const pane = focusedWorkspacePane();
    ensurePaneTab(pane, path);
    pane.emptyTab = false;
    pane.activePath = path;
    refreshLinkContext();
    recents = [path, ...recents.filter((entry) => entry !== path)].slice(0, 50);
    await tick();
    if (outlineOpen) {
      refreshOutline();
    }
    if (debugStart !== undefined) {
      debugWindow.__SKRIBEUM_DEBUG_NOTE_OPEN_MS__ =
        performance.now() - debugStart;
    }
    return true;
  } catch (error) {
    if (
      !activeVaultMatches(currentVault, vaultGeneration) ||
      !contentRequests.isCurrent(request)
    ) {
      return false;
    }
    if (isMissingNoteError(error)) {
      note = null;
      currentNoteSource = "";
      sourceMode = false;
      contentView = null;
      canvas = null;
      canvasError = null;
      selectedPath = null;
      missingAddress = { path };
      return false;
    }
    errorText = describeError(STRINGS.noteReadFailed, error);
    return false;
  }
}

async function openNoteAddress(
  address: NoteAddress,
  restoration: NoteViewState | null = null,
  source: "fresh" | "history" = "fresh",
): Promise<boolean> {
  const editorWasFocused = editor?.getView()?.hasFocus === true;
  if (editorWasFocused || source === "history") focusReadingSurface();
  const opened = await openNote(
    address.path,
    restoration,
    source === "history" ? "history" : "note",
  );
  if (!opened) {
    if (missingAddress !== null) {
      missingAddress = address;
      if (source === "history") focusReadingSurface();
      return true;
    }
    return false;
  }
  if (source === "history") {
    await tick();
    focusReadingSurface();
    requestAnimationFrame(() => focusReadingSurface());
    return true;
  }
  if (address.fragment === undefined) {
    if (editorWasFocused) focusReadingSurface();
    return true;
  }
  await tick();
  const view = editor?.getView();
  if (view === undefined) {
    return false;
  }
  const position = noteFragmentPosition(view.state, address.fragment);
  if (position !== null) {
    view.dispatch({
      selection: { anchor: position },
      scrollIntoView: true,
      userEvent: "select",
    });
  }
  focusReadingSurface();
  return true;
}

/**
 * Opens a note. The default reuses the focused pane's active tab, and
 * switches to an existing tab when the note is already open anywhere, so
 * ordinary navigation never accumulates tabs. `newTab` is the explicit
 * route: a mod-click or middle-click, an "Open in new tab" menu item, or
 * the command surface's new-tab file action.
 */
async function navigateToNote(
  path: string,
  fragment?: string,
  intent: "in-place" | "new-tab" = "in-place",
): Promise<void> {
  const address = fragment === undefined ? { path } : { path, fragment };
  if (intent === "in-place") {
    const holder = paneHoldingPath(path);
    if (holder !== null && holder.id !== workspace.focusedPaneId) {
      await focusWorkspacePane(holder.id);
      await activateWorkspaceTab(path);
      if (fragment !== undefined) await openNoteAddress(address, null);
      return;
    }
  }
  captureFocusedTabState();
  const pane = focusedWorkspacePane();
  // The tab is placed before the note loads: the load itself only ensures a
  // tab exists, so placing afterwards would find the one it just added and
  // leave the replaced tab behind.
  if (intent === "new-tab") placeTabBeside(pane, path);
  else placeTabInPlace(pane, path);
  if (navigationSurface === "browser") {
    await (navigation?.open(address) ?? openNoteAddress(address));
    pane.activePath = path;
    return;
  }
  const tab = pane.tabs.find((candidate) => candidate.path === path);
  const opened = await openNoteAddress(address, tab?.viewState ?? null);
  if (opened) {
    pane.activePath = path;
    pushPaneHistory(pane, address);
  }
}

function wikilinkNavigationOptions(): FollowWikilinkOptions {
  const view = editor?.getView();
  const context =
    view === undefined
      ? (linkContext ?? EMPTY_WIKILINK_CONTEXT)
      : currentWikilinkContext(view.state);
  return {
    context: { ...context, currentPath: selectedPath },
    currentPath: selectedPath,
    navigate: async (address, intent) => {
      focusReadingSurface();
      try {
        await navigateToNote(
          address.path,
          address.fragment,
          intent?.newTab === true ? "new-tab" : "in-place",
        );
      } finally {
        focusReadingSurface();
        requestAnimationFrame(() => focusReadingSurface());
        setTimeout(focusReadingSurface, 0);
      }
    },
    unresolved: (reason) => {
      pushBanner({ text: reason });
    },
    openExternal: async (url) => {
      try {
        await openExternalLink(url, navigationSurface, window);
      } catch {
        pushBanner({ text: STRINGS.externalLinkOpenFailed });
      }
    },
  };
}

function followLinkUnderCursor(
  activeView = editor?.getView() ?? null,
): boolean {
  const view = activeView;
  if (view === null) {
    return false;
  }
  return followEditorLinkUnderCursor(view, wikilinkNavigationOptions());
}

async function refreshMissingNote() {
  const address = missingAddress;
  if (address === null) {
    return;
  }
  await refreshTree();
  await openNoteAddress(address);
}

function decodeFile(bytes: Uint8Array): string {
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return decoded.length > 100_000
    ? `${decoded.slice(0, 100_000)}\n${STRINGS.canvasPreviewTruncated}`
    : decoded;
}

function decodeCanvas(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function openCanvas(path: string) {
  const currentVault = vault;
  if (currentVault === null) {
    return;
  }
  const request = contentRequests.next();
  errorText = null;
  if ((await editor?.flush()) === false) {
    errorText = STRINGS.contentSwitchUnsaved;
    return;
  }
  try {
    const parsed = parseCanvas(
      decodeCanvas(await readVaultFile(currentVault, path)),
    );
    const previews = await Promise.all(
      canvasFilePaths(parsed).map(async (file) => {
        try {
          return [
            file,
            decodeFile(await readVaultFile(currentVault, file)),
          ] as const;
        } catch {
          return [file, STRINGS.canvasFileUnavailable] as const;
        }
      }),
    );
    if (vault !== currentVault || !contentRequests.isCurrent(request)) {
      return;
    }
    note = null;
    currentNoteSource = "";
    sourceMode = false;
    canvas = parsed;
    canvasPreviews = Object.fromEntries(previews);
    canvasError = null;
    contentView = VIEW_CANVAS;
    selectedPath = path;
    outlineOpen = false;
    await tick();
    canvasViewer?.focus();
  } catch (error) {
    if (vault !== currentVault || !contentRequests.isCurrent(request)) {
      return;
    }
    note = null;
    currentNoteSource = "";
    sourceMode = false;
    canvas = null;
    canvasPreviews = {};
    canvasError = `${STRINGS.canvasParseFailed}: ${String(error)}`;
    contentView = VIEW_CANVAS;
    selectedPath = path;
  }
}

/**
 * Serializes and durably writes the open canvas document. Never touches
 * local state itself: callers apply their own optimistic update first and
 * roll it back when this reports failure.
 */
async function persistCanvas(
  path: string,
  next: CanvasDocument,
): Promise<boolean> {
  const currentVault = vault;
  if (currentVault === null) return false;
  try {
    await writeVaultFile(
      currentVault,
      path,
      new TextEncoder().encode(serializeCanvas(next)),
    );
    return true;
  } catch (error) {
    errorText = describeError(STRINGS.canvasWriteFailed, error);
    return false;
  }
}

/** Moves one card to a new world-space position and persists the board. */
async function moveCanvasNode(nodeId: string, x: number, y: number) {
  const current = canvas;
  const path = selectedPath;
  if (current === null || path === null) return;
  const next: CanvasDocument = {
    ...current,
    nodes: current.nodes.map((node) =>
      node.id === nodeId ? { ...node, x, y } : node,
    ),
  };
  canvas = next;
  // Only roll back onto the board still open when the write settles: the
  // view may have navigated to a different note or canvas while the write
  // was in flight, and that canvas's own state must never be clobbered by
  // a failure that belongs to the one this mutation started on.
  if (!(await persistCanvas(path, next)) && selectedPath === path) {
    canvas = current;
  }
}

/**
 * Removes one card and any edge touching it, and persists the board. The
 * underlying note file is never touched: this only edits the board.
 */
async function removeCanvasNode(nodeId: string) {
  const current = canvas;
  const path = selectedPath;
  if (current === null || path === null) return;
  const next: CanvasDocument = {
    nodes: current.nodes.filter((node) => node.id !== nodeId),
    edges: current.edges.filter(
      (edge) => edge.fromNode !== nodeId && edge.toNode !== nodeId,
    ),
  };
  canvas = next;
  if (!(await persistCanvas(path, next)) && selectedPath === path) {
    canvas = current;
  }
}

function canvasNotePaths(document: CanvasDocument): Set<string> {
  return new Set(
    document.nodes
      .filter(
        (node): node is Extract<CanvasNode, { type: "file" }> =>
          node.type === "file",
      )
      .map((node) => node.file),
  );
}

/**
 * Prompts for an existing vault note's path and adds it to the open board
 * as a new card, positioned to the right of the current rightmost card.
 */
async function addCanvasNode() {
  const currentVault = vault;
  const current = canvas;
  const canvasPath = selectedPath;
  if (currentVault === null || current === null || canvasPath === null) {
    return;
  }
  const onCanvas = canvasNotePaths(current);
  const entered = await showPromptDialog({
    title: STRINGS.canvasAddCard,
    inputLabel: STRINGS.canvasAddCardPrompt,
    confirmLabel: STRINGS.createAction,
    validate: (value) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) return null;
      const entry = tree.find((candidate) => candidate.path === trimmed);
      if (entry === undefined || entry.kind !== "note") {
        return STRINGS.canvasAddCardNotFound;
      }
      if (onCanvas.has(trimmed)) {
        return STRINGS.canvasAddCardDuplicate;
      }
      return null;
    },
  });
  const path = entered?.trim();
  if (path === undefined || path === "") return;
  let previewText: string;
  try {
    previewText = decodeFile(await readVaultFile(currentVault, path));
  } catch {
    previewText = STRINGS.canvasFileUnavailable;
  }
  const { x, y } = nextCanvasNodePosition(current);
  const node: CanvasNode = {
    id: nextCanvasNodeId(current),
    type: "file",
    file: path,
    x,
    y,
    width: 360,
    height: 280,
  };
  const next: CanvasDocument = {
    nodes: [...current.nodes, node],
    edges: current.edges,
  };
  const previousPreviews = canvasPreviews;
  canvas = next;
  canvasPreviews = { ...canvasPreviews, [path]: previewText };
  if (!(await persistCanvas(canvasPath, next)) && selectedPath === canvasPath) {
    canvas = current;
    canvasPreviews = previousPreviews;
  }
}

function openPath(path: string, options?: { newTab?: boolean }) {
  if (activeSheet === "file-tree") {
    closeSheet();
  }
  if (path.toLowerCase().endsWith(".canvas")) {
    void openCanvas(path);
  } else {
    void navigateToNote(
      path,
      undefined,
      options?.newTab === true ? "new-tab" : "in-place",
    );
  }
}

/**
 * Review action for reconciliation banners: re-reads the note. When it is
 * the open note, the re-read rebases the editing session in place, keeping
 * cursor and pending edits; otherwise it opens the note.
 */
async function reviewPath(path: string, bannerId: number) {
  dismissBanner(bannerId);
  if (vault === null) {
    return;
  }
  if (path === selectedPath && note !== null && !note.readOnly) {
    const currentVault = vault;
    const request = contentRequests.next();
    try {
      const loaded = await readNote(currentVault, path);
      if (
        vault !== currentVault ||
        selectedPath !== path ||
        !contentRequests.isCurrent(request)
      ) {
        return;
      }
      editor?.reconcileWith(loaded);
    } catch (error) {
      if (vault !== currentVault || !contentRequests.isCurrent(request)) {
        return;
      }
      errorText = describeError(STRINGS.noteReadFailed, error);
    }
    return;
  }
  await navigateToNote(path);
}

function onConflict() {
  if (selectedPath === null) {
    return;
  }
  const path = selectedPath;
  pushBanner({ text: STRINGS.conflictBanner, paths: [path] });
}

function onWriteError(message: string) {
  errorText = `${STRINGS.noteWriteFailed}: ${message}`;
}

function setEndToEndSelection(anchor: number): boolean {
  const view = editor?.getView();
  if (view === undefined) return false;
  view.dispatch({
    selection: {
      anchor: Math.max(0, Math.min(anchor, view.state.doc.length)),
    },
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

function setEndToEndSelectionAtLineEnd(lineText: string): number | null {
  const view = editor?.getView();
  if (view === undefined) return null;
  for (
    let lineNumber = 1;
    lineNumber <= view.state.doc.lines;
    lineNumber += 1
  ) {
    const line = view.state.doc.line(lineNumber);
    if (line.text === lineText || line.text.endsWith(lineText)) {
      view.dispatch({
        selection: { anchor: line.to },
        scrollIntoView: true,
      });
      view.focus();
      return line.to;
    }
  }
  return null;
}

function setEndToEndSelectionFromLastMatch(
  sourceText: string,
  relativeOffset: number,
  relativeSelectionLength = 0,
): number | null {
  const view = editor?.getView();
  if (view === undefined) return null;
  const start = view.state.doc.toString().lastIndexOf(sourceText);
  if (start < 0) return null;
  const docLength = view.state.doc.length;
  const anchor = Math.max(start, Math.min(start + relativeOffset, docLength));
  const head = Math.max(
    0,
    Math.min(anchor + relativeSelectionLength, docLength),
  );
  view.dispatch({ selection: { anchor, head }, scrollIntoView: true });
  view.focus();
  return anchor;
}

// The end-to-end seam: webdriver-feature builds announce a scratch vault
// path on the window object (see the page-load hook in src-tauri); release
// builds never set it, which keeps this poll inert outside the test
// harness. Polling covers the race between webview page load and the eval
// that plants the value.
function pollEndToEndVault() {
  let attempts = 0;
  // The announcement is planted before this component mounts, so its absence
  // right now already answers for the reserved sidebar column: nothing is
  // arriving to fill it, and the empty state must not sit beside it while a
  // poll confirms that. The poll still runs, for the slower webview race.
  if (
    typeof (window as { __SKRIBEUM_E2E_VAULT__?: string })
      .__SKRIBEUM_E2E_VAULT__ !== "string"
  ) {
    settleStartupVaultSource("announced");
  }
  const timer = setInterval(() => {
    attempts += 1;
    const path = (window as { __SKRIBEUM_E2E_VAULT__?: string })
      .__SKRIBEUM_E2E_VAULT__;
    if (typeof path === "string" && vault === null) {
      const debugWindow = window as Window & {
        __SKRIBEUM_E2E_RESET_WORKSPACE__?: boolean;
      };
      if (debugWindow.__SKRIBEUM_E2E_RESET_WORKSPACE__ === true) {
        for (const key of Object.keys(localStorage)) {
          if (key.startsWith("skribeum.workspace.")) {
            localStorage.removeItem(key);
          }
        }
        delete debugWindow.__SKRIBEUM_E2E_RESET_WORKSPACE__;
      }
      const target = window as Window & {
        __SKRIBEUM_E2E_OPEN_NOTE__?: (path: string) => Promise<void>;
        __SKRIBEUM_E2E_HISTORY_STATE__?: () => NoteViewState | null;
        __SKRIBEUM_E2E_CURRENT_PATH__?: () => string | null;
        __SKRIBEUM_E2E_SET_SELECTION__?: (anchor: number) => boolean;
        __SKRIBEUM_E2E_SET_LINE_END__?: (lineText: string) => number | null;
        __SKRIBEUM_E2E_SET_FROM_LAST_MATCH__?: (
          sourceText: string,
          relativeOffset: number,
          relativeSelectionLength?: number,
        ) => number | null;
        __SKRIBEUM_E2E_ACTIVE_TAB_DIRTY__?: () => boolean | null;
      };
      target.__SKRIBEUM_E2E_OPEN_NOTE__ = (notePath) =>
        navigateToNote(notePath);
      target.__SKRIBEUM_E2E_HISTORY_STATE__ = () =>
        editor?.captureHistoryState() ?? null;
      target.__SKRIBEUM_E2E_CURRENT_PATH__ = () => selectedPath;
      target.__SKRIBEUM_E2E_SET_SELECTION__ = setEndToEndSelection;
      target.__SKRIBEUM_E2E_SET_LINE_END__ = setEndToEndSelectionAtLineEnd;
      target.__SKRIBEUM_E2E_SET_FROM_LAST_MATCH__ =
        setEndToEndSelectionFromLastMatch;
      target.__SKRIBEUM_E2E_ACTIVE_TAB_DIRTY__ = activeTabDirty;
      clearInterval(timer);
      void openEndToEndVault(path).finally(() =>
        settleStartupVaultSource("announced"),
      );
    } else if (attempts > 50 || vault !== null) {
      clearInterval(timer);
    }
  }, 100);
  return timer;
}

$effect(() => {
  // Re-observed whenever the tree changes shape; the observer itself covers
  // window resizes, panel collapse, and divider drags.
  void workspace.layout;
  const host = workspaceHost;
  if (host === undefined) return;
  const measure = () => {
    const next = new Map<string, { width: number; height: number }>();
    for (const element of host.querySelectorAll<HTMLElement>(
      "[data-pane-id]",
    )) {
      const id = element.dataset.paneId;
      if (id === undefined) continue;
      const bounds = element.getBoundingClientRect();
      next.set(id, { width: bounds.width, height: bounds.height });
    }
    const unchanged =
      next.size === paneExtents.size &&
      [...next].every(([id, box]) => {
        const previous = paneExtents.get(id);
        return (
          previous !== undefined &&
          Math.abs(previous.width - box.width) < 0.5 &&
          Math.abs(previous.height - box.height) < 0.5
        );
      });
    if (!unchanged) paneExtents = next;
  };
  const observer = new ResizeObserver(measure);
  for (const element of host.querySelectorAll<HTMLElement>("[data-pane-id]")) {
    observer.observe(element);
  }
  measure();
  return () => observer.disconnect();
});

onMount(() => {
  const stopVisualViewportCss = bindVisualViewportCss();
  const narrowQuery = window.matchMedia(
    `(max-width: ${NARROW_BREAKPOINT_REM}rem)`,
  );
  const updateNarrowViewport = () => {
    narrowViewport = narrowQuery.matches;
  };
  updateNarrowViewport();
  narrowQuery.addEventListener("change", updateNarrowViewport);
  navigation = createNoteNavigator({
    mode: navigationSurface,
    browserWindow: window,
    load: openNoteAddress,
    capture: () => editor?.captureHistoryState() ?? null,
    changed: (state) => {
      navigationState = state;
    },
  });
  navigationState = navigation.state();
  const debugWindow = window as Window & {
    __SKRIBEUM_DEBUG_OPEN_NOTE__?: (path: string) => Promise<void>;
    __SKRIBEUM_DEBUG_PERF__?: boolean;
    __SKRIBEUM_E2E_OPEN_NOTE__?: (path: string) => Promise<void>;
    __SKRIBEUM_E2E_HISTORY_STATE__?: () => NoteViewState | null;
    __SKRIBEUM_E2E_CURRENT_PATH__?: () => string | null;
    __SKRIBEUM_E2E_SET_SELECTION__?: (anchor: number) => boolean;
    __SKRIBEUM_E2E_SET_LINE_END__?: (lineText: string) => number | null;
    __SKRIBEUM_E2E_SET_FROM_LAST_MATCH__?: (
      sourceText: string,
      relativeOffset: number,
      relativeSelectionLength?: number,
    ) => number | null;
    __SKRIBEUM_E2E_ACTIVE_TAB_DIRTY__?: () => boolean | null;
    __SKRIBEUM_E2E_VAULT__?: string;
    __SKRIBEUM_E2E_RESET_WORKSPACE__?: boolean;
  };
  if (debugWindow.__SKRIBEUM_E2E_RESET_WORKSPACE__ === true) {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("skribeum.workspace.")) {
        localStorage.removeItem(key);
      }
    }
    delete debugWindow.__SKRIBEUM_E2E_RESET_WORKSPACE__;
  }
  if (debugWindow.__SKRIBEUM_DEBUG_PERF__ === true) {
    debugWindow.__SKRIBEUM_DEBUG_OPEN_NOTE__ = async (path) => {
      await openNote(path);
    };
  }
  if (typeof debugWindow.__SKRIBEUM_E2E_VAULT__ === "string") {
    debugWindow.__SKRIBEUM_E2E_OPEN_NOTE__ = (path) => navigateToNote(path);
    debugWindow.__SKRIBEUM_E2E_HISTORY_STATE__ = () =>
      editor?.captureHistoryState() ?? null;
    debugWindow.__SKRIBEUM_E2E_CURRENT_PATH__ = () => selectedPath;
    debugWindow.__SKRIBEUM_E2E_SET_SELECTION__ = setEndToEndSelection;
    debugWindow.__SKRIBEUM_E2E_SET_LINE_END__ = setEndToEndSelectionAtLineEnd;
    debugWindow.__SKRIBEUM_E2E_SET_FROM_LAST_MATCH__ =
      setEndToEndSelectionFromLastMatch;
    debugWindow.__SKRIBEUM_E2E_ACTIVE_TAB_DIRTY__ = activeTabDirty;
  }
  let disposed = false;
  let nativeOpenFilesDispose: (() => void) | undefined;
  const nativeOpenFilesListener = installNativeOpenListener(
    (available) => events.openFilesAvailable.listen(available),
    nativeOpenQueue,
    () => {
      nativeOpenIntent = true;
      startupRecoveryGuard.observeNativeOpen();
    },
  );
  void nativeOpenFilesListener.then(async (dispose) => {
    if (disposed) {
      dispose();
      return;
    }
    nativeOpenFilesDispose = dispose;
    await startDesktopVaultRecovery(debugWindow.__SKRIBEUM_E2E_VAULT__);
  });
  const unlisteners = [
    events.vaultCollisionsDetected.listen((event) => {
      collisionGroups = event.payload.groups;
    }),
    // Raw watcher events refresh the tree; content reconciliation for open
    // notes arrives through the typed events below, never through raw
    // (possibly unstable) modification events.
    events.vaultChanged.listen((event) => {
      if (!activeVaultMatchesEvent(event.payload.vault)) {
        return;
      }
      if (event.payload.change === "overflow") {
        void refreshTreeIndex(true);
      } else if (event.payload.change === "removed") {
        void refreshTreeIndex(true);
      } else if (event.payload.change !== "modified") {
        void refreshTree();
      }
    }),
    events.externalNoteUpdate.listen((event) => {
      const activeVault = vault;
      if (
        activeVault === null ||
        !activeVaultMatchesEvent(event.payload.vault)
      ) {
        return;
      }
      void refreshTagCatalog(activeVault);
      if (event.payload.path !== selectedPath || note === null) {
        return;
      }
      if (note.readOnly) {
        void openNote(event.payload.path);
        return;
      }
      void editor?.ingestExternal(
        event.payload.change_set,
        event.payload.projection_hash,
      );
    }),
    events.externalNoteRemove.listen((event) => {
      const activeVault = vault;
      if (
        activeVault === null ||
        !activeVaultMatchesEvent(event.payload.vault)
      ) {
        return;
      }
      void refreshTreeAfterTagCatalog(activeVault);
      if (event.payload.path === selectedPath) {
        editor?.markRemoved();
        pushBanner({
          text: STRINGS.noteRemovedBanner,
          paths: [event.payload.path],
        });
      }
    }),
    events.reconciliationBanner.listen((event) => {
      if (!activeVaultMatchesEvent(event.payload.vault)) {
        return;
      }
      const path = event.payload.path;
      nextBannerId += 1;
      const id = nextBannerId;
      banners = [
        ...banners,
        {
          id,
          text: `${STRINGS.reconciliationBannerPrefix} ${bannerReasonText(event.payload.reason)}`,
          paths: [path],
          onReview: () => void reviewPath(path, id),
        },
      ];
    }),
    events.bulkDivergenceReview.listen((event) => {
      if (!activeVaultMatchesEvent(event.payload.vault)) {
        return;
      }
      const paths = event.payload.paths;
      nextBannerId += 1;
      const id = nextBannerId;
      banners = [
        ...banners,
        {
          id,
          text: STRINGS.bulkDivergenceBanner,
          paths,
          onReview: () => {
            dismissBanner(id);
            void refreshTree();
            if (selectedPath !== null && paths.includes(selectedPath)) {
              void reviewPath(selectedPath, id);
            }
          },
        },
      ];
    }),
    events.noteRecovered.listen((event) => {
      if (!activeVaultMatchesEvent(event.payload.vault)) {
        return;
      }
      const path = event.payload.path;
      if (path === selectedPath && note !== null && !note.readOnly) {
        editor?.ingestRecovered(event.payload.change_set);
        pushBanner({ text: STRINGS.noteRecoveredNotice, paths: [path] });
        return;
      }
      pendingRecovered.set(path, event.payload.change_set);
      nextBannerId += 1;
      const id = nextBannerId;
      banners = [
        ...banners,
        {
          id,
          text: STRINGS.noteRecoveredPendingBanner,
          paths: [path],
          onReview: () => void reviewPath(path, id),
        },
      ];
    }),
    events.settingsZoomChanged.listen((event) => {
      settingsStore.applyExternal({
        zoom_percent: event.payload.zoom_percent,
      });
    }),
  ];
  void settingsStore.load();
  if (hasDesktopRuntime()) {
    void settingsPath()
      .then((path) => {
        settingsFilePath = path;
      })
      .catch(() => {
        settingsFilePath = null;
      });
  }
  const pollTimer = pollEndToEndVault();
  return () => {
    disposed = true;
    stopVisualViewportCss();
    narrowQuery.removeEventListener("change", updateNarrowViewport);
    navigation?.dispose();
    navigation = null;
    delete debugWindow.__SKRIBEUM_DEBUG_OPEN_NOTE__;
    delete debugWindow.__SKRIBEUM_E2E_OPEN_NOTE__;
    delete debugWindow.__SKRIBEUM_E2E_HISTORY_STATE__;
    delete debugWindow.__SKRIBEUM_E2E_CURRENT_PATH__;
    delete debugWindow.__SKRIBEUM_E2E_SET_SELECTION__;
    delete debugWindow.__SKRIBEUM_E2E_SET_LINE_END__;
    delete debugWindow.__SKRIBEUM_E2E_SET_FROM_LAST_MATCH__;
    delete debugWindow.__SKRIBEUM_E2E_ACTIVE_TAB_DIRTY__;
    clearInterval(pollTimer);
    nativeOpenFilesDispose?.();
    void vaultOwnership.dispose();
    cancelOutlineRefresh?.();
    for (const unlisten of unlisteners) {
      void unlisten.then((dispose) => dispose());
    }
  };
});
</script>

<!-- registry-exempt keydown: the window handler is the registry's own
     global dispatcher; every chord it recognizes is a registered
     keybinding. -->
<svelte:window onkeydown={onGlobalKeydown} />

<div
  class="skr-shell flex h-screen flex-col overflow-hidden"
  inert={activeSheet !== null || activeOverlay !== null}
>
  <!-- svelte-ignore a11y_no_static_element_interactions -- the header's
       implicit role is already `banner`; the drag-region right-click opens
       the desktop window menu (design system section 4.13), not a page
       interaction. -->
  <header
    class="skr-app-header border-b"
    data-tauri-drag-region={hasDesktopRuntime() && !narrowViewport
      ? "deep"
      : undefined}
    oncontextmenu={(event) => {
      if (!hasDesktopRuntime() || narrowViewport) return;
      event.preventDefault();
      void showWindowSystemMenu();
    }}
  >
    <div class="skr-header-leading">
      <h1 class="sr-only">{STRINGS.appTitle}</h1>
      {#if vault !== null && workspace.sidebarCollapsed}
        <button
          type="button"
          class="skr-header-icon-button skr-desktop-sidebar-toggle"
          data-command-id="panel.sidebar.toggle"
          aria-label={STRINGS.expandSidebar}
          use:commandTooltip={tooltipForCommand("panel.sidebar.toggle", STRINGS.expandSidebar)}
          onpointerdown={rememberPanelTogglePointerOrigin}
          onmousedown={keepPanelTogglePointerFocus}
          onpointerup={releasePanelTogglePointerOrigin}
          onpointercancel={cancelPanelTogglePointerOrigin}
          onclick={() => registry.run("panel.sidebar.toggle", commandContext())}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 5.5h16v13H4zM9 5.5v13M14 9l3 3-3 3" />
          </svg>
        </button>
      {/if}
      <button
        type="button"
        class="skr-phone-files skr-header-icon-button"
        disabled={vault === null}
        data-command-id="file-tree.open"
        aria-label={STRINGS.mobileFiles}
        aria-haspopup="dialog"
        onclick={(event) =>
          runSurfaceCommand("file-tree.open", event.currentTarget)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3.75 5.75h6l1.5 2h9v10.5h-16.5z" />
        </svg>
      </button>
      <nav class="skr-history" aria-label={STRINGS.navigationHistoryLabel}>
        <button
          type="button"
          class="skr-header-icon-button"
          disabled={!navigationState.canGoBack}
          data-command-id="navigation.back"
          aria-label={STRINGS.navigationBack}
          onclick={() => registry.run("navigation.back", commandContext())}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m14.5 6-6 6 6 6" />
          </svg>
        </button>
        <button
          type="button"
          class="skr-header-icon-button"
          disabled={!navigationState.canGoForward}
          data-command-id="navigation.forward"
          aria-label={STRINGS.navigationForward}
          onclick={() => registry.run("navigation.forward", commandContext())}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m9.5 6 6 6-6 6" />
          </svg>
        </button>
      </nav>
    </div>
    <div class="skr-note-title-region">
      <span
        class="skr-note-title m-0"
        class:skr-note-title-hidden={!shellTitleVisible}
        aria-hidden="true"
        data-testid="note-title"
      >
        {shellTitle}
      </span>
      {#if shellTitleVisible && note !== null}
        <h2 class="sr-only">{shellTitle}</h2>
      {/if}
      {#if sourceMode}
        <span class="skr-source-chip" data-testid="source-mode-chip">
          {STRINGS.sourceModeBadge}
        </span>
      {/if}
    </div>
    <div class="skr-header-trailing">
      {#if note?.readOnly || contentView === VIEW_CANVAS}
        <span class="skr-type-label skr-warning skr-read-only-badge rounded px-2 py-0.5">
          {STRINGS.readOnlyBadge}
        </span>
      {/if}
      <button
        type="button"
        class="skr-header-overflow skr-header-icon-button"
        aria-label={STRINGS.overflowMenuLabel}
        aria-haspopup={narrowViewport ? "dialog" : "menu"}
        onpointerdown={(event) => prepareOverflowContext(event.currentTarget)}
        onfocus={(event) => {
          if (!overflowContextPrepared) {
            prepareOverflowContext(event.currentTarget, event.relatedTarget);
          }
        }}
        onclick={(event) => openSheet("overflow", event.currentTarget)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="5" cy="12" r="1.75" />
          <circle cx="12" cy="12" r="1.75" />
          <circle cx="19" cy="12" r="1.75" />
        </svg>
      </button>
      <WindowControls {registry} {commandContext} {narrowViewport} />
    </div>
  </header>

  {#if collisionGroups.length > 0}
    <aside class="skr-type-label skr-warning border-b px-3 py-1" role="alert">
      {STRINGS.collisionBanner}
      {collisionGroups.map((group) => group.join(" / ")).join("; ")}
    </aside>
  {/if}
  {#if note?.readOnly}
    <aside class="skr-type-label skr-warning border-b px-3 py-1" role="alert">
      {STRINGS.nonUtf8Banner}
    </aside>
  {/if}
  <Banners {banners} onDismiss={dismissBanner} />
  {#if errorText !== null}
    <aside class="skr-type-label skr-error border-b px-3 py-1" role="alert">
      {errorText}
    </aside>
  {/if}

  <main class="flex min-h-0 flex-1 overflow-hidden">
    {#if vault !== null || !initialVaultSettled}
      <div
        class="skr-sidebar skr-desktop-sidebar skr-panel-motion"
        class:skr-sidebar-header-hovered={sidebarHeaderHovered}
        class:skr-sidebar-focused={sidebarFocused}
        style={`width: ${workspace.sidebarCollapsed ? 0 : workspace.sidebarWidthRem}rem`}
        onfocusin={() => (sidebarFocused = true)}
        onfocusout={(event) => {
          const next = event.relatedTarget;
          if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
            sidebarFocused = false;
          }
        }}
      >
        {#if !workspace.sidebarCollapsed && vault !== null}
        <nav class="skr-sidebar-content" aria-label={STRINGS.sidebarHeaderLabel}>
          <header
            class="skr-sidebar-header"
            role="group"
            aria-label={STRINGS.sidebarHeaderLabel}
            onpointerenter={() => (sidebarHeaderHovered = true)}
            onpointerleave={() => (sidebarHeaderHovered = false)}
          >
            <span>{vaultName}</span>
            <div class="skr-sidebar-header-actions">
              <button
                type="button"
                data-command-id="note.create"
                aria-label={STRINGS.treeCreateNote}
                use:commandTooltip={tooltipForCommand("note.create", STRINGS.treeCreateNote)}
                onclick={() => registry.run("note.create", commandContext())}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M8 3v10M3 8h10" />
                </svg>
              </button>
              <button
                type="button"
                data-command-id="panel.sidebar.toggle"
                aria-label={STRINGS.collapseSidebar}
                use:commandTooltip={tooltipForCommand("panel.sidebar.toggle", STRINGS.collapseSidebar)}
                onpointerdown={rememberPanelTogglePointerOrigin}
                onmousedown={keepPanelTogglePointerFocus}
                onpointerup={releasePanelTogglePointerOrigin}
                onpointercancel={cancelPanelTogglePointerOrigin}
                onclick={() => registry.run("panel.sidebar.toggle", commandContext())}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M2.5 3.5h11v9h-11zM7 3.5v9M5 6l-2 2 2 2" />
                </svg>
              </button>
            </div>
          </header>
          <div class="skr-sidebar-tree">
            <FileTree
              entries={tree}
              {selectedPath}
              titleSources={treeTitleSources}
              expandedPaths={workspace.expandedFolders}
              onExpandedChange={(paths) => (workspace.expandedFolders = paths)}
              onSelectionChange={(path) => (workspace.selectedPath = path)}
              onOpenPath={openPath}
              {registry}
              {commandContext}
              desktop={hasDesktopRuntime()}
            />
          </div>
        </nav>
        <PanelDivider
          value={workspace.sidebarWidthRem}
          minimum={SIDEBAR_MIN_REM}
          maximum={SIDEBAR_MAX_REM}
          defaultValue={SIDEBAR_DEFAULT_REM}
          edge="right"
          label={STRINGS.sidebarResize}
          onResize={(value) => (workspace.sidebarWidthRem = value)}
          onCollapse={(origin) => togglePanel("sidebar", origin)}
        />
        {/if}
      </div>
    {/if}
    <div class="skr-workspace" bind:this={workspaceHost}>
      {#if vault === null}
        <StartupVaultRecovery
          surface={startupVaultSurface}
          disabledReason={openVaultDisabledReason}
          onOpen={(path) => void openStartupVault(path)}
        />
      {:else}
        {#snippet leafPane(pane: WorkspaceLeaf)}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <section
            class="skr-editor-pane"
            class:skr-editor-pane-focused={pane.id === workspace.focusedPaneId}
            data-pane-id={pane.id}
            aria-label={`${STRINGS.editorPane} ${workspacePanes.indexOf(pane) + 1}`}
            onfocusin={() => void focusWorkspacePane(pane.id)}
            onpointerdown={() => void focusWorkspacePane(pane.id)}
            ondragover={(event) => {
              if (
                event.dataTransfer?.types.includes(
                  "application/x-skribeum-tree-path",
                )
              ) {
                event.preventDefault();
                splitDropZone = null;
                return;
              }
              updateTabDropZone(event, pane.id);
            }}
            ondragleave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                splitDropZone = null;
              }
            }}
            ondrop={(event) => {
              const treePath = event.dataTransfer?.getData(
                "application/x-skribeum-tree-path",
              );
              if (treePath) {
                event.preventDefault();
                splitDropZone = null;
                void (async () => {
                  await focusWorkspacePane(pane.id);
                  await navigateToNote(treePath);
                })();
                return;
              }
              void dropTabOnPane(event, pane.id);
            }}
          >
            <TabStrip
              paneId={pane.id}
              tabs={pane.tabs}
              activePath={pane.activePath}
              titleSources={treeTitleSources}
              focused={pane.id === workspace.focusedPaneId}
              visible={pane.tabs.length > 1 || workspacePanes.length > 1 || pane.emptyTab === true}
              emptyTab={pane.emptyTab === true}
              closeTooltip={tooltipForCommand("tab.close", STRINGS.closeTab)}
              onActivate={(path) => {
                void focusWorkspacePane(pane.id).then(() => activateWorkspaceTab(path));
              }}
              onClose={(path, restoreFocus) => {
                void focusWorkspacePane(pane.id).then(() =>
                  closeWorkspaceTab(path, restoreFocus),
                );
              }}
              onReorder={(from, to) => {
                if (pane.id === workspace.focusedPaneId) reorderWorkspaceTabs(from, to);
              }}
              onNewTab={() => void openEmptyWorkspaceTab(pane.id)}
              onAdopt={(origin, index) =>
                void moveTabIntoPane(origin.paneId, origin.path, pane.id, index)}
            />
            <div
              class="skr-pane-content"
              use:captureContentHost={pane.id}
              tabindex="-1"
              data-testid="reading-surface"
              data-note-path={pane.id === workspace.focusedPaneId ? selectedPath : pane.activePath}
            >
              {#if pane.id !== workspace.focusedPaneId}
                {#if pane.activePath !== null}
                <div class="skr-unfocused-note">
                  <ReadOnlyNote
                    source={treeTitleSources[pane.activePath] ?? ""}
                    label={STRINGS.editorLabel}
                    context={{ ...(linkContext ?? EMPTY_WIKILINK_CONTEXT), currentPath: pane.activePath }}
                    taskStatuses={documentTaskStatuses}
                  />
                </div>
                {/if}
              {:else if contentView === VIEW_CANVAS && canvas !== null}
                <CanvasView
                  bind:this={canvasViewer}
                  {canvas}
                  previews={canvasPreviews}
                  {linkContext}
                  taskStatuses={documentTaskStatuses}
                  onOpenNode={openPath}
                  onMoveNode={(nodeId, x, y) => void moveCanvasNode(nodeId, x, y)}
                  onRemoveNode={(nodeId) => void removeCanvasNode(nodeId)}
                  onAddNode={() => void addCanvasNode()}
                />
              {:else if contentView === VIEW_CANVAS && canvasError !== null}
                <div class="skr-error m-4 rounded border p-3" role="alert" data-testid="canvas-error">
                  {canvasError}
                </div>
              {:else if missingAddress !== null}
                <div
                  class="skr-error m-4 max-w-2xl rounded border p-4"
                  role="alert"
                  data-testid="note-not-found"
                >
                  <h2 class="skr-type-title m-0 font-semibold">{STRINGS.noteNotFoundTitle}</h2>
                  <p class="my-2">{STRINGS.noteNotFoundPrefix}</p>
                  <p class="my-2 font-mono">{missingAddress.path}</p>
                  {#if navigationSurface === "browser"}
                    <p class="mb-0">{STRINGS.noteNotFoundBrowser}</p>
                  {:else}
                    <p>{STRINGS.noteNotFoundDesktop}</p>
                    <button
                      type="button"
                      class="skr-btn-secondary"
                      data-btn-role="secondary"
                      onclick={refreshMissingNote}
                    >
                      {STRINGS.noteNotFoundRefresh}
                    </button>
                  {/if}
                </div>
              {:else}
                <!--
                  One Editor instance regardless of whether a note is open:
                  branching this on `note !== null` used to mount a second,
                  separate Editor (and CodeMirror view) the moment the first
                  note loaded, which read as the whole page rebuilding. The
                  single instance transitions in place through its own
                  reactive `note`/`path` handling instead. `vault` and `path`
                  stay null together with `note` so a still-loading note
                  never keys the live tab-state cache under its final path
                  before it has actually arrived.
                -->
                <Editor
                  bind:this={editor}
                  doc={M0_FIXTURE}
                  {note}
                  vault={editorVault}
                  path={editorPath}
                  {linkContext}
                  {propertyTypes}
                  taskStatuses={documentTaskStatuses}
                  {registry}
                  {commandContext}
                  settings={documentSettings}
                  {sourceMode}
                  {historyViewState}
                  {onConflict}
                  {onWriteError}
                  onDocChanged={onEditorDocChanged}
                  onOutlineChanged={onEditorOutlineChanged}
                  onDirtyChanged={(dirty) =>
                    onEditorDirtyChanged(workspace.focusedPaneId, selectedPath, dirty)}
                  onTitleVisibilityChange={(visible) => (noteTitleVisible = visible)}
                  onSaved={onEditorSaved}
                  onStatisticsChanged={(statistics) => (editorStatistics = statistics)}
                  onPersistenceChanged={(state) => (persistenceState = state)}
                  {wikilinkNavigationOptions}
                  {tagAffordanceOptions}
                />
              {/if}
              {#if splitDropZone?.paneId === pane.id}
                <div
                  class="skr-pane-split-target"
                  data-drop-side={splitDropZone.side}
                  aria-hidden="true"
                ></div>
              {/if}
            </div>
          </section>
        {/snippet}

        {#snippet paneNode(node: WorkspaceNode)}
          {#if node.type === "split"}
            <div
              class="skr-split"
              class:skr-split-column={node.axis === "column"}
            >
              <div
                class="skr-split-child"
                style={`flex-basis: ${node.ratio * 100}%`}
              >
                {@render paneNode(node.children[0])}
              </div>
              <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
              <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
              <div
                class="skr-split-divider"
                class:skr-split-divider-column={node.axis === "column"}
                class:skr-split-divider-dragging={splitDraggingNode === node}
                role="separator"
                aria-label={STRINGS.paneResize}
                aria-orientation={node.axis === "row" ? "vertical" : "horizontal"}
                aria-valuemin="5"
                aria-valuemax="95"
                aria-valuenow={Math.round(node.ratio * 100)}
                tabindex="0"
                onpointerdown={(event) => beginSplitResize(event, node)}
                onkeydown={(event) => resizeSplitWithKeyboard(event, node)}
              ></div>
              <div
                class="skr-split-child"
                style={`flex-basis: ${(1 - node.ratio) * 100}%`}
              >
                {@render paneNode(node.children[1])}
              </div>
            </div>
          {:else}
            {@render leafPane(node)}
          {/if}
        {/snippet}

        {@render paneNode(workspace.layout)}
      {/if}
    </div>
    {#if vault !== null}
      <div
        class="skr-panel skr-desktop-outline skr-panel-motion"
        data-testid="desktop-outline-panel"
        style={`width: ${outlineOpen ? workspace.outlineWidthRem : 0}rem`}
      >
        {#if outlineOpen}
        <PanelDivider
          value={workspace.outlineWidthRem}
          minimum={OUTLINE_MIN_REM}
          maximum={OUTLINE_MAX_REM}
          defaultValue={OUTLINE_DEFAULT_REM}
          edge="left"
          label={STRINGS.outlineResize}
          onResize={(value) => (workspace.outlineWidthRem = value)}
          onCollapse={(origin) => togglePanel("outline", origin)}
        />
        <section class="skr-outline-content" aria-label={STRINGS.outlineLabel}>
          <div class="skr-outline-header">
            <span>{STRINGS.outlineLabel}</span>
            <button
              type="button"
              data-command-id="panel.outline.toggle"
              aria-label={STRINGS.collapseOutline}
              use:commandTooltip={tooltipForCommand("panel.outline.toggle", STRINGS.collapseOutline)}
              onpointerdown={rememberPanelTogglePointerOrigin}
              onmousedown={rememberPanelTogglePointerOrigin}
              onpointerup={releasePanelTogglePointerOrigin}
              onpointercancel={cancelPanelTogglePointerOrigin}
              onclick={() => registry.run("panel.outline.toggle", commandContext())}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M2.5 3.5h11v9h-11zM9 3.5v9m2-6 2 2-2 2" />
              </svg>
            </button>
          </div>
          <div class="skr-outline-body">
            <OutlinePanel
              entries={outlineEntries}
              onNavigate={outlineNavigate}
              onCopyHeading={copyOutlineHeading}
            />
          </div>
        </section>
        {/if}
      </div>
    {/if}
  </main>
  {#if !narrowViewport}
    <Statusline
      path={note !== null ? selectedPath : null}
      createdMs={noteTimes?.createdMs ?? null}
      modifiedMs={noteTimes?.modifiedMs ?? null}
      statistics={editorStatistics}
      {sourceMode}
      persistence={persistenceState}
      announcement={statuslineAnnouncement}
      bind:infoOpen={noteInfoOpen}
    />
  {/if}
</div>

{#if activeSheet === "file-tree" && vault !== null}
  <Sheet label={STRINGS.vaultTreeLabel} onClose={closeSheet} restoreFocus={false}>
    <FileTree
      entries={tree}
      {selectedPath}
      titleSources={treeTitleSources}
      expandedPaths={workspace.expandedFolders}
      onExpandedChange={(paths) => (workspace.expandedFolders = paths)}
      onSelectionChange={(path) => (workspace.selectedPath = path)}
      onOpenPath={openPath}
      {registry}
      {commandContext}
      desktop={hasDesktopRuntime()}
      touchMode={true}
    />
  </Sheet>
{:else if activeSheet === "outline"}
  <Sheet label={STRINGS.outlineLabel} onClose={closeSheet} restoreFocus={false}>
    <OutlinePanel
      entries={outlineEntries}
      onCopyHeading={copyOutlineHeading}
      onNavigate={(from) => {
        closeSheet();
        outlineNavigate(from);
      }}
      touchMode={true}
    />
  </Sheet>
{:else if activeSheet === "note-info"}
  <Sheet label={STRINGS.noteInfoLabel} onClose={closeSheet} restoreFocus={false}>
    <div class="skr-note-info-sheet">
      <NoteInfo
        path={note !== null ? selectedPath : null}
        createdMs={noteTimes?.createdMs ?? null}
        modifiedMs={noteTimes?.modifiedMs ?? null}
        statistics={editorStatistics}
      />
    </div>
  </Sheet>
{:else if activeSheet === "overflow"}
  {#if narrowViewport}
    <Sheet label={STRINGS.overflowMenuLabel} onClose={closeSheet} restoreFocus={false}>
      {@render overflowMenuRows(false)}
    </Sheet>
  {:else if surfaceFocusOrigin !== null}
    <AnchoredMenu
      anchor={surfaceFocusOrigin}
      label={STRINGS.overflowMenuLabel}
      align="end"
      onClose={closeSheet}
      restoreFocus={false}
    >
      {@render overflowMenuRows(true)}
    </AnchoredMenu>
  {/if}
{/if}

{#snippet overflowMenuRows(asMenu: boolean)}
  <nav class="skr-action-menu" aria-label={STRINGS.overflowMenuLabel}>
    {#each overflowCommands as item (item.command?.id)}
      {#if item.command !== undefined}
        <button
          type="button"
          role={asMenu ? "menuitem" : undefined}
          data-command-id={item.command.id}
          onclick={() =>
            item.command !== undefined && runActionCommand(item.command.id)}
        >
          <span>{item.label}</span>
          {#if formattedCommandKeybinding(item.command) !== undefined}
            <kbd>{formattedCommandKeybinding(item.command)}</kbd>
          {/if}
        </button>
      {/if}
    {/each}
    {#each actionCommands as command (command.id)}
      <button
        type="button"
        role={asMenu ? "menuitem" : undefined}
        data-command-id={command.id}
        data-checked={command.id === TOGGLE_SOURCE_MODE_COMMAND
          ? String(sourceMode)
          : undefined}
        aria-pressed={command.id === TOGGLE_SOURCE_MODE_COMMAND
          ? sourceMode
          : undefined}
        disabled={(command.id === TOGGLE_SOURCE_MODE_COMMAND && note === null) ||
          paneCommandUnavailability.has(command.id)}
        title={paneCommandUnavailability.get(command.id)}
        onclick={() => runActionCommand(command.id)}
      >
        <span class="skr-action-menu-label">
          {#if command.id === TOGGLE_SOURCE_MODE_COMMAND}
            <span class="skr-action-menu-check" aria-hidden="true">
              {sourceMode ? "✓" : ""}
            </span>
          {/if}
          <span>{command.title}</span>
        </span>
        {#if formattedCommandKeybinding(command) !== undefined}
          <kbd>{formattedCommandKeybinding(command)}</kbd>
        {/if}
      </button>
    {/each}
    {#each contextualOverflowCommands() as command (command.id)}
      <button
        type="button"
        role={asMenu ? "menuitem" : undefined}
        data-command-id={command.id}
        onclick={() => runActionCommand(command.id)}
      >
        <span>{command.title}</span>
      </button>
    {/each}
    {#if vaultOpenCommand !== undefined}
      <button
        type="button"
        role={asMenu ? "menuitem" : undefined}
        data-command-id={vaultOpenCommand.id}
        disabled={openVaultDisabledReason !== null}
        title={openVaultDisabledReason ?? undefined}
        onclick={() => runActionCommand(vaultOpenCommand.id)}
      >
        <span>{vaultOpenCommand.title}</span>
      </button>
    {/if}
  </nav>
{/snippet}

{#if activeOverlay === VIEW_COMMAND_SURFACE}
  <UnifiedCommandSurface
    items={overlayItems}
    mode={parsedOverlayQuery.mode}
    initialQuery={overlayQuery}
    onQueryChange={onOverlayQuery}
    onPick={onOverlayPick}
    onClose={closeOverlay}
    restoreFocus={false}
  />
{:else if activeOverlay === VIEW_SETTINGS}
  <SettingsView
    settings={settingsState}
    onUpdate={(patch) => void settingsStore.update(patch)}
    onPreview={(patch) =>
      applySettings({ ...settingsState.document, ...patch })}
    onClose={closeOverlay}
    restoreFocus={false}
    desktopAvailable={hasDesktopRuntime()}
    currentVersion={tauriConfig.version}
    {settingsFilePath}
    {updateState}
    onCheckUpdate={checkSelectedUpdateChannel}
    {targetSetting}
  />
{/if}
