<script lang="ts">
import { onDestroy } from "svelte";
import type { PickerItem } from "./features/pickers";
import { STRINGS } from "./strings";

let {
  label,
  placeholder,
  items,
  initialQuery = "",
  emptyText = STRINGS.noMatches,
  onQueryChange,
  onPick,
  onClose,
  restoreFocus = true,
}: {
  label: string;
  placeholder: string;
  items: PickerItem[];
  initialQuery?: string;
  emptyText?: string;
  onQueryChange: (query: string) => void;
  onPick: (id: string) => void;
  onClose: () => void;
  restoreFocus?: boolean;
} = $props();

const initialQueryValue = () => initialQuery;
let query = $state(initialQueryValue());
let active = $state(0);
let inputElement = $state<HTMLInputElement | undefined>();
let closeElement = $state<HTMLButtonElement | undefined>();
const returnFocusElement =
  typeof document !== "undefined" &&
  document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;

const LISTBOX_ID = "skr-picker-listbox";

$effect(() => {
  inputElement?.focus();
});

$effect(() => {
  if (active >= items.length) {
    active = Math.max(0, items.length - 1);
  }
});

function onInput() {
  active = 0;
  onQueryChange(query);
}

function pickActive() {
  const item = items[active];
  if (item !== undefined) {
    onPick(item.id);
  }
}

// registry-exempt keydown: ARIA combobox pattern internal navigation
// (arrows move the active option, Enter picks it, Escape dismisses),
// scoped to this widget's own input; the chords that open pickers are all
// registry keybindings, and the listed items come from the registry.
function onKeydown(event: KeyboardEvent) {
  switch (event.key) {
    case "ArrowDown":
      active = Math.min(active + 1, Math.max(0, items.length - 1));
      break;
    case "ArrowUp":
      active = Math.max(active - 1, 0);
      break;
    case "Home":
      active = 0;
      break;
    case "End":
      active = Math.max(0, items.length - 1);
      break;
    case "Enter":
      pickActive();
      break;
    default:
      return;
  }
  event.preventDefault();
}

function onDialogKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    onClose();
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

onDestroy(() => {
  if (restoreFocus && returnFocusElement?.isConnected) {
    returnFocusElement.focus();
  }
});
</script>

<div
    class="skr-overlay picker-backdrop fixed inset-0 z-40 flex items-start justify-center pt-24"
  role="presentation"
  onclick={(event) => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  }}
>
  <div
    class="w-[36rem] max-w-[90vw] rounded-lg border"
    role="dialog"
    aria-modal="true"
    aria-label={label}
    tabindex="-1"
    onkeydown={onDialogKeydown}
  >
    <div class="picker-input-row">
      <input
        bind:this={inputElement}
        bind:value={query}
        type="text"
        class="min-w-0 flex-1 rounded-tl-lg px-3 py-2 text-sm outline-none"
        role="combobox"
        aria-expanded="true"
        aria-haspopup="listbox"
        aria-controls={LISTBOX_ID}
        aria-activedescendant={items.length > 0 ? `skr-picker-option-${active}` : undefined}
        aria-label={label}
        {placeholder}
        autocomplete="off"
        spellcheck="false"
        oninput={onInput}
        onkeydown={onKeydown}
      />
      <button
        bind:this={closeElement}
        type="button"
        class="picker-close"
        onclick={onClose}
      >
        {STRINGS.closeAction}
      </button>
    </div>
    <ul
      id={LISTBOX_ID}
      class="m-0 max-h-80 list-none overflow-y-auto p-1 text-sm"
      role="listbox"
      aria-label={label}
    >
      {#each items as item, index (item.id)}
        <!-- svelte-ignore a11y_click_events_have_key_events -- keyboard
             operation lives on the combobox input per the ARIA pattern. -->
        <li
          id={`skr-picker-option-${index}`}
          role="option"
          data-command-id={item.id}
          aria-selected={index === active}
          class="cursor-pointer rounded px-2 py-1"
          onclick={() => onPick(item.id)}
          onmousemove={() => {
            active = index;
          }}
        >
          <span class="flex items-center justify-between gap-2">
            <span class="min-w-0 truncate">
              {#each item.titleSegments as segment, segmentIndex (segmentIndex)}
                {#if segment.highlighted}<mark class="skr-match rounded">{segment.text}</mark>{:else}{segment.text}{/if}
              {/each}
            </span>
            {#if item.keybinding !== undefined}
              <kbd class="skr-muted shrink-0 rounded border px-1 text-xs">{item.keybinding}</kbd>
            {/if}
          </span>
          {#if item.detailSegments !== undefined}
            <span class="skr-muted block truncate text-xs">
              {#each item.detailSegments as segment, segmentIndex (segmentIndex)}
                {#if segment.highlighted}<mark class="skr-match rounded">{segment.text}</mark>{:else}{segment.text}{/if}
              {/each}
            </span>
          {/if}
        </li>
      {/each}
    </ul>
    {#if items.length === 0}
      <div class="skr-muted px-3 pb-2 text-sm" role="status">
        {emptyText}
      </div>
    {/if}
  </div>
</div>

<style>
  .picker-input-row {
    display: flex;
    border-bottom: 1px solid var(--skr-border);
  }

  .picker-input-row input {
    border: 0;
  }

  .picker-close {
    min-width: 2.75rem;
    border: 0;
    border-left: 1px solid var(--skr-border);
    border-radius: 0 0.75rem 0 0;
    padding: 0.5rem 0.75rem;
  }

  @media (max-width: 60rem) {
    .picker-backdrop {
      align-items: flex-end;
      padding: 0;
    }

    .picker-backdrop > [role="dialog"] {
      max-height: 80dvh;
      max-width: none;
      border-bottom: 0;
      border-radius: 0.75rem 0.75rem 0 0;
      width: 100%;
    }

    input,
    [role="option"] {
      min-height: 2.75rem;
    }

    [role="option"] {
      display: flex;
      flex-direction: column;
      justify-content: center;
    }
  }
</style>
