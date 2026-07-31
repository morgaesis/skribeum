<script lang="ts">
import { open as openDirectoryDialog } from "@tauri-apps/plugin-dialog";
import { onMount } from "svelte";
import Editor from "./lib/Editor.svelte";
import FileTree from "./lib/FileTree.svelte";
import { M0_FIXTURE } from "./lib/fixture";
import { events, type TreeEntry, type VaultHandle } from "./lib/ipc/bindings";
import {
  IpcError,
  type LoadedNote,
  openVault,
  readNote,
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

function describeError(context: string, error: unknown): string {
  if (error instanceof IpcError) {
    return `${context}: ${error.app.message}`;
  }
  return `${context}: ${String(error)}`;
}

async function pickVault() {
  errorText = null;
  const path = await openDirectoryDialog({ directory: true, multiple: false });
  if (path === null) {
    return;
  }
  try {
    const handle = await openVault(path);
    vault = handle;
    tree = await vaultTree(handle);
    selectedPath = null;
    note = null;
    await watchSubscribe(handle);
  } catch (error) {
    errorText = describeError(STRINGS.vaultOpenFailed, error);
  }
}

async function openNote(path: string) {
  if (vault === null) {
    return;
  }
  errorText = null;
  try {
    note = await readNote(vault, path);
    selectedPath = path;
  } catch (error) {
    errorText = describeError(STRINGS.noteReadFailed, error);
  }
}

onMount(() => {
  const unlistenCollisions = events.vaultCollisionsDetected.listen((event) => {
    collisionGroups = event.payload.groups;
  });
  // Re-read the displayed note when an external change touches it; the
  // browse surface is read-only, so refreshing cannot lose anything.
  const unlistenChanges = events.vaultChanged.listen((event) => {
    if (
      vault !== null &&
      event.payload.vault === vault.id &&
      event.payload.change === "modified" &&
      event.payload.path !== null &&
      event.payload.path === selectedPath
    ) {
      void openNote(event.payload.path);
    }
  });
  return () => {
    void unlistenCollisions.then((unlisten) => unlisten());
    void unlistenChanges.then((unlisten) => unlisten());
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
        <Editor doc={note.text} readOnly={true} />
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
