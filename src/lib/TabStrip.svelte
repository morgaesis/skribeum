<script lang="ts">
import { onMount, tick } from "svelte";
import AnchoredMenu from "./AnchoredMenu.svelte";
import { type CommandTooltipOptions, commandTooltip } from "./commandTooltip";
import { enterMotionSurface, motionDurationMilliseconds } from "./motion";
import { resolveTitleCollisions } from "./noteTitles";
import { STRINGS } from "./strings";
import type { WorkspaceTab } from "./workspaceState";

// The active-tab indicator travel: a compositor-only transform on the panel
// clock, matching the reorder reflow's own clock below.
const ACTIVE_INDICATOR_TRAVEL_TRANSITION =
  "transform var(--skr-motion-panel-duration) var(--skr-motion-panel-easing)";

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
  if (translate !== null) {
    return Number.parseFloat(translate[1] ?? "0");
  }
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
  tabs,
  activePath,
  titleSources,
  focused,
  closeTooltip = { title: STRINGS.closeTab },
  onActivate,
  onClose,
  onReorder,
}: {
  tabs: readonly WorkspaceTab[];
  activePath: string | null;
  titleSources: Readonly<Record<string, string>>;
  focused: boolean;
  closeTooltip?: CommandTooltipOptions;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
  onReorder: (from: number, to: number) => void;
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
let indicatorTraveling = false;

const titles = $derived(
  resolveTitleCollisions(
    tabs.map((tab) => ({
      path: tab.path,
      source: titleSources[tab.path] ?? "",
    })),
  ),
);

function closeWithMiddleButton(event: MouseEvent, path: string) {
  if (event.button !== 1) return;
  event.preventDefault();
  onClose(path);
}

function finishReorder() {
  if (dragging !== null && insertion !== null && dragging !== insertion) {
    onReorder(dragging, insertion);
  }
  dragging = null;
  insertion = null;
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
  const element = itemsElement;
  overflowed =
    element instanceof HTMLElement &&
    element.scrollWidth > element.clientWidth + 1;
  if (!overflowed) listOpen = false;
}

/**
 * Re-reads the active tab's geometry with no choreography, for a resize
 * that shifts the flexible tab widths without any selection change. Any
 * choreographed travel or entrance is left untouched: this only ever runs
 * outside the animated effect below, from the resize observer and handler.
 */
function syncActiveIndicatorGeometry() {
  const element = indicatorElement;
  if (element === undefined) return;
  const activeIndex =
    activePath === null ? -1 : tabs.findIndex((tab) => tab.path === activePath);
  const tabElement = activeIndex < 0 ? undefined : tabElements[activeIndex];
  if (tabElement === undefined) return;
  const left = tabElement.offsetLeft;
  const width = tabElement.offsetWidth;
  if (indicatorTraveling) {
    const currentLeft = renderedLeft(element, indicatorRestLeft ?? left);
    const generation = ++indicatorMotionGeneration;
    element.style.transition = "none";
    element.style.left = `${left}px`;
    element.style.width = `${width}px`;
    element.style.transform = `translateX(${currentLeft - left}px)`;
    indicatorRestLeft = left;
    void element.offsetWidth;
    requestAnimationFrame(() => {
      if (generation !== indicatorMotionGeneration) return;
      element.style.transition = ACTIVE_INDICATOR_TRAVEL_TRANSITION;
      element.style.transform = "";
      setTimeout(
        () => {
          if (generation !== indicatorMotionGeneration) return;
          element.style.transition = "";
          indicatorTraveling = false;
        },
        motionDurationMilliseconds(
          "--skr-motion-panel-duration",
          itemsElement ?? document.documentElement,
        ),
      );
    });
    return;
  }
  element.style.left = `${left}px`;
  element.style.width = `${width}px`;
  indicatorRestLeft = left;
}

function measureOverflowAndIndicator() {
  measureOverflow();
  syncActiveIndicatorGeometry();
}

$effect(() => {
  void tabs.length;
  void tick().then(measureOverflow);
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
  const path = activePath;
  const element = indicatorElement;
  const items = itemsElement;
  if (element === undefined || items === undefined) {
    indicatorRestLeft = null;
    indicatorAnimatedPath = null;
    indicatorTraveling = false;
    return;
  }
  const activeIndex =
    path === null ? -1 : tabs.findIndex((tab) => tab.path === path);
  const tabElement = activeIndex < 0 ? undefined : tabElements[activeIndex];

  if (tabElement === undefined) {
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
    previousPath !== null && tabs.some((tab) => tab.path === previousPath);
  indicatorAnimatedPath = path;
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

  const previousLeft = renderedLeft(element, indicatorRestLeft);
  delete element.dataset.motionSurface;
  element.style.transition = "none";
  element.style.opacity = "1";
  element.style.left = `${left}px`;
  element.style.width = `${width}px`;
  element.style.transform = `translateX(${previousLeft - left}px)`;
  indicatorRestLeft = left;
  indicatorTraveling = true;
  void element.offsetWidth;
  requestAnimationFrame(() => {
    if (generation !== indicatorMotionGeneration) return;
    element.style.transition = ACTIVE_INDICATOR_TRAVEL_TRANSITION;
    element.style.transform = "";
    setTimeout(() => {
      if (generation !== indicatorMotionGeneration) return;
      element.style.transition = "";
      indicatorTraveling = false;
    }, duration);
  });
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
  if (itemsElement === undefined || !overflowed) return;
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
    itemsElement === undefined ||
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
  if (event.pointerId !== scrollPointer || itemsElement === undefined) return;
  itemsElement.scrollLeft = scrollOriginLeft - (event.clientX - scrollOriginX);
}

function finishScrollDrag(event: PointerEvent) {
  if (event.pointerId !== scrollPointer || itemsElement === undefined) return;
  if (itemsElement.hasPointerCapture(event.pointerId)) {
    itemsElement.releasePointerCapture(event.pointerId);
  }
  scrollPointer = null;
}
</script>

{#if tabs.length > 1}
  <div class="skr-tab-strip">
    <div
      class="skr-tab-items"
      class:skr-tab-items-scrolling={scrollPointer !== null}
      class:skr-tab-items-reordering={dragging !== null}
      role="tablist"
      tabindex="-1"
      aria-label={STRINGS.openTabs}
      bind:this={itemsElement}
      onwheel={scrollWithWheel}
      onpointerdown={beginScrollDrag}
      onpointermove={updateScrollDrag}
      onpointerup={finishScrollDrag}
      onpointercancel={finishScrollDrag}
    >
      {#each tabs as tab, index (tab.path)}
      {@const title = titles[index]}
      <button
        bind:this={tabElements[index]}
        type="button"
        class="skr-tab-shell"
        role="tab"
        aria-selected={tab.path === activePath}
        tabindex={tab.path === activePath ? 0 : -1}
        class:skr-tab-focused={focused && tab.path === activePath}
        class:skr-tab-active={tab.path === activePath}
        class:skr-tab-dirty={tab.dirty === true}
        class:skr-tab-insertion={insertion === index && dragging !== index}
        class:skr-tab-dragging={dragging === index}
        style:transform={dragging !== null && dragging !== index
          ? `translateX(${reorderOffset(index)}px)`
          : null}
        draggable="true"
        onmousedown={(event) => closeWithMiddleButton(event, tab.path)}
        onclick={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest(".skr-tab-close") !== null
          ) {
            onClose(tab.path);
          } else {
            onActivate(tab.path);
          }
        }}
        ondragstart={(event) => {
          dragging = index;
          dragWidth = event.currentTarget.offsetWidth;
          event.dataTransfer?.setData("application/x-skribeum-tab", tab.path);
          if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = "move";
        }}
        ondragover={(event) => {
          if (dragging === null) return;
          event.preventDefault();
          const bounds = event.currentTarget.getBoundingClientRect();
          insertion = event.clientX < bounds.left + bounds.width / 2 ? index : index + 1;
        }}
        ondrop={(event) => {
          event.preventDefault();
          finishReorder();
        }}
        ondragend={finishReorder}
      >
        <span class="skr-tab">
          <span class="skr-tab-label">{title?.displayTitle ?? tab.path}</span>
          {#if title?.collisionSuffix !== undefined}
            <span class="skr-tab-suffix">{title.collisionSuffix}</span>
          {/if}
        </span>
        <span class="skr-tab-status">
          {#if tab.dirty === true}
            <span
              class="skr-tab-unsaved"
              aria-label={STRINGS.unsavedNote}
            ></span>
          {/if}
          <span
            class="skr-tab-close"
            class:skr-tab-close-dirty={tab.dirty === true}
            data-command-id="tab.close"
            aria-hidden="true"
            use:commandTooltip={closeTooltip}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="m4.5 4.5 7 7m0-7-7 7" />
            </svg>
          </span>
        </span>
      </button>
      {/each}
      <span
        bind:this={indicatorElement}
        class="skr-tab-active-indicator"
        class:skr-tab-active-indicator-focused={focused}
        aria-hidden="true"
      ></span>
    </div>
    {#if overflowed}
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
            {#each tabs as tab, index (tab.path)}
              {@const title = titles[index]}
              <button
                type="button"
                role="menuitemradio"
                aria-checked={tab.path === activePath}
                onclick={() => {
                  listOpen = false;
                  onActivate(tab.path);
                }}
              >
                <span>{title?.displayTitle ?? tab.path}</span>
                {#if title?.collisionSuffix !== undefined}
                  <span class="skr-tab-suffix">{title.collisionSuffix}</span>
                {/if}
              </button>
            {/each}
          </AnchoredMenu>
        {/if}
      </div>
    {/if}
  </div>
{/if}
