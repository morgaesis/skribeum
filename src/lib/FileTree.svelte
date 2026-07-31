<script lang="ts">
import { tick } from "svelte";
import type { TreeEntry } from "./ipc/bindings";
import { STRINGS } from "./strings";

const ROW_HEIGHT = 24;
const TREE_PADDING = 4;
const OVERSCAN_ROWS = 12;

let {
  entries,
  selectedPath = null,
  onOpenPath,
}: {
  entries: TreeEntry[];
  selectedPath?: string | null;
  onOpenPath: (path: string) => void;
} = $props();

let expanded = $state<Record<string, boolean>>({});
let focusIndex = $state(0);
let scrollTop = $state(0);
let viewportHeight = $state(0);
let treeElement = $state<HTMLUListElement>();
let itemElements: Array<HTMLElement | undefined> = [];

type Row = TreeEntry & {
  depth: number;
  name: string;
  position: number;
  setSize: number;
};

const rows = $derived.by((): Row[] => {
  const visible: Array<Omit<Row, "position" | "setSize"> & { parent: string }> =
    [];
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
        parent: ancestors.join("/"),
      });
    }
  }
  const setSizes = new Map<string, number>();
  for (const row of visible) {
    setSizes.set(row.parent, (setSizes.get(row.parent) ?? 0) + 1);
  }
  const positions = new Map<string, number>();
  return visible.map(({ parent, ...row }) => {
    const position = (positions.get(parent) ?? 0) + 1;
    positions.set(parent, position);
    return { ...row, position, setSize: setSizes.get(parent) ?? 1 };
  });
});

const windowStart = $derived(
  Math.max(
    0,
    Math.floor(Math.max(0, scrollTop - TREE_PADDING) / ROW_HEIGHT) -
      OVERSCAN_ROWS,
  ),
);
const windowEnd = $derived(
  Math.min(
    rows.length,
    Math.ceil(
      Math.max(0, scrollTop + viewportHeight - TREE_PADDING) / ROW_HEIGHT,
    ) + OVERSCAN_ROWS,
  ),
);
const renderedIndices = $derived.by((): number[] => {
  const indices = Array.from(
    { length: Math.max(0, windowEnd - windowStart) },
    (_, offset) => windowStart + offset,
  );
  if (
    focusIndex < rows.length &&
    (focusIndex < windowStart || focusIndex >= windowEnd)
  ) {
    indices.push(focusIndex);
    indices.sort((left, right) => left - right);
  }
  return indices;
});

$effect(() => {
  if (focusIndex >= rows.length) {
    focusIndex = Math.max(0, rows.length - 1);
  }
});

$effect(() => {
  const element = treeElement;
  if (element === undefined) {
    return;
  }
  const measure = () => {
    viewportHeight = element.clientHeight;
  };
  measure();
  const observer = new ResizeObserver(measure);
  observer.observe(element);
  return () => observer.disconnect();
});

async function focusRow(index: number) {
  if (rows.length === 0) {
    return;
  }
  const nextIndex = Math.max(0, Math.min(index, rows.length - 1));
  focusIndex = nextIndex;
  if (treeElement !== undefined) {
    const rowTop = TREE_PADDING + nextIndex * ROW_HEIGHT;
    const rowBottom = rowTop + ROW_HEIGHT;
    const viewportBottom = treeElement.scrollTop + treeElement.clientHeight;
    let nextScrollTop = treeElement.scrollTop;
    if (rowTop < treeElement.scrollTop) {
      nextScrollTop = rowTop;
    } else if (rowBottom > viewportBottom) {
      nextScrollTop = rowBottom - treeElement.clientHeight;
    }
    if (nextScrollTop !== treeElement.scrollTop) {
      treeElement.scrollTop = nextScrollTop;
      scrollTop = nextScrollTop;
    }
  }
  await tick();
  itemElements[nextIndex]?.focus();
}

function activate(row: Row) {
  if (row.kind === "directory") {
    expanded[row.path] = !expanded[row.path];
  } else if (
    row.kind === "note" ||
    row.path.toLowerCase().endsWith(".canvas")
  ) {
    onOpenPath(row.path);
  }
}

function parentIndex(row: Row): number {
  const parent = row.path.split("/").slice(0, -1).join("/");
  return rows.findIndex((candidate) => candidate.path === parent);
}

// registry-exempt keydown: ARIA tree pattern internal navigation (arrows
// move and expand, Home/End jump, Enter and Space activate) with roving
// tabindex, scoped to this widget; opening notes beyond the tree goes
// through registry commands.
function onKeydown(event: KeyboardEvent) {
  const row = rows[focusIndex];
  if (row === undefined) {
    return;
  }
  switch (event.key) {
    case "ArrowDown":
      void focusRow(Math.min(focusIndex + 1, rows.length - 1));
      break;
    case "ArrowUp":
      void focusRow(Math.max(focusIndex - 1, 0));
      break;
    case "ArrowRight":
      if (row.kind === "directory" && !expanded[row.path]) {
        expanded[row.path] = true;
      } else if (row.kind === "directory") {
        void focusRow(Math.min(focusIndex + 1, rows.length - 1));
      }
      break;
    case "ArrowLeft":
      if (row.kind === "directory" && expanded[row.path]) {
        expanded[row.path] = false;
      } else {
        const parent = parentIndex(row);
        if (parent >= 0) {
          void focusRow(parent);
        }
      }
      break;
    case "Home":
      void focusRow(0);
      break;
    case "End":
      void focusRow(rows.length - 1);
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
  bind:this={treeElement}
  class="relative m-0 h-full list-none overflow-y-auto p-0 text-sm"
  role="tree"
  aria-label={STRINGS.vaultTreeLabel}
  onkeydown={onKeydown}
  onscroll={(event) => {
    scrollTop = event.currentTarget.scrollTop;
    viewportHeight = event.currentTarget.clientHeight;
  }}
>
  <li
    role="presentation"
    aria-hidden="true"
    class="pointer-events-none"
    style={`height: ${TREE_PADDING * 2 + rows.length * ROW_HEIGHT}px`}
  ></li>
  {#each renderedIndices as index (rows[index]?.path)}
    {@const row = rows[index]}
    {#if row !== undefined}
    <!-- svelte-ignore a11y_click_events_have_key_events -- keyboard input is
         handled at the tree container per the ARIA tree pattern: arrows,
         Home/End, Enter and Space, with roving tabindex on the items. -->
    <li
      bind:this={itemElements[index]}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-posinset={row.position}
      aria-setsize={row.setSize}
      aria-expanded={row.kind === "directory" ? Boolean(expanded[row.path]) : undefined}
      aria-selected={row.kind === "note" || row.path.toLowerCase().endsWith(".canvas") ? row.path === selectedPath : undefined}
      aria-disabled={row.kind === "file" && !row.path.toLowerCase().endsWith(".canvas") ? true : undefined}
      tabindex={index === focusIndex ? 0 : -1}
      class="absolute right-0 left-0 h-6 cursor-pointer overflow-hidden rounded px-2 py-0.5 whitespace-nowrap outline-offset-1 focus-visible:outline-2 focus-visible:outline-blue-500"
      class:opacity-60={row.hidden || (row.kind === "file" && !row.path.toLowerCase().endsWith(".canvas"))}
      class:bg-blue-100={row.path === selectedPath}
      style={`top: ${TREE_PADDING + index * ROW_HEIGHT}px; padding-left: ${0.5 + row.depth}rem`}
      onclick={() => {
        void focusRow(index);
        activate(row);
      }}
    >
      {#if row.kind === "directory"}
        <span aria-hidden="true">{expanded[row.path] ? "▾" : "▸"}</span>
      {/if}
      {row.name}
    </li>
    {/if}
  {/each}
</ul>
