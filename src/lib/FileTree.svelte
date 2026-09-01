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

// A folder reveal is a real expansion. The rows a toggle displaces hold
// their own slot in the tree's layout and travel to the new one on the panel
// clock, so the gap opens over the whole duration instead of opening in one
// frame under an animation that only looks like travel. The rows the toggle
// reveals or hides unfold from, and fold back into, the slot below their
// folder: they start stacked on that fold line clipped to nothing and end at
// their own slot at full height, which keeps the block flush against the
// rows below it at every point of the animation. The scroll extent follows
// the same clock, so a list taller than the sidebar grows and shrinks under
// the reader rather than jumping.
const FOLDED_CLIP = "inset(0 0 100% 0)";
const UNFOLDED_CLIP = "inset(0 0 0 0)";

// The open note's highlight travel between two notes: a compositor-only
// transform on the panel clock. A highlight displaced by a folder reveal
// instead moves with the row it marks, on the row's own clock and geometry.
const ACTIVE_HIGHLIGHT_TRAVEL_TRANSITION =
  "transform var(--skr-motion-panel-duration) var(--skr-motion-panel-easing)";

let {
  entries,
  selectedPath = null,
  titleSources = {},
  expandedPaths = [],
  onExpandedChange,
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
  onOpenPath: (path: string, options?: { newTab?: boolean }) => unknown;
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
// `bind:this` writes `null`, not `undefined`, into a slot whose element has
// been torn down (a keyed row moving to a different index releases its old
// slot that way), so every element reference below is checked for being an
// element rather than for being defined.
let treeElement = $state<HTMLUListElement | null>();
let itemElements = $state<Array<HTMLElement | null | undefined>>([]);
let menuPath = $state<string | null>(null);
let menuLeft = $state(0);
let menuTop = $state(0);
let menuOrigin = $state<HTMLElement | null>(null);
let menuElement = $state<HTMLElement | null>();
let dragPath = $state<string | null>(null);
let dropPath = $state<string | null>(null);
let hoveredPath = $state<string | null>(null);
let holdTimer: ReturnType<typeof setTimeout> | null = null;
let menuCloseGeneration = 0;
// The reveal in flight: whether the tree carries the panel-clock transitions,
// which rows are unfolding and from where, which rows are held on the slot
// they are travelling away from, which are folding away, and whether the
// animation has been handed its end state yet. Only geometry is ever held;
// the row list, the ARIA tree and the persisted expansion are the toggle's
// own flush, so anything reading the tree sees the new state at once.
let revealing = $state(false);
let revealPhase = $state<0 | 1>(0);
let unfoldingRows = $state<Record<string, FoldedStart>>({});
let heldTops = $state<Record<string, number>>({});
let heldHeight = $state<number | null>(null);
let leavingRows = $state<GhostRow[]>([]);
let revealSpan = $state(0);
let revealGeneration = 0;
let revealTimer: ReturnType<typeof setTimeout> | null = null;
let highlightElement = $state<HTMLElement | null>();
type PrimaryClickIntent = {
  path: string;
  generation: number;
  pending: Promise<void> | null;
};
// A native double-click is the one activation route whose second action must
// follow the first. All other opens start immediately so App-level request
// ownership can supersede slow reads. This record keeps only the matching
// first click, and drops its settled promise while retaining the gesture key
// long enough for the browser's subsequent `dblclick` event.
let primaryClickIntent: PrimaryClickIntent | null = null;
let openGestureGeneration = 0;
let mountGeneration = 0;
// Plain (non-reactive) bookkeeping: the choreography effect below both
// reads and writes these, and making them `$state` would make its own
// writes re-trigger itself mid-flush, stomping the entrance markers it had
// just set.
let highlightRestTop: number | null = null;
let highlightAnimatedPath: string | null = null;
let highlightMotionGeneration = 0;
let highlightMotionFrame: number | null = null;
let highlightMotionTimer: ReturnType<typeof setTimeout> | null = null;
// Tracks which `selectedPath` the ancestor auto-expand effect below last
// computed for. Without this the effect would also re-run whenever a
// manual folder toggle mutates `userExpanded`/`autoExpanded`, and since
// `selectedPath` still points inside the folder being collapsed, it would
// recompute the very ancestor the user just closed back into `autoExpanded`
// and silently undo the collapse.
let autoExpandedForPath: string | null | undefined;
let revealedSelection: string | null = null;
// The first expansion state the tree resolves is a rendering, not a change:
// no row was on screen to travel from, so it lands in the frame the tree
// first paints. Everything after it is a change the reader can see.
let hasRendered = false;
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

/** Where an unfolding row starts, and how much of it is visible there. */
type FoldedStart = { top: number; clip: string };

/** A collapsed row lingering only long enough to fold away. */
type GhostRow = RowPresentation & {
  open: boolean;
  from: number;
  fromClip: string;
  to: number;
  folded: boolean;
};

function parentPath(path: string): string {
  return path.split("/").slice(0, -1).join("/");
}

function baseName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function transformOffset(element: HTMLElement): number {
  const transform = getComputedStyle(element).transform.trim();
  if (transform === "" || transform === "none") return 0;

  const matrix3d = transform.match(/^matrix3d\(([^)]+)\)$/);
  if (matrix3d !== null) {
    const values = matrix3d[1]?.split(",").map(Number) ?? [];
    return values[13] ?? 0;
  }
  const matrix = transform.match(/^matrix\(([^)]+)\)$/);
  if (matrix !== null) {
    const values = matrix[1]?.split(",").map(Number) ?? [];
    return values[5] ?? 0;
  }

  const translate = transform.match(
    /^translate\(\s*-?[\d.]+px(?:,\s*(-?[\d.]+)px)?\s*\)$/,
  );
  if (translate !== null) return Number.parseFloat(translate[1] ?? "0");
  const axisTranslate = transform.match(/^translateY\(\s*(-?[\d.]+)px\s*\)$/);
  return axisTranslate === null
    ? 0
    : Number.parseFloat(axisTranslate[1] ?? "0");
}

/**
 * Where an element is right now rather than where it is headed: the computed
 * `top` reports the interpolated value while a transition runs, so a reveal
 * interrupted mid-flight starts its reversal from what the reader can see.
 */
function renderedTop(element: HTMLElement, fallback: number): number {
  const computed = Number.parseFloat(getComputedStyle(element).top);
  const inline = Number.parseFloat(element.style.top);
  const base = Number.isFinite(computed)
    ? computed
    : Number.isFinite(inline)
      ? inline
      : fallback;
  return base + transformOffset(element);
}

function renderedClip(element: HTMLElement, fallback: string): string {
  const clip = getComputedStyle(element).clipPath.trim();
  return clip === "" || clip === "none" ? fallback : clip;
}

function rowElement(path: string): HTMLElement | null {
  return (
    treeElement?.querySelector<HTMLElement>(
      `[data-path="${CSS.escape(path)}"]`,
    ) ?? null
  );
}

function ghostElement(path: string): HTMLElement | null {
  return (
    treeElement?.querySelector<HTMLElement>(
      `[data-ghost-path="${CSS.escape(path)}"]`,
    ) ?? null
  );
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

function cancelRevealCallbacks(): void {
  if (revealTimer !== null) {
    clearTimeout(revealTimer);
    revealTimer = null;
  }
}

onDestroy(() => {
  mounted = false;
  mountGeneration += 1;
  openGestureGeneration += 1;
  primaryClickIntent = null;
  highlightMotionGeneration += 1;
  revealGeneration += 1;
  menuCloseGeneration += 1;
  cancelHighlightCallbacks();
  cancelRevealCallbacks();
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

/**
 * The visible row list for a given expansion state. Taking the state as an
 * argument rather than reading it lets a toggle measure the layout it is
 * about to produce while the current one is still on screen, which is what
 * makes the reveal a real expansion instead of a jump with an animation over
 * it.
 */
function buildRows(
  userOpen: Record<string, boolean>,
  autoOpen: Record<string, boolean>,
): Row[] {
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
      if (
        entry.kind === "directory" &&
        (userOpen[entry.path] === true || autoOpen[entry.path] === true)
      ) {
        append(entry.path, depth + 1);
      }
    });
  };
  append("", 0);
  return visible;
}

const rows = $derived(buildRows(userExpanded, autoExpanded));

const activeRowIndex = $derived(
  selectedPath === null
    ? -1
    : rows.findIndex((row) => row.path === selectedPath),
);
const activeRowTop = $derived(
  activeRowIndex < 0 ? null : TREE_PADDING + activeRowIndex * rowHeight,
);
const activeRowPath = $derived(activeRowIndex < 0 ? null : selectedPath);
/**
 * Where the open note's highlight belongs this frame. A highlight on a row
 * the current reveal is unfolding sits on that row's own travelling
 * geometry, so the fill and the row it marks are never a frame apart.
 */
const highlightTop = $derived.by((): number | null => {
  if (activeRowTop === null || activeRowPath === null) return activeRowTop;
  if (revealPhase === 1) return activeRowTop;
  return (
    unfoldingRows[activeRowPath]?.top ?? heldTops[activeRowPath] ?? activeRowTop
  );
});
const highlightClip = $derived.by((): string | null => {
  if (activeRowPath === null || unfoldingRows[activeRowPath] === undefined) {
    return null;
  }
  return revealPhase === 1
    ? UNFOLDED_CLIP
    : (unfoldingRows[activeRowPath]?.clip ?? FOLDED_CLIP);
});

// While a reveal runs, rows travel across slots they do not finally occupy,
// so the rendered window has to cover the distance the block moves as well
// as the resting viewport.
const overscanRows = $derived(OVERSCAN_ROWS + revealSpan);
const windowStart = $derived(
  Math.max(
    0,
    Math.floor(Math.max(0, scrollTop - TREE_PADDING) / rowHeight) -
      overscanRows,
  ),
);
const windowEnd = $derived(
  Math.min(
    rows.length,
    Math.ceil(
      Math.max(0, scrollTop + viewportHeight - TREE_PADDING) / rowHeight,
    ) + overscanRows,
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
  // Only a genuine selection change reveals ancestors. Reading `path` above
  // is what makes this effect re-run when it changes; bailing out before
  // touching `userExpanded`/`autoExpanded` keeps this run from depending on
  // either, so a manual folder toggle (which mutates both) does not
  // re-trigger this effect and re-derive the selected path's ancestors from
  // scratch, which would auto-expand the very folder the toggle just closed.
  if (path === autoExpandedForPath) return;
  autoExpandedForPath = path;
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
  if (changed) void playExpansionChange(userExpanded, next);
  // Only a note change scrolls the tree. Re-running this reveal for an
  // unrelated folder toggle would drag the whole sidebar back to the open
  // note every time a reader opened a folder somewhere else in the vault.
  if (path !== null && path !== revealedSelection) {
    revealedSelection = path;
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
 * (top) applies instantly; only the leftover transform interpolates. When
 * the previous row has left the screen (first selection, or the row sat
 * inside what is now a collapsed folder), there is nothing to travel from,
 * so the highlight enters in place with the surface class instead.
 *
 * A reveal that displaces the open note is not a travel: the highlight then
 * takes the row's own moving geometry, on the tree's panel-clock transition,
 * so the fill stays on its row for every frame of the expansion instead of
 * animating on a clock of its own.
 */
$effect(() => {
  const path = selectedPath;
  const top = highlightTop;
  const clip = highlightClip;
  const element = highlightElement;
  if (!(element instanceof HTMLElement)) return;

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
    element.style.removeProperty("clip-path");
    highlightRestTop = null;
    return;
  }

  // A row the reveal is unfolding carries the highlight with it: same start,
  // same clip, same panel-clock transition, so the two are one object. The
  // start state is taken up in one frame like the row's own, which is a new
  // element and so cannot animate into existence; the travel that follows is
  // the tree's transition, shared with the row.
  if (clip !== null) {
    const arriving = revealPhase === 0;
    highlightAnimatedPath = path;
    cancelHighlightCallbacks();
    highlightMotionGeneration += 1;
    delete element.dataset.motionSurface;
    element.style.transition = arriving ? "none" : "";
    element.style.transform = "";
    element.style.opacity = "1";
    element.style.top = `${top}px`;
    element.style.clipPath = clip;
    highlightRestTop = top;
    if (arriving) {
      // Commit the start state under `transition: none`, then hand the
      // element back to the tree's own transition for the travel.
      void element.offsetHeight;
      element.style.transition = "";
    }
    return;
  }
  element.style.removeProperty("clip-path");

  const isNewSelection = path !== highlightAnimatedPath;
  highlightAnimatedPath = path;
  const previousTop =
    highlightRestTop === null ? null : renderedTop(element, highlightRestTop);
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
  if (!(element instanceof HTMLElement)) return;
  const measure = () => {
    if (mounted) viewportHeight = element.clientHeight;
  };
  measure();
  const observer = new ResizeObserver(measure);
  observer.observe(element);
  return () => observer.disconnect();
});

// Declared last, so it runs after the expansion state settles on the first
// pass: from the second pass on, a change to that state is a change to
// something the reader has already seen.
$effect(() => {
  hasRendered = true;
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
  if (focus) focusRowElement(nextIndex);
}

/**
 * Moves focus onto the row at `index`, and keeps it inside the tree.
 *
 * Only the window of rows around the scroll position is rendered, so a row
 * that leaves it is destroyed, and destroying the row that holds focus hands
 * focus to the document body. The element bindings that window maintains are
 * therefore not a reliable handle on the row to focus next: a scroll or a
 * refreshed tree can rebuild the row between the request and this call, and a
 * binding that has not been written back yet leaves focus on the body, where
 * no key reaches the tree at all. Resolving the row from the tree's own DOM
 * covers the rebuild, and falling back to the tree keeps the widget reachable
 * from the keyboard when the row genuinely is not rendered.
 */
function focusRowElement(index: number): void {
  const bound = itemElements[index];
  if (bound instanceof HTMLElement && bound.isConnected) {
    bound.focus();
    return;
  }
  const row = rows[index];
  const rendered =
    row === undefined
      ? null
      : (treeElement?.querySelector<HTMLElement>(
          `[role="treeitem"][data-path="${CSS.escape(row.path)}"]`,
        ) ?? null);
  if (rendered !== null) {
    rendered.focus();
    return;
  }
  const active = document.activeElement;
  if (active === null || active === document.body) treeElement?.focus();
}

function restoreMenuTreeFocus(path: string): () => void {
  const originIndex = rows.findIndex((row) => row.path === path);
  if (originIndex >= 0) {
    focusIndex = originIndex;
    focusRowElement(originIndex);
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

function presentationOf(row: Row | GhostRow): RowPresentation {
  return {
    path: row.path,
    kind: row.kind,
    depth: row.depth,
    label: row.label,
    ...(row.suffix === undefined ? {} : { suffix: row.suffix }),
    ...(row.icon === undefined ? {} : { icon: row.icon }),
  };
}

function toggleFolder(row: Row) {
  const nextUser = { ...userExpanded, [row.path]: !expanded(row.path) };
  const nextAuto = { ...autoExpanded };
  delete nextAuto[row.path];
  void playExpansionChange(nextUser, nextAuto, true);
}

/** Releases every row and overlay the reveal borrowed. */
function settleReveal(): void {
  revealing = false;
  revealPhase = 0;
  revealSpan = 0;
  heldHeight = null;
  if (Object.keys(unfoldingRows).length > 0) unfoldingRows = {};
  if (Object.keys(heldTops).length > 0) heldTops = {};
  if (leavingRows.length > 0) leavingRows = [];
}

/**
 * The slot a block of rows unfolds out of, or folds back into: the one
 * directly below the nearest row above it that exists in both layouts,
 * measured in the layout the block is travelling away from.
 */
function foldOrigin(
  order: readonly Row[],
  index: number,
  slots: ReadonlyMap<string, number>,
): number {
  for (let above = index - 1; above >= 0; above -= 1) {
    const path = order[above]?.path;
    const slot = path === undefined ? undefined : slots.get(path);
    if (slot !== undefined) return TREE_PADDING + (slot + 1) * rowHeight;
  }
  return TREE_PADDING;
}

/**
 * Moves the tree from one expansion state to another as a real expansion.
 * Every displaced row travels through the slots between its old and new
 * position on the panel clock, the revealed rows unfold from their folder's
 * slot while the hidden ones fold back into it, and the tree's own height
 * follows the same clock so the scroll extent grows and shrinks under the
 * reader instead of jumping. The ARIA tree, keyboard focus and hit testing
 * read the new state from the first frame; only the geometry is in motion.
 * With animations off or reduced motion the new state simply applies.
 */
async function playExpansionChange(
  nextUser: Record<string, boolean>,
  nextAuto: Record<string, boolean>,
  persist = false,
): Promise<void> {
  const tree = treeElement;
  const apply = () => {
    userExpanded = nextUser;
    autoExpanded = nextAuto;
    if (persist) persistExpanded();
  };
  const duration = !(tree instanceof HTMLElement)
    ? 0
    : motionDurationMilliseconds("--skr-motion-panel-duration", tree);
  if (
    !hasRendered ||
    !(tree instanceof HTMLElement) ||
    duration === 0 ||
    !mounted
  ) {
    revealGeneration += 1;
    cancelRevealCallbacks();
    settleReveal();
    apply();
    return;
  }

  const before = rows;
  const after = buildRows(nextUser, nextAuto);
  const beforeSlots = new Map(before.map((row, index) => [row.path, index]));
  const afterSlots = new Map(after.map((row, index) => [row.path, index]));

  const unfolding: Record<string, FoldedStart> = {};
  after.forEach((row, index) => {
    if (beforeSlots.has(row.path)) return;
    // A row that reverses an unfinished collapse starts from wherever its own
    // ghost has reached, so an interrupted reveal never restarts from a
    // position the reader has not seen.
    const ghost = ghostElement(row.path);
    const origin = foldOrigin(after, index, beforeSlots);
    unfolding[row.path] = {
      top: ghost === null ? origin : renderedTop(ghost, origin),
      clip: ghost === null ? FOLDED_CLIP : renderedClip(ghost, FOLDED_CLIP),
    };
  });

  const folding: GhostRow[] = [];
  before.forEach((row, index) => {
    if (afterSlots.has(row.path)) return;
    const element = rowElement(row.path);
    const resting = TREE_PADDING + index * rowHeight;
    folding.push({
      ...presentationOf(row),
      open: row.kind === "directory" && expanded(row.path),
      from: element === null ? resting : renderedTop(element, resting),
      fromClip:
        element === null ? UNFOLDED_CLIP : renderedClip(element, UNFOLDED_CLIP),
      to: foldOrigin(before, index, afterSlots),
      folded: false,
    });
  });

  if (Object.keys(unfolding).length === 0 && folding.length === 0) {
    apply();
    return;
  }

  // Every surviving row the change displaces holds the slot it is travelling
  // away from for one flush, which is what the transition then interpolates
  // out of.
  const held: Record<string, number> = {};
  for (const [path, slot] of beforeSlots) {
    const destination = afterSlots.get(path);
    if (destination === undefined || destination === slot) continue;
    held[path] = TREE_PADDING + slot * rowHeight;
  }

  const generation = ++revealGeneration;
  cancelRevealCallbacks();
  // Ghosts still folding away from an earlier toggle keep their own motion;
  // only the rows this change moves are staged afresh.
  const carried = leavingRows.filter(
    (ghost) =>
      !afterSlots.has(ghost.path) &&
      folding.every((row) => row.path !== ghost.path),
  );
  revealing = true;
  revealPhase = 0;
  unfoldingRows = unfolding;
  heldTops = held;
  heldHeight = TREE_PADDING * 2 + before.length * rowHeight;
  leavingRows = [...carried, ...folding];
  revealSpan = Math.max(Object.keys(unfolding).length, folding.length);
  // The new state lands here, in the caller's own flush: rows, ARIA, and the
  // persisted expansion are never a frame behind the click. Only where the
  // rows are drawn is held back.
  apply();
  await tick();
  if (!mounted || generation !== revealGeneration) return;
  // The transitions have to be committed before the geometry moves: a
  // transition runs only when the style it interpolates from already named
  // it, so reading layout here is what makes the next flush animate rather
  // than jump.
  void tree.getBoundingClientRect();

  revealPhase = 1;
  for (const ghost of leavingRows) ghost.folded = true;
  await tick();
  if (!mounted || generation !== revealGeneration) return;
  revealTimer = setTimeout(() => {
    revealTimer = null;
    if (!mounted || generation !== revealGeneration) return;
    settleReveal();
  }, duration);
}

function invokeOpenPath(path: string, newTab: boolean): Promise<void> | null {
  try {
    const result = onOpenPath(path, { newTab });
    if (
      result === null ||
      (typeof result !== "object" && typeof result !== "function")
    )
      return null;
    let then: unknown;
    try {
      then = (result as { then?: unknown }).then;
    } catch {
      return null;
    }
    if (typeof then !== "function") return null;
    return Promise.resolve(result).then(
      () => undefined,
      () => undefined,
    );
  } catch {
    return null;
  }
}

function supersedePrimaryClick(): number {
  primaryClickIntent = null;
  openGestureGeneration += 1;
  return openGestureGeneration;
}

function activate(row: Row, newTab = false): Promise<void> {
  if (row.kind === "directory") {
    toggleFolder(row);
    return Promise.resolve();
  }

  // Every file the vault holds opens; the tree never shows a row it
  // refuses to act on. Selection belongs to committed navigation, so a
  // slow or failed read leaves the tree and reading surface in agreement.
  return invokeOpenPath(row.path, newTab) ?? Promise.resolve();
}

function beginPrimaryClick(row: Row): void {
  const generation = supersedePrimaryClick();
  if (row.kind === "directory") {
    toggleFolder(row);
    return;
  }

  const intent: PrimaryClickIntent = {
    path: row.path,
    generation,
    pending: invokeOpenPath(row.path, false),
  };
  primaryClickIntent = intent;
  const pending = intent.pending;
  if (pending !== null) {
    void pending.then(() => {
      if (primaryClickIntent === intent) intent.pending = null;
    });
  }
}

async function promotePrimaryDoubleClick(path: string): Promise<void> {
  const intent = primaryClickIntent;
  if (intent === null || intent.path !== path) return;

  const generation = intent.generation;
  const lifetime = mountGeneration;
  const pending = intent.pending;
  if (primaryClickIntent === intent) primaryClickIntent = null;
  if (pending !== null) {
    try {
      await pending;
    } catch {
      // `invokeOpenPath` already converts failures into settlement. Keep this
      // boundary defensive so a foreign thenable cannot poison promotion.
    }
  }
  if (
    !mounted ||
    mountGeneration !== lifetime ||
    openGestureGeneration !== generation
  )
    return;

  openGestureGeneration += 1;
  void invokeOpenPath(path, true);
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
  if (!(menu instanceof HTMLElement)) finish();
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
    if (!(menu instanceof HTMLElement)) return;
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
  const focusedPath =
    event.target instanceof Element
      ? event.target
          .closest<HTMLElement>('[role="treeitem"][data-path]')
          ?.getAttribute("data-path")
      : null;
  const focusedIndex =
    focusedPath === null
      ? -1
      : rows.findIndex((candidate) => candidate.path === focusedPath);
  const activeIndex = focusedIndex >= 0 ? focusedIndex : focusIndex;
  if (focusedIndex >= 0 && focusIndex !== focusedIndex) {
    focusIndex = focusedIndex;
  }
  const row = rows[activeIndex];
  if (row === undefined) return;
  switch (event.key) {
    case "ArrowDown":
      void focusRow(Math.min(activeIndex + 1, rows.length - 1));
      break;
    case "ArrowUp":
      void focusRow(Math.max(activeIndex - 1, 0));
      break;
    case "ArrowRight":
      if (row.kind === "directory" && !expanded(row.path)) toggleFolder(row);
      else if (row.kind === "directory") void focusRow(activeIndex + 1);
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
      supersedePrimaryClick();
      void activate(row);
      break;
    case "F10":
      if (!event.shiftKey) return;
      openMenu(
        row,
        itemElements[activeIndex] ?? (event.currentTarget as HTMLElement),
      );
      break;
    case "ContextMenu":
      openMenu(
        row,
        itemElements[activeIndex] ?? (event.currentTarget as HTMLElement),
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

/**
 * A row's geometry for this frame: its resting slot, or the fold line it is
 * unfolding from while the reveal's start state is on screen.
 */
function rowStyle(path: string, index: number, depth: number): string {
  const unfolding = unfoldingRows[path];
  const held = revealPhase === 0;
  const resting = TREE_PADDING + index * rowHeight;
  const top = held ? (unfolding?.top ?? heldTops[path] ?? resting) : resting;
  const geometry = `top: ${top}px; height: ${rowHeight}px; padding-left: ${0.5 + depth}rem`;
  if (unfolding === undefined) return geometry;
  return `${geometry}; clip-path: ${held ? unfolding.clip : UNFOLDED_CLIP}`;
}

function ghostStyle(ghost: GhostRow): string {
  return [
    `top: ${ghost.folded ? ghost.to : ghost.from}px`,
    `height: ${rowHeight}px`,
    `padding-left: ${0.5 + ghost.depth}rem`,
    `clip-path: ${ghost.folded ? FOLDED_CLIP : ghost.fromClip}`,
  ].join("; ");
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
  class:skr-file-tree-revealing={revealing}
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
    style={`height: ${revealPhase === 0 && heldHeight !== null ? heldHeight : TREE_PADDING * 2 + rows.length * rowHeight}px`}
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
        aria-selected={row.kind === "directory" ? undefined : row.path === selectedPath}
        data-path={row.path}
        tabindex={index === focusIndex ? 0 : -1}
        class="skr-tree-row"
        class:skr-tree-row-dragging={dragPath === row.path}
        class:skr-tree-row-drop={dropPath === row.path}
        class:skr-tree-row-hovered={hoveredPath === row.path}
        style={rowStyle(row.path, index, row.depth)}
        draggable={true}
        onfocus={() => (focusIndex = index)}
        onclick={(event) => {
          void focusRow(index);
          // A browser sends a second ordinary click before `dblclick`. That
          // click belongs to the double-click gesture handled below.
          if (event.detail > 1) return;
          if (
            event.detail === 1 &&
            event.button === 0 &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.shiftKey &&
            !event.altKey
          ) {
            beginPrimaryClick(row);
            return;
          }
          supersedePrimaryClick();
          void activate(row, event.ctrlKey || event.metaKey);
        }}
        ondblclick={(event) => {
          event.preventDefault();
          void focusRow(index);
          // The first click already toggles a folder. The rest of the
          // double-click gesture must not toggle it again.
          if (row.kind === "directory") return;
          void promotePrimaryDoubleClick(row.path);
        }}
        onauxclick={(event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          void focusRow(index);
          supersedePrimaryClick();
          void activate(row, true);
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
          if (row.kind !== "directory") {
            // Every file opens, so every file row is something a pane can
            // receive; the pane decides which surface the path lands on.
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
  {#each leavingRows as ghost (ghost.path)}
    <!-- A collapse leaves its hidden rows behind as inert, presentation-only
         ghosts while they fold back into their folder's slot; the ARIA tree,
         keyboard focus, and hit-testing only ever see the real rows above. -->
    <li
      role="presentation"
      aria-hidden="true"
      inert
      class="skr-tree-row skr-tree-ghost"
      data-ghost-path={ghost.path}
      style={ghostStyle(ghost)}
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
