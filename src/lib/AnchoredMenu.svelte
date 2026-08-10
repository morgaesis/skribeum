<script lang="ts">
// The one anchored-menu surface every chrome dropdown renders through: the
// tab strip's "all tabs" list and the header overflow menu on wide
// viewports. It owns positioning against its invoking control (with
// flip-to-fit), the state-class hover a menu row gets from app.css, the
// surface-class entrance and exit motion of design section 5.1, and the
// three dismissal guarantees every menu makes: a capture-phase outside
// press, Escape, and window blur. A menu that draws its own chrome outside
// this component is a defect against the pattern, not a variant of it.
//
// registry-exempt keydown: ARIA menu pattern internal roving focus
// (arrows, Home, End) stays inside the widget; every row it moves focus
// to is a registered command already, so this only ever moves focus.
import { onMount, type Snippet, tick } from "svelte";
import {
  attachMenuDismissal,
  computeAnchoredPosition,
  menuRows,
  moveMenuFocus,
} from "./anchoredMenu";
import { enterMotionSurface, exitMotionSurface } from "./motion";
import { observeVisualViewport, visualViewportRect } from "./visualViewport";

let {
  anchor,
  label,
  onClose,
  align = "start",
  minWidth = "12rem",
  maxWidth = "min(22rem, calc(100vw - 1rem))",
  restoreFocus = true,
  children,
}: {
  /** The control this menu opened from; its rect drives placement. */
  anchor: HTMLElement;
  label: string;
  onClose: () => void;
  align?: "start" | "end";
  minWidth?: string;
  maxWidth?: string;
  restoreFocus?: boolean;
  children?: Snippet;
} = $props();

let surface = $state<HTMLElement>();
let closing = false;
let stopDismissal: (() => void) | null = null;
let stopViewport: (() => void) | null = null;

function reposition() {
  const element = surface;
  if (element === undefined) return;
  const viewport = visualViewportRect(
    element.ownerDocument.defaultView ?? window,
  );
  const position = computeAnchoredPosition(
    anchor.getBoundingClientRect(),
    { width: element.offsetWidth, height: element.offsetHeight },
    viewport,
    { align },
  );
  element.style.left = `${position.left}px`;
  element.style.top = `${position.top}px`;
  element.style.maxHeight = `${position.maxHeight}px`;
  element.dataset.motionSurface =
    position.placement === "above" ? "anchored-bottom" : "anchored-top";
}

function requestClose() {
  if (closing) return;
  closing = true;
  stopDismissal?.();
  stopDismissal = null;
  stopViewport?.();
  stopViewport = null;
  const element = surface;
  if (element === undefined) {
    onClose();
    return;
  }
  void exitMotionSurface(element, onClose);
}

function onKeydown(event: KeyboardEvent) {
  const element = surface;
  if (element === undefined) return;
  if (moveMenuFocus(element, event.key)) {
    event.preventDefault();
  }
}

onMount(() => {
  const element = surface;
  if (element === undefined) return;
  reposition();
  enterMotionSurface(element);
  stopViewport = observeVisualViewport(
    reposition,
    element.ownerDocument.defaultView ?? window,
  );
  stopDismissal = attachMenuDismissal(element, {
    onDismiss: requestClose,
    ignore: [anchor],
  });
  void tick().then(() => {
    const rows = menuRows(element);
    const active = rows.find(
      (row) =>
        row.getAttribute("aria-checked") === "true" ||
        row.getAttribute("aria-selected") === "true",
    );
    (active ?? rows[0])?.focus();
  });
  return () => {
    stopDismissal?.();
    stopViewport?.();
    if (restoreFocus && anchor.isConnected) anchor.focus();
  };
});
</script>

<div
  bind:this={surface}
  class="skr-anchored-menu"
  role="menu"
  aria-label={label}
  tabindex="-1"
  data-testid="anchored-menu"
  data-motion-surface="anchored-top"
  style:min-width={minWidth}
  style:max-width={maxWidth}
  onkeydown={onKeydown}
>
  {#if children !== undefined}
    {@render children()}
  {/if}
</div>

<style>
  .skr-anchored-menu {
    position: fixed;
    top: 0;
    left: 0;
    z-index: 90;
    display: grid;
    overflow-y: auto;
    box-sizing: border-box;
    border: 1px solid var(--skr-border);
    border-radius: var(--skr-radius-surface);
    padding: 0.25rem;
    background: var(--skr-surface-raised);
    box-shadow: var(--skr-shadow);
    color: var(--skr-text);
    font-family: var(--skr-font-interface);
    font-size: 13px;
  }

  .skr-anchored-menu :global(button) {
    display: flex;
    min-width: 0;
    min-height: 2.75rem;
    align-items: center;
    gap: 0.5rem;
    justify-content: space-between;
    border: 0;
    /* Overflow-menu rows are flat full-width rows: no rounded row cards
       (design system section 5.12). */
    border-radius: 0;
    padding: 0.375rem 0.75rem;
    color: var(--skr-text);
    background-color: transparent;
    font: inherit;
    text-align: start;
    cursor: pointer;
    transition:
      background-color var(--skr-motion-state-duration)
        var(--skr-motion-state-easing),
      color var(--skr-motion-state-duration) var(--skr-motion-state-easing);
  }

  .skr-anchored-menu :global(button:hover),
  .skr-anchored-menu :global(button:focus-visible) {
    background-color: var(--skr-surface-subtle);
  }

  .skr-anchored-menu :global(button[aria-checked="true"]) {
    background-color: var(--skr-accent-subtle);
  }
</style>
