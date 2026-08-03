<script lang="ts">
import { tick } from "svelte";
import { commandTooltip } from "./commandTooltip";
import type { TreeEntry } from "./ipc/bindings";
import { noteFileName, noteIcon, resolveTitleCollisions } from "./noteTitles";
import type { CommandContext, CommandRegistry } from "./registry";
import { STRINGS } from "./strings";

const DESKTOP_ROW_HEIGHT = 28;
const TOUCH_ROW_HEIGHT = 44;
const TREE_PADDING = 4;
const OVERSCAN_ROWS = 12;
const HOLD_DELAY_MS = 550;

let {
  entries,
  selectedPath = null,
  titleSources = {},
  expandedPaths = [],
  onExpandedChange,
  onSelectionChange,
  onOpenPath,
  registry,
  commandContext,
  desktop = false,
  touchMode = false,
}: {
  entries: TreeEntry[];
  selectedPath?: string | null;
  titleSources?: Readonly<Record<string, string>>;
  expandedPaths?: readonly string[];
  onExpandedChange?: (paths: string[]) => void;
  onSelectionChange?: (path: string | null) => void;
  onOpenPath: (path: string) => void;
  registry?: CommandRegistry;
  commandContext?: () => CommandContext;
  desktop?: boolean;
  touchMode?: boolean;
} = $props();

const rowHeight = $derived(touchMode ? TOUCH_ROW_HEIGHT : DESKTOP_ROW_HEIGHT);

let userExpanded = $state<Record<string, boolean>>({});
let autoExpanded = $state<Record<string, boolean>>({});
let focusIndex = $state(0);
let scrollTop = $state(0);
let viewportHeight = $state(0);
let treeElement = $state<HTMLUListElement>();
let itemElements = $state<Array<HTMLElement | undefined>>([]);
let menuPath = $state<string | null>(null);
let menuLeft = $state(0);
let menuTop = $state(0);
let menuOrigin = $state<HTMLElement | null>(null);
let menuElement = $state<HTMLElement>();
let dragPath = $state<string | null>(null);
let dropPath = $state<string | null>(null);
let hoveredPath = $state<string | null>(null);
let holdTimer: ReturnType<typeof setTimeout> | null = null;

type Row = TreeEntry & {
  depth: number;
  label: string;
  suffix?: string;
  icon?: string;
  position: number;
  setSize: number;
};

function parentPath(path: string): string {
  return path.split("/").slice(0, -1).join("/");
}

function baseName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function expanded(path: string): boolean {
  return userExpanded[path] === true || autoExpanded[path] === true;
}

function noteRowsByParent(): Map<
  string,
  Map<string, { label: string; suffix?: string; icon?: string }>
> {
  const groups = new Map<string, TreeEntry[]>();
  for (const entry of entries) {
    if (entry.kind !== "note") continue;
    const parent = parentPath(entry.path);
    groups.set(parent, [...(groups.get(parent) ?? []), entry]);
  }
  const resolved = new Map<
    string,
    Map<string, { label: string; suffix?: string; icon?: string }>
  >();
  for (const [parent, notes] of groups) {
    const titles = resolveTitleCollisions(
      notes.map((entry) => ({
        path: entry.path,
        source: titleSources[entry.path] ?? "",
      })),
    );
    resolved.set(
      parent,
      new Map(
        notes.map((entry, index) => {
          const title = titles[index];
          const icon = noteIcon(titleSources[entry.path] ?? "");
          return [
            entry.path,
            {
              label: title?.displayTitle ?? noteFileName(entry.path),
              ...(title?.collisionSuffix === undefined
                ? {}
                : { suffix: title.collisionSuffix }),
              ...(titleSources[entry.path] === undefined || icon === null
                ? {}
                : { icon }),
            },
          ];
        }),
      ),
    );
  }
  return resolved;
}

const rows = $derived.by((): Row[] => {
  const noteRows = noteRowsByParent();
  const children = new Map<string, TreeEntry[]>();
  for (const entry of entries) {
    const parent = parentPath(entry.path);
    children.set(parent, [...(children.get(parent) ?? []), entry]);
  }
  const visible: Row[] = [];
  const append = (parent: string, depth: number) => {
    const siblings = [...(children.get(parent) ?? [])].sort((left, right) => {
      const leftLabel =
        noteRows.get(parent)?.get(left.path)?.label ?? baseName(left.path);
      const rightLabel =
        noteRows.get(parent)?.get(right.path)?.label ?? baseName(right.path);
      return leftLabel.localeCompare(rightLabel, undefined, {
        sensitivity: "base",
      });
    });
    siblings.forEach((entry, index) => {
      const notePresentation = noteRows.get(parent)?.get(entry.path);
      visible.push({
        ...entry,
        depth,
        label: notePresentation?.label ?? baseName(entry.path),
        ...(notePresentation?.suffix === undefined
          ? {}
          : { suffix: notePresentation.suffix }),
        ...(notePresentation?.icon === undefined
          ? {}
          : { icon: notePresentation.icon }),
        position: index + 1,
        setSize: siblings.length,
      });
      if (entry.kind === "directory" && expanded(entry.path)) {
        append(entry.path, depth + 1);
      }
    });
  };
  append("", 0);
  return visible;
});

const windowStart = $derived(
  Math.max(
    0,
    Math.floor(Math.max(0, scrollTop - TREE_PADDING) / rowHeight) -
      OVERSCAN_ROWS,
  ),
);
const windowEnd = $derived(
  Math.min(
    rows.length,
    Math.ceil(
      Math.max(0, scrollTop + viewportHeight - TREE_PADDING) / rowHeight,
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

const menuRow = $derived(rows.find((row) => row.path === menuPath) ?? null);
const menuCommands = $derived.by(() => {
  if (menuRow === null) return [];
  const ids =
    menuRow.kind === "directory"
      ? [
          "tree.note.create",
          "tree.folder.create",
          "tree.entry.rename",
          "tree.entry.delete",
          ...(desktop ? ["tree.entry.reveal"] : []),
        ]
      : menuRow.kind === "note"
        ? [
            "tree.entry.rename",
            "tree.entry.delete",
            "tree.note.copy-link",
            ...(desktop ? ["tree.entry.reveal"] : []),
          ]
        : [
            "tree.entry.rename",
            "tree.entry.delete",
            ...(desktop ? ["tree.entry.reveal"] : []),
          ];
  return ids
    .map((id) => registry?.command(id))
    .filter((command) => command !== undefined);
});

$effect(() => {
  const next: Record<string, boolean> = {};
  for (const path of expandedPaths) next[path] = true;
  userExpanded = next;
});

$effect(() => {
  const path = selectedPath;
  const next: Record<string, boolean> = {};
  if (path !== null) {
    const segments = path.split("/").slice(0, -1);
    for (let index = 1; index <= segments.length; index += 1) {
      const ancestor = segments.slice(0, index).join("/");
      if (userExpanded[ancestor] !== true) next[ancestor] = true;
    }
  }
  autoExpanded = next;
  if (path !== null) {
    void tick().then(() => {
      const index = rows.findIndex((row) => row.path === path);
      if (index >= 0) void focusRow(index, false);
    });
  }
});

$effect(() => {
  if (focusIndex >= rows.length) focusIndex = Math.max(0, rows.length - 1);
});

$effect(() => {
  if (menuPath === null) return;
  const dismiss = (event: PointerEvent) => {
    if (
      menuElement?.contains(event.target as Node) === true ||
      menuOrigin?.contains(event.target as Node) === true
    ) {
      return;
    }
    closeMenu(false);
  };
  document.addEventListener("pointerdown", dismiss, true);
  return () => document.removeEventListener("pointerdown", dismiss, true);
});

$effect(() => {
  const element = treeElement;
  if (element === undefined) return;
  const measure = () => (viewportHeight = element.clientHeight);
  measure();
  const observer = new ResizeObserver(measure);
  observer.observe(element);
  return () => observer.disconnect();
});

async function focusRow(index: number, focus = true) {
  if (rows.length === 0) return;
  const nextIndex = Math.max(0, Math.min(index, rows.length - 1));
  focusIndex = nextIndex;
  if (treeElement !== undefined) {
    const rowTop = TREE_PADDING + nextIndex * rowHeight;
    const rowBottom = rowTop + rowHeight;
    const viewportBottom = treeElement.scrollTop + treeElement.clientHeight;
    if (rowTop < treeElement.scrollTop) treeElement.scrollTop = rowTop;
    else if (rowBottom > viewportBottom) {
      treeElement.scrollTop = rowBottom - treeElement.clientHeight;
    }
    scrollTop = treeElement.scrollTop;
  }
  await tick();
  if (focus) itemElements[nextIndex]?.focus();
}

function persistExpanded() {
  onExpandedChange?.(
    Object.entries(userExpanded)
      .filter(([, open]) => open)
      .map(([path]) => path),
  );
}

function toggleFolder(row: Row) {
  userExpanded[row.path] = !expanded(row.path);
  delete autoExpanded[row.path];
  persistExpanded();
}

function activate(row: Row) {
  if (row.kind === "directory") {
    toggleFolder(row);
  } else if (
    row.kind === "note" ||
    row.path.toLowerCase().endsWith(".canvas")
  ) {
    onSelectionChange?.(row.path);
    onOpenPath(row.path);
  }
}

function parentIndex(row: Row): number {
  const parent = parentPath(row.path);
  return rows.findIndex((candidate) => candidate.path === parent);
}

function closeMenu(restore = true) {
  const origin = menuOrigin;
  menuPath = null;
  menuOrigin = null;
  if (restore) void tick().then(() => origin?.focus());
}

function openMenu(row: Row, origin: HTMLElement, x?: number, y?: number) {
  const bounds = origin.getBoundingClientRect();
  menuPath = row.path;
  menuOrigin = origin;
  menuLeft = x ?? bounds.right;
  menuTop = y ?? bounds.bottom;
  void tick().then(() => {
    const menu = menuElement;
    if (menu === undefined) return;
    const bounds = menu.getBoundingClientRect();
    menuLeft = Math.max(
      8,
      Math.min(menuLeft, window.innerWidth - bounds.width - 8),
    );
    menuTop = Math.max(
      8,
      Math.min(menuTop, window.innerHeight - bounds.height - 8),
    );
    menu.querySelector<HTMLElement>("button")?.focus();
  });
}

function runMenuCommand(id: string) {
  const path = menuPath;
  if (path === null || registry === undefined || commandContext === undefined)
    return;
  closeMenu(false);
  registry.run(id, { ...commandContext(), treePath: path });
}

function rowContextMenu(event: MouseEvent, row: Row) {
  event.preventDefault();
  openMenu(
    row,
    event.currentTarget as HTMLElement,
    event.clientX,
    event.clientY,
  );
}

function beginHold(event: PointerEvent, row: Row) {
  if (!touchMode && event.pointerType !== "touch") return;
  clearHold();
  const origin = event.currentTarget as HTMLElement;
  holdTimer = setTimeout(() => {
    holdTimer = null;
    openMenu(row, origin, event.clientX, event.clientY);
  }, HOLD_DELAY_MS);
}

function clearHold() {
  if (holdTimer !== null) clearTimeout(holdTimer);
  holdTimer = null;
}

// registry-exempt keydown: ARIA tree and menu roving navigation stay inside
// their widgets. Every application action dispatched from the menu is a
// registered command.
function onKeydown(event: KeyboardEvent) {
  const row = rows[focusIndex];
  if (row === undefined) return;
  switch (event.key) {
    case "ArrowDown":
      void focusRow(Math.min(focusIndex + 1, rows.length - 1));
      break;
    case "ArrowUp":
      void focusRow(Math.max(focusIndex - 1, 0));
      break;
    case "ArrowRight":
      if (row.kind === "directory" && !expanded(row.path)) toggleFolder(row);
      else if (row.kind === "directory") void focusRow(focusIndex + 1);
      break;
    case "ArrowLeft":
      if (row.kind === "directory" && expanded(row.path)) toggleFolder(row);
      else {
        const parent = parentIndex(row);
        if (parent >= 0) void focusRow(parent);
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
    case "F10":
      if (!event.shiftKey) return;
      openMenu(
        row,
        itemElements[focusIndex] ?? (event.currentTarget as HTMLElement),
      );
      break;
    case "ContextMenu":
      openMenu(
        row,
        itemElements[focusIndex] ?? (event.currentTarget as HTMLElement),
      );
      break;
    default:
      return;
  }
  event.preventDefault();
}

function onMenuKeydown(event: KeyboardEvent) {
  const buttons = [
    ...(menuElement?.querySelectorAll<HTMLButtonElement>("button") ?? []),
  ];
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
  let next: number | null = null;
  if (event.key === "ArrowDown") next = (current + 1) % buttons.length;
  else if (event.key === "ArrowUp")
    next = (current - 1 + buttons.length) % buttons.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = buttons.length - 1;
  else if (event.key === "Enter" || event.key === " ") {
    buttons[current]?.click();
    event.preventDefault();
    return;
  } else if (event.key === "Escape") {
    closeMenu();
    event.preventDefault();
    return;
  } else if (event.key === "Tab") {
    closeMenu(false);
    return;
  }
  if (next === null) return;
  event.preventDefault();
  buttons[next]?.focus();
}

function dropOn(destination: string | null) {
  const source = dragPath;
  dragPath = null;
  dropPath = null;
  if (
    source === null ||
    source === destination ||
    registry === undefined ||
    commandContext === undefined
  )
    return;
  registry.run("tree.entry.move", {
    ...commandContext(),
    treePath: source,
    treeDestination: destination,
  });
}
</script>

<ul
  bind:this={treeElement}
  class="skr-file-tree"
  role="tree"
  aria-label={STRINGS.vaultTreeLabel}
  onkeydown={onKeydown}
  onscroll={(event) => {
    scrollTop = event.currentTarget.scrollTop;
    viewportHeight = event.currentTarget.clientHeight;
  }}
  ondragover={(event) => {
    if (dragPath !== null) {
      event.preventDefault();
      dropPath = "";
    }
  }}
  ondrop={(event) => {
    event.preventDefault();
    dropOn(null);
  }}
>
  <li
    role="presentation"
    aria-hidden="true"
    class="skr-tree-spacer"
    style={`height: ${TREE_PADDING * 2 + rows.length * rowHeight}px`}
  ></li>
  {#each renderedIndices as index (rows[index]?.path)}
    {@const row = rows[index]}
    {#if row !== undefined}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <li
        bind:this={itemElements[index]}
        role="treeitem"
        aria-level={row.depth + 1}
        aria-posinset={row.position}
        aria-setsize={row.setSize}
        aria-expanded={row.kind === "directory" ? expanded(row.path) : undefined}
        aria-selected={row.kind === "note" || row.path.toLowerCase().endsWith(".canvas") ? row.path === selectedPath : undefined}
        aria-disabled={row.kind === "file" && !row.path.toLowerCase().endsWith(".canvas") ? true : undefined}
        data-path={row.path}
        tabindex={index === focusIndex ? 0 : -1}
        class="skr-tree-row"
        class:skr-tree-row-disabled={row.kind === "file" && !row.path.toLowerCase().endsWith(".canvas")}
        class:skr-tree-row-dragging={dragPath === row.path}
        class:skr-tree-row-drop={dropPath === row.path}
        class:skr-tree-row-hovered={hoveredPath === row.path}
        style={`top: ${TREE_PADDING + index * rowHeight}px; height: ${rowHeight}px; padding-left: ${0.5 + row.depth}rem`}
        draggable={row.kind !== "file" || row.path.toLowerCase().endsWith(".canvas")}
        onfocus={() => (focusIndex = index)}
        onclick={() => {
          void focusRow(index);
          activate(row);
        }}
        oncontextmenu={(event) => rowContextMenu(event, row)}
        onpointerdown={(event) => beginHold(event, row)}
        onpointerenter={() => (hoveredPath = row.path)}
        onpointerleave={() => {
          if (hoveredPath === row.path) hoveredPath = null;
        }}
        onpointerup={clearHold}
        onpointercancel={clearHold}
        onpointermove={clearHold}
        ondragstart={(event) => {
          dragPath = row.path;
          event.dataTransfer?.setData("text/plain", row.path);
          if (row.kind === "note") {
            event.dataTransfer?.setData(
              "application/x-skribeum-tree-path",
              row.path,
            );
          }
        }}
        ondragend={() => {
          dragPath = null;
          dropPath = null;
        }}
        ondragover={(event) => {
          if (row.kind === "directory" && dragPath !== null && !row.path.startsWith(`${dragPath}/`)) {
            event.preventDefault();
            event.stopPropagation();
            dropPath = row.path;
          }
        }}
        ondrop={(event) => {
          if (row.kind === "directory") {
            event.preventDefault();
            event.stopPropagation();
            dropOn(row.path);
          }
        }}
      >
        {#each Array(row.depth) as _, guide}
          <span
            class="skr-tree-indent-guide"
            aria-hidden="true"
            style={`left: ${0.5 + guide}rem`}
          ></span>
        {/each}
        <span class="skr-tree-leading" aria-hidden="true">
          {#if row.kind === "directory"}
            <svg viewBox="0 0 16 16" class:skr-tree-chevron-open={expanded(row.path)}>
              <path d="m5.5 3.5 4.5 4.5-4.5 4.5" />
            </svg>
          {:else if row.icon !== undefined}
            <span class="skr-tree-note-icon">{row.icon}</span>
          {/if}
        </span>
        <span class="skr-tree-label">{row.label}</span>
        {#if row.suffix !== undefined}
          <span class="skr-tree-suffix">{row.suffix}</span>
        {/if}
        <button
          type="button"
          class="skr-tree-actions"
          aria-label={`${STRINGS.rowActions}: ${row.label}`}
          aria-haspopup="menu"
          use:commandTooltip={{ title: STRINGS.rowActions }}
          onclick={(event) => {
            event.stopPropagation();
            openMenu(row, event.currentTarget);
          }}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="3" cy="8" r="1" />
            <circle cx="8" cy="8" r="1" />
            <circle cx="13" cy="8" r="1" />
          </svg>
        </button>
      </li>
    {/if}
  {/each}
</ul>

{#if menuRow !== null}
  <div
    bind:this={menuElement}
    class="skr-tree-menu"
    role="menu"
    tabindex="-1"
    aria-label={`${STRINGS.rowActions}: ${menuRow.label}`}
    style={`left: ${menuLeft}px; top: ${menuTop}px`}
    onkeydown={onMenuKeydown}
  >
    {#each menuCommands as command (command.id)}
      <button
        type="button"
        role="menuitem"
        data-command-id={command.id}
        onclick={() => runMenuCommand(command.id)}
      >
        {command.title}
      </button>
    {/each}
  </div>
{/if}
