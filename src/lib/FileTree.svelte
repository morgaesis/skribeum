<script lang="ts">
import { onDestroy, tick } from "svelte";
import { computeAnchoredPosition } from "./anchoredMenu";
import { commandTooltip } from "./commandTooltip";
import type { TreeEntry } from "./ipc/bindings";
import {
  enterMotionSurface,
  exitMotionSurface,
  motionDurationMilliseconds,
} from "./motion";
import { noteFileName, noteIcon, resolveTitleCollisions } from "./noteTitles";
import type { CommandContext, CommandRegistry } from "./registry";
import { STRINGS } from "./strings";
import { visualViewportRect } from "./visualViewport";

const DESKTOP_ROW_HEIGHT = 28;
const TOUCH_ROW_HEIGHT = 44;
const TREE_PADDING = 4;
const OVERSCAN_ROWS = 12;
const HOLD_DELAY_MS = 550;

// The folder reveal choreography: rows displaced by a toggle translate from
// their previous slot and revealed or hidden rows cross-fade, all on the
// panel clock, while row hover fills keep the state clock throughout.
const FOLDER_REVEAL_TRANSITION = [
  "transform var(--skr-motion-panel-duration) var(--skr-motion-panel-easing)",
  "opacity var(--skr-motion-panel-duration) var(--skr-motion-panel-easing)",
  "background-color var(--skr-motion-state-duration) var(--skr-motion-state-easing)",
].join(", ");

// The open note's highlight travel: a compositor-only transform on the
// panel clock, matching the folder reveal's own reflow clock above.
const ACTIVE_HIGHLIGHT_TRAVEL_TRANSITION =
  "transform var(--skr-motion-panel-duration) var(--skr-motion-panel-easing)";

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
  onOpenPath: (path: string, options?: { newTab?: boolean }) => void;
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
let menuCloseGeneration = 0;
let folderMotionGeneration = 0;
let folderMotionFrame: number | null = null;
let folderMotionTimer: ReturnType<typeof setTimeout> | null = null;
let folderMotionElements: HTMLElement[] = [];
let ghostElements = $state<Array<HTMLElement | undefined>>([]);
let leavingRows = $state<GhostRow[]>([]);
let highlightElement = $state<HTMLElement>();
// Plain (non-reactive) bookkeeping: the choreography effect below both
// reads and writes these, and making them `$state` would make its own
// writes re-trigger itself mid-flush, stomping the entrance markers it had
// just set.
let highlightRestTop: number | null = null;
let highlightAnimatedPath: string | null = null;
let highlightMotionGeneration = 0;
let highlightMotionFrame: number | null = null;
let highlightMotionTimer: ReturnType<typeof setTimeout> | null = null;
let mounted = true;

type RowPresentation = {
  path: string;
  kind: TreeEntry["kind"];
  depth: number;
  label: string;
  suffix?: string;
  icon?: string;
};

type Row = TreeEntry & {
  depth: number;
  label: string;
  suffix?: string;
  icon?: string;
  position: number;
  setSize: number;
};

/** A collapsed row lingering only long enough to fade out. */
type GhostRow = RowPresentation & {
  open: boolean;
  top: number;
  opacity: number;
};

type FolderMotionSnapshot = {
  presentation: RowPresentation;
  open: boolean;
  top: number;
  opacity: number;
};

function parentPath(path: string): string {
  return path.split("/").slice(0, -1).join("/");
}

function baseName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function transformOffset(element: HTMLElement, axis: "x" | "y"): number {
  const transform = getComputedStyle(element).transform.trim();
  if (transform === "" || transform === "none") return 0;

  const matrix3d = transform.match(/^matrix3d\(([^)]+)\)$/);
  if (matrix3d !== null) {
    const values = matrix3d[1]?.split(",").map(Number) ?? [];
    return values[axis === "x" ? 12 : 13] ?? 0;
  }
  const matrix = transform.match(/^matrix\(([^)]+)\)$/);
  if (matrix !== null) {
    const values = matrix[1]?.split(",").map(Number) ?? [];
    return values[axis === "x" ? 4 : 5] ?? 0;
  }

  const translate = transform.match(
    /^translate\(\s*(-?[\d.]+)px(?:,\s*(-?[\d.]+)px)?\s*\)$/,
  );
  if (translate !== null) {
    return Number.parseFloat(translate[axis === "x" ? 1 : 2] ?? "0");
  }
  const axisTranslate = transform.match(
    new RegExp(`^translate${axis.toUpperCase()}\\(\\s*(-?[\\d.]+)px\\s*\\)$`),
  );
  return axisTranslate === null
    ? 0
    : Number.parseFloat(axisTranslate[1] ?? "0");
}

function renderedCoordinate(
  element: HTMLElement,
  axis: "x" | "y",
  fallback: number,
): number {
  const property = axis === "x" ? element.style.left : element.style.top;
  const base = Number.parseFloat(property);
  return (
    (Number.isFinite(base) ? base : fallback) + transformOffset(element, axis)
  );
}

function renderedOpacity(element: HTMLElement): number {
  const opacity = Number.parseFloat(getComputedStyle(element).opacity);
  return Number.isFinite(opacity) ? opacity : 1;
}

function cancelHighlightCallbacks(): void {
  if (highlightMotionFrame !== null) {
    cancelAnimationFrame(highlightMotionFrame);
    highlightMotionFrame = null;
  }
  if (highlightMotionTimer !== null) {
    clearTimeout(highlightMotionTimer);
    highlightMotionTimer = null;
  }
}

function cancelFolderCallbacks(): void {
  if (folderMotionFrame !== null) {
    cancelAnimationFrame(folderMotionFrame);
    folderMotionFrame = null;
  }
  if (folderMotionTimer !== null) {
    clearTimeout(folderMotionTimer);
    folderMotionTimer = null;
  }
}

onDestroy(() => {
  mounted = false;
  highlightMotionGeneration += 1;
  folderMotionGeneration += 1;
  menuCloseGeneration += 1;
  cancelHighlightCallbacks();
  cancelFolderCallbacks();
  clearHold();
});
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

const activeRowIndex = $derived(
  selectedPath === null
    ? -1
    : rows.findIndex((row) => row.path === selectedPath),
);
const activeRowTop = $derived(
  activeRowIndex < 0 ? null : TREE_PADDING + activeRowIndex * rowHeight,
);

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
            "tree.note.open-in-new-tab",
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
  const previous = autoExpanded;
  const changed =
    Object.keys(previous).length !== Object.keys(next).length ||
    Object.keys(next).some((ancestor) => previous[ancestor] !== true);
  if (changed) {
    const snapshots = captureFolderMotion();
    const collapsingPaths = Object.keys(previous).filter(
      (folderPath) =>
        previous[folderPath] === true &&
        next[folderPath] !== true &&
        userExpanded[folderPath] !== true,
    );
    const generation = ++folderMotionGeneration;
    cancelFolderCallbacks();
    settleFolderMotion();
    autoExpanded = next;
    void playFolderReveal(snapshots, generation, collapsingPaths);
  }
  if (path !== null) {
    void tick().then(() => {
      if (!mounted) return;
      const index = rows.findIndex((row) => row.path === path);
      if (index >= 0) void focusRow(index, false);
    });
  }
});

/**
 * Travels the open-note highlight from its previous row to the new one on
 * the panel clock, a compositor-only transform. The overlay's own geometry
 * (top) always applies instantly; only the leftover transform interpolates.
 * This effect re-runs for reasons other than a selection change too (the
 * tree reflowing under an unchanged selection, e.g. a sibling folder
 * toggling), in which case it just follows the new geometry with no
 * choreography at all: the travel is reserved for an actual note change.
 * When the previous row has left the screen (first selection, or the row
 * sat inside what is now a collapsed folder), there is nothing to travel
 * from, so the highlight enters in place with the surface class instead.
 */
$effect(() => {
  const path = selectedPath;
  const top = activeRowTop;
  const element = highlightElement;
  if (element === undefined) return;

  if (top === null) {
    highlightMotionGeneration += 1;
    cancelHighlightCallbacks();
    // Deliberately leaves `highlightAnimatedPath` untouched: a row can
    // resolve to null on an intermediate pass within the same flush (e.g.
    // the tree hasn't derived its rows yet) before settling on the real
    // target a moment later, and recording the path here would make that
    // later, real pass look like a no-op re-selection instead of new.
    element.style.transition = "";
    element.style.transform = "";
    element.style.opacity = "0";
    highlightRestTop = null;
    return;
  }

  const isNewSelection = path !== highlightAnimatedPath;
  highlightAnimatedPath = path;
  const previousTop =
    highlightRestTop === null
      ? null
      : renderedCoordinate(element, "y", highlightRestTop);
  cancelHighlightCallbacks();
  const generation = ++highlightMotionGeneration;

  // The panel-duration custom property is root-scoped (theme and the
  // reduced-motion/animations-off overrides both apply at `:root`), so this
  // reads it from the document root rather than the tree element, which may
  // not have its `bind:this` resolved yet on the very first run.
  const duration = motionDurationMilliseconds("--skr-motion-panel-duration");

  if (duration === 0 || !isNewSelection) {
    delete element.dataset.motionSurface;
    element.style.transition = "";
    element.style.transform = "";
    element.style.opacity = "1";
    element.style.top = `${top}px`;
    highlightRestTop = top;
    return;
  }

  if (previousTop === null) {
    element.style.transition = "";
    element.style.transform = "";
    element.style.opacity = "";
    element.style.top = `${top}px`;
    highlightRestTop = top;
    delete element.dataset.motionExiting;
    element.dataset.motionSurface = "fade";
    enterMotionSurface(element);
    return;
  }

  delete element.dataset.motionSurface;
  element.style.transition = "none";
  element.style.opacity = "1";
  element.style.top = `${top}px`;
  element.style.transform = `translateY(${previousTop - top}px)`;
  highlightRestTop = top;
  void element.offsetHeight;
  highlightMotionFrame = requestAnimationFrame(() => {
    highlightMotionFrame = null;
    if (!mounted || generation !== highlightMotionGeneration) return;
    element.style.transition = ACTIVE_HIGHLIGHT_TRAVEL_TRANSITION;
    element.style.transform = "";
    highlightMotionTimer = setTimeout(() => {
      highlightMotionTimer = null;
      if (!mounted || generation !== highlightMotionGeneration) return;
      element.style.transition = "";
    }, duration);
  });
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
  const dismissOnBlur = () => closeMenu(false);
  document.addEventListener("pointerdown", dismiss, true);
  window.addEventListener("blur", dismissOnBlur);
  return () => {
    document.removeEventListener("pointerdown", dismiss, true);
    window.removeEventListener("blur", dismissOnBlur);
  };
});

$effect(() => {
  const element = treeElement;
  if (element === undefined) return;
  const measure = () => {
    if (mounted) viewportHeight = element.clientHeight;
  };
  measure();
  const observer = new ResizeObserver(measure);
  observer.observe(element);
  return () => observer.disconnect();
});

async function focusRow(index: number, focus = true) {
  if (rows.length === 0) return;
  const nextIndex = Math.max(0, Math.min(index, rows.length - 1));
  focusIndex = nextIndex;
  if (treeElement != null) {
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
  if (!mounted) return;
  if (focus) itemElements[nextIndex]?.focus();
}

function restoreMenuTreeFocus(path: string): () => void {
  const originIndex = rows.findIndex((row) => row.path === path);
  if (originIndex >= 0) {
    focusIndex = originIndex;
    itemElements[originIndex]?.focus();
  }

  return () => {
    const exactIndex = rows.findIndex((row) => row.path === path);
    if (exactIndex >= 0) {
      void focusRow(exactIndex);
      return;
    }
    if (rows.length > 0) {
      // A removed row hands focus to its following sibling when available,
      // otherwise the preceding sibling at the final surviving index.
      void focusRow(Math.min(Math.max(originIndex, 0), rows.length - 1));
      return;
    }
    treeElement?.focus();
  };
}

function persistExpanded() {
  onExpandedChange?.(
    Object.entries(userExpanded)
      .filter(([, open]) => open)
      .map(([path]) => path),
  );
}

function toggleFolder(row: Row) {
  void toggleFolderWithReveal(row);
}

function captureFolderMotion(): Map<string, FolderMotionSnapshot> {
  const snapshots = new Map<string, FolderMotionSnapshot>();
  for (const index of renderedIndices) {
    const row = rows[index];
    const element = itemElements[index];
    if (row === undefined || element === undefined) continue;
    snapshots.set(row.path, {
      presentation: {
        path: row.path,
        kind: row.kind,
        depth: row.depth,
        label: row.label,
        ...(row.suffix === undefined ? {} : { suffix: row.suffix }),
        ...(row.icon === undefined ? {} : { icon: row.icon }),
      },
      open: row.kind === "directory" && expanded(row.path),
      top: renderedCoordinate(element, "y", TREE_PADDING + index * rowHeight),
      opacity: renderedOpacity(element),
    });
  }
  for (const [index, ghost] of leavingRows.entries()) {
    const element = ghostElements[index];
    snapshots.set(ghost.path, {
      presentation: {
        path: ghost.path,
        kind: ghost.kind,
        depth: ghost.depth,
        label: ghost.label,
        ...(ghost.suffix === undefined ? {} : { suffix: ghost.suffix }),
        ...(ghost.icon === undefined ? {} : { icon: ghost.icon }),
      },
      open: ghost.open,
      top:
        element === undefined
          ? ghost.top
          : renderedCoordinate(element, "y", ghost.top),
      opacity: element === undefined ? ghost.opacity : renderedOpacity(element),
    });
  }
  return snapshots;
}

/** Restores every row the reveal choreography touched to its settled state. */
function settleFolderMotion() {
  for (const element of folderMotionElements) {
    element.style.transition = "";
    element.style.transform = "";
    element.style.opacity = "";
  }
  folderMotionElements = [];
  ghostElements = [];
  if (leavingRows.length > 0) leavingRows = [];
}

/**
 * Flips a folder and choreographs the change so it reads as a reveal: rows
 * a toggle displaces translate from their previous slot while revealed rows
 * fade in and hidden rows linger as inert ghosts fading out. Row geometry
 * itself applies instantly and only transform and opacity animate, so
 * keyboard focus, scrolling, and the ARIA tree read from the real rows at
 * their final positions throughout. With animations off or reduced motion,
 * the toggle lands in its final state with no choreography at all.
 */
async function toggleFolderWithReveal(row: Row) {
  const folderPath = row.path;
  const opening = !expanded(folderPath);
  const snapshots = captureFolderMotion();
  const generation = ++folderMotionGeneration;
  cancelFolderCallbacks();
  settleFolderMotion();
  const tree = treeElement;
  const duration =
    tree === undefined
      ? 0
      : motionDurationMilliseconds("--skr-motion-panel-duration", tree);
  if (duration > 0 && !opening) {
    leavingRows = renderedIndices.flatMap((index): GhostRow[] => {
      const hidden = rows[index];
      const snapshot =
        hidden === undefined ? undefined : snapshots.get(hidden.path);
      if (
        hidden === undefined ||
        snapshot === undefined ||
        !hidden.path.startsWith(`${folderPath}/`)
      ) {
        return [];
      }
      return [
        {
          ...snapshot.presentation,
          open: snapshot.open,
          top: snapshot.top,
          opacity: snapshot.opacity,
        },
      ];
    });
  }
  userExpanded[folderPath] = opening;
  delete autoExpanded[folderPath];
  persistExpanded();
  if (duration === 0 || tree === undefined) return;
  await playFolderReveal(snapshots, generation, opening ? [] : [folderPath]);
}

async function playFolderReveal(
  snapshots: Map<string, FolderMotionSnapshot>,
  generation: number,
  collapsingPaths: readonly string[] = [],
): Promise<void> {
  const tree = treeElement;
  if (!mounted || tree === undefined) return;
  const duration = motionDurationMilliseconds(
    "--skr-motion-panel-duration",
    tree,
  );
  if (duration === 0) return;
  if (collapsingPaths.length > 0) {
    leavingRows = [...snapshots.values()]
      .filter((snapshot) =>
        collapsingPaths.some((folderPath) =>
          snapshot.presentation.path.startsWith(`${folderPath}/`),
        ),
      )
      .map((snapshot) => ({
        ...snapshot.presentation,
        open: snapshot.open,
        top: snapshot.top,
        opacity: snapshot.opacity,
      }));
  }
  await tick();
  if (!mounted || generation !== folderMotionGeneration) return;
  const moving: HTMLElement[] = [];
  for (const index of renderedIndices) {
    const current = rows[index];
    const element = itemElements[index];
    if (current === undefined || element === undefined) continue;
    const before = snapshots.get(current.path);
    if (before === undefined) {
      element.style.transition = "none";
      element.style.opacity = "0";
      moving.push(element);
    } else {
      const finalTop = TREE_PADDING + index * rowHeight;
      const offset = before.top - finalTop;
      const opacityChanged = before.opacity < 1;
      if (offset === 0 && !opacityChanged) continue;
      element.style.transition = "none";
      if (offset !== 0) element.style.transform = `translateY(${offset}px)`;
      if (opacityChanged) element.style.opacity = `${before.opacity}`;
      moving.push(element);
    }
  }
  const ghosts = ghostElements.filter(
    (element): element is HTMLElement => element !== undefined,
  );
  folderMotionElements = [...moving, ...ghosts];
  if (folderMotionElements.length === 0) {
    settleFolderMotion();
    return;
  }
  void tree.offsetWidth;
  folderMotionFrame = requestAnimationFrame(() => {
    folderMotionFrame = null;
    if (!mounted || generation !== folderMotionGeneration) return;
    for (const element of moving) {
      element.style.transition = FOLDER_REVEAL_TRANSITION;
      element.style.transform = "";
      element.style.opacity = "";
    }
    for (const ghost of ghosts) {
      ghost.style.transition = FOLDER_REVEAL_TRANSITION;
      ghost.style.opacity = "0";
    }
    folderMotionTimer = setTimeout(() => {
      folderMotionTimer = null;
      if (!mounted || generation !== folderMotionGeneration) return;
      settleFolderMotion();
    }, duration);
  });
}

function activate(row: Row, newTab = false) {
  if (row.kind === "directory") {
    toggleFolder(row);
  } else if (
    row.kind === "note" ||
    row.path.toLowerCase().endsWith(".canvas")
  ) {
    onSelectionChange?.(row.path);
    onOpenPath(row.path, { newTab });
  }
}

function parentIndex(row: Row): number {
  const parent = parentPath(row.path);
  return rows.findIndex((candidate) => candidate.path === parent);
}

function closeMenu(restore = true) {
  const origin = menuOrigin;
  const menu = menuElement;
  const generation = ++menuCloseGeneration;
  const finish = () => {
    if (!mounted || generation !== menuCloseGeneration) return;
    menuPath = null;
    menuOrigin = null;
    if (restore) {
      void tick().then(() => {
        if (mounted) origin?.focus();
      });
    }
  };
  if (menu === undefined) finish();
  else void exitMotionSurface(menu, finish);
}

function openMenu(row: Row, origin: HTMLElement, x?: number, y?: number) {
  menuCloseGeneration += 1;
  const bounds = origin.getBoundingClientRect();
  // A context click or long-press anchors to that point; the row's own
  // overflow button anchors to its own bottom-right corner. Either way the
  // anchor is a single point, expressed as a zero-size rect so it shares
  // the flip-to-fit clamp every other menu in the product uses.
  const point = { left: x ?? bounds.right, top: y ?? bounds.bottom };
  const anchor = {
    ...point,
    right: point.left,
    bottom: point.top,
    width: 0,
    height: 0,
  };
  menuPath = row.path;
  menuOrigin = origin;
  menuLeft = anchor.left;
  menuTop = anchor.top;
  void tick().then(() => {
    if (!mounted) return;
    const menu = menuElement;
    if (menu === undefined) return;
    const position = computeAnchoredPosition(
      anchor,
      { width: menu.offsetWidth, height: menu.offsetHeight },
      visualViewportRect(window),
      { gap: 0 },
    );
    menuLeft = position.left;
    menuTop = position.top;
    enterMotionSurface(menu);
    menu.querySelector<HTMLElement>("button")?.focus();
  });
}

function runMenuCommand(id: string) {
  const path = menuPath;
  if (path === null || registry === undefined || commandContext === undefined)
    return;
  const restoreTreeFocus = restoreMenuTreeFocus(path);
  closeMenu(false);
  registry.run(id, {
    ...commandContext(),
    treePath: path,
    restoreTreeFocus,
  });
}

/**
 * Runs a tree command directly against the focused row, bypassing the
 * action menu: the `F2`/`Delete` accelerators every Obsidian and VS Code
 * user reaches for first. Shares the same context shape `runMenuCommand`
 * builds from the menu, so a rename or delete behaves identically and
 * returns focus the same way whichever route triggered it.
 */
function runRowCommand(id: string, row: Row) {
  if (registry === undefined || commandContext === undefined) return;
  const restoreTreeFocus = restoreMenuTreeFocus(row.path);
  registry.run(id, {
    ...commandContext(),
    treePath: row.path,
    restoreTreeFocus,
  });
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
    if (!mounted) return;
    openMenu(row, origin, event.clientX, event.clientY);
  }, HOLD_DELAY_MS);
}

function clearHold() {
  if (holdTimer !== null) clearTimeout(holdTimer);
  holdTimer = null;
}

// registry-exempt keydown: ARIA tree and menu roving navigation stay inside
// their widgets. Every application action dispatched from a row, whether
// through the menu or through the F2/Delete accelerators below, is a
// registered command run through the registry.
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
    case "F2":
      runRowCommand("tree.entry.rename", row);
      break;
    case "Delete":
      runRowCommand("tree.entry.delete", row);
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

{#snippet rowBody(entry: RowPresentation, open: boolean)}
  {#each Array(entry.depth) as _, guide}
    <span
      class="skr-tree-indent-guide"
      aria-hidden="true"
      style={`left: ${0.5 + guide}rem`}
    ></span>
  {/each}
  <span class="skr-tree-leading" aria-hidden="true">
    {#if entry.kind === "directory"}
      <svg viewBox="0 0 16 16" class:skr-tree-chevron-open={open}>
        <path d="m5.5 3.5 4.5 4.5-4.5 4.5" />
      </svg>
    {:else if entry.icon !== undefined}
      <span class="skr-tree-note-icon">{entry.icon}</span>
    {/if}
  </span>
  <span class="skr-tree-label">{entry.label}</span>
  {#if entry.suffix !== undefined}
    <span class="skr-tree-suffix">{entry.suffix}</span>
  {/if}
{/snippet}

<ul
  bind:this={treeElement}
  class="skr-file-tree"
  role="tree"
  tabindex="-1"
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
  <li
    bind:this={highlightElement}
    role="presentation"
    aria-hidden="true"
    inert
    class="skr-tree-active-highlight"
    style={`height: ${rowHeight}px`}
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
        onclick={(event) => {
          void focusRow(index);
          activate(row, event.ctrlKey || event.metaKey);
        }}
        onauxclick={(event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          void focusRow(index);
          activate(row, true);
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
        {@render rowBody(row, expanded(row.path))}
        <button
          type="button"
          class="skr-tree-actions"
          tabindex={index === focusIndex ? 0 : -1}
          aria-label={`${STRINGS.rowActions}: ${row.label}`}
          aria-haspopup="menu"
          aria-expanded={menuPath === row.path}
          use:commandTooltip={{ title: STRINGS.rowActions }}
          onclick={(event) => {
            event.stopPropagation();
            if (menuPath === row.path) {
              closeMenu(false);
            } else {
              openMenu(row, event.currentTarget);
            }
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
  {#each leavingRows as ghost, ghostIndex (ghost.path)}
    <!-- A collapse leaves its hidden rows behind as inert, presentation-only
         ghosts for one panel-class fade; the ARIA tree, keyboard focus, and
         hit-testing only ever see the real rows above. -->
    <li
      bind:this={ghostElements[ghostIndex]}
      role="presentation"
      aria-hidden="true"
      inert
      class="skr-tree-row skr-tree-ghost"
      data-ghost-path={ghost.path}
      style={`top: ${ghost.top}px; height: ${rowHeight}px; padding-left: ${0.5 + ghost.depth}rem${ghost.opacity < 1 ? `; opacity: ${ghost.opacity}` : ""}`}
    >
      {@render rowBody(ghost, ghost.open)}
    </li>
  {/each}
</ul>

{#if menuRow !== null}
  <div
    bind:this={menuElement}
    class="skr-tree-menu"
    role="menu"
    tabindex="-1"
    data-motion-surface="anchored-top"
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
