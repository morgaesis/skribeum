<script lang="ts">
import { onMount, tick } from "svelte";
import { type CommandTooltipOptions, commandTooltip } from "./commandTooltip";
import { resolveTitleCollisions } from "./noteTitles";
import { STRINGS } from "./strings";
import type { WorkspaceTab } from "./workspaceState";

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
let overflowed = $state(false);
let scrollPointer = $state<number | null>(null);
let scrollOriginX = 0;
let scrollOriginLeft = 0;

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

function measureOverflow() {
  const element = itemsElement;
  overflowed =
    element instanceof HTMLElement &&
    element.scrollWidth > element.clientWidth + 1;
  if (!overflowed) listOpen = false;
}

$effect(() => {
  void tabs.length;
  void tick().then(measureOverflow);
});

onMount(() => {
  const observer = new ResizeObserver(measureOverflow);
  if (itemsElement instanceof HTMLElement) observer.observe(itemsElement);
  window.addEventListener("resize", measureOverflow);
  measureOverflow();
  return () => {
    observer.disconnect();
    window.removeEventListener("resize", measureOverflow);
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
        type="button"
        class="skr-tab-shell"
        role="tab"
        aria-selected={tab.path === activePath}
        tabindex={tab.path === activePath ? 0 : -1}
        class:skr-tab-focused={focused && tab.path === activePath}
        class:skr-tab-active={tab.path === activePath}
        class:skr-tab-insertion={insertion === index && dragging !== index}
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
        {#if tab.dirty === true}
          <span class="skr-tab-unsaved" aria-label={STRINGS.unsavedNote}></span>
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
      </button>
      {/each}
    </div>
    {#if overflowed}
      <div class="skr-tab-list-shell">
        <button
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
        {#if listOpen}
          <div class="skr-tab-menu" role="menu" aria-label={STRINGS.allTabs}>
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
          </div>
        {/if}
      </div>
    {/if}
  </div>
{/if}
