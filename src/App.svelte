<script lang="ts">
import { open as openDirectoryDialog } from "@tauri-apps/plugin-dialog";
import { onMount, tick } from "svelte";
import tauriConfig from "../src-tauri/tauri.conf.json";
import Banners, { type BannerItem } from "./lib/Banners.svelte";
import Editor from "./lib/Editor.svelte";
import { currentWikilinkContext } from "./lib/editor/decorations/engine";
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
  createNoteNavigator,
  type FollowWikilinkOptions,
  followWikilinkUnderCursor,
  type NavigationState,
  type NoteAddress,
  type NoteNavigator,
  noteFragmentPosition,
} from "./lib/features/navigation";
import { computeOutline, type OutlineEntry } from "./lib/features/outline";
import {
  firstMatchText,
  type PickerItem,
  paletteItems,
  quickSwitcherItems,
  searchResultItems,
} from "./lib/features/pickers";
import {
  DEFAULT_SETTINGS,
  type SettingsState,
  SettingsStore,
} from "./lib/features/settingsStore";
import {
  VIEW_CANVAS,
  VIEW_COMMAND_PALETTE,
  VIEW_OUTLINE,
  VIEW_QUICK_SWITCHER,
  VIEW_SETTINGS,
  VIEW_VAULT_SEARCH,
} from "./lib/features/surfaces";
import { registerTaskStatusCommands } from "./lib/features/taskCommands";
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
  type SearchResult,
  searchQuery,
  settingsPath,
  vaultTreeRefresh,
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
import OutlinePanel from "./lib/OutlinePanel.svelte";
import PaletteOverlay from "./lib/PaletteOverlay.svelte";
import { type CommandContext, globalKeydownHandler } from "./lib/registry";
import CanvasView from "./lib/rendering/CanvasView.svelte";
import {
  type CanvasDocument,
  canvasFilePaths,
  parseCanvas,
} from "./lib/rendering/canvas";
import SettingsView from "./lib/SettingsView.svelte";
import { STRINGS } from "./lib/strings";
import {
  applyAppearance,
  isCodeFontName,
  isDarkPaletteName,
  isLightPaletteName,
  isProseFontName,
  isThemeName,
} from "./lib/themes/theme";

let {
  openVaultDisabledReason = null,
  navigationSurface = "desktop",
}: {
  openVaultDisabledReason?: string | null;
  navigationSurface?: "browser" | "desktop";
} = $props();

let vault = $state<VaultHandle | null>(null);
let tree = $state<TreeEntry[]>([]);
let selectedPath = $state<string | null>(null);
let note = $state<LoadedNote | null>(null);
let collisionGroups = $state<string[][]>([]);
let errorText = $state<string | null>(null);
let banners = $state<BannerItem[]>([]);
let editor = $state<ReturnType<typeof Editor> | undefined>();
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
let outlineOpen = $state(false);
let outlineEntries = $state<OutlineEntry[]>([]);
/** The live query of the open picker overlay. */
let overlayQuery = $state("");
let searchResults = $state<SearchResult[]>([]);
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

function openOverlay(id: string) {
  activeOverlay = id;
  overlayQuery = "";
  searchResults = [];
  if (id === VIEW_QUICK_SWITCHER) {
    void refreshTreeIndex();
  }
}

/** Re-indexes the tree so the switcher lists just-created notes. */
async function refreshTreeIndex() {
  if (vault === null) {
    return;
  }
  try {
    tree = await vaultTreeRefresh(vault);
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

function closeOverlay() {
  activeOverlay = null;
  focusContent();
}

function commandContext(): CommandContext {
  return {
    view: editor?.getView() ?? null,
    openNote: (path) => navigateToNote(path),
    createNote: createNewNote,
    openView: (id) => {
      if (id === VIEW_OUTLINE) {
        outlineOpen = true;
        refreshOutline();
      } else {
        openOverlay(id);
      }
    },
    toggleView: (id) => {
      if (id === VIEW_OUTLINE) {
        outlineOpen = !outlineOpen;
        if (outlineOpen) {
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
  };
}

const onGlobalKeydown = globalKeydownHandler(registry, commandContext);

// Derived from the tree alone: the switcher's candidate list must not be
// rebuilt from every tree entry on each keystroke, which is what made the
// surface take most of a second to appear over a large vault.
const notePaths = $derived(notePathsOf(tree));

const overlayItems = $derived.by((): PickerItem[] => {
  void settingsState.document.task_statuses;
  switch (activeOverlay) {
    case VIEW_COMMAND_PALETTE:
      return paletteItems(registry, overlayQuery, macPlatform);
    case VIEW_QUICK_SWITCHER:
      return quickSwitcherItems(notePaths, recents, overlayQuery);
    case VIEW_VAULT_SEARCH:
      return searchResultItems(searchResults);
    default:
      return [];
  }
});

function onOverlayQuery(query: string) {
  overlayQuery = query;
  if (activeOverlay === VIEW_VAULT_SEARCH) {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      void runVaultSearch(query);
    }, 200);
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
      settingsState.document.search_note_bodies,
      settingsState.document.search_case_sensitive,
    );
  } catch (error) {
    searchResults = [];
    errorText = describeError(STRINGS.vaultSearchFailed, error);
  }
}

function onOverlayPick(id: string) {
  const overlay = activeOverlay;
  if (overlay === VIEW_COMMAND_PALETTE) {
    // Keep the editor's selection stable until editor-scoped commands have
    // consumed it. Restoring focus first can reconcile a browser selection
    // change before the command reads the CodeMirror state.
    activeOverlay = null;
    registry.run(id, commandContext());
    if (activeOverlay === null) {
      focusContent();
    }
  } else if (overlay === VIEW_QUICK_SWITCHER) {
    closeOverlay();
    void navigateToNote(id);
  } else if (overlay === VIEW_VAULT_SEARCH) {
    closeOverlay();
    void openSearchResult(id);
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

function onEditorDocChanged() {
  if (outlineOpen) {
    scheduleOutlineRefresh();
  }
}

function pushBanner(banner: Omit<BannerItem, "id">) {
  nextBannerId += 1;
  banners = [...banners, { ...banner, id: nextBannerId }];
}

function dismissBanner(id: number) {
  banners = banners.filter((banner) => banner.id !== id);
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

async function openVaultAtPath(path: string) {
  errorText = null;
  if ((await editor?.flush()) === false) {
    errorText = STRINGS.contentSwitchUnsaved;
    return;
  }
  const request = contentRequests.next();
  try {
    const handle = await openVault(path);
    const [nextTree, config] = await Promise.all([
      vaultTree(handle),
      loadObsidianConfig(handle),
      watchSubscribe(handle),
    ]);
    if (!contentRequests.isCurrent(request)) {
      return;
    }
    vault = handle;
    tree = nextTree;
    selectedPath = null;
    note = null;
    missingAddress = null;
    contentView = null;
    canvas = null;
    canvasError = null;
    obsidianConfig = config.config;
    propertyTypes = config.types;
    refreshLinkContext();
    const harnessNote = (window as Window & { __SKRIBEUM_E2E_NOTE__?: string })
      .__SKRIBEUM_E2E_NOTE__;
    const addressed = navigation?.state().address ?? null;
    if (addressed !== null) {
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

async function openNote(path: string): Promise<boolean> {
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

async function openNoteAddress(address: NoteAddress): Promise<void> {
  const opened = await openNote(address.path);
  if (!opened) {
    if (missingAddress !== null) {
      missingAddress = address;
    }
    return;
  }
  if (address.fragment === undefined) {
    return;
  }
  await tick();
  const view = editor?.getView();
  if (view === undefined) {
    return;
  }
  const position = noteFragmentPosition(view.state, address.fragment);
  if (position !== null) {
    view.dispatch({
      selection: { anchor: position },
      scrollIntoView: true,
      userEvent: "select",
    });
  }
}

function navigateToNote(path: string, fragment?: string): Promise<void> {
  const address = fragment === undefined ? { path } : { path, fragment };
  return navigation?.open(address) ?? openNoteAddress(address);
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
    navigate: (address) =>
      navigation?.open(address) ?? openNoteAddress(address),
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
    canvas = null;
    canvasPreviews = {};
    canvasError = `${STRINGS.canvasParseFailed}: ${String(error)}`;
    contentView = VIEW_CANVAS;
    selectedPath = path;
  }
}

function openPath(path: string) {
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
      clearInterval(timer);
      void openVaultAtPath(path);
    } else if (attempts > 50 || vault !== null) {
      clearInterval(timer);
    }
  }, 100);
  return timer;
}

onMount(() => {
  navigation = createNoteNavigator({
    mode: navigationSurface,
    browserWindow: window,
    load: openNoteAddress,
    changed: (state) => {
      navigationState = state;
    },
  });
  navigationState = navigation.state();
  const debugWindow = window as Window & {
    __SKRIBEUM_DEBUG_OPEN_NOTE__?: (path: string) => Promise<void>;
    __SKRIBEUM_DEBUG_PERF__?: boolean;
  };
  if (debugWindow.__SKRIBEUM_DEBUG_PERF__ === true) {
    debugWindow.__SKRIBEUM_DEBUG_OPEN_NOTE__ = async (path) => {
      await openNote(path);
    };
  }
  const unlisteners = [
    events.vaultCollisionsDetected.listen((event) => {
      collisionGroups = event.payload.groups;
    }),
    // Raw watcher events refresh the tree; content reconciliation for open
    // notes arrives through the typed events below, never through raw
    // (possibly unstable) modification events.
    events.vaultChanged.listen((event) => {
      if (
        vault !== null &&
        event.payload.vault === vault.id &&
        event.payload.change !== "modified"
      ) {
        void refreshTree();
      }
    }),
    events.externalNoteUpdate.listen((event) => {
      if (vault === null || event.payload.vault !== vault.id) {
        return;
      }
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
      void refreshTree();
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
    navigation?.dispose();
    navigation = null;
    delete debugWindow.__SKRIBEUM_DEBUG_OPEN_NOTE__;
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

<div class="flex h-screen flex-col overflow-hidden">
  <header class="skr-app-header flex items-center gap-3 border-b px-3 py-1.5">
    <h1 class="m-0 text-sm font-semibold">{STRINGS.appTitle}</h1>
    <button
      type="button"
      class="skr-control rounded border px-2 py-0.5 text-sm"
      onclick={pickVault}
      disabled={openVaultDisabledReason !== null}
      title={openVaultDisabledReason ?? undefined}
    >
      {STRINGS.openVault}
    </button>
    <div class="flex items-center gap-1" aria-label={STRINGS.navigationHistoryLabel}>
      <button
        type="button"
        class="rounded border border-gray-300 px-2 py-0.5 text-sm outline-offset-1 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
        disabled={!navigationState.canGoBack}
        onclick={() => registry.run("navigation.back", commandContext())}
      >
        {STRINGS.navigationBack}
      </button>
      <button
        type="button"
        class="rounded border border-gray-300 px-2 py-0.5 text-sm outline-offset-1 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
        disabled={!navigationState.canGoForward}
        onclick={() => registry.run("navigation.forward", commandContext())}
      >
        {STRINGS.navigationForward}
      </button>
    </div>
    {#if note?.readOnly || contentView === VIEW_CANVAS}
      <span class="skr-warning rounded px-2 py-0.5 text-xs">{STRINGS.readOnlyBadge}</span>
    {/if}
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
      <nav class="skr-sidebar w-64 shrink-0 overflow-hidden border-r">
        <FileTree entries={tree} {selectedPath} onOpenPath={openPath} />
      </nav>
    {/if}
    <section class="min-w-0 flex-1">
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
              class="rounded border border-current px-2 py-1 outline-offset-2 focus-visible:outline-2 focus-visible:outline-blue-500"
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
          {onConflict}
          {onWriteError}
          onDocChanged={onEditorDocChanged}
          {wikilinkNavigationOptions}
        />
      {:else}
        <!-- The scaffold fixture stays as the empty-state view. -->
        <Editor
          bind:this={editor}
          doc={M0_FIXTURE}
          taskStatuses={settingsState.document.task_statuses}
          {registry}
          {commandContext}
          settings={settingsState.document}
          onDocChanged={onEditorDocChanged}
          {wikilinkNavigationOptions}
        />
        {#if vault === null}
          <p class="sr-only">{STRINGS.emptyStateHint}</p>
        {/if}
      {/if}
    </section>
    {#if outlineOpen}
      <aside class="skr-panel w-60 shrink-0 overflow-y-auto border-l">
        <OutlinePanel entries={outlineEntries} onNavigate={outlineNavigate} />
      </aside>
    {/if}
  </main>
</div>

{#if activeOverlay === VIEW_COMMAND_PALETTE}
  <PaletteOverlay
    label={STRINGS.commandPaletteLabel}
    placeholder={STRINGS.commandPalettePlaceholder}
    items={overlayItems}
    onQueryChange={onOverlayQuery}
    onPick={onOverlayPick}
    onClose={closeOverlay}
  />
{:else if activeOverlay === VIEW_QUICK_SWITCHER}
  <PaletteOverlay
    label={STRINGS.quickSwitcherLabel}
    placeholder={STRINGS.quickSwitcherPlaceholder}
    items={overlayItems}
    onQueryChange={onOverlayQuery}
    onPick={onOverlayPick}
    onClose={closeOverlay}
  />
{:else if activeOverlay === VIEW_VAULT_SEARCH}
  <PaletteOverlay
    label={STRINGS.vaultSearchLabel}
    placeholder={STRINGS.vaultSearchPlaceholder}
    items={overlayItems}
    onQueryChange={onOverlayQuery}
    onPick={onOverlayPick}
    onClose={closeOverlay}
  />
{:else if activeOverlay === VIEW_SETTINGS}
  <SettingsView
    settings={settingsState}
    onUpdate={(patch) => void settingsStore.update(patch)}
    onPreview={(patch) =>
      applySettings({ ...settingsState.document, ...patch })}
    onClose={closeOverlay}
    desktopAvailable={hasDesktopRuntime()}
    currentVersion={tauriConfig.version}
    {settingsFilePath}
    {updateState}
    onCheckUpdate={checkSelectedUpdateChannel}
  />
{/if}
