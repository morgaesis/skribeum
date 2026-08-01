<script lang="ts">
import {
  type FlatOutlineRow,
  flattenOutline,
  type OutlineEntry,
} from "./features/outline";
import { STRINGS } from "./strings";

let {
  entries,
  onNavigate,
}: {
  entries: OutlineEntry[];
  onNavigate: (from: number) => void;
} = $props();

let collapsed = $state<Set<number>>(new Set());
let focusIndex = $state(0);
let itemElements: HTMLElement[] = [];

const rows = $derived.by((): FlatOutlineRow[] =>
  flattenOutline(entries, collapsed),
);

$effect(() => {
  if (focusIndex >= rows.length) {
    focusIndex = Math.max(0, rows.length - 1);
  }
});

function focusRow(index: number) {
  focusIndex = index;
  itemElements[index]?.focus();
}

function toggleCollapse(row: FlatOutlineRow) {
  const next = new Set(collapsed);
  if (next.has(row.entry.from)) {
    next.delete(row.entry.from);
  } else {
    next.add(row.entry.from);
  }
  collapsed = next;
}

function activate(row: FlatOutlineRow) {
  onNavigate(row.entry.from);
}

// registry-exempt keydown: ARIA tree pattern internal navigation (arrows
// move and collapse, Home/End jump, Enter navigates), roving tabindex on
// the items, scoped to this widget; the command that opens the panel is a
// registry keybinding.
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
      if (row.hasChildren && collapsed.has(row.entry.from)) {
        toggleCollapse(row);
      } else {
        focusRow(Math.min(focusIndex + 1, rows.length - 1));
      }
      break;
    case "ArrowLeft":
      if (row.hasChildren && !collapsed.has(row.entry.from)) {
        toggleCollapse(row);
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

<div class="flex h-full flex-col overflow-hidden text-sm">
  <h2 class="skr-panel-heading m-0 border-b px-2 py-1 text-xs font-semibold uppercase tracking-wide">
    {STRINGS.outlineLabel}
  </h2>
  {#if rows.length === 0}
    <p class="skr-muted m-0 px-2 py-1 text-xs">{STRINGS.outlineEmpty}</p>
  {:else}
    <ul
      class="m-0 list-none overflow-y-auto p-1"
      role="tree"
      aria-label={STRINGS.outlineLabel}
      onkeydown={onKeydown}
    >
      {#each rows as row, index (row.entry.from)}
        <!-- svelte-ignore a11y_click_events_have_key_events -- keyboard
             input is handled at the tree container per the ARIA tree
             pattern with roving tabindex on the items. -->
        <li
          bind:this={itemElements[index]}
          role="treeitem"
          aria-level={row.depth}
          aria-selected={index === focusIndex}
          aria-expanded={row.hasChildren ? !collapsed.has(row.entry.from) : undefined}
          tabindex={index === focusIndex ? 0 : -1}
          class="cursor-pointer truncate rounded px-2 py-0.5"
          style={`padding-left: ${0.5 + (row.depth - 1) * 0.75}rem`}
          onclick={() => {
            focusRow(index);
            activate(row);
          }}
        >
          {#if row.hasChildren}
            <span
              aria-hidden="true"
              role="presentation"
              onclick={(event) => {
                event.stopPropagation();
                toggleCollapse(row);
              }}>{collapsed.has(row.entry.from) ? "▸" : "▾"}</span>
          {/if}
          {row.entry.title}
        </li>
      {/each}
    </ul>
  {/if}
</div>
