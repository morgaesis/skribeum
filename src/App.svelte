<script lang="ts">
import { open as openDirectoryDialog } from "@tauri-apps/plugin-dialog";
import { onMount, tick } from "svelte";
import tauriConfig from "../src-tauri/tauri.conf.json";
import Banners, { type BannerItem } from "./lib/Banners.svelte";
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
  followWikilinkUnderCursor,
  type NavigationState,
  type NoteAddress,
  type NoteNavigator,
  type NoteViewState,
  noteFragmentPosition,
} from "./lib/features/navigation";
import {
  computeOutline,
  headingAtOrBefore,
  type OutlineEntry,
} from "./lib/features/outline";
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
  vaultTreeRefresh,
  zoomSet,
} from "./lib/ipc/services";
import {
  IpcError,
  type LoadedNote,
  noteCreate,
  openVault,
  readNote,
  readVaultConfigFile,
  readVaultFile,
  vaultTree,
  watchSubscribe,
} from "./lib/ipc/vault";
import { resolveNoteTitle } from "./lib/noteTitles";
import OutlinePanel from "./lib/OutlinePanel.svelte";
import {
  type CommandContext,
  formatKeybinding,
  globalKeydownHandler,
} from "./lib/registry";
import CanvasView from "./lib/rendering/CanvasView.svelte";
import {
  type CanvasDocument,
  canvasFilePaths,
  parseCanvas,
} from "./lib/rendering/canvas";
import { NARROW_BREAKPOINT_REM } from "./lib/responsive";
import SettingsView from "./lib/SettingsView.svelte";
import Sheet from "./lib/Sheet.svelte";
import { STRINGS } from "./lib/strings";
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
let selectedPath = $state<string | null>(null);
let note = $state<LoadedNote | null>(null);
let collisionGroups = $state<string[][]>([]);
let errorText = $state<string | null>(null);
let banners = $state<BannerItem[]>([]);
let editor = $state<ReturnType<typeof Editor> | undefined>();
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

let nextBannerId = 0;
// Journal-recovered deltas for notes that are not open yet, applied as
// pending edits when the note opens.
const pendingRecovered = new Map<string, ByteRangeReplace[]>();

// The registration surface: every command, palette entry, view and
// keybinding is registered here; this shell only maps view ids to
// concrete components and provides command capabilities.
const registry = createAppRegistry(DEFAULT_SETTINGS.task_statuses);

const macPlatform =
  typeof navigator !== "undefined" &&
  /Mac|iP[ao]d|iPhone/.test(navigator.platform);

/** The transient surface currently open (a registered overlay view id). */
let activeOverlay = $state<string | null>(null);
type SheetId = "file-tree" | "outline" | "overflow";
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
        : "lamplight",
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
    refreshLinkContext();
    await openNote(path);
  } catch (error) {
    errorText = describeError(STRINGS.noteCreateFailed, error);
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
          focusFileTree();
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
    notePaths: () => notePathsOf(tree),
    recentNotePaths: () => recents,
    navigateBack: () => navigation?.back() ?? false,
    navigateForward: () => navigation?.forward() ?? false,
    followLink: followLinkUnderCursor,
    copyNoteLink,
    copyHeadingLink,
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
const actionCommands = $derived(registry.pointerCommands("action-menu"));
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

$effect(() => {
  if (narrowViewport && outlineOpen) {
    outlineOpen = false;
    refreshOutline();
    openSheet("outline");
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
const parsedOverlayQuery = $derived(parsePickerQuery(overlayQuery));

const overlayItems = $derived.by((): PickerItem[] => {
  void settingsState.document.task_statuses;
  if (activeOverlay !== VIEW_COMMAND_SURFACE) return [];
  switch (parsedOverlayQuery.mode) {
    case "command":
      return commandItems(
        registry,
        parsedOverlayQuery.query,
        macPlatform,
        commandContext(),
      );
    case "file":
      return appendBareDiscoveryItems(
        fileItems(
          commandSurfacePaths,
          recents,
          selectedPath === null ? [] : [selectedPath],
          parsedOverlayQuery.query,
        ),
        commandItems(
          registry,
          parsedOverlayQuery.query,
          macPlatform,
          commandContext(),
        ),
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

function copyOutlineHeading(heading: string) {
  registry.run("link.copy-heading", {
    ...commandContext(),
    heading,
  });
}

function onEditorDocChanged(source: string, path: string | null) {
  if (path === selectedPath) {
    currentNoteSource = source;
  }
  if (outlineOpen) {
    scheduleOutlineRefresh();
  }
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

function announceLinkCopied() {
  const id = pushBanner({ text: STRINGS.linkCopied, polite: true });
  transientBannerTimers.set(
    id,
    setTimeout(() => dismissBanner(id), 2000),
  );
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
    tree = nextTree;
    selectedPath = null;
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
    const harnessNote = (window as Window & { __SKRIBEUM_E2E_NOTE__?: string })
      .__SKRIBEUM_E2E_NOTE__;
    const addressed = navigation?.state().address ?? null;
    if (initialNote !== undefined) {
      await navigation?.reset({ path: initialNote });
    } else if (addressed !== null) {
      await navigation?.start(addressed);
    } else if (typeof harnessNote === "string") {
      await navigation?.start({ path: harnessNote });
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
    noteTitleVisible = !noteOpensWithHeading(loaded.text);
    currentNoteSource = loaded.text;
    sourceMode = false;
    note = loaded;
    missingAddress = null;
    contentView = null;
    canvas = null;
    canvasError = null;
    selectedPath = path;
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
  const opened = await openNote(address.path, restoration);
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
  await (navigation?.open(address) ?? openNoteAddress(address));
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
        await (navigation?.open(address) ?? openNoteAddress(address));
      } finally {
        focusReadingSurface();
        requestAnimationFrame(() => focusReadingSurface());
        setTimeout(focusReadingSurface, 0);
      }
    },
    unresolved: (reason) => {
      pushBanner({ text: reason });
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
  return followWikilinkUnderCursor(view, wikilinkNavigationOptions());
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
      const target = window as Window & {
        __SKRIBEUM_E2E_OPEN_NOTE__?: (path: string) => Promise<void>;
        __SKRIBEUM_E2E_HISTORY_STATE__?: () => NoteViewState | null;
      };
      target.__SKRIBEUM_E2E_OPEN_NOTE__ = (notePath) =>
        navigateToNote(notePath);
      target.__SKRIBEUM_E2E_HISTORY_STATE__ = () =>
        editor?.captureHistoryState() ?? null;
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
    __SKRIBEUM_E2E_VAULT__?: string;
  };
  if (debugWindow.__SKRIBEUM_DEBUG_PERF__ === true) {
    debugWindow.__SKRIBEUM_DEBUG_OPEN_NOTE__ = async (path) => {
      await openNote(path);
    };
  }
  if (typeof debugWindow.__SKRIBEUM_E2E_VAULT__ === "string") {
    debugWindow.__SKRIBEUM_E2E_OPEN_NOTE__ = (path) => navigateToNote(path);
    debugWindow.__SKRIBEUM_E2E_HISTORY_STATE__ = () =>
      editor?.captureHistoryState() ?? null;
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
  <header class="skr-app-header border-b">
    <div class="skr-header-leading">
      <h1 class="sr-only">{STRINGS.appTitle}</h1>
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
      <nav class="skr-sidebar skr-desktop-sidebar w-64 shrink-0 overflow-hidden border-r">
        <FileTree entries={tree} {selectedPath} onOpenPath={openPath} />
      </nav>
    {/if}
    <section
      class="min-w-0 flex-1"
      bind:this={contentHost}
      tabindex="-1"
      data-testid="reading-surface"
    >
      {#if contentView === VIEW_CANVAS && canvas !== null}
        <CanvasView
          bind:this={canvasViewer}
          {canvas}
          previews={canvasPreviews}
          {linkContext}
          taskStatuses={settingsState.document.task_statuses}
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
              class="skr-control rounded border px-2 py-1"
              onclick={refreshMissingNote}
            >
              {STRINGS.noteNotFoundRefresh}
            </button>
          {/if}
        </div>
      {:else if note !== null}
        <Editor
          bind:this={editor}
          {note}
          {vault}
          path={selectedPath}
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
          onTitleVisibilityChange={(visible) => (noteTitleVisible = visible)}
          onSaved={() => void refreshTagCatalog()}
          {wikilinkNavigationOptions}
          {tagAffordanceOptions}
        />
      {:else if vault !== null}
        <!-- The scaffold fixture stays as the empty-state view. -->
        <Editor
          bind:this={editor}
          doc={M0_FIXTURE}
          taskStatuses={settingsState.document.task_statuses}
          {registry}
          {commandContext}
          settings={settingsState.document}
          onDocChanged={onEditorDocChanged}
          onTitleVisibilityChange={(visible) => (noteTitleVisible = visible)}
          onSaved={() => void refreshTagCatalog()}
          {wikilinkNavigationOptions}
          {tagAffordanceOptions}
        />
      {:else}
        <div class="skr-empty-vault">
          <button
            type="button"
            class="skr-control rounded border px-3 py-2"
            disabled={openVaultDisabledReason !== null}
            title={openVaultDisabledReason ?? undefined}
            data-command-id="vault.open"
            onclick={() => registry.run("vault.open", commandContext())}
          >
            {STRINGS.openVault}
          </button>
          <p class="sr-only">{STRINGS.emptyStateHint}</p>
        </div>
      {/if}
    </section>
    {#if outlineOpen}
      <aside class="skr-panel skr-desktop-outline w-60 shrink-0 overflow-y-auto border-l">
        <OutlinePanel
          entries={outlineEntries}
          onNavigate={outlineNavigate}
          onCopyHeading={copyOutlineHeading}
        />
      </aside>
    {/if}
  </main>
</div>

{#if activeSheet === "file-tree" && vault !== null}
  <Sheet label={STRINGS.vaultTreeLabel} onClose={closeSheet} restoreFocus={false}>
    <FileTree
      entries={tree}
      {selectedPath}
      onOpenPath={openPath}
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
        {@const unavailableReason = registry.unavailableReason(command.id, commandContext())}
        <button
          type="button"
          data-command-id={command.id}
          data-checked={command.id === TOGGLE_SOURCE_MODE_COMMAND
            ? String(sourceMode)
            : undefined}
          aria-pressed={command.id === TOGGLE_SOURCE_MODE_COMMAND
            ? sourceMode
            : undefined}
          disabled={unavailableReason !== null ||
            (command.id === TOGGLE_SOURCE_MODE_COMMAND && note === null)}
          title={unavailableReason ?? undefined}
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
