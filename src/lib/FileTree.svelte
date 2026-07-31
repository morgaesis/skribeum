<script lang="ts">
import type { TreeEntry } from "./ipc/bindings";
import { STRINGS } from "./strings";

let {
  entries,
  selectedPath = null,
  onOpenNote,
}: {
  entries: TreeEntry[];
  selectedPath?: string | null;
  onOpenNote: (path: string) => void;
} = $props();

let expanded = $state<Record<string, boolean>>({});
let focusIndex = $state(0);
let itemElements: HTMLElement[] = [];

type Row = TreeEntry & { depth: number; name: string };

const rows = $derived.by((): Row[] => {
  const visible: Row[] = [];
  for (const entry of entries) {
    const segments = entry.path.split("/");
    const ancestors = segments.slice(0, -1);
    let shown = true;
    let prefix = "";
    for (const segment of ancestors) {
      prefix = prefix === "" ? segment : `${prefix}/${segment}`;
      if (!expanded[prefix]) {
        shown = false;
        break;
      }
    }
    if (shown) {
      visible.push({
        ...entry,
        depth: ancestors.length,
        name: segments[segments.length - 1] ?? entry.path,
      });
    }
  }
  return visible;
});

$effect(() => {
  if (focusIndex >= rows.length) {
    focusIndex = Math.max(0, rows.length - 1);
  }
});

function focusRow(index: number) {
  focusIndex = index;
  itemElements[index]?.focus();
}

function activate(row: Row) {
  if (row.kind === "directory") {
    expanded[row.path] = !expanded[row.path];
  } else if (row.kind === "note") {
    onOpenNote(row.path);
  }
}

function parentIndex(row: Row): number {
  const parent = row.path.split("/").slice(0, -1).join("/");
  return rows.findIndex((candidate) => candidate.path === parent);
}

function onKeydown(event: KeyboardEvent) {
  const row = rows[focusIndex];
  if (row === undefined) {
    return;
  }
  switch (event.key) {
    case "ArrowDown":
      focusRow(Math.min(focusIndex + 1, rows.length - 1));
      break;
    case "ArrowUp":
      focusRow(Math.max(focusIndex - 1, 0));
      break;
    case "ArrowRight":
      if (row.kind === "directory" && !expanded[row.path]) {
        expanded[row.path] = true;
      } else if (row.kind === "directory") {
        focusRow(Math.min(focusIndex + 1, rows.length - 1));
      }
      break;
    case "ArrowLeft":
      if (row.kind === "directory" && expanded[row.path]) {
        expanded[row.path] = false;
      } else {
        const parent = parentIndex(row);
        if (parent >= 0) {
          focusRow(parent);
        }
      }
      break;
    case "Home":
      focusRow(0);
      break;
    case "End":
      focusRow(rows.length - 1);
      break;
    case "Enter":
    case " ":
      activate(row);
      break;
    default:
      return;
  }
  event.preventDefault();
}
</script>

<ul
  class="m-0 list-none overflow-y-auto p-1 text-sm"
  role="tree"
  aria-label={STRINGS.vaultTreeLabel}
  onkeydown={onKeydown}
>
  {#each rows as row, index (row.path)}
    <!-- svelte-ignore a11y_click_events_have_key_events -- keyboard input is
         handled at the tree container per the ARIA tree pattern: arrows,
         Home/End, Enter and Space, with roving tabindex on the items. -->
    <li
      bind:this={itemElements[index]}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-expanded={row.kind === "directory" ? Boolean(expanded[row.path]) : undefined}
      aria-selected={row.kind === "note" ? row.path === selectedPath : undefined}
      aria-disabled={row.kind === "file" ? true : undefined}
      tabindex={index === focusIndex ? 0 : -1}
      class="cursor-pointer rounded px-2 py-0.5 outline-offset-1 focus-visible:outline-2 focus-visible:outline-blue-500"
      class:opacity-60={row.hidden || row.kind === "file"}
      class:bg-blue-100={row.path === selectedPath}
      style={`padding-left: ${0.5 + row.depth}rem`}
      onclick={() => {
        focusRow(index);
        activate(row);
      }}
    >
      {#if row.kind === "directory"}
        <span aria-hidden="true">{expanded[row.path] ? "▾" : "▸"}</span>
      {/if}
      {row.name}
    </li>
  {/each}
</ul>
