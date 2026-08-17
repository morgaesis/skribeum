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
  onCopyHeading,
  touchMode = false,
}: {
  entries: OutlineEntry[];
  onNavigate: (from: number) => void;
  onCopyHeading: (heading: string) => void;
  touchMode?: boolean;
} = $props();

let collapsed = $state<Set<number>>(new Set());
let focusIndex = $state(0);
let itemElements: Array<HTMLElement | null | undefined> = [];

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
  if (event.target instanceof HTMLButtonElement) return;
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

<div class="flex h-full flex-col overflow-hidden">
  <h2 class="skr-panel-heading m-0 border-b px-2 py-1 font-semibold uppercase tracking-wide">
    {STRINGS.outlineLabel}
  </h2>
  {#if rows.length === 0}
    <p class="skr-type-label skr-muted m-0 px-2 py-1">{STRINGS.outlineEmpty}</p>
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
          class="outline-row flex cursor-pointer items-center rounded px-2"
          style={`min-height: ${touchMode ? 44 : 28}px; padding-left: ${0.5 + (row.depth - 1) * 0.75}rem`}
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
          <span class="min-w-0 flex-1 truncate">{row.entry.title}</span>
          <button
            type="button"
            class="outline-copy"
            aria-label={`${STRINGS.copyLinkToHeading}: ${row.entry.title}`}
            data-command-id="link.copy-heading"
            onclick={(event) => {
              event.stopPropagation();
              onCopyHeading(row.entry.title);
            }}
          ><span aria-hidden="true">⧉</span></button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .outline-copy {
    display: grid;
    width: 1rem;
    height: 1rem;
    flex: none;
    place-items: center;
    border: 0;
    padding: 0;
    background: transparent;
    color: var(--skr-text-muted);
    font-size: var(--skr-type-label);
    line-height: 1;
    opacity: 0;
    transition: opacity var(--skr-motion-state-duration)
      var(--skr-motion-state-easing);
  }

  .outline-row:hover .outline-copy,
  .outline-row:focus .outline-copy,
  .outline-row:focus-within .outline-copy {
    opacity: 1;
  }

  .outline-copy:focus-visible {
    outline: 2px solid var(--skr-focus);
    outline-offset: 2px;
  }
</style>
