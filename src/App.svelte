<script lang="ts">
import { open as openDirectoryDialog } from "@tauri-apps/plugin-dialog";
import { onMount } from "svelte";
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
import { M0_FIXTURE } from "./lib/fixture";
import {
  type BannerReason,
  type ByteRangeReplace,
  events,
  type TreeEntry,
  type VaultHandle,
} from "./lib/ipc/bindings";
import {
  IpcError,
  type LoadedNote,
  openVault,
  readNote,
  readVaultConfigFile,
  vaultTree,
  watchSubscribe,
} from "./lib/ipc/vault";
import { STRINGS } from "./lib/strings";

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

let nextBannerId = 0;
// Journal-recovered deltas for notes that are not open yet, applied as
// pending edits when the note opens.
const pendingRecovered = new Map<string, ByteRangeReplace[]>();

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
  linkContext = {
    paths: tree
      .filter((entry) => entry.kind !== "directory")
      .map((entry) => entry.path),
    config: obsidianConfig,
  };
}

/**
 * Reads the optional `.obsidian` configuration (link knobs, declared
 * property types) read-only through the existing `note_read` command.
 * Absent files leave the defaults; nothing is ever written.
 */
async function readObsidianConfig(handle: VaultHandle) {
  const [appJson, typesJson] = await Promise.all([
    readVaultConfigFile(handle, ".obsidian/app.json"),
    readVaultConfigFile(handle, ".obsidian/types.json"),
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
    await readObsidianConfig(handle);
    refreshLinkContext();
    await watchSubscribe(handle);
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
  try {
    const loaded = await readNote(vault, path);
    const recovered = pendingRecovered.get(path);
    if (recovered !== undefined) {
      pendingRecovered.delete(path);
      loaded.recoveredChangeSet = recovered;
      pushBanner({ text: STRINGS.noteRecoveredNotice });
    }
    note = loaded;
    selectedPath = path;
  } catch (error) {
    errorText = describeError(STRINGS.noteReadFailed, error);
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
  const pollTimer = pollEndToEndVault();
  return () => {
    clearInterval(pollTimer);
    for (const unlisten of unlisteners) {
      void unlisten.then((dispose) => dispose());
    }
  };
});
</script>

<div class="flex h-screen flex-col overflow-hidden">
  <header class="flex items-center gap-3 border-b border-gray-200 px-3 py-1.5">
    <h1 class="m-0 text-sm font-semibold">{STRINGS.appTitle}</h1>
    <button
      type="button"
      class="rounded border border-gray-300 px-2 py-0.5 text-sm outline-offset-1 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500"
      onclick={pickVault}
    >
      {STRINGS.openVault}
    </button>
    {#if note?.readOnly}
      <span class="rounded bg-amber-100 px-2 py-0.5 text-xs">{STRINGS.readOnlyBadge}</span>
    {/if}
  </header>

  {#if collisionGroups.length > 0}
    <aside class="border-b border-amber-300 bg-amber-50 px-3 py-1 text-xs" role="alert">
      {STRINGS.collisionBanner}
      {collisionGroups.map((group) => group.join(" / ")).join("; ")}
    </aside>
  {/if}
  {#if note?.readOnly}
    <aside class="border-b border-amber-300 bg-amber-50 px-3 py-1 text-xs" role="alert">
      {STRINGS.nonUtf8Banner}
    </aside>
  {/if}
  <Banners {banners} onDismiss={dismissBanner} />
  {#if errorText !== null}
    <aside class="border-b border-red-300 bg-red-50 px-3 py-1 text-xs" role="alert">
      {errorText}
    </aside>
  {/if}

  <main class="flex min-h-0 flex-1 overflow-hidden">
    {#if vault !== null}
      <nav class="w-64 shrink-0 overflow-y-auto border-r border-gray-200">
        <FileTree entries={tree} {selectedPath} onOpenNote={openNote} />
      </nav>
    {/if}
    <section class="min-w-0 flex-1">
      {#if note !== null}
        <Editor
          bind:this={editor}
          {note}
          {vault}
          path={selectedPath}
          {linkContext}
          {propertyTypes}
          {onConflict}
          {onWriteError}
        />
      {:else}
        <!-- The scaffold fixture stays as the empty-state view. -->
        <Editor doc={M0_FIXTURE} />
        {#if vault === null}
          <p class="sr-only">{STRINGS.emptyStateHint}</p>
        {/if}
      {/if}
    </section>
  </main>
</div>
