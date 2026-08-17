<script lang="ts">
import { onDestroy, onMount } from "svelte";
import type { PickerItem, PickerMode } from "./features/pickers";
import { enterMotionSurface, exitMotionSurfaces } from "./motion";
import { STRINGS } from "./strings";

let {
  items,
  mode,
  initialQuery = "",
  onQueryChange,
  onPick,
  onClose,
  restoreFocus = true,
}: {
  items: PickerItem[];
  mode: PickerMode;
  initialQuery?: string;
  onQueryChange: (query: string) => void;
  onPick: (item: PickerItem, intent?: { newTab?: boolean }) => void;
  onClose: () => void;
  restoreFocus?: boolean;
} = $props();

const initialViewportHeight = () =>
  typeof window === "undefined" ? 0 : window.innerHeight;
let active = $state(0);
let inputElement = $state<HTMLInputElement | null>();
let closeElement = $state<HTMLButtonElement | null>();
let backdropElement = $state<HTMLElement | null>();
let dialogElement = $state<HTMLElement | null>();
let closing = false;
let visualTop = $state(0);
let visualLeft = $state(0);
let visualWidth = $state(typeof window === "undefined" ? 0 : window.innerWidth);
let visualHeight = $state(initialViewportHeight());
let heightCap = $state(initialViewportHeight());
const returnFocusElement =
  typeof document !== "undefined" &&
  document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;

const LISTBOX_ID = "skr-command-surface-listbox";

// A row that states something about the list rather than offering an action
// is rendered but never occupies a selection stop, so arrow keys walk only
// the rows Enter can invoke and no press lands on a dead one.
const options = $derived(items.filter((item) => item.informational !== true));
const optionIndexes = $derived(
  new Map(options.map((item, index) => [item.id, index])),
);

$effect(() => {
  inputElement?.focus();
});

$effect(() => {
  if (active >= options.length) {
    active = Math.max(0, options.length - 1);
  }
});

function updateVisualViewport() {
  const viewport = window.visualViewport;
  visualTop = viewport?.offsetTop ?? 0;
  visualLeft = viewport?.offsetLeft ?? 0;
  visualWidth = viewport?.width ?? window.innerWidth;
  visualHeight = viewport?.height ?? window.innerHeight;
  const keyboardVisible = visualHeight < window.innerHeight - 1;
  heightCap = keyboardVisible
    ? visualHeight
    : Math.min(visualHeight, window.innerHeight * 0.8);
}

onMount(() => {
  updateVisualViewport();
  const viewport = window.visualViewport;
  viewport?.addEventListener("resize", updateVisualViewport);
  viewport?.addEventListener("scroll", updateVisualViewport);
  window.addEventListener("resize", updateVisualViewport);
  return () => {
    viewport?.removeEventListener("resize", updateVisualViewport);
    viewport?.removeEventListener("scroll", updateVisualViewport);
    window.removeEventListener("resize", updateVisualViewport);
  };
});

function onInput(event: Event & { currentTarget: HTMLInputElement }) {
  active = 0;
  onQueryChange(event.currentTarget.value);
}

function pickActive(intent?: { newTab?: boolean }) {
  const item = options[active];
  if (item !== undefined && item.unavailableReason === undefined) {
    onPick(item, intent);
  }
}

// registry-exempt keydown: ARIA combobox pattern internal navigation
// stays inside the unified surface. Registry keybindings own every command
// that opens the surface and every command row listed inside it.
function onKeydown(event: KeyboardEvent) {
  switch (event.key) {
    case "ArrowDown":
      active = Math.min(active + 1, Math.max(0, options.length - 1));
      break;
    case "ArrowUp":
      active = Math.max(active - 1, 0);
      break;
    case "Home":
      active = 0;
      break;
    case "End":
      active = Math.max(0, options.length - 1);
      break;
    case "Enter":
      // Mod-Enter is the file mode's explicit new-tab action; plain Enter
      // opens in place like every other default route.
      pickActive({ newTab: event.ctrlKey || event.metaKey });
      break;
    default:
      return;
  }
  event.preventDefault();
}

function onDialogKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    void requestClose();
  } else if (event.key === "Tab") {
    event.preventDefault();
    if (event.shiftKey) {
      (document.activeElement === inputElement
        ? closeElement
        : inputElement
      )?.focus();
    } else {
      (document.activeElement === closeElement
        ? inputElement
        : closeElement
      )?.focus();
    }
  }
}

function requestClose() {
  if (closing) return;
  closing = true;
  exitMotionSurfaces(
    [backdropElement, dialogElement].filter(
      (element): element is HTMLElement => element instanceof HTMLElement,
    ),
    onClose,
  );
}

onMount(() => {
  enterMotionSurface(backdropElement);
  enterMotionSurface(dialogElement);
});

onDestroy(() => {
  if (restoreFocus && returnFocusElement?.isConnected) {
    returnFocusElement.focus();
  }
});
</script>

<div
  bind:this={backdropElement}
  class="skr-overlay command-surface-backdrop"
  role="presentation"
  data-testid="unified-command-surface"
  style={`--skr-visual-top: ${visualTop}px; --skr-visual-left: ${visualLeft}px; --skr-visual-width: ${visualWidth}px; --skr-visual-height: ${visualHeight}px; --skr-command-height-cap: ${heightCap}px`}
  data-motion-surface="scrim"
  onclick={(event) =>
    event.target === event.currentTarget && void requestClose()}
>
  <div
    bind:this={dialogElement}
    class="command-surface-dialog"
    role="dialog"
    aria-modal="true"
    aria-label={STRINGS.commandSurfaceLabel}
    tabindex="-1"
    data-motion-surface="centered"
    onkeydown={onDialogKeydown}
  >
    <div class="command-surface-input-row">
      <input
        bind:this={inputElement}
        value={initialQuery}
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-haspopup="listbox"
        aria-controls={LISTBOX_ID}
        aria-activedescendant={options.length > 0 ? `skr-command-option-${active}` : undefined}
        aria-label={STRINGS.commandSurfaceLabel}
        placeholder={STRINGS.commandSurfacePlaceholder}
        autocomplete="off"
        spellcheck="false"
        data-search-mode={mode}
        oninput={onInput}
        onkeydown={onKeydown}
      />
      <button
        bind:this={closeElement}
        type="button"
        class="command-surface-close"
        data-btn-role="secondary"
        onclick={requestClose}
      >{STRINGS.closeAction}</button>
    </div>
    <ul
      id={LISTBOX_ID}
      class="command-surface-results"
      role="listbox"
      aria-label={STRINGS.commandSurfaceLabel}
      data-result-kind={mode}
    >
      {#each items as item, index (item.id)}
        {#if item.group !== undefined && (index === 0 || items[index - 1]?.group !== item.group)}
          <li
            class="command-surface-group"
            role="presentation"
            data-result-kind={item.kind}
          >{item.group}</li>
        {/if}
        {#if item.informational === true}
          <li
            class="command-surface-note skr-muted"
            role="presentation"
            data-result-kind={item.kind}
          >{#each item.titleSegments as segment, segmentIndex (segmentIndex)}{segment.text}{/each}</li>
        {:else}
        <!-- svelte-ignore a11y_click_events_have_key_events -- keyboard
             operation lives on the combobox input per the ARIA pattern. -->
        <li
          id={`skr-command-option-${optionIndexes.get(item.id)}`}
          role="option"
          data-result-kind={item.kind}
          data-result-group={item.group ?? ""}
          data-action-kind={item.actionKind}
          data-command-id={item.commandId}
          aria-label={item.accessibleName}
          aria-selected={optionIndexes.get(item.id) === active}
          aria-disabled={item.unavailableReason === undefined ? undefined : true}
          class:command-surface-unavailable={item.unavailableReason !== undefined}
          class:command-surface-secondary={item.tone === "muted"}
          onclick={(event) => {
            if (item.unavailableReason !== undefined) return;
            onPick(item, { newTab: event.ctrlKey || event.metaKey });
          }}
          onmousemove={() => {
            active = optionIndexes.get(item.id) ?? active;
          }}
        >
          <span class="command-surface-title">
            <span class="min-w-0 truncate">
              {#each item.titleSegments as segment, segmentIndex (segmentIndex)}
                {#if segment.highlighted}<mark class="skr-match rounded">{segment.text}</mark>{:else}{segment.text}{/if}
              {/each}
              {#if item.titleSuffix !== undefined}
                <span class="skr-muted"> {item.titleSuffix}</span>
              {/if}
            </span>
            {#if item.keybinding !== undefined}
              <kbd class="command-surface-chip skr-muted shrink-0 rounded border px-1">{item.keybinding}</kbd>
            {:else if item.prefixHint !== undefined}
              <kbd class="command-surface-chip skr-muted shrink-0 rounded border px-1">{item.prefixHint}</kbd>
            {:else if item.meta !== undefined}
              <span class="command-surface-meta skr-muted shrink-0">{item.meta}</span>
            {/if}
          </span>
          {#if item.unavailableReason !== undefined}
            <span class="command-surface-detail skr-muted block truncate">{item.unavailableReason}</span>
          {:else if item.detailSegments !== undefined}
            <span class="command-surface-detail skr-muted block truncate">
              {#each item.detailSegments as segment, segmentIndex (segmentIndex)}
                {#if segment.highlighted}<mark class="skr-match rounded">{segment.text}</mark>{:else}{segment.text}{/if}
              {/each}
            </span>
          {/if}
        </li>
        {/if}
      {/each}
    </ul>
    {#if items.length === 0}
      <div class="skr-muted px-3 pb-2" role="status">{STRINGS.noMatches}</div>
    {/if}
  </div>
</div>

<style>
  /* An unavailable row stays listed so the capability is discoverable, and
     reads as unavailable rather than as a row that silently does nothing. */
  .command-surface-unavailable {
    opacity: 0.55;
  }

  /* A lower-confidence answer costs nothing to skip past: it reads in the
     muted text colour, so the boundary its heading draws is legible without
     a rule, a box, or a fill. */
  .command-surface-results [role="option"].command-surface-secondary {
    color: var(--skr-text-muted);
  }

  /* A line that states something about the list rather than offering an
     action. */
  .command-surface-note {
    padding: 0.25rem 0.5rem;
    font-size: var(--skr-type-label);
  }

  .command-surface-meta {
    font-size: var(--skr-type-label);
  }

  .command-surface-backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 6rem;
  }

  .command-surface-dialog {
    display: flex;
    width: 36rem;
    max-width: 90vw;
    max-height: calc(100vh - 7rem);
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--skr-border);
    border-radius: var(--skr-radius-dialog);
    background: var(--skr-surface-raised);
  }

  .command-surface-input-row {
    display: flex;
    flex: none;
    border-bottom: 1px solid var(--skr-border);
  }

  .command-surface-input-row input {
    min-width: 0;
    flex: 1;
    border: 0;
    padding: 0.5rem 0.75rem;
    background: var(--skr-surface-raised);
    color: var(--skr-text);
    font-size: var(--skr-type-control);
    outline: none;
  }

  .command-surface-close {
    min-width: 2.75rem;
    border: 0;
    border-left: 1px solid var(--skr-border);
    padding: 0.5rem 0.75rem;
    font-weight: 600;
  }

  .command-surface-close:hover {
    background: var(--skr-surface-subtle);
  }

  .command-surface-results {
    min-height: 0;
    max-height: 20rem;
    margin: 0;
    overflow-y: auto;
    padding: 0.25rem;
    list-style: none;
    font-size: var(--skr-type-control);
  }

  .command-surface-results [role="option"] {
    cursor: pointer;
    border-radius: var(--skr-radius-control);
    padding: 0.25rem 0.5rem;
    color: var(--skr-text);
  }

  .command-surface-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .command-surface-group {
    padding: 0.5rem 0.5rem 0.25rem;
    color: var(--skr-text-muted);
    font-size: var(--skr-type-label);
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .command-surface-chip {
    font-family: var(--skr-font-mono);
    font-size: var(--skr-type-chip);
  }

  .command-surface-detail {
    font-size: var(--skr-type-label);
  }

  @media (max-width: 60rem) {
    .command-surface-backdrop {
      inset: auto;
      top: var(--skr-visual-top);
      left: var(--skr-visual-left);
      width: var(--skr-visual-width);
      height: var(--skr-visual-height);
      padding: 0;
    }

    .command-surface-dialog {
      width: 100%;
      max-width: none;
      max-height: var(--skr-command-height-cap);
      border-radius: 0 0 var(--skr-radius-dialog) var(--skr-radius-dialog);
    }

    .command-surface-results {
      max-height: none;
      flex: 1;
    }

    .command-surface-input-row input,
    .command-surface-results [role="option"] {
      min-height: 2.75rem;
    }

    .command-surface-results [role="option"] {
      display: flex;
      flex-direction: column;
      justify-content: center;
    }
  }
</style>
