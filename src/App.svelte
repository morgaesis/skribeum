<script lang="ts">
import { open as openDirectoryDialog } from "@tauri-apps/plugin-dialog";
import { onMount, tick } from "svelte";
import tauriConfig from "../src-tauri/tauri.conf.json";
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
  vaultTreeRefresh,
  zoomSet,
} from "./lib/ipc/services";
import {
  IpcError,
  type LoadedNote,
  noteCreate,
  openVault,
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
import Statusline from "./lib/Statusline.svelte";
import { STRINGS } from "./lib/strings";
import TabStrip from "./lib/TabStrip.svelte";
import {
  applyAppearance,
  isCodeFontName,
  isDarkPaletteName,
  isLightPaletteName,
  isProseFontName,
  isThemeName,
} from "./lib/themes/theme";
import UnifiedCommandSurface from "./lib/UnifiedCommandSurface.svelte";
import { bindVisualViewportCss } from "./lib/visualViewport";
import WindowControls from "./lib/WindowControls.svelte";
import { showWindowSystemMenu } from "./lib/windowChrome";
import {
  defaultWorkspaceState,
  loadWorkspaceState,
  OUTLINE_DEFAULT_REM,
  OUTLINE_MAX_REM,
  OUTLINE_MIN_REM,
  remapWorkspacePath,
  removeWorkspacePath,
  SIDEBAR_DEFAULT_REM,
  SIDEBAR_MAX_REM,
  SIDEBAR_MIN_REM,
  SPLIT_MIN_REM,
  saveWorkspaceState,
  type WorkspacePane,
  type WorkspaceTab,
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
let tree = $state<TreeEntry[]>([]);
let treeTitleSources = $state<Record<string, string>>({});
let selectedPath = $state<string | null>(null);
let note = $state<LoadedNote | null>(null);
let collisionGroups = $state<string[][]>([]);
let errorText = $state<string | null>(null);
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
let splitDragging = $state(false);
let splitDropPaneId = $state<string | null>(null);
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
let surfaceFocusOrigin: HTMLElement | null = null;
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
    if (generation !== titleLoadGeneration || vault?.id !== handle.id) return;
    for (const [path, source] of loaded) next[path] = source;
    treeTitleSources = { ...next };
  }
}

function togglePanel(panel: "sidebar" | "outline") {
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
  if (panel === "sidebar") {
    workspace.sidebarCollapsed = !workspace.sidebarCollapsed;
  } else {
    outlineOpen = !outlineOpen;
    workspace.outlineCollapsed = !outlineOpen;
    if (outlineOpen) refreshOutline();
  }
}

function focusedWorkspacePane(): WorkspacePane {
  return (
    workspace.panes.find((pane) => pane.id === workspace.focusedPaneId) ??
    workspace.panes[0] ?? {
      id: "pane-1",
      tabs: [],
      activePath: null,
      history: [],
      historyIndex: -1,
    }
  );
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

function ensurePaneTab(pane: WorkspacePane, path: string): WorkspaceTab {
  const existing = pane.tabs.find((tab) => tab.path === path);
  if (existing !== undefined) return existing;
  const tab = { path, viewState: null } satisfies WorkspaceTab;
  pane.tabs.push(tab);
  return tab;
}

function pushPaneHistory(
  pane: WorkspacePane,
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

async function activateWorkspaceTab(path: string) {
  const pane = focusedWorkspacePane();
  if (pane.activePath === path && selectedPath === path) return;
  captureFocusedTabState();
  const tab = ensurePaneTab(pane, path);
  pane.activePath = path;
  await openNote(path, tab.viewState, "tab");
  updatePaneNavigationState();
}

async function focusWorkspacePane(id: string) {
  if (workspace.focusedPaneId === id) return;
  if ((await editor?.flush()) === false) {
    errorText = STRINGS.contentSwitchUnsaved;
    return;
  }
  captureFocusedTabState();
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

async function closeWorkspaceTab(path = focusedWorkspacePane().activePath) {
  if (path === null) return;
  const pane = focusedWorkspacePane();
  const index = pane.tabs.findIndex((tab) => tab.path === path);
  if (index < 0) return;
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
  if (pane.tabs.length === 0 && workspace.panes.length === 2) {
    const other = workspace.panes.find((candidate) => candidate.id !== pane.id);
    workspace.panes = workspace.panes.filter(
      (candidate) => candidate.id !== pane.id,
    );
    if (other !== undefined) {
      workspace.focusedPaneId = other.id;
      await tick();
      contentHost =
        document.querySelector<HTMLElement>(
          `[data-pane-id="${CSS.escape(other.id)}"] .skr-pane-content`,
        ) ?? undefined;
      if (other.activePath !== null) {
        const tab = ensurePaneTab(other, other.activePath);
        await openNote(other.activePath, tab.viewState, "tab");
      }
      updatePaneNavigationState();
    }
    return;
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
}

async function reopenClosedWorkspaceTab() {
  const tab = workspace.closedTabs.at(-1);
  if (tab === undefined) return;
  workspace.closedTabs = workspace.closedTabs.slice(0, -1);
  const pane = focusedWorkspacePane();
  pane.tabs.push(tab);
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

async function splitWorkspaceTab(path = focusedWorkspacePane().activePath) {
  if (path === null || narrowViewport || workspace.panes.length >= 2) return;
  captureFocusedTabState();
  const source = focusedWorkspacePane();
  if (source.tabs.length <= 1) return;
  const index = source.tabs.findIndex((tab) => tab.path === path);
  const [tab] = index < 0 ? [] : source.tabs.splice(index, 1);
  if (tab === undefined) return;
  source.activePath =
    source.tabs[Math.min(index, source.tabs.length - 1)]?.path ?? null;
  const pane: WorkspacePane = {
    id: "pane-2",
    tabs: [tab],
    activePath: tab.path,
    history: [{ address: { path: tab.path }, viewState: tab.viewState }],
    historyIndex: 0,
  };
  workspace.panes.push(pane);
  workspace.focusedPaneId = pane.id;
  await tick();
  contentHost =
    document.querySelector<HTMLElement>(
      `[data-pane-id="${CSS.escape(pane.id)}"] .skr-pane-content`,
    ) ?? undefined;
  if (selectedPath !== tab.path) {
    await openNote(tab.path, tab.viewState, "tab");
  } else {
    selectedPath = tab.path;
  }
  updatePaneNavigationState();
}

async function moveWorkspaceTabToOtherPane() {
  if (workspace.panes.length === 1) {
    await splitWorkspaceTab();
    return;
  }
  const source = focusedWorkspacePane();
  const path = source.activePath;
  if (path === null) return;
  captureFocusedTabState();
  const index = source.tabs.findIndex((tab) => tab.path === path);
  const [tab] = source.tabs.splice(index, 1);
  const target = workspace.panes.find((pane) => pane.id !== source.id);
  if (tab === undefined || target === undefined) return;
  if (!target.tabs.some((candidate) => candidate.path === tab.path)) {
    target.tabs.push(tab);
  }
  target.activePath = tab.path;
  pushPaneHistory(target, { path: tab.path }, tab.viewState);
  source.activePath =
    source.tabs[Math.min(index, source.tabs.length - 1)]?.path ?? null;
  if (source.tabs.length === 0) {
    workspace.panes = workspace.panes.filter(
      (candidate) => candidate.id !== source.id,
    );
  }
  workspace.focusedPaneId = target.id;
  await tick();
  contentHost =
    document.querySelector<HTMLElement>(
      `[data-pane-id="${CSS.escape(target.id)}"] .skr-pane-content`,
    ) ?? undefined;
  await openNote(tab.path, tab.viewState, "tab");
  updatePaneNavigationState();
}

function focusWorkspacePaneDirection(direction: "left" | "right") {
  if (workspace.panes.length < 2) return;
  const index = direction === "left" ? 0 : 1;
  const pane = workspace.panes[index];
  if (pane !== undefined) void focusWorkspacePane(pane.id);
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
  pane.activePath = tab.path;
  void openNoteAddress(entry.address, entry.viewState, "history");
  updatePaneNavigationState();
  return true;
}

function beginSplitResize(event: PointerEvent) {
  if (event.button !== 0 || workspaceHost === undefined) return;
  event.preventDefault();
  const divider = event.currentTarget as HTMLElement;
  const pointer = event.pointerId;
  const bounds = workspaceHost.getBoundingClientRect();
  const rootSize = Number.parseFloat(
    getComputedStyle(document.documentElement).fontSize,
  );
  const minimum = Math.min(0.5, (SPLIT_MIN_REM * rootSize) / bounds.width);
  splitDragging = true;
  divider.setPointerCapture(pointer);
  const move = (next: PointerEvent) => {
    if (next.pointerId !== pointer) return;
    workspace.splitRatio = Math.max(
      minimum,
      Math.min(1 - minimum, (next.clientX - bounds.left) / bounds.width),
    );
  };
  const stop = (end: PointerEvent) => {
    if (end.pointerId !== pointer) return;
    splitDragging = false;
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
function resizeSplitWithKeyboard(event: KeyboardEvent) {
  if (workspaceHost === undefined) return;
  const rootSize = Number.parseFloat(
    getComputedStyle(document.documentElement).fontSize,
  );
  const step = rootSize / workspaceHost.getBoundingClientRect().width;
  if (event.key === "ArrowLeft") workspace.splitRatio -= step;
  else if (event.key === "ArrowRight") workspace.splitRatio += step;
  else if (event.key === "Home") workspace.splitRatio = 0.5;
  else return;
  const minimum = Math.min(
    0.5,
    (SPLIT_MIN_REM * rootSize) / workspaceHost.getBoundingClientRect().width,
  );
  workspace.splitRatio = Math.max(
    minimum,
    Math.min(1 - minimum, workspace.splitRatio),
  );
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
    if (origin?.isConnected) {
      origin.focus();
    } else {
      focusContent();
    }
  });
}

function focusFileTree() {
  document
    .querySelector<HTMLElement>(
      '.skr-desktop-sidebar [role="treeitem"][tabindex="0"]',
    )
    ?.focus();
}

/** Re-indexes the tree so newly discovered notes reach indexed surfaces. */
async function refreshTreeIndex(refreshTags = false) {
  const activeVault = vault;
  if (activeVault === null) {
    return;
  }
  try {
    const refreshedTree = await vaultTreeRefresh(activeVault);
    if (vault?.id !== activeVault.id) {
      return;
    }
    if (refreshTags) {
      await refreshTagCatalog(activeVault);
      if (vault?.id !== activeVault.id) {
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

async function renameTreeEntry(path: string) {
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
    }
  } catch (error) {
    errorText = describeError(STRINGS.treeOperationFailed, error);
  }
}

async function deleteTreeEntry(path: string) {
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
    splitPane: () => splitWorkspaceTab(),
    focusPane: focusWorkspacePaneDirection,
    moveTabToOtherPane: () => moveWorkspaceTabToOtherPane(),
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
const SPLIT_COMMAND_IDS = new Set([
  "pane.split-right",
  "pane.focus-left",
  "pane.focus-right",
  "pane.move-tab",
]);
const actionCommands = $derived(
  registry
    .pointerCommands("action-menu")
    .filter((command) => !narrowViewport || !SPLIT_COMMAND_IDS.has(command.id)),
);
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
) {
  if (
    surfaceFocusOrigin === null &&
    focusTarget instanceof HTMLElement &&
    focusTarget.isConnected
  ) {
    surfaceFocusOrigin = focusTarget;
  }
  taskStatusSurfaceMarker = currentTaskStatusMarker(focusTarget);
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
  if (narrowViewport && workspace.panes.length === 2) {
    const [first, second] = workspace.panes;
    if (first !== undefined && second !== undefined) {
      for (const tab of second.tabs) {
        if (!first.tabs.some((candidate) => candidate.path === tab.path)) {
          first.tabs.push(tab);
        }
      }
      if (workspace.focusedPaneId === second.id && second.activePath !== null) {
        first.activePath = second.activePath;
      }
      workspace.panes = [first];
      workspace.focusedPaneId = first.id;
    }
  }
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
  workspace.panes.flatMap((pane) => pane.tabs.map((tab) => tab.path)),
);
const parsedOverlayQuery = $derived(parsePickerQuery(overlayQuery));

function visibleCommandItems(query: string): PickerItem[] {
  return commandItems(registry, query, macPlatform).filter(
    (item) => !narrowViewport || !SPLIT_COMMAND_IDS.has(item.value),
  );
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
  try {
    const entries = await tagCatalog(handle);
    if (generation === tagCatalogGeneration && vault?.id === handle.id) {
      setTagCatalog(entries);
    }
  } catch {
    // Keep the last indexed catalog when search is temporarily unavailable.
  }
}

async function refreshTreeAfterTagCatalog(handle: VaultHandle) {
  await refreshTagCatalog(handle);
  if (vault?.id === handle.id) {
    await refreshTree();
  }
}

function onOverlayPick(item: PickerItem) {
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
    openPath(item.value);
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
  const pane = workspace.panes.find(
    (candidate) => candidate.id === workspace.focusedPaneId,
  );
  const tab = pane?.tabs.find(
    (candidate) => candidate.path === pane.activePath,
  );
  return tab?.dirty ?? null;
}

function onEditorDirtyChanged(
  paneId: string,
  path: string | null,
  dirty: boolean,
) {
  if (path === null) return;
  const pane = workspace.panes.find((candidate) => candidate.id === paneId);
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
  const next = await loadObsidianConfig(handle);
  if (
    generation !== obsidianReadGeneration ||
    vault?.id !== handle.id ||
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

async function openVaultAtPath(path: string, initialNote?: string) {
  errorText = null;
  tagCatalogGeneration += 1;
  if ((await editor?.flush()) === false) {
    errorText = STRINGS.contentSwitchUnsaved;
    return;
  }
  const request = contentRequests.next();
  try {
    const handle = await openVault(path);
    const [nextTree, config, , nextTags] = await Promise.all([
      vaultTree(handle),
      loadObsidianConfig(handle),
      watchSubscribe(handle),
      tagCatalog(handle).catch(() => []),
    ]);
    if (!contentRequests.isCurrent(request)) {
      return;
    }
    vault = handle;
    activeVaultPath = path;
    workspaceIdentity = path;
    workspace = loadWorkspaceState(path);
    outlineOpen = !workspace.outlineCollapsed;
    tree = nextTree;
    selectedPath = workspace.selectedPath;
    treeTitleSources = {};
    void loadTreeTitles(handle, nextTree);
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
    if (navigationSurface === "browser") {
      await resolvePermalinkNavigation(handle, nextTree);
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
      notePathsOf(nextTree).includes(focusedWorkspacePane().activePath ?? "")
    ) {
      const pane = focusedWorkspacePane();
      const path = pane.activePath;
      if (path !== null) {
        const tab = ensurePaneTab(pane, path);
        await openNote(path, tab.viewState);
        updatePaneNavigationState();
      }
    } else if (addressed !== null) {
      await navigation?.start(addressed);
    } else if (typeof harnessNote === "string") {
      if (navigationSurface === "browser")
        await navigation?.start({ path: harnessNote });
      else await navigateToNote(harnessNote);
    }
  } catch (error) {
    if (!contentRequests.isCurrent(request)) {
      return;
    }
    errorText = describeError(STRINGS.vaultOpenFailed, error);
  }
}

function comparableNativePath(path: string): string {
  const normalized = path.replace(/[\\/]+$/u, "");
  return /Win/u.test(navigator.platform)
    ? normalized.toLocaleLowerCase()
    : normalized;
}

async function handleNativeOpen(path: string): Promise<void> {
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
      await openVaultAtPath(target.vault_path, target.note_path);
    }
  } catch {
    errorText = STRINGS.fileOpenFailed;
  }
}

let nativeOpenQueue = Promise.resolve();
function drainNativeOpenFiles(): void {
  nativeOpenQueue = nativeOpenQueue
    .catch(() => {})
    .then(async () => {
      for (const path of await openFilesTake()) await handleNativeOpen(path);
    });
}

async function pickVault() {
  const path = await openDirectoryDialog({ directory: true, multiple: false });
  if (path === null) {
    return;
  }
  await openVaultAtPath(path);
}

async function refreshTree() {
  const currentVault = vault;
  if (currentVault === null) {
    return;
  }
  try {
    const nextTree = await vaultTree(currentVault);
    if (vault !== currentVault) {
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
    if (vault !== currentVault || !contentRequests.isCurrent(request)) {
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
    if (vault !== currentVault || !contentRequests.isCurrent(request)) {
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

async function navigateToNote(path: string, fragment?: string): Promise<void> {
  const address = fragment === undefined ? { path } : { path, fragment };
  if (navigationSurface === "browser") {
    await (navigation?.open(address) ?? openNoteAddress(address));
    const pane = focusedWorkspacePane();
    ensurePaneTab(pane, path);
    pane.activePath = path;
    return;
  }
  captureFocusedTabState();
  const pane = focusedWorkspacePane();
  const tab = ensurePaneTab(pane, path);
  const opened = await openNoteAddress(address, tab.viewState);
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
    navigate: async (address) => {
      focusReadingSurface();
      try {
        await navigateToNote(address.path, address.fragment);
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

function openPath(path: string) {
  if (activeSheet === "file-tree") {
    closeSheet();
  }
  if (path.toLowerCase().endsWith(".canvas")) {
    void openCanvas(path);
  } else {
    void navigateToNote(path);
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
          if (key.startsWith("skribeum.workspace.v1.")) {
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
      void openVaultAtPath(path);
    } else if (attempts > 50 || vault !== null) {
      clearInterval(timer);
    }
  }, 100);
  return timer;
}

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
      if (key.startsWith("skribeum.workspace.v1.")) {
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
  const unlisteners = [
    events.vaultCollisionsDetected.listen((event) => {
      collisionGroups = event.payload.groups;
    }),
    events.openFilesAvailable.listen(() => {
      drainNativeOpenFiles();
    }),
    // Raw watcher events refresh the tree; content reconciliation for open
    // notes arrives through the typed events below, never through raw
    // (possibly unstable) modification events.
    events.vaultChanged.listen((event) => {
      if (vault === null || event.payload.vault !== vault.id) {
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
      if (vault === null || event.payload.vault !== vault.id) {
        return;
      }
      void refreshTagCatalog(vault);
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
      if (vault === null || event.payload.vault !== vault.id) {
        return;
      }
      void refreshTreeAfterTagCatalog(vault);
      if (event.payload.path === selectedPath) {
        editor?.markRemoved();
        pushBanner({
          text: STRINGS.noteRemovedBanner,
          paths: [event.payload.path],
        });
      }
    }),
    events.reconciliationBanner.listen((event) => {
      if (vault === null || event.payload.vault !== vault.id) {
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
      if (vault === null || event.payload.vault !== vault.id) {
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
      if (vault === null || event.payload.vault !== vault.id) {
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
  if (hasDesktopRuntime()) drainNativeOpenFiles();
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
        <span class="skr-warning skr-read-only-badge rounded px-2 py-0.5 text-xs">
          {STRINGS.readOnlyBadge}
        </span>
      {/if}
      <button
        type="button"
        class="skr-header-overflow skr-header-icon-button"
        aria-label={STRINGS.overflowMenuLabel}
        aria-haspopup="dialog"
        onpointerdown={() => prepareOverflowContext()}
        onfocus={(event) => prepareOverflowContext(event.relatedTarget)}
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
    <aside class="skr-warning border-b px-3 py-1 text-xs" role="alert">
      {STRINGS.collisionBanner}
      {collisionGroups.map((group) => group.join(" / ")).join("; ")}
    </aside>
  {/if}
  {#if note?.readOnly}
    <aside class="skr-warning border-b px-3 py-1 text-xs" role="alert">
      {STRINGS.nonUtf8Banner}
    </aside>
  {/if}
  <Banners {banners} onDismiss={dismissBanner} />
  {#if errorText !== null}
    <aside class="skr-error border-b px-3 py-1 text-xs" role="alert">
      {errorText}
    </aside>
  {/if}

  <main class="flex min-h-0 flex-1 overflow-hidden">
    {#if vault !== null}
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
        {#if !workspace.sidebarCollapsed}
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
          onCollapse={() => togglePanel("sidebar")}
        />
        {/if}
      </div>
    {/if}
    <div class="skr-workspace" bind:this={workspaceHost}>
      {#if vault === null}
        <div class="skr-empty-vault">
          <button
            type="button"
            class="skr-btn-primary"
            disabled={openVaultDisabledReason !== null}
            title={openVaultDisabledReason ?? undefined}
            data-command-id="vault.open"
            data-btn-role="primary"
            onclick={() => registry.run("vault.open", commandContext())}
          >
            {STRINGS.openVault}
          </button>
          <p class="sr-only">{STRINGS.emptyStateHint}</p>
        </div>
      {:else}
        {#each workspace.panes as pane, paneIndex (pane.id)}
          {#if paneIndex === 1}
            <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <div
              class="skr-split-divider"
              class:skr-split-divider-dragging={splitDragging}
              role="separator"
              aria-label={STRINGS.paneResize}
              aria-orientation="vertical"
              aria-valuemin="20"
              aria-valuemax="80"
              aria-valuenow={Math.round(workspace.splitRatio * 100)}
              tabindex="0"
              onpointerdown={beginSplitResize}
              ondblclick={() => (workspace.splitRatio = 0.5)}
              onkeydown={resizeSplitWithKeyboard}
            ></div>
          {/if}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <section
            class="skr-editor-pane"
            class:skr-editor-pane-focused={pane.id === workspace.focusedPaneId}
            style={workspace.panes.length === 2
              ? `flex-basis: ${(paneIndex === 0 ? workspace.splitRatio : 1 - workspace.splitRatio) * 100}%`
              : undefined}
            data-pane-id={pane.id}
            aria-label={`${STRINGS.editorPane} ${paneIndex + 1}`}
            onfocusin={() => void focusWorkspacePane(pane.id)}
            onpointerdown={() => void focusWorkspacePane(pane.id)}
            ondragover={(event) => {
              if (
                event.dataTransfer?.types.includes(
                  "application/x-skribeum-tree-path",
                )
              ) {
                event.preventDefault();
                splitDropPaneId = null;
                return;
              }
              if (workspace.panes.length !== 1) return;
              const bounds = event.currentTarget.getBoundingClientRect();
              if (event.clientX >= bounds.left + (bounds.width * 2) / 3) {
                event.preventDefault();
                splitDropPaneId = pane.id;
              } else {
                splitDropPaneId = null;
              }
            }}
            ondragleave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                splitDropPaneId = null;
              }
            }}
            ondrop={(event) => {
              const treePath = event.dataTransfer?.getData(
                "application/x-skribeum-tree-path",
              );
              if (treePath) {
                event.preventDefault();
                void (async () => {
                  await focusWorkspacePane(pane.id);
                  await navigateToNote(treePath);
                })();
              } else {
                const tabPath = event.dataTransfer?.getData(
                  "application/x-skribeum-tab",
                );
                if (tabPath && splitDropPaneId === pane.id) {
                  event.preventDefault();
                  void splitWorkspaceTab(tabPath);
                }
              }
              splitDropPaneId = null;
            }}
          >
            <TabStrip
              tabs={pane.tabs}
              activePath={pane.activePath}
              titleSources={treeTitleSources}
              focused={pane.id === workspace.focusedPaneId}
              closeTooltip={tooltipForCommand("tab.close", STRINGS.closeTab)}
              onActivate={(path) => {
                void focusWorkspacePane(pane.id).then(() => activateWorkspaceTab(path));
              }}
              onClose={(path) => {
                void focusWorkspacePane(pane.id).then(() => closeWorkspaceTab(path));
              }}
              onReorder={(from, to) => {
                if (pane.id === workspace.focusedPaneId) reorderWorkspaceTabs(from, to);
              }}
            />
            <div
              class="skr-pane-content"
              use:captureContentHost={pane.id}
              tabindex="-1"
              data-testid="reading-surface"
              data-note-path={pane.id === workspace.focusedPaneId ? selectedPath : pane.activePath}
            >
              {#if pane.id !== workspace.focusedPaneId && pane.activePath !== null}
                <div class="skr-unfocused-note">
                  <ReadOnlyNote
                    source={treeTitleSources[pane.activePath] ?? ""}
                    label={STRINGS.editorLabel}
                    context={{ ...(linkContext ?? EMPTY_WIKILINK_CONTEXT), currentPath: pane.activePath }}
                    taskStatuses={settingsState.document.task_statuses}
                  />
                </div>
              {:else if contentView === VIEW_CANVAS && canvas !== null}
                <CanvasView
                  bind:this={canvasViewer}
                  {canvas}
                  previews={canvasPreviews}
                  {linkContext}
                  taskStatuses={settingsState.document.task_statuses}
                  onOpenNode={openPath}
                  onMoveNode={(nodeId, x, y) => void moveCanvasNode(nodeId, x, y)}
                  onRemoveNode={(nodeId) => void removeCanvasNode(nodeId)}
                  onAddNode={() => void addCanvasNode()}
                />
              {:else if contentView === VIEW_CANVAS && canvasError !== null}
                <div class="skr-error m-4 rounded border p-3 text-sm" role="alert" data-testid="canvas-error">
                  {canvasError}
                </div>
              {:else if missingAddress !== null}
                <div
                  class="skr-error m-4 max-w-2xl rounded border p-4 text-sm"
                  role="alert"
                  data-testid="note-not-found"
                >
                  <h2 class="m-0 text-base font-semibold">{STRINGS.noteNotFoundTitle}</h2>
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
                  vault={note !== null ? vault : null}
                  path={note !== null ? selectedPath : null}
                  {linkContext}
                  {propertyTypes}
                  taskStatuses={settingsState.document.task_statuses}
                  {registry}
                  {commandContext}
                  settings={settingsState.document}
                  {sourceMode}
                  {historyViewState}
                  {onConflict}
                  {onWriteError}
                  onDocChanged={onEditorDocChanged}
                  onDirtyChanged={(dirty) => onEditorDirtyChanged(pane.id, pane.activePath, dirty)}
                  onTitleVisibilityChange={(visible) => (noteTitleVisible = visible)}
                  onSaved={onEditorSaved}
                  onStatisticsChanged={(statistics) => (editorStatistics = statistics)}
                  onPersistenceChanged={(state) => (persistenceState = state)}
                  {wikilinkNavigationOptions}
                  {tagAffordanceOptions}
                />
              {/if}
            </div>
            {#if splitDropPaneId === pane.id}
              <div class="skr-pane-split-target" aria-hidden="true"></div>
            {/if}
          </section>
        {/each}
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
          onCollapse={() => togglePanel("outline")}
        />
        <section class="skr-outline-content" aria-label={STRINGS.outlineLabel}>
          <div class="skr-outline-header">
            <span>{STRINGS.outlineLabel}</span>
            <button
              type="button"
              data-command-id="panel.outline.toggle"
              aria-label={STRINGS.collapseOutline}
              use:commandTooltip={tooltipForCommand("panel.outline.toggle", STRINGS.collapseOutline)}
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
  <Sheet
    label={STRINGS.overflowMenuLabel}
    onClose={closeSheet}
    restoreFocus={false}
    variant={narrowViewport ? "sheet" : "anchored"}
  >
    <nav class="skr-action-menu" aria-label={STRINGS.overflowMenuLabel}>
      {#each overflowCommands as item (item.command?.id)}
        {#if item.command !== undefined}
          <button
            type="button"
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
          data-command-id={command.id}
          data-checked={command.id === TOGGLE_SOURCE_MODE_COMMAND
            ? String(sourceMode)
            : undefined}
          aria-pressed={command.id === TOGGLE_SOURCE_MODE_COMMAND
            ? sourceMode
            : undefined}
          disabled={command.id === TOGGLE_SOURCE_MODE_COMMAND && note === null}
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
          data-command-id={command.id}
          onclick={() => runActionCommand(command.id)}
        >
          <span>{command.title}</span>
        </button>
      {/each}
      {#if vaultOpenCommand !== undefined}
        <button
          type="button"
          data-command-id={vaultOpenCommand.id}
          disabled={openVaultDisabledReason !== null}
          title={openVaultDisabledReason ?? undefined}
          onclick={() => runActionCommand(vaultOpenCommand.id)}
        >
          <span>{vaultOpenCommand.title}</span>
        </button>
      {/if}
    </nav>
  </Sheet>
{/if}

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
