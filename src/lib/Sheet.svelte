<script lang="ts">
import { onDestroy, onMount, type Snippet, tick } from "svelte";
import { enterMotionSurface, exitMotionSurfaces } from "./motion";
import { STRINGS } from "./strings";

let {
  label,
  onClose,
  children,
  restoreFocus = true,
  variant = "sheet",
}: {
  label: string;
  onClose: () => void;
  children?: Snippet;
  restoreFocus?: boolean;
  variant?: "sheet" | "anchored";
} = $props();

let dialog = $state<HTMLElement>();
let backdrop = $state<HTMLElement>();
let returnFocus: HTMLElement | null = null;
let closing = false;
const titleId = "skr-sheet-title";
const focusableSelector =
  'a[href], button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])';

function focusableElements(): HTMLElement[] {
  return dialog === undefined
    ? []
    : [...dialog.querySelectorAll<HTMLElement>(focusableSelector)].filter(
        (element) => !element.hasAttribute("inert"),
      );
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    void requestClose();
    return;
  }
  if (event.key !== "Tab") {
    return;
  }
  const focusable = focusableElements();
  const first = focusable[0];
  const last = focusable.at(-1);
  if (first === undefined || last === undefined) {
    event.preventDefault();
    dialog?.focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function requestClose() {
  if (closing) return;
  closing = true;
  exitMotionSurfaces(
    [backdrop, dialog].filter(
      (element): element is HTMLElement => element !== undefined,
    ),
    onClose,
  );
}

// registry-exempt keydown: modal dialog focus trapping and Escape dismissal
// are internal to the sheet. Commands only open the registered surface.

onMount(() => {
  returnFocus =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  void tick().then(() => {
    (focusableElements()[0] ?? dialog)?.focus();
  });
  if (backdrop !== undefined) enterMotionSurface(backdrop);
  if (dialog !== undefined) enterMotionSurface(dialog);
});

onDestroy(() => {
  if (restoreFocus && returnFocus?.isConnected) {
    returnFocus.focus();
  }
});
</script>

<div
  bind:this={backdrop}
  class="sheet-backdrop"
  class:sheet-backdrop-anchored={variant === "anchored"}
  role="presentation"
  data-motion-surface="scrim"
  onclick={(event) =>
    event.target === event.currentTarget && void requestClose()}
>
  <div
    bind:this={dialog}
    class="sheet"
    class:sheet-anchored={variant === "anchored"}
    role="dialog"
    aria-modal="true"
    aria-labelledby={variant === "sheet" ? titleId : undefined}
    aria-label={variant === "anchored" ? label : undefined}
    tabindex="-1"
    data-testid="overlay-sheet"
    data-sheet-variant={variant}
    data-motion-surface={variant === "sheet"
      ? "anchored-bottom"
      : "anchored-top"}
    onkeydown={onKeydown}
  >
    {#if variant === "sheet"}
      <header>
        <h2 id={titleId}>{label}</h2>
        <button type="button" class="sheet-close" onclick={requestClose}>
          {STRINGS.closeAction}
        </button>
      </header>
    {/if}
    <div class="sheet-content">
      {#if children !== undefined}
        {@render children()}
      {/if}
    </div>
  </div>
</div>

<style>
  .sheet-backdrop {
    align-items: flex-end;
    background: var(--skr-overlay);
    display: flex;
    top: var(--skr-visual-viewport-top);
    left: var(--skr-visual-viewport-left);
    justify-content: center;
    position: fixed;
    width: var(--skr-visual-viewport-width);
    height: var(--skr-visual-viewport-height);
    z-index: 45;
  }

  .sheet {
    background: var(--skr-surface-raised);
    border: 1px solid var(--skr-border);
    border-bottom: 0;
    border-radius: 0.75rem 0.75rem 0 0;
    box-shadow: var(--skr-shadow);
    color: var(--skr-text);
    display: flex;
    flex-direction: column;
    height: min(80dvh, 40rem, var(--skr-visual-viewport-height));
    max-width: 32rem;
    outline: none;
    overflow: hidden;
    width: 100%;
  }

  .sheet-backdrop-anchored {
    align-items: flex-start;
    justify-content: flex-end;
    box-sizing: border-box;
    padding: 2.25rem 0.25rem 0.25rem;
    background: transparent;
  }

  .sheet-anchored {
    width: min(22rem, calc(var(--skr-visual-viewport-width) - 0.5rem));
    height: auto;
    max-height: calc(var(--skr-visual-viewport-height) - 2.5rem);
    border-bottom: 1px solid var(--skr-border);
    border-radius: 0.375rem;
  }

  header {
    align-items: center;
    border-bottom: 1px solid var(--skr-border);
    display: flex;
    flex: none;
    justify-content: space-between;
    min-height: 3.5rem;
    padding-inline: 1rem;
  }

  h2 {
    font-size: 1rem;
    margin: 0;
  }

  .sheet-close {
    min-height: 2.75rem;
    min-width: 2.75rem;
    padding: 0.5rem 0.75rem;
  }

  .sheet-content {
    box-sizing: border-box;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding-bottom: env(safe-area-inset-bottom);
  }
</style>
