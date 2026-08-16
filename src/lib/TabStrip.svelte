<script module lang="ts">
/**
 * The tab a pointer is currently dragging. A drag's payload also travels in
 * the drag event's own data, but `dragover` may not read that data, and the
 * edge drop zones have to know which pane a tab came from while the pointer
 * is still moving. Dragging tabs between windows is out of scope, so one
 * document-scoped record answers it.
 */
export type TabDragOrigin = { path: string; paneId: string };

let activeTabDrag: TabDragOrigin | null = null;

export function currentTabDrag(): TabDragOrigin | null {
  return activeTabDrag;
}

export function setTabDrag(origin: TabDragOrigin | null): void {
  activeTabDrag = origin;
}

/** Identifies the transient empty tab, which owns no note path. */
export const EMPTY_TAB_KEY = "\u0000empty-tab";
</script>

<script lang="ts">
import { onDestroy, onMount, tick } from "svelte";
import AnchoredMenu from "./AnchoredMenu.svelte";
import { type CommandTooltipOptions, commandTooltip } from "./commandTooltip";
import {
  enterMotionSurface,
  exitMotionSurface,
  motionDurationMilliseconds,
} from "./motion";
import { resolveTitleCollisions } from "./noteTitles";
import { STRINGS } from "./strings";
import type { WorkspaceTab } from "./workspaceState";

// The active-tab indicator travel: a compositor-only transform on the panel
// clock, matching the reorder reflow's own clock below.
const ACTIVE_INDICATOR_TRAVEL_TRANSITION =
  "transform var(--skr-motion-panel-duration) var(--skr-motion-panel-easing)";
let nextTablistId = 0;

function transformOffset(element: HTMLElement): number {
  const transform = getComputedStyle(element).transform.trim();
  if (transform === "" || transform === "none") return 0;
  const matrix3d = transform.match(/^matrix3d\(([^)]+)\)$/);
  if (matrix3d !== null) {
    return Number.parseFloat(matrix3d[1]?.split(",")[12] ?? "0");
  }
  const matrix = transform.match(/^matrix\(([^)]+)\)$/);
  if (matrix !== null) {
    return Number.parseFloat(matrix[1]?.split(",")[4] ?? "0");
  }
  const translate = transform.match(
    /^translate\(\s*(-?[\d.]+)px(?:,\s*(-?[\d.]+)px)?\s*\)$/,
  );
  if (translate !== null) return Number.parseFloat(translate[1] ?? "0");
  const axisTranslate = transform.match(/^translateX\(\s*(-?[\d.]+)px\s*\)$/);
  return axisTranslate === null
    ? 0
    : Number.parseFloat(axisTranslate[1] ?? "0");
}

function renderedLeft(element: HTMLElement, fallback: number): number {
  const left = Number.parseFloat(element.style.left);
  return (Number.isFinite(left) ? left : fallback) + transformOffset(element);
}
let {
  paneId,
  tabs,
  activePath,
  titleSources,
  focused,
  emptyTab = false,
  closeTooltip = { title: STRINGS.closeTab },
  onActivate,
  onClose,
  onReorder,
  onNewTab,
  onAdopt,
}: {
  paneId: string;
  tabs: readonly WorkspaceTab[];
  activePath: string | null;
  titleSources: Readonly<Record<string, string>>;
  focused: boolean;
  emptyTab?: boolean;
  closeTooltip?: CommandTooltipOptions;
  onActivate: (path: string | null) => void;
  onClose: (path: string | null, restoreFocus: boolean) => void;
  onReorder: (from: number, to: number) => void;
  onNewTab: () => void;
  onAdopt: (origin: TabDragOrigin, index: number) => void;
} = $props();

let dragging = $state<number | null>(null);
let insertion = $state<number | null>(null);
let listOpen = $state(false);
let itemsElement = $state<HTMLDivElement>();
let listButtonElement = $state<HTMLButtonElement>();
let overflowed = $state(false);
let scrollPointer = $state<number | null>(null);
let scrollOriginX = 0;
let scrollOriginLeft = 0;
// The dragged tab's width, measured once when its drag starts; the gap the
// passed-over tabs open is exactly the slot the tab will land in.
let dragWidth = 0;
let tabElements = $state<Array<HTMLElement | undefined>>([]);
let indicatorElement = $state<HTMLElement>();
// Plain (non-reactive) bookkeeping: the choreography effect below both
// reads and writes these, and making them `$state` would make its own
// writes re-trigger itself mid-flush, stomping the entrance markers it had
// just set.
let indicatorRestLeft: number | null = null;
let indicatorAnimatedPath: string | null = null;
let indicatorMotionGeneration = 0;
let indicatorMotionFrame: number | null = null;
let indicatorMotionTimer: ReturnType<typeof setTimeout> | null = null;
let indicatorTraveling = false;
let indicatorTrackFrame: number | null = null;
let settleGeneration = 0;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * True from the moment a settle takes hold of the strip's widths until it
 * lets go of them, which is wider than the interval it animates over: the
 * widths it starts from are pinned before the clock starts.
 */
let settleActive = false;
let mounted = true;
/**
 * The tab that owns the strip's single tab stop. It follows the active tab
 * until an arrow key moves it, which is the tabs pattern's roving tabindex.
 */
let rovingIndex = $state(0);
/**
 * The width every tab is pinned to, keyed by tab. It carries both of the
 * strip's width states: the widths held after a close while the pointer is
 * still over the strip, so the next tab's close control lands under the
 * pointer exactly as it does in a browser, and the from and to widths of a
 * settle, the one relayout below that travels rather than jumps.
 */
let pinnedWidths = $state<Map<string, number> | null>(null);
/**
 * The gap a closed tab leaves, carried as a margin on the tab that follows
 * it so a settle starts from the layout the strip actually had and closes
 * the gap over the same interval the widths travel in.
 */
let settleGaps = $state<Map<string, { start: number; end: number }> | null>(
  null,
);
/** True while a settle is in flight, which is what puts it on the clock. */
let settling = $state(false);
let pointerOverStrip = false;
let previousEntryKeys: string[] = [];
/**
 * Tabs that have already left the open set, drawn for the length of the
 * dismissal class in the slot they occupied. They are absolutely positioned
 * ghosts, so they hold no layout slot and appear in no count or index: the
 * strip's tabs, its roving focus and its reorder indices all see only the
 * open tabs, and only the pixels linger.
 */
let exitingTabs = $state<
  Array<{ id: number; label: string; left: number; width: number }>
>([]);
let nextExitId = 0;
const tablistId = `skr-tablist-${nextTablistId++}`;

function tabId(index: number): string {
  return `${tablistId}-tab-${index}`;
}

function cancelIndicatorCallbacks(): void {
  if (indicatorMotionFrame !== null) {
    cancelAnimationFrame(indicatorMotionFrame);
    indicatorMotionFrame = null;
  }
  if (indicatorMotionTimer !== null) {
    clearTimeout(indicatorMotionTimer);
    indicatorMotionTimer = null;
  }
}

/**
 * Stops the settle's frame-by-frame tracking. It is deliberately not part
 * of the travel's own teardown above: the choreography effect re-runs for
 * ordinary reasons while a settle is in flight, and cancelling tracking
 * there would strand the bar wherever that re-run happened to find it.
 */
function cancelIndicatorTracking(): void {
  if (indicatorTrackFrame !== null) {
    cancelAnimationFrame(indicatorTrackFrame);
    indicatorTrackFrame = null;
  }
}

/** Drops an in-flight settle without disturbing the widths it left behind. */
function cancelSettle(): void {
  settleGeneration += 1;
  if (settleTimer !== null) {
    clearTimeout(settleTimer);
    settleTimer = null;
  }
  settleActive = false;
  settling = false;
  settleGaps = null;
}

onDestroy(() => {
  mounted = false;
  indicatorMotionGeneration += 1;
  cancelSettle();
  cancelIndicatorTracking();
  cancelIndicatorCallbacks();
});

const titles = $derived(
  resolveTitleCollisions(
    tabs.map((tab) => ({
      path: tab.path,
      source: titleSources[tab.path] ?? "",
    })),
  ),
);

type StripEntry = {
  key: string;
  path: string | null;
  tab: WorkspaceTab | null;
  label: string;
  suffix: string | undefined;
};

/** Open notes, plus the transient empty tab when one is open. */
const entries = $derived.by((): StripEntry[] => {
  const open = tabs.map((tab, index) => ({
    key: tab.path,
    path: tab.path,
    tab,
    label: titles[index]?.displayTitle ?? tab.path,
    suffix: titles[index]?.collisionSuffix,
  }));
  return emptyTab
    ? [
        ...open,
        {
          key: EMPTY_TAB_KEY,
          path: null,
          tab: null,
          label: STRINGS.emptyTabLabel,
          suffix: undefined,
        },
      ]
    : open;
});

const activeKey = $derived(
  activePath ?? (emptyTab ? EMPTY_TAB_KEY : null),
) as string | null;

function closeWithMiddleButton(event: MouseEvent, path: string | null) {
  if (event.button !== 1) return;
  event.preventDefault();
  onClose(path, false);
}

function keepPointerFocus(event: MouseEvent) {
  if (event.button === 0) event.preventDefault();
}

function closeFromButton(event: MouseEvent, path: string | null) {
  event.stopPropagation();
  onClose(
    path,
    event.detail === 0 && document.activeElement === event.currentTarget,
  );
}

function finishReorder() {
  if (dragging !== null && insertion !== null && dragging !== insertion) {
    onReorder(dragging, insertion);
  }
  dragging = null;
  insertion = null;
  setTabDrag(null);
}

/** A tab dragged out of another pane's strip, or null for a local drag. */
function foreignDrag(): TabDragOrigin | null {
  const origin = currentTabDrag();
  return origin === null || origin.paneId === paneId ? null : origin;
}

function acceptForeignDragOver(event: DragEvent, index: number) {
  if (foreignDrag() === null) return;
  event.preventDefault();
  event.stopPropagation();
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
  insertion =
    event.clientX < bounds.left + bounds.width / 2 ? index : index + 1;
}

function acceptForeignDrop(event: DragEvent, index: number) {
  const origin = foreignDrag();
  if (origin === null) return;
  event.preventDefault();
  event.stopPropagation();
  const target = insertion ?? index;
  insertion = null;
  setTabDrag(null);
  onAdopt(origin, target);
}

/**
 * How far a tab shifts to open the dragged tab's landing gap. The dragged
 * tab itself follows the pointer natively with no animation; only the tabs
 * it passes over translate, on the panel clock, and dropping resets every
 * offset instantly as the reordered strip takes over.
 */
function reorderOffset(index: number): number {
  if (dragging === null || insertion === null) return 0;
  if (dragging < index && index < insertion) return -dragWidth;
  if (insertion <= index && index < dragging) return dragWidth;
  return 0;
}

function measureOverflow() {
  if (!mounted) return;
  // A settle holds the tabs at widths on the way to the shape the strip is
  // settling into, and those widths can be wider than the strip even when
  // the shape it is heading for fits. Measuring them would move the
  // new-tab control and raise the all-tabs list over an overflow that is
  // about to be gone, so the measurement waits for the strip to land.
  if (settleActive) return;
  const element = itemsElement;
  overflowed =
    element instanceof HTMLElement &&
    element.scrollWidth > element.clientWidth + 1;
  if (!overflowed) listOpen = false;
}

function scheduleIndicatorTravel(generation: number): void {
  const element = indicatorElement;
  if (!mounted || !(element instanceof HTMLElement)) return;
  const duration = motionDurationMilliseconds(
    "--skr-motion-panel-duration",
    itemsElement ?? document.documentElement,
  );
  indicatorMotionFrame = requestAnimationFrame(() => {
    indicatorMotionFrame = null;
    if (!mounted || generation !== indicatorMotionGeneration) return;
    element.style.transition = ACTIVE_INDICATOR_TRAVEL_TRANSITION;
    element.style.transform = "";
    indicatorMotionTimer = setTimeout(() => {
      indicatorMotionTimer = null;
      if (!mounted || generation !== indicatorMotionGeneration) return;
      element.style.transition = "";
      indicatorTraveling = false;
    }, duration);
  });
}

/**
 * Re-reads the active tab's geometry after the strip changes size. If the
 * indicator is traveling, its current rendered position becomes the start
 * of a new panel-clock leg so a resize does not create a visible jump.
 */
function syncActiveIndicatorGeometry() {
  const element = indicatorElement;
  if (!mounted || !(element instanceof HTMLElement)) return;
  const activeIndex =
    activeKey === null
      ? -1
      : entries.findIndex((entry) => entry.key === activeKey);
  const tabElement = activeIndex < 0 ? undefined : tabElements[activeIndex];
  if (!(tabElement instanceof HTMLElement)) return;
  const left = tabElement.offsetLeft;
  const width = tabElement.offsetWidth;
  if (indicatorTraveling) {
    const currentLeft = renderedLeft(element, indicatorRestLeft ?? left);
    const generation = ++indicatorMotionGeneration;
    cancelIndicatorCallbacks();
    element.style.transition = "none";
    element.style.left = `${left}px`;
    element.style.width = `${width}px`;
    element.style.transform = `translateX(${currentLeft - left}px)`;
    indicatorRestLeft = left;
    void element.offsetWidth;
    scheduleIndicatorTravel(generation);
    return;
  }
  element.style.left = `${left}px`;
  element.style.width = `${width}px`;
  indicatorRestLeft = left;
}

/**
 * Holds the active-tab indicator against its own tab for the length of a
 * settle. The tabs travel as layout, so the bar reads their rendered
 * geometry frame by frame instead of running a second animation beside
 * them: bar and tab are one motion, and the bar cannot arrive early. A
 * selection travel already owns the bar while it runs, so this yields to it.
 *
 * Tracking runs for the settle's own length and then for as long as the tab
 * is still moving: a transition's clock starts at the first frame the
 * browser renders it, so on a busy main thread it outlives a deadline
 * measured from the moment the strip was told to travel, and a bar that
 * stopped following at that deadline would be left behind. A hard ceiling
 * keeps the frame loop bounded whatever the strip is doing.
 */
function trackActiveIndicator(duration: number): void {
  cancelIndicatorTracking();
  const started = performance.now();
  const deadline = started + duration;
  const ceiling = started + duration * 5;
  let previousGeometry = "";
  const step = () => {
    indicatorTrackFrame = null;
    if (!mounted) return;
    if (!indicatorTraveling) syncActiveIndicatorGeometry();
    const element = indicatorElement;
    const geometry =
      element instanceof HTMLElement
        ? `${element.style.left}/${element.style.width}`
        : "";
    const moving = geometry !== previousGeometry;
    previousGeometry = geometry;
    const now = performance.now();
    if (now < deadline || (moving && now < ceiling)) {
      indicatorTrackFrame = requestAnimationFrame(step);
    }
  };
  indicatorTrackFrame = requestAnimationFrame(step);
}

/**
 * One strip relayout, run as a single motion on the panel clock: every tab
 * travels from the width it last rendered to the width the new open set
 * gives it, an arriving tab expands from nothing and the gap a leaving tab
 * left collapses over the same interval, and the indicator tracks its tab
 * throughout. Nothing waits on it: the open set changed before it started.
 */
async function settleStrip(
  from: ReadonlyMap<string, number>,
  gaps: ReadonlyMap<string, { start: number; end: number }>,
): Promise<void> {
  const items = itemsElement;
  if (!mounted || !(items instanceof HTMLElement)) return;
  const duration = motionDurationMilliseconds(
    "--skr-motion-panel-duration",
    items,
  );
  if (duration === 0) return;
  const generation = ++settleGeneration;
  settleActive = true;
  await tick();
  if (!mounted || generation !== settleGeneration) return;
  const targets = new Map<string, number>();
  const start = new Map<string, number>();
  for (const [index, entry] of entries.entries()) {
    const element = tabElements[index];
    if (!(element instanceof HTMLElement) || element.offsetWidth <= 0) continue;
    targets.set(entry.key, element.offsetWidth);
    start.set(entry.key, from.get(entry.key) ?? 0);
  }
  if (targets.size === 0) {
    settleActive = false;
    return;
  }
  // The strip is put back where it was, without a clock, so the widths the
  // transition below starts from are the ones the user last saw.
  settling = false;
  pinnedWidths = start;
  settleGaps = gaps.size === 0 ? null : new Map(gaps);
  await tick();
  if (!mounted || generation !== settleGeneration) return;
  void items.offsetWidth;
  settling = true;
  pinnedWidths = targets;
  settleGaps = null;
  trackActiveIndicator(duration);
  if (settleTimer !== null) clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    settleTimer = null;
    if (!mounted || generation !== settleGeneration) return;
    settleActive = false;
    settling = false;
    pinnedWidths = null;
    // The strip has landed, so it is read once at rest: whatever the settle
    // managed to render — a main thread busy enough to eat the whole
    // interval renders none of it — the bar belongs on its tab, and whether
    // the tabs overflow is a question about this shape, not the one they
    // travelled through.
    void tick().then(() => {
      if (!mounted) return;
      measureOverflow();
      if (!indicatorTraveling) syncActiveIndicatorGeometry();
    });
  }, duration);
}

/**
 * The gap each closed tab leaves, charged to the tab that followed it so
 * the settle starts from the pre-close layout. A tab closed at the end
 * charges its gap to the last survivor's trailing edge instead.
 */
function settleGapsFor(
  previous: readonly string[],
  keys: readonly string[],
  slots: ReadonlyMap<string, { left: number; width: number; label: string }>,
): Map<string, { start: number; end: number }> {
  const gaps = new Map<string, { start: number; end: number }>();
  const charge = (key: string, edge: "start" | "end", width: number) => {
    const gap = gaps.get(key) ?? { start: 0, end: 0 };
    gap[edge] += width;
    gaps.set(key, gap);
  };
  const surviving = keys.filter((key) => previous.includes(key));
  const last = surviving.at(-1);
  for (const [index, key] of previous.entries()) {
    if (keys.includes(key)) continue;
    const width = slots.get(key)?.width;
    if (width === undefined || width <= 0) continue;
    const next = previous.slice(index + 1).find((other) => keys.includes(other));
    if (next !== undefined) charge(next, "start", width);
    else if (last !== undefined) charge(last, "end", width);
  }
  return gaps;
}

/** Brings the active tab into view when the strip scrolls horizontally. */
function revealActiveTab() {
  const items = itemsElement;
  if (!mounted || !(items instanceof HTMLElement)) return;
  const activeIndex =
    activeKey === null
      ? -1
      : entries.findIndex((entry) => entry.key === activeKey);
  const tabElement = activeIndex < 0 ? undefined : tabElements[activeIndex];
  if (!(tabElement instanceof HTMLElement)) return;
  const left = tabElement.offsetLeft;
  const right = left + tabElement.offsetWidth;
  if (left < items.scrollLeft) items.scrollLeft = left;
  else if (right > items.scrollLeft + items.clientWidth) {
    items.scrollLeft = right - items.clientWidth;
  }
}

function measureOverflowAndIndicator() {
  measureOverflow();
  revealActiveTab();
  syncActiveIndicatorGeometry();
}

/**
 * The geometry and label each tab had immediately before the last update.
 * A close reads its slot from here, because by the time the change is
 * observable the tab's own element is already gone. It is captured from the
 * rendered strip rather than from `entries`, which has already moved on.
 */
let renderedSlots = new Map<
  string,
  { left: number; width: number; label: string }
>();

$effect.pre(() => {
  void entries;
  const items = itemsElement;
  if (!(items instanceof HTMLElement)) return;
  const captured = new Map<
    string,
    { left: number; width: number; label: string }
  >();
  for (const shell of items.querySelectorAll<HTMLElement>(".skr-tab-shell")) {
    const key = shell.dataset.tabKey;
    if (key === undefined || shell.offsetWidth <= 0) continue;
    captured.set(key, {
      left: shell.offsetLeft,
      width: shell.offsetWidth,
      label: shell.dataset.tabLabel ?? "",
    });
  }
  if (captured.size > 0) renderedSlots = captured;
});

/**
 * One pass over a change in the open set. A close holds the surviving tabs
 * at their previous widths while the pointer rests over the strip, so the
 * next tab's close control stays under it, and leaves a ghost of the closed
 * tab in the slot it held so the tab is seen to leave. Every other change
 * settles: the strip travels to its new shape on the panel clock instead of
 * arriving in one frame. Nothing waits on either: the tab is gone from
 * state in the same frame.
 */
$effect(() => {
  const keys = entries.map((entry) => entry.key);
  const previous = previousEntryKeys;
  previousEntryKeys = keys;
  const removed = previous.filter((key) => !keys.includes(key));
  const added = keys.filter((key) => !previous.includes(key));
  if (removed.length === 0 && added.length === 0) return;
  const slots = renderedSlots;
  let holding = false;

  if (removed.length > 0) {
    if (pointerOverStrip && keys.length > 0) {
      const held = new Map<string, number>();
      for (const key of keys) {
        const width = slots.get(key)?.width;
        if (width !== undefined && width > 0) held.set(key, width);
      }
      if (held.size === keys.length) {
        // The pointer is resting on the strip, so the surviving tabs keep
        // the widths they had and the gap closes in the same frame: the
        // next tab's close control has to land under the pointer, not
        // arrive under it at the end of an animation. The indicator jumps
        // with them, once those widths are on the page, because a bar that
        // measured the strip before it was held sits on no tab at all.
        cancelSettle();
        pinnedWidths = held;
        holding = true;
        void tick().then(() => {
          if (mounted && !indicatorTraveling) syncActiveIndicatorGeometry();
        });
      }
    }
    const ghosts = removed
      .map((key) => {
        const slot = slots.get(key);
        return slot === undefined
          ? null
          : {
              id: nextExitId++,
              label: slot.label,
              left: slot.left,
              width: slot.width,
            };
      })
      .filter((ghost): ghost is NonNullable<typeof ghost> => ghost !== null);
    if (ghosts.length > 0) exitingTabs = [...exitingTabs, ...ghosts];
  }

  // A strip with no rendered geometry behind it (its first render) has
  // nothing to travel from and arrives in place.
  if (holding || slots.size === 0) return;
  const from = new Map<string, number>();
  for (const [key, slot] of slots) from.set(key, slot.width);
  void settleStrip(from, settleGapsFor(previous, keys, slots));
});

function releaseExitingTab(element: HTMLElement, id: number) {
  // Attachments re-run whenever the block renders; the dismissal starts once.
  if (element.dataset.dismissing !== undefined) return;
  const remove = () => {
    exitingTabs = exitingTabs.filter((ghost) => ghost.id !== id);
  };
  const duration = motionDurationMilliseconds(
    "--skr-motion-panel-duration",
    element,
  );
  if (duration === 0) {
    remove();
    return;
  }
  // The ghost paints at full width and opacity in the slot its tab held and
  // then leaves the way a tab arrives, in reverse: its slot collapses to
  // nothing while it fades, on the clock the rest of the strip settles on.
  // The forced reflow commits that resting state as the transition's start
  // value; without it the flip below lands in the same style recalculation
  // and the tab would vanish rather than be seen to leave.
  void element.offsetWidth;
  element.dataset.dismissing = "true";
  element.style.width = "0px";
  setTimeout(remove, duration);
}

/**
 * Releases the held widths when the pointer leaves. The strip settles from
 * the widths it was holding to the ones the open set gives it, so the tabs
 * expand and travel as one motion with the indicator riding along.
 */
function releaseHeldWidths() {
  pointerOverStrip = false;
  const held = pinnedWidths;
  if (held === null || settling) return;
  pinnedWidths = null;
  void settleStrip(held, new Map());
}

// registry-exempt keydown: the ARIA tabs pattern's own roving focus. Every
// command the strip offers (activate, close, new tab) stays registered.
function onTabKeydown(event: KeyboardEvent) {
  const last = entries.length - 1;
  let next = rovingIndex;
  if (event.key === "ArrowRight") next = rovingIndex >= last ? 0 : rovingIndex + 1;
  else if (event.key === "ArrowLeft")
    next = rovingIndex <= 0 ? last : rovingIndex - 1;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = last;
  else return;
  event.preventDefault();
  rovingIndex = next;
  void tick().then(() => {
    const element = tabElements[next];
    element?.querySelector<HTMLElement>('[role="tab"]')?.focus();
  });
}

$effect(() => {
  const activeIndex =
    activeKey === null
      ? -1
      : entries.findIndex((entry) => entry.key === activeKey);
  if (activeIndex >= 0) rovingIndex = activeIndex;
  else if (rovingIndex > entries.length - 1) rovingIndex = 0;
});

$effect(() => {
  void activeKey;
  void entries.length;
  void tick().then(() => {
    if (mounted) revealActiveTab();
  });
});

$effect(() => {
  void entries.length;
  void tick().then(() => {
    if (mounted) measureOverflow();
  });
});

/**
 * Travels the active-tab indicator from its previous tab to the new one on
 * the panel clock, a compositor-only transform. This effect re-runs for
 * reasons other than a selection change too (tabs opening or closing, the
 * strip reflowing), in which case it just follows the new geometry with no
 * choreography: the travel is reserved for an actual tab switch. When the
 * previously active tab has closed, there is nothing to travel from, so the
 * indicator enters in place with the surface class instead.
 */
$effect(() => {
  const path = activeKey;
  const element = indicatorElement;
  const items = itemsElement;
  if (!(element instanceof HTMLElement) || !(items instanceof HTMLElement)) {
    cancelIndicatorCallbacks();
    indicatorRestLeft = null;
    indicatorAnimatedPath = null;
    indicatorTraveling = false;
    return;
  }
  const activeIndex =
    path === null ? -1 : entries.findIndex((entry) => entry.key === path);
  const tabElement = activeIndex < 0 ? undefined : tabElements[activeIndex];

  if (!(tabElement instanceof HTMLElement)) {
    // Deliberately leaves `indicatorAnimatedPath` untouched: the active
    // tab's own element can resolve to undefined on an intermediate pass
    // within the same flush (its `bind:this` not settled yet) before
    // resolving a moment later, and recording the path here would make
    // that later, real pass look like a no-op re-selection instead of new.
    element.style.transition = "";
    element.style.transform = "";
    element.style.opacity = "0";
    indicatorRestLeft = null;
    return;
  }

  const previousPath = indicatorAnimatedPath;
  const isNewSelection = path !== previousPath;
  const previousStillOpen =
    previousPath !== null &&
    entries.some((entry) => entry.key === previousPath);
  indicatorAnimatedPath = path;
  const previousLeft =
    indicatorRestLeft === null
      ? null
      : renderedLeft(element, indicatorRestLeft);
  cancelIndicatorCallbacks();
  const generation = ++indicatorMotionGeneration;

  const left = tabElement.offsetLeft;
  const width = tabElement.offsetWidth;
  const duration = motionDurationMilliseconds(
    "--skr-motion-panel-duration",
    items,
  );

  if (duration === 0 || !isNewSelection) {
    indicatorTraveling = false;
    delete element.dataset.motionSurface;
    element.style.transition = "";
    element.style.transform = "";
    element.style.opacity = "1";
    element.style.left = `${left}px`;
    element.style.width = `${width}px`;
    indicatorRestLeft = left;
    return;
  }

  if (indicatorRestLeft === null || !previousStillOpen) {
    indicatorTraveling = false;
    element.style.transition = "";
    element.style.transform = "";
    element.style.opacity = "";
    element.style.left = `${left}px`;
    element.style.width = `${width}px`;
    indicatorRestLeft = left;
    delete element.dataset.motionExiting;
    element.dataset.motionSurface = "fade";
    enterMotionSurface(element);
    return;
  }

  if (previousLeft === null) return;
  delete element.dataset.motionSurface;
  element.style.transition = "none";
  element.style.opacity = "1";
  element.style.left = `${left}px`;
  element.style.width = `${width}px`;
  element.style.transform = `translateX(${previousLeft - left}px)`;
  indicatorRestLeft = left;
  indicatorTraveling = true;
  void element.offsetWidth;
  scheduleIndicatorTravel(generation);
});

onMount(() => {
  const observer = new ResizeObserver(measureOverflowAndIndicator);
  if (itemsElement instanceof HTMLElement) observer.observe(itemsElement);
  window.addEventListener("resize", measureOverflowAndIndicator);
  measureOverflow();
  return () => {
    observer.disconnect();
    window.removeEventListener("resize", measureOverflowAndIndicator);
  };
});

function scrollWithWheel(event: WheelEvent) {
  if (!(itemsElement instanceof HTMLElement) || !overflowed) return;
  const delta =
    Math.abs(event.deltaX) > Math.abs(event.deltaY)
      ? event.deltaX
      : event.deltaY;
  if (delta === 0) return;
  itemsElement.scrollLeft += delta;
  event.preventDefault();
}

function beginScrollDrag(event: PointerEvent) {
  if (
    event.button !== 0 ||
    !(itemsElement instanceof HTMLElement) ||
    !overflowed ||
    event.target !== itemsElement
  ) {
    return;
  }
  scrollPointer = event.pointerId;
  scrollOriginX = event.clientX;
  scrollOriginLeft = itemsElement.scrollLeft;
  itemsElement.setPointerCapture(event.pointerId);
}

function updateScrollDrag(event: PointerEvent) {
  if (event.pointerId !== scrollPointer || !(itemsElement instanceof HTMLElement))
    return;
  itemsElement.scrollLeft = scrollOriginLeft - (event.clientX - scrollOriginX);
}

function finishScrollDrag(event: PointerEvent) {
  if (event.pointerId !== scrollPointer || !(itemsElement instanceof HTMLElement))
    return;
  if (itemsElement.hasPointerCapture(event.pointerId)) {
    itemsElement.releasePointerCapture(event.pointerId);
  }
  scrollPointer = null;
}
</script>

<!-- The new-tab control is the end of the open set, so it sits against the
     last tab and travels with the run of tabs. Once that run is longer than
     the strip, it pins to the strip's own trailing edge instead: the state
     where a person most needs it is the one where a control inside the
     scrolling run would be scrolled off the screen. -->
{#snippet newTab()}
  <button
    type="button"
    class="skr-tab-new"
    data-command-id="tab.new-empty"
    aria-label={STRINGS.newTab}
    use:commandTooltip={{ title: STRINGS.newTab }}
    onclick={onNewTab}
  >
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  </button>
{/snippet}

<div
  class="skr-tab-strip"
  data-pane-strip={paneId}
  role="presentation"
  onpointerenter={() => (pointerOverStrip = true)}
  onpointerleave={releaseHeldWidths}
>
  <div
    class="skr-tab-items"
    class:skr-tab-items-scrolling={scrollPointer !== null}
    class:skr-tab-items-reordering={dragging !== null}
    class:skr-tab-items-settling={settling}
    role="presentation"
    bind:this={itemsElement}
    onwheel={scrollWithWheel}
    onpointerdown={beginScrollDrag}
    onpointermove={updateScrollDrag}
    onpointerup={finishScrollDrag}
    onpointercancel={finishScrollDrag}
    onkeydown={onTabKeydown}
    ondragover={(event) => acceptForeignDragOver(event, entries.length)}
    ondragleave={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
        insertion = null;
      }
    }}
    ondrop={(event) => acceptForeignDrop(event, entries.length)}
  >
    <!-- The tablist owns the tabs explicitly because each visible tab also
         needs an independently focusable close control. Keeping that
         control outside the tablist's owned children preserves both the
         ARIA tab pattern and the close command's keyboard route. -->
    <div
      class="skr-tablist"
      role="tablist"
      aria-label={STRINGS.openTabs}
      aria-owns={entries.map((_, index) => tabId(index)).join(" ")}
    ></div>
    {#each entries as entry, index (entry.key)}
    <div
      bind:this={tabElements[index]}
      class="skr-tab-shell"
      role="presentation"
      class:skr-tab-focused={focused && entry.key === activeKey}
      class:skr-tab-active={entry.key === activeKey}
      class:skr-tab-dirty={entry.tab?.dirty === true}
      class:skr-tab-insertion={insertion === index && dragging !== index}
      class:skr-tab-dragging={dragging === index}
      data-tab-key={entry.key}
      data-tab-label={entry.label}
      style:flex={pinnedWidths?.get(entry.key) === undefined
        ? null
        : `0 0 ${pinnedWidths.get(entry.key)}px`}
      style:margin-inline-start={settleGaps?.get(entry.key) === undefined
        ? null
        : `${settleGaps.get(entry.key)?.start}px`}
      style:margin-inline-end={settleGaps?.get(entry.key) === undefined
        ? null
        : `${settleGaps.get(entry.key)?.end}px`}
      style:transform={dragging !== null && dragging !== index
        ? `translateX(${reorderOffset(index)}px)`
        : null}
      draggable={entry.path !== null}
      onmousedown={(event) => closeWithMiddleButton(event, entry.path)}
      ondragstart={(event) => {
        if (entry.path === null) {
          event.preventDefault();
          return;
        }
        dragging = index;
        dragWidth = event.currentTarget.offsetWidth;
        setTabDrag({ path: entry.path, paneId });
        event.dataTransfer?.setData("application/x-skribeum-tab", entry.path);
        if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = "move";
      }}
      ondragover={(event) => {
        if (dragging === null) {
          acceptForeignDragOver(event, index);
          return;
        }
        event.preventDefault();
        const bounds = event.currentTarget.getBoundingClientRect();
        insertion = event.clientX < bounds.left + bounds.width / 2 ? index : index + 1;
      }}
      ondrop={(event) => {
        if (dragging === null) {
          acceptForeignDrop(event, index);
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        finishReorder();
      }}
      ondragend={finishReorder}
    >
      <button
        type="button"
        class="skr-tab"
        role="tab"
        id={tabId(index)}
        aria-selected={entry.key === activeKey}
        aria-label={
          entry.tab?.dirty === true
            ? `${entry.label}, ${STRINGS.unsavedNote}`
            : undefined
        }
        data-dirty={entry.tab?.dirty === true ? "true" : undefined}
        data-empty-tab={entry.path === null ? "true" : undefined}
        tabindex={index === rovingIndex ? 0 : -1}
        onclick={() => onActivate(entry.path)}
      >
        <span class="skr-tab-label">{entry.label}</span>
        {#if entry.suffix !== undefined}
          <span class="skr-tab-suffix">{entry.suffix}</span>
        {/if}
      </button>
      <span class="skr-tab-status">
        {#if entry.tab?.dirty === true}
          <span
            class="skr-tab-unsaved"
            aria-label={STRINGS.unsavedNote}
          ></span>
        {/if}
        <button
          type="button"
          class="skr-tab-close"
          class:skr-tab-close-dirty={entry.tab?.dirty === true}
          data-command-id="tab.close"
          aria-label={STRINGS.closeTab}
          tabindex={index === rovingIndex ? 0 : -1}
          use:commandTooltip={closeTooltip}
          onpointerdown={keepPointerFocus}
          onmousedown={keepPointerFocus}
          onclick={(event) => closeFromButton(event, entry.path)}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="m4.5 4.5 7 7m0-7-7 7" />
          </svg>
        </button>
      </span>
    </div>
    {/each}
    {#each exitingTabs as ghost (ghost.id)}
      <span
        class="skr-tab-exiting"
        aria-hidden="true"
        inert
        style={`left: ${ghost.left}px; width: ${ghost.width}px`}
        {@attach (element) => releaseExitingTab(element, ghost.id)}
      >
        <span class="skr-tab-label">{ghost.label}</span>
      </span>
    {/each}
    {#if !overflowed}{@render newTab()}{/if}
    <span
      bind:this={indicatorElement}
      class="skr-tab-active-indicator"
      class:skr-tab-active-indicator-focused={focused}
      aria-hidden="true"
    ></span>
  </div>
  {#if overflowed}
    {@render newTab()}
    <div class="skr-tab-list-shell">
      <button
        bind:this={listButtonElement}
        type="button"
        class="skr-tab-list"
        aria-label={STRINGS.allTabs}
        aria-haspopup="menu"
        aria-expanded={listOpen}
        use:commandTooltip={{ title: STRINGS.allTabs }}
        onclick={() => (listOpen = !listOpen)}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3 4h10M3 8h10M3 12h10" />
        </svg>
      </button>
      {#if listOpen && listButtonElement !== undefined}
        <AnchoredMenu
          anchor={listButtonElement}
          label={STRINGS.allTabs}
          align="end"
          onClose={() => (listOpen = false)}
        >
          {#each entries as entry (entry.key)}
            <button
              type="button"
              role="menuitemradio"
              aria-checked={entry.key === activeKey}
              onclick={() => {
                listOpen = false;
                onActivate(entry.path);
              }}
            >
              <span>{entry.label}</span>
              {#if entry.suffix !== undefined}
                <span class="skr-tab-suffix">{entry.suffix}</span>
              {/if}
            </button>
          {/each}
        </AnchoredMenu>
      {/if}
    </div>
  {/if}
</div>

<style>
/* The strip owns its own motion and its own hover shape, so the cascade
   here is self-contained: every transition a tab can run is declared in
   this block, in the order the states can occur. */

.skr-tab-shell {
  /* The hover fill takes the control radius, the same one the file tree's
     row fills take, so a pointer resting on a tab lands on a soft chip
     rather than a full-height rectangle. It rests here rather than on the
     hover state so the shape is the tab's, not the pointer's. */
  border-radius: var(--skr-radius-control);
  /* The fill arrives on the dismissal clock, the same one the close
     control inside it fades on: the whole hover affordance is one act. */
  transition: background-color var(--skr-motion-state-duration)
    var(--skr-motion-state-easing);
}

/* While a tab drags, the tabs it passes over reflow to open its landing
   gap on the panel clock, a compositor-only translate; the dragged tab
   itself follows the pointer natively with no animation at all. */
.skr-tab-items-reordering .skr-tab-shell {
  transition: transform var(--skr-motion-panel-duration)
    var(--skr-motion-panel-easing);
}

.skr-tab-items-reordering .skr-tab-dragging {
  transition: none;
}

/* One settle: the widths the tabs travel between and the gap a closed tab
   leaves, both on the panel clock, which is the class that governs a
   chrome dimension. */
.skr-tab-items-settling .skr-tab-shell {
  transition:
    flex-basis var(--skr-motion-panel-duration) var(--skr-motion-panel-easing),
    margin var(--skr-motion-panel-duration) var(--skr-motion-panel-easing),
    background-color var(--skr-motion-state-duration)
    var(--skr-motion-state-easing);
}

/* A closed tab leaves the way a tab arrives, reversed: its slot collapses
   to nothing while it fades, on the clock the strip settles on. */
.skr-tab-exiting {
  transition:
    opacity var(--skr-motion-panel-duration) var(--skr-motion-panel-easing),
    width var(--skr-motion-panel-duration) var(--skr-motion-panel-easing);
}

/* The new-tab control sits in the scrolling run of tabs, so it holds its
   own size there instead of flexing with them, and its hover fill takes the
   same corner and clock as the tab it sits against. */
.skr-tab-new {
  flex: none;
  border-radius: var(--skr-radius-control);
  transition: background-color var(--skr-motion-state-duration)
    var(--skr-motion-state-easing);
}
</style>
