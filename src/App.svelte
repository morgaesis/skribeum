<script lang="ts">
import { open as openDirectoryDialog } from "@tauri-apps/plugin-dialog";
import { onMount, tick } from "svelte";
import Banners, { type BannerItem } from "./lib/Banners.svelte";
import Editor from "./lib/Editor.svelte";
import {
  DEFAULT_OBSIDIAN_APP_CONFIG,
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
  vaultTreeRefresh,
} from "./lib/ipc/services";
import {
  IpcError,
  type LoadedNote,
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
import { applyTheme, isThemeName } from "./lib/themes/theme";

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
let contentView = $state<string | null>(null);
let canvas = $state<CanvasDocument | null>(null);
let canvasPreviews = $state<Record<string, string>>({});
let canvasError = $state<string | null>(null);
let canvasViewer = $state<ReturnType<typeof CanvasView> | undefined>();

let nextBannerId = 0;
// Journal-recovered deltas for notes that are not open yet, applied as
// pending edits when the note opens.
const pendingRecovered = new Map<string, ByteRangeReplace[]>();

// The registration surface: every command, palette entry, view and
// keybinding is registered here; this shell only maps view ids to
// concrete components and provides command capabilities.
const registry = createAppRegistry();

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
  loaded: false,
});

function applyEditorFontSize(pixels: number) {
  document.documentElement.style.setProperty(
    "--skr-editor-font-size",
    `${pixels}px`,
  );
}

function applyEditorReadingMeasure(characters: number) {
  document.documentElement.style.setProperty(
    "--skr-editor-measure",
    `${characters}ch`,
  );
}

// Settings apply optimistically (the font size restart-free via the CSS
// variable); a failed write reverts and the settings view surfaces it.
const settingsStore = new SettingsStore((state) => {
  settingsState = state;
  applyEditorFontSize(state.document.editor_font_size);
  applyEditorReadingMeasure(state.document.editor_reading_measure);
  applyTheme(
    isThemeName(state.document.theme) ? state.document.theme : "system",
  );
});

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

function closeOverlay() {
  activeOverlay = null;
  if (contentView === VIEW_CANVAS) {
    canvasViewer?.focus();
  } else {
    editor?.getView()?.focus();
  }
}

function commandContext(): CommandContext {
  return {
    view: editor?.getView() ?? null,
    openNote: (path) => openNote(path),
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
  };
}

const onGlobalKeydown = globalKeydownHandler(registry, commandContext);

// Derived from the tree alone: the switcher's candidate list must not be
// rebuilt from every tree entry on each keystroke, which is what made the
// surface take most of a second to appear over a large vault.
const notePaths = $derived(notePathsOf(tree));

const overlayItems = $derived.by((): PickerItem[] => {
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
    );
  } catch (error) {
    searchResults = [];
    errorText = describeError(STRINGS.vaultSearchFailed, error);
  }
}

function onOverlayPick(id: string) {
  const overlay = activeOverlay;
  closeOverlay();
  if (overlay === VIEW_COMMAND_PALETTE) {
    registry.run(id, commandContext());
  } else if (overlay === VIEW_QUICK_SWITCHER) {
    void openNote(id);
  } else if (overlay === VIEW_VAULT_SEARCH) {
    void openSearchResult(id);
  }
}

/** Opens a search hit and selects its first match in the note. */
async function openSearchResult(path: string) {
  const result = searchResults.find((entry) => entry.path === path);
  await openNote(path);
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
    config: obsidianConfig,
    currentPath,
    embedAncestry: currentPath === null ? [] : [currentPath],
    embedDepth: 0,
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

/**
 * Reads the optional `.obsidian` configuration (link knobs, declared
 * property types) read-only through the `vault_config_read` command.
 * Absent files leave the defaults; nothing is ever written.
 */
async function readObsidianConfig(handle: VaultHandle) {
  const [appJson, typesJson] = await Promise.all([
    readVaultConfigFile(handle, "app.json"),
    readVaultConfigFile(handle, "types.json"),
  ]);
  obsidianConfig =
    appJson === null
      ? DEFAULT_OBSIDIAN_APP_CONFIG
      : parseObsidianAppConfig(appJson);
  propertyTypes = typesJson === null ? null : parseObsidianTypes(typesJson);
}

async function openVaultAtPath(path: string) {
  errorText = null;
  try {
    const handle = await openVault(path);
    vault = handle;
    tree = await vaultTree(handle);
    selectedPath = null;
    note = null;
    contentView = null;
    canvas = null;
    canvasError = null;
    await readObsidianConfig(handle);
    refreshLinkContext();
    await watchSubscribe(handle);
    const harnessNote = (window as Window & { __SKRIBEUM_E2E_NOTE__?: string })
      .__SKRIBEUM_E2E_NOTE__;
    if (typeof harnessNote === "string") {
      await openNote(harnessNote);
    }
  } catch (error) {
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
  if (vault === null) {
    return;
  }
  try {
    tree = await vaultTree(vault);
    refreshLinkContext();
  } catch (error) {
    errorText = describeError(STRINGS.vaultOpenFailed, error);
  }
}

async function openNote(path: string) {
  if (vault === null) {
    return;
  }
  errorText = null;
  // Persist pending edits of the current note before switching away.
  await editor?.flush();
  const debugWindow = window as Window & {
    __SKRIBEUM_DEBUG_NOTE_OPEN_MS__?: number;
    __SKRIBEUM_DEBUG_PERF__?: boolean;
  };
  const debugStart = debugWindow.__SKRIBEUM_DEBUG_PERF__
    ? performance.now()
    : undefined;
  delete debugWindow.__SKRIBEUM_DEBUG_NOTE_OPEN_MS__;
  try {
    const loaded = await readNote(vault, path);
    const recovered = pendingRecovered.get(path);
    if (recovered !== undefined) {
      pendingRecovered.delete(path);
      loaded.recoveredChangeSet = recovered;
      pushBanner({ text: STRINGS.noteRecoveredNotice });
    }
    note = loaded;
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
  } catch (error) {
    errorText = describeError(STRINGS.noteReadFailed, error);
  }
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
  errorText = null;
  await editor?.flush();
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
    void openNote(path);
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
    try {
      const loaded = await readNote(vault, path);
      editor?.reconcileWith(loaded);
    } catch (error) {
      errorText = describeError(STRINGS.noteReadFailed, error);
    }
    return;
  }
  await openNote(path);
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
  const debugWindow = window as Window & {
    __SKRIBEUM_DEBUG_OPEN_NOTE__?: (path: string) => Promise<void>;
    __SKRIBEUM_DEBUG_PERF__?: boolean;
  };
  if (debugWindow.__SKRIBEUM_DEBUG_PERF__ === true) {
    debugWindow.__SKRIBEUM_DEBUG_OPEN_NOTE__ = openNote;
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
  const pollTimer = pollEndToEndVault();
  return () => {
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
      class="rounded border border-gray-300 px-2 py-0.5 text-sm outline-offset-1 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500"
      onclick={pickVault}
    >
      {STRINGS.openVault}
    </button>
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
        <CanvasView bind:this={canvasViewer} {canvas} previews={canvasPreviews} />
      {:else if contentView === VIEW_CANVAS && canvasError !== null}
        <div class="skr-error m-4 rounded border p-3 text-sm" role="alert" data-testid="canvas-error">
          {canvasError}
        </div>
      {:else if note !== null}
        <Editor
          bind:this={editor}
          {note}
          {vault}
          path={selectedPath}
          {linkContext}
          {propertyTypes}
          {registry}
          {commandContext}
          {onConflict}
          {onWriteError}
          onDocChanged={onEditorDocChanged}
        />
      {:else}
        <!-- The scaffold fixture stays as the empty-state view. -->
        <Editor
          bind:this={editor}
          doc={M0_FIXTURE}
          {registry}
          {commandContext}
          onDocChanged={onEditorDocChanged}
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
    onClose={closeOverlay}
  />
{/if}
